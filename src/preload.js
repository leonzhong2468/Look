// 预加载脚本: 暴露类型安全的 IPC 桥
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  accountsList: () => ipcRenderer.invoke('accounts:list'),
  accountsAdd: (providerId) => ipcRenderer.invoke('accounts:add', providerId || 'doubao'),
  accountsRename: (id, label) => ipcRenderer.invoke('accounts:rename', { id, label }),
  accountsDelete: (id) => ipcRenderer.invoke('accounts:delete', id),
  accountsSelect: (id) => ipcRenderer.invoke('accounts:select', id),
  accountsDetectName: (id) => ipcRenderer.invoke('accounts:detectName', id),
  prefsGet: () => ipcRenderer.invoke('prefs:get'),
  prefsSet: (patch) => ipcRenderer.invoke('prefs:set', patch),
  openDownloads: (dir) => ipcRenderer.invoke('downloads:openFolder', dir),

  // ---- 任务流水线 ----
  tasksList: () => ipcRenderer.invoke('tasks:list'),
  taskCreate: (payload) => ipcRenderer.invoke('tasks:create', payload),
  taskStart: (id) => ipcRenderer.invoke('tasks:start', id),
  taskCancel: (id) => ipcRenderer.invoke('tasks:cancel', id),
  taskRerunVideo: (id, fix) => ipcRenderer.invoke('tasks:rerunVideo', id, fix),
  taskApprove: (id) => ipcRenderer.invoke('tasks:approve', id),
  taskDelete: (id) => ipcRenderer.invoke('tasks:delete', id),
  taskOpenFolder: (id) => ipcRenderer.invoke('tasks:openFolder', id),
  taskReveal: (p) => ipcRenderer.invoke('tasks:reveal', p),
  taskShowPage: (id) => ipcRenderer.invoke('tasks:showPage', id),
  taskReadPrompt: (id) => ipcRenderer.invoke('tasks:readPrompt', id),
  pickImages: () => ipcRenderer.invoke('files:pickImages'),
  getFilePath: (f) => { try { return webUtils.getPathForFile(f); } catch (e) { return ''; } },
  toFileUrl: (p) => (p ? 'file:///' + encodeURI(String(p).replace(/\\/g, '/')) : ''),
  setMode: (m) => ipcRenderer.invoke('ui:setMode', m),
  getMode: () => ipcRenderer.invoke('ui:getMode'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openConfig: () => ipcRenderer.invoke('app:openConfig'),
  diagRun: () => ipcRenderer.invoke('diag:run'),
  diagOpenFolder: () => ipcRenderer.invoke('diag:openFolder'),
  docsOpen: (name) => ipcRenderer.invoke('docs:open', name),
  docsReveal: () => ipcRenderer.invoke('docs:reveal'),
  toolsDoctor: () => ipcRenderer.invoke('tools:doctor'),

  // ---- AI 平台注册表（可加 WorkBuddy / DeepSeek 等） ----
  providersList: () => ipcRenderer.invoke('providers:list'),
  providerAdd: (input) => ipcRenderer.invoke('providers:add', input),
  providerUpdate: (id, patch) => ipcRenderer.invoke('providers:update', id, patch),
  providerRemove: (id) => ipcRenderer.invoke('providers:remove', id),

  // 主进程推送
  onAccountReady: (cb) => ipcRenderer.on('account:ready', (e, d) => cb(d)),
  onAccountLogout: (cb) => ipcRenderer.on('account:logout', (e, d) => cb(d)),
  onLoginTimeout: (cb) => ipcRenderer.on('account:login-timeout', (e, d) => cb(d)),
  onBadgeUpdate: (cb) => ipcRenderer.on('badge:update', (e, d) => cb(d)),
  onActiveChanged: (cb) => ipcRenderer.on('active:changed', (e, d) => cb(d)),
  onDownloadDone: (cb) => ipcRenderer.on('download:done', (e, d) => cb(d)),
  onMenuAdd: (cb) => ipcRenderer.on('menu:addAccount', () => cb()),
  onTaskUpdate: (cb) => ipcRenderer.on('task:update', (e, d) => cb(d)),
  onTaskRemoved: (cb) => ipcRenderer.on('task:removed', (e, d) => cb(d)),
  onTaskToast: (cb) => ipcRenderer.on('task:toast', (e, d) => cb(d)),
  onUiMode: (cb) => ipcRenderer.on('ui:mode', (e, d) => cb(d)),
  onViewLocked: (cb) => ipcRenderer.on('view:locked', (e, d) => cb(d)),
  onAccountsChanged: (cb) => ipcRenderer.on('accounts:changed', (e, d) => cb(d))
});
