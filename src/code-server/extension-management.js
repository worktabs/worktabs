// Selection, staging, and update ownership are independent of native dialogs and Electron.
const crypto = require('crypto');
const semver = require('semver');
const { t } = require('../i18n');
const { agentExtensions, isAgentExtension } = require('../agents/agents');
const imports = require('./extension-imports');

const PROTECTED_IDS = ['worktabs.worktabs-helper'];
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;

/**
 * @param {{ openVsx?: ReturnType<typeof import('./open-vsx').createOpenVsx> | null, now?: () => number,
 *   [key: string]: any }} options
 */
function createExtensionManagement({ config, extensionImports, updateCoordinator, getServers,
  helperExtensions, vscodeVersion, probeInstance, refreshResolvedExtensions, setUpdate, startUpdate,
  checkError = () => '', log = (_line) => {}, openVsx = null, platform = process.platform, newKey = crypto.randomUUID,
  schedule = (fn) => setTimeout(fn, 0), now = Date.now, localTarget = imports.localTarget,
  discoverDesktop = imports.discoverDesktop, localExtensions = imports.installedExtensions,
  validateBatch = imports.validateBatch, readVsix = imports.readVsix, applyImportBatch = imports.applyImportBatch }) {
  const extensionCandidates = new Map();
  // Staging runs before the update transaction, so its errors reach the dialog, and packing a
  // large folder takes a while. Nothing else may start an import in that gap.
  let staging = false;

  // Snapshots that no record keeps: those replaced twice, and those of a batch that failed. Only
  // while no batch stages or applies, as a staged snapshot has no record yet.
  function pruneSnapshots() {
    if (staging || updateCoordinator.busy) return;
    const removed = extensionImports.prune();
    if (removed.length) log(`removed ${removed.length} unused snapshot(s)`);
  }

  function assertIdle() {
    if (!getServers() || staging || updateCoordinator.busy || ['preparing', 'waiting', 'applying'].includes(updateCoordinator.state.status)) throw new Error(t('Another update is in progress.'));
  }

  // What a batch for `target` replaces: on this computer, the active extensions; for a Linux
  // target, the prepared snapshots.
  function installedFor(target) {
    return target === localTarget() ? localExtensions(config.resolvedExtensionsDir) : extensionImports.records(target).map((record) => ({ id: record.id, version: record.version }));
  }

  // The snapshots that `ids` replace: their records, or on this computer the installed versions
  // that no record keeps, staged now. A first install has none.
  async function stagePrevious(ids, installed, target) {
    const previous = [];
    for (const id of ids) {
      const recorded = extensionImports.records(target).find((entry) => entry.id === id);
      if (recorded) { extensionImports.package(recorded); previous.push(recorded); continue; }
      const old = installed.find((entry) => entry.id === id);
      if (target === localTarget() && old) previous.push(await extensionImports.stage(old, target));
    }
    return previous;
  }

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

  function sourceLabel(id, record, current) {
    if (record?.source.kind === 'openvsx') return t('Open VSX');
    if (record?.source.kind === 'vscode') return t('VS Code');
    if (record) return t('VSIX file');
    if (id === 'openai.chatgpt') return current ? t('Existing install / import updates') : t('Import required');
    return t('Worktabs / Open VSX');
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
      const newer = newerImports.find((item) => item.id === id);
      // Open VSX can replace an import, and gives Codex, which the gallery install leaves out.
      // The extensions Worktabs installs from the gallery are on Open VSX already.
      const openVsxAction = Boolean(openVsx) && (record ? record.source.kind !== 'openvsx' : id === 'openai.chatgpt');
      return { id, name: record?.name || current?.name || id, version: record?.version || current?.version || '', prepared: target !== localTarget(), source: sourceLabel(id, record, current), newer: newer?.to || '', previous: Boolean(record?.previous), imported: Boolean(record), openVsx: openVsxAction, location: record?.source.location || '' };
    });
    const codeServerVersion = config.codeServerDir ? t('Custom (VS Code {version})', { version: vscodeVersion() }) : config.codeServerVersion;
    return { target, targets: [localTarget(), ...(platform === 'win32' ? ['linux-x64', 'linux-arm64'] : [])], rows, candidates, errors: [...desktop.filter((item) => item.error).map((item) => item.error), ...(checkError() ? [checkError()] : [])], update: updateCoordinator.state, codeServerVersion };
  }

  async function queueExtensionImports(keys, target = localTarget(), followUp = []) {
    assertIdle();
    if (!Array.isArray(keys) || keys.length > 100) throw new Error(t('Invalid extension selection.'));
    const candidates = keys.map((key) => {
      const item = extensionCandidates.get(key);
      if (!item) throw new Error(t('Refresh the extension list before importing.'));
      return item;
    });
    const installed = installedFor(target);
    const vscode = vscodeVersion();
    validateBatch(candidates, { target, vscode, installed, protectedIds: PROTECTED_IDS });
    const records = [];
    let previous;
    staging = true;
    try {
      for (const item of candidates) records.push(await extensionImports.stage(item, target));
      previous = await stagePrevious(candidates.map((item) => item.id), installed, target);
    } catch (error) {
      // What was staged before the failure will never have a record.
      staging = false;
      pruneSnapshots();
      throw error;
    } finally {
      staging = false;
    }
    const items = records.map((record) => ({ kind: 'import', id: record.id, name: record.name, from: installed.find((item) => item.id === record.id)?.version || '', to: record.version, target }));
    const run = updateCoordinator.begin(items, t('Preparing extension imports'));
    schedule(() => applyExtensionImports(run, async () => ({ records, previous }), target, followUp));
    return { queued: true };
  }

  // The newest Open VSX releases of `ids` for `target`, each after the members of its extension
  // pack. A member comes at the pack's version when Open VSX has that release (Codex and Codex
  // Audio share their versions), else at its newest release, so that installing the pack does
  // not fetch a member of another version from the gallery.
  async function resolveReleases(ids, target, vscode) {
    const releases = [];
    const add = (item) => { if (!releases.some((entry) => entry.id === item.id)) releases.push(item); };
    for (const id of ids) {
      const main = await openVsx.latestRelease(id, target, vscode);
      if (!main) throw new Error(t('Open VSX has no release of {id} for {target} that runs on VS Code {version}.', { id, target, version: vscode }));
      for (const member of main.bundled) {
        if (releases.some((entry) => entry.id === member)) continue;
        const match = await openVsx.releaseOf(member, main.version, target) || await openVsx.latestRelease(member, target, vscode);
        if (!match) throw new Error(t('Open VSX has no release of {id}, which {name} includes.', { id: member, name: main.name }));
        add(match);
      }
      add(main);
    }
    return releases;
  }

  // Takes the newest releases of `ids` from Open VSX as snapshots, with the members of their
  // extension packs. A record they replace (an import) becomes the previous version. The releases
  // are looked up before the update begins, so that a missing one is told to the dialog; the
  // downloads run in the update's preparation, where the side bar shows them and tabs keep running.
  async function useOpenVsx(ids, target = localTarget(), followUp = []) {
    if (!openVsx) throw new Error(t('Downloading from Open VSX is not available.'));
    const list = typeof ids === 'string' ? [ids] : ids;
    if (!Array.isArray(list) || !list.length || list.length > 20 || list.some((id) => typeof id !== 'string' || !EXTENSION_ID.test(id))) throw new Error(t('Invalid extension selection.'));
    if (!imports.TARGETS.includes(target)) throw new Error(t('Unsupported extension target.'));
    assertIdle();
    const vscode = vscodeVersion();
    let releases;
    staging = true;
    try {
      releases = await resolveReleases(list.map((id) => id.toLowerCase()), target, vscode);
    } finally {
      staging = false;
    }
    const installed = installedFor(target);
    const items = releases.map((item) => ({ kind: 'import', id: item.id, name: item.name, from: installed.find((entry) => entry.id === item.id)?.version || '', to: item.version, target }));
    const run = updateCoordinator.begin(items, t('Preparing the download from Open VSX'));
    schedule(() => applyExtensionImports(run, (report) => stageReleases(releases, installed, target, vscode, report), target, followUp));
    return { queued: true };
  }

  // Downloads and stages `releases`, then checks them as an import batch is checked.
  async function stageReleases(releases, installed, target, vscode, report) {
    const records = [];
    for (const item of releases) {
      let shown = 0;
      const onProgress = (mb, totalMb) => {
        if (now() - shown < 1000) return;
        shown = now();
        const progress = `${mb.toFixed(0)}${totalMb ? ` / ${totalMb.toFixed(0)}` : ''} MB`;
        report({ status: 'preparing', detail: t('Downloading {name} {version} from Open VSX… {progress}', { name: item.name, version: item.version, progress }) });
      };
      report({ status: 'preparing', detail: t('Downloading {name} {version} from Open VSX…', { name: item.name, version: item.version }) });
      records.push(await extensionImports.stage(item, target, { download: (release, file) => openVsx.download(release, file, { onProgress }) }));
    }
    validateBatch(records.map((record) => readVsix(record.file)), { target, vscode, installed, protectedIds: PROTECTED_IDS });
    report({ status: 'preparing', detail: t('Keeping the current versions…') });
    const previous = await stagePrevious(records.map((record) => record.id), installed, target);
    return { records, previous };
  }

  // `prepare(report)` resolves the staged { records, previous }.
  async function applyExtensionImports(run, prepare, target, followUp) {
    const servers = getServers();
    const succeeded = await updateCoordinator.execute(run, {
      prepare,
      applying: t('Installing the imported extensions'),
      // applyImportBatch has put the previous versions back, unless that failed too (the cause).
      failure: (error) => error.cause ? error.message : t('{error}. The previous versions stay.', { error: error.message }),
      apply: async ({ records, previous }) => {
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
    // Done, failed, or cancelled: the snapshots replaced twice, or never committed, are not needed.
    pruneSnapshots();
    if (succeeded && followUp.length) {
      setUpdate({ status: 'available', items: followUp });
      await startUpdate();
    }
  }

  // Newer Open VSX releases of the extensions taken from there, as update items. The members of an
  // extension pack come with the pack, so they are not asked about on their own.
  async function openVsxUpdates(target = localTarget()) {
    const records = extensionImports.records(target).filter((record) => record.source?.kind === 'openvsx');
    if (!openVsx || !records.length) return { updates: [], errors: [] };
    const members = new Set(records.flatMap((record) => record.bundled || []));
    const vscode = vscodeVersion();
    const updates = [];
    const errors = [];
    for (const record of records) {
      if (members.has(record.id)) continue;
      try {
        const latest = await openVsx.latestRelease(record.id, target, vscode);
        if (latest && semver.valid(record.version) && semver.gt(latest.version, record.version)) {
          updates.push({ kind: 'openvsx', id: record.id, name: record.name, from: record.version, to: latest.version, target });
        }
      } catch (error) { errors.push(error.message); }
    }
    return { updates, errors };
  }

  // Puts back the previous snapshot of `id`, and of the members of its extension pack that have
  // one, keeping their recorded sources.
  async function rollbackExtension(id, target) {
    const records = extensionImports.records(target);
    const record = records.find((entry) => entry.id === id);
    if (!record?.previous) throw new Error(t('No previous version is available.'));
    const members = (record.bundled || []).filter((member) => records.find((entry) => entry.id === member)?.previous);
    const keys = [...members, id].map((each) => {
      const previous = records.find((entry) => entry.id === each).previous;
      /** @type {ReturnType<typeof readVsix> & { snapshotSource?: object, bundled?: string[] }} */
      const candidate = readVsix(extensionImports.package(previous));
      candidate.snapshotSource = previous.source;
      candidate.bundled = previous.bundled;
      return rememberCandidate(candidate).key;
    });
    return queueExtensionImports(keys, target);
  }

  return { extensionSpecs, rememberCandidate, extensionState, queueExtensionImports, useOpenVsx, openVsxUpdates, rollbackExtension, pruneSnapshots };
}

module.exports = { createExtensionManagement };
