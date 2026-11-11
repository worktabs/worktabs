const assert = require('node:assert/strict');
const test = require('node:test');
const { createExtensionManagement } = require('../src/code-server/extension-management');
const { UpdateCoordinator } = require('../src/code-server/update-coordinator');

const candidate = (version = '2.0.0') => ({ id: 'openai.chatgpt', name: 'Codex', version,
  kind: 'vscode', location: 'desktop/codex', targetPlatform: 'win32-x64', engine: '^1.100.0',
  dependencies: [], manifest: { publisher: 'openai', name: 'chatgpt', version } });

function setup(overrides = {}) {
  const calls = [];
  const scheduled = [];
  const records = [];
  // Whether the update coordinator was busy at each prune.
  const prunes = [];
  const config = { agents: ['claude', 'codex'], resolvedExtensions: ['Anthropic.claude-code', 'OpenAI.chatgpt'],
    resolvedExtensionsDir: 'extensions', codeServerVersion: '4.141.0' };
  const importer = {
    records: () => records, localUpdates: () => [],
    stage: (item, target) => { calls.push(['stage', item.version, target]); return { ...item, file: `snapshot/${item.version}.vsix`, source: { kind: item.kind, location: item.location } }; },
    package: (record) => record.file,
    commit: (target, next, previous) => calls.push(['commit', target, next, previous]),
    prune: () => { prunes.push(coordinator.busy); return ['snapshot/old']; },
  };
  const coordinator = new UpdateCoordinator({
    tabs: () => new Map(), changed: () => {}, busyError: () => 'busy', startingError: () => 'starting',
    risks: async () => ({ busy: [] }), sleep: async () => {}, log: (text) => calls.push(['log', text]),
    resumeDetail: () => '',
  });
  const servers = {
    installExtension: async (file) => calls.push(['install', file]),
    uninstallExtension: async (id) => calls.push(['uninstall', id]),
  };
  let nextKey = 0;
  const service = createExtensionManagement({
    config, extensionImports: importer, updateCoordinator: coordinator, getServers: () => servers,
    localTarget: () => 'win32-x64', platform: 'win32', newKey: () => `key-${++nextKey}`,
    helperExtensions: () => ['helper.vsix'], vscodeVersion: () => '1.140.0',
    discoverDesktop: () => [], localExtensions: () => [],
    probeInstance: async (ids) => calls.push(['probe', ids]),
    refreshResolvedExtensions: () => calls.push(['refresh']),
    setUpdate: (state) => { calls.push(['report', state]); coordinator.report(state); },
    startUpdate: async () => calls.push(['follow-up']), schedule: (fn) => scheduled.push(fn),
    ...overrides,
  });
  return { service, calls, scheduled, records, importer, coordinator, config, servers, prunes };
}

test('candidate keys and invalid selections cannot begin an import transaction', async () => {
  const { service, coordinator, scheduled, calls } = setup();
  for (const keys of [null, Array(101).fill('key')]) await assert.rejects(service.queueExtensionImports(keys), /Invalid extension selection/);
  await assert.rejects(service.queueExtensionImports(['expired']), /Refresh the extension list/);
  await assert.rejects(service.queueExtensionImports([]), /Select at least one/);
  for (let i = 0; i < 2001; i++) service.rememberCandidate(candidate());
  service.extensionState();
  await assert.rejects(service.queueExtensionImports(['key-1']), /Refresh the extension list/);
  assert.equal(coordinator.busy, false);
  assert.equal(scheduled.length, 0);
  assert.deepEqual(calls, []);
});

test('busy ownership and compatibility failures leave snapshots and installation alone', async () => {
  const { service, coordinator, calls } = setup();
  const { key } = service.rememberCandidate({ ...candidate(), targetPlatform: 'linux-x64' });
  await assert.rejects(service.queueExtensionImports([key]), /targets linux-x64/);
  coordinator.begin([], 'busy');
  await assert.rejects(service.queueExtensionImports([key]), /Another update is in progress/);
  assert.deepEqual(calls, []);
});

test('a staging size failure occurs before update ownership and leaves the existing installation usable', async () => {
  const { service, importer, coordinator, scheduled, calls } = setup({ localExtensions: () => [candidate('1.0.0')] });
  importer.stage = () => { throw new Error('The extension is too large.'); };
  const { key } = service.rememberCandidate(candidate());
  await assert.rejects(service.queueExtensionImports([key]), /The extension is too large/);
  assert.equal(coordinator.busy, false);
  assert.equal(coordinator.state.status, 'none');
  assert.equal(scheduled.length, 0);
  assert.deepEqual(calls, []);
});

