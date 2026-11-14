const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const { ExtensionImports, applyImportBatch, discoverDesktop, identity, installedExtensions, readFolder, readVsix, safeEntries, validateBatch, idleWaitReason } = require('../src/code-server/extension-imports');
const { CodeServerManager, localFiles } = require('../src/code-server/code-server');
const { prepareCodex } = require('../src/codex/codex-launch');
const { WslCodeServerManager } = require('../src/code-server/code-server-wsl');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktabs-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function folder(root, version = '1.0.0', extra = {}) {
  const location = path.join(root, `acme.agent-${version}`);
  fs.mkdirSync(path.join(location, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(location, 'package.json'), JSON.stringify({ publisher: 'Acme', name: 'agent', version, engines: { vscode: '^1.90.0' }, ...extra }));
  fs.writeFileSync(path.join(location, 'bin', 'agent'), 'complete executable payload', { mode: 0o755 });
  return readFolder(location);
}

function index(root, items) {
  fs.writeFileSync(path.join(root, 'extensions.json'), JSON.stringify(items.map((item) => ({ identifier: { id: item.id }, version: item.version, relativeLocation: path.basename(item.location), metadata: { targetPlatform: item.targetPlatform } }))));
}

const options = { target: 'win32-x64', vscode: '1.131.0' };

test('updates wait for startup, work, edits, or a Codex that Worktabs cannot see', () => {
  assert.equal(idleWaitReason({ server: 'starting' }), 'busy');
  // Still at its gates, such as a Codex tab waiting for Codex from Open VSX: nothing launched yet,
  // and the update may be what it waits for.
  assert.equal(idleWaitReason({ server: 'starting', preparing: true }), null);
  assert.equal(idleWaitReason({ server: 'running' }, { risks: ['unsaved'] }), 'busy');
  assert.equal(idleWaitReason({ server: 'running' }), null);
  assert.equal(idleWaitReason({ server: 'stopped' }, { risks: ['unsaved'], codexActive: true }), null);
  // Idle tabs with Codex running behind the proxy update in place, like Claude tabs.
  assert.equal(idleWaitReason({ server: 'running', codexObserved: true }, { codexActive: true }), null);
  assert.equal(idleWaitReason({ server: 'running', codexObserved: true }, { risks: ['working'], codexActive: true }), 'busy');
  assert.equal(idleWaitReason({ server: 'running' }, { codexActive: true }), 'unobserved');
  assert.equal(idleWaitReason({ server: 'running' }, { codexActive: null }), 'unobserved');
  assert.equal(idleWaitReason({ server: 'running' }, { codexActive: false }), null);
});

test('desktop universal metadata and unresolved display labels are normalized', () => {
  const item = identity({ publisher: 'acme', name: 'agent', version: '1.0.0', displayName: '%displayName%', engines: { vscode: '*' } }, 'undefined');
  assert.equal(item.targetPlatform, 'universal');
  assert.equal(item.name, 'acme.agent');
  validateBatch([item], options);
});

test('desktop discovery reads only active entries, including custom and Insiders roots', (t) => {
  const root = fixture(t);
  const custom = path.join(root, 'custom');
  const insiders = path.join(root, '.vscode-insiders', 'extensions');
  const active = folder(custom, '2.0.0');
  folder(custom, '1.0.0');
  index(custom, [active]);
  index(insiders, [folder(insiders, '3.0.0')]);
  const items = discoverDesktop({ home: root, env: { VSCODE_EXTENSIONS: custom } });
  assert.deepEqual(items.map((item) => item.version), ['2.0.0', '3.0.0']);
  assert.equal(items[0].root, custom);
});

test('desktop discovery reports a corrupt source without hiding other sources', (t) => {
  const root = fixture(t);
  const custom = path.join(root, 'custom');
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, 'extensions.json'), '{}');
  const other = path.join(root, '.vscode', 'extensions');
  index(other, [folder(other)]);
  const items = discoverDesktop({ home: root, env: { VSCODE_EXTENSIONS: custom } });
  assert.ok(items[0].error);
  assert.equal(items[1].id, 'acme.agent');
});

