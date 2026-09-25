// 宠物行为状态机。纯逻辑：输入时间流逝与指针事件，输出「现在播哪个动画、脚底在屏幕哪里」。
// 坐标单位是屏幕 DIP；(x, y) 是宠物「脚底锚点」在屏幕上的位置。
//
// 模式：idle 待机 → walk 走动 / action 动作 / sleep 睡觉；drag 被拖着；fall 松手后下落。

export const TUNING = {
  gravity: 2600, // 下落加速度 DIP/s²
  idle: [2.5, 7], // 每段待机时长（秒）
  walk: [2, 6], // 每段行走时长（秒）
  sleep: [25, 70], // 每次睡觉时长（秒）
  dragDirSpeed: 40, // 拖动时水平速度超过它才算「朝某方向拖」DIP/s
  dragStill: 0.15, // 这么久（秒）没移动就算停住
  maxThrow: 1800, // 甩出去的最大速度 DIP/s
  wallBounce: 0.4, // 撞墙后保留的水平速度比例
  airDrag: 1.5, // 空中水平速度衰减 1/s
};

// 这些动画由状态机自己驱动，不会被当成「随机动作」挑中
const LOCOMOTION = new Set(['idle', 'walk', 'walk-left', 'walk-right', 'drag', 'drag-left', 'drag-right', 'fall', 'sleep']);

const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));

function weightedPick(options, random) {
  const total = options.reduce((s, [, w]) => s + w, 0);
  let r = random() * total;
  for (const [key, w] of options) {
    r -= w;
    if (r < 0) return key;
  }
  return options[options.length - 1][0];
}

export class PetBrain {
  /**
   * @param {object} o
   * @param {Record<string, {durationMs:number, repeat?:number, weight?:number, label?:string, moveX?:number, mirror?:boolean}>} o.anims
   *        动画元数据：durationMs 为播一遍的时长；moveX 已换算成 DIP
   * @param {{click?:string, doubleClick?:string}} [o.behavior]
   * @param {number} o.speed 行走速度 DIP/s
   * @param {{left:number, right:number, top:number}} o.body 身体相对脚底锚点向左/右/上的范围（DIP）
   * @param {{x:number, y:number, width:number, height:number}[]} o.areas 各显示器的工作区（DIP）
   * @param {{wander?:boolean, randomActions?:boolean, gravity?:boolean}} [o.settings]
   * @param {{x:number, y:number}} o.position 初始脚底位置
   * @param {() => number} [o.random]
   */
  constructor(o) {
    this.random = o.random ?? Math.random;
    this.behavior = o.behavior ?? {};
    this.settings = { wander: true, randomActions: true, gravity: true, ...o.settings };
    this.areas = o.areas;
    this.setMetrics(o);
    this.x = o.position.x;
    this.y = o.position.y;
    this.vx = 0;
    this.vy = 0;
    this.clock = 0;
    this.facing = 1;
    this.anim = null;
    this.flip = false;
    this.animTime = 0;
    this.distance = 0;
    this.toIdle();
  }

  // ------------------------------------------------------------------ 外部输入

  setMetrics({ anims, speed, body }) {
    this.anims = anims;
    this.speed = speed;
    this.body = body;
    if (this.anim && !this.anims[this.anim]) this.toIdle();
  }

  setAreas(areas) {
    if (areas?.length) this.areas = areas;
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    if (!this.settings.wander && this.mode === 'walk') this.toIdle();
  }

  get isDragging() {
    return this.mode === 'drag';
  }

  get view() {
    return { mode: this.mode, anim: this.anim, flip: this.flip, x: this.x, y: this.y, animTime: this.animTime, distance: this.distance };
  }

  /** 按下并开始拖动（px, py 为指针的屏幕坐标）。 */
  grab(px, py) {
    this.mode = 'drag';
    this.grabOffset = [this.x - px, this.y - py];
    this.samples = [[this.clock, px, py]];
    this.dragDir = 0;
    this.setAnim(...this.dragAnim(0));
  }

  dragTo(px, py) {
    if (this.mode !== 'drag') return;
    const nx = px + this.grabOffset[0];
    this.distance += Math.abs(nx - this.x);
    this.x = nx;
    this.y = py + this.grabOffset[1];
    this.samples.push([this.clock, px, py]);
    while (this.samples.length > 2 && this.samples[0][0] < this.clock - 0.12) this.samples.shift();
    this.updateDragAnim();
  }