test('a second import cannot start while a large folder is still being packed', async () => {
  const { service, importer, scheduled } = setup();
  const stage = importer.stage;
  let finish;
  importer.stage = (item, target) => new Promise((resolve) => { finish = () => resolve(stage(item, target)); });
  const first = service.queueExtensionImports([service.rememberCandidate(candidate()).key]);
  await assert.rejects(service.queueExtensionImports([service.rememberCandidate(candidate()).key]), /Another update is in progress/);
  finish();
  assert.deepEqual(await first, { queued: true });
  assert.equal(scheduled.length, 1);
});

test('a failed packing releases the import for the next attempt', async () => {
  const { service, importer, coordinator } = setup();
  const stage = importer.stage;
  importer.stage = async () => { throw new Error('The extension archive is too large.'); };
  await assert.rejects(service.queueExtensionImports([service.rememberCandidate(candidate()).key]), /too large/);
  importer.stage = stage;
  assert.deepEqual(await service.queueExtensionImports([service.rememberCandidate(candidate()).key]), { queued: true });
  assert.equal(coordinator.busy, true);
});

test('local imports stage the existing install, probe before committing, then run gallery follow-up', async () => {
  const { service, calls, scheduled, coordinator } = setup({ localExtensions: () => [candidate('1.0.0')] });
  const { key } = service.rememberCandidate(candidate());
  const gallery = [{ kind: 'extension', id: 'anthropic.claude-code', from: '1', to: '2' }];
  assert.deepEqual(await service.queueExtensionImports([key], 'win32-x64', gallery), { queued: true });
  assert.equal(coordinator.busy, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['stage', 'stage']);
  await scheduled.shift()();
  assert.deepEqual(calls.map(([kind]) => kind), ['stage', 'stage', 'install', 'probe', 'commit', 'refresh', 'report', 'follow-up']);
  const committed = calls.find(([kind]) => kind === 'commit');
  assert.equal(committed[3][0].version, '1.0.0');
  assert.equal(coordinator.busy, false);
  assert.deepEqual(coordinator.state.items, gallery);
});

test('a failed local probe restores the previous snapshot and never starts a gallery follow-up', async () => {
  const { service, records, calls, scheduled, coordinator } = setup({
    probeInstance: async () => { throw new Error('probe failed'); },
  });
  records.push({ ...candidate('1.0.0'), file: 'snapshot/old.vsix', source: { kind: 'vscode' } });
  const { key } = service.rememberCandidate(candidate());
  await service.queueExtensionImports([key], 'win32-x64', [{ kind: 'extension' }]);
  await scheduled.shift()();
  assert.deepEqual(calls.filter(([kind]) => kind === 'install'), [['install', 'snapshot/2.0.0.vsix'], ['install', 'snapshot/old.vsix']]);
  assert.equal(coordinator.state.status, 'failed');
  assert.equal(coordinator.state.detail, 'probe failed. The previous versions stay.');
  assert.equal(calls.some(([kind]) => ['commit', 'refresh', 'follow-up'].includes(kind)), false);
});

test('unused snapshots are pruned once a batch ends or its staging fails, never during a batch', async () => {
  for (const probeInstance of [async () => {}, async () => { throw new Error('probe failed'); }]) {
    const lines = [];
    const { service, scheduled, prunes } = setup({ probeInstance, log: (line) => lines.push(line) });
    await service.queueExtensionImports([service.rememberCandidate(candidate()).key]);
    service.pruneSnapshots();
    assert.deepEqual(prunes, []);
    await scheduled.shift()();
    assert.deepEqual(prunes, [false]);
    assert.deepEqual(lines, ['removed 1 unused snapshot(s)']);
  }
  const { service, importer, prunes } = setup();
  importer.stage = async () => { throw new Error('The extension archive is too large.'); };
  await assert.rejects(service.queueExtensionImports([service.rememberCandidate(candidate()).key]), /too large/);
  assert.deepEqual(prunes, [false]);
});

