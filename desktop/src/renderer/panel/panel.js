// 控制面板：浏览宠物仓库、预览动画、选择桌宠、导入到 Codex、调整设置。
import { planCodexExport } from '../../shared/codex.js';
import { renderCodexAtlas } from '../lib/codex-export.js';
import { drawFrame, loadAnimation, opaqueBounds } from '../lib/player.js';

const api = window.pets;
const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SLOT_LABELS = {
  idle: '待机',
  walk: '走路',
  'walk-left': '向左走',
  'walk-right': '向右走',
  drag: '被拖动',
  'drag-left': '向左拖',
  'drag-right': '向右拖',
  fall: '下落',
  sleep: '睡觉',
};
const SOURCE_LABELS = { bundled: '仓库', user: '我的', codex: 'Codex' };
const SOURCE_NAMES = { bundled: '仓库宠物', user: '我的宠物', codex: 'Codex 宠物' };
const CODEX_LABELS = {
  'running-right': '向右跑',
  'running-left': '向左跑',
  waving: '挥手',
  jumping: '跳跃',
  failed: '失败',
  waiting: '等待',
  running: '忙碌',
  review: '审阅',
};
const FILTERS = [
  ['all', '全部'],
  ['bundled', '仓库'],
  ['user', '我的'],
  ['codex', 'Codex'],
];

const state = { app: null, records: [], filter: 'all', query: '', selected: null, anim: 'idle', view: 'library', exporting: null };
const els = {
  grid: $('#grid'),
  problems: $('#problems'),
  detail: $('#detail'),
  status: $('#status'),
  filters: $('#filters'),
  search: $('#search'),
  settings: $('#settings'),
  toast: $('#toast'),
};

const animLabel = (pet, name) => pet.animations[name]?.label ?? SLOT_LABELS[name] ?? name;
const validRecords = () => state.records.filter((r) => r.pet);
const byKey = (key) => state.records.find((r) => r.key === key);
const isLive = (key) => !!state.app?.visible && state.app.activeKey === key;

// ---------------------------------------------------------------- 动画预览

const animCache = new Map(); // `${key}|${动画名}` → Promise<Anim>
const fitCache = new Map(); // key → idle 第一帧的身体范围，用于统一缩放与对齐

function getAnim(record, name) {
  const k = `${record.key}|${name}`;
  if (!animCache.has(k)) animCache.set(k, loadAnimation(record.pet.animations[name], record.assetBase));
  return animCache.get(k);
}

function petFit(record) {
  if (!fitCache.has(record.key)) {
    fitCache.set(
      record.key,
      getAnim(record, 'idle').then((idle) => {
        const b = opaqueBounds(idle, 0) ?? { x0: 0, y0: 0, x1: idle.box.w, y1: idle.box.h };
        return { padBottom: idle.box.h - b.y1, bw: b.x1 - b.x0, bh: b.y1 - b.y0, cx: (b.x0 + b.x1) / 2 - idle.box.w / 2 };
      }),
    );
  }
  return fitCache.get(record.key);
}

const previews = new Set();

class Preview {
  constructor(canvas, record, fill) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.record = record;
    this.fill = fill;
    this.visible = true;
    this.token = 0;
    previews.add(this);
  }

  async play(name) {
    const token = ++this.token;
    try {
      const [anim, fit] = await Promise.all([getAnim(this.record, name), petFit(this.record)]);
      if (token !== this.token) return;
      Object.assign(this, { anim, fit, name, start: performance.now(), lastIdx: -1, dirty: true });
    } catch (e) {
      if (token === this.token) toast(`预览失败：${e.message}`, 'error');
    }
  }

  draw(now) {
    if (!this.visible || !this.anim) return;
    const c = this.canvas;
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      this.dirty = true;
    }
    const a = this.anim;
    const t = now - this.start;
    // 按距离换帧的走路动画，在预览里按固定节奏播放
    const idx = a.def.stepDistance ? Math.floor(t / 200) % a.frames.length : a.indexAt(t);
    if (!this.dirty && idx === this.lastIdx) return;
    const pet = this.record.pet;
    const { fit } = this;
    const scale = Math.min((W * 0.86) / fit.bw, (H * this.fill) / fit.bh, pet.pixelated ? 4 : 1.5);
    const anchor = pet.animations[this.name].anchor ?? [a.box.w / 2, a.box.h - fit.padBottom];
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = !pet.pixelated;
    ctx.imageSmoothingQuality = 'high';
    const src = drawFrame(ctx, a, idx, anchor, W / 2 - fit.cx * scale, H * 0.93, scale);
    this.dirty = !src?.exact;
    this.lastIdx = idx;
  }

  dispose() {
    this.token++;
    previews.delete(this);
  }
}