test('installed entries cannot escape their root or lie about their identity', (t) => {
  const root = fixture(t);
  const item = folder(root);
  index(root, [{ ...item, id: 'wrong.agent' }]);
  assert.throws(() => installedExtensions(root), /does not match/);
  fs.writeFileSync(path.join(root, 'extensions.json'), JSON.stringify([{ relativeLocation: '..' }]));
  assert.throws(() => installedExtensions(root), /outside/);
});

test('folder snapshots preserve the manifest, binaries, executable permissions and target', async (t) => {
  const root = fixture(t);
  const store = new ExtensionImports(path.join(root, 'store'));
  const item = folder(root, '1.0.0', { __metadata: { targetPlatform: 'linux-x64' } });
  fs.mkdirSync(path.join(item.location, 'webview', 'ü'), { recursive: true });
  fs.writeFileSync(path.join(item.location, 'webview', 'ü', 'empty.js'), '');
  const large = Buffer.alloc(3 * 1024 ** 2, 'payload ');
  fs.writeFileSync(path.join(item.location, 'bin', 'large'), large);
  const record = await store.stage(item, 'linux-x64');
  const checked = readVsix(record.file);
  assert.equal(checked.id, item.id);
  assert.equal(checked.targetPlatform, 'linux-x64');
  const zip = new AdmZip(record.file);
  assert.equal(zip.readAsText('extension/bin/agent'), 'complete executable payload');
  assert.equal(zip.readFile('extension/webview/ü/empty.js').length, 0);
  assert.ok(zip.readFile('extension/bin/large').equals(large));
  assert.ok(zip.getEntry('extension/bin/large').header.compressedSize < large.length);
  assert.deepEqual(checked.manifest, item.manifest);
  if (process.platform !== 'win32') assert.equal((zip.getEntry('extension/bin/agent').header.attr >>> 16) & 0o777, 0o755);
});

test('the Codex observer launches the binary from the imported snapshot, not a changed source', async (t) => {
  const root = fixture(t);
  const store = new ExtensionImports(path.join(root, 'store'));
  for (const [platform, directory, filename] of [['win32', 'windows-x86_64', 'codex.exe'], ['linux', 'linux-x86_64', 'codex']]) {
    const item = folder(path.join(root, platform), '1.0.0', { publisher: 'openai', name: 'chatgpt', __metadata: { targetPlatform: `${platform}-x64` } });
    const binary = path.join(item.location, 'bin', directory, filename);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, 'snapshot binary', { mode: 0o755 });
    const record = await store.stage(item, `${platform}-x64`);
    fs.writeFileSync(binary, 'source updated later');
    const installed = path.join(root, `${platform}-installed`);
    new AdmZip(store.package(record)).extractAllTo(installed);
    fs.writeFileSync(path.join(installed, 'extensions.json'), JSON.stringify([{ identifier: { id: item.id }, version: item.version, relativeLocation: 'extension' }]));
    const dir = path.join(root, `${platform}-instance`, 'codex');
    const nativeLauncher = path.join(root, 'native-launcher');
    fs.writeFileSync(nativeLauncher, 'launcher');
    const wrapper = await prepareCodex({ files: localFiles, extensionsDir: installed, dir, node: process.execPath, platform, arch: 'x64', nativeLauncher });
    const launch = JSON.parse(fs.readFileSync(path.join(dir, 'codex-launch.json'), 'utf8'));
    assert.equal(launch.binary, path.join(installed, 'extension', 'bin', directory, filename));
    assert.equal(fs.readFileSync(launch.binary, 'utf8'), 'snapshot binary');
    assert.equal(fs.existsSync(wrapper), true);
  }
});

test('VSIX snapshots copy the exact file and detect changes to the cached payload', async (t) => {
  const root = fixture(t);
  const store = new ExtensionImports(path.join(root, 'store'));
  const first = await store.stage(folder(root), 'win32-x64');
  const second = await store.stage(readVsix(first.file), 'win32-x64');
  assert.equal(first.sha256, second.sha256);
  fs.appendFileSync(second.file, 'changed');
  assert.throws(() => store.package(second), /has changed/);
  assert.throws(() => store.package({ ...first, file: path.join(root, 'elsewhere.vsix') }), /has changed/);
});

