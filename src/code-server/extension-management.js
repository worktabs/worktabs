// Selection, staging, and update ownership are independent of native dialogs and Electron.
const crypto = require('crypto');
const { t } = require('../i18n');
const { agentExtensions, isAgentExtension } = require('../agents/agents');
const imports = require('./extension-imports');

function createExtensionManagement({ config, extensionImports, updateCoordinator, getServers,
  helperExtensions, vscodeVersion, probeInstance, refreshResolvedExtensions, setUpdate, startUpdate,
  checkError = () => '', platform = process.platform, newKey = crypto.randomUUID,
  schedule = (fn) => setTimeout(fn, 0), localTarget = imports.localTarget,
  discoverDesktop = imports.discoverDesktop, localExtensions = imports.installedExtensions,
  validateBatch = imports.validateBatch, readVsix = imports.readVsix, applyImportBatch = imports.applyImportBatch }) {
  const extensionCandidates = new Map();
  // Staging runs before the update transaction, so its errors reach the dialog, and packing a
  // large folder takes a while. Nothing else may start an import in that gap.
  let staging = false;

  function extensionSpecs(target = localTarget()) {
    const records = extensionImports.records(target);
    const locked = new Set(records.map((record) => record.id));
    const configured = config.resolvedExtensions.filter((id) => !locked.has(id.toLowerCase()) && id.toLowerCase() !== 'openai.chatgpt');
    return [...configured, ...records.filter((record) => !isAgentExtension(record.id) || agentExtensions(config.agents).some((id) => id.toLowerCase() === record.id)).map((record) => extensionImports.package(record)), ...helperExtensions()];
  }

  function rememberCandidate(item) {
    const key = newKey();
    extensionCandidates.set(key, item);
    return { key, id: item.id, name: item.name, version: item.version, targetPlatform: item.targetPlatform, source: item.kind === 'vsix' ? t('VSIX file') : t('VS Code'), location: item.location };
  }

  function extensionState(target = localTarget()) {
    if (extensionCandidates.size > 2000) extensionCandidates.clear();
    const records = extensionImports.records(target);
    const installed = target === localTarget() ? localExtensions(config.resolvedExtensionsDir) : [];
    const desktop = discoverDesktop();
    const newerImports = extensionImports.localUpdates(target);
    const sources = [...desktop.filter((item) => !item.error), ...newerImports.map((item) => item.candidate)];
    const candidates = [...new Map(sources.map((item) => [`${item.location}:${item.version}`, item])).values()].map(rememberCandidate);
    const allIds = new Set([...config.resolvedExtensions.filter((id) => !id.endsWith('.vsix')).map((id) => id.toLowerCase()), ...records.map((record) => record.id)]);
    const rows = [...allIds].map((id) => {
      const record = records.find((item) => item.id === id);
      const current = installed.find((item) => item.id === id);
      const source = record?.source.kind === 'vscode' ? t('VS Code') : record ? t('VSIX file') : id === 'openai.chatgpt' ? (current ? t('Existing install / import updates') : t('Import required')) : t('Worktabs / Open VSX');
      const newer = newerImports.find((item) => item.id === id);
      return { id, name: record?.name || current?.name || id, version: record?.version || current?.version || '', prepared: target !== localTarget(), source, newer: newer?.to || '', previous: Boolean(record?.previous), imported: Boolean(record), location: record?.source.location || '' };
    });
    const codeServerVersion = config.codeServerDir ? t('Custom (VS Code {version})', { version: vscodeVersion() }) : config.codeServerVersion;
    return { target, targets: [localTarget(), ...(platform === 'win32' ? ['linux-x64', 'linux-arm64'] : [])], rows, candidates, errors: [...desktop.filter((item) => item.error).map((item) => item.error), ...(checkError() ? [checkError()] : [])], update: updateCoordinator.state, codeServerVersion };
  }

  async function queueExtensionImports(keys, target = localTarget(), followUp = []) {
    const servers = getServers();
    if (!servers || staging || updateCoordinator.busy || ['preparing', 'waiting', 'applying'].includes(updateCoordinator.state.status)) throw new Error(t('Another update is in progress.'));
    if (!Array.isArray(keys) || keys.length > 100) throw new Error(t('Invalid extension selection.'));
    const candidates = keys.map((key) => {
      const item = extensionCandidates.get(key);
      if (!item) throw new Error(t('Refresh the extension list before importing.'));
      return item;
    });
    const installed = target === localTarget() ? localExtensions(config.resolvedExtensionsDir) : extensionImports.records(target).map((record) => ({ id: record.id }));
    const vscode = vscodeVersion();
    validateBatch(candidates, { target, vscode, installed, protectedIds: ['worktabs.worktabs-helper'] });
    const records = [];
    const previous = [];
    staging = true;
    try {
      for (const item of candidates) records.push(await extensionImports.stage(item, target));
      for (const item of candidates) {
        const recorded = extensionImports.records(target).find((entry) => entry.id === item.id);
        if (recorded) { extensionImports.package(recorded); previous.push(recorded); continue; }
        const old = installed.find((entry) => entry.id === item.id);
        if (target === localTarget() && old) previous.push(await extensionImports.stage(old, target));
      }
    } finally {
      staging = false;
    }
    const items = records.map((record) => ({ kind: 'import', id: record.id, name: record.name, from: installed.find((item) => item.id === record.id)?.version || '', to: record.version, target }));
    const run = updateCoordinator.begin(items, t('Preparing extension imports'));
    schedule(() => applyExtensionImports(run, records, previous, items, target, followUp));
    return { queued: true };
  }

  async function applyExtensionImports(run, records, previous, items, target, followUp) {
    const servers = getServers();
    const succeeded = await updateCoordinator.execute(run, {
      applying: t('Installing the imported extensions'),
      // applyImportBatch has put the previous versions back, unless that failed too (the cause).
      failure: (error) => error.cause ? error.message : t('{error}. The previous versions stay.', { error: error.message }),
      apply: async () => {
        if (target === localTarget()) {
          await applyImportBatch({ records, previous,
            install: (record) => servers.installExtension(extensionImports.package(record)),
            uninstall: (id) => servers.uninstallExtension(id),
            probe: () => probeInstance(records.map((record) => record.id)),
            commit: () => extensionImports.commit(target, records, previous),
          });
        } else {
          // Linux snapshots are applied before the distribution opens its first tab.
          extensionImports.commit(target, records, previous);
        }
        refreshResolvedExtensions();
        return { status: 'done', detail: target === localTarget() ? '' : t('Linux imports apply when the matching WSL tabs next start.') };
      },
    });
    if (succeeded && followUp.length) {
      setUpdate({ status: 'available', items: followUp });
      await startUpdate();
    }
  }

  async function rollbackExtension(id, target) {
    const previous = extensionImports.records(target).find((record) => record.id === id)?.previous;
    if (!previous) throw new Error(t('No previous version is available.'));
    /** @type {ReturnType<typeof readVsix> & { snapshotSource?: object }} */
    const candidate = readVsix(extensionImports.package(previous));
    candidate.snapshotSource = previous.source;
    const key = rememberCandidate(candidate).key;
    return queueExtensionImports([key], target);
  }

  return { extensionSpecs, rememberCandidate, extensionState, queueExtensionImports, rollbackExtension };
}

module.exports = { createExtensionManagement };
