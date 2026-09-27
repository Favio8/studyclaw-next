'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// 最小化、显式的桥接。Web UI 不需要 Node 访问；Host token 由静态托管按
// 浏览器路径的方式注入 window.__STUDYCLAW__——桌面壳不额外注入任何凭据。
// C-5：host-info 只返回 {dev, port}，不透出 host.json 全文（含访问 token）。
contextBridge.exposeInMainWorld('studyclawDesktop', {
  hostInfo: () => ipcRenderer.invoke('studyclaw:host-info'),
  isDesktop: true,
  platform: process.platform,
})
