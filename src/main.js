// Worktabs: one browser VS Code (code-server) per git worktree, shown as tabs, with the
// state of the Claude Code sessions in each tab (working / waiting for approval / done) as
// tab badges.
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  app,
  BaseWindow,
  Menu,
  Notification,
  WebContentsView,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell,
  webContents,
  webFrameMain,
} = require('electron');

const { attachAppIcons } = require('./window/app-icons');
const { gitMessage, runAt } = require('./commands');
const { cloneRepo, hasGhq, placeFolder } = require('./repos/clone');
const { CodeServerManager, DEFAULT_SETTINGS } = require('./code-server/code-server');
const { createServerRegistry } = require('./code-server/server-registry');
const { WslCodeServerManager } = require('./code-server/code-server-wsl');
const { loadConfig, saveConfig } = require('./config');
const { controlToken, startControlServer, writeControlToken } = require('./window/control');
const { createControlHandlers } = require('./window/control-handlers');
const { createGithubPages } = require('./repos/github-pages');
const { createMenus, groupName } = require('./window/menus');
const { createSettingsActions } = require('./window/settings-actions');
const { registerIpc } = require('./window/ipc-routes');
const { appIpcRoutes } = require('./window/ipc-table');
const { wireHooks } = require('./conversations/hook-events');
const { createTabStore } = require('./tabs/tab-store');
const { createWindowLayout } = require('./window/window-layout');
const { viewPreferences } = require('./window/web-preferences');
const {
  approvedPulls,
  branchPulls,
  checksUrl,
  forgetHostLookups,
  gitProtocol,
  githubRepo,
  hasBranchPage,
  mergedAtHead,
  ownedRepos,
  pageUrl,
  readRemotes,
  repoVisibility,
  setGithubHosts,
  signedInHosts,
} = require('./repos/github');
const { HookServer, nextConversation } = require('./conversations/hooks');
const { ConversationStore } = require('./conversations/conversation-store');
const { ClaudeObserver } = require('./conversations/claude-observer');
const { SeenConversations } = require('./conversations/seen-conversations');
const { displayLocale, language, messages, resolveLanguage, setLanguage, t, withLanguagePack } = require('./i18n');
const { downloadRelease, ensureCodeServer } = require('./code-server/install');
const { installWrapper } = require('./agents/mac-claude-wrap');
const { agentExtensions, effectiveBranchAgent, isAgentExtension, managedAgentSettings, normalizeAgent } = require('./agents/agents');
const { settingsDialog } = require('./window/message-box');
const { createDialogView } = require('./window/dialog-view');
const { createCloseGuard } = require('./window/window-close');
const { placeholderUrl: placeholderPage, tabPlaceholder } = require('./window/placeholder');
const { createThemeState } = require('./window/theme-state');
const { createViewState } = require('./window/view-state');
const { parseLaunchArgs } = require('./conversations/notifications');
const { ChatWidths } = require('./conversations/secondary-sidebar');
const { WEBVIEW_FRAME, shownConversations, visibleCodexFrames } = require('./conversations/chat-frames');
const { createChatPanel } = require('./conversations/chat-panel');
const { createHelperClient } = require('./tabs/helper-client');
const { hostKeyAction } = require('./window/host-keys');
const { createSessionNotices } = require('./conversations/session-notices');
const { createTabRisks } = require('./tabs/tab-risks');
const { SettingsSync } = require('./code-server/settings-sync');
const { applyShellEnv, readShellEnv } = require('./shell-env');
const { TabLifecycle } = require('./tabs/tab-lifecycle');
const { createTabViews } = require('./tabs/tab-view');
const { createWebviewSites } = require('./tabs/webview-sites');
const { StartupGate } = require('./tabs/startup-gate');
const { createAppUpdates } = require('./code-server/app-updates');
const { prepareCodeServer, wrapperProblem } = require('./code-server/startup-preparation');
const { createUpdateProbe } = require('./code-server/update-probe');
const { RepositoryService } = require('./repos/repository-service');
const { createWorktreeAdding } = require('./repos/worktree-adding');
const { createWorktreeRemoval } = require('./repos/worktree-removal');
const { createCloneCoordinator } = require('./repos/clone-coordinator');
const { checkedTask, describeTask, firstPrompt, suggestBranch } = require('./repos/task');
const { windowBackground } = require('./window/theme');
const { findUpdates, getJson, startupExtensions } = require('./code-server/updates');
const { createSelfUpdate } = require('./self-update/self-update');
const { fetchReleases, newestRelease } = require('./self-update/releases');
const { updateTarget } = require('./self-update/target');
const { removeLeftovers, stageRelease, stagingPaths } = require('./self-update/stage');
const { readSwapResult, swapCommand, swapScript } = require('./self-update/swap');
const { ExtensionImports, installedExtensions: localExtensions, localTarget, readVsix } = require('./code-server/extension-imports');
const { UsageTracker } = require('./agents/usage');
const { CodexUsageTracker } = require('./codex/codex-usage');
const { ONBOARDING_SETTINGS, isOtherWorktree, onboardingSettings } = require('./agents/agent-onboarding');
const { codexNavigationScript } = require('./conversations/conversation-navigation');
const { createConversationOpening } = require('./conversations/conversation-opening');
const { REFRESH_EVERY } = require('./agents/usage-refresh');
const { UsagePolling } = require('./agents/usage-polling');
const { keepPage } = require('./util');
const { listDistros, normalizeFolder, parseWslPath } = require('./wsl/wsl');
const {
  addWorktree,
  branchLinks,
  currentBranch,
  deleteBranch,
  gitWorktrees,
  ignoredOnlyHere,
  isGitFolder,
  listWorktrees,
  mainWorktree,
  planWorktree,
  readRepoCache,
  removableWorktree,
  removeWorktree,
  repoCatalog,
  repoRoot,
  setBranchLink,
  unsharedCommits,
  worktreeChanges,
  writeRepoCache,
} = require('./repos/worktrees');

const PARTITION = 'persist:worktabs';
// The views that show code-server's workbench (the tabs and the update probe). Their preload
// serves the webviews from sites of their own (tab-preload.js, webview-sites.js); their frames,
// webviews included, also run the preload registered on their session (codex-frame-preload.js).
const TAB_PRELOAD = path.join(__dirname, 'tabs', 'tab-preload.js');
const WORKBENCH_VIEW = Object.freeze({ partition: PARTITION, preload: TAB_PRELOAD, backgroundThrottling: false, nodeIntegrationInSubFrames: true });
const CODEX_FRAME_PRELOAD = path.join(__dirname, 'codex', 'codex-frame-preload.js');
const webviewSites = createWebviewSites();

