const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { InstanceManager } = require('../src/code-server/code-server-instances');
const { WslCodeServerManager, installedVersions, vsixIdentity } = require('../src/code-server/code-server-wsl');
const { tempDir } = require('./support');

const FOLDER = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A distribution whose code-server installs extensions as the real one does: it extracts into a
// temporary folder and renames it into place, so a second install of an extension still being
// installed fails with ENOTEMPTY (#69). `have`: what it has installed already. `latest`: the
// version an install without one takes (else 1.0.0). `fail(spec)` makes an install fail otherwise.
function distro(t, { windows = [], extensions = ['acme.one'], unpinnedExtensions, have = [], latest = {}, fail = () => false } = {}) {
  const windowsDir = tempDir(t);
  if (windows.length) fs.writeFileSync(path.join(windowsDir, 'extensions.json'), JSON.stringify(windows.map(([id, version]) => ({ identifier: { id }, version }))));
  const installed = new Map(have);
  const files = new Map();
  const logs = [];
  const busy = new Set();
  const events = [];
  let running = 0;
  let most = 0;
  const wsl = new EventEmitter();
  wsl.readFile = async (file) => {
    if (!file.endsWith('/extensions/extensions.json')) return files.get(file) ?? null;
    events.push(`read ${[...installed.keys()].join(' ')}`.trim());
    return JSON.stringify([...installed].map(([id, version]) => ({ identifier: { id }, version })));
  };
  wsl.writeFile = async (file, text) => { files.set(file, String(text)); };
  wsl.exec = async (command, args) => {
    const spec = args[args.indexOf('--install-extension') + 1];
    const [id, version = latest[spec] || '1.0.0'] = spec.split('@');
    events.push(`install ${spec}`);
    const raced = busy.has(id);
    busy.add(id);
    most = Math.max(most, ++running);
    await tick();
    running--;
    if (raced) throw Object.assign(new Error('Command failed'), { stderr: `Error while installing extension ${id}: ENOTEMPTY: directory not empty, rename` });
    busy.delete(id);
    if (fail(spec)) throw Object.assign(new Error('Command failed'), { stderr: `Error: ${spec} is not reachable` });
    installed.set(id, version);
  };
  const manager = new WslCodeServerManager({ distro: 'Ubuntu', dataDir: windowsDir, hooks: { token: 'hook-token' }, wsl,
    extensions, unpinnedExtensions, windowsExtensionsDir: windowsDir, log: (line) => logs.push(line) });
  manager.home = '/home/me';
  manager.arch = 'amd64';
  manager.codeServerDir = '/server';
  // As the real one does, preparing reads the distribution's $HOME.
  manager.prepare = async () => { manager.home = '/home/me'; return true; };
  manager.launch = async () => ({ port: 4300 });
  return { manager, installed, files, logs, events, installs: () => events.filter((event) => event.startsWith('install ')), most: () => most };
}

const CLAUDE = 'anthropic.claude-code';
// A distribution with Claude Code unpinned, as main.js makes it.
const claudeDistro = (t, options) => distro(t, { extensions: [CLAUDE], unpinnedExtensions: [CLAUDE], ...options });

test('vsixIdentity reads the id and version from a VSIX named <id>-<version>.vsix', () => {
  assert.deepEqual(vsixIdentity('C:\\app\\native\\worktabs.worktabs-helper-0.5.0.vsix'), { id: 'worktabs.worktabs-helper', version: '0.5.0' });
  assert.deepEqual(vsixIdentity('/home/me/Publisher.Name-1.2.3-beta.vsix'), { id: 'publisher.name', version: '1.2.3-beta' });
  assert.equal(vsixIdentity('helper.vsix'), null);
});

test('installedVersions lists the extensions of an extensions.json by lowercase id', () => {
  const text = JSON.stringify([
    { identifier: { id: 'Anthropic.claude-code' }, version: '2.1.283' },
    { identifier: { id: 'ms-ceintl.vscode-language-pack-ja' }, version: '1.131.0' },
    { version: '1.0.0' },
  ]);
  assert.deepEqual([...installedVersions(text)], [
    ['anthropic.claude-code', '2.1.283'],
    ['ms-ceintl.vscode-language-pack-ja', '1.131.0'],
  ]);
  assert.equal(installedVersions(null).size, 0);
  assert.equal(installedVersions('not json').size, 0);
  assert.equal(installedVersions('{}').size, 0);
});

