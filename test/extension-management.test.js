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
  const config = { agents: ['claude', 'codex'], resolvedExtensions: ['Anthropic.claude-code', 'OpenAI.chatgpt'],
    resolvedExtensionsDir: 'extensions', codeServerVersion: '4.141.0' };
  const importer = {
    records: () => records, localUpdates: () => [],
    stage: (item, target) => { calls.push(['stage', item.version, target]); return { ...item, file: `snapshot/${item.version}.vsix`, source: { kind: item.kind, location: item.location } }; },
    package: (record) => record.file,
    commit: (target, next, previous) => calls.push(['commit', target, next, previous]),
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
  return { service, calls, scheduled, records, importer, coordinator, config, servers };
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