// Sets an instance's session cookie, and has its webviews get it too.
function connectInstance(port, cookie) {
  webviewSites.connect(port, cookie);
  return session.fromPartition(PARTITION).cookies.set({ url: `http://127.0.0.1:${port}/`, path: '/', sameSite: 'lax', ...cookie });
}
// Outside the asar archive in the packaged app, since Windows cannot run an exe from inside it
// and code-server cannot read a VSIX there.
const NATIVE_DIR = app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(__dirname, '..', 'native');
function tabAgent(tab) {
  return normalizeAgent(tab?.provider, config.agents, config.defaultAgent);
}

function managedSettings() {
  return { ...managedAgentSettings({ agents: config.agents, wrapper: WRAP_EXE, permissionMode: config.permissionMode, locale: config.resolvedLocale }), 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false };
}

function extensionListForAgents(agents, extras = config.extensions) {
  return [...new Set([...agentExtensions(agents), ...(Array.isArray(extras) ? extras.filter((id) => !isAgentExtension(id)) : [])])];
}

function refreshResolvedExtensions() {
  config.extensions = extensionListForAgents(config.agents, config.extensions);
  const imported = extensionImports.records(localTarget()).map((record) => record.id).filter((id) => !isAgentExtension(id));
  config.resolvedExtensions = withLanguagePack([...new Set([...config.extensions, ...imported])], config.resolvedLocale);
}

