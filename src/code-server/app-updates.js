// code-server and the extensions stay at the versions the app was tested with until the user
// takes an update offered in the side bar: checking for updates, applying them while no tab is
// busy, and the extensions imported by hand (extension-management.js). The running servers, the
// tabs, and the hidden instance that tries new versions out (update-probe.js) are injected.
const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');
const { UpdateCoordinator } = require('./update-coordinator');
const { applyGalleryUpdate } = require('./update-strategies');
const { createExtensionManagement } = require('./extension-management');
const { idleWaitReason, installedExtensions, localTarget } = require('./extension-imports');
const { ensureCodeServer, removeOldCodeServers } = require('./install');
const { runAt } = require('../commands');
const { sleep } = require('../util');

// While an update downloads, installs, or waits for the tabs, another cannot start.
const UPDATE_BUSY = ['preparing', 'waiting', 'applying'];

// An onProgress for ensureCodeServer that reports the download at most once a second.
function downloadProgress(version, report, now = Date.now) {
  let shown = 0;
  return (mb, totalMb) => {
    if (now() - shown < 1000) return;
    shown = now();
    const of = totalMb ? ` / ${totalMb.toFixed(0)} MB` : ' MB';
    report(t('Downloading code-server {version}… {progress}', { version, progress: `${mb.toFixed(0)}${of}` }));
  };
}