  release() {
    if (this.mode !== 'drag') return;
    const moving = this.clock - this.samples[this.samples.length - 1][0] <= TUNING.dragStill;
    const [vx, vy] = moving ? this.dragVelocity() : [0, 0];
    const cap = (v) => clamp(v, -TUNING.maxThrow, TUNING.maxThrow);
    if (this.settings.gravity) {
      this.startFall(cap(vx), cap(vy));
    } else {
      const L = this.limits();
      this.x = clamp(this.x, L.minX, L.maxX);
      this.y = clamp(this.y, L.ceil, L.floor);
      this.toIdle();
    }
  }

  click() {
    this.react(this.behavior.click);
  }

  doubleClick() {
    this.react(this.behavior.doubleClick ?? this.behavior.click);
  }

  /** 播放指定动画（右键菜单 / 外部指令）。 */
  play(name) {
    if (this.mode === 'drag' || this.mode === 'fall') return false;
    if (name === 'idle') this.toIdle();
    else if (name === 'sleep' && this.anims.sleep) this.startSleep();
    else if (name === 'walk' || name === 'walk-left' || name === 'walk-right') {
      if (!this.canWalk()) return false;
      this.startWalk(name === 'walk-left' ? -1 : name === 'walk-right' ? 1 : undefined);
    } else if (this.anims[name] && !LOCOMOTION.has(name)) this.startAction(name);
    else return false;
    return true;
  }

  // ------------------------------------------------------------------ 时间推进

  update(dt) {
    dt = clamp(dt, 0, 0.1);
    this.clock += dt;
    this.animTime += dt * 1000;
    const mode = this.mode;
    if (mode === 'drag') {
      this.updateDragAnim();
      return this.view;
    }
    if (mode === 'fall') {
      this.updateFall(dt);
      return this.view;
    }
    this.t += dt;
    if (mode === 'walk') this.updateWalk(dt);
    if (this.settle()) return this.view;
    if (mode === 'idle' && this.t >= this.dur) this.decideNext();
    else if ((mode === 'walk' || mode === 'sleep') && this.t >= this.dur) this.toIdle();
    else if (mode === 'action' && this.t * 1000 >= this.actionMs) this.finishAction();
    return this.view;
  }

  // ------------------------------------------------------------------ 内部

