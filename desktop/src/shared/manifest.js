// 宠物清单（pet.json）的规范化与校验。纯函数，无 Node / DOM 依赖：
// 主进程、校验脚本、单元测试共用同一套规则。
import { CODEX_CELL, CODEX_STATE_NAMES } from './codex.js';

export const WELL_KNOWN = [
  'idle', 'walk', 'walk-left', 'walk-right', 'drag', 'drag-left', 'drag-right', 'fall', 'sleep',
];

const DEFAULT_FPS = 8;
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

// Codex / Petdex 宠物：pet.json（id, displayName, description, spritesheetPath）
// + 8 列 × 9 行、每格 192×208 的精灵图。每行一个固定状态。
export const CODEX_ROWS = [
  // [Codex 状态, 本仓库动画名, 帧数, 每帧毫秒, 额外字段]
  ['idle', 'idle', 6, 180, {}],
  ['running-right', 'walk-right', 8, 180, {}],
  ['running-left', 'walk-left', 8, 180, {}],
  ['waving', 'waving', 4, 250, { label: '挥手', repeat: 2 }],
  ['jumping', 'jumping', 5, 200, { label: '跳一跳' }],
  ['failed', 'failed', 8, 180, { label: '失败了', repeat: 2, weight: 0.3 }],
  ['waiting', 'waiting', 6, 180, { label: '等待中', repeat: 3 }],
  ['running', 'running', 6, 180, { label: '忙碌中', repeat: 3 }],
  ['review', 'review', 6, 180, { label: '审阅', repeat: 3 }],
];

export function isCodexManifest(raw) {
  return !!raw && typeof raw === 'object' && typeof raw.spritesheetPath === 'string' && !raw.animations;
}

/** 把 Codex 格式的 pet.json 转成本仓库格式（之后再走统一的 normalize）。 */
export function fromCodexManifest(raw, dirName) {
  const animations = {};
  CODEX_ROWS.forEach(([, name, count, ms, extra], row) => {
    animations[name] = {
      sheet: { src: raw.spritesheetPath, cell: CODEX_CELL, row, count },
      fps: Math.round((1000 / ms) * 100) / 100,
      ...extra,
    };
  });
  return {
    id: raw.id || dirName,
    name: raw.displayName || raw.name || raw.id || dirName,
    description: raw.description || '',
    tags: ['Codex'],
    scale: 0.8,
    speed: 60,
    behavior: { click: 'waving', doubleClick: 'jumping' },
    animations,
  };
}

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function isPair(v) { return Array.isArray(v) && v.length === 2 && v.every(isNum); }

