const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { assetName, checksumOf, fetchReleases, newestRelease } = require('../src/self-update/releases');
const { updateTarget } = require('../src/self-update/target');
const { findStagedApp, removeLeftovers, stageRelease, stagingPaths } = require('../src/self-update/stage');
const { readSwapResult, swapCommand, swapScript } = require('../src/self-update/swap');
const { createSelfUpdate } = require('../src/self-update/self-update');

const WIN = { platform: 'win32', arch: 'x64' };
const MAC = { platform: 'darwin', arch: 'arm64' };

function release(version, { draft = false, prerelease = false, assets } = {}) {
  const names = assets || [`Worktabs-${version}-win.zip`, `Worktabs-${version}-arm64-mac.zip`, 'SHA256SUMS.txt'];
  return {
    tag_name: `v${version}`, draft, prerelease, html_url: `https://example.test/v${version}`,
    assets: names.map((name) => ({ name, browser_download_url: `https://example.test/${name}`, size: 10 })),
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'worktabs-self-update-'));
}

test('the asset is the zip for this machine, and none elsewhere', () => {
  assert.equal(assetName('1.2.3', WIN), 'Worktabs-1.2.3-win.zip');
  assert.equal(assetName('1.2.3', MAC), 'Worktabs-1.2.3-arm64-mac.zip');
  assert.equal(assetName('1.2.3', { platform: 'darwin', arch: 'x64' }), null);
  assert.equal(assetName('1.2.3', { platform: 'linux', arch: 'x64' }), null);
});

test('the newest release skips drafts, prereleases, older versions, and releases without the files', () => {
  const releases = [
    release('0.7.0', { draft: true }),
    release('0.6.1-beta.1'),
    release('0.6.2', { prerelease: true }),
    release('0.6.1', { assets: ['Worktabs-0.6.1-win.zip'] }),
    release('0.6.0'),
    release('0.5.9'),
    { tag_name: 'nightly', assets: [] },
  ];
  const found = newestRelease(releases, '0.5.2', WIN);
  assert.deepEqual(found, {
    version: '0.6.0', notesUrl: 'https://example.test/v0.6.0',
    asset: { name: 'Worktabs-0.6.0-win.zip', url: 'https://example.test/Worktabs-0.6.0-win.zip', size: 10 },
    checksumsUrl: 'https://example.test/SHA256SUMS.txt',
  });
  assert.equal(newestRelease(releases, '0.6.0', WIN), null);
  assert.equal(newestRelease(releases, '0.5.2', { platform: 'linux', arch: 'x64' }), null);
  // Not in order from GitHub: the highest version still wins.
  assert.equal(newestRelease([release('0.5.3'), release('0.6.0'), release('0.5.4')], '0.5.2', MAC).version, '0.6.0');
});

test('releases come through gh when it answers, and from the API otherwise', async () => {
  const asked = [];
  const getJson = async (url) => { asked.push(url); return ['api']; };
  assert.deepEqual(await fetchReleases({ runGh: async (args) => JSON.stringify([args.join(' ')]), getJson }), ['api repos/worktabs/worktabs/releases?per_page=10']);
  assert.deepEqual(asked, []);
  assert.deepEqual(await fetchReleases({ runGh: async () => { throw new Error('not signed in'); }, getJson }), ['api']);
  assert.deepEqual(asked, ['https://api.github.com/repos/worktabs/worktabs/releases?per_page=10']);
});

test('the checksum is read from sha256sum output', () => {
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const text = `${a}  Worktabs-1.0.0-setup.exe\r\n${b} *Worktabs-1.0.0-win.zip\n`;
  assert.equal(checksumOf(text, 'Worktabs-1.0.0-win.zip'), 'b'.repeat(64));
  assert.equal(checksumOf(text, 'Worktabs-1.0.0-setup.exe'), a);
  assert.equal(checksumOf(text, 'other.zip'), null);
});

