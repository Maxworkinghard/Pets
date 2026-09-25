// Codex 宠物格式（纯逻辑）：读取 Codex 宠物、以及把本仓库的宠物导出成 Codex 宠物时，
// 九个状态行从哪个动画取帧、取哪几帧、怎么缩放进 192×208 的格子。
//
// Codex 规格（v1）：spritesheet 为 8 列 × 9 行、每格 192×208（1536×1872），
// pet.json = { id, displayName, description, spritesheetPath }。每行帧数固定，未用的格子必须全透明。

export const CODEX_CELL = [192, 208];
export const CODEX_COLUMNS = 8;
export const CODEX_MARGIN = [18, 16]; // 格子内留白（左右、上下），与 hatch-pet 的布局参考线一致

// [状态, 每帧时长（毫秒，来自 hatch-pet 的 animation-rows.md）]
export const CODEX_STATES = [
  ['idle', [280, 110, 110, 140, 140, 320]],
  ['running-right', [120, 120, 120, 120, 120, 120, 120, 220]],
  ['running-left', [120, 120, 120, 120, 120, 120, 120, 220]],
  ['waving', [140, 140, 140, 280]],
  ['jumping', [140, 140, 140, 140, 280]],
  ['failed', [140, 140, 140, 140, 140, 140, 140, 240]],
  ['waiting', [150, 150, 150, 150, 150, 260]],
  ['running', [120, 120, 120, 120, 120, 220]],
  ['review', [150, 150, 150, 150, 150, 280]],
];
export const CODEX_STATE_NAMES = CODEX_STATES.map(([s]) => s);

// 导出时每个 Codex 状态依次尝试的动画名；"@click" / "@doubleClick" 指 behavior 里配置的动画
const CANDIDATES = {
  idle: ['idle'],
  'running-right': ['running-right', 'walk-right', 'walk', 'drag-right'],
  'running-left': ['running-left', 'walk-left', 'walk', 'drag-left'],
  waving: ['waving', 'wave', '@click'],
  jumping: ['jumping', 'jump', 'jump-happy', '@doubleClick'],
  failed: ['failed', 'error'],
  waiting: ['waiting', 'think', 'listening'],
  running: ['running', 'type-keyboard', 'type', 'working'],
  review: ['review', 'peek', 'point'],
};

/**
 * 决定每个 Codex 状态用哪个动画。pet.codex 里可以逐个指定，没指定的按常见命名猜，猜不到用 idle。
 * 带 moveX 的动画（靠移动窗口实现位移）不会被选用。
 * @returns {{state:string, anim:string, flip:boolean, count:number, durations:number[], guessed:boolean}[]}
 */
export function planCodexExport(pet) {
  const usable = (name) => !!name && !!pet.animations[name] && !pet.animations[name].moveX;
  return CODEX_STATES.map(([state, durations]) => {
    let anim = pet.codex?.[state];
    let guessed = false;
    if (!usable(anim)) {
      guessed = true;
      anim = CANDIDATES[state]
        .map((c) => (c === '@click' ? pet.behavior?.click : c === '@doubleClick' ? pet.behavior?.doubleClick : c))
        .find(usable) ?? 'idle';
    }
    // 通用的 walk / drag 素材默认朝右，向左那一行要镜像
    const flip = state === 'running-left' && (anim === 'walk' || anim === 'drag') && pet.animations[anim].mirror !== false;
    return { state, anim, flip, count: durations.length, durations, guessed };
  });
}

/**
 * 从一个动画里取 count 帧填进 Codex 的一行。
 * - cycle：按顺序循环取帧（走路动画这样取，步伐节奏清楚）
 * - 否则按时间取样：把动画的一整遍压缩/拉伸到 Codex 这一行的总时长，在每个格子的时间中点取帧
 * @param {number[]} frameMs 动画每帧时长
 * @returns {number[]} 每个格子对应的帧下标
 */
export function sampleFrames(frameMs, count, codexMs, { cycle = false } = {}) {
  const n = frameMs.length;
  if (n <= 1) return Array(count).fill(0);
  if (cycle) return Array.from({ length: count }, (_, k) => k % n);
  const total = frameMs.reduce((s, d) => s + d, 0);
  const codexTotal = codexMs.reduce((s, d) => s + d, 0);
  const out = [];
  let acc = 0;
  for (let k = 0; k < count; k++) {
    let t = ((acc + codexMs[k] / 2) / codexTotal) * total;
    let i = 0;
    while (i < n - 1 && t >= frameMs[i]) t -= frameMs[i++];
    out.push(i);
    acc += codexMs[k];
  }
  return out;
}

/**
 * 统一缩放：让所有导出帧（相对脚底锚点的范围）都装进格子的留白之内，脚底落在同一条基线上。
 * @param {{left:number, right:number, up:number, down:number}} ext 素材像素
 * @returns {{scale:number, anchorX:number, anchorY:number}} 锚点在格子内的位置
 */
export function fitToCell(ext, { pixelated = false } = {}) {
  const [cw, ch] = CODEX_CELL;
  const [mx, my] = CODEX_MARGIN;
  const half = Math.max(ext.left, ext.right, 1);
  let scale = Math.min((cw - 2 * mx) / (2 * half), (ch - 2 * my) / Math.max(1, ext.up + ext.down), 3);
  // 像素画按 1/8 取整，避免大像素块被缩成宽窄不一
  if (pixelated) scale = scale >= 1 ? Math.floor(scale) : Math.floor(scale * 8) / 8 || scale;
  return { scale, anchorX: cw / 2, anchorY: ch - my - ext.down * scale };
}
