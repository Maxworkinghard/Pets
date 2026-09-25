// 控制面板的预加载脚本。
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

contextBridge.exposeInMainWorld('pets', {
  list: () => ipcRenderer.invoke('pets:list'),
  state: () => ipcRenderer.invoke('app:state'),
  activate: (key) => ipcRenderer.invoke('pet:activate', key),
  setVisible: (visible) => ipcRenderer.invoke('pet:visible', visible),
  play: (name) => ipcRenderer.invoke('pet:play', name),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openFolder: (target) => ipcRenderer.invoke('folder:open', target),
  importFolder: () => ipcRenderer.invoke('pets:import'),
  installToCodex: (key, bytes) => ipcRenderer.invoke('codex:install', key, bytes),
  reload: () => ipcRenderer.invoke('pets:reload'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onState: (cb) => subscribe('app:state', cb),
  onPetsChanged: (cb) => subscribe('pets:changed', cb),
  onToast: (cb) => subscribe('app:toast', cb),
});
