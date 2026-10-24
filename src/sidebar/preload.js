// Bridge between the side bar page and the main process.
const { contextBridge, ipcRenderer } = require('electron');

// The UI language and its table, there before the page's scripts run (src/i18n/page.js).
contextBridge.exposeInMainWorld('i18n', ipcRenderer.sendSync('i18n:get'));

contextBridge.exposeInMainWorld('host', {
  getState: () => ipcRenderer.invoke('tabs:get'),
  getRepos: () => ipcRenderer.invoke('repos:get'),
  getWorktrees: (repo) => ipcRenderer.invoke('repos:worktrees', repo),
  onUpdate: (callback) => ipcRenderer.on('tabs:update', (_event, state) => callback(state)),
  onRepos: (callback) => ipcRenderer.on('repos:update', (_event, repos) => callback(repos)),
  onReloadWorktrees: (callback) => ipcRenderer.on('worktrees:reload', (_event, repos) => callback(repos)),
  onWorktreeAdded: (callback) => ipcRenderer.on('worktrees:added', (_event, repo) => callback(repo)),
  onCloned: (callback) => ipcRenderer.on('repos:cloned', (_event, repo) => callback(repo)),
  addWorktree: (repo) => ipcRenderer.invoke('worktrees:add-dialog', repo),
  // A repository of the account not cloned, by its address on GitHub; an owner by host/owner.
  cloneRepo: (url) => ipcRenderer.invoke('uncloned:clone', url),
  showUnclonedMenu: (url) => ipcRenderer.invoke('uncloned:menu', url),
  showOwnerMenu: (key) => ipcRenderer.invoke('uncloned:owner-menu', key),
  // ids: the open tabs the row shows under it; repo is null for the folders outside git.
  showRepoMenu: (repo, ids) => ipcRenderer.invoke('repos:menu', repo, ids),
  closeTabs: (repo, ids) => ipcRenderer.invoke('tabs:close-together', repo, ids),
  showWorktreeMenu: (folder, repo) => ipcRenderer.invoke('worktrees:menu', folder, repo),
  removeWorktree: (folder, repo) => ipcRenderer.invoke('worktrees:remove', folder, repo),
  open: (folder) => ipcRenderer.invoke('tabs:open', folder),
  activate: (id) => ipcRenderer.invoke('tabs:activate', id),
  close: (id) => ipcRenderer.invoke('tabs:close', id),
  showAddMenu: () => ipcRenderer.invoke('sidebar:add-menu'),
  showSettings: () => ipcRenderer.invoke('sidebar:settings'),
  showExtensions: () => ipcRenderer.invoke('sidebar:extensions'),
  showMoreMenu: () => ipcRenderer.invoke('sidebar:more-menu'),
  refreshRepos: () => ipcRenderer.invoke('repos:refresh'),
  revealNext: (state) => ipcRenderer.invoke('sessions:next', state),
  showTabMenu: (id) => ipcRenderer.invoke('tabs:tab-menu', id),
  revealSession: (id, sessionId) => ipcRenderer.invoke('sessions:reveal', id, sessionId),
  archiveSession: (id, sessionId) => ipcRenderer.invoke('sessions:archive', id, sessionId),
  github: (folder) => ipcRenderer.invoke('github:get', folder),
  openGithub: (folder, page) => ipcRenderer.invoke('github:open', folder, page),
  openIssue: (folder, number) => ipcRenderer.invoke('github:issue', folder, number),
  // numbers: [branch, number] for each branch made from a pull request; heads: the worktrees'
  // commits.
  pullRequests: (repo, branches, numbers = [], heads = []) => ipcRenderer.invoke('github:pulls', repo, branches, numbers, heads),
  openPull: (folder, number) => ipcRenderer.invoke('github:pull', folder, number),
  openChecks: (folder, oid) => ipcRenderer.invoke('github:checks', folder, oid),
  startUpdate: () => ipcRenderer.invoke('update:start'),
  cancelUpdate: () => ipcRenderer.invoke('update:cancel'),
  dismissUpdate: () => ipcRenderer.invoke('update:dismiss'),
  startAppUpdate: () => ipcRenderer.invoke('app-update:start'),
  restartAppUpdate: () => ipcRenderer.invoke('app-update:restart'),
  cancelAppUpdate: () => ipcRenderer.invoke('app-update:cancel'),
  skipAppUpdate: () => ipcRenderer.invoke('app-update:skip'),
  dismissAppUpdate: () => ipcRenderer.invoke('app-update:dismiss'),
  openAppReleaseNotes: () => ipcRenderer.invoke('app-update:notes'),
  startResize: () => ipcRenderer.invoke('sidebar:resize-start'),
  resize: (width) => ipcRenderer.send('sidebar:resize', width),
  endResize: (width) => ipcRenderer.invoke('sidebar:resize-end', width),
  resetWidth: () => ipcRenderer.invoke('sidebar:reset-width'),
});
