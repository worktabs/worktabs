const assert = require('node:assert/strict');
const test = require('node:test');
const { prepareCodeServer, wrapperProblem } = require('../src/code-server/startup-preparation');
const { StartupGate } = require('../src/tabs/startup-gate');

test('wrapperProblem names a missing or broken claude wrapper only when Claude is turned on', () => {
  const wrapExe = '/data/bin/claude-wrap';
  assert.equal(wrapperProblem({ agents: ['codex'], platform: 'darwin', wrapExe, exists: false, error: null }), null);
  assert.equal(wrapperProblem({ agents: ['claude'], platform: 'darwin', wrapExe, exists: true, error: null }), null);
  assert.equal(wrapperProblem({ agents: ['claude'], platform: 'win32', wrapExe: 'C:\\claude-wrap.exe', exists: false, error: null }),
    'C:\\claude-wrap.exe is missing. Run npm run build:native.');
  assert.equal(wrapperProblem({ agents: ['claude'], platform: 'darwin', wrapExe, exists: true, error: new Error('read-only') }),
    `Could not set up the claude wrapper (${wrapExe}). read-only`);
  assert.equal(wrapperProblem({ agents: ['claude'], platform: 'darwin', wrapExe, exists: false, error: null }),
    `Could not set up the claude wrapper (${wrapExe}).`);
});

function setup({ config = {}, ensure, install = null, extensions, wrapper = null } = {}) {
  const shown = [];
  const calls = [];
  const startup = new StartupGate();
  const servers = {
    checkInstall: () => install,
    ensureExtensions: extensions || (async (specs) => calls.push(['extensions', specs])),
  };
  const run = () => prepareCodeServer({
    config: { codeServerVersion: '4.0.0', file: '/data/config.json', ...config },
    show: (title, detail, progress) => shown.push(progress === undefined ? [title, detail] : [title, detail, progress]),
    startup,
    ensureCodeServer: ensure || (async (options) => { calls.push(['ensure', options.version]); return '/data/code-server'; }),
    createServers: (dir) => { calls.push(['create', dir]); return servers; },
    made: (made) => calls.push(['made', made === servers]),
    wrapper: () => wrapper,
    specs: () => ['ext'],
    changed: () => calls.push(['changed']),
  });
  return { run, shown, calls, startup, servers };
}

test('code-server is downloaded, the extensions installed, and the gate opened', async () => {
  const { run, shown, calls, startup, servers } = setup();
  assert.equal(await run(), servers);
  assert.equal(startup.status, 'ready');
  assert.deepEqual(calls, [['ensure', '4.0.0'], ['create', '/data/code-server'], ['made', true], ['extensions', ['ext']]]);
  assert.deepEqual(shown.map(([, detail]) => detail), [
    'Preparing code-server 4.0.0…', 'Checking the extensions…', 'Open a worktree from the side bar on the left.',
  ]);
});

test('the page without tabs shows how far the download and the extracting of code-server have gone', async () => {
  const { run, shown } = setup({
    ensure: async ({ onProgress, onExtract }) => {
      onProgress(59, 236);
      onProgress(236, 236);
      onExtract(118, 236);
      return '/data/code-server';
    },
  });
  await run();
  assert.deepEqual(shown.slice(0, 4), [
    ['Worktabs', 'Preparing code-server 4.0.0…'],
    ['Worktabs', 'Downloading code-server 4.0.0… 59 / 236 MB', 0.25],
    ['Worktabs', 'Downloading code-server 4.0.0… 236 / 236 MB', 1],
    ['Worktabs', 'Extracting code-server 4.0.0…', 0.5],
  ]);
  assert.deepEqual(shown[4], ['Worktabs', 'Checking the extensions…']);
});

test('a code-server folder in the settings is used as it is', async () => {
  const { run, calls } = setup({ config: { codeServerDir: '/opt/code-server' } });
  await run();
  assert.deepEqual(calls[0], ['create', '/opt/code-server']);
});

test('each step that fails shows why and fails the gate', async () => {
  const download = setup({ ensure: async () => { throw new Error('offline'); } });
  assert.equal(await download.run(), null);
  assert.equal(download.startup.status, 'failed');
  assert.deepEqual(download.shown.at(-1), ['Could not prepare code-server', 'offline']);
  await assert.rejects(download.startup.wait(), /Could not prepare code-server: offline/);

  const settings = setup({ wrapper: 'claude-wrap.exe is missing.' });
  assert.equal(await settings.run(), null);
  assert.deepEqual(settings.shown.at(-1), ['Settings needed', 'claude-wrap.exe is missing. (settings file: /data/config.json)']);
  assert.deepEqual(settings.calls.at(-1), ['changed']);
  // The control port still comes up, to look into it.
  assert.ok(settings.calls.some(([kind]) => kind === 'made'));

  const install = setup({ install: 'code-server is not installed', wrapper: 'ignored' });
  await install.run();
  assert.match(install.shown.at(-1)[1], /^code-server is not installed/);

  const extensions = setup({ extensions: async () => { throw new Error('gallery down'); } });
  assert.equal(await extensions.run(), null);
  assert.equal(extensions.startup.status, 'failed');
  assert.deepEqual(extensions.shown.at(-1), ['Could not install the extensions', 'gallery down']);
});
