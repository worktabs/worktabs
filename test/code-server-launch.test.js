const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { CodeServerManager } = require('../src/code-server/code-server');
const { WslCodeServerManager } = require('../src/code-server/code-server-wsl');
const { cleanEnv, firstErrorLine, launchArgs, launchAuthentication, prepareLaunch, localFiles } = require('../src/code-server/code-server-launch');
const { tempDir } = require('./support');
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };

function fixture(t, backend, mode = 'success') {
  const dir = tempDir(t); const launched = deferred(); const health = deferred();
  const calls = []; const ports = []; let stopped = 0; let clock = 0; let proc;
  const owner = {}; const avoid = new Set([4400]);
  const runtime = {
    pickPort: async (preferred, reserved) => { ports.push([preferred, reserved]); return preferred || 4500; },
    prepare: async () => ({ stop: () => stopped++ }), now: () => clock, sleep: async (ms) => { clock += ms; }, timeout: 600,
    health: async () => mode === 'pending' ? health.promise : mode === 'timeout' ? 0 : mode === 'probe-error' ? Promise.reject(new Error('probe failed')) : 200,
    spawn: (command, args, options) => {
      if (mode === 'transport-error') throw new Error('transport failed');
      proc = new EventEmitter(); proc.pid = 999; proc.exitCode = null;
      calls.push({ command, args, env: options.env }); launched.resolve();
      if (mode === 'early-exit') queueMicrotask(() => { proc.exitCode = 7; proc.emit('exit', 7); });
      if (mode === 'process-error') queueMicrotask(() => proc.emit('error', new Error('missing executable')));
      return proc;
    }, kill: (pid) => calls.push({ op: 'stop', pid }),
  };
  const wsl = new EventEmitter();
  wsl.request = async (request) => {
    calls.push(request);
    if (request.op !== 'start') return;
    if (mode === 'transport-error') throw new Error('transport failed');
    launched.resolve();
    if (mode === 'early-exit') queueMicrotask(() => wsl.emit('instance-exit', request.name, 7));
    if (mode === 'port-retry' && calls.filter((call) => call.op === 'start').length === 1) {
      queueMicrotask(() => { wsl.emit('output', request.name, 'EADDRINUSE'); wsl.emit('instance-exit', request.name, 1); });
    }
  };
  const manager = backend === 'local'
    ? new CodeServerManager({ dataDir: dir, extensionsDir: path.join(dir, 'extensions'), codeServerDir: path.join(dir, 'server'), locale: 'ja', runtime })
    : new WslCodeServerManager({ distro: 'Ubuntu', dataDir: dir, locale: 'ja', hooks: { token: 'hook-token' }, runtime, wsl });
  if (backend === 'wsl') { manager.home = '/home/me'; manager.codeServerDir = '/server'; manager.arch = 'amd64'; manager.prepare = async () => {}; manager.syncExtensions = async () => {}; manager.ready = () => true; }
  const folder = backend === 'local' ? path.join(dir, 'repo') : '\\\\wsl.localhost\\Ubuntu\\repo';
  const start = () => manager.start('tab', folder, 4600, { owner, avoid });
  const exit = (code) => backend === 'local' ? (proc.exitCode = code, proc.emit('exit', code)) : wsl.emit('instance-exit', manager.instances.get('tab')?.key || 'tab:1', code);
  return { manager, calls, ports, owner, avoid, start, exit, launched, health, stopped: () => stopped };
}

