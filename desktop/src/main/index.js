// Pets 桌面端主进程：托盘、控制面板窗口、透明桌宠窗口、菜单与 IPC。
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from 'electron';
import { codexPetsDir, installCodexPet, isPetsExport, listExports } from './codex-install.js';
import { ORIGIN, assetBase, handleProtocol, registerScheme } from './protocol.js';
import { loadPet, scanAll } from './registry.js';
import { Settings } from './settings.js';

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(DESKTOP_ROOT, 'src');
const ICON = path.join(DESKTOP_ROOT, 'assets', 'icon.png');
const TRAY_ICON = path.join(DESKTOP_ROOT, 'assets', 'tray.png');
const REPO_URL = 'https://github.com/Maxworkinghard/Pets';
const SIZES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SOURCE_LABEL = { bundled: '仓库', user: '我的', codex: 'Codex' };
const DEBUG = process.argv.includes('--pets-debug');
const log = (...args) => DEBUG && console.log('[pets]', ...args);

// 测试时可以用独立的用户目录，不影响真实设置
if (process.env.PETS_USER_DATA) app.setPath('userData', path.resolve(process.env.PETS_USER_DATA));
// 桌宠常驻后台，画面很小：软件渲染足够流畅，GPU 进程内存从 300MB+ 降到 20MB 左右。
// 需要时可用 --pets-gpu 打开硬件加速。
if (!process.argv.includes('--pets-gpu')) app.disableHardwareAcceleration();
registerScheme();

let settings;
let records = new Map();
let tray = null;
let panelWin = null;
let petWin = null;
let petKey = null;

// ---------------------------------------------------------------- 宠物来源

function sources() {
  return [
    {
      id: 'bundled',
      label: '仓库宠物',
      dir: app.isPackaged ? path.join(process.resourcesPath, 'pets') : path.resolve(DESKTOP_ROOT, '..', 'pets'),
    },
    { id: 'user', label: '我的宠物', dir: path.join(app.getPath('userData'), 'pets') },
    { id: 'codex', label: 'Codex 宠物', dir: codexPetsDir() },
  ];
}

const sourceDir = (id) => sources().find((s) => s.id === id)?.dir;
let codexExports = new Map();

function rescan() {
  // 自己导出到 Codex 的宠物不再作为「Codex 宠物」重复出现
  const all = scanAll(sources()).filter((r) => r.source !== 'codex' || !isPetsExport(r.dir));
  records = new Map(all.map((r) => [r.key, r]));
  codexExports = listExports();
  log('pets:', [...records.values()].map((r) => (r.pet ? r.key : `${r.key}(无效)`)).join(', '));
}

const publicRecord = (r) => ({ ...r, assetBase: assetBase(r), codexExport: codexExports.get(r.key) ?? null });

function appState() {
  return {
    activeKey: settings.data.activePet,
    visible: !!petWin,
    settings: settings.data,
    sources: sources().map((s) => ({ ...s, exists: fs.existsSync(s.dir) })),
    version: app.getVersion(),
    repoUrl: REPO_URL,
  };
}

function broadcast() {
  panelWin?.webContents.send('app:state', appState());
  refreshTrayMenu();
}

function petsChanged() {
  if (petKey && !records.get(petKey)?.pet) closePet();
  panelWin?.webContents.send('pets:changed');
  broadcast();
}

// ---------------------------------------------------------------- 桌宠窗口

const workAreas = () => screen.getAllDisplays().map((d) => d.workArea);

function initialPosition() {
  const p = settings.data.position;
  if (p && workAreas().some((a) => p.x >= a.x && p.x <= a.x + a.width && p.y >= a.y && p.y <= a.y + a.height + 1)) return p;
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - 180, y: wa.y + wa.height };
}

