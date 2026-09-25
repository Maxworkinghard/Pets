// 桌宠窗口：加载动画 → 行为状态机驱动 → 移动透明窗口并绘制当前帧。
// 窗口大小 = 舞台（能装下所有动画），宠物脚底锚点固定在舞台的 (ax, ay)，移动窗口就是移动宠物。
import { PetBrain } from '../../shared/brain.js';
import { computeLayout, drawFrame, frameIndex, loadPetAnimations } from '../lib/player.js';

const host = window.petHost;
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const ALPHA_HIT = 40;

const init = await host.init();
if (!init) throw new Error('宠物窗口初始化失败');
const pet = init.record.pet;
let settings = init.settings;

let anims;
try {
  anims = await loadPetAnimations(pet, init.record.assetBase, (msg) => host.log('error', msg));
} catch (e) {
  host.log('fatal', `${pet.name}：${e.message}`);
  throw e;
}

let layout;
let dpr = window.devicePixelRatio || 1;
let dirty = true;
let shown = { anim: null, idx: -1, flip: false };
let lastBounds = null;

const brainSettings = (s) => ({ wander: s.wander, randomActions: s.randomActions, gravity: s.gravity });

function brainMetrics() {
  const s = layout.scale;
  const meta = {};
  for (const [name, a] of Object.entries(anims)) {
    const def = pet.animations[name];
    meta[name] = { durationMs: a.totalMs, repeat: def.repeat, weight: def.weight, label: def.label, moveX: (def.moveX ?? 0) * s, mirror: def.mirror };
  }
  return { anims: meta, speed: pet.speed * s, body: layout.body };
}

function relayout() {
  layout = computeLayout(pet, anims, pet.scale * settings.size);
  dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${layout.stage.w}px`;
  canvas.style.height = `${layout.stage.h}px`;
  canvas.width = Math.max(1, Math.round(layout.stage.w * dpr));
  canvas.height = Math.max(1, Math.round(layout.stage.h * dpr));
  dirty = true;
  lastBounds = null;
}

relayout();
const brain = new PetBrain({
  ...brainMetrics(),
  behavior: pet.behavior,
  areas: init.areas,
  settings: brainSettings(settings),
  position: init.position,
});

// ---------------------------------------------------------------- 绘制与移动

function draw(v) {
  const name = anims[v.anim] ? v.anim : 'idle';
  const anim = anims[name];
  const idx = frameIndex(anim, v.animTime, v.distance / layout.scale);
  if (!dirty && idx === shown.idx && name === shown.anim && v.flip === shown.flip) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = !pet.pixelated;
  ctx.imageSmoothingQuality = 'high';
  const src = drawFrame(ctx, anim, idx, layout.anchors[name], layout.stage.ax, layout.stage.ay, layout.scale, v.flip);
  dirty = !src?.exact; // 帧还在解码：下一拍再画
  shown = { anim: name, idx, flip: v.flip };
}

let prev = performance.now();
let lastSave = 0;
let saved = null;
let readySent = false;

function tick() {
  const now = performance.now();
  const v = brain.update((now - prev) / 1000);
  prev = now;
  if ((window.devicePixelRatio || 1) !== dpr) relayout();

  const b = { x: Math.round(v.x - layout.stage.ax), y: Math.round(v.y - layout.stage.ay), width: layout.stage.w, height: layout.stage.h };
  if (!lastBounds || b.x !== lastBounds.x || b.y !== lastBounds.y || b.width !== lastBounds.width || b.height !== lastBounds.height) {
    host.setBounds(b);
    lastBounds = b;
  }
  draw(v);
  if (!readySent) {
    host.ready();
    readySent = true;
  }
  if (now - lastSave > 3000 && v.mode !== 'drag' && v.mode !== 'fall') {
    lastSave = now;
    if (!saved || Math.abs(saved.x - v.x) > 2 || Math.abs(saved.y - v.y) > 2) {
      saved = { x: v.x, y: v.y };
      host.savePosition(saved);
    }
  }
}

// ---------------------------------------------------------------- 鼠标：像素级点击穿透、拖动、单击/双击

function hit(clientX, clientY) {
  const r = Math.max(1, Math.round(2 * dpr)); // 边缘放宽几像素，细小部位也好抓
  const x = Math.floor(clientX * dpr);
  const y = Math.floor(clientY * dpr);
  const sx = Math.max(0, x - r);
  const sy = Math.max(0, y - r);
  const w = Math.min(canvas.width, x + r + 1) - sx;
  const h = Math.min(canvas.height, y + r + 1) - sy;
  if (w <= 0 || h <= 0) return false;
  const data = ctx.getImageData(sx, sy, w, h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > ALPHA_HIT) return true;
  return false;
}

let ignoring = true; // 主进程创建窗口时已设为穿透
function setIgnore(value) {
  if (value !== ignoring) {
    ignoring = value;
    host.setIgnoreMouse(value);
  }
}

let press = null;
let clickTimer = null;

function onClick() {
  if (!pet.behavior.doubleClick) return brain.click();
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    brain.doubleClick();
  } else {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      brain.click();
    }, 280);
  }
}

function endPress(cancelled) {
  const p = press;
  press = null;
  if (!p) return;
  if (p.dragging) brain.release();
  else if (!cancelled) onClick();
}

window.addEventListener('mousemove', (e) => {
  if (!press) setIgnore(!hit(e.clientX, e.clientY));
});
document.addEventListener('mouseleave', () => {
  if (!press) setIgnore(true);
});
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !hit(e.clientX, e.clientY)) return;
  canvas.setPointerCapture(e.pointerId);
  press = { x: e.screenX, y: e.screenY, dragging: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (!press) return;
  if (!press.dragging) {
    if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < 4) return;
    press.dragging = true;
    brain.grab(press.x, press.y);
  }
  brain.dragTo(e.screenX, e.screenY);
});
canvas.addEventListener('pointerup', () => endPress(false));
canvas.addEventListener('pointercancel', () => endPress(true));
canvas.addEventListener('lostpointercapture', () => endPress(true));
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (hit(e.clientX, e.clientY)) host.showMenu();
});

// ---------------------------------------------------------------- 主进程指令

host.onCommand((cmd) => {
  if (cmd.type === 'play') brain.play(cmd.name);
  else if (cmd.type === 'areas') brain.setAreas(cmd.areas);
  else if (cmd.type === 'settings') {
    const resized = cmd.settings.size !== settings.size;
    settings = cmd.settings;
    brain.setSettings(brainSettings(settings));
    if (resized) {
      relayout();
      brain.setMetrics(brainMetrics());
    }
  }
});

// 调试（--pets-debug）：暴露内部状态，方便自动化测试
if (init.debug) {
  window.__pet = { brain, anims, hit, get layout() { return layout; }, get ignoring() { return ignoring; } };
}

tick();
setInterval(tick, 16);