test('only release builds look for releases, and only where the app can be replaced does it update', () => {
  const marker = (resources) => (file) => file === `${resources}${resources.includes('\\') ? '\\' : '/'}native${resources.includes('\\') ? '\\' : '/'}release.json`;
  const win = { execPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\Worktabs\\Worktabs.exe', resourcesPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\Worktabs\\resources', platform: 'win32' };
  assert.deepEqual(updateTarget({ ...win, isPackaged: true, exists: marker(win.resourcesPath) }), { appPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\Worktabs', checkable: true });
  // A build of your own has no marker; running from source is not packaged.
  assert.equal(updateTarget({ ...win, isPackaged: true, exists: () => false }).checkable, false);
  assert.equal(updateTarget({ ...win, isPackaged: false, exists: marker(win.resourcesPath) }).checkable, false);
  const root = updateTarget({ execPath: 'D:\\Worktabs.exe', resourcesPath: 'D:\\resources', platform: 'win32', isPackaged: true, exists: marker('D:\\resources') });
  assert.equal(root.appPath, null);
  assert.equal(root.checkable, true);

  const mac = { execPath: '/Applications/Worktabs.app/Contents/MacOS/Worktabs', resourcesPath: '/Applications/Worktabs.app/Contents/Resources', platform: 'darwin', isPackaged: true };
  assert.deepEqual(updateTarget({ ...mac, exists: marker(mac.resourcesPath) }), { appPath: '/Applications/Worktabs.app', checkable: true });
  const moved = '/private/var/folders/x/AppTranslocation/1234/d/Worktabs.app';
  const translocated = updateTarget({ execPath: `${moved}/Contents/MacOS/Worktabs`, resourcesPath: `${moved}/Contents/Resources`, platform: 'darwin', isPackaged: true, exists: marker(`${moved}/Contents/Resources`) });
  assert.equal(translocated.appPath, null);
  assert.match(translocated.reason, /temporary copy/);
});

// A fake release: the zip's bytes, and an extract that lays out what the zip would hold.
function fakeRelease(dir, { layout, sums } = {}) {
  const bytes = Buffer.from('zip bytes');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const calls = [];
  return {
    calls,
    release: { version: '9.9.9', asset: { name: 'Worktabs-9.9.9-win.zip', url: 'https://example.test/zip' }, checksumsUrl: 'https://example.test/sums' },
    fetchText: async () => sums ?? `${hash}  Worktabs-9.9.9-win.zip\n`,
    download: async (url, file, onProgress) => {
      calls.push(['download', url]);
      onProgress(1, 2);
      fs.writeFileSync(file, bytes);
    },
    extract: async (zip, into) => {
      calls.push(['extract', path.basename(zip), into]);
      (layout || ((root) => {
        fs.writeFileSync(path.join(root, 'Worktabs.exe'), 'new');
        fs.mkdirSync(path.join(root, 'resources', 'native'), { recursive: true });
        fs.writeFileSync(path.join(root, 'resources', 'native', 'release.json'), '{}');
      }))(into);
    },
  };
}

test('staging checks the download, extracts it beside the app, and keeps the uninstaller', async () => {
  const dir = tempDir();
  const appPath = path.join(dir, 'Worktabs');
  fs.mkdirSync(appPath);
  fs.writeFileSync(path.join(appPath, 'Worktabs.exe'), 'old');
  fs.writeFileSync(path.join(appPath, 'Uninstall Worktabs.exe'), 'uninstaller');
  const dataDir = path.join(dir, 'data');
  const fake = fakeRelease(dir);
  const progress = [];
  const result = await stageRelease({ ...fake, appPath, dataDir, platform: 'win32', onProgress: (...args) => progress.push(args) });
  assert.deepEqual(result, { staged: `${appPath}.update`, container: `${appPath}.update` });
  assert.equal(fs.readFileSync(path.join(result.staged, 'Worktabs.exe'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(result.staged, 'Uninstall Worktabs.exe'), 'utf8'), 'uninstaller');
  assert.deepEqual(progress, [[1, 2]]);
  // The zip itself does not stay.
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'app-update')), []);
  // The app is untouched until the swap.
  assert.equal(fs.readFileSync(path.join(appPath, 'Worktabs.exe'), 'utf8'), 'old');
});

