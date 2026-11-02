const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const test = require('node:test');
const { prepareCodex } = require('../src/codex/codex-launch');
const { eventQueue, jsonScanner, run } = require('../src/codex/codex-wrap');
const { HookServer } = require('../src/conversations/hooks');
const { localFiles } = require('../src/code-server/code-server');
const { tempDir } = require('./support');
const { ERROR, MESSAGES, OUTPUT } = require('./codex-wrap-fixture');

test('the Codex scanner handles byte splits, CRLF, malformed and oversized lines', () => {
  const messages = [];
  const scan = jsonScanner((message) => messages.push(message), 1000);
  const buffer = Buffer.from('invalid\n' + JSON.stringify(MESSAGES[0]) + '\r\n' + 'x'.repeat(2000) + '\n' + JSON.stringify(MESSAGES[1]) + '\n');
  for (const byte of buffer) scan(Buffer.from([byte]));
  assert.deepEqual(messages, MESSAGES.slice(0, 2));
});

test('the Codex event queue keeps transitions ordered without holding up the pipes', async () => {
  const sent = [];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const queue = eventQueue(async (event) => { if (!sent.length) await first; sent.push(event); });
  queue.push({ threadId: 't', state: 'working' });
  queue.push({ threadId: 't', state: 'waiting', title: 'old' });
  queue.push({ threadId: 't', state: 'waiting', title: 'new' });
  queue.push({ threadId: 't', state: 'done' });
  queue.push({ type: 'codex-account', authMode: null });
  queue.push({ type: 'codex-usage', buckets: [] });
  assert.deepEqual(sent, []);
  release();
  await queue.flush();
  assert.deepEqual(sent.filter((e) => e.threadId).map((e) => [e.state, e.title]), [['working', undefined], ['waiting', 'new'], ['done', undefined]]);
  assert.deepEqual(sent.filter((e) => e.type).map((e) => e.type), ['codex-account', 'codex-usage']);
});

test('a folded thread load still tells the app to read the chat', async () => {
  const sent = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const queue = eventQueue(async (event) => { await blocked; sent.push(event); });
  queue.push({ threadId: 'busy', state: 'working' });
  queue.push({ threadId: 't', state: 'idle', loaded: true });
  queue.push({ threadId: 't', state: 'idle', title: 'named' });
  release();
  await queue.flush();
  assert.deepEqual(sent.at(-1), { threadId: 't', state: 'idle', title: 'named', loaded: true });
});

test('the Codex event queue keeps closure, deletion, restore failures and quota events distinct', async () => {
  const sent = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const queue = eventQueue(async (event) => { await blocked; sent.push(event); });
  const events = [
    { threadId: 't', state: 'working' },
    { threadId: 't', ended: true, reason: 'closed' },
    { threadId: 't', ended: true, reason: 'archived' },
    { threadId: 't', ended: true, reason: 'deleted' },
    { threadId: 't', restoreFailed: true },
    { threadId: 't', state: 'idle', prompt: 'latest' },
    { type: 'codex-account', authMode: null },
    { type: 'codex-account', authMode: 'chatgpt' },
    { type: 'codex-usage', buckets: [] },
    { type: 'codex-usage', buckets: [{ limitId: 'codex' }] },
  ];
  for (const event of events) queue.push(event);
  release();
  await queue.flush();
  assert.deepEqual(sent, events);
});

function fixture(t) {
  const dir = tempDir(t);
  const args = ['space here', 'quote"here', '日本語', 'C:\\path with spaces\\', ''];
  const input = '{"id":0,"result":{"decision":"decline"}}';
  const expected = path.join(dir, 'expected.json');
  fs.writeFileSync(expected, JSON.stringify({ args, input }));
  return { dir, args: [path.join(__dirname, 'codex-wrap-fixture.js'), 'app-server', expected, ...args], input };
}

test('the Codex node proxy preserves arguments, decisions, output, stderr and exit status', { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
  let out = '', err = '';
  output.setEncoding('utf8').on('data', (text) => { out += text; });
  error.setEncoding('utf8').on('data', (text) => { err += text; });
  const events = [];
  const done = run({ binary: process.execPath, args: f.args, input, output, error, send: async (event) => { events.push(event); } });
  input.write(`${f.input}\n`);
  assert.equal(await done, 7);
  input.destroy();
  assert.equal(out, OUTPUT);
  assert.equal(err, ERROR);
  assert.deepEqual(events.filter((e) => e.threadId).map((e) => e.state), ['idle', 'working', 'waiting', 'working', 'done']);
  assert.equal(events.at(-1).buckets[0].primary.usedPercent, 42);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_CREDITS/);
  assert.equal(events[0].title, '日本語');
});