// Chromium treats hidden views and covered windows as hidden and throttles their timers. The
// Claude panel's webview then stops answering the extension, and sessions in background tabs
// stall for minutes (stage 0 finding), so every tab keeps running at full speed.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// The menu macOS cannot do without: the standard editing shortcuts (Cmd+C, Cmd+V, Cmd+A) come
// with it, and without one they do nothing anywhere in the window. It leaves out the items whose
// shortcuts are VS Code's: Close (Cmd+W) closes an editor tab, New (Cmd+N) opens an editor. It
// is set once the UI language is known (see app.whenReady below).
/** @returns {import('electron').MenuItemConstructorOptions[]} */
function macMenuTemplate() {
  return [
    { role: 'appMenu' },
    { role: 'editMenu', label: t('Edit') },
    { label: t('Window'), submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ];
}

// No application menu: its accelerators would take Ctrl+W / Ctrl+T / Ctrl+Tab from VS Code.
if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
// Same as the installer's appId, so Windows attributes notifications to the app. A development
// run gets its own: Electron gives it a Start menu shortcut (Electron.lnk) with this ID, and one
// sharing the installed app's ID takes over its notifications, which then show as "Electron" and
// start a bare Electron when clicked.
app.setAppUserModelId(app.isPackaged ? 'io.github.worktabs.worktabs' : 'io.github.worktabs.worktabs.dev');

// Development: WORKTABS_DATA_DIR gives a separate instance (its own tabs, browser storage and
// single-instance lock) that runs next to the installed app. WORKTABS_HIDDEN keeps its window
// hidden for scripted checks.
if (process.env.WORKTABS_DATA_DIR) app.setPath('userData', path.resolve(process.env.WORKTABS_DATA_DIR));

if (!app.requestSingleInstanceLock()) app.quit();

// On macOS, an app started from Finder or the Dock has no PATH from the shell's start-up files:
// ghq, gh and claude would not be found (see shell-env.js). Read while Electron starts, and taken
// before the first command runs.
const shellEnvReady = process.platform === 'darwin'
  ? readShellEnv().then((env) => applyShellEnv(process.env, env))
  : Promise.resolve();

const dataDir = app.getPath('userData');
const extensionImports = new ExtensionImports(path.join(dataDir, 'extension-imports'));
// The wrapper the Claude Code extension runs for every claude (claudeCode.claudeProcessWrapper).
// Windows brings its claude-wrap.exe along; on macOS the app writes the wrapper into its own
// data folder at start, since the wrapper names the binary that runs it.
const WRAP_EXE = process.platform === 'win32'
  ? path.join(NATIVE_DIR, 'claude-wrap.exe')
  : path.join(dataDir, 'bin', 'claude-wrap');
const config = loadConfig(path.join(__dirname, '..'), dataDir, app.isPackaged);
setGithubHosts(config.githubHosts);
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
const hooks = new HookServer({ logFile: path.join(dataDir, 'logs', 'hooks.log') });
const sessions = new ConversationStore();
const claudeObserver = new ClaudeObserver(sessions).start();
const usage = new UsageTracker(path.join(dataDir, 'usage.json'));
const codexUsage = new CodexUsageTracker();
const usagePolling = new UsagePolling({
  usage, codexUsage,
  enabled: () => config.agents,
  options: () => ({ extensionsDir: config.resolvedExtensionsDir, cwd: dataDir }),
  changed: () => pushState(),
  log: (record) => fs.appendFile(path.join(dataDir, 'logs', 'usage-refresh.log'), `${JSON.stringify(record)}\n`, () => {}),
});
let usageRefreshTimer;

// The VS Code settings the tabs of each repository's worktrees share.
const userSettings = new SettingsSync({
  dir: path.join(dataDir, 'repos'),
  defaults: DEFAULT_SETTINGS,
  log: (line) => fs.appendFileSync(path.join(dataDir, 'logs', 'settings.log'), `${new Date().toISOString()} ${line}\n`),
});
// Tab identity, selection, and pending starts are owned outside Electron.
const startup = new StartupGate();
const lifecycle = new TabLifecycle(tabDependencies());
const tabs = lifecycle.tabs;
const tabPorts = lifecycle.ports;
const { stopRisks, riskLines, confirmStop, confirmCloseTogether, suspendIdleTabs } = createTabRisks({
  tabs, sessions, messageBox, activeId: () => lifecycle.activeId,
  idleMinutes: () => config.idleSuspendMinutes, suspend: (tab, options) => lifecycle.suspend(tab, options),
});
// Where the helper extension in each running tab's VS Code listens: id -> { port, token }.
const helpers = new Map();
const { callHelper, applySettings } = createHelperClient(helpers);
// Worktrees being removed (lowercase folder paths), shown as such in the side bar.
const removing = new Set();
// Repositories of the account being cloned (repoKey in clone.js), shown as such in the side bar.
const cloning = new Set();
// The code-server manager of the tabs on Windows, and those of the WSL distributions in use.
const codeServers = createServerRegistry({ createWsl: createWslServers });
let win;
let sidebar;
let emptyView;
// Over everything else, where the app's dialogs show (see "Dialogs").
let dialogView;

// The colors of the VS Code theme in the tab in front, which the side bar and the placeholder
// pages take (see theme.js).
const theme = createThemeState({
  file: path.join(dataDir, 'theme.json'), views: () => ({ win, dialogView }), tabs,
  activeId: () => lifecycle.activeId, changed: () => pushState(),
});
const readTheme = (tab) => theme.read(tab);

function tabIdFor(folder) {
  const hash = crypto.createHash('sha1').update(normalizeFolder(folder).toLowerCase()).digest('hex');
  return `t${hash.slice(0, 10)}`;
}

// A page in the colors of the side bar's theme.
function placeholderUrl(title, detail = '') {
  return placeholderPage(title, detail, theme.current(), language());
}

// ---- State shown in the tab bar ----------------------------------------------------------

const stateView = createViewState({
  lifecycle, sessions, tabAgent, update: () => updateCoordinator.state, appUpdate: () => selfUpdate.state, removing, cloning,
  repoUsed: () => tabStore.repoUsed(), agents: () => config.agents, usage, codexUsage,
  theme: () => theme.current(), views: () => ({ win, sidebar, emptyView }),
});
const viewState = stateView.viewState;

// A declaration, as dependencies made above take it before this line runs.
function pushState() {
  stateView.push();
}

let conversationSaveTimer = null;
let tabsRestored = false;

// The width of the chat in each repository's primary, for the worktrees opened while it does not
// run (see fitChat).
const chatWidths = new ChatWidths();
const tabStore = createTabStore({
  file: path.join(dataDir, 'tabs.json'), lifecycle, chatWidths,
  // Looking into a WSL folder would start its distribution, holding up the start here; a folder
  // that is gone shows when its tab starts.
  present: (folder) => Boolean(parseWslPath(folder)) || fs.existsSync(folder),
});

function saveTabs() {
  tabStore.save();
}

// What VS Code web kept in the browser for the instances that listened on `ports`, which no tab
// keeps any more (tab-ports.js): deleted, so that a tab given one of them later starts empty. Not
// the cookies: they are not kept apart by port, so the other tabs' would go too.
/** @type {import('electron').ClearStorageDataOptions['storages']} */
const ORIGIN_STORAGES = ['filesystem', 'indexdb', 'localstorage', 'serviceworkers', 'cachestorage'];

function clearPortStorage(ports) {
  const storage = session.fromPartition(PARTITION);
  return Promise.all(
    ports.map((port) => storage.clearStorageData({ origin: `http://127.0.0.1:${port}`, storages: ORIGIN_STORAGES }).catch(() => {})),
  );
}

// ---- Layout --------------------------------------------------------------------------------

const windowLayout = createWindowLayout({
  file: path.join(dataDir, 'window.json'), screen, tabs, configured: () => config.sidebarWidth,
  views: () => ({ win, sidebar, emptyView, dialogView }),
});
const layout = () => windowLayout.layout();

// Adds a view to the window under the side bar and the dialogs. The side bar sits over the tabs
// only while its edge is dragged; else they do not overlap.
function addView(view) {
  win.contentView.addChildView(view, win.contentView.children.indexOf(sidebar));
}

// ---- Dialogs -------------------------------------------------------------------------------

// The app draws its dialogs itself, over the whole window and in the colors of the VS Code theme
// (src/dialog/): Electron's are Windows' task dialogs, white whatever the theme. One at a time;
// the others wait.
const appDialogs = createDialogView({
  views: () => ({ win, sidebar, dialogView }), focused: () => webContents.getFocusedWebContents(),
  activeTab: () => tabs.get(lifecycle.activeId), theme: () => theme.current(),
  refreshSeen: () => seenConversations.refresh(),
});
const dialogs = appDialogs.dialogs;

// A declaration, as dependencies made above take it before this line runs.
function messageBox(options) {
  return appDialogs.messageBox(options);
}

// ---- Tabs ----------------------------------------------------------------------------------

const createTabView = createTabViews({
  makeView: () => new WebContentsView({ webPreferences: viewPreferences(WORKBENCH_VIEW) }),
  frameOf: (processId, routingId) => webFrameMain.fromId(processId, routingId),
  folderFromUrl: (url) => codeServers.all().map((manager) => manager.folderFromUrl(url)).find(Boolean),
  openTab, openExternal: (url) => shell.openExternal(url), hostKeys: handleHostKeys,
  current: (tab) => lifecycle.current(tab), approvalMode: () => config.codexApprovalMode, changed: pushState,
});

// Electron and app services adapt the lifecycle's small operations here. They do not decide
// whether an asynchronous result still belongs to a tab or to its current server start.
function tabDependencies() {
  return {
    idOf: tabIdFor,
    resolveFolder: normalizeFolder,
    describe: (folder, provider = config.defaultAgent) => ({
      name: path.basename(folder), branch: null,
      provider: normalizeAgent(provider, config.agents, config.defaultAgent),
    }),
    mount: (tab) => {
      tab.view = createTabView(tab);
      tab.view.setVisible(false);
      addView(tab.view);
      layout();
    },
    unmount: (tab) => {
      win.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    },
    lookupRepo: async (tab) => {
      const [repo, root] = await Promise.all([mainWorktree(tab.folder), repoRoot(tab.folder)]);
      return { repo, linkedWorktree: isOtherWorktree(root, repo) };
    },
    lookupBranch: (tab) => currentBranch(tab.folder),
    used: (tab) => tabStore.markTabUsed(tab),
    prepare: () => startup.wait(),
    managerFor: (tab) => codeServers.forFolder(tab.folder),
    canStart: (tab) => updateCoordinator.canStart(tab),
    startOptions: (tab) => ({ shareSettings: sharedTabSettings(tab) }),
    connect: (_tab, { port, cookie }) => connectInstance(port, cookie),
    navigate: (tab, url) => tab.view.webContents.loadURL(url),
    placeholder: showTabPlaceholder,
    exitError: (code) => t('code-server ended (code {code}). Select the tab to restart it.', { code }),
    cleanup: clearTabRuntime,
    cancelReveal: (tab) => conversationOpening.cancelPending(tab),
    activate: (tab) => {
      for (const other of tabs.values()) other.view.setVisible(other === tab);
      seenConversations.refresh();
      // A hidden view can take keyboard focus (electron#54321), so focus this one explicitly;
      // with a dialog up, once it has gone (dialog-view.js).
      if (!dialogs.current) tab.view.webContents.focus();
      if (tab.theme) theme.set(tab.theme);
    },
    confirm: (tab, action) => confirmStop(tab, action),
    confirmTogether: (tabList, name) => confirmCloseTogether(tabList, name),
    canClose: () => Boolean(win),
    remember: (tab) => rememberChatWidth(tab),
    reload: (tab) => tab.view.webContents.reload(),
    metadata: (tab) => ({ provider: tabAgent(tab), conversations: sessions.codexHistory(tab.id) }),
    restoreMetadata: (tab, entry) => sessions.restoreCodexHistory(tab.id, entry.conversations),
    clearStorage: clearPortStorage,
    save: saveTabs,
    changed: pushState,
  };
}

function showTabPlaceholder(tab, state, detail) {
  const page = tabPlaceholder(tab.name, state, detail, startup.status === 'pending');
  tab.view.webContents.loadURL(placeholderUrl(page.title, page.detail));
}

function openTab(folder, options) {
  return lifecycle.open(folder, options);
}

// The code-server manager of a WSL distribution's tabs (server-registry.js makes one per
// distribution).
function createWslServers(distro) {
  const manager = new WslCodeServerManager({
    distro,
    dataDir,
    version: () => config.codeServerVersion,
    customDir: config.wslCodeServerDir,
    download: (options) => downloadRelease({ dataDir, ...options }),
    extensions: [...config.resolvedExtensions, ...helperExtensions()],
    extensionSpecs: (target) => extensionSpecs(target),
    unpinnedExtensions: ['anthropic.claude-code'],
    restrictExtensionGallery: config.restrictExtensionGallery,
    windowsExtensionsDir: config.resolvedExtensionsDir,
    hooks,
    locale: config.resolvedLocale,
    managedSettings: managedSettings(),
  });
  manager.on('exit', onServerExit);
  // Hooks and the helper extension's requests from the distribution, through its agent.
  manager.on('request', (route, tabId, procId, raw) => hooks.receive(route, tabId, procId, raw));
  manager.on('proc-exit', (procId) => sessions.endProc(procId));
  return manager;
}

// The distributions of the listed repositories, as the last run left the list, and of the open
// tabs (see prepareWsl in server-registry.js).
async function prepareWsl() {
  const repos = repositories.list || (await refreshRepos());
  codeServers.prepareWsl([...repos.map((repo) => repo.path), ...[...tabs.values()].map((tab) => tab.folder)]);
}

function onServerExit(tabId, code, owner) {
  lifecycle.exited(tabId, code, owner);
}

function startServer(tab) {
  return lifecycle.start(tab);
}

function sharedTabSettings(tab) {
  if (!tab.repo) return null;
  return (target) => userSettings.attach({
    ...target,
    tabId: tab.id,
    repo: tab.repo,
    managed: { ...target.managed, ...onboardingSettings(tab.linkedWorktree) },
    unshared: ONBOARDING_SETTINGS,
    worktreeTabs: () => worktreeTabIds(tab.repo),
    apply: (changes) => applySettings(tab.id, changes),
  });
}

// The tabs of a repository's worktrees, open or not: the first time one of them starts, their
// settings make those the repository's tabs share.
async function worktreeTabIds(repo) {
  const worktrees = await gitWorktrees(repo).catch(() => []);
  return worktrees.map((worktree) => tabIdFor(worktree.path));
}

function activateTab(id) {
  lifecycle.activate(id);
}

// Branches and worktrees also change outside the app (a checkout in a terminal or Claude
// itself), so they are read again when the window comes to the front and when a Claude
// turn ends. The side bar reads the worktrees of `repos` (every expanded one when null).
async function refreshGit(tabList = [...tabs.values()], repos = null) {
  const changed = await Promise.all(
    tabList.map(async (tab) => {
      const branch = await currentBranch(tab.folder);
      if (branch === tab.branch) return false;
      tab.branch = branch;
      return true;
    }),
  );
  if (changed.some(Boolean)) pushState();
  if (sidebar && !sidebar.webContents.isDestroyed()) sidebar.webContents.send('worktrees:reload', repos);
}

function cycleTab(step) {
  if (!lifecycle.order.length) return;
  const index = Math.max(0, lifecycle.order.indexOf(lifecycle.activeId));
  activateTab(lifecycle.order[(index + step + lifecycle.order.length) % lifecycle.order.length]);
}

// Runtime state is cleared for both agents. Codex history stays for a stopped open tab;
// closing removes it too. Reveal timers are cleared by the lifecycle on the captured tab.
function clearTabRuntime(tab, { keepCodex }) {
  sessions.clearTab(tab.id, { keepCodex });
  codexUsage.clearTab(tab.id);
  helpers.delete(tab.id);
}

function closeTab(id, options) {
  return lifecycle.close(id, options);
}

function closeTabsTogether(ids, name) {
  return lifecycle.closeTogether(ids, name);
}

function suspendTab(tab, options) {
  return lifecycle.suspend(tab, options);
}

function restartServer(tab) {
  return lifecycle.restart(tab);
}

function reloadTab(tab) {
  return lifecycle.reload(tab);
}

// ---- Updates -------------------------------------------------------------------------------

function logUpdate(line) {
  fs.appendFileSync(path.join(dataDir, 'logs', 'updates.log'), `${new Date().toISOString()} ${line}\n`);
}

const probeInstance = createUpdateProbe({
  dataDir, config, servers: codeServers.local, reserved: (id) => tabPorts.reserved(id), clearPortStorage, startupExtensions,
  connect: connectInstance,
  hiddenView: () => {
    const view = new WebContentsView({ webPreferences: viewPreferences(WORKBENCH_VIEW) });
    view.setVisible(false);
    addView(view);
    view.setBounds(emptyView.getBounds());
    return {
      webContents: view.webContents,
      close: () => {
        win.contentView.removeChildView(view);
        view.webContents.close();
      },
    };
  },
});

// status: 'none' | 'available' | 'preparing' (download) | 'waiting' (for the busy tabs named in
// `busy`) | 'applying' | 'done' | 'failed'. items: the updates, [{ kind, id, name, from, to }].
const {
  coordinator: updateCoordinator, setUpdate, checkForUpdates, checkLocalExtensionUpdates, startUpdate, cancelUpdate, dismissUpdate,
  updateRisks, extensionSpecs, rememberCandidate, extensionState, queueExtensionImports, rollbackExtension,
} = createAppUpdates({
  config, saveConfig, dataDir, tabs, servers: codeServers.local, wslServers: codeServers.wsl, extensionImports,
  pause: (tab) => {
    lifecycle.stop(tab);
    tab.view.webContents.loadURL(placeholderUrl(tab.name, t('Updating extensions')));
  },
  start: startServer, stopRisks, callHelper, helperExtensions, refreshResolvedExtensions, probe: probeInstance,
  messageBox, changed: pushState, log: logUpdate, find: findUpdates,
});

// ---- Updates of Worktabs itself ------------------------------------------------------------

const SELF_UPDATE_DIR = path.join(dataDir, 'app-update');
const SELF_UPDATE_RESULT = path.join(SELF_UPDATE_DIR, 'result.json');
const SELF_UPDATE_FILE = path.join(dataDir, 'app-update.json');
const selfTarget = updateTarget({ execPath: process.execPath, resourcesPath: process.resourcesPath, isPackaged: app.isPackaged, exists: fs.existsSync });

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const selfUpdate = createSelfUpdate({
  currentVersion: app.getVersion(),
  appPath: selfTarget.appPath,
  reason: selfTarget.reason,
  find: async () => newestRelease(await fetchReleases({ runGh: (args) => runAt(null, 'gh', args, 20000), getJson }), app.getVersion()),
  stage: (release, onProgress) => {
    const net = require('./self-update/net');
    return stageRelease({ release, appPath: selfTarget.appPath, dataDir, onProgress, ...net });
  },
  swap: ({ staged, container }, version, relaunch) => {
    fs.mkdirSync(SELF_UPDATE_DIR, { recursive: true });
    fs.rmSync(SELF_UPDATE_RESULT, { force: true });
    let script;
    if (process.platform !== 'win32') {
      script = path.join(SELF_UPDATE_DIR, 'swap.sh');
      fs.writeFileSync(script, swapScript());
    }
    const { command, args, env: values, verbatim } = swapCommand({
      pid: process.pid, appPath: selfTarget.appPath, staged, container, old: stagingPaths(selfTarget.appPath).old,
      version, result: SELF_UPDATE_RESULT, relaunch, script,
    });
    // The new version starts as from Explorer or Finder, not as a child of this one, but with the
    // data folder this one runs with.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key === 'WORKTABS_DATA_DIR' || !/^(ELECTRON_|WORKTABS_)/i.test(key)));
    // Not in the app's folder (its working folder when started from a shortcut): Windows does not
    // rename a folder that a process runs in.
    spawn(command, args, {
      cwd: SELF_UPDATE_DIR, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim, env: { ...env, ...values },
    }).unref();
  },
  risks: async () => {
    const { busy, unobserved } = await updateRisks();
    // A code-server update in the middle of switching would be cut off.
    return { busy: updateCoordinator.busy ? [...busy, 'code-server'] : busy, unobserved };
  },
  quit: () => win?.close(),
  skipped: () => readJsonFile(SELF_UPDATE_FILE)?.skipped || '',
  skip: (version) => fs.writeFileSync(SELF_UPDATE_FILE, JSON.stringify({ skipped: version })),
  lastResult: () => {
    const text = fs.existsSync(SELF_UPDATE_RESULT) ? fs.readFileSync(SELF_UPDATE_RESULT, 'utf8') : null;
    fs.rmSync(SELF_UPDATE_RESULT, { force: true });
    return text === null ? null : readSwapResult(text);
  },
  messageBox, changed: pushState, log: (line) => logUpdate(`worktabs: ${line}`),
});

// Checks for a new version of Worktabs at start and then twice a day, as the app may stay open
// for days.
function startSelfUpdates() {
  if (!selfTarget.checkable) return;
  if (selfTarget.appPath) {
    try { removeLeftovers(selfTarget.appPath); }
    catch (error) { logUpdate(`worktabs: could not remove the last update's folders: ${error.message}`); }
  }
  selfUpdate.showLastResult();
  if (!config.updateCheck) return;
  selfUpdate.check();
  setInterval(() => selfUpdate.check(), 12 * 60 * 60 * 1000);
}

// ---- Repositories and settings -------------------------------------------------------------

const REPOS_FILE = path.join(dataDir, 'repos.json');
const repositories = new RepositoryService({
  config: () => config,
  tabs: () => tabs,
  catalog: repoCatalog,
  remotes: readRemotes,
  visibility: repoVisibility,
  hosts: signedInHosts,
  owned: ownedRepos,
  pulls: approvedPulls,
  running: runningDistros,
  now: Date.now,
  write: (cache) => writeRepoCache(REPOS_FILE, cache),
  log: logRepos,
  changed: sendRepos,
}, readRepoCache(REPOS_FILE));
const APPROVED_EVERY = 5 * 60 * 1000;
const APPROVED_AGAIN = 60 * 1000;

function logRepos(line) {
  fs.appendFileSync(path.join(dataDir, 'logs', 'repos.log'), `${new Date().toISOString()} ${line}\n`);
}

function repoMessage() { return repositories.message(); }
function unclonedView() { return repositories.uncloned(); }
function refreshRepos(options) { return repositories.refresh(options); }
function rememberWorktrees(repo, items) { repositories.remember(repo, items); }
function refreshApproved(all = false) { return repositories.refreshApproved(all); }

function sendRepos() {
  if (sidebar && !sidebar.webContents.isDestroyed()) sidebar.webContents.send('repos:update', repoMessage());
}

// Listing running distributions never starts one. Periodic reads preserve sleeping caches.
async function runningDistros() {
  const { names } = await listDistros({ args: ['-l', '--running', '-q'] });
  return names && new Set(names.map((name) => name.toLowerCase()));
}

// Settings, the repositories added by hand, and extensions picked by hand.
const { saveSettings, scheduleCodexSetupWarnings, addRepository, openConfigFile, browseExtensionSource, openDesktopCode } = createSettingsActions({
  config, saveConfig, tabs, servers: codeServers.local, wslServers: codeServers.wsl, managedSettings,
  extensionSpecs, helperExtensions, extensionListForAgents, refreshResolvedExtensions,
  usagePolling, pushState, messageBox, showOpenDialog: (options) => dialog.showOpenDialog(win, options),
  openPath: (target) => shell.openPath(target), repositories, refreshRepos, repoRoot,
  rememberCandidate, readVsix, localExtensions,
});

function openSettingsDialog(section = 'general') {
  return dialogs.open(settingsDialog({ ...config, section }));
}

// Shows a folder in the file manager, or with `select` an item selected in its folder. On
// Windows that is a new tab of the front Explorer window, or a new window (claude-wrap.exe
// --explore); started by the app, it may bring the window to the front. Elsewhere (Finder) the
// shell opens it, which is what Windows falls back to without the wrapper.
function openInExplorer(target, { select = false } = {}) {
  if (process.platform !== 'win32' || !fs.existsSync(WRAP_EXE)) {
    if (select) shell.showItemInFolder(target);
    else shell.openPath(target);
    return;
  }
  execFile(WRAP_EXE, [select ? '--explore-select' : '--explore', target], { windowsHide: true }, () => {});
}

// VSIX files of the app's helper extension (helper-extension/, packed by npm run build:native).
// Without one the app still works, just without the commands it adds.
function helperExtensions() {
  try {
    return fs.readdirSync(NATIVE_DIR).filter((file) => file.endsWith('.vsix')).map((file) => path.join(NATIVE_DIR, file));
  } catch {
    return [];
  }
}

// ---- Adding and removing worktrees ---------------------------------------------------------

const { addWorktreeDialog, addingTo, addWorktreeTab } = createWorktreeAdding({
  dialogs, windowOpen: () => Boolean(win), remotes: () => repositories.remotes, githubRepo, addWorktree,
  setBranchLink, gitMessage, firstPrompt, openTab, tabs, forgetFocus: appDialogs.forgetFocus,
  send: (channel, ...args) => {
    if (sidebar && !sidebar.webContents.isDestroyed()) sidebar.webContents.send(channel, ...args);
  },
  refreshGit, messageBox,
});

const { removalCheck, confirmRemoveWorktree, removeWorktreeNow } = createWorktreeRemoval({
  tabs, removing, tabIdFor, stopRisks, conversations: (id) => sessions.conversations(id),
  messageBox, openTab, closeTab, pushState, refreshGit, serversFor: codeServers.forFolder, clearPortStorage,
  forgetPort: (id) => tabPorts.forget(id), saveTabs, notifyBranchDeleted: (branch, tip) => notifyBranchDeleted(branch, tip),
  removableWorktree, worktreeChanges, unsharedCommits, ignoredOnlyHere, githubRepo, branchLinks,
  branchPulls, mergedAtHead, removeWorktree, deleteBranch, gitMessage,
});

// ---- Cloning repositories of the account ---------------------------------------------------

// Where to clone, cloning, and the dialog that asks where are in clone-coordinator.js; the menus
// and the native folder picker are here.
const { ownedRepo, isCloning, clonePlaces, hideOwner, startClone, openCloneDialog, dialogRequests: cloneRequests } = createCloneCoordinator({
  config, saveConfig, repositories, cloning, dialogs, messageBox, pushState, sendRepos, refreshRepos,
  cloned: (folder) => {
    if (sidebar && !sidebar.webContents.isDestroyed()) sidebar.webContents.send('repos:cloned', folder);
  },
  log: logRepos,
  pickFolder: async ({ title, defaultPath }) => {
    const result = await dialog.showOpenDialog(win, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] || null;
  },
  windowOpen: () => Boolean(win),
  hasGhq, gitProtocol, cloneRepo, placeFolder,
});

// ---- GitHub and menus ----------------------------------------------------------------------

const { openGithub, openNumbered, openChecks, branchPage, repoInfo, pullRequests } = createGithubPages({
  githubRepo, pageUrl, checksUrl, branchPulls, hasBranchPage, openExternal: (url) => shell.openExternal(url),
});

const { showAddMenu, showMoreMenu, showTabMenu, showRepoMenu, showWorktreeMenu, showCloneMenu, showUnclonedMenu, showOwnerMenu } = createMenus({
  popup: (template) => Menu.buildFromTemplate(template).popup({ window: win }),
  tabs, order: () => lifecycle.order, remotes: () => repositories.remotes, owned: () => repositories.owned,
  chooseFolder: async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] || null;
  },
  addRepository, openTab, canUpdate: () => Boolean(codeServers.local()), checkForUpdates,
  canCheckApp: () => selfTarget.checkable, checkAppUpdate: () => selfUpdate.check({ manual: true }),
  appVersion: app.getVersion(), openSettingsDialog, openConfigFile,
  restartServer, suspendTab, reloadTab, closeTab, closeTabsTogether, addWorktreeDialog,
  removableWorktree, confirmRemoveWorktree, isGitFolder, openInExplorer, copy: (text) => clipboard.writeText(text),
  openExternal: (url) => shell.openExternal(url), openGithub, branchPage,
  ownedRepo, isCloning, clonePlaces, startClone, hideOwner,
});