// `servers`: the code-server manager of the tabs here (null until it is made). `pause`: stops a
// tab for the switch and shows that it is updating. `probe`: tries the new versions in a hidden
// instance (update-probe.js). `find`: findUpdates (updates.js, which takes Electron's net).
function createAppUpdates({ config, saveConfig, dataDir, tabs, servers, wslServers, extensionImports,
  pause, start, stopRisks, callHelper, helperExtensions, refreshResolvedExtensions, probe, messageBox,
  changed, log, find, ensure = ensureCodeServer, removeOld = removeOldCodeServers,
  localExtensions = installedExtensions, target = localTarget }) {
  const coordinator = new UpdateCoordinator({
    tabs: () => tabs,
    changed,
    busyError: () => t('Another update is in progress.'),
    startingError: () => t('A tab started during the update check. Try applying again.'),
    waitDetail: (unobserved) => unobserved ? t('Close the tabs where Worktabs cannot see whether Codex is working.') : t('Wait for work to finish and save changes before applying updates.'),
    resumeDetail: () => t('Restarting the tabs…'),
    risks: updateRisks,
    pause,
    start,
    sleep,
    log,
  });
  let checkError = '';
  // Native dialogs remain in main.js; extension selection and staging belong to the service.
  const management = createExtensionManagement({
    config, extensionImports, updateCoordinator: coordinator, getServers: servers,
    helperExtensions,
    vscodeVersion: () => JSON.parse(fs.readFileSync(path.join(servers().codeServerDir, 'lib', 'vscode', 'package.json'), 'utf8')).version,
    probeInstance: probe, refreshResolvedExtensions, setUpdate, startUpdate, checkError: () => checkError,
  });

  function setUpdate(next) {
    coordinator.report(next);
  }

  // `manual`: asked for from the menu, which says so when there is nothing to update.
  async function checkForUpdates({ manual = false } = {}) {
    if (UPDATE_BUSY.includes(coordinator.state.status)) return;
    const stateBefore = coordinator.state;
    let items = extensionImports.localUpdates(target());
    checkError = '';
    let errors;
    try {
      const found = await find({
        codeServerVersion: config.codeServerDir ? null : config.codeServerVersion,
        codeServerDir: servers().codeServerDir,
        extensionsDir: config.resolvedExtensionsDir,
        extensions: config.resolvedExtensions,
        lockedExtensions: ['openai.chatgpt', ...extensionImports.records(target()).map((record) => record.id)],
        runGh: (args) => runAt(null, 'gh', args, 20000),
      });
      items.push(...found.updates);
      errors = found.errors;
    } catch (error) {
      errors = [error.message];
    }
    if (errors.length) {
      for (const error of errors) log(`check failed: ${error}`);
      checkError = t('Could not check app-managed updates: {error}', { error: errors.join('\n') });
    }
    if (coordinator.state !== stateBefore) return;
    log(`check: ${items.map((i) => `${i.id} ${i.from} -> ${i.to}`).join(', ') || 'up to date'}`);
    if (items.length) setUpdate({ status: 'available', items });
    else {
      if (coordinator.state.status === 'available') setUpdate({ status: 'none' });
      if (manual) messageBox({ type: checkError ? 'error' : 'info', message: checkError || t('No updates found in the configured sources.') });
    }
  }

  // Newer versions of the extensions imported by hand, found without asking any gallery.
  function checkLocalExtensionUpdates() {
    if (UPDATE_BUSY.includes(coordinator.state.status)) return;
    try {
      const local = extensionImports.localUpdates(target());
      const remote = coordinator.state.status === 'available' ? coordinator.state.items.filter((item) => item.kind !== 'import') : [];
      if (local.length || remote.length) setUpdate({ status: 'available', items: [...local, ...remote] });
      else if (coordinator.state.status === 'available') setUpdate({ status: 'none' });
    } catch (error) { log(`local check failed: ${error.message}`); }
  }

  // Applies the offered updates. The download comes first; the switch waits until no running tab
  // is busy, because the extensions folder is shared: installing a version marks the old one
  // obsolete, and the next code-server that serves a page deletes it, even while another tab
  // still runs it. The new versions are tried in a hidden instance before any tab restarts on
  // them, and put back if it does not come up.
  async function startUpdate() {
    const update = coordinator.state;
    if (coordinator.state.status !== 'available' || coordinator.busy) return;
    const imports = update.items.filter((item) => item.kind === 'import');
    if (imports.length) {
      const keys = imports.map((item) => management.rememberCandidate(item.candidate).key);
      return management.queueExtensionImports(keys, target(), update.items.filter((item) => item.kind !== 'import'));
    }
    const { items } = update;
    const codeServer = items.find((item) => item.kind === 'code-server');
    const extensions = items.filter((item) => item.kind === 'extension');
    const local = servers();
    const previous = { dir: local.codeServerDir, version: config.codeServerVersion };
    const run = coordinator.begin(items, t('Installing the new versions…'));
    return coordinator.execute(run, {
      applying: t('Installing the new versions…'),
      failure: (error, phase) => phase === 'prepare'
        ? t('{error}. The previous versions stay.', { error: error.message }) : error.message,
      prepare: async (report) => {
        if (!codeServer) return null;
        report({ status: 'preparing', items, detail: t('Preparing code-server {version}…', { version: codeServer.to }) });
        const dir = await ensure({
          dataDir,
          version: codeServer.to,
          onProgress: downloadProgress(codeServer.to, (detail) => report({ status: 'preparing', items, detail })),
        });
        return { dir, version: codeServer.to };
      },
      apply: (next, report) => applyGalleryUpdate({
        items, extensions, next, previous, report, log,
        install: (spec) => local.installExtension(spec),
        use: useCodeServer,
        probe,
        commit: () => {
          saveConfig(config, ['codeServerVersion']);
          removeOld(dataDir, [next.dir, previous.dir]);
        },
        wsl: () => wslServers.values(),
      }),
    });
  }

  // Running Codex tabs whose turns cannot be observed still block the shared extension switch.
  async function updateRisks() {
    const busy = [];
    let unobserved = false;
    const codexInstalled = config.agents.includes('codex') || localExtensions(config.resolvedExtensionsDir).some((item) => item.id === 'openai.chatgpt');
    for (const tab of tabs.values()) {
      const running = tab.server === 'running';
      const risks = running ? await stopRisks(tab) : [];
      const codexActive = running && codexInstalled && !tab.codexObserved
        ? ((await callHelper(tab.id, '/codex-active', {}, { result: true }))?.active ?? null)
        : false;
      const reason = idleWaitReason(tab, { risks, codexActive });
      if (reason) busy.push(tab.name);
      if (reason === 'unobserved') unobserved = true;
    }
    return { busy, unobserved };
  }

  // Instances started from now on run this code-server ({ dir, version }).
  function useCodeServer({ dir, version }) {
    servers().codeServerDir = dir;
    config.codeServerVersion = version;
  }

  function cancelUpdate() {
    coordinator.cancel();
  }

  // The side bar's card goes away once the update is offered, done, or failed.
  function dismissUpdate() {
    if (['available', 'done', 'failed'].includes(coordinator.state.status)) setUpdate({ status: 'none' });
  }

  return {
    coordinator, ...management,
    setUpdate, checkForUpdates, checkLocalExtensionUpdates, startUpdate, cancelUpdate, dismissUpdate, updateRisks,
  };
}

module.exports = { UPDATE_BUSY, createAppUpdates, downloadProgress };