test('staging refuses a download that does not match, and a zip without a release', async () => {
  const dir = tempDir();
  const appPath = path.join(dir, 'Worktabs');
  fs.mkdirSync(appPath);
  const dataDir = path.join(dir, 'data');
  const mismatch = fakeRelease(dir, { sums: `${'0'.repeat(64)}  Worktabs-9.9.9-win.zip\n` });
  await assert.rejects(stageRelease({ ...mismatch, appPath, dataDir, platform: 'win32' }), /does not match its checksum/);
  assert.deepEqual(mismatch.calls.map((call) => call[0]), ['download']);
  await assert.rejects(stageRelease({ ...fakeRelease(dir, { sums: '' }), appPath, dataDir, platform: 'win32' }), /has no checksum/);

  const notOurs = fakeRelease(dir, { layout: (root) => fs.writeFileSync(path.join(root, 'Worktabs.exe'), 'x') });
  await assert.rejects(stageRelease({ ...notOurs, appPath, dataDir, platform: 'win32' }), /does not hold a Worktabs release/);
  assert.equal(fs.existsSync(`${appPath}.update`), false);
});

test('the staged app is found at the zip root, in its one folder, or as the .app', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'Worktabs-win'));
  fs.writeFileSync(path.join(dir, 'Worktabs-win', 'Worktabs.exe'), '');
  assert.equal(findStagedApp(dir, 'win32'), path.join(dir, 'Worktabs-win'));
  fs.writeFileSync(path.join(dir, 'Worktabs.exe'), '');
  assert.equal(findStagedApp(dir, 'win32'), dir);
  assert.equal(findStagedApp(dir, 'darwin'), null);
  fs.mkdirSync(path.join(dir, 'Worktabs.app'));
  assert.equal(findStagedApp(dir, 'darwin'), path.join(dir, 'Worktabs.app'));
});

test('leftovers of an update are removed at the next start', () => {
  const dir = tempDir();
  const appPath = path.join(dir, 'Worktabs');
  const { container, old } = stagingPaths(appPath);
  for (const folder of [appPath, container, old]) fs.mkdirSync(path.join(folder, 'x'), { recursive: true });
  removeLeftovers(appPath);
  assert.deepEqual(fs.readdirSync(dir), ['Worktabs']);
});

test('the Windows swap starts PowerShell through cmd, with its values in the environment', () => {
  const options = {
    platform: 'win32', pid: 42, appPath: "C:\\Programs\\Work'tabs", staged: "C:\\Programs\\Work'tabs.update", container: 'C:\\c', old: 'C:\\o',
    version: '1.0.0', result: 'C:\\r.json', relaunch: true,
  };
  const { command, args, env, verbatim } = swapCommand(options);
  assert.equal(command, 'cmd.exe');
  assert.deepEqual(args.slice(0, 6), ['/d', '/c', 'start', '""', '/min', 'powershell.exe']);
  assert.equal(args.at(-2), '-EncodedCommand');
  assert.equal(verbatim, true);
  assert.match(Buffer.from(args.at(-1), 'base64').toString('utf16le'), /DisplayVersion/);
  assert.deepEqual(JSON.parse(env.WORKTABS_SWAP), {
    pid: 42, appPath: "C:\\Programs\\Work'tabs", staged: "C:\\Programs\\Work'tabs.update", container: 'C:\\c', old: 'C:\\o',
    version: '1.0.0', result: 'C:\\r.json', relaunch: true, tries: 60,
  });
  // cmd refuses a command line longer than 8191 characters, so it must not grow with the paths.
  assert.deepEqual(swapCommand({ ...options, appPath: `C:\\${'x'.repeat(240)}` }).args, args);
  assert.ok([command, ...args].join(' ').length < 8191);
});

