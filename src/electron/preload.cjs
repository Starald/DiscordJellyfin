// CommonJS preload (надёжнее всего для contextBridge). Копируется в dist при сборке.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('bot:state'),
  listChannels: () => ipcRenderer.invoke('bot:channels'),
  search: (term, type) => ipcRenderer.invoke('bot:search', term, type),
  play: (opts) => ipcRenderer.invoke('bot:play', opts),
  togglePause: () => ipcRenderer.invoke('bot:togglePause'),
  skip: () => ipcRenderer.invoke('bot:skip'),
  stop: () => ipcRenderer.invoke('bot:stop'),
  shuffle: () => ipcRenderer.invoke('bot:shuffle'),
  leave: () => ipcRenderer.invoke('bot:leave'),
  onError: (cb) => ipcRenderer.on('bot:error', (_e, msg) => cb(msg)),
});
