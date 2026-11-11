const assert = require('node:assert/strict');
const test = require('node:test');
const { createAppUpdates, downloadProgress } = require('../src/code-server/app-updates');

const update = { kind: 'extension', id: 'a.b', from: '1.0.0', to: '1.1.0' };

function setup({ found = { updates: [], errors: [] }, local = [], tabs = [], codexActive = null, records = [], openVsx = null, codeServerDir = '/cs', target = 'local' } = {}) {
  const calls = [];
  const logged = [];
  const config = { agents: ['claude', 'codex'], codeServerVersion: '4.0.0', resolvedExtensions: [], resolvedExtensionsDir: '/ext' };
  const updates = createAppUpdates({
    config, saveConfig: () => {}, dataDir: '/data', tabs: new Map(tabs.map((tab) => [tab.id, tab])),
    servers: () => ({ codeServerDir }), wslServers: new Map(), openVsx,
    extensionImports: { localUpdates: () => [...local], records: () => records, prune: () => [],
      stage: async () => { throw new Error('offline'); } },
    pause: () => {}, start: () => {}, stopRisks: async (tab) => tab.risks || [],
    callHelper: async () => (codexActive === null ? false : { active: codexActive }),
    helperExtensions: () => [], refreshResolvedExtensions: () => {}, probe: async () => {},
    messageBox: (options) => calls.push(options), changed: () => {}, log: (line) => logged.push(line),
    find: async () => {
      if (found instanceof Error) throw found;
      return found;
    },
    localExtensions: () => [], target: () => target,
  });
  return { updates, calls, logged };
}

test('newer Open VSX releases of snapshots join the gallery updates, and are applied through the snapshot batch first', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const codeServerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktabs-cs-'));
  t.after(() => fs.rmSync(codeServerDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(codeServerDir, 'lib', 'vscode'), { recursive: true });
  fs.writeFileSync(path.join(codeServerDir, 'lib', 'vscode', 'package.json'), JSON.stringify({ version: '1.145.2' }));
  const latest = { kind: 'openvsx', id: 'openai.chatgpt', name: 'Codex', version: '26.1106.51428', targetPlatform: 'win32-x64', bundled: [] };
  const openVsx = { latestRelease: async () => latest, releaseOf: async () => null, download: async () => {} };
  const records = [{ id: 'openai.chatgpt', name: 'Codex', version: '26.1021.22027', source: { kind: 'openvsx' } }];
  const { updates, logged } = setup({ found: { updates: [update], errors: [] }, records, openVsx, codeServerDir, target: 'win32-x64' });
  await updates.checkForUpdates();
  const fromOpenVsx = { kind: 'openvsx', id: 'openai.chatgpt', name: 'Codex', from: '26.1021.22027', to: '26.1106.51428', target: 'win32-x64' };
  assert.deepEqual(updates.coordinator.state, { status: 'available', items: [update, fromOpenVsx] });
  assert.deepEqual(logged, ['check: a.b 1.0.0 -> 1.1.0, openai.chatgpt 26.1021.22027 -> 26.1106.51428']);
  await updates.startUpdate();
  assert.equal(updates.coordinator.state.status, 'preparing');
  assert.deepEqual(updates.coordinator.state.items.map((item) => `${item.id} ${item.to}`), ['openai.chatgpt 26.1106.51428']);
  // The download fails (the fake store is offline), so the gallery update does not follow.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(updates.coordinator.state.status, 'failed');
  assert.match(updates.coordinator.state.detail, /offline\. The previous versions stay\./);
});

test('updates found are offered; none found says so only when asked from the menu', async () => {
  const offered = setup({ found: { updates: [update], errors: [] } });
  await offered.updates.checkForUpdates();
  assert.deepEqual(offered.updates.coordinator.state, { status: 'available', items: [update] });
  assert.deepEqual(offered.logged, ['check: a.b 1.0.0 -> 1.1.0']);
  const quiet = setup();
  await quiet.updates.checkForUpdates();
  assert.deepEqual(quiet.calls, []);
  await quiet.updates.checkForUpdates({ manual: true });
  assert.deepEqual(quiet.calls, [{ type: 'info', message: 'No updates found in the configured sources.' }]);
});

test('a check that fails says why, and the Extensions pane hears it too', async () => {
  const { updates, calls, logged } = setup({ found: new Error('rate limited') });
  await updates.checkForUpdates({ manual: true });
  assert.equal(calls[0].type, 'error');
  assert.match(calls[0].message, /rate limited/);
  assert.equal(logged[0], 'check failed: rate limited');
});

test('newer imports join the gallery updates already offered, and dismissing clears them', async () => {
  const imported = { kind: 'import', id: 'c.d', from: '1', to: '2' };
  const { updates } = setup({ found: { updates: [update], errors: [] }, local: [imported] });
  await updates.checkForUpdates();
  updates.checkLocalExtensionUpdates();
  assert.deepEqual(updates.coordinator.state.items, [imported, update]);
  updates.dismissUpdate();
  assert.deepEqual(updates.coordinator.state, { status: 'none' });
});

test('busy tabs, and Codex tabs that cannot be observed, hold up the switch', async () => {
  const tabs = [
    { id: 'a', name: 'busy', server: 'running', codexObserved: true, risks: ['A turn is in progress.'] },
    { id: 'b', name: 'quiet', server: 'running', codexObserved: true },
    { id: 'c', name: 'unseen', server: 'running', codexObserved: false },
    { id: 'd', name: 'stopped', server: 'suspended' },
  ];
  const { updates } = setup({ tabs });
  assert.deepEqual(await updates.coordinator.deps.risks(), { busy: ['busy', 'unseen'], unobserved: true });
  const answered = setup({ tabs: tabs.slice(1), codexActive: false });
  assert.deepEqual(await answered.updates.coordinator.deps.risks(), { busy: [], unobserved: false });
});

test('the download is reported at most once a second', () => {
  let at = 0;
  const shown = [];
  const progress = downloadProgress('4.1.0', (detail) => shown.push(detail), () => at);
  at = 1000;
  progress(10, 100);
  at = 1500;
  progress(20, 100);
  at = 2000;
  progress(30, null);
  assert.deepEqual(shown, ['Downloading code-server 4.1.0… 10 / 100 MB', 'Downloading code-server 4.1.0… 30 MB']);
});