/** 相对路径检查：只允许宠物目录内的相对路径。返回规范化后的路径或 null。 */
export function safeRelPath(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const norm = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null;
  if (norm.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return norm;
}

/**
 * 规范化并校验一份清单。
 * @param {object} raw           解析后的 pet.json
 * @param {object} [opts]
 * @param {string} [opts.dirName]      宠物目录名（用于 id 缺省与一致性检查）
 * @param {(rel: string) => boolean} [opts.fileExists]  检查素材文件是否存在
 * @returns {{ pet: object|null, errors: string[], warnings: string[] }}
 */
export function normalizeManifest(raw, opts = {}) {
  const errors = [];
  const warnings = [];
  const { dirName, fileExists } = opts;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { pet: null, errors: ['pet.json 不是一个 JSON 对象'], warnings };
  }

  let format = 'pets';
  if (isCodexManifest(raw)) {
    format = 'codex';
    raw = fromCodexManifest(raw, dirName);
  }

  const id = raw.id ?? dirName;
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    errors.push(`id 无效：需要小写字母、数字、- _ . 组成（当前：${JSON.stringify(raw.id)}）`);
  } else if (dirName && id !== dirName && format === 'pets') {
    warnings.push(`id「${id}」与目录名「${dirName}」不一致，建议保持相同`);
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) errors.push('name 必填，且不能为空');

  const scale = raw.scale ?? 1;
  if (!isNum(scale) || scale <= 0 || scale > 10) errors.push('scale 必须是 0～10 之间的正数');
  const speed = raw.speed ?? 50;
  if (!isNum(speed) || speed < 0) errors.push('speed 必须是 ≥ 0 的数字（素材像素/秒）');
  if (raw.tags !== undefined && !(Array.isArray(raw.tags) && raw.tags.every((t) => typeof t === 'string'))) {
    errors.push('tags 必须是字符串数组');
  }

  const animations = {};
  const rawAnims = raw.animations;
  if (!rawAnims || typeof rawAnims !== 'object' || Array.isArray(rawAnims)) {
    errors.push('animations 必填，且必须是对象');
  } else {
    for (const [name, def] of Object.entries(rawAnims)) {
      const res = normalizeAnimation(name, def, { fileExists });
      errors.push(...res.errors);
      warnings.push(...res.warnings);
      if (res.anim) animations[name] = res.anim;
    }
    if (!rawAnims.idle) errors.push('缺少 idle 动画：每只宠物至少需要 idle');
  }

  const behavior = {};
  const rawBehavior = raw.behavior ?? {};
  if (typeof rawBehavior !== 'object' || Array.isArray(rawBehavior)) {
    errors.push('behavior 必须是对象');
  } else {
    for (const key of ['click', 'doubleClick']) {
      const v = rawBehavior[key];
      if (v === undefined) continue;
      if (typeof v !== 'string' || !(v in (rawAnims || {}))) {
        errors.push(`behavior.${key} 指向不存在的动画「${v}」`);
      } else {
        behavior[key] = v;
      }
    }
  }

  // 导出到 Codex 时的状态对应：{ "waving": "wave", ... }
  const codex = {};
  if (raw.codex !== undefined) {
    if (!raw.codex || typeof raw.codex !== 'object' || Array.isArray(raw.codex)) {
      errors.push('codex 必须是对象，例如 { "waving": "wave" }');
    } else {
      for (const [state, anim] of Object.entries(raw.codex)) {
        if (!CODEX_STATE_NAMES.includes(state)) errors.push(`codex.${state} 不是 Codex 的状态（可选：${CODEX_STATE_NAMES.join(' ')}）`);
        else if (typeof anim !== 'string' || !(anim in (rawAnims || {}))) errors.push(`codex.${state} 指向不存在的动画「${anim}」`);
        else codex[state] = anim;
      }
    }
  }

  const walkPair = ('walk-left' in animations) !== ('walk-right' in animations);
  if (walkPair && !animations.walk) {
    warnings.push('只定义了 walk-left / walk-right 其中之一，另一方向将无法行走（可补一个 walk 作为兜底）');
  }

  if (errors.length) return { pet: null, errors, warnings };

  const actions = Object.keys(animations).filter((n) => animations[n].label);
  return {
    pet: {
      format,
      id,
      name: raw.name.trim(),
      description: typeof raw.description === 'string' ? raw.description : '',
      author: typeof raw.author === 'string' ? raw.author : '',
      version: typeof raw.version === 'string' ? raw.version : '',
      license: typeof raw.license === 'string' ? raw.license : '',
      tags: raw.tags ?? [],
      scale,
      pixelated: raw.pixelated === true,
      speed,
      behavior,
      codex,
      animations,
      actions,
    },
    errors,
    warnings,
  };
}

