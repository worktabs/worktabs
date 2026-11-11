// What the Settings dialog and the side bar's "+" and "…" change: the agents and their settings,
// the repositories added by hand, the settings file, and the extensions picked from a VSIX, a
// folder, or VS Code on the desktop. The native pickers, the running servers and the tabs' pages
// are injected.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');
const { codexSetupWarnings, normalizeAgent, normalizeAgents, normalizeBranchAgent } = require('../agents/agents');
const { normalizeCodexApproval } = require('../codex/codex-approval');
const { codexChatFrames } = require('../conversations/chat-frames');
const { normalizeFolder } = require('../wsl/wsl');

function createSettingsActions({ config, saveConfig, tabs, servers, wslServers, managedSettings,
  extensionSpecs, helperExtensions, extensionListForAgents, refreshResolvedExtensions, usagePolling,
  pushState, messageBox, showOpenDialog, openPath, repositories, refreshRepos, repoRoot,
  rememberCandidate, readVsix, localExtensions, ensureCodex = async () => {}, platform = process.platform, env = process.env,
  exists = fs.existsSync, run = execFile, schedule = (fn) => setTimeout(fn, 0) }) {
  // Settings that need Codex's own setup (its CLI, signing in) warn after they are taken, and
  // after Codex has come from Open VSX (or failed to), so that a download is not told as missing.
  function scheduleCodexSetupWarnings(settings) {
    schedule(async () => {
      await ensureCodex().catch(() => {});
      const warnings = await codexSetupWarnings({ ...settings, extensionsDir: config.resolvedExtensionsDir }).catch(() => []);
      if (!warnings.length) return;
      messageBox({
        type: 'warning',
        message: t('Codex setup needs attention'),
        detail: warnings.join('\n'),
      });
    });
  }

  async function saveSettings(input) {
    const agents = normalizeAgents(input?.agents);
    const defaultAgent = normalizeAgent(input?.defaultAgent, agents);
    const branchAgent = normalizeBranchAgent(input?.branchAgent, agents, defaultAgent);
    const extensions = extensionListForAgents(agents);
    config.agents = agents;
    config.defaultAgent = defaultAgent;
    config.branchAgent = branchAgent;
    config.codexApprovalMode = normalizeCodexApproval(input?.codexApprovalMode ?? config.codexApprovalMode);
    config.extensions = extensions;
    refreshResolvedExtensions();
    saveConfig(config, ['agents', 'defaultAgent', 'branchAgent', 'codexApprovalMode']);
    // Updating the preference affects the next empty composer, not an explicit choice in one
    // already open. New webview frames get the current value at load.
    for (const tab of tabs.values()) {
      for (const frame of codexChatFrames(tab.view.webContents)) {
        frame.executeJavaScript(`window.worktabsCodexApproval?.setPreference(${JSON.stringify(config.codexApprovalMode)})`).catch(() => {});
      }
    }
    const local = servers();
    if (local) {
      local.managedSettings = managedSettings();
      await local.ensureExtensions(extensionSpecs());
      for (const manager of wslServers.values()) {
        manager.extensions = [...config.resolvedExtensions, ...helperExtensions()];
        manager.managedSettings = managedSettings();
      }
    }
    for (const agent of config.agents) usagePolling.refresh(agent);
    pushState();
    scheduleCodexSetupWarnings({ agents, defaultAgent, branchAgent });
    return { ok: true };
  }

  // Adds the git repository containing a chosen folder to config.repos, so it shows up in the
  // side bar even when ghq does not know it.
  async function addRepository() {
    const result = await showOpenDialog({ title: t('Add repository'), properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return;
    const root = await repoRoot(result.filePaths[0]);
    if (!root) {
      messageBox({ type: 'error', message: t('This is not a git repository.'), detail: result.filePaths[0] });
      return;
    }
    if (!config.repos.some((repo) => normalizeFolder(repo).toLowerCase() === root.toLowerCase())) {
      config.repos.push(root);
      // Only `repos`: writing the other settings would keep their defaults of today in the file.
      saveConfig(config, ['repos']);
    }
    // Shown at once; the other sources are read again behind it.
    repositories.add(root, 'config');
    refreshRepos();
  }

  function openConfigFile() {
    if (!exists(config.file)) saveConfig(config);
    openPath(config.file);
  }

  // The Extensions pane's "Import": VSIX files, or a folder of installed extensions.
  async function browseExtensionSource(kind) {
    const picked = await showOpenDialog(kind === 'vsix'
      ? { title: t('Import VSIX'), properties: ['openFile', 'multiSelections'], filters: [{ name: t('VS Code extensions'), extensions: ['vsix'] }] }
      : { title: t('Select a VS Code extensions folder'), properties: ['openDirectory'] });
    if (picked.canceled) return { candidates: [] };
    const items = kind === 'vsix' ? picked.filePaths.map(readVsix) : localExtensions(picked.filePaths[0]).map((item) => ({ ...item, root: picked.filePaths[0] }));
    return { candidates: items.map(rememberCandidate) };
  }

  // Opens VS Code on the desktop, to install there what the pane cannot import yet.
  async function openDesktopCode() {
    if (platform === 'darwin') return new Promise((resolve, reject) => run('open', ['-a', 'Visual Studio Code'], (error) => error ? reject(error) : resolve({ ok: true })));
    const candidates = [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
    ].filter(Boolean);
    let file = candidates.find((candidate) => exists(candidate));
    if (!file) {
      const picked = await showOpenDialog({ title: t('Select VS Code'), properties: ['openFile'], filters: [{ name: 'VS Code', extensions: ['exe'] }] });
      if (picked.canceled) return { canceled: true };
      file = picked.filePaths[0];
    }
    const error = await openPath(file);
    if (error) throw new Error(error);
    return { ok: true };
  }

  return { saveSettings, scheduleCodexSetupWarnings, addRepository, openConfigFile, browseExtensionSource, openDesktopCode };
}

module.exports = { createSettingsActions };