test('a failed restoration after a failed probe does not claim that the previous versions stay', async () => {
  const { service, records, scheduled, coordinator, servers } = setup({
    probeInstance: async () => { throw new Error('probe failed'); },
  });
  servers.installExtension = async (file) => { if (file === 'snapshot/old.vsix') throw new Error('cannot reinstall'); };
  records.push({ ...candidate('1.0.0'), file: 'snapshot/old.vsix', source: { kind: 'vscode' } });
  await service.queueExtensionImports([service.rememberCandidate(candidate()).key]);
  await scheduled.shift()();
  assert.equal(coordinator.state.status, 'failed');
  assert.match(coordinator.state.detail, /^probe failed\. Restoration failed: cannot reinstall$/);
});

test('Linux imports commit prepared snapshots without installing or probing the local server', async () => {
  const { service, calls, scheduled, coordinator } = setup();
  const { key } = service.rememberCandidate({ ...candidate(), targetPlatform: 'linux-x64' });
  await service.queueExtensionImports([key], 'linux-x64');
  await scheduled.shift()();
  assert.deepEqual(calls.map(([kind]) => kind), ['stage', 'commit', 'refresh']);
  assert.equal(coordinator.state.status, 'done');
  assert.match(coordinator.state.detail, /matching WSL tabs/);
});

test('rollback preserves snapshot source and takes the same staging and update path', async () => {
  const old = { ...candidate('1.0.0'), file: 'snapshot/old.vsix', source: { kind: 'vscode', root: 'desktop' } };
  const { service, records, importer, scheduled } = setup({ readVsix: () => ({ ...candidate('1.0.0'), kind: 'vsix' }) });
  records.push({ ...candidate(), file: 'snapshot/new.vsix', source: { kind: 'vscode' }, previous: old });
  let staged;
  const stage = importer.stage;
  importer.stage = (item, target) => { staged = item; return stage(item, target); };
  assert.deepEqual(await service.rollbackExtension('openai.chatgpt', 'win32-x64'), { queued: true });
  assert.deepEqual(staged.snapshotSource, old.source);
  assert.equal(scheduled.length, 1);
  await assert.rejects(service.rollbackExtension('missing', 'win32-x64'), /No previous version/);
});

test('extension specs retain imported sources, enabled agents, and the helper without a Codex gallery fallback', () => {
  const { service, records, config } = setup();
  records.push({ ...candidate(), file: 'snapshot/codex.vsix', source: { kind: 'vscode' } });
  assert.deepEqual(service.extensionSpecs(), ['Anthropic.claude-code', 'snapshot/codex.vsix', 'helper.vsix']);
  config.agents = ['claude'];
  assert.deepEqual(service.extensionSpecs(), ['Anthropic.claude-code', 'helper.vsix']);
});

test('extension state distinguishes active local installs, prepared snapshots, and source read errors', () => {
  const { service, records } = setup({
    localExtensions: () => [candidate('1.0.0')],
    discoverDesktop: () => [candidate(), candidate(), { error: 'source unavailable' }],
    checkError: () => 'update check failed',
  });
  const local = service.extensionState();
  assert.equal(local.candidates.length, 1);
  assert.equal(local.rows.find((item) => item.id === 'openai.chatgpt').source, 'Existing install / import updates');
  assert.deepEqual(local.errors, ['source unavailable', 'update check failed']);
  records.push({ ...candidate(), file: 'snapshot/codex.vsix', source: { kind: 'vscode' } });
  const linux = service.extensionState('linux-x64');
  assert.equal(linux.rows.find((item) => item.id === 'openai.chatgpt').prepared, true);
  assert.deepEqual(linux.targets, ['win32-x64', 'linux-x64', 'linux-arm64']);
});

// ---- Open VSX releases as snapshots (#54)

const release = (id, version, bundled = []) => ({ kind: 'openvsx', id, name: id, version, targetPlatform: 'win32-x64',
  download: `https://cdn.example/${id}-${version}.vsix`, sha256: `https://cdn.example/${id}-${version}.sha256`, bundled, page: `https://open-vsx.org/extension/${id.replace('.', '/')}` });