// ---- Keys and notifications ----------------------------------------------------------------

function handleHostKeys(event, input, contents) {
  const action = hostKeyAction(input, { dialogOpen: Boolean(dialogs.current), pasteFallback: config.pasteFallback });
  if (!action) return;
  event.preventDefault();
  if (action === 'paste') contents.paste();
  else cycleTab(action === 'next' ? 1 : -1);
}

const { openFromNotification, bringWindowToFront, onSessionState, onToolUsed, notifyBranchDeleted } = createSessionNotices({
  Notification, window: () => win, tabs, sessions, activeId: () => lifecycle.activeId,
  refreshSeen: () => seenConversations.refresh(), revealSession, refreshGit, refreshApproved,
});

const seenConversations = new SeenConversations({
  activeTab: () => tabs.get(lifecycle.activeId),
  focused: () => Boolean(win?.isFocused()) && !dialogs.current,
  hasUnread: (tab) => sessions.hasUnread(tab.id),
  conversations: (tab) => sessions.conversations(tab.id),
  markSeen: (tab, id) => sessions.markSeen(tab.id, id),
  changed: () => pushState(),
  read: async (tab) => {
    if (tab.server !== 'running' || tab.view.webContents.isDestroyed()) return [];
    let timer;
    try {
      // A stuck renderer must not hold up future checks or a newly selected tab.
      return await Promise.race([shownConversations(tab.view.webContents), new Promise((resolve) => { timer = setTimeout(resolve, 1000, []); })]);
    } finally { clearTimeout(timer); }
  },
});