function loop(now) {
  for (const p of previews) p.draw(now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------------------------------------------------------------- 宠物网格

const cardPreviews = new Map();
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const p = cardPreviews.get(e.target.dataset.key);
      if (p) p.visible = e.isIntersecting;
    }
  },
  { root: $('.library-main') },
);

function matches(r) {
  if (state.filter !== 'all' && r.source !== state.filter) return false;
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const p = r.pet;
  return [p.name, p.id, p.description, ...p.tags].some((s) => s?.toLowerCase().includes(q));
}

function renderFilters() {
  const counts = { all: validRecords().length };
  for (const r of validRecords()) counts[r.source] = (counts[r.source] ?? 0) + 1;
  els.filters.innerHTML = FILTERS.map(
    ([id, label]) =>
      `<button data-filter="${id}" class="${state.filter === id ? 'is-active' : ''}">${label}<span>${counts[id] ?? 0}</span></button>`,
  ).join('');
}

function cardHtml(r) {
  const p = r.pet;
  const tags = p.tags
    .slice(0, 2)
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join('');
  return `<article class="card" data-key="${esc(r.key)}" tabindex="0" aria-label="${esc(p.name)}">
    <div class="stage"><canvas></canvas><span class="badge-live">在桌面上</span>
      <button class="btn btn-primary summon" data-action="activate">召唤</button></div>
    <div class="card-body">
      <div class="card-title"><span class="name">${esc(p.name)}</span>${
        r.source === 'bundled' ? '' : `<span class="source">${SOURCE_LABELS[r.source]}</span>`
      }</div>
      <p class="card-desc">${esc(p.description || '（还没有描述）')}</p>
      <div class="card-meta">${tags}<span class="count">${p.actions.length ? `${p.actions.length} 个动作` : ''}</span></div>
    </div>
  </article>`;
}

function renderGrid() {
  for (const p of cardPreviews.values()) p.dispose();
  cardPreviews.clear();
  io.disconnect();
  const list = validRecords().filter(matches);
  if (!list.length) {
    els.grid.innerHTML = validRecords().length
      ? '<div class="empty"><strong>没有找到匹配的宠物</strong>换个关键词或来源试试</div>'
      : '<div class="empty"><strong>宠物仓库是空的</strong>把宠物文件夹放进「我的宠物」目录，或者点「导入宠物」</div>';
  } else {
    els.grid.innerHTML = list.map(cardHtml).join('');
    for (const card of els.grid.querySelectorAll('.card')) {
      const record = byKey(card.dataset.key);
      const preview = new Preview(card.querySelector('canvas'), record, 0.8);
      preview.play('idle');
      cardPreviews.set(record.key, preview);
      io.observe(card);
    }
  }
  updateCards();
}

function updateCards() {
  for (const card of els.grid.querySelectorAll('.card')) {
    card.classList.toggle('is-selected', card.dataset.key === state.selected);
    card.classList.toggle('is-live', isLive(card.dataset.key));
  }
}

function renderProblems() {
  const bad = state.records.filter((r) => !r.pet);
  els.problems.innerHTML = bad.length
    ? `<h3>有 ${bad.length} 只宠物无法加载</h3>` +
      bad
        .map(
          (r) => `<div class="problem"><b>${esc(r.dirName)}</b>（${SOURCE_NAMES[r.source]}）
            <ul>${r.errors
              .slice(0, 8)
              .map((e) => `<li>${esc(e)}</li>`)
              .join('')}</ul></div>`,
        )
        .join('')
    : '';
}

// ---------------------------------------------------------------- 详情

let detailPreview = null;

function interactionText(pet) {
  const parts = [];
  if (pet.behavior.click) parts.push(`单击「${animLabel(pet, pet.behavior.click)}」`);
  if (pet.behavior.doubleClick) parts.push(`双击「${animLabel(pet, pet.behavior.doubleClick)}」`);
  const walks = ['walk', 'walk-left', 'walk-right'].some((n) => pet.animations[n]);
  const moves = Object.values(pet.animations).some((a) => a.moveX);
  parts.push(walks ? '会自己走动' : moves ? '会遁地移动' : '待在原地');
  return parts.join('，');
}