test('Open VSX releases are downloaded into snapshots that record their page and pack members', async (t) => {
  const root = fixture(t);
  const store = new ExtensionImports(path.join(root, 'store'));
  const built = await store.stage(folder(root), 'win32-x64');
  const release = { kind: 'openvsx', id: 'acme.agent', name: 'Agent', version: '1.0.0', targetPlatform: 'universal',
    page: 'https://open-vsx.org/extension/acme/agent', bundled: ['acme.audio'] };
  const download = async (_item, file) => fs.copyFileSync(built.file, file);
  const record = await store.stage(release, 'win32-x64', { download });
  assert.deepEqual(record.source, { kind: 'openvsx', location: release.page, root: null });
  assert.deepEqual(record.bundled, ['acme.audio']);
  assert.equal(store.package(record), record.file);
  // What Open VSX sent is checked like any VSIX, and nothing is left behind when it is not what was asked for.
  const before = fs.readdirSync(path.join(root, 'store', 'packages', 'win32-x64')).length;
  await assert.rejects(store.stage({ ...release, version: '2.0.0' }, 'win32-x64', { download }), /source changed/);
  await assert.rejects(store.stage(release, 'win32-x64'), /not available/);
  assert.equal(fs.readdirSync(path.join(root, 'store', 'packages', 'win32-x64')).length, before);
});

test('pruning keeps the current and previous snapshots of every target and deletes the rest', async (t) => {
  const root = fixture(t);
  const store = new ExtensionImports(path.join(root, 'store'));
  const snapshot = async (version, target = 'win32-x64') => store.stage(folder(root, version), target);
  const first = await snapshot('1.0.0');
  store.commit('win32-x64', [first], []);
  const second = await snapshot('2.0.0');
  store.commit('win32-x64', [second], [first]);
  const third = await snapshot('3.0.0');
  store.commit('win32-x64', [third], [second]);
  const linux = await snapshot('1.0.0', 'linux-x64');
  store.commit('linux-x64', [linux], []);
  // Staged by a batch that never committed.
  const failed = await snapshot('4.0.0');
  const folderOf = (record) => path.dirname(record.file);
  assert.deepEqual(store.prune().sort(), [folderOf(first), folderOf(failed)].sort());
  for (const record of [second, third, linux]) assert.equal(store.package(record), record.file);
  for (const record of [first, failed]) assert.equal(fs.existsSync(folderOf(record)), false);
  assert.deepEqual(store.prune(), []);
  // A data folder that moved keeps the snapshots its records name.
  const moved = path.join(root, 'moved');
  fs.cpSync(store.root, moved, { recursive: true });
  assert.deepEqual(new ExtensionImports(moved).prune(), []);
  // Records that cannot be read do not tell what is in use, so nothing goes.
  const orphan = await snapshot('5.0.0');
  fs.writeFileSync(store.file, '[]');
  assert.deepEqual(store.prune(), []);
  assert.equal(fs.existsSync(orphan.file), true);
});

test('snapshot validation catches a source replaced after selection', async (t) => {
  const root = fixture(t);
  const item = folder(root);
  fs.writeFileSync(path.join(item.location, 'package.json'), JSON.stringify({ ...item.manifest, version: '2.0.0' }));
  const store = new ExtensionImports(path.join(root, 'store'));
  await assert.rejects(store.stage(item, 'win32-x64'), /does not match|source changed/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'store', 'packages', 'win32-x64')), []);
  await assert.rejects(store.stage(item, '../outside'), /Unsupported/);
});