function onSessionsChange(tabId) {
  const tab = tabs.get(tabId);
  if (tab) tab.lastUsed = Date.now();
  pushState();
  // Protocol item events can arrive in bursts. Coalesce metadata writes; quitting flushes them.
  clearTimeout(conversationSaveTimer);
  conversationSaveTimer = setTimeout(() => saveTabs(), 500);
}

const { showAgentChat, startFirstConversation, rememberChatWidth } = createChatPanel({
  tabs, runs: (id) => lifecycle.runs.get(id), tabIdFor, tabAgent, chatWidths, saveTabs, callHelper,
  messageBox, copy: (text) => clipboard.writeText(text),
});

// Switches to the tab and brings one of its conversations to the front. The helper
// extension in the tab's VS Code does the latter; until it has registered (or with an older
// helper), the tab is only switched to.
const conversationOpening = createConversationOpening({
  tabs, helpers, sessions, activeId: () => lifecycle.activeId, runFor: (id) => lifecycle.runs.get(id),
  activateTab, callHelper, readTheme, startFirstConversation, showAgentChat,
  focused: () => Boolean(win?.isFocused()), messageBox, pushState, refreshSeen: () => seenConversations.refresh(),
  read: async (tab) => {
    const frames = await visibleCodexFrames(tab.view.webContents);
    return Promise.all(frames.map((frame) => frame.executeJavaScript(codexNavigationScript()).catch(() => null)));
  },
});

