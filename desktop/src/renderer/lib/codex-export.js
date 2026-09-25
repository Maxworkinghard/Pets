// 把一只宠物渲染成 Codex 宠物的精灵图（v1：8 列 × 9 行，每格 192×208）。
// 取帧与缩放规则见 shared/codex.js；这里负责解码、量尺寸、绘制和编码成 WebP。
import { CODEX_CELL, CODEX_COLUMNS, CODEX_STATES, fitToCell, planCodexExport, sampleFrames } from '../../shared/codex.js';
import { drawFrame, opaqueBounds } from './player.js';

/**
 * @param {object} pet  规范化后的清单
 * @param {(name: string) => Promise<object>} getAnim  按名字加载动画（可复用预览的缓存）
 * @returns {Promise<{bytes: Uint8Array, plan: object[], scale: number}>}
 */
export async function renderCodexAtlas(pet, getAnim) {
  const plan = planCodexExport(pet);
  const anims = {};
  for (const name of new Set(['idle', ...plan.map((r) => r.anim)])) anims[name] = await getAnim(name);

  // 默认锚点规则与桌宠窗口一致：画框底边居中，离底边的距离和 idle 第一帧相同
  const idle = anims.idle;
  const idleSrc = await idle.exactSource(0);
  const ib = opaqueBounds(idle, 0, idleSrc);
  idleSrc.release();
  const padBottom = ib ? idle.box.h - ib.y1 : 0;
  const anchorOf = (name) => pet.animations[name].anchor ?? [anims[name].box.w / 2, anims[name].box.h - padBottom];

  // 先量出所有要用到的帧相对脚底的范围，得到统一的缩放
  const ext = { left: 0, right: 0, up: 0, down: 0 };
  const rows = plan.map((row) => {
    const a = anims[row.anim];
    const locomotion = row.state === 'running-right' || row.state === 'running-left';
    const cycle = locomotion && a.frames.length <= row.count;
    const idxs = sampleFrames(a.frames.map((f) => f.duration), row.count, row.durations, { cycle });
    return { ...row, a, idxs, anchor: anchorOf(row.anim) };
  });
  for (const row of rows) {
    const [ax, ay] = row.anchor;
    for (const i of new Set(row.idxs)) {
      const src = await row.a.exactSource(i);
      const b = opaqueBounds(row.a, i, src);
      src.release();
      if (!b) continue;
      ext.left = Math.max(ext.left, ax - b.x0);
      ext.right = Math.max(ext.right, b.x1 - ax);
      ext.up = Math.max(ext.up, ay - b.y0);
      ext.down = Math.max(ext.down, b.y1 - ay);
    }
  }
  const fit = fitToCell(ext, { pixelated: pet.pixelated });

  const [cw, ch] = CODEX_CELL;
  const canvas = new OffscreenCanvas(cw * CODEX_COLUMNS, ch * CODEX_STATES.length);
  const ctx = canvas.getContext('2d');
  for (const [r, row] of rows.entries()) {
    for (const [c, i] of row.idxs.entries()) {
      const src = await row.a.exactSource(i);
      ctx.save();
      ctx.beginPath();
      ctx.rect(c * cw, r * ch, cw, ch);
      ctx.clip();
      ctx.imageSmoothingEnabled = !pet.pixelated;
      ctx.imageSmoothingQuality = 'high';
      drawFrame(ctx, row.a, i, row.anchor, c * cw + fit.anchorX, r * ch + fit.anchorY, fit.scale, row.flip, src);
      ctx.restore();
      src.release();
    }
  }
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 1 });
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    plan: rows.map(({ state, anim, flip, guessed, idxs }) => ({ state, anim, flip, guessed, frames: idxs })),
    scale: fit.scale,
  };
}