// The PowerShell script itself, started as main.js starts it. It reports before it removes what
// it no longer needs, so `done` says when it has finished.
async function windowsSwap(options, done) {
  const { command, args, env, verbatim } = swapCommand({ platform: 'win32', version: '9.9.9', relaunch: false, ...options });
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim, env: { ...process.env, ...env } }).unref();
  const deadline = Date.now() + 60000;
  for (;;) {
    let result = null;
    // Busy while PowerShell writes it.
    try { result = readSwapResult(fs.readFileSync(options.result, 'utf8')); } catch {}
    if (result && done()) return result;
    if (Date.now() > deadline) throw new Error('The swap did not finish.');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('the PowerShell swap waits for the app to exit, then puts the new folder in place', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDir();
  const app = path.join(dir, 'Worktabs');
  const container = `${app}.update`;
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'version'), 'old');
  fs.mkdirSync(container);
  fs.writeFileSync(path.join(container, 'version'), 'new');
  const result = path.join(dir, 'result.json');
  const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
  let exited = 0;
  running.on('exit', () => { exited = Date.now(); });
  const outcome = await windowsSwap({ pid: running.pid, appPath: app, staged: container, container, old: `${app}.old`, result }, () => !fs.existsSync(`${app}.old`));
  assert.deepEqual(outcome, { version: '9.9.9', ok: true, error: '' });
  assert.ok(exited && fs.statSync(result).mtimeMs >= exited, 'it waited for the app');
  assert.equal(fs.readFileSync(path.join(app, 'version'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Worktabs', 'result.json']);
});

// Holds a file open without sharing, as antivirus can, from another program: Node shares what it
// opens. The returned function lets it go.
async function holdFile(file) {
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f = [IO.File]::Open($env:HELD, 'Open', 'Read', 'None'); 'held'; [void][Console]::In.ReadLine()"],
  { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, HELD: file } });
  await new Promise((resolve, reject) => {
    holder.stdout.once('data', resolve);
    holder.once('exit', () => reject(new Error(`Could not hold ${file}.`)));
  });
  return () => new Promise((resolve) => { holder.once('exit', resolve); holder.stdin.end(); });
}

test('the PowerShell swap leaves the app whole when a file in it is held', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDir();
  const app = path.join(dir, 'Worktabs');
  const container = `${app}.update`;
  fs.mkdirSync(path.join(app, 'sub'), { recursive: true });
  const files = ['a.dll', 'held.txt', 'z.exe', path.join('sub', 's.bin')];
  for (const file of files) fs.writeFileSync(path.join(app, file), 'old');
  fs.mkdirSync(container);
  fs.writeFileSync(path.join(container, 'version'), 'new');
  const result = path.join(dir, 'result.json');
  const release = await holdFile(path.join(app, 'held.txt'));
  let outcome;
  try {
    outcome = await windowsSwap({ pid: 999999, appPath: app, staged: container, container, old: `${app}.old`, result, tries: 2 }, () => !fs.existsSync(container));
  } finally {
    await release();
  }
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Worktabs', 'result.json']);
  for (const file of files) assert.equal(fs.readFileSync(path.join(app, file), 'utf8'), 'old');
});

test('the swap result is read, with or without a byte order mark', () => {
  assert.deepEqual(readSwapResult('\uFEFF{"version":"1.0.0","ok":false,"error":"Still running: claude-wrap.exe"}'), { version: '1.0.0', ok: false, error: 'Still running: claude-wrap.exe' });
  assert.deepEqual(readSwapResult('{"version":"1.0.0","ok":true}'), { version: '1.0.0', ok: true, error: '' });
  assert.equal(readSwapResult('{"ok":true}'), null);
  assert.equal(readSwapResult('not json'), null);
});