function fakeOpenVsx({ latest = {}, versions = {}, fail = null } = {}) {
  const asked = [];
  return {
    asked,
    latestRelease: async (id) => { asked.push(['latest', id]); if (fail === id) throw new Error(`${id}: HTTP 503`); return latest[id] || null; },
    releaseOf: async (id, version) => { asked.push(['of', id, version]); return versions[`${id}@${version}`] || null; },
    download: async (item, _file, { onProgress }) => {
      asked.push(['download', item.id, item.version]);
      if (fail === `download ${item.id}`) throw new Error('connection reset');
      onProgress(100, 381);
    },
  };
}

// A store whose stage downloads Open VSX releases through the given download, as the real one does.
function openVsxSetup(options = {}) {
  const lines = [];
  let clock = 0;
  const context = setup({
    validateBatch: () => {}, readVsix: (file) => ({ id: file }), now: () => (clock += 5000), log: (line) => lines.push(line), ...options,
  });
  context.importer.stage = async (item, _target, { download } = {}) => {
    if (item.kind === 'openvsx') await download(item, `snapshot/${item.id}-${item.version}.vsix`);
    context.calls.push(['stage', item.id, item.version]);
    return { id: item.id, name: item.name, version: item.version, file: `snapshot/${item.id}-${item.version}.vsix`,
      source: item.snapshotSource || { kind: item.kind }, ...(item.bundled?.length ? { bundled: item.bundled } : {}) };
  };
  const details = [];
  const report = context.coordinator.report.bind(context.coordinator);
  context.coordinator.report = (state) => { if (state.detail) details.push(state.detail); report(state); };
  return { ...context, details, lines };
}

test('Open VSX releases come with their pack members at the same version, download in the preparation, and keep an import as the previous version', async () => {
  const openVsx = fakeOpenVsx({
    latest: { 'openai.chatgpt': release('openai.chatgpt', '26.1106.51428', ['openai.codex-audio']) },
    versions: { 'openai.codex-audio@26.1106.51428': release('openai.codex-audio', '26.1106.51428') },
  });
  const { service, calls, scheduled, records, coordinator, details, prunes } = openVsxSetup({ openVsx });
  const imported = { id: 'openai.chatgpt', name: 'Codex', version: '26.1021.22027', file: 'snapshot/imported.vsix', source: { kind: 'vscode' } };
  records.push(imported);
  assert.deepEqual(await service.useOpenVsx('OpenAI.chatgpt'), { queued: true });
  // Looked up before the update began, so that a missing release reaches the dialog.
  assert.deepEqual(coordinator.state.items.map((item) => `${item.id} ${item.to}`), ['openai.codex-audio 26.1106.51428', 'openai.chatgpt 26.1106.51428']);
  assert.equal(calls.length, 0);
  await scheduled.shift()();
  assert.deepEqual(openVsx.asked, [
    ['latest', 'openai.chatgpt'], ['of', 'openai.codex-audio', '26.1106.51428'],
    ['download', 'openai.codex-audio', '26.1106.51428'], ['download', 'openai.chatgpt', '26.1106.51428'],
  ]);
  assert.ok(details.includes('Downloading openai.chatgpt 26.1106.51428 from Open VSX… 100 / 381 MB'));
  assert.deepEqual(calls.filter(([kind]) => kind === 'install').map(([, file]) => file), ['snapshot/openai.codex-audio-26.1106.51428.vsix', 'snapshot/openai.chatgpt-26.1106.51428.vsix']);
  const [, target, next, previous] = calls.find(([kind]) => kind === 'commit');
  assert.equal(target, 'win32-x64');
  assert.deepEqual(next.map((record) => [record.id, record.source.kind, record.bundled]), [['openai.codex-audio', 'openvsx', undefined], ['openai.chatgpt', 'openvsx', ['openai.codex-audio']]]);
  assert.deepEqual(previous, [imported]);
  assert.equal(coordinator.state.status, 'done');
  assert.deepEqual(prunes, [false]);
});

