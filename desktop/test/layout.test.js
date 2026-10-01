import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, opaqueBounds } from '../src/renderer/lib/player.js';

// 单元测试里没法 import player.js 的 Anim 类（未导出），用一个最小的同形对象：
// 复用原型上的 groundY 语义——直接给出 _groundY 或按帧量。
const GROUND = Symbol('groundY');
function withGround(o) {
  o.groundY = function groundY() {
    if (this._groundY === undefined) {
      let low = -Infinity;
      for (let i = 0; i < this.frames.length; i++) {
        const b = opaqueBounds(this, i);
        if (b) low = Math.max(low, b.y1);
      }
      this._groundY = Number.isFinite(low) ? low : this.box.h;
    }
    return this._groundY;
  };
  return o;
}

// player.js 用 OffscreenCanvas 量不透明像素。Node 里没有，用最小替身：
// 假图带 __rects（不透明矩形），drawImage 记下来，getImageData 按它合成 alpha。
class FakeImage {
  constructor(w, h, rects) {
    this.naturalWidth = w;
    this.naturalHeight = h;
    this.__rects = rects;
  }
}
globalThis.OffscreenCanvas = class {
  constructor(w, h) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    const self = this;
    return {
      drawImage(img) {
        self.__img = img;
      },
      getImageData(_x, _y, w, h) {
        const data = new Uint8ClampedArray(w * h * 4);
        for (const [x0, y0, x1, y1] of self.__img?.__rects ?? []) {
          for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
            for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) data[(y * w + x) * 4 + 3] = 255;
          }
        }
        return { data };
      },
    };
  }
};

/** 造一个动画：画框 boxW×boxH，角色画在角色矩形里。 */
function anim(boxW, boxH, rects, groundY) {
  const img = new FakeImage(boxW, boxH, rects);
  const a = {
    box: { w: boxW, h: boxH },
    frames: [{ img, w: boxW, h: boxH, x: 0, y: 0 }],
    source: () => ({ image: img, sx: 0, sy: 0 }),
  };
  if (groundY !== undefined) a._groundY = groundY;
  return withGround(a);
}

test('groundY 取整段动画最低帧的底边，而不是第 0 帧', () => {
  // 同一个动画里，第 0 帧人物画得靠上、后面一帧踩得更低
  const img0 = new FakeImage(50, 100, [[10, 10, 40, 60]]);
  const img1 = new FakeImage(50, 100, [[10, 10, 40, 90]]);
  const a = {
    box: { w: 50, h: 100 },
    frames: [
      { img: img0, w: 50, h: 100, x: 0, y: 0 },
      { img: img1, w: 50, h: 100, x: 0, y: 0 },
    ],
    source(i) {
      return { image: this.frames[i].img, sx: 0, sy: 0 };
    },
  };
  withGround(a);
  assert.equal(a.groundY(), 90); // 最低帧的底边，不是第 0 帧的 60
  assert.equal(a.groundY(), 90); // 结果缓存
});

test('同一只宠物各动画角色高低不同时，脚底仍然落在同一条基线上', () => {
  // 两个动画画框一样大（180×300）：idle 的人物靠下，walk 的人物画得靠上
  const pet = { animations: { idle: {}, walk: {} } };
  const anims = {
    idle: anim(180, 300, [[70, 100, 110, 300]]), // 脚在 300
    walk: anim(180, 300, [[60, 20, 120, 220]]), // 脚在 220（素材整体靠上）
  };
  const layout = computeLayout(pet, anims, 1);
  // 这是修复的关键：两个动画的锚点都取自己的最低帧底边，
  // 而不是「用 idle 的留白」给 walk 也算出一个偏高的脚底。
  assert.equal(layout.anchors.idle[1], 300);
  assert.equal(layout.anchors.walk[1], 220);

  // 画到屏幕上以后，每个动画最低帧的底边都落在 stage.ay 那条线上：
  // 描画时 oy = stage.ay，帧的底边在 (ay - anchorY + frameBottom)，取最低帧即 frameBottom == anchorY。
  for (const [name, a] of Object.entries(anims)) {
    const bottom = Math.max(...a.frames.map((_, i) => opaqueBounds(a, i).y1));
    const screenBottom = layout.stage.ay - layout.anchors[name][1] + bottom;
    assert.equal(screenBottom, layout.stage.ay, name + ' 的脚底应该正好落在基线上');
  }
});

test('显式写 anchor 时仍然优先用 pet.json 里的值', () => {
  const pet = { animations: { idle: {}, walk: { anchor: [90, 250] } } };
  const anims = {
    idle: anim(180, 300, [[70, 100, 110, 300]]),
    walk: anim(180, 300, [[60, 20, 120, 220]]),
  };
  const layout = computeLayout(pet, anims, 1);
  assert.deepEqual(layout.anchors.walk, [90, 250]);
});

test('opaqueBounds 仍然返回整帧的不透明包围盒', () => {
  const a = anim(100, 100, [[20, 30, 60, 80]]);
  assert.deepEqual(opaqueBounds(a, 0), { x0: 20, y0: 30, x1: 60, y1: 80 });
});