// The macOS script itself, with /bin/sh: it waits for the app, swaps, and reports.
test('the shell swap waits for the app to exit, then puts the new app in place', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDir();
  const app = path.join(dir, 'Worktabs.app');
  const container = path.join(dir, 'Worktabs.app.update');
  const staged = path.join(container, 'Worktabs.app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'version'), 'old');
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, 'version'), 'new');
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(script, swapScript());
  const result = path.join(dir, 'result.json');
  const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)']);
  const { command, args } = swapCommand({ platform: 'darwin', pid: running.pid, appPath: app, staged, container, old: `${app}.old`, version: '9.9.9', result, relaunch: false, script });
  const started = Date.now();
  // Not spawnSync: the event loop must keep running to reap the app, or it stays a zombie that
  // `kill -0` still finds.
  const swap = spawn(command, args, { stdio: 'ignore' });
  const status = await new Promise((resolve) => swap.on('exit', resolve));
  assert.equal(status, 0);
  assert.ok(Date.now() - started >= 400, 'it waited for the app');
  assert.equal(fs.readFileSync(path.join(app, 'version'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Worktabs.app', 'result.json', 'swap.sh']);
  assert.deepEqual(readSwapResult(fs.readFileSync(result, 'utf8')), { version: '9.9.9', ok: true, error: '' });
});

test('the shell swap puts the app back when the new one cannot move in', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  const app = path.join(dir, 'Worktabs.app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'version'), 'old');
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(script, swapScript());
  const result = path.join(dir, 'result.json');
  const { command, args } = swapCommand({ platform: 'darwin', pid: 999999, appPath: app, staged: path.join(dir, 'missing.app'), container: path.join(dir, 'c'), old: `${app}.old`, version: '9.9.9', result, relaunch: false, script });
  const out = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(out.status, 1);
  assert.equal(fs.readFileSync(path.join(app, 'version'), 'utf8'), 'old');
  assert.deepEqual(readSwapResult(fs.readFileSync(result, 'utf8')), { version: '9.9.9', ok: false, error: 'move' });
});

function service(overrides = {}) {
  const calls = [];
  let skipped = '';
  const found = { version: '0.6.0', notesUrl: 'https://example.test/v0.6.0' };
  const deps = {
    currentVersion: '0.5.2',
    appPath: '/Applications/Worktabs.app',
    find: async () => found,
    stage: async (_release, onProgress) => { onProgress(5, 100); return { staged: '/s', container: '/c' }; },
    swap: (staged, version, relaunch) => calls.push(['swap', staged.staged, version, relaunch]),
    risks: async () => ({ busy: [], unobserved: false }),
    quit: () => calls.push(['quit']),
    skipped: () => skipped,
    skip: (version) => { skipped = version; },
    lastResult: () => null,
    messageBox: (options) => calls.push(['message', options.message]),
    changed: () => {},
    log: () => {},
    sleep: async () => {},
    now: (() => { let time = 0; return () => (time += 2000); })(),
    ...overrides,
  };
  return { update: createSelfUpdate(deps), calls };
}

test('a found version is offered, downloaded on request, and swapped in when the app quits', async () => {
  const { update, calls } = service();
  update.onQuit();
  assert.deepEqual(calls, [], 'nothing to swap yet');
  await update.check();
  assert.deepEqual(update.state, { status: 'available', version: '0.6.0', from: '0.5.2', notesUrl: 'https://example.test/v0.6.0', canApply: true, detail: '' });
  await update.start();
  assert.equal(update.state.status, 'ready');
  // A check meanwhile does not take the card back.
  await update.check();
  assert.equal(update.state.status, 'ready');
  update.onQuit();
  assert.deepEqual(calls, [['swap', '/s', '0.6.0', false]]);
});

test('restarting waits for the busy tabs, can be canceled, and then quits to relaunch', async () => {
  let busy = ['repo-a'];
  let rounds = 0;
  const { update, calls } = service({
    risks: async () => ({ busy, unobserved: false }),
    sleep: async () => { if (++rounds === 2) busy = []; },
  });
  await update.check();
  await update.start();
  await update.restart();
  assert.deepEqual(calls, [['quit']]);
  assert.equal(rounds, 2);
  update.onQuit();
  assert.deepEqual(calls.at(-1), ['swap', '/s', '0.6.0', true]);

  // Canceled from the card while it waits.
  const second = service({ risks: async () => ({ busy: ['repo-b'], unobserved: false }), sleep: async () => second.update.cancel() });
  await second.update.check();
  await second.update.start();
  await second.update.restart();
  assert.equal(second.update.state.status, 'ready');
  assert.deepEqual(second.calls, []);
});

test('a canceled quit after restarting only installs at the next quit', async () => {
  const { update, calls } = service();
  await update.check();
  await update.start();
  await update.restart();
  update.quitCanceled();
  update.onQuit();
  assert.deepEqual(calls, [['quit'], ['swap', '/s', '0.6.0', false]]);
});

test('a skipped version is not offered again unless asked for', async () => {
  const { update, calls } = service();
  await update.check();
  update.skipVersion();
  assert.equal(update.state.status, 'none');
  await update.check();
  assert.equal(update.state.status, 'none');
  await update.check({ manual: true });
  assert.equal(update.state.status, 'available');
  assert.deepEqual(calls, []);
});

test('the menu says when there is nothing newer or the check fails', async () => {
  const none = service({ find: async () => null });
  await none.update.check({ manual: true });
  assert.deepEqual(none.calls, [['message', 'Worktabs 0.5.2 is the newest version.']]);
  const failing = service({ find: async () => { throw new Error('offline'); } });
  await failing.update.check();
  assert.deepEqual(failing.calls, []);
  await failing.update.check({ manual: true });
  assert.deepEqual(failing.calls, [['message', 'Could not check for a new version of Worktabs: offline']]);
});

test('where the app cannot replace itself, the version is offered for a download by hand', async () => {
  const { update } = service({ appPath: null, reason: 'Worktabs is not in an app bundle.' });
  await update.check();
  assert.equal(update.state.canApply, false);
  assert.equal(update.state.detail, 'Worktabs is not in an app bundle.');
  await update.start();
  assert.equal(update.state.status, 'available');
});

test('a failed download is shown and can be tried again', async () => {
  let attempts = 0;
  const { update } = service({ stage: async () => { if (++attempts === 1) throw new Error('HTTP 404'); return { staged: '/s', container: '/c' }; } });
  await update.check();
  await update.start();
  assert.equal(update.state.status, 'failed');
  assert.equal(update.state.detail, 'HTTP 404');
  await update.start();
  assert.equal(update.state.status, 'ready');
});

test('the last swap is reported once at the next start', async () => {
  const done = service({ currentVersion: '0.6.0', lastResult: () => ({ version: '0.6.0', ok: true, error: '' }) });
  done.update.showLastResult();
  assert.equal(done.update.state.status, 'done');
  assert.equal(done.update.state.version, '0.6.0');

  const failed = service({ lastResult: () => ({ version: '0.6.0', ok: false, error: 'wait' }) });
  failed.update.showLastResult();
  assert.equal(failed.update.state.status, 'failed');
  assert.match(failed.update.state.detail, /did not quit in time/);
  for (const error of ["Access to the path 'C:\\W' is denied.", "パス 'C:\\W' へのアクセスが拒否されました。"]) {
    const denied = service({ lastResult: () => ({ version: '0.6.0', ok: false, error }) });
    denied.update.showLastResult();
    assert.equal(denied.update.state.detail, `${error.slice(0, -1)}. The previous version stays.`);
  }
  // The check that follows keeps the failure on the card, with a way to try again.
  await failed.update.check();
  assert.equal(failed.update.state.status, 'failed');
  assert.equal(failed.update.state.canApply, true);
});