  /** 当前所在显示器的活动范围。 */
  limits() {
    let area = this.areas[0];
    let best = Infinity;
    for (const a of this.areas) {
      const dx = this.x < a.x ? a.x - this.x : this.x > a.x + a.width ? this.x - a.x - a.width : 0;
      const y = this.y - 1;
      const dy = y < a.y ? a.y - y : y > a.y + a.height ? y - a.y - a.height : 0;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; area = a; }
    }
    return {
      minX: area.x + this.body.left,
      maxX: area.x + area.width - this.body.right,
      ceil: area.y + this.body.top,
      floor: area.y + area.height,
    };
  }

  /** 把宠物放回活动范围内；开启重力且悬空时开始下落（返回 true）。 */
  settle() {
    const L = this.limits();
    this.x = clamp(this.x, L.minX, L.maxX);
    if (this.settings.gravity) {
      if (this.y < L.floor - 1) {
        this.startFall(0, 0);
        return true;
      }
      this.y = L.floor;
    } else {
      this.y = clamp(this.y, L.ceil, L.floor);
    }
    return false;
  }

  setAnim(name, flip = false, restart = false) {
    if (restart || name !== this.anim || flip !== this.flip) {
      this.anim = name;
      this.flip = flip;
      this.animTime = 0;
      this.distance = 0;
    }
  }

  walkAnim(dir) {
    if (dir > 0 && this.anims['walk-right']) return ['walk-right', false];
    if (dir < 0 && this.anims['walk-left']) return ['walk-left', false];
    if (this.anims.walk) return ['walk', dir < 0 && this.anims.walk.mirror !== false];
    return null;
  }

  dragAnim(dir) {
    if (dir > 0 && this.anims['drag-right']) return ['drag-right', false];
    if (dir < 0 && this.anims['drag-left']) return ['drag-left', false];
    if (dir !== 0) {
      const walk = this.walkAnim(dir);
      if (walk) return walk;
    }
    if (this.anims.drag) return ['drag', dir < 0 && this.anims.drag.mirror !== false];
    return ['idle', false];
  }

  canWalk() {
    return this.speed > 0 && !!this.walkAnim(1) && !!this.walkAnim(-1);
  }

  toIdle() {
    this.mode = 'idle';
    this.t = 0;
    this.dur = this.rand(TUNING.idle);
    this.setAnim('idle');
  }

  startWalk(dir) {
    const L = this.limits();
    let d = dir ?? (this.random() < 0.5 ? -1 : 1);
    if (dir === undefined) {
      const margin = Math.min(120, (L.maxX - L.minX) / 4);
      if (this.x - L.minX < margin) d = 1;
      else if (L.maxX - this.x < margin) d = -1;
    }
    this.mode = 'walk';
    this.t = 0;
    this.dur = this.rand(TUNING.walk);
    this.facing = d;
    this.setAnim(...this.walkAnim(d));
  }

  updateWalk(dt) {
    const L = this.limits();
    const step = this.speed * dt;
    this.x += this.facing * step;
    this.distance += step;
    if (this.x <= L.minX && this.facing < 0) this.turn(1);
    else if (this.x >= L.maxX && this.facing > 0) this.turn(-1);
  }

  turn(dir) {
    this.facing = dir;
    this.setAnim(...this.walkAnim(dir));
  }

  startAction(name) {
    const a = this.anims[name];
    this.mode = 'action';
    this.action = name;
    this.t = 0;
    this.actionMs = Math.max(1, a.durationMs) * (a.repeat ?? 1);
    this.setAnim(name, false, true);
  }

  finishAction() {
    const a = this.anims[this.action];
    if (a?.moveX) {
      const L = this.limits();
      this.x = clamp(this.x + a.moveX, L.minX, L.maxX);
    }
    this.toIdle();
  }

  startSleep() {
    this.mode = 'sleep';
    this.t = 0;
    this.dur = this.rand(TUNING.sleep);
    this.setAnim('sleep');
  }

  react(name) {
    if (this.mode === 'drag' || this.mode === 'fall') return;
    if (this.mode === 'sleep') this.toIdle();
    if (name && this.anims[name]) this.play(name);
  }

  /** 待机结束后决定下一步：继续待机 / 走一走 / 做个动作 / 睡一觉。 */
  decideNext() {
    const options = [['idle', 3]];
    if (this.settings.wander && this.canWalk()) options.push(['walk', 4]);
    if (this.settings.randomActions) {
      const acts = this.actionCandidates();
      const total = acts.reduce((s, [, w]) => s + w, 0);
      for (const [name, w] of acts) options.push([`action:${name}`, (3 * w) / total]);
      if (this.anims.sleep) options.push(['sleep', 0.5]);
    }
    const pick = weightedPick(options, this.random);
    if (pick === 'walk') this.startWalk();
    else if (pick === 'sleep') this.startSleep();
    else if (pick.startsWith('action:')) this.startAction(pick.slice(7));
    else this.toIdle();
  }

  /** 可以被随机挑中的动作：有 label、权重 > 0；带位移的动作只在允许走动且不会出界时才算。 */
  actionCandidates() {
    const L = this.limits();
    return Object.entries(this.anims)
      .filter(([name, a]) => a.label && a.weight > 0 && !LOCOMOTION.has(name))
      .filter(([, a]) => !a.moveX || (this.settings.wander && this.x + a.moveX >= L.minX && this.x + a.moveX <= L.maxX))
      .map(([name, a]) => [name, a.weight]);
  }

  dragVelocity() {
    const s = this.samples;
    const [t0, x0, y0] = s[0];
    const [t1, x1, y1] = s[s.length - 1];
    const dt = t1 - t0;
    return dt > 0 ? [(x1 - x0) / dt, (y1 - y0) / dt] : [0, 0];
  }

  updateDragAnim() {
    const last = this.samples[this.samples.length - 1];
    let dir = this.dragDir;
    if (this.clock - last[0] > TUNING.dragStill) dir = 0;
    else {
      const [vx] = this.dragVelocity();
      if (Math.abs(vx) > TUNING.dragDirSpeed) dir = Math.sign(vx);
      else if (Math.abs(vx) < TUNING.dragDirSpeed / 2) dir = 0;
    }
    this.dragDir = dir;
    this.setAnim(...this.dragAnim(dir));
  }

  startFall(vx, vy) {
    this.mode = 'fall';
    this.vx = vx;
    this.vy = vy;
    if (this.anims.fall) this.setAnim('fall');
    else this.setAnim(...this.dragAnim(0));
  }

  updateFall(dt) {
    const L = this.limits();
    this.vy += TUNING.gravity * dt;
    this.vx *= Math.exp(-TUNING.airDrag * dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (this.x < L.minX) { this.x = L.minX; this.vx = Math.abs(this.vx) * TUNING.wallBounce; }
    if (this.x > L.maxX) { this.x = L.maxX; this.vx = -Math.abs(this.vx) * TUNING.wallBounce; }
    if (this.y < L.ceil) { this.y = L.ceil; this.vy = Math.abs(this.vy) * 0.3; }
    if (this.y >= L.floor) {
      this.y = L.floor;
      this.vx = 0;
      this.vy = 0;
      this.toIdle();
    }
  }

  rand([lo, hi]) {
    return lo + this.random() * (hi - lo);
  }
}