test('a pack member missing at the pack version comes at its newest release, and one missing altogether stops before the update', async () => {
  const pack = release('acme.pack', '2.0.0', ['acme.member']);
  const later = openVsxSetup({ openVsx: fakeOpenVsx({ latest: { 'acme.pack': pack, 'acme.member': release('acme.member', '1.5.0') } }) });
  await later.service.useOpenVsx(['acme.pack']);
  assert.deepEqual(later.coordinator.state.items.map((item) => `${item.id} ${item.to}`), ['acme.member 1.5.0', 'acme.pack 2.0.0']);
  for (const latest of [{ 'acme.pack': pack }, {}]) {
    const { service, coordinator, scheduled } = openVsxSetup({ openVsx: fakeOpenVsx({ latest }) });
    await assert.rejects(service.useOpenVsx(['acme.pack']), /Open VSX has no release of acme\.(member, which acme\.pack includes|pack for win32-x64)/);
    assert.equal(coordinator.busy, false);
    assert.equal(scheduled.length, 0);
  }
  const { service } = openVsxSetup({ openVsx: fakeOpenVsx() });
  for (const ids of [[], ['../evil'], 'not an id', Array(21).fill('acme.pack')]) await assert.rejects(service.useOpenVsx(ids), /Invalid extension selection/);
  await assert.rejects(service.useOpenVsx(['acme.pack'], 'plan9-x64'), /Unsupported extension target/);
  await assert.rejects(setup().service.useOpenVsx(['acme.pack']), /not available/);
});

test('a download that fails in the preparation changes nothing and leaves no snapshot behind', async () => {
  const openVsx = fakeOpenVsx({ latest: { 'openai.chatgpt': release('openai.chatgpt', '26.1106.51428') }, fail: 'download openai.chatgpt' });
  const { service, calls, scheduled, coordinator, prunes } = openVsxSetup({ openVsx });
  await service.useOpenVsx(['openai.chatgpt']);
  await scheduled.shift()();
  assert.equal(coordinator.state.status, 'failed');
  assert.equal(coordinator.state.detail, 'connection reset. The previous versions stay.');
  assert.equal(calls.some(([kind]) => ['install', 'commit'].includes(kind)), false);
  assert.deepEqual(prunes, [false]);
});

test('updates are looked up on Open VSX for the records taken from there, without their pack members', async () => {
  const openVsx = fakeOpenVsx({ latest: { 'openai.chatgpt': release('openai.chatgpt', '26.1106.51428'), 'acme.same': release('acme.same', '1.0.0') }, fail: 'acme.down' });
  const { service, records } = openVsxSetup({ openVsx });
  records.push(
    { id: 'openai.chatgpt', name: 'Codex', version: '26.1021.22027', source: { kind: 'openvsx' }, bundled: ['openai.codex-audio'] },
    { id: 'openai.codex-audio', name: 'Codex Audio', version: '26.1021.22027', source: { kind: 'openvsx' } },
    { id: 'acme.same', name: 'Same', version: '1.0.0', source: { kind: 'openvsx' } },
    { id: 'acme.down', name: 'Down', version: '1.0.0', source: { kind: 'openvsx' } },
    { id: 'acme.desktop', name: 'Desktop', version: '1.0.0', source: { kind: 'vscode' } },
  );
  const { updates, errors } = await service.openVsxUpdates();
  assert.deepEqual(updates, [{ kind: 'openvsx', id: 'openai.chatgpt', name: 'Codex', from: '26.1021.22027', to: '26.1106.51428', target: 'win32-x64' }]);
  assert.deepEqual(errors, ['acme.down: HTTP 503']);
  assert.deepEqual(openVsx.asked.map(([, id]) => id), ['openai.chatgpt', 'acme.same', 'acme.down']);
  assert.deepEqual(await setup().service.openVsxUpdates(), { updates: [], errors: [] });
});

test('restoring the previous version brings back the pack members too, with their recorded sources', async () => {
  const { service, records, scheduled, calls } = openVsxSetup({
    openVsx: fakeOpenVsx(),
    readVsix: (file) => ({ ...candidate(file.includes('audio') ? '1.0.0' : '2.0.0'), id: file.includes('audio') ? 'openai.codex-audio' : 'openai.chatgpt', kind: 'vsix', location: file }),
  });
  records.push(
    { id: 'openai.chatgpt', version: '3.0.0', file: 'snapshot/codex-3.vsix', source: { kind: 'openvsx' }, bundled: ['openai.codex-audio'],
      previous: { id: 'openai.chatgpt', version: '2.0.0', file: 'snapshot/codex-2.vsix', source: { kind: 'vscode', location: 'desktop' } } },
    { id: 'openai.codex-audio', version: '3.0.0', file: 'snapshot/audio-3.vsix', source: { kind: 'openvsx' },
      previous: { id: 'openai.codex-audio', version: '1.0.0', file: 'snapshot/audio-1.vsix', source: { kind: 'openvsx' } } },
  );
  assert.deepEqual(await service.rollbackExtension('openai.chatgpt', 'win32-x64'), { queued: true });
  await scheduled.shift()();
  const [, , next] = calls.find(([kind]) => kind === 'commit');
  assert.deepEqual(next.map((record) => [record.id, record.version, record.source.kind]), [['openai.codex-audio', '1.0.0', 'openvsx'], ['openai.chatgpt', '2.0.0', 'vscode']]);
});