for (const backend of ['local', 'wsl']) {
  test(`${backend} launch returns matching authentication and common arguments, then emits one owned exit`, async (t) => {
    const f = fixture(t, backend); const exits = []; f.manager.on('exit', (...args) => exits.push(args));
    const result = await f.start();
    const request = f.calls[0];
    assert.equal(result.port, 4600); assert.equal(result.cookie.name, 'code-server-session-tab'); assert.equal(result.cookie.value, request.env.HASHED_PASSWORD);
    assert.equal(request.env.WORKTABS_TAB_ID, 'tab');
    if (process.env.NODE_USE_SYSTEM_CA === undefined) assert.equal(request.env.NODE_USE_SYSTEM_CA, '1');
    for (const flag of ['--ignore-last-opened', '--disable-telemetry', '--disable-update-check']) assert.ok(request.args.includes(flag));
    assert.equal(request.args[request.args.indexOf('--locale') + 1], 'ja');
    assert.equal(request.args[request.args.indexOf('--auth') + 1], 'password');
    assert.deepEqual(f.ports, [[4600, f.avoid]]);
    f.exit(7); assert.deepEqual(exits, [['tab', 7, f.owner]]); assert.equal(f.stopped(), 1); assert.equal(f.manager.instances.size, 0);
  });

  for (const mode of ['transport-error', 'early-exit', 'timeout', 'probe-error']) {
    test(`${backend} ${mode} rejects startup and releases settings exactly once`, async (t) => {
      const f = fixture(t, backend, mode); const exits = []; f.manager.on('exit', (...args) => exits.push(args));
      await assert.rejects(f.start(), mode === 'timeout' ? /60 seconds/ : mode === 'early-exit' ? /ended/ : /failed/);
      assert.equal(f.stopped(), 1); assert.equal(f.manager.instances.size, 0); assert.deepEqual(exits, []);
      f.manager.stop('tab'); assert.equal(f.stopped(), 1);
      if (mode === 'timeout' || mode === 'probe-error') assert.equal(f.calls.filter((call) => call.op === 'stop').length, 1);
    });
  }

  test(`${backend} intentional stop during a health request cannot complete the canceled start`, async (t) => {
    const f = fixture(t, backend, 'pending'); const start = f.start(); await f.launched.promise;
    await new Promise((resolve) => setImmediate(resolve));
    f.manager.stop('tab'); f.manager.stop('tab'); f.health.resolve(200);
    await assert.rejects(start, /stopped while starting/);
    assert.equal(f.stopped(), 1); assert.equal(f.calls.filter((call) => call.op === 'stop').length, 1);
  });

  test(`${backend} startup failure cannot stop a replacement instance with the same ID`, async (t) => {
    const f = fixture(t, backend, 'pending'); const start = f.start(); await f.launched.promise;
    await new Promise((resolve) => setImmediate(resolve));
    const replacement = { key: 'new', proc: { pid: 1000, exitCode: null }, shared: { stop: () => assert.fail('replacement settings') } };
    f.manager.instances.set('tab', replacement); f.health.resolve(200);
    await assert.rejects(start, /stopped while starting/);
    assert.equal(f.manager.instances.get('tab'), replacement); assert.equal(f.stopped(), 1);
    assert.equal(f.calls.filter((call) => call.op === 'stop' && (call.pid === 1000 || call.name === 'new')).length, 0);
    f.manager.instances.delete('tab');
  });

  test(`${backend} repeated intentional stop releases settings without an unexpected-exit event`, async (t) => {
    const f = fixture(t, backend); const exits = []; f.manager.on('exit', (...args) => exits.push(args));
    await f.start(); f.manager.stop('tab'); f.manager.stop('tab'); f.exit(0);
    assert.equal(f.stopped(), 1); assert.deepEqual(exits, []); assert.equal(f.manager.instances.size, 0);
  });
}

test('a local spawn error cleans up settings and rejects startup with its diagnostic', async (t) => {
  const f = fixture(t, 'local', 'process-error'); await assert.rejects(f.start(), /missing executable/);
  assert.equal(f.stopped(), 1); assert.equal(f.manager.instances.size, 0);
});

test('preparation shares managed settings, paths and Codex launchers across filesystem adapters', async (t) => {
  for (const backend of ['local', 'wsl']) {
    const root = backend === 'local' ? tempDir(t) : '/home/me/.worktabs'; const writes = new Map(); let wrapperOptions;
    const files = backend === 'local' ? localFiles : { join: path.posix.join, read: async (file) => writes.get(file) || null, write: async (file, text) => writes.set(file, text) };
    const userDataDir = files.join(root, 'instances', 'tab'); const wrapper = files.join(userDataDir, 'codex', 'codex-wrap');
    const shared = {};
    const result = await prepareLaunch({ files, extensionsDir: files.join(root, 'extensions'), userDataDir,
      userDir: (id) => files.join(root, 'instances', id, 'User'), managed: { 'chatgpt.openOnStartup': true, 'claudeCode.claudeProcessWrapper': '/claude-wrap' },
      wrapperOptions: { node: '/node', platform: backend === 'wsl' ? 'linux' : process.platform },
      prepare: async (options) => { wrapperOptions = options; return wrapper; },
      shareSettings: async ({ managed, files: actual, userDir }) => {
        assert.equal(actual, files); assert.equal(managed['chatgpt.cliExecutable'], wrapper);
        assert.equal(managed['claudeCode.claudeProcessWrapper'], '/claude-wrap'); assert.equal(userDir('other'), files.join(root, 'instances', 'other', 'User')); return shared;
      } });
    assert.equal(result, shared); assert.equal(wrapperOptions.dir, files.join(userDataDir, 'codex')); assert.equal(wrapperOptions.node, '/node');
    const machine = JSON.parse(await files.read(files.join(userDataDir, 'Machine', 'settings.json')));
    assert.equal(machine['chatgpt.cliExecutable'], wrapper);
  }
});