function revealSession(tabId, sessionId) {
  return conversationOpening.revealSession(tabId, sessionId);
}

// The conversation each badge at the top of the side bar went to last, by state, so the next
// click goes on to the one after it.
const lastRevealed = {};

// Brings the next conversation in `state` ('waiting', 'working') to the front.
function revealNext(state) {
  const next = nextConversation(sessions.inState(state, lifecycle.order), lastRevealed[state]);
  if (!next) return;
  lastRevealed[state] = next.id;
  revealSession(next.tabId, next.id);
}

// Takes a conversation off the side bar's list. Its claude goes on (see SessionTracker.archive).
function archiveSession(tabId, sessionId) {
  if (sessions.archive(tabId, sessionId)) {
    saveTabs();
    pushState();
  }
}

// ---- Development control port --------------------------------------------------------------

function controlHandlers() {
  return createControlHandlers({
    tabs,
    views: () => ({ sidebar: sidebar.webContents, dialog: dialogView.webContents }),
    focusedContents: () => webContents.getFocusedWebContents(),
    viewState, sessionsSnapshot: () => sessions.snapshot(), sessions, language,
    openTab, activateTab, closeTab,
    closeTabsTogether: (ids, repo) => closeTabsTogether(ids, groupName(repo)),
    suspendTab, stopRisks, checkForUpdates, revealSession, archiveSession,
    windowState: () => ({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }),
    setWindowBounds: (bounds) => win.setBounds(bounds),
    layout: () => ({
      window: win.getContentBounds(),
      sidebar: sidebar.getBounds(),
      empty: emptyView.getBounds(),
      tabs: Object.fromEntries([...tabs.values()].map((tab) => [tab.id, tab.view.getBounds()])),
      ...windowLayout.snapshot(),
    }),
    addWorktreeTab, addWorktreeDialog, checkedTask,
    uncloned: () => ({ groups: unclonedView(), places: clonePlaces(), ghqDistros: [...repositories.ghqDistros.values()] }),
    ownedRepo, openCloneDialog, startClone, startFirstConversation, firstPrompt, describeTask,
    suggestBranch: (repo, task) => suggestBranch(repo, task, { agent: effectiveBranchAgent(config), extensionsDir: config.resolvedExtensionsDir }),
    removalCheck, removeWorktreeNow, messageBox, callHelper,
    quit: () => {
      setTimeout(() => app.quit(), 100);
    },
    closeWindow: () => win.close(),
    screenshotDir: () => path.join(dataDir, 'logs'),
    writeFile: (file, data) => fs.writeFileSync(file, data),
    webviewFrame: WEBVIEW_FRAME,
  });
}