function renderDetail() {
  detailPreview?.dispose();
  detailPreview = null;
  const r = byKey(state.selected);
  if (!r?.pet) {
    els.detail.innerHTML = '<div class="detail-empty">在左边选一只宠物，看看它会做什么</div>';
    return;
  }
  const p = r.pet;
  const names = Object.keys(p.animations);
  const chips = names
    .map((n) => {
      const cls = ['chip', p.animations[n].label ? '' : 'is-slot', n === state.anim ? 'is-active' : ''].join(' ');
      return `<button class="${cls}" data-anim="${esc(n)}" title="${esc(n)}">${esc(animLabel(p, n))}</button>`;
    })
    .join('');
  const sub = [
    SOURCE_NAMES[r.source],
    p.version && `v${esc(p.version)}`,
    p.author && `作者 ${esc(p.author)}`,
    p.format === 'codex' && 'Codex 格式',
  ]
    .filter(Boolean)
    .join(' · ');
  els.detail.innerHTML = `
    <div class="stage"><canvas></canvas><span class="detail-anim" id="detail-anim"></span></div>
    <div class="detail-body">
      <h2>${esc(p.name)}</h2>
      <div class="detail-sub">${sub}</div>
      <p class="detail-desc">${esc(p.description || '这只宠物还没有描述。')}</p>
      <div class="detail-actions" id="detail-actions"></div>
      <div id="codex-box"></div>
      <h3>动画 <small>点一下预览</small></h3>
      <div class="chips">${chips}</div>
      <div id="play-live"></div>
      <h3>信息</h3>
      <dl class="facts">
        <dt>动画</dt><dd>${names.length} 个${p.actions.length ? `，${p.actions.length} 个可在右键菜单里点` : ''}</dd>
        <dt>互动</dt><dd>${esc(interactionText(p))}</dd>
        ${
          r.source === 'codex'
            ? ''
            : `<dt>Codex</dt><dd title="导入到 Codex 时，Codex 的各个状态用哪个动画；可在 pet.json 的 codex 字段里修改">${esc(codexMappingText(p))}</dd>`
        }
        <dt>ID</dt><dd>${esc(p.id)}</dd>
        <dt>文件夹</dt><dd><button class="link" data-action="open-folder" title="在资源管理器中打开">${esc(r.dir)}</button></dd>
      </dl>
      ${
        r.warnings.length
          ? `<div class="warnings"><b>提示</b><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
          : ''
      }
    </div>`;
  detailPreview = new Preview(els.detail.querySelector('canvas'), r, 0.72);
  playDetail(state.anim in p.animations ? state.anim : 'idle');
  renderDetailActions();
  renderCodexBox();
}

/** 导出到 Codex 时每个状态用哪个动画，例如「挥手←打招呼 · 跳跃←跳跃」。 */
function codexMappingText(pet) {
  return planCodexExport(pet)
    .filter((row) => row.state !== 'idle')
    .map((row) => `${CODEX_LABELS[row.state]}←${animLabel(pet, row.anim)}${row.flip ? '（镜像）' : ''}`)
    .join(' · ');
}

function renderCodexBox() {
  const box = $('#codex-box');
  const r = byKey(state.selected);
  if (!box || !r?.pet) return;
  if (r.source === 'codex') {
    box.innerHTML = '<p class="hint-sm">这只宠物来自 Codex，本来就能在 Codex 里用。</p>';
    return;
  }
  const busy = state.exporting === r.key;
  const done = r.codexExport;
  const label = busy ? '正在转换…' : done ? '更新 Codex 里的版本' : '导入到 Codex';
  box.innerHTML = `
    <button class="btn btn-block codex-btn" data-action="codex" ${busy ? 'disabled' : ''}>${label}</button>
    <p class="hint-sm">${
      done
        ? `已在 Codex 中（文件夹 ${esc(done.folder)}）。在 Codex 的「设置 → 外观 → 宠物」里选择「${esc(r.pet.name)}」即可使用。`
        : '转换成 Codex 宠物格式，装进 ~/.codex/pets；之后在 Codex 的「设置 → 外观 → 宠物」里选择它。'
    }</p>`;
}

async function exportToCodex(key) {
  const r = byKey(key);
  if (!r?.pet || state.exporting) return;
  state.exporting = key;
  renderCodexBox();
  try {
    const { bytes } = await renderCodexAtlas(r.pet, (name) => getAnim(r, name));
    const res = await api.installToCodex(key, bytes);
    if (!res.ok) throw new Error(res.error);
    toast(`已导入 Codex（${res.folder}）。在 Codex 的「设置 → 外观 → 宠物」里选择「${r.pet.name}」`, 'info', 7000);
  } catch (e) {
    toast(`导入 Codex 失败：${e.message}`, 'error');
  } finally {
    state.exporting = null;
    renderCodexBox();
  }
}

function playDetail(name) {
  const r = byKey(state.selected);
  if (!r?.pet) return;
  state.anim = name;
  detailPreview?.play(name);
  $('#detail-anim').textContent = animLabel(r.pet, name);
  for (const c of els.detail.querySelectorAll('.chip')) c.classList.toggle('is-active', c.dataset.anim === name);
  renderPlayLive();
}

function renderDetailActions() {
  const box = $('#detail-actions');
  if (!box) return;
  box.innerHTML = isLive(state.selected)
    ? '<button class="btn btn-lg btn-ok" disabled>✓ 正在桌面上</button><button class="btn btn-lg btn-shrink" data-action="hide">隐藏</button>'
    : '<button class="btn btn-lg btn-primary" data-action="activate">设为桌面宠物</button>';
  renderPlayLive();
}

function renderPlayLive() {
  const box = $('#play-live');
  if (!box) return;
  const r = byKey(state.selected);
  const a = r?.pet.animations[state.anim];
  box.innerHTML =
    isLive(state.selected) && a?.label
      ? `<button class="btn play-live" data-action="play-live">让桌面上的 ${esc(r.pet.name)}「${esc(a.label)}」</button>`
      : '';
}

// ---------------------------------------------------------------- 顶栏状态

function renderStatus() {
  const r = byKey(state.app?.activeKey);
  if (state.app?.visible && r?.pet) {
    els.status.className = 'status is-on';
    els.status.innerHTML = `<span class="status-dot"></span><span class="status-text"><b>${esc(r.pet.name)}</b> 在桌面上</span>
      <button class="btn btn-ghost" data-action="hide">隐藏</button>`;
  } else if (r?.pet) {
    els.status.className = 'status';
    els.status.innerHTML = `<span class="status-dot"></span><span class="status-text"><b>${esc(r.pet.name)}</b> 已隐藏</span>
      <button class="btn" data-action="show">显示</button>`;
  } else {
    els.status.className = 'status';
    els.status.innerHTML = '<span class="status-dot"></span><span class="status-text">还没有选择桌宠</span>';
  }
}

// ---------------------------------------------------------------- 设置

function renderSettings() {
  const s = state.app.settings;
  const toggle = (key, title, desc) => `<div class="setting">
      <div class="setting-text"><div class="setting-title">${title}</div><div class="setting-desc">${desc}</div></div>
      <label class="switch"><input type="checkbox" data-setting="${key}" ${s[key] ? 'checked' : ''} aria-label="${title}"><span></span></label>
    </div>`;
  const folders = state.app.sources
    .map((src) => {
      const usable = src.exists || src.id === 'user';
      return `<div class="folder"><span class="folder-name">${esc(src.label)}</span><code>${esc(src.dir)}</code>
        <button class="btn btn-ghost" data-open-folder="${src.id}" ${usable ? '' : 'disabled'}>${usable ? '打开' : '不存在'}</button></div>`;
    })
    .join('');
  els.settings.innerHTML = `<div class="settings-inner">
    <section class="settings-group"><h2>桌宠</h2>
      <div class="setting">
        <div class="setting-text"><div class="setting-title">大小</div><div class="setting-desc">在每只宠物默认大小的基础上整体缩放</div></div>
        <div class="range"><input type="range" id="set-size" min="0.5" max="2" step="0.05" value="${s.size}" aria-label="宠物大小"><output id="size-out">${Math.round(s.size * 100)}%</output></div>
      </div>
      ${toggle('wander', '自由走动', '空闲时在屏幕底部走来走去；没有走路动画的宠物会待在原地')}
      ${toggle('randomActions', '随机动作', '空闲时偶尔做个动作、打个盹')}
      ${toggle('gravity', '重力', '松手后落回任务栏上；关掉后放在哪儿就停在哪儿')}
      ${toggle('alwaysOnTop', '始终置顶', '宠物显示在其它窗口上方')}
    </section>
    <section class="settings-group"><h2>启动</h2>
      ${toggle('launchAtLogin', '开机自动启动', '登录 Windows 后自动启动，把上次的宠物放回桌面')}
    </section>
    <section class="settings-group"><h2>宠物文件夹</h2>
      ${folders}
      <p class="hint">每只宠物是一个文件夹：pet.json + 素材。放进「我的宠物」后，在宠物仓库页点刷新即可出现；Codex 宠物（~/.codex/pets）会自动识别。格式说明见仓库里的 pets/README.md。</p>
    </section>
    <section class="settings-group"><h2>关于</h2>
      <div class="about"><b>Pets</b> v${esc(state.app.version)} · <button class="link" data-action="repo">${esc(state.app.repoUrl)}</button></div>
    </section>
  </div>`;
}

/** 状态更新时只同步控件的值，避免拖动滑块时被重绘打断。 */
function syncSettings() {
  const s = state.app.settings;
  for (const input of els.settings.querySelectorAll('[data-setting]')) input.checked = !!s[input.dataset.setting];
  const size = $('#set-size');
  if (size && document.activeElement !== size) {
    size.value = s.size;
    $('#size-out').textContent = `${Math.round(s.size * 100)}%`;
  }
}

// ---------------------------------------------------------------- 提示

let toastTimer;
function toast(text, type = 'info', ms = type === 'error' ? 6000 : 2600) {
  els.toast.textContent = text;
  els.toast.className = `toast is-shown${type === 'error' ? ' is-error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.className = 'toast'), ms);
}

