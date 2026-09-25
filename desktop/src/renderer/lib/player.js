// 动画加载与绘制（渲染进程）。三种素材统一成同一个接口：
//   image  —— GIF / APNG / WebP 动图或静态图，用 ImageDecoder 按需逐帧解码（内存占用小）
//   frames —— PNG 帧序列，每帧可单独设置时长与偏移
//   sheet  —— 精灵图（如 Codex 宠物的 8×9 图集）中的一行
//
// 每个动画有一个「画框」box（素材坐标），每帧在画框内的位置 {x, y, w, h}；
// 帧序列按「底边居中」对齐到画框。

const MIME = {
  gif: 'image/gif',
  png: 'image/png',
  apng: 'image/apng',
  webp: 'image/webp',
  avif: 'image/avif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
const ALPHA_HIT = 40;

export function assetUrl(base, rel) {
  return base + rel.split('/').map(encodeURIComponent).join('/');
}

async function loadImage(url) {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    throw new Error(`图片加载失败：${decodeURIComponent(url)}`);
  }
  return img;
}

class Anim {
  constructor(def, box, frames) {
    this.def = def;
    this.box = box;
    this.frames = frames;
    this.totalMs = Math.max(1, frames.reduce((s, f) => s + f.duration, 0));
  }

  /** 按时间取帧（循环播放）。 */
  indexAt(ms) {
    if (this.frames.length === 1) return 0;
    let t = ms % this.totalMs;
    for (let i = 0; i < this.frames.length; i++) {
      t -= this.frames[i].duration;
      if (t < 0) return i;
    }
    return this.frames.length - 1;
  }

  /** 按移动距离取帧（stepDistance：每走这么多素材像素换一帧，脚步和位移同步）。 */
  indexAtDistance(distance) {
    return Math.floor(distance / this.def.stepDistance) % this.frames.length;
  }

  /** 第 i 帧的可绘制来源：{image, sx, sy, exact}。exact=false 表示暂时用上一帧顶替。 */
  source(i) {
    const f = this.frames[i];
    return { image: f.img, sx: f.sx ?? 0, sy: f.sy ?? 0, exact: true };
  }

  /** 保证拿到第 i 帧本身（导出用）。用完调用 release()。 */
  async exactSource(i) {
    return { ...this.source(i), release() {} };
  }

  close() {}
}

class FramesAnim extends Anim {
  static async load(def, base) {
    const unique = [...new Set(def.frames.map((f) => f.src))];
    const images = new Map(await Promise.all(unique.map(async (src) => [src, await loadImage(assetUrl(base, src))])));
    let W = 0;
    let H = 0;
    for (const img of images.values()) {
      W = Math.max(W, img.naturalWidth);
      H = Math.max(H, img.naturalHeight);
    }
    const frames = def.frames.map((f) => {
      const img = images.get(f.src);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      return { duration: f.duration, img, w, h, x: Math.floor((W - w) / 2) + f.offset[0], y: H - h + f.offset[1] };
    });
    return new FramesAnim(def, { w: W, h: H }, frames);
  }
}

class SheetAnim extends Anim {
  static async load(def, base) {
    const img = await loadImage(assetUrl(base, def.sheet.src));
    const [cw, ch] = def.sheet.cell;
    const frames = [];
    for (let i = 0; i < def.sheet.count; i++) {
      frames.push({ duration: def.frameMs, img, w: cw, h: ch, x: 0, y: 0, sx: (def.sheet.col + i) * cw, sy: def.sheet.row * ch });
    }
    return new SheetAnim(def, { w: cw, h: ch }, frames);
  }
}

class DecodedAnim extends Anim {
  static async load(def, base) {
    const url = assetUrl(base, def.src);
    const type = MIME[def.src.split('.').pop().toLowerCase()];
    if (typeof ImageDecoder === 'undefined' || !type || !(await ImageDecoder.isTypeSupported(type))) {
      // 不支持逐帧解码时退化为静态图
      const img = await loadImage(url);
      const frame = { duration: 1000, img, w: img.naturalWidth, h: img.naturalHeight, x: 0, y: 0 };
      return new Anim(def, { w: frame.w, h: frame.h }, [frame]);
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`素材加载失败：${def.src}`);
    const decoder = new ImageDecoder({ data: await res.arrayBuffer(), type });
    await decoder.tracks.ready;
    await decoder.completed;
    const count = decoder.tracks.selectedTrack?.frameCount ?? 1;
    const frames = [];
    let first = null;
    // 先完整过一遍，拿到每帧时长；只保留第一帧，其余按需再解码
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      const us = image.duration;
      const duration = def.fps ? 1000 / def.fps : us ? Math.max(20, us / 1000) : count > 1 ? 100 : 1000;
      frames.push({ duration, w: image.displayWidth, h: image.displayHeight, x: 0, y: 0 });
      if (i === 0) first = image;
      else image.close();
    }
    const anim = new DecodedAnim(def, { w: frames[0].w, h: frames[0].h }, frames);
    anim.decoder = decoder;
    anim.cache = new Map([[0, first]]);
    anim.pending = new Set();
    anim.shown = 0;
    return anim;
  }

  source(i) {
    this.want(i);
    this.want((i + 1) % this.frames.length);
    const exact = this.cache.get(i);
    if (exact) {
      this.shown = i;
      return { image: exact, sx: 0, sy: 0, exact: true };
    }
    const fallback = this.cache.get(this.shown) ?? this.cache.get(0);
    return fallback ? { image: fallback, sx: 0, sy: 0, exact: false } : null;
  }

  async exactSource(i) {
    const cached = this.cache.get(i);
    if (cached) return { image: cached, sx: 0, sy: 0, exact: true, release() {} };
    const { image } = await this.decoder.decode({ frameIndex: i });
    return { image, sx: 0, sy: 0, exact: true, release: () => image.close() };
  }

  want(i) {
    if (this.closed || this.cache.has(i) || this.pending.has(i)) return;
    this.pending.add(i);
    this.decoder.decode({ frameIndex: i }).then(
      ({ image }) => {
        this.pending.delete(i);
        if (this.closed) return image.close();
        this.cache.set(i, image);
        // 只留第一帧、正在显示的帧和最近解码的几帧
        for (const [k, img] of this.cache) {
          if (this.cache.size <= 4) break;
          if (k !== 0 && k !== this.shown && k !== i) {
            img.close();
            this.cache.delete(k);
          }
        }
      },
      () => this.pending.delete(i),
    );
  }

  close() {
    this.closed = true;
    for (const img of this.cache.values()) img.close();
    this.cache.clear();
    this.decoder.close();
  }
}