// ---- App -----------------------------------------------------------------------------------

registerIpc(ipcMain, appIpcRoutes({
  uiLanguage: () => ({ language: language(), messages: messages() }),
  viewState, activateTab, closeTab, openTab, groupName, closeTabsTogether, revealNext, revealSession, archiveSession,
  showAddMenu, showMoreMenu, showTabMenu, showRepoMenu, showWorktreeMenu, showCloneMenu, showUnclonedMenu, showOwnerMenu,
  openSettingsDialog,
  resizeSidebar: (width) => windowLayout.resize(width),
  startSidebarResize: () => windowLayout.startResize(),
  endSidebarResize: (width) => windowLayout.endResize(width),
  resetSidebarWidth: () => windowLayout.resetWidth(),
  reposWithWorktrees: () => {
    // Do not block the side bar's startup on ghq or WSL. It needs this reply before it wires up
    // its refresh button; the live list arrives through repos:update when the read finishes.
    if (!repositories.list && !repositories.catalogRead) refreshRepos();
    return { ...repoMessage(), worktrees: Object.fromEntries(repositories.worktrees) };
  },
  refreshReposAgain: async () => {
    repositories.invalidateRemotes();
    // ~/.ssh/config may have changed, or gh signed in to a host.
    forgetHostLookups();
    await refreshRepos({ again: true });
    return repoMessage();
  },
  listWorktrees, rememberWorktrees, gitMessage, confirmRemoveWorktree, addWorktreeDialog,
  addingTo, describeTask, planWorktree, addWorktreeTab,
  suggestBranch: (repo, task) => suggestBranch(repo, task, { agent: effectiveBranchAgent(config), extensionsDir: config.resolvedExtensionsDir }),
  cloneRequests,
  fromSettingsDialog: appDialogs.fromSettingsDialog,
  saveSettings, extensionState, browseExtensionSource, queueExtensionImports, rollbackExtension, openDesktopCode,
  openExternal: (url) => shell.openExternal(url), checkForUpdates,
  updateAvailable: () => updateCoordinator.state.status === 'available',
  queueUpdate: () => setTimeout(() => startUpdate().catch((error) => setUpdate({ status: 'failed', detail: error.message })), 0),
  repoInfo, openGithub, openNumbered, openChecks, pullRequests,
  startUpdate, cancelUpdate, dismissUpdate, selfUpdate,
  dialogReady: () => ({ dialog: dialogs.current, theme: theme.current() }),
  answerDialog: (id, response, checkboxChecked) => dialogs.answer(id, response, checkboxChecked),
  copyDialog: () => {
    const text = appDialogs.currentText();
    if (text !== null) clipboard.writeText(text);
  },
}));

app.on('second-instance', () => {
  if (win) bringWindowToFront();
});

// After the window is gone (its close handler may still cancel), stop every code-server.
app.on('will-quit', () => {
  claudeObserver.stop();
  clearTimeout(conversationSaveTimer);
  if (tabsRestored) saveTabs();
  clearInterval(usageRefreshTimer);
  usagePolling.stop();
  for (const manager of codeServers.all()) manager.stopAll();
  selfUpdate.onQuit();
});