function lockDown(win) {
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function openPet(key) {
  const record = records.get(key);
  if (!record?.pet) return false;
  closePet();
  petKey = key;
  settings.set({ activePet: key, petVisible: true });
  const win = new BrowserWindow({
    width: 64,
    height: 64,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: settings.data.alwaysOnTop,
    backgroundColor: '#00000000',
    title: record.pet.name,
    webPreferences: {
      preload: path.join(SRC, 'preload', 'pet.cjs'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  petWin = win;
  win.setIgnoreMouseEvents(true, { forward: true });
  lockDown(win);
  win.on('closed', () => {
    if (petWin !== win) return;
    petWin = null;
    petKey = null;
    broadcast();
  });
  win.loadURL(`${ORIGIN}/renderer/pet/index.html`);
  log('open pet', key);
  broadcast();
  return true;
}

function closePet() {
  const win = petWin;
  petWin = null;
  petKey = null;
  win?.destroy();
}

function hidePet() {
  closePet();
  settings.set({ petVisible: false });
  broadcast();
}

const sendPet = (cmd) => petWin?.webContents.send('petwin:command', cmd);

function applySettings(patch) {
  const clean = {};
  if (typeof patch.size === 'number' && patch.size >= 0.25 && patch.size <= 3) clean.size = patch.size;
  for (const k of ['wander', 'randomActions', 'gravity', 'alwaysOnTop', 'launchAtLogin']) {
    if (typeof patch[k] === 'boolean') clean[k] = patch[k];
  }
  settings.set(clean);
  if ('alwaysOnTop' in clean) petWin?.setAlwaysOnTop(clean.alwaysOnTop);
  if ('launchAtLogin' in clean) {
    // 源码运行时需要带上应用目录作为参数，否则开机只会启动一个空的 Electron
    const opts = app.isPackaged ? {} : { path: process.execPath, args: [DESKTOP_ROOT] };
    app.setLoginItemSettings({ openAtLogin: clean.launchAtLogin, ...opts });
  }
  sendPet({ type: 'settings', settings: settings.data });
  broadcast();
}

// ---------------------------------------------------------------- 菜单

function switchItems() {
  const valid = [...records.values()].filter((r) => r.pet);
  if (!valid.length) return [{ label: '（没有可用的宠物）', enabled: false }];
  return valid.map((r) => ({
    label: r.source === 'bundled' ? r.pet.name : `${r.pet.name}（${SOURCE_LABEL[r.source]}）`,
    type: 'radio',
    checked: r.key === petKey,
    click: () => openPet(r.key),
  }));
}

function petMenu() {
  const pet = records.get(petKey)?.pet;
  const s = settings.data;
  const actions = pet?.actions ?? [];
  return Menu.buildFromTemplate([
    { label: pet?.name ?? '宠物', enabled: false },
    { type: 'separator' },
    ...(actions.length
      ? [{ label: '动作', submenu: actions.map((n) => ({ label: pet.animations[n].label, click: () => sendPet({ type: 'play', name: n }) })) }]
      : []),
    { label: '切换宠物', submenu: switchItems() },
    {
      label: '大小',
      submenu: SIZES.map((v) => ({
        label: `${Math.round(v * 100)}%`,
        type: 'radio',
        checked: Math.abs(s.size - v) < 0.001,
        click: () => applySettings({ size: v }),
      })),
    },
    { label: '自由走动', type: 'checkbox', checked: s.wander, click: (item) => applySettings({ wander: item.checked }) },
    { label: '随机动作', type: 'checkbox', checked: s.randomActions, click: (item) => applySettings({ randomActions: item.checked }) },
    { type: 'separator' },
    { label: '打开控制面板', click: showPanel },
    { label: '隐藏宠物', click: hidePet },
    { label: '退出 Pets', click: () => app.quit() },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON);
  tray = new Tray(icon);
  tray.setToolTip('Pets 桌面宠物');
  tray.on('click', showPanel);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const active = records.get(settings.data.activePet);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开控制面板', click: showPanel },
      petWin
        ? { label: '隐藏宠物', click: hidePet }
        : { label: '显示宠物', enabled: !!active?.pet, click: () => openPet(active.key) },
      { label: '切换宠物', submenu: switchItems() },
      { type: 'separator' },
      { label: '退出 Pets', click: () => app.quit() },
    ]),
  );
}

// ---------------------------------------------------------------- 控制面板

function showPanel() {
  if (panelWin) {
    if (panelWin.isMinimized()) panelWin.restore();
    panelWin.show();
    panelWin.focus();
    return;
  }
  panelWin = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Pets',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17151b' : '#f6f1ea',
    webPreferences: { preload: path.join(SRC, 'preload', 'panel.cjs'), sandbox: true, contextIsolation: true },
  });
  panelWin.removeMenu();
  lockDown(panelWin);
  panelWin.once('ready-to-show', () => panelWin.show());
  panelWin.on('closed', () => {
    panelWin = null;
  });
  panelWin.loadURL(`${ORIGIN}/renderer/panel/index.html`);
}

/** 给控制面板发一条提示；面板没开就先打开，等页面加载完再发。 */
function notifyPanel(toast) {
  if (panelWin && !panelWin.webContents.isLoading()) {
    panelWin.webContents.send('app:toast', toast);
    return;
  }
  showPanel();
  panelWin.webContents.once('did-finish-load', () => panelWin?.webContents.send('app:toast', toast));
}

async function importPet() {
  const res = await dialog.showOpenDialog(panelWin ?? undefined, {
    title: '选择宠物文件夹（里面要有 pet.json）',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  const src = res.filePaths[0];
  if (!fs.existsSync(path.join(src, 'pet.json'))) return { ok: false, errors: ['这个文件夹里没有 pet.json'] };
  const check = loadPet('user', src);
  if (!check.pet) return { ok: false, errors: check.errors };
  const userDir = sourceDir('user');
  const base = path.basename(src);
  let dest = path.join(userDir, base);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(userDir, `${base}-${i}`);
  fs.cpSync(src, dest, { recursive: true });
  rescan();
  petsChanged();
  return { ok: true, key: `user/${path.basename(dest)}`, name: check.pet.name };
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  const fromPet = (e) => petWin && e.sender === petWin.webContents;

  // 桌宠窗口
  ipcMain.handle('petwin:init', (e) => {
    const record = records.get(petKey);
    if (!fromPet(e) || !record) return null;
    return { record: publicRecord(record), settings: settings.data, areas: workAreas(), position: initialPosition(), debug: DEBUG };
  });
  ipcMain.on('petwin:ready', (e) => fromPet(e) && petWin.showInactive());
  ipcMain.on('petwin:bounds', (e, b) => {
    if (!fromPet(e) || !b) return;
    const r = { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) };
    if (Object.values(r).every(Number.isFinite)) petWin.setBounds(r);
  });
  ipcMain.on('petwin:ignore-mouse', (e, ignore) => fromPet(e) && petWin.setIgnoreMouseEvents(!!ignore, { forward: true }));
  ipcMain.on('petwin:menu', (e) => {
    if (!fromPet(e)) return;
    const menu = petMenu();
    if (DEBUG) globalThis.__petsDebug = { menu }; // 自动化测试用：读取/关闭右键菜单
    menu.popup({ window: petWin });
  });
  ipcMain.on('petwin:position', (e, p) => {
    if (fromPet(e) && Number.isFinite(p?.x) && Number.isFinite(p?.y)) settings.set({ position: { x: Math.round(p.x), y: Math.round(p.y) } });
  });
  ipcMain.on('petwin:log', (e, level, msg) => {
    if (level === 'info') return log('[pet]', msg);
    console.error('[pet]', msg);
    if (level === 'fatal' && fromPet(e)) {
      closePet();
      broadcast();
      notifyPanel({ type: 'error', text: msg });
    }
  });

  // 控制面板
  ipcMain.handle('pets:list', () => [...records.values()].map(publicRecord));
  ipcMain.handle('app:state', () => appState());
  ipcMain.handle('pet:activate', (_e, key) => openPet(key));
  ipcMain.handle('pet:visible', (_e, visible) => {
    if (visible) return openPet(settings.data.activePet);
    hidePet();
    return true;
  });
  ipcMain.handle('pet:play', (_e, name) => {
    sendPet({ type: 'play', name });
    return !!petWin;
  });
  ipcMain.handle('settings:set', (_e, patch) => {
    applySettings(patch ?? {});
    return settings.data;
  });
  ipcMain.handle('folder:open', (_e, target) => {
    const dir = sourceDir(target) ?? records.get(target)?.dir;
    if (!dir) return false;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return true;
  });
  ipcMain.handle('pets:reload', () => {
    rescan();
    petsChanged();
    return true;
  });
  ipcMain.handle('pets:import', importPet);
  ipcMain.handle('codex:install', (_e, key, bytes) => {
    const record = records.get(key);
    if (!record?.pet) return { ok: false, error: '找不到这只宠物' };
    if (record.source === 'codex') return { ok: false, error: '它本来就在 Codex 里' };
    const res = installCodexPet({ sourceKey: key, pet: record.pet, bytes });
    log('codex install', key, JSON.stringify(res));
    if (res.ok) {
      rescan();
      petsChanged();
    }
    return res;
  });
  ipcMain.handle('app:open-external', (_e, url) => {
    if (typeof url === 'string' && url.startsWith(REPO_URL)) shell.openExternal(url);
  });
}

// ---------------------------------------------------------------- 启动

function start() {
  app.setAppUserModelId('com.maxworkinghard.pets');
  settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
  fs.mkdirSync(sourceDir('user'), { recursive: true });
  handleProtocol(SRC, (key) => records.get(key));
  rescan();
  registerIpc();
  createTray();

  const pushAreas = () => sendPet({ type: 'areas', areas: workAreas() });
  screen.on('display-added', pushAreas);
  screen.on('display-removed', pushAreas);
  screen.on('display-metrics-changed', pushAreas);

  // --pet=<key> 可在启动时直接召唤某只宠物（调试用）
  const forced = process.argv.find((a) => a.startsWith('--pet='))?.slice(6);
  const key = forced ?? (settings.data.petVisible ? settings.data.activePet : null);
  const shown = key ? openPet(key) : false;
  if (!shown || process.argv.includes('--panel')) showPanel();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => app.isReady() && showPanel());
  app.on('window-all-closed', () => {
    // 托盘常驻：关掉所有窗口也不退出，从托盘菜单退出
  });
  app.whenReady().then(start);
}
