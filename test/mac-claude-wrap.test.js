// The claude wrapper on macOS, which claude-wrap.exe is on Windows. The tests run it through
// the shell script installWrapper writes, as the extension does, so they cover both.
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { HookServer } = require('../src/conversations/hooks');
const { installWrapper, shellQuote, usageScanner, wrapperScript } = require('../src/agents/mac-claude-wrap');
const { tempDir } = require('./support');
const { EXPECTED_CODE, EXPECTED_ERR, EXPECTED_OUT, REORDERED, USAGE, runWrapper, settingsCases, writeChild } = require('./wrap-fixture');

// The script is sh, and the program runs on whatever node started the test.
const skip = process.platform === 'win32' ? 'needs a POSIX shell' : false;

// Reports what reached claude, as the wrapper started it.
const ARGS_CHILD = `
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  procId: process.env.WORKTABS_PROC_ID,
  electron: process.env.ELECTRON_RUN_AS_NODE || '',
}));
`;

// The stand-in for claude as one program (see settingsCases): an sh script that runs ARGS_CHILD.
function writeArgsChild(dir) {
  const script = path.join(dir, 'args-child.js');
  fs.writeFileSync(script, ARGS_CHILD);
  const child = path.join(dir, 'args-child');
  fs.writeFileSync(child, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
  fs.chmodSync(child, 0o755);
  return child;
}

async function hookServer(t) {
  const server = new HookServer();
  await server.listen();
  t.after(() => server.close());
  return server;
}

function wrapperEnv(server, extra = {}) {
  const env = {
    ...process.env,
    WORKTABS_HOOK_URL: server.url,
    WORKTABS_HOOK_TOKEN: server.token,
    WORKTABS_TAB_ID: 'tab1',
    ...extra,
  };
  if (!extra.WORKTABS_CLAUDE_SETTINGS) delete env.WORKTABS_CLAUDE_SETTINGS;
  return env;
}

test('the wrapper passes claude\'s output through as it comes, and posts the rate_limit_event lines', { skip, timeout: 60000 }, async (t) => {
  const dir = tempDir(t);
  const wrapper = installWrapper({ dir, exe: process.execPath });
  const claude = writeChild(dir);

  const server = await hookServer(t);
  const usage = [];
  const hooks = [];
  server.on('usage', (input) => usage.push(input));
  server.on('hook', (...args) => hooks.push(args));

  const { code, out, err } = await runWrapper(wrapper, claude, wrapperEnv(server));

  assert.equal(code, EXPECTED_CODE);
  assert.equal(out, EXPECTED_OUT);
  assert.equal(err, EXPECTED_ERR);
  // Posted in order, before the wrapper exits.
  assert.deepEqual(usage, [JSON.parse(USAGE), JSON.parse(REORDERED)]);
  assert.deepEqual(hooks, []);
});

test('the wrapper adds the app\'s settings to a session, and names itself in claude\'s environment', { skip, timeout: 30000 }, async (t) => {
  const dir = tempDir(t);
  const wrapper = installWrapper({ dir, exe: process.execPath });
  const child = writeArgsChild(dir);
  const settings = path.join(dir, 'hook settings.json');

  const server = await hookServer(t);
  for (const { args, expected } of settingsCases(settings)) {
    const proc = spawn(wrapper, [child, ...args], {
      env: wrapperEnv(server, { WORKTABS_CLAUDE_SETTINGS: settings }),
    });
    let out = '';
    proc.stdout.on('data', (chunk) => (out += chunk));
    const code = await new Promise((resolve) => proc.on('close', resolve));

    assert.equal(code, 0, `with ${args.join(' ') || 'no arguments'}`);
    assert.deepEqual(JSON.parse(out), {
      args: expected,
      // The wrapper's own id: the app watches it to see the panel's claude end. The shell script
      // runs the program with exec, so the id is the one the app started.
      procId: String(proc.pid),
      // Set for the wrapper alone; claude must not run as node.
      electron: '',
    });
  }
});

test('--hook posts what it is given to the app, and says nothing to claude', { skip, timeout: 30000 }, async (t) => {
  const dir = tempDir(t);
  const wrapper = installWrapper({ dir, exe: process.execPath });
  const server = await hookServer(t);
  const hooks = [];
  server.on('hook', (...args) => hooks.push(args));

  const input = { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup', text: '日本語' };
  const proc = spawn(wrapper, ['--hook'], { env: wrapperEnv(server, { WORKTABS_PROC_ID: '4242' }) });
  let out = '';
  proc.stdout.on('data', (chunk) => (out += chunk));
  proc.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolve) => proc.on('close', resolve));

  assert.equal(code, 0);
  assert.equal(out, '');
  assert.deepEqual(hooks, [['tab1', input, '4242']]);
});