test('archive paths reject traversal, Windows aliases, symlinks and case collisions', () => {
  for (const name of ['../a', '/a', 'extension/../a', 'extension\\a', 'extension/a:b', 'extension/CON.txt', 'extension/a.', 'extension/a ', 'extension//a']) {
    assert.throws(() => safeEntries({ getEntries: () => [{ entryName: name, header: { attr: 0, size: 1 } }] }), /unsafe path/);
  }
  assert.throws(() => safeEntries({ getEntries: () => [{ entryName: 'extension/link', header: { attr: 0xa000 << 16, size: 1 } }] }), /unsafe/);
  assert.throws(() => safeEntries({ getEntries: () => ['extension/A', 'extension/a'].map((entryName) => ({ entryName, header: { attr: 0, size: 1 } })) }), /duplicate/);
  assert.throws(() => safeEntries({ getEntries: () => [{ entryName: 'extension/a', header: { attr: 0, size: 4 * 1024 ** 3 + 1 } }] }), /too large/);
});

test('VSIX metadata must match the payload and cannot define XML entities', async (t) => {
  const root = fixture(t);
  const store = new ExtensionImports(path.join(root, 'store'));
  const record = await store.stage(folder(root), 'win32-x64');
  const zip = new AdmZip(record.file);
  const metadata = zip.readAsText('extension.vsixmanifest');
  zip.updateFile('extension.vsixmanifest', Buffer.from(metadata.replace('Version="1.0.0"', 'Version="9.0.0"')));
  zip.writeZip(record.file);
  assert.throws(() => readVsix(record.file), /does not match/);
  zip.updateFile('extension.vsixmanifest', Buffer.from(`<!DOCTYPE a [<!ENTITY a "b">]>${metadata}`));
  zip.writeZip(record.file);
  assert.throws(() => readVsix(record.file), /Invalid VSIX metadata/);
});

test('batch validation enforces engine, platform, duplicates and managed infrastructure', () => {
  const item = identity({ publisher: 'acme', name: 'agent', version: '1.0.0', engines: { vscode: '^1.90.0' } });
  validateBatch([item], options);
  assert.throws(() => validateBatch([], options), /at least one/);
  assert.throws(() => validateBatch([item, item], options), /one version/);
  assert.throws(() => validateBatch([{ ...item, targetPlatform: 'linux-x64' }], options), /targets/);
  assert.throws(() => validateBatch([{ ...item, engine: '^1.140.0' }], options), /requires VS Code/);
  assert.throws(() => validateBatch([item], { ...options, protectedIds: [item.id] }), /managed/);
  assert.throws(() => validateBatch([{ ...item, manifest: { contributes: { localizations: [{}] } } }], options), /managed/);
  validateBatch([{ ...item, targetPlatform: 'darwin-universal' }], { ...options, target: 'darwin-arm64' });
});

test('dependencies must be active or included in the same import batch', () => {
  const item = identity({ publisher: 'acme', name: 'agent', version: '1.0.0', engines: { vscode: '*' }, extensionDependencies: ['acme.required'] });
  assert.throws(() => validateBatch([item], options), /needs these/);
  validateBatch([item], { ...options, installed: [{ id: 'Acme.Required' }] });
  validateBatch([item, { ...item, id: 'acme.required', dependencies: [] }], options);
  assert.throws(() => validateBatch([{ ...item, dependencies: [1] }], options), /Invalid extension dependencies/);
});

test('local update checks keep sources and targets separate, with one previous snapshot', async (t) => {
  const root = fixture(t);
  const source = path.join(root, 'desktop');
  const store = new ExtensionImports(path.join(root, 'store'));
  const item = { ...folder(source), root: source };
  index(source, [item]);
  const record = await store.stage(item, 'win32-x64');
  store.commit('win32-x64', [record], []);
  assert.deepEqual(store.localUpdates('win32-x64'), []);
  index(source, [folder(source, '2.0.0')]);
  assert.equal(store.localUpdates('win32-x64')[0].to, '2.0.0');
  assert.equal(store.localUpdates('win32-x64')[0].candidate.root, source);
  assert.deepEqual(store.localUpdates('linux-x64'), []);
  const next = await store.stage({ ...folder(source, '2.0.0'), root: source }, 'win32-x64');
  store.commit('win32-x64', [next], [record]);
  const rollback = await store.stage({ ...readVsix(record.file), snapshotSource: record.source }, 'win32-x64');
  store.commit('win32-x64', [rollback], store.records('win32-x64'));
  assert.equal(store.records('win32-x64')[0].source.root, source);
  assert.equal(store.records('win32-x64')[0].previous.version, '2.0.0');
  assert.equal(store.records('win32-x64')[0].previous.previous, undefined);
  fs.renameSync(path.join(source, 'extensions.json'), path.join(source, 'unavailable.json'));
  assert.deepEqual(store.localUpdates('win32-x64'), []);
});

