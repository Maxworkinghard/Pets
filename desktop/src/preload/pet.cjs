// 桌宠窗口的预加载脚本：只暴露宠物窗口需要的最小接口。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petHost', {
  init: () => ipcRenderer.invoke('petwin:init'),
  ready: () => ipcRenderer.send('petwin:ready'),
  setBounds: (bounds) => ipcRenderer.send('petwin:bounds', bounds),
  setIgnoreMouse: (ignore) => ipcRenderer.send('petwin:ignore-mouse', ignore),
  showMenu: () => ipcRenderer.send('petwin:menu'),
  savePosition: (pos) => ipcRenderer.send('petwin:position', pos),
  log: (level, message) => ipcRenderer.send('petwin:log', level, String(message)),
  onCommand: (cb) => ipcRenderer.on('petwin:command', (_e, cmd) => cb(cmd)),
});