// ---------------------------------------------------------------- 交互

function select(key) {
  if (state.selected === key) return;
  state.selected = key;
  state.anim = 'idle';
  updateCards();
  renderDetail();
}

async function activate(key) {
  const r = byKey(key);
  if (!r?.pet) return;
  if (!(await api.activate(key))) return toast(`召唤 ${r.pet.name} 失败`, 'error');
  toast(`${r.pet.name} 来到桌面上了`);
  select(key);
}

function setView(view) {
  state.view = view;
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.view === view;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  }
  $('#view-library').classList.toggle('is-active', view === 'library');
  $('#view-settings').classList.toggle('is-active', view === 'settings');
  if (view === 'settings') renderSettings();
}

els.grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  if (e.target.closest('[data-action="activate"]')) activate(card.dataset.key);
  else select(card.dataset.key);
});
els.grid.addEventListener('dblclick', (e) => {
  const card = e.target.closest('.card');
  if (card && !e.target.closest('button')) activate(card.dataset.key);
});
els.grid.addEventListener('keydown', (e) => {
  const card = e.target.closest('.card');
  if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    select(card.dataset.key);
  }
});

els.detail.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-anim]');
  if (chip) return playDetail(chip.dataset.anim);
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'activate') activate(state.selected);
  else if (action === 'hide') api.setVisible(false);
  else if (action === 'open-folder') api.openFolder(state.selected);
  else if (action === 'play-live') api.play(state.anim);
  else if (action === 'codex') exportToCodex(state.selected);
});