/** 加载一个（规范化后的）动画定义。 */
export function loadAnimation(def, base) {
  if (def.kind === 'frames') return FramesAnim.load(def, base);
  if (def.kind === 'sheet') return SheetAnim.load(def, base);
  return DecodedAnim.load(def, base);
}

/** 加载一只宠物的全部动画；单个动画失败不影响其它（idle 除外）。 */
export async function loadPetAnimations(pet, base, onError = () => {}) {
  const entries = await Promise.all(
    Object.entries(pet.animations).map(async ([name, def]) => {
      try {
        return [name, await loadAnimation(def, base)];
      } catch (e) {
        onError(`动画「${name}」加载失败：${e.message}`);
        return null;
      }
    }),
  );
  const anims = Object.fromEntries(entries.filter(Boolean));
  if (!anims.idle) throw new Error('idle 动画加载失败，无法显示宠物');
  return anims;
}

/** 第 i 帧不透明像素的包围盒（画框坐标）。 */
export function opaqueBounds(anim, i = 0, src = anim.source(i)) {
  if (!src) return null;
  const f = anim.frames[i];
  const canvas = new OffscreenCanvas(f.w, f.h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src.image, src.sx, src.sy, f.w, f.h, 0, 0, f.w, f.h);
  const { data } = ctx.getImageData(0, 0, f.w, f.h);
  let x0 = f.w;
  let y0 = f.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      if (data[(y * f.w + x) * 4 + 3] > ALPHA_HIT) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0: x0 + f.x, y0: y0 + f.y, x1: x1 + 1 + f.x, y1: y1 + 1 + f.y };
}

/**
 * 计算宠物的布局：每个动画的锚点（脚底）、舞台（窗口）大小、身体范围。
 * 锚点默认取「画框底边居中，且和 idle 第一帧脚底离画框底边的距离相同」，可在 pet.json 用 anchor 覆盖。
 * @param {object} pet    规范化后的清单
 * @param {Record<string, Anim>} anims
 * @param {number} scale  素材像素 → 屏幕 DIP
 */
export function computeLayout(pet, anims, scale) {
  const idle = anims.idle;
  const ib = opaqueBounds(idle, 0) ?? { x0: 0, y0: 0, x1: idle.box.w, y1: idle.box.h };
  const padBottom = idle.box.h - ib.y1;
  const anchors = {};
  let half = 0;
  let up = 0;
  let down = 0;
  for (const [name, a] of Object.entries(anims)) {
    const [ax, ay] = pet.animations[name].anchor ?? [a.box.w / 2, a.box.h - padBottom];
    anchors[name] = [ax, ay];
    for (const f of a.frames) {
      half = Math.max(half, ax - f.x, f.x + f.w - ax); // 左右对称，镜像后也放得下
      up = Math.max(up, ay - f.y);
      down = Math.max(down, f.y + f.h - ay);
    }
  }
  const [iax, iay] = anchors.idle;
  return {
    scale,
    anchors,
    stage: { w: Math.ceil(2 * half * scale), h: Math.ceil((up + down) * scale), ax: half * scale, ay: up * scale },
    body: { left: (iax - ib.x0) * scale, right: (ib.x1 - iax) * scale, top: (iay - ib.y0) * scale, bottom: 0 },
  };
}

/**
 * 在 ctx 上绘制一帧：动画锚点对齐到 (ox, oy)，按 scale 缩放，flip 时以锚点为轴水平镜像。
 * 返回 source(i) 的结果（null 表示没画）。
 */
export function drawFrame(ctx, anim, i, anchor, ox, oy, scale, flip = false, src = anim.source(i)) {
  if (!src) return null;
  const f = anim.frames[i];
  const [ax, ay] = anchor;
  ctx.save();
  if (flip) {
    ctx.translate(2 * ox, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(src.image, src.sx, src.sy, f.w, f.h, ox + (f.x - ax) * scale, oy + (f.y - ay) * scale, f.w * scale, f.h * scale);
  ctx.restore();
  return src;
}

/** 取某一帧用于显示的索引（按时间，或按行走距离）。 */
export function frameIndex(anim, animTime, distanceSrcPx) {
  return anim.def.stepDistance ? anim.indexAtDistance(distanceSrcPx) : anim.indexAt(animTime);
}