for (const failure of ['install', 'probe', 'commit']) {
  test(`a failed ${failure} restores old snapshots and uninstalls new additions`, async () => {
    const calls = [];
    const records = [{ id: 'acme.old', version: '2' }, { id: 'acme.new', version: '1' }];
    const previous = [{ id: 'acme.old', version: '1' }];
    await assert.rejects(applyImportBatch({ records, previous,
      install: async (record) => { calls.push(`install ${record.id} ${record.version}`); if (failure === 'install' && record.id === 'acme.new') throw new Error('broken'); },
      uninstall: async (id) => { calls.push(`remove ${id}`); },
      probe: async () => { if (failure === 'probe') throw new Error('broken'); },
      commit: async () => { if (failure === 'commit') throw new Error('broken'); },
    }), /broken/);
    assert.deepEqual(calls.slice(-2), ['remove acme.new', 'install acme.old 1']);
  });
}

test('restoration errors are reported without skipping the other restorations', async () => {
  const restored = [];
  await assert.rejects(applyImportBatch({ records: [{ id: 'a' }, { id: 'b' }], previous: [],
    install: async () => {}, probe: async () => { throw new Error('probe failed'); }, commit: async () => {},
    uninstall: async (id) => { restored.push(id); if (id === 'b') throw new Error('cannot remove b'); },
  }), /Restoration failed: cannot remove b/);
  assert.deepEqual(restored, ['b', 'a']);
});

test('ensureExtensions ignores obsolete folders and accepts active platform-suffixed installs', async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'acme.agent-2.0.0'));
  index(root, [{ id: 'acme.agent', version: '1.0.0', location: path.join(root, 'acme.agent-1.0.0-win32-x64') }]);
  const calls = [];
  const manager = { extensionsDir: root, installExtension: async (spec) => calls.push(spec) };
  await CodeServerManager.prototype.ensureExtensions.call(manager, ['acme.agent', 'acme.agent-1.0.0.vsix', 'acme.agent-2.0.0.vsix']);
  assert.deepEqual(calls, ['acme.agent-2.0.0.vsix']);
});

test('WSL selects Linux imports, leaves busy installs alone, and refreshes unpinned Claude on demand', async (t) => {
  const root = fixture(t);
  const calls = [];
  const have = JSON.stringify([{ identifier: { id: 'acme.agent' }, version: '1.0.0' }, { identifier: { id: 'anthropic.claude-code' }, version: '1.0.0' }]);
  const manager = {
    arch: 'amd64', base: '/home/me/.worktabs', extensionsDir: '/ext', windowsExtensionsDir: root,
    instances: new Map([['busy', {}]]), unpinnedExtensions: ['anthropic.claude-code'],
    extensionSpecs: (target) => { assert.equal(target, 'linux-x64'); return ['acme.agent-2.0.0.vsix', 'anthropic.claude-code']; },
    wsl: { readFile: async () => have, writeFile: async () => calls.push('copy') }, installExtension: async (spec) => calls.push(spec),
  };
  await WslCodeServerManager.prototype.doSyncExtensions.call(manager);
  assert.deepEqual(calls, []);
  const vsix = path.join(root, 'acme.agent-2.0.0.vsix');
  fs.writeFileSync(vsix, 'linux payload');
  manager.extensionSpecs = () => [vsix, 'anthropic.claude-code'];
  manager.instances.clear();
  await WslCodeServerManager.prototype.doSyncExtensions.call(manager, { force: true });
  assert.deepEqual(calls, ['copy', '/home/me/.worktabs/vsix/acme.agent-2.0.0.vsix', 'anthropic.claude-code']);
});
