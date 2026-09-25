import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_CELL, CODEX_MARGIN, CODEX_STATES, fitToCell, planCodexExport, sampleFrames } from '../src/shared/codex.js';
import { normalizeManifest } from '../src/shared/manifest.js';

const pet = (animations, extra = {}) => {
  const { pet: p, errors } = normalizeManifest({ id: 'p', name: 'p', animations, ...extra });
  assert.deepEqual(errors, []);
  return p;
};
const plan = (p) => Object.fromEntries(planCodexExport(p).map((r) => [r.state, r]));

test('Codex 的 9 行帧数与官方规格一致', () => {
  assert.deepEqual(CODEX_STATES.map(([, d]) => d.length), [6, 8, 8, 4, 5, 8, 6, 6, 6]);
});

test('同名状态直接对应；常见命名自动猜；猜不到用 idle', () => {
  const p = plan(pet({
    idle: { src: 'i.gif' },
    'walk-right': { src: 'r.gif' },
    'walk-left': { src: 'l.gif' },
    wave: { src: 'w.gif', label: '挥手' },
    'jump-happy': { src: 'j.gif', label: '跳' },
    review: { src: 'v.gif', label: '审阅' },
  }));
  assert.equal(p.waving.anim, 'wave');
  assert.equal(p.jumping.anim, 'jump-happy');
  assert.equal(p.review.anim, 'review');
  assert.equal(p['running-right'].anim, 'walk-right');
  assert.deepEqual([p['running-left'].anim, p['running-left'].flip], ['walk-left', false]);
  assert.equal(p.failed.anim, 'idle');
  assert.equal(p.failed.guessed, true);
});

test('通用 walk 在向左那一行镜像；mirror:false 时不镜像', () => {
  assert.equal(plan(pet({ idle: { src: 'i.gif' }, walk: { src: 'w.gif' } }))['running-left'].flip, true);
  assert.equal(plan(pet({ idle: { src: 'i.gif' }, walk: { src: 'w.gif', mirror: false } }))['running-left'].flip, false);
});

test('pet.json 的 codex 字段优先；behavior.click 作为挥手的候选；带 moveX 的动画不会被选', () => {
  const p = plan(pet(
    {
      idle: { src: 'i.gif' },
      hello: { src: 'h.gif', label: '你好' },
      smoke: { src: 's.gif', label: '抽烟' },
      burrow: { src: 'b.gif', label: '遁地', moveX: -400 },
    },
    { behavior: { click: 'hello' }, codex: { running: 'smoke', 'running-right': 'burrow' } },
  ));
  assert.equal(p.waving.anim, 'hello');
  assert.deepEqual([p.running.anim, p.running.guessed], ['smoke', false]);
  assert.equal(p['running-right'].anim, 'idle');
});

test('codex 字段只能写 Codex 的状态、指向已有动画', () => {
  const base = { id: 'p', name: 'p', animations: { idle: { src: 'i.gif' } } };
  assert.ok(normalizeManifest({ ...base, codex: { dance: 'idle' } }).errors.some((e) => e.includes('codex.dance')));
  assert.ok(normalizeManifest({ ...base, codex: { waving: 'nope' } }).errors.some((e) => e.includes('nope')));
});

test('按时间取样：把一遍动画映射进 Codex 这一行', () => {
  // 两帧各 420ms 的待机 → 前一半取第 0 帧，后一半取第 1 帧
  assert.deepEqual(sampleFrames([420, 420], 6, CODEX_STATES[0][1]), [0, 0, 0, 1, 1, 1]);
  // 单帧动画整行都是它
  assert.deepEqual(sampleFrames([1000], 4, [140, 140, 140, 280]), [0, 0, 0, 0]);
  // 走路循环：按顺序轮流
  assert.deepEqual(sampleFrames([100, 100], 8, CODEX_STATES[1][1], { cycle: true }), [0, 1, 0, 1, 0, 1, 0, 1]);
  // 取样结果始终是合法下标、且不回退
  const idx = sampleFrames([50, 900, 30, 30, 400, 70, 120], 8, CODEX_STATES[5][1]);
  assert.ok(idx.every((i, k) => i >= 0 && i < 7 && (k === 0 || i >= idx[k - 1])));
});

test('统一缩放：身体装进格子留白内，脚底落在同一基线', () => {
  const [cw, ch] = CODEX_CELL;
  const [mx, my] = CODEX_MARGIN;
  const tall = fitToCell({ left: 50, right: 60, up: 350, down: 0 }); // 高个子人物
  assert.ok(Math.abs(tall.scale - (ch - 2 * my) / 350) < 1e-9);
  assert.equal(tall.anchorY, ch - my);
  assert.ok(tall.anchorX + 60 * tall.scale <= cw - mx);
  const wide = fitToCell({ left: 200, right: 100, up: 80, down: 10 }); // 宽的怪物，按较宽一侧对称
  assert.ok(Math.abs(wide.scale - (cw - 2 * mx) / 400) < 1e-9);
  assert.ok(wide.anchorY + 10 * wide.scale <= ch - my + 1e-9);
  // 像素画缩放取整到 1/8，避免像素块宽窄不一
  assert.equal(fitToCell({ left: 92, right: 92, up: 220, down: 0 }, { pixelated: true }).scale, 0.75);
  assert.equal(fitToCell({ left: 10, right: 10, up: 20, down: 0 }).scale, 3); // 小素材最多放大 3 倍
});