test('prepareCodex selects the extension CLI and installs a quoted macOS/WSL launcher', async () => {
  for (const [platform, arch, target] of [['darwin', 'arm64', 'macos-aarch64'], ['linux', 'x64', 'linux-x86_64']]) {
    const store = new Map([['/extensions/extensions.json', JSON.stringify([{ identifier: { id: 'OpenAI.chatgpt' }, relativeLocation: 'openai.chatgpt-1' }])]]);
    const modes = [];
    const files = { join: path.posix.join, read: async (file) => store.get(file), write: async (file, value) => store.set(file, value), chmod: async (...args) => modes.push(args) };
    const wrapper = await prepareCodex({ files, extensionsDir: '/extensions', dir: "/app's data/codex", node: '/node with spaces', platform, arch });
    assert.equal(wrapper, "/app's data/codex/codex-wrap");
    assert.deepEqual(modes, [[wrapper, 0o755]]);
    assert.ok(store.get(wrapper).includes("exec '/node with spaces' '/app'\\''s data/codex/codex-wrap.js' \"$@\""));
    assert.deepEqual(JSON.parse(store.get("/app's data/codex/codex-launch.json")), { node: '/node with spaces', binary: `/extensions/openai.chatgpt-1/bin/${target}/codex` });
  }
});

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const skip = process.platform !== 'win32' || !fs.existsSync(CSC) ? 'needs Windows and its C# compiler' : false;

test('the Windows Codex launcher inherits the extension pipes and posts with its watched PID', { skip, timeout: 20000 }, async (t) => {
  const f = fixture(t);
  const native = path.join(f.dir, 'launcher.exe');
  execFileSync(CSC, ['-nologo', '-target:exe', '-platform:x64', '-r:System.Web.Extensions.dll', `-out:${native}`, path.join(__dirname, '..', 'native', 'CodexWrap.cs')]);
  const extensions = path.join(f.dir, 'extensions');
  fs.mkdirSync(extensions);
  fs.writeFileSync(path.join(extensions, 'extensions.json'), JSON.stringify([{ identifier: { id: 'openai.chatgpt' }, relativeLocation: 'openai.chatgpt-1' }]));
  const dir = path.join(f.dir, 'proxy with spaces');
  const exe = await prepareCodex({ files: localFiles, extensionsDir: extensions, dir, node: process.execPath, nativeLauncher: native });
  fs.writeFileSync(path.join(dir, 'codex-launch.json'), JSON.stringify({ node: process.execPath, binary: process.execPath }));
  const server = new HookServer();
  await server.listen();
  t.after(() => server.close());
  const events = [];
  server.on('codex', (...args) => events.push(args));
  const quota = [];
  server.on('codex-usage', (...args) => quota.push(args));
  const child = spawn(exe, f.args, { windowsHide: true, env: { ...process.env, WORKTABS_HOOK_URL: server.url, WORKTABS_HOOK_TOKEN: server.token, WORKTABS_TAB_ID: 'tab' } });
  t.after(() => child.kill());
  let out = '', err = '';
  child.stdout.setEncoding('utf8').on('data', (text) => { out += text; });
  child.stderr.setEncoding('utf8').on('data', (text) => { err += text; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  child.stdin.write(`${f.input}\n`);
  assert.equal(await done, 7);
  assert.equal(out, OUTPUT);
  assert.equal(err, ERROR);
  assert.deepEqual(events.map(([, e]) => e.state), ['idle', 'working', 'waiting', 'working', 'done']);
  assert.ok(events.every(([tab, , pid]) => tab === 'tab' && pid === String(child.pid)));
  assert.deepEqual(quota.map(([, e]) => e.type), ['codex-account', 'codex-usage']);
  assert.equal(quota[1][1].buckets[0].primary.usedPercent, 42);
  assert.ok(quota.every(([tab, , pid]) => tab === 'tab' && pid === String(child.pid)));
  assert.doesNotMatch(JSON.stringify(quota), /PRIVATE_CREDITS/);
});

test('killing the Windows Codex launcher stops node and the app-server process tree', { skip, timeout: 15000 }, async (t) => {
  const dir = tempDir(t);
  const exe = path.join(dir, 'codex-wrap.exe');
  execFileSync(CSC, ['-nologo', '-target:exe', '-platform:x64', '-r:System.Web.Extensions.dll', `-out:${exe}`, path.join(__dirname, '..', 'native', 'CodexWrap.cs')]);
  for (const name of ['codex-wrap.js', 'codex-events.js', 'codex-quota.js']) fs.copyFileSync(path.join(__dirname, '..', 'src', 'codex', name), path.join(dir, name));
  fs.writeFileSync(path.join(dir, 'codex-launch.json'), JSON.stringify({ node: process.execPath, binary: process.execPath }));
  const script = path.join(dir, 'app-server.js');
  const pidsFile = path.join(dir, 'pids.json');
  fs.writeFileSync(script, `const fs = require('fs');
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`);
  const child = spawn(exe, [script, pidsFile, 'app-server'], { windowsHide: true });
  t.after(() => child.kill());
  t.signal.addEventListener('abort', () => child.kill(), { once: true });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(pidsFile) && Date.now() < deadline) await sleep(20);
  const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(pids.every(alive));
  const ended = new Promise((resolve) => child.once('close', resolve));
  child.kill();
  await ended;
  for (let i = 0; i < 100 && pids.some(alive); i++) await sleep(20);
  assert.ok(pids.every((pid) => !alive(pid)));
});