test('the extension table offers Open VSX for imports and for Codex, and names the Open VSX source', () => {
  const { service, records } = setup({ openVsx: fakeOpenVsx() });
  const rows = () => Object.fromEntries(service.extensionState().rows.map((row) => [row.id, [row.source, row.openVsx]]));
  // Not there yet: taken from Open VSX while Codex is enabled (#50), or at once with the action.
  assert.deepEqual(rows(), { 'anthropic.claude-code': ['Worktabs / Open VSX', false], 'openai.chatgpt': ['Open VSX', true] });
  records.push({ id: 'openai.chatgpt', name: 'Codex', version: '1', source: { kind: 'openvsx', location: 'https://open-vsx.org/extension/openai/chatgpt' } },
    { id: 'acme.tool', name: 'Tool', version: '1', source: { kind: 'vscode' } });
  assert.deepEqual(rows(), { 'anthropic.claude-code': ['Worktabs / Open VSX', false], 'openai.chatgpt': ['Open VSX', false], 'acme.tool': ['VS Code', true] });
  // Update checks cover this computer only, so a Linux snapshot from Open VSX keeps the action.
  assert.equal(service.extensionState('linux-x64').rows.find((row) => row.id === 'openai.chatgpt').openVsx, true);
  assert.equal(setup().service.extensionState().rows.some((row) => row.openVsx), false);
});

test('a pack member follows its pack: it has no actions of its own, and neither restoring nor taking it alone is allowed', async () => {
  const { service, records } = setup({ openVsx: fakeOpenVsx() });
  records.push(
    { id: 'openai.chatgpt', name: 'Codex', version: '2', source: { kind: 'openvsx' }, bundled: ['openai.codex-audio'], previous: { id: 'openai.chatgpt', version: '1', source: { kind: 'openvsx' } } },
    { id: 'openai.codex-audio', name: 'Codex Audio', version: '2', source: { kind: 'openvsx' }, previous: { id: 'openai.codex-audio', version: '1', source: { kind: 'openvsx' } } },
  );
  for (const target of ['win32-x64', 'linux-x64']) {
    const audio = service.extensionState(target).rows.find((row) => row.id === 'openai.codex-audio');
    assert.deepEqual([audio.previous, audio.openVsx], [false, false]);
  }
  await assert.rejects(service.rollbackExtension('openai.codex-audio', 'win32-x64'), /Codex Audio comes with Codex\. Restore Codex instead/);
  await assert.rejects(service.useOpenVsx(['openai.codex-audio']), /comes with Codex\. Take Codex from Open VSX instead/);
});

// ---- Codex from Open VSX by default (#50)

// A store whose commits become records, so that ensureCodex sees what it took.
function codexSetup(options = {}) {
  const codex = release('openai.chatgpt', '26.1106.51428', ['openai.codex-audio']);
  const openVsx = fakeOpenVsx({ latest: { 'openai.chatgpt': codex }, versions: { 'openai.codex-audio@26.1106.51428': release('openai.codex-audio', '26.1106.51428') }, ...options.openVsx });
  const context = openVsxSetup({ openVsx, sleep: async () => {}, ...options.setup });
  context.importer.commit = (target, next, previous) => {
    context.calls.push(['commit', target, next, previous]);
    for (const record of next) {
      const at = context.records.findIndex((entry) => entry.id === record.id);
      if (at >= 0) context.records.splice(at, 1);
      context.records.push({ ...record, target });
    }
  };
  return { ...context, openVsx };
}

// Runs the batch the service scheduled, once it has.
async function runScheduled(scheduled) {
  for (let i = 0; i < 50 && !scheduled.length; i++) await new Promise((resolve) => setImmediate(resolve));
  await scheduled.shift()();
}