test('WSL start keeps the same owner when a taken port needs a retry', async () => {
  const owner = {};
  const calls = [];
  const manager = {
    stop: () => {}, ready: () => true, prepare: async () => {}, syncExtensions: async () => {},
    launch: async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw Object.assign(new Error('EADDRINUSE'), { portTaken: true });
      return { port: 4300 };
    },
  };
  const result = await WslCodeServerManager.prototype.start.call(manager, 'tab', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', 4200, { owner });
  assert.equal(result.port, 4300);
  assert.equal(calls[0][5], owner);
  assert.equal(calls[1][5], owner);
  assert.deepEqual(calls[1][4], new Set([4200]));
});

test('WSL readies the snapshots of its architecture after it is prepared and before the extensions sync', async () => {
  const calls = [];
  const manager = {
    target: 'linux-arm64', stop: () => {}, ready: () => true,
    prepare: async () => calls.push('prepare'), syncExtensions: async () => calls.push('sync'), launch: async () => ({ port: 4300 }),
    beforeSync: async (target, onProgress) => { calls.push(`before ${target}`); onProgress('Installing Codex from Open VSX…'); },
  };
  const progress = [];
  await WslCodeServerManager.prototype.start.call(manager, 'tab', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', 4200, { onProgress: (text) => progress.push(text) });
  assert.deepEqual(calls, ['prepare', 'before linux-arm64', 'sync']);
  assert.ok(progress.includes('Installing Codex from Open VSX…'));
});

test('WSL exits carry the start owner and ignore replaced instance keys', () => {
  const manager = new InstanceManager();
  const owner = {};
  let stopped = 0;
  manager.instances = new Map([['tab', { key: 'tab:2', started: true, stopping: false, owner, shared: { stop: () => stopped++ } }]]);
  manager.byKey = WslCodeServerManager.prototype.byKey;
  const exits = [];
  manager.on('exit', (...args) => exits.push(args));
  WslCodeServerManager.prototype.onExit.call(manager, 'tab:1', 1);
  assert.equal(stopped, 0);
  WslCodeServerManager.prototype.onExit.call(manager, 'tab:2', 7);
  assert.deepEqual(exits, [['tab', 7, owner]]);
  assert.equal(stopped, 1);
  assert.equal(manager.instances.size, 0);
});

test('WSL tabs that start together install each missing extension once', async (t) => {
  const f = distro(t, { windows: [['acme.one', '2.0.0']], extensions: ['acme.one', 'acme.two'] });
  const starts = ['a', 'b', 'c'].map((tabId) => f.manager.start(tabId, FOLDER));
  assert.deepEqual(await Promise.all(starts), [{ port: 4300 }, { port: 4300 }, { port: 4300 }]);
  assert.deepEqual(f.installs(), ['install acme.one@2.0.0', 'install acme.two']);
  assert.equal(f.most(), 1);
  assert.deepEqual([...f.installed], [['acme.one', '2.0.0'], ['acme.two', '1.0.0']]);
});

test('a WSL sync that waited reads extensions.json again and skips what the one before installed', async (t) => {
  const f = distro(t);
  await Promise.all([f.manager.syncExtensions(), f.manager.syncExtensions()]);
  assert.deepEqual(f.events, ['read', 'install acme.one', 'read acme.one']);
});

test('a failed WSL sync does not hold up the next one', async (t) => {
  let failures = 1;
  const f = distro(t, { fail: () => failures-- > 0 });
  const first = f.manager.start('a', FOLDER);
  const second = f.manager.start('b', FOLDER);
  await assert.rejects(first, /acme\.one: Error: acme\.one is not reachable/);
  assert.deepEqual(await second, { port: 4300 });
  assert.deepEqual(f.installs(), ['install acme.one', 'install acme.one']);
  await f.manager.syncExtensions();
  assert.equal(f.events.at(-1), 'read acme.one');
});

test('code-server for WSL reports the part of its download and of its extracting done', async (t) => {
  const dir = tempDir(t);
  const archive = path.join(dir, 'code-server.tar.gz');
  fs.writeFileSync(archive, 'archive');
  const progress = [];
  const extracted = [];
  const manager = {
    distro: 'Ubuntu', arch: 'amd64', base: '/home/me/.worktabs', version: () => '4.146.0',
    download: async ({ onProgress }) => { onProgress(59, 236); onProgress(236, 236); return archive; },
    wsl: { execDirect: async (_command, _args, { input }) => {
      for await (const chunk of input) extracted.push(String(chunk));
    } },
  };
  await WslCodeServerManager.prototype.installCodeServer.call(manager, (text, part) => progress.push([text, part]));
  assert.deepEqual(progress, [
    ['Downloading code-server 4.146.0 for WSL… 59 / 236 MB', 0.25],
    ['Downloading code-server 4.146.0 for WSL… 236 / 236 MB', 1],
    // tar in WSL reads the archive from its standard input; the part it has read is how far it is.
    ['Extracting code-server 4.146.0 in WSL Ubuntu…', 0],
    ['Extracting code-server 4.146.0 in WSL Ubuntu…', 1],
  ]);
  assert.equal(extracted.join(''), 'archive');
  assert.equal(fs.existsSync(archive), false);
});

test('an update syncs the WSL extensions after a starting tab has, and still replaces them', async (t) => {
  const f = distro(t, { windows: [['acme.one', '2.0.0']], extensions: ['acme.one', 'anthropic.claude-code'], unpinnedExtensions: ['anthropic.claude-code'] });
  const start = f.manager.start('a', FOLDER);
  const update = f.manager.applyUpdate(() => {});
  await Promise.all([start, update]);
  assert.deepEqual(f.events, [
    'read', 'install acme.one@2.0.0', 'install anthropic.claude-code',
    // The forced sync waited for the start's, so it skips the version just installed, and
    // installs the unpinned extension again, as an update does.
    'read acme.one anthropic.claude-code', 'install anthropic.claude-code',
  ]);
  assert.equal(f.most(), 1);
});

test('a WSL tab start takes the latest Claude Code when an update skipped the distribution (#88)', async (t) => {
  const f = claudeDistro(t, { windows: [[CLAUDE, '2.1.327']], have: [[CLAUDE, '2.1.319']], latest: { [CLAUDE]: '2.1.327' } });
  // The update ran while no tab of the distribution had started in this run.
  f.manager.home = null;
  await f.manager.applyUpdate(() => {});
  assert.deepEqual(f.installs(), []);
  await f.manager.start('a', FOLDER);
  assert.deepEqual(f.installs(), [`install ${CLAUDE}`]);
  assert.equal(f.installed.get(CLAUDE), '2.1.327');
  assert.deepEqual(JSON.parse(f.files.get('/home/me/.worktabs/unpinned-extensions.json')), { [CLAUDE]: '2.1.327' });
  // Up to date now: the next start does not take it again.
  await f.manager.start('b', FOLDER);
  assert.deepEqual(f.installs(), [`install ${CLAUDE}`]);
});

test('a WSL tab start leaves a Claude Code as new as the Windows tabs\' alone', async (t) => {
  for (const have of ['2.1.327', '2.1.330']) {
    const f = claudeDistro(t, { windows: [[CLAUDE, '2.1.327']], have: [[CLAUDE, have]] });
    await f.manager.start('a', FOLDER);
    assert.deepEqual(f.installs(), [], have);
  }
});

test('a WSL tab start takes the latest Claude Code once for each Windows version, even when it is older', async (t) => {
  const f = claudeDistro(t, { windows: [[CLAUDE, '2.1.327']], have: [[CLAUDE, '2.1.319']], latest: { [CLAUDE]: '2.1.325' } });
  await f.manager.start('a', FOLDER);
  // Open VSX has nothing newer for Linux yet: the next starts do not install it again and again.
  await f.manager.start('b', FOLDER);
  assert.deepEqual(f.installs(), [`install ${CLAUDE}`]);
  assert.equal(f.installed.get(CLAUDE), '2.1.325');
});

test('a WSL tab start leaves an older Claude Code alone while a tab of the distribution runs', async (t) => {
  const f = claudeDistro(t, { windows: [[CLAUDE, '2.1.327']], have: [[CLAUDE, '2.1.319']], latest: { [CLAUDE]: '2.1.327' } });
  f.manager.instances.set('running', /** @type {any} */ ({}));
  await f.manager.start('a', FOLDER);
  assert.deepEqual(f.installs(), []);
  f.manager.instances.clear();
  await f.manager.start('b', FOLDER);
  assert.deepEqual(f.installs(), [`install ${CLAUDE}`]);
});

test('a WSL tab starts with its Claude Code when taking a newer one fails, and the next start tries again', async (t) => {
  let failures = 1;
  const f = claudeDistro(t, { windows: [[CLAUDE, '2.1.327']], have: [[CLAUDE, '2.1.319']], latest: { [CLAUDE]: '2.1.327' }, fail: () => failures-- > 0 });
  assert.deepEqual(await f.manager.start('a', FOLDER), { port: 4300 });
  assert.equal(f.installed.get(CLAUDE), '2.1.319');
  assert.match(f.logs[0], /^WSL Ubuntu: anthropic\.claude-code not updated: anthropic\.claude-code: Error: anthropic\.claude-code is not reachable/);
  await f.manager.start('b', FOLDER);
  assert.equal(f.installed.get(CLAUDE), '2.1.327');
});

test('a missing Claude Code still stops the WSL tab when it cannot be installed', async (t) => {
  const f = claudeDistro(t, { windows: [[CLAUDE, '2.1.327']], fail: () => true });
  await assert.rejects(f.manager.start('a', FOLDER), /anthropic\.claude-code is not reachable/);
});