test('--hook gives up quietly when the app is not there', { skip, timeout: 30000 }, async (t) => {
  const dir = tempDir(t);
  const wrapper = installWrapper({ dir, exe: process.execPath });
  // A port nothing listens on, and no URL at all.
  for (const url of ['http://127.0.0.1:1/hook', '']) {
    const env = { ...process.env, WORKTABS_HOOK_URL: url };
    const proc = spawn(wrapper, ['--hook'], { env });
    proc.stdin.end('{"hook_event_name":"SessionStart"}');
    assert.equal(await new Promise((resolve) => proc.on('close', resolve)), 0, `with ${url || 'no url'}`);
  }
});

test('the wrapper reports a claude it cannot run, instead of looking like one that said nothing', { skip, timeout: 30000 }, async (t) => {
  const dir = tempDir(t);
  const wrapper = installWrapper({ dir, exe: process.execPath });
  const proc = spawn(wrapper, [path.join(dir, 'not-here')], { env: { ...process.env } });
  let err = '';
  proc.stderr.on('data', (chunk) => (err += chunk));
  const code = await new Promise((resolve) => proc.on('close', resolve));

  assert.notEqual(code, 0);
  assert.match(err, /not-here/);
});

// Windows keeps no execute bits, so there only what is written is checked.
function assertExecutable(file) {
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o111, 0o111);
}

test('installWrapper writes a runnable script beside the program, and rewrites both', (t) => {
  const dir = tempDir(t);
  const wrapper = installWrapper({ dir, exe: '/Applications/My App.app/Contents/MacOS/My App' });
  assert.equal(wrapper, path.join(dir, 'claude-wrap'));
  assertExecutable(wrapper);
  assert.equal(
    fs.readFileSync(path.join(dir, 'mac-claude-wrap.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'agents', 'mac-claude-wrap.js'), 'utf8'),
  );

  // A wrapper left by an older version is replaced, keeping the mode.
  fs.writeFileSync(wrapper, 'stale\n');
  fs.chmodSync(wrapper, 0o600);
  installWrapper({ dir, exe: process.execPath });
  assert.match(fs.readFileSync(wrapper, 'utf8'), /^#!\/bin\/sh\n/);
  assertExecutable(wrapper);
});

test('the wrapper script quotes the paths it runs', () => {
  const script = wrapperScript("/Apps/It's Here/node", '/tmp/a b/mac-claude-wrap.js');
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.ok(script.endsWith(`exec '/Apps/It'\\''s Here/node' '/tmp/a b/mac-claude-wrap.js' "$@"\n`), script);
  assert.equal(shellQuote('plain'), "'plain'");
});

test('usageScanner finds the event lines, however the output is cut up', () => {
  const lines = [];
  const scan = usageScanner((line) => lines.push(line.toString()));
  const event = '{"type":"rate_limit_event","a":1}';
  // A line split across chunks, one chunk holding several lines, and text that names the event
  // without being one (its quotes are escaped there).
  for (const chunk of ['{"type":"assistant"}\n{"text":"\\"type\\":\\"rate_limit_event\\""}\n', event.slice(0, 7), event.slice(7), '\nplain\n']) {
    scan(Buffer.from(chunk));
  }
  assert.deepEqual(lines, [event]);
});

test('usageScanner leaves out a line too long to be the event, and takes the next one', () => {
  const lines = [];
  const scan = usageScanner((line) => lines.push(line.toString()));
  const event = '{"type":"rate_limit_event"}';
  scan(Buffer.from(`{"type":"rate_limit_event","text":"${'x'.repeat(100000)}"}\n`));
  scan(Buffer.from(`${event}\n`));
  assert.deepEqual(lines, [event]);
  // The end of an unfinished line never comes out on its own.
  scan(Buffer.from('{"type":"rate_limit_event"'));
  assert.deepEqual(lines, [event]);
});
