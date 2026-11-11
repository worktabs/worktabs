// Bridge between the dialog page and the main process.
const { contextBridge, ipcRenderer } = require('electron');

// The UI language and its table, there before the page's scripts run (src/i18n/page.js).
contextBridge.exposeInMainWorld('i18n', ipcRenderer.sendSync('i18n:get'));

contextBridge.exposeInMainWorld('host', {
  // { dialog, theme }: the dialog in front (null when none is) and the theme to draw it in.
  ready: () => ipcRenderer.invoke('dialog:ready'),
  answer: (id, response, checkboxChecked) => ipcRenderer.invoke('dialog:answer', id, response, checkboxChecked),
  copy: () => ipcRenderer.invoke('dialog:copy'),
  onShow: (callback) => ipcRenderer.on('dialog:show', (_event, dialog, theme) => callback(dialog, theme)),
  onTheme: (callback) => ipcRenderer.on('dialog:theme', (_event, theme) => callback(theme)),
  // The dialog that adds a worktree to `repo`: what the task field names, what adding the branch
  // would do (for a pull request, checking it out), a name for it, and making it.
  worktree: {
    task: (repo, text) => ipcRenderer.invoke('worktree:task', repo, text),
    plan: (repo, name, task) => ipcRenderer.invoke('worktree:plan', repo, name, task),
    suggest: (repo, task) => ipcRenderer.invoke('worktree:suggest', repo, task),
    create: (repo, name, task) => ipcRenderer.invoke('worktree:create', repo, name, task),
  },
  // The dialog that asks where to clone a repository: whether it can go into a folder, picking a
  // folder, and starting the clone.
  clone: {
    check: (dest) => ipcRenderer.invoke('clone:check', dest),
    browse: (dest) => ipcRenderer.invoke('clone:browse', dest),
    start: (dest) => ipcRenderer.invoke('clone:start', dest),
  },
  settings: {
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
  },
  extensions: {
    list: (target) => ipcRenderer.invoke('extensions:list', target),
    browse: (kind) => ipcRenderer.invoke('extensions:browse', kind),
    import: (keys, target) => ipcRenderer.invoke('extensions:import', keys, target),
    openVsx: (id, target) => ipcRenderer.invoke('extensions:open-vsx', id, target),
    rollback: (id, target) => ipcRenderer.invoke('extensions:rollback', id, target),
    openCode: () => ipcRenderer.invoke('extensions:open-code'),
    page: (id) => ipcRenderer.invoke('extensions:page', id),
    check: (target) => ipcRenderer.invoke('extensions:check', target),
    update: () => ipcRenderer.invoke('extensions:update'),
  },
});