app.whenReady().then(async () => {
  // The system's languages can be asked for only now, and every menu, dialog and page after this
  // is in the language picked here.
  setLanguage(resolveLanguage(config.locale, app.getPreferredSystemLanguages()));
  // VS Code's display language, and the extensions with the language pack it needs.
  config.resolvedLocale = displayLocale(config.locale, language());
  refreshResolvedExtensions();
  session.fromPartition(PARTITION).registerPreloadScript({ type: 'frame', id: 'worktabs-codex-frame', filePath: CODEX_FRAME_PRELOAD });
  webviewSites.attach(session.fromPartition(PARTITION));
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate(macMenuTemplate()));
  // Electron starts taking clicks on notifications from Windows (as a COM server) with its first
  // notification. A click on one left from before the app started starts the app, and reaches
  // it only once it takes them (see handleActivation below).
  Notification.isSupported();
  const restored = windowLayout.restore();
  // Made hidden and maximized before it shows, so it does not flash at its normal size first.
  win = new BaseWindow({
    ...restored.bounds,
    title: 'Worktabs',
    backgroundColor: windowBackground(theme.current()) || (nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff'),
    show: false,
    // On macOS, a click on the window behind another also clicks what it lands on, as on Windows
    // (where it cannot be turned off): a row of the side bar switches tabs at once. VS Code's own
    // window does the same by default (window.clickThroughInactive).
    acceptFirstMouse: true,
  });
  attachAppIcons({ app, nativeTheme, window: win });
  if (!process.env.WORKTABS_HIDDEN) {
    // On Windows, maximize() also shows the window, hence not on a hidden run.
    if (restored.maximized) win.maximize();
    win.show();
  }
  emptyView = new WebContentsView({ webPreferences: viewPreferences() });
  sidebar = new WebContentsView({ webPreferences: viewPreferences({ preload: path.join(__dirname, 'sidebar', 'preload.js') }) });
  // Transparent: the tab shows through beyond the side bar while its edge is dragged.
  sidebar.setBackgroundColor('#00000000');
  // Transparent: the window shows through around the dialog, dimmed by the page.
  dialogView = new WebContentsView({ webPreferences: viewPreferences({ preload: path.join(__dirname, 'dialog', 'preload.js') }) });
  dialogView.setBackgroundColor('#00000000');
  dialogView.setVisible(false);
  win.contentView.addChildView(emptyView);
  win.contentView.addChildView(sidebar);
  win.contentView.addChildView(dialogView);
  sidebar.webContents.loadFile(path.join(__dirname, 'sidebar', 'index.html'));
  keepPage(sidebar.webContents);
  sidebar.webContents.on('before-input-event', (event, input) => handleHostKeys(event, input, sidebar.webContents));
  // A page gone or reloaded while its edge was dragged would never end the drag, and the side bar
  // would stay over the tabs.
  const endResize = () => windowLayout.endResize(null);
  sidebar.webContents.on('did-start-loading', endResize);
  sidebar.webContents.on('render-process-gone', endResize);
  // Behind the last run's list, which the side bar shows meanwhile (see repos:get).
  shellEnvReady.then(() => refreshRepos());
  const dialogPage = path.join(__dirname, 'dialog', 'index.html');
  dialogView.webContents.loadFile(dialogPage);
  // A dialog the page can no longer answer would hold up what asked and cover the window: the
  // page stays (keepPage), and one that crashes cancels.
  keepPage(dialogView.webContents);
  dialogView.webContents.on('render-process-gone', () => {
    if (!win) return;
    dialogs.cancelAll();
    dialogView.webContents.loadFile(dialogPage);
  });
  emptyView.webContents.loadURL(placeholderUrl('Worktabs', t('Getting ready…')));
  layout();
  // Load the saved session before any sidebar action can save a new tab over it.
  tabStore.restore();
  tabsRestored = true;
  win.on('resize', layout);
  // Saved a moment after moving or resizing stops, and again on close.
  let saveTimer = null;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(windowLayout.save, 500);
  };
  win.on('resize', saveSoon);
  win.on('move', saveSoon);
  win.on('maximize', saveSoon);
  win.on('unmaximize', saveSoon);
  win.on('focus', () => {
    win.flashFrame(false);
    seenConversations.refresh();
    refreshGit();
    if (Date.now() - repositories.approvedAt >= APPROVED_AGAIN) refreshApproved();
  });
  win.on('blur', () => seenConversations.refresh());

  // Closing the window stops every code-server, so check all tabs first.
  const closeGuard = createCloseGuard({
    cancelDialogs: () => dialogs.cancelAll(), risks: () => riskLines(lifecycle.order), messageBox,
    // The primaries' chat widths, for the worktrees opened after the next start.
    beforeClose: () => Promise.all([...tabs.values()].map((tab) => rememberChatWidth(tab))),
    close: () => win.close(),
    canceled: () => selfUpdate.quitCanceled(),
  });
  win.on('close', (event) => {
    clearTimeout(saveTimer);
    windowLayout.save();
    closeGuard.onClose(event);
  });
  win.on('closed', () => {
    for (const tab of tabs.values()) tab.view.webContents.close();
    sidebar.webContents.close();
    emptyView.webContents.close();
    dialogView.webContents.close();
    win = null;
    app.quit();
  });

  await shellEnvReady;
  await hooks.listen();
  const hookSettings = path.join(dataDir, 'hook-settings.json');
  let wrapperError = null;
  if (config.agents.includes('claude') && process.platform !== 'win32') {
    try {
      installWrapper({ dir: path.dirname(WRAP_EXE), exe: process.execPath });
    } catch (error) {
      wrapperError = error;
    }
  }
  hooks.writeSettings(hookSettings, WRAP_EXE);
  wireHooks({
    hooks, tabs, sessions, usage, codexUsage, usagePolling, pushState, onToolUsed,
    helperRegistered: conversationOpening.helperRegistered, readTheme,
    reveal: (target) => openInExplorer(target, { select: true }), exists: fs.existsSync,
  });
  // Time labels, reset expiry and stale Codex snapshots must update even without a response.
  setInterval(() => {
    const expired = usage.expire();
    if (expired || config.agents.length) pushState();
  }, 60 * 1000);
  sessions.on('state', onSessionState);
  sessions.on('change', onSessionsChange);
  sessions.on('restore-failed', conversationOpening.restoreFailed);

  const showEmpty = (title, detail) => emptyView.webContents.loadURL(placeholderUrl(title, detail));
  const servers = await prepareCodeServer({
    config, show: showEmpty, startup,
    ensureCodeServer: (options) => ensureCodeServer({ dataDir, ...options }),
    createServers: (codeServerDir) => {
      const manager = new CodeServerManager({
        codeServerDir,
        extensionsDir: config.resolvedExtensionsDir,
        dataDir,
        codexLauncher: path.join(NATIVE_DIR, 'codex-wrap.exe'),
        env: { WORKTABS_HOOK_URL: hooks.url, WORKTABS_HOOK_TOKEN: hooks.token, WORKTABS_CLAUDE_SETTINGS: hookSettings, ...(config.restrictExtensionGallery ? { EXTENSIONS_GALLERY: '{}' } : {}) },
        locale: config.resolvedLocale,
        managedSettings: managedSettings(),
      });
      manager.on('exit', onServerExit);
      codeServers.setLocal(manager);
      return manager;
    },
    made: () => {
      if (!config.controlPort) return;
      const token = controlToken();
      writeControlToken(dataDir, token);
      startControlServer(config.controlPort, controlHandlers(), token);
    },
    wrapper: () => wrapperProblem({
      agents: config.agents, platform: process.platform, wrapExe: WRAP_EXE, exists: fs.existsSync(WRAP_EXE), error: wrapperError,
    }),
    specs: () => extensionSpecs(), changed: pushState,
  });
  // Even when code-server could not start: a new version may be what fixes that.
  startSelfUpdates();
  if (!servers) return;
  usagePolling.refreshAll();
  usageRefreshTimer = setInterval(() => usagePolling.refreshAll(), REFRESH_EVERY);
  // Clicks on notifications from before the app (re)started, once their tabs are back; one that
  // started the app comes now. A toast without a tab is one from an older version. Windows
  // alone keeps them: elsewhere a click reaches the app that showed it, or nobody.
  if (process.platform === 'win32') {
    Notification.handleActivation(({ arguments: args }) => {
      const target = parseLaunchArgs(args);
      if (target) openFromNotification(target.tabId, target.sessionId);
      else if (win) bringWindowToFront();
    });
  }
  prepareWsl();
  pushState();
  if (config.idleSuspendMinutes > 0) setInterval(suspendIdleTabs, 60 * 1000);
  // While the window stays in front, as it does all day for work in its tabs (see readApproved).
  setInterval(() => refreshApproved(), APPROVED_EVERY);
  scheduleCodexSetupWarnings(config);
  if (config.updateCheck) checkForUpdates().catch((error) => logUpdate(`check failed: ${error.message}`));
  if (config.updateCheck) setInterval(checkLocalExtensionUpdates, 60000);
});
