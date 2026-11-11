const assert = require('node:assert/strict');
const test = require('node:test');
const { InstanceManager } = require('../src/code-server/code-server-instances');
const { WslCodeServerManager, installedVersions, vsixIdentity } = require('../src/code-server/code-server-wsl');

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