function normalizeAnimation(name, def, { fileExists }) {
  const errors = [];
  const warnings = [];
  const at = `animations.${name}`;
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    return { anim: null, errors: [`${at} 必须是对象`], warnings };
  }
  const kinds = ['src', 'frames', 'sheet'].filter((k) => def[k] !== undefined);
  if (kinds.length !== 1) {
    return { anim: null, errors: [`${at} 需要且只能有 src / frames / sheet 其中一个`], warnings };
  }

  const anim = { name };
  const checkFile = (p, where) => {
    const rel = safeRelPath(p);
    if (!rel) { errors.push(`${where} 路径无效：只允许宠物目录内的相对路径（${JSON.stringify(p)}）`); return null; }
    if (fileExists && !fileExists(rel)) errors.push(`${where} 文件不存在：${rel}`);
    return rel;
  };

  if (def.fps !== undefined && (!isNum(def.fps) || def.fps <= 0 || def.fps > 120)) {
    errors.push(`${at}.fps 必须是 0～120 之间的正数`);
  }
  const frameMs = def.fps ? 1000 / def.fps : 1000 / DEFAULT_FPS;

  if (kinds[0] === 'src') {
    anim.kind = 'image';
    anim.src = checkFile(def.src, `${at}.src`);
    if (def.fps) anim.fps = def.fps;
  } else if (kinds[0] === 'frames') {
    anim.kind = 'frames';
    if (!Array.isArray(def.frames) || def.frames.length === 0) {
      errors.push(`${at}.frames 必须是非空数组`);
    } else {
      anim.frames = def.frames.map((fr, i) => {
        const where = `${at}.frames[${i}]`;
        const obj = typeof fr === 'string' ? { src: fr } : fr;
        if (!obj || typeof obj !== 'object') { errors.push(`${where} 必须是路径字符串或 {src, duration?, offset?}`); return null; }
        const src = checkFile(obj.src, where);
        const duration = obj.duration ?? frameMs;
        if (!isNum(duration) || duration <= 0) errors.push(`${where}.duration 必须是正数（毫秒）`);
        if (obj.offset !== undefined && !isPair(obj.offset)) errors.push(`${where}.offset 必须是 [x, y]`);
        return { src, duration, offset: obj.offset ?? [0, 0] };
      });
    }
  } else {
    anim.kind = 'sheet';
    const s = def.sheet;
    if (!s || typeof s !== 'object') {
      errors.push(`${at}.sheet 必须是对象 {src, cell, row, count}`);
    } else {
      const src = checkFile(s.src, `${at}.sheet.src`);
      if (!isPair(s.cell) || s.cell.some((v) => v <= 0)) errors.push(`${at}.sheet.cell 必须是 [宽, 高]`);
      const row = s.row ?? 0;
      const col = s.col ?? 0;
      if (!Number.isInteger(row) || row < 0) errors.push(`${at}.sheet.row 必须是 ≥ 0 的整数`);
      if (!Number.isInteger(col) || col < 0) errors.push(`${at}.sheet.col 必须是 ≥ 0 的整数`);
      if (!Number.isInteger(s.count) || s.count < 1) errors.push(`${at}.sheet.count 必须是 ≥ 1 的整数`);
      anim.sheet = { src, cell: s.cell, row, col, count: s.count };
      anim.frameMs = frameMs;
    }
  }

  const repeat = def.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) errors.push(`${at}.repeat 必须是 1～100 的整数`);
  anim.repeat = repeat;

  if (def.label !== undefined) {
    if (typeof def.label !== 'string' || !def.label.trim()) errors.push(`${at}.label 必须是非空字符串`);
    else anim.label = def.label.trim();
  }
  const weight = def.weight ?? (anim.label ? 1 : 0);
  if (!isNum(weight) || weight < 0) errors.push(`${at}.weight 必须是 ≥ 0 的数字`);
  anim.weight = weight;

  if (def.mirror !== undefined && typeof def.mirror !== 'boolean') errors.push(`${at}.mirror 必须是 true / false`);
  anim.mirror = def.mirror !== false;

  if (def.anchor !== undefined) {
    if (!isPair(def.anchor)) errors.push(`${at}.anchor 必须是 [x, y]`);
    else anim.anchor = def.anchor;
  }
  if (def.moveX !== undefined) {
    if (!isNum(def.moveX)) errors.push(`${at}.moveX 必须是数字（素材像素）`);
    else anim.moveX = def.moveX;
  }
  if (def.stepDistance !== undefined) {
    if (!isNum(def.stepDistance) || def.stepDistance <= 0) errors.push(`${at}.stepDistance 必须是正数（素材像素）`);
    else anim.stepDistance = def.stepDistance;
  }

  const known = new Set(['src', 'frames', 'sheet', 'fps', 'repeat', 'label', 'weight', 'mirror', 'anchor', 'moveX', 'stepDistance']);
  for (const key of Object.keys(def)) {
    if (!known.has(key)) warnings.push(`${at}.${key} 是未知字段，已忽略`);
  }
  return { anim: errors.length ? null : anim, errors, warnings };
}

/** 清单中引用到的全部素材相对路径（去重）。 */
export function referencedFiles(pet) {
  const out = new Set();
  for (const a of Object.values(pet.animations)) {
    if (a.src) out.add(a.src);
    if (a.sheet?.src) out.add(a.sheet.src);
    for (const f of a.frames ?? []) out.add(f.src);
  }
  return [...out];
}