els.status.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'hide') api.setVisible(false);
  else if (action === 'show') api.setVisible(true);
});

for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setView(tab.dataset.view));

els.search.addEventListener('input', () => {
  state.query = els.search.value;
  renderGrid();
});
els.filters.addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  state.filter = b.dataset.filter;
  renderFilters();
  renderGrid();
});

$('#btn-import').addEventListener('click', async () => {
  const res = await api.importFolder();
  if (res.canceled) return;
  if (!res.ok) return toast(`导入失败：${res.errors?.[0] ?? '未知错误'}`, 'error');
  await loadRecords();
  select(res.key);
  toast(`已导入：${res.name}`);
});
$('#btn-folder').addEventListener('click', () => api.openFolder('user'));
$('#btn-reload').addEventListener('click', async () => {
  await api.reload();
  toast('已重新扫描宠物文件夹');
});

els.settings.addEventListener('input', (e) => {
  if (e.target.id === 'set-size') $('#size-out').textContent = `${Math.round(Number(e.target.value) * 100)}%`;
});
els.settings.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.setting) api.setSettings({ [t.dataset.setting]: t.checked });
  else if (t.id === 'set-size') api.setSettings({ size: Number(t.value) });
});
els.settings.addEventListener('click', (e) => {
  const folder = e.target.closest('[data-open-folder]');
  if (folder) api.openFolder(folder.dataset.openFolder);
  else if (e.target.closest('[data-action="repo"]')) api.openExternal(state.app.repoUrl);
});

// ---------------------------------------------------------------- 启动

async function loadRecords() {
  state.records = await api.list();
  animCache.clear();
  fitCache.clear();
  if (!byKey(state.selected)?.pet) {
    const active = byKey(state.app?.activeKey);
    state.selected = active?.pet ? active.key : (validRecords()[0]?.key ?? null);
    state.anim = 'idle';
  }
  renderFilters();
  renderGrid();
  renderProblems();
  renderDetail();
  renderStatus();
}

api.onState((s) => {
  state.app = s;
  renderStatus();
  updateCards();
  renderDetailActions();
  if (state.view === 'settings') syncSettings();
});
api.onPetsChanged(() => loadRecords());
api.onToast((t) => toast(t.text, t.type));

state.app = await api.state();
await loadRecords();