test('Codex is taken from Open VSX only when it is enabled and the target has none, and callers share one take', async () => {
  const { service, scheduled, calls, openVsx, config, records } = codexSetup();
  config.agents = ['claude'];
  await service.ensureCodex();
  assert.equal(openVsx.asked.length, 0);
  config.agents = ['claude', 'codex'];
  const first = service.ensureCodex();
  const second = service.ensureCodex();
  await runScheduled(scheduled);
  await Promise.all([first, second]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'commit').map(([, target, next]) => [target, next.map((record) => record.id)]), [['win32-x64', ['openai.codex-audio', 'openai.chatgpt']]]);
  assert.equal(scheduled.length, 0);
  assert.equal(service.hasCodex('win32-x64'), true);
  await service.ensureCodex();
  assert.equal(openVsx.asked.filter(([kind]) => kind === 'latest').length, 1);
  // An imported Codex keeps its source; one installed before snapshots keeps running as it is.
  records.splice(0);
  records.push({ id: 'openai.chatgpt', version: '1', source: { kind: 'vscode' } });
  await service.ensureCodex();
  const legacy = codexSetup({ setup: { localExtensions: () => [{ id: 'openai.chatgpt', version: '1' }] } });
  await legacy.service.ensureCodex();
  assert.equal(legacy.openVsx.asked.length, 0);
});

test('a failed take says why, a later call tries again, and updates on offer stay on offer after a take', async () => {
  const failing = codexSetup({ openVsx: { fail: 'download openai.chatgpt' } });
  const attempt = failing.service.ensureCodex();
  await runScheduled(failing.scheduled);
  await assert.rejects(attempt, /connection reset\. The previous versions stay\./);
  const retry = failing.service.ensureCodex();
  await runScheduled(failing.scheduled);
  await assert.rejects(retry, /connection reset/);
  assert.equal(failing.openVsx.asked.filter(([kind]) => kind === 'latest').length, 2);

  const { service, scheduled, coordinator } = codexSetup();
  const offered = [{ kind: 'extension', id: 'anthropic.claude-code', from: '1', to: '2' }];
  coordinator.report({ status: 'available', items: offered });
  const take = service.ensureCodex();
  await runScheduled(scheduled);
  await take;
  assert.deepEqual(coordinator.state, { status: 'available', items: offered });
});

test('Codex for a WSL target is prepared without waiting for the tabs here, and another update is waited for', async () => {
  let reads = 0;
  const { service, scheduled, calls, coordinator } = codexSetup();
  coordinator.deps.risks = async () => { if (++reads > 20) throw new Error('waited for the tabs'); return { busy: ['busy tab'] }; };
  const take = service.ensureCodex('linux-x64');
  await runScheduled(scheduled);
  await take;
  assert.equal(reads, 0);
  assert.equal(calls.some(([kind]) => ['install', 'probe'].includes(kind)), false);
  assert.deepEqual(calls.filter(([kind]) => kind === 'commit').map(([, target]) => target), ['linux-x64']);

  const waiting = codexSetup({ setup: { sleep: () => new Promise((resolve) => setImmediate(resolve)) } });
  waiting.coordinator.report({ status: 'applying', items: [] });
  const later = waiting.service.ensureCodex();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waiting.openVsx.asked.length, 0);
  waiting.coordinator.report({ status: 'done', items: [] });
  await runScheduled(waiting.scheduled);
  await later;
  assert.equal(waiting.service.hasCodex('win32-x64'), true);
});

test('a WSL start does not wait for Codex while another update runs, which may wait for that start', async () => {
  const { service, scheduled, coordinator, openVsx } = codexSetup({ setup: { sleep: () => new Promise((resolve) => setImmediate(resolve)) } });
  coordinator.report({ status: 'applying', items: [] });
  // Resolves at once; the take runs after the other update.
  await service.ensureCodex('linux-x64', { whenIdle: true });
  assert.equal(service.hasCodex('linux-x64'), false);
  assert.equal(openVsx.asked.length, 0);
  coordinator.report({ status: 'done', items: [] });
  await runScheduled(scheduled);
  for (let i = 0; i < 5 && !service.hasCodex('linux-x64'); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.hasCodex('linux-x64'), true);
  // When nothing else runs, the start waits for the take, which does not wait for tabs.
  const idle = codexSetup();
  const take = idle.service.ensureCodex('linux-arm64', { whenIdle: true });
  await runScheduled(idle.scheduled);
  await take;
  assert.equal(idle.service.hasCodex('linux-arm64'), true);
});