test('authentication uses fresh per-start secrets and locale-free arguments omit the locale flag', () => {
  const first = launchAuthentication('tab'); const second = launchAuthentication('tab');
  assert.match(first.sessionKey, /^[a-f0-9]{64}$/); assert.notEqual(first.sessionKey, second.sessionKey);
  assert.equal(first.cookie.value, first.sessionKey);
  const args = launchArgs({ baseArgs: ['server'], port: 4500, tabId: 'tab', folder: '/folder' });
  assert.equal(args.includes('--locale'), false); assert.equal(args.at(-1), '/folder');
});

test('WSL preferred-port fallback releases the old handle and keeps its owner and reserved ports', async (t) => {
  const f = fixture(t, 'wsl', 'port-retry'); const result = await f.start();
  assert.equal(result.port, 4500); assert.equal(f.stopped(), 1);
  assert.equal(f.ports.length, 2); assert.equal(f.ports[1][0], 0);
  assert.deepEqual([...f.ports[1][1]], [4400, 4600]);
  assert.equal(f.manager.instances.get('tab').owner, f.owner);
  assert.deepEqual(f.calls.filter((call) => call.op === 'start').map((call) => call.name), ['tab:1', 'tab:2']);
  f.manager.stop('tab'); assert.equal(f.stopped(), 2);
});

test('the local manager still resolves a folder URL through the neutral helper', () => {
  const folder = path.resolve('repo');
  const manager = { ports: () => [4600] };
  assert.equal(CodeServerManager.prototype.folderFromUrl.call(manager, `http://127.0.0.1:4600/?folder=${encodeURIComponent(folder)}`), folder);
  assert.equal(CodeServerManager.prototype.folderFromUrl.call(manager, 'http://127.0.0.1:4700/?folder=/other'), null);
});

test('cleanEnv has Node trust the OS certificate store, unless the user set it', (t) => {
  const saved = process.env.NODE_USE_SYSTEM_CA;
  t.after(() => { if (saved === undefined) delete process.env.NODE_USE_SYSTEM_CA; else process.env.NODE_USE_SYSTEM_CA = saved; });
  delete process.env.NODE_USE_SYSTEM_CA;
  assert.equal(cleanEnv().NODE_USE_SYSTEM_CA, '1');
  assert.equal(cleanEnv({ EXTENSIONS_GALLERY: undefined }).NODE_USE_SYSTEM_CA, '1');
  process.env.NODE_USE_SYSTEM_CA = '0';
  assert.equal(cleanEnv().NODE_USE_SYSTEM_CA, '0');
});

test('firstErrorLine skips Node warnings, which would pass for the error line', () => {
  const stderr = [
    'Installing extensions...',
    '(node:40472) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications.',
    '(Use `node --trace-deprecation ...` to show where the warning was created)',
    'Error while installing extensions: self-signed certificate in certificate chain',
    'self-signed certificate in certificate chain',
  ].join('\r\n');
  assert.equal(firstErrorLine(stderr, 'fallback'), 'Error while installing extensions: self-signed certificate in certificate chain');
  assert.equal(firstErrorLine('(node:1) Warning: something errored\n  first line  \n', 'fallback'), 'first line');
  assert.equal(firstErrorLine('(node:1) ExperimentalWarning: error\n', 'fallback'), 'fallback');
  assert.equal(firstErrorLine(undefined, 'fallback'), 'fallback');
});

test('WSL extension installs have Node trust the CA store and report the error, not a Node warning', async (t) => {
  const dir = tempDir(t); const calls = [];
  const wsl = new EventEmitter();
  wsl.exec = async (command, args, options) => {
    calls.push({ command, args, options });
    throw Object.assign(new Error('exit 1'), {
      stderr: '(node:7) [DEP0169] DeprecationWarning: prone to errors\nError while installing extensions: self-signed certificate in certificate chain\n',
    });
  };
  const manager = new WslCodeServerManager({ distro: 'Ubuntu', dataDir: dir, hooks: { token: 'hook-token' }, wsl });
  manager.home = '/home/me'; manager.codeServerDir = '/server';
  await assert.rejects(manager.installExtension('Anthropic.claude-code'),
    { message: 'Anthropic.claude-code: Error while installing extensions: self-signed certificate in certificate chain' });
  assert.equal(calls[0].command, 'env');
  assert.deepEqual(calls[0].args.slice(0, 3), ['NODE_USE_SYSTEM_CA=1', manager.nodeExe, '/server']);
  assert.equal(calls[0].options.shellEnv, true);
});
