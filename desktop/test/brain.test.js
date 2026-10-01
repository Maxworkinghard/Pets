import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PetBrain, TUNING } from '../src/shared/brain.js';

const AREA = { x: 0, y: 0, width: 1000, height: 700 }; // 地面 y = 700
const BODY = { left: 30, right: 30, top: 100 };

function seq(...values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function makeBrain(over = {}) {
  return new PetBrain({
    anims: {
      idle: { durationMs: 800 },
      walk: { durationMs: 600, mirror: true },
      wave: { durationMs: 1000, repeat: 2, label: '挥手', weight: 1 },
      burrow: { durationMs: 2000, label: '遁地', weight: 1, moveX: -400 },
      sleep: { durationMs: 1200, label: '睡觉', weight: 0 },
    },
    behavior: { click: 'wave' },
    speed: 50,
    body: BODY,
    areas: [AREA],
    position: { x: 500, y: 700 },
    random: () => 0.5,
    ...over,
  });
}

function run(brain, seconds, step = 1 / 60) {
  for (let t = 0; t < seconds; t += step) brain.update(step);
  return brain.view;
}

test('出生在地面上时进入待机', () => {
  const b = makeBrain();
  const v = b.update(0.016);
  assert.equal(v.mode, 'idle');
  assert.equal(v.anim, 'idle');
  assert.equal(v.y, 700);
});

test('开启重力：悬空出生会落到地面', () => {
  const b = makeBrain({ position: { x: 500, y: 200 } });
  b.update(0.016);
  assert.equal(b.view.mode, 'fall');
  const v = run(b, 2);
  assert.equal(v.y, 700);
  assert.notEqual(v.mode, 'fall');
});

test('关闭重力：停在原处', () => {
  const b = makeBrain({ position: { x: 500, y: 200 }, settings: { gravity: false } });
  run(b, 1);
  assert.equal(b.view.y, 200);
});

test('行走不会走出屏幕，走到边缘会掉头（左走时用镜像）', () => {
  const b = makeBrain({ position: { x: 40, y: 700 } });
  b.startWalk(-1);
  assert.equal(b.view.anim, 'walk');
  assert.equal(b.view.flip, true);
  b.dur = 100;
  for (let i = 0; i < 600; i++) {
    const v = b.update(1 / 60);
    assert.ok(v.x >= BODY.left && v.x <= AREA.width - BODY.right, `x=${v.x}`);
  }
  assert.equal(b.facing, 1);
  assert.equal(b.view.flip, false);
});

test('优先使用 walk-left / walk-right，而不是镜像', () => {
  const b = makeBrain({
    anims: { idle: { durationMs: 500 }, 'walk-left': { durationMs: 500 }, 'walk-right': { durationMs: 500 } },
  });
  b.startWalk(-1);
  assert.deepEqual([b.view.anim, b.view.flip], ['walk-left', false]);
  b.turn(1);
  assert.deepEqual([b.view.anim, b.view.flip], ['walk-right', false]);
});

test('关闭自由走动后，不会选择走动', () => {
  const b = makeBrain({ settings: { wander: false, randomActions: false }, random: () => 0.99 });
  for (let i = 0; i < 50; i++) {
    b.decideNext();
    assert.equal(b.view.mode, 'idle');
  }
});

test('单击切换动作是立刻生效的，不需要等双击判定', () => {
  const b = makeBrain();
  b.click();
  assert.equal(b.view.anim, 'wave');
  b.click();
  assert.equal(b.view.anim, 'burrow');
});

test('动作播放 durationMs × repeat 后回到待机', () => {
  const b = makeBrain();
  b.play('wave');
  assert.equal(b.view.mode, 'action');
  run(b, 1.9);
  assert.equal(b.view.mode, 'action');
  run(b, 0.2);
  assert.equal(b.view.mode, 'idle');
});

test('带 moveX 的动作结束后，位置平移', () => {
  const b = makeBrain({ position: { x: 800, y: 700 } });
  b.play('burrow');
  run(b, 2.1);
  assert.equal(b.view.mode, 'idle');
  assert.equal(b.view.x, 400);
});

test('会出界的位移动作不会被随机挑中（允许走动时才算）', () => {
  // 开自由走动：位移动作才参与随机挑选，出界时排除
  const b = makeBrain({ position: { x: 200, y: 700 }, settings: { wander: true } });
  assert.deepEqual(b.actionCandidates().map(([n]) => n), ['wave']);
  b.x = 800;
  assert.deepEqual(b.actionCandidates().map(([n]) => n), ['wave', 'burrow']);
  // 关自由走动（现在的默认）：位移动作不参与随机挑选
  const c = makeBrain({ position: { x: 800, y: 700 } });
  assert.deepEqual(c.actionCandidates().map(([n]) => n), ['wave']);
});

test('单击从 behavior.click 开始依次切换动作；睡觉时单击会先醒来', () => {
  const b = makeBrain();
  // 动作循环：behavior.click → behavior.doubleClick → 其余带 label 的动作
  assert.deepEqual(b.actionCycle, ['wave', 'burrow', 'sleep']);
  b.click();
  assert.equal(b.view.mode, 'action');
  assert.equal(b.view.anim, 'wave');
  b.click();
  assert.equal(b.view.anim, 'burrow');
  b.click();
  assert.equal(b.view.anim, 'sleep');
  b.click(); // 循环回到第一个
  assert.equal(b.view.anim, 'wave');
});

test('动作循环跳过会出界之前也不会漏掉动作；没有 label 的动画不进循环', () => {
  const b = makeBrain();
  b.actionCycle = [];
  b.buildActionCycle();
  assert.ok(!b.actionCycle.includes('idle'));
  assert.ok(!b.actionCycle.includes('walk'));
  assert.deepEqual(b.actionCycle, ['wave', 'burrow', 'sleep']);
});

test('关掉自由走动时，待机只会选待机 / 动作 / 睡觉，不会走动', () => {
  const b = makeBrain({ settings: { wander: false, randomActions: true }, random: () => 0.99 });
  for (let i = 0; i < 50; i++) {
    b.decideNext();
    assert.notEqual(b.view.mode, 'walk');
  }
});

test('打开自由走动后，待机会挑中走动（设置仍然有效）', () => {
  // random 返回 0.5 在 idle(3) / walk(4) / … 里落在 walk 上
  const b = makeBrain({ settings: { wander: true }, random: () => 0.5 });
  b.decideNext();
  assert.equal(b.view.mode, 'walk');
});

test('默认不随机做动作、不自动走动：无交互时一直待机', () => {
  const b = makeBrain({ settings: undefined, random: () => 0.5 });
  for (let i = 0; i < 50; i++) {
    b.decideNext();
    assert.equal(b.view.mode, 'idle');
    assert.equal(b.view.anim, 'idle');
  }
});

test('拖动：跟随指针，水平拖动时播放对应方向的走路动画，停住后回到待机姿势', () => {
  const b = makeBrain();
  b.grab(500, 650); // 抓在脚底上方 50px
  assert.equal(b.view.mode, 'drag');
  for (let i = 1; i <= 10; i++) {
    b.update(1 / 60);
    b.dragTo(500 - i * 5, 650 - i * 10);
  }
  assert.equal(b.view.x, 450);
  assert.equal(b.view.y, 600);
  assert.deepEqual([b.view.anim, b.view.flip], ['walk', true]);
  run(b, TUNING.dragStill + 0.05);
  assert.equal(b.view.anim, 'idle');
});

test('甩出去：带着速度下落、不穿墙，最后落地待机', () => {
  const b = makeBrain();
  b.grab(500, 650);
  for (let i = 1; i <= 6; i++) {
    b.update(1 / 60);
    b.dragTo(500 + i * 40, 650 - i * 30); // 向右上方甩
  }
  b.release();
  assert.equal(b.view.mode, 'fall');
  assert.equal(b.vx, TUNING.maxThrow);
  let maxX = 0;
  for (let i = 0; i < 600 && b.view.mode === 'fall'; i++) {
    const v = b.update(1 / 60);
    maxX = Math.max(maxX, v.x);
    assert.ok(v.x <= AREA.width - BODY.right + 1e-9);
  }
  assert.equal(maxX, AREA.width - BODY.right); // 撞到了右墙
  assert.equal(b.view.mode, 'idle');
  assert.equal(b.view.y, 700);
});

test('多显示器：落到当前所在显示器的地面', () => {
  const right = { x: 1000, y: 100, width: 800, height: 500 };
  const b = makeBrain({ areas: [AREA, right], position: { x: 1400, y: 300 } });
  run(b, 2);
  assert.equal(b.view.y, 600);
  assert.equal(b.view.x, 1400);
});

test('随机决策按权重挑选', () => {
  // random 固定返回 0：总是挑第一个选项（继续待机）
  const b = makeBrain({ random: () => 0 });
  b.decideNext();
  assert.equal(b.view.mode, 'idle');
  // 返回接近 1：挑最后一个选项（睡觉）。随机动作默认关闭，这里显式打开
  const c = makeBrain({ random: seq(0.5, 0.999), settings: { randomActions: true } });
  c.decideNext();
  assert.equal(c.view.mode, 'sleep');
});
