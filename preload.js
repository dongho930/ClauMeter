const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onUsageUpdate: (callback) => ipcRenderer.on('usage-update', (_e, data) => callback(data)),
  onCalibrateInit: (callback) => ipcRenderer.on('calibrate-init', (_e, data) => callback(data)),
  submitCalibration: (data) => ipcRenderer.send('calibrate-submit', data),
  cancelCalibration: () => ipcRenderer.send('calibrate-cancel'),
  previewOpacity: (value) => ipcRenderer.send('calibrate-opacity-preview', value),
  openDetailWindow: () => ipcRenderer.send('open-detail-window'),
  openCalibrateWindow: () => ipcRenderer.send('open-calibrate-window'),
  quitApp: () => ipcRenderer.send('quit-app'),
  getUsageAdvice: (forceRefresh) => ipcRenderer.invoke('get-usage-advice', { forceRefresh }),
  toggleClickThrough: () => ipcRenderer.send('clickthrough:toggle'),
  getClickThroughState: () => ipcRenderer.invoke('clickthrough:get-state'),
  onClickThroughState: (callback) => ipcRenderer.on('clickthrough:state', (_e, enabled) => callback(enabled)),
  setClickThroughHover: (hovering) => ipcRenderer.send('clickthrough:hover', hovering),
  onLocaleData: (callback) => ipcRenderer.on('locale-data', (_e, data) => callback(data)),
  setLanguage: (code) => ipcRenderer.send('set-language', code),
});
