// Smoke check on Linux: starts the whole app (Electron under Xvfb, with the Linux build of
// code-server) in a folder of its own, and drives it through the development control port as a
// person would: tabs and VS Code, adding and removing a worktree, cloning, the dialogs, the side
// bar's IPC, and stopping. For changes that the unit tests cannot see (main.js, the pages, the
// code-server managers) on a machine without Windows or macOS, as in a cloud session. It does not
// replace the checks on a real machine (docs/development.md).
//
// Nothing of the person's own is used: a new data folder and settings file, a git repository it
// makes, a stand-in Claude Code extension (Open VSX may be out of reach), and stand-ins for gh
// and ghq on PATH. code-server is downloaded once into the cache folder. Cloning clones
// github.com/octocat/Hello-World for real; --offline leaves that out.
//
// usage: node scripts/smoke-check.js [--work <folder>] [--cache <folder>] [--port <n>] [--offline] [--keep]
//   needs: Linux, xvfb-run (or a DISPLAY), curl and tar, and Electron's binary
//   (node node_modules/electron/install.js; see docs/development.md)
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const flag = (name) => args.includes(name);
const WORK = path.resolve(option('--work', path.join(os.tmpdir(), 'worktabs-smoke')));
const CACHE = path.resolve(option('--cache', path.join(os.homedir(), '.cache', 'worktabs-smoke')));
const PORT = Number(option('--port', 47831));
const OFFLINE = flag('--offline');
const KEEP = flag('--keep');
// dev-lib reads the port when it is loaded, and the token on each call; the app takes both.
process.env.WORKTABS_CONTROL_PORT = String(PORT);
process.env.WORKTABS_CONTROL_TOKEN = require('crypto').randomBytes(24).toString('hex');
const { call, log, sleep, until } = require('./dev-lib');

// ---- Preparing ---------------------------------------------------------------------------------

function need(ok, message) {
  if (!ok) {
    console.error(message);
    process.exit(2);
  }
}

const has = (command) => {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// The Linux release of the code-server version the app is set up for, extracted in the cache.
function codeServer() {
  const { DEFAULTS } = require('../src/config');
  const version = DEFAULTS.codeServerVersion;
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  need(arch, `no code-server release for ${process.arch}`);
  const name = `code-server-${version}-linux-${arch}`;
  const dir = path.join(CACHE, name);
  if (fs.existsSync(path.join(dir, 'lib', 'node'))) return dir;
  fs.mkdirSync(CACHE, { recursive: true });
  const archive = path.join(CACHE, `${name}.tar.gz`);
  log(`downloading ${name}`);
  execFileSync('curl', ['-fsSL', '-o', archive, `https://github.com/coder/code-server/releases/download/v${version}/${name}.tar.gz`], { stdio: 'inherit' });
  execFileSync('tar', ['-xzf', archive, '-C', CACHE]);
  fs.rmSync(archive, { force: true });
  return dir;
}

// A ZIP archive of `files` (name -> text), stored without compression: enough for a VSIX.
function zip(files) {
  const table = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = (data) => {
    let c = -1;
    for (const byte of data) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const file = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(file.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, file, data);
    centrals.push(central, file);
    offset += local.length + file.length + data.length;
  }
  const size = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// The Claude Code extension, as an empty stand-in under its id, installed into `dir` by
// code-server: the app installs the real one from Open VSX only when it is missing.
function standInExtension(serverDir, dir) {
  const vsix = path.join(WORK, 'claude-code-stand-in.vsix');
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="claude-code" Version="0.0.1" Publisher="Anthropic"/><DisplayName>Stand-in</DisplayName><Description xml:space="preserve">Stand-in for the smoke check</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`;
  fs.writeFileSync(vsix, zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>',
    'extension.vsixmanifest': manifest,
    'extension/package.json': JSON.stringify({ name: 'claude-code', publisher: 'Anthropic', version: '0.0.1', displayName: 'Stand-in', engines: { vscode: '^1.80.0' } }),
  }));
  execFileSync(path.join(serverDir, 'bin', 'code-server'), ['--extensions-dir', dir, '--install-extension', vsix], { stdio: 'ignore' });
}

// gh signed in to github.com with one repository of its own, and ghq listing one repository.
function standInCommands(bin, ghqRepo) {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "auth status") echo '{"hosts":{"github.com":[{"state":"success","active":true,"login":"octocat"}]}}' ;;
  "config get") echo https ;;
  "api --hostname")
    case "$*" in *graphql*) exit 1 ;; esac
    echo '{"owner":"octocat","type":"User","name":"Hello-World","url":"https://github.com/octocat/Hello-World","fork":false,"archived":false,"visibility":"PUBLIC","description":"","pushed":"2024-01-01T00:00:00Z"}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ghq'), `#!/bin/sh
case "$1" in
  list) echo '${ghqRepo}' ;;
  root) echo '${path.dirname(path.dirname(path.dirname(ghqRepo)))}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
}

function git(cwd, ...gitArgs) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.email=smoke@example.com', '-c', 'user.name=smoke', ...gitArgs], { encoding: 'utf8' });
}

// ---- Checks ------------------------------------------------------------------------------------

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
// Waits as `until` does, and resolves null instead of failing, for a check that reports it.
const waitFor = (what, test, ms = 30000) => until(what, async () => test(), ms, 300).catch(() => null);
const pageText = (id) => call('eval', { id, js: 'document.body.innerText' });
// Calls the page's preload (window.host) and resolves what it answered.
const inPage = (id, js) => call('eval', { id, js: `(async () => JSON.stringify(await (${js})))()` }).then((r) => JSON.parse(r ?? 'null'));
const tabOf = async (test) => (await call('state')).tabs.find(test);

async function checks({ repo, ghqRepo, configFile }) {
  await until('the control port', () => call('state'), 60000, 500);
  check('the app starts and the control port answers', true);
  check('the UI is in English', (await call('language')) === 'en');
  check('the side bar lists the configured repository', await waitFor('the repository', async () => (await pageText('sidebar')).includes('smoke-repo')));
  await waitFor('the ghq repository', async () => (await pageText('sidebar')).includes('from-ghq'));
  const fromGhq = (await inPage('sidebar', 'window.host.getRepos()')).repos.find((r) => r.path === ghqRepo);
  check('the side bar lists what ghq lists, from ghq', fromGhq && fromGhq.sources.includes('ghq'), JSON.stringify(fromGhq?.sources));
  check('the side bar takes a theme', ['light', 'dark'].includes(await call('eval', { id: 'sidebar', js: 'document.documentElement.dataset.scheme' })));

  // ---- Tabs
  await call('open', { folder: repo });
  const tab = await waitFor('the tab runs', () => tabOf((t) => t.folder === repo && t.server === 'running'), 120000);
  check('a tab opens and its code-server runs', tab, tab ? '' : JSON.stringify(await tabOf((t) => t.folder === repo)));
  if (!tab) return;
  const id = tab.id;
  check('VS Code loads in the tab', await waitFor('the workbench', () => call('eval', { id, js: "Boolean(document.querySelector('.monaco-workbench'))" }), 90000));

  // ---- Worktrees
  await call('addWorktree', { repo, name: 'smoke-wt' });
  const wt = await waitFor('the worktree tab', () => tabOf((t) => t.folder.endsWith('smoke-wt')), 60000);
  check('adding a worktree opens a tab for it', wt);
  if (!wt) return;
  check('the worktree is there', fs.existsSync(wt.folder), wt.folder);
  check('.worktreeinclude copies .env into it', fs.existsSync(path.join(wt.folder, '.env')));
  check('the worktree tab runs', await waitFor('the worktree runs', () => tabOf((t) => t.id === wt.id && t.server === 'running'), 120000));
  const settings = (tabId) => {
    try {
      return fs.readFileSync(path.join(WORK, 'data', 'instances', tabId, 'User', 'settings.json'), 'utf8');
    } catch {
      return '';
    }
  };
  check('a linked worktree skips Claude Code\'s onboarding, the primary does not', settings(wt.id).includes('hideOnboarding') && !settings(id).includes('hideOnboarding'));
  // A code-server that ends on its own (not stopped by the app) reaches its tab.
  try {
    execFileSync('pkill', ['-f', `instances/${wt.id}`]);
  } catch {
    // Gone already.
  }
  const exited = await waitFor('the exit', () => tabOf((t) => t.id === wt.id && !['running', 'starting'].includes(t.server)), 20000);
  check('a code-server that ends on its own stops its tab', exited, exited ? exited.server : '');
  await call('activate', { id });
  check('selecting a tab brings it to the front', (await tabOf((t) => t.id === id)).active);
  await call('close', { id: wt.id });
  check('closing a tab', await waitFor('closed', async () => !(await tabOf((t) => t.id === wt.id))));
  const removal = await call('removalCheck', { folder: wt.folder, repo });
  check('the worktree can be removed', removal.removable, JSON.stringify(removal.blockers));
  await call('removeWorktree', { folder: wt.folder, repo, deleteBranch: true });
  await waitFor('removed', () => !fs.existsSync(wt.folder));
  check('removing the worktree and its branch', !fs.existsSync(wt.folder) && !git(repo, 'branch', '--list', 'smoke-wt').trim());

  // ---- Repositories of the account, and cloning
  const helloUrl = 'https://github.com/octocat/Hello-World';
  const uncloned = await waitFor('the account repository', async () => {
    const u = await call('uncloned');
    return JSON.stringify(u.groups).includes('Hello-World') ? u : null;
  });
  check('the account\'s repository is listed as not cloned, cloned here', uncloned && uncloned.places.length === 1);
  await call('cloneDialog', { url: helloUrl });
  check('the clone dialog opens', await waitFor('the clone dialog', async () => (await pageText('dialog')).includes('octocat/Hello-World')));
  const dest = path.join(WORK, 'clones', 'Hello-World');
  check('the clone dialog refuses a relative path', (await inPage('dialog', "window.host.clone.check('relative')")).error === 'Enter a full path');
  const good = await inPage('dialog', `window.host.clone.check(${JSON.stringify(dest)})`);
  check('the clone dialog takes a new folder', good.error === null && good.dest === dest);
  if (OFFLINE) {
    await call('key', { id: 'dialog', keyCode: 'Escape' });
    log('skip: cloning (--offline)');
  } else {
    await call('eval', { id: 'dialog', js: `(() => { const el = document.getElementById('clone-dest'); el.value = ${JSON.stringify(dest)}; el.dispatchEvent(new Event('input')); document.getElementById('clone-start').click(); })()` });
    check('Clone starts the clone and closes the dialog', await waitFor('the dialog closes', async () => !(await pageText('dialog')).includes('octocat/Hello-World')));
    check('the repository is cloned', await waitFor('cloned', () => fs.existsSync(path.join(dest, '.git')), 120000));
    check('the cloned repository joins the list', await waitFor('listed', async () => JSON.stringify((await inPage('sidebar', 'window.host.getRepos()')).repos).includes('Hello-World')));
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    check('where it was cloned is kept', config.cloneRoot === path.dirname(dest) && config.repos.includes(dest));
    check('it is no longer marked as being cloned', (await call('state')).cloning.length === 0);
  }
  // The page hides as the button is pressed; the main process hears the answer a frame later.
  const closedReply = () => inPage('dialog', "window.host.clone.check('/x')");
  const refused = await waitFor('refused', async () => (await closedReply()).error === 'The dialog that asks where to clone is closed', 5000);
  check('the clone dialog\'s requests are refused once it is closed', refused, refused ? '' : JSON.stringify(await closedReply()));

  // ---- The side bar's IPC
  const state = await inPage('sidebar', 'window.host.getState()');
  check('tabs:get', state.tabs.length === 1 && state.tabs[0].id === id);
  check('repos:worktrees', JSON.stringify(await inPage('sidebar', `window.host.getWorktrees(${JSON.stringify(repo)})`)).includes('"branch":"main"'));
  await inPage('sidebar', 'window.host.refreshRepos()');
  check('repos:refresh', true);
  check('github:get answers', (await inPage('sidebar', `window.host.github(${JSON.stringify(repo)})`)) === null);
  await inPage('sidebar', 'window.host.startResize()');
  await call('eval', { id: 'sidebar', js: 'window.host.resize(400)' });
  await inPage('sidebar', 'window.host.endResize(400)');
  check('the side bar\'s width follows a resize', (await call('layout')).sidebar.width === 400);
  await inPage('sidebar', 'window.host.resetWidth()');
  check('a double click on the edge goes back to the configured width', (await call('layout')).sidebar.width === 260);

  // ---- Dialogs
  const answer = call('dialog', { message: 'smoke message', buttons: ['OK', 'Cancel'] });
  await waitFor('the message', async () => (await pageText('dialog')).includes('smoke message'));
  await call('key', { id: 'dialog', keyCode: 'Escape' });
  check('a message box shows and Escape cancels it', (await answer).response === 1);
  inPage('sidebar', 'window.host.showSettings()');
  check('Settings opens', await waitFor('Settings', async () => /Settings|General/.test(await pageText('dialog'))));
  const extensions = await inPage('dialog', 'window.host.extensions.list()');
  check('the Extensions pane lists the extensions', extensions && !extensions.error);
  check('the Extensions pane refuses a bad id', (await inPage('dialog', "window.host.extensions.page('bad id')")).error === 'Invalid extension ID.');
  await call('key', { id: 'dialog', keyCode: 'Escape' });
  check('the Extensions pane is refused once Settings closes', await waitFor('refused', async () => (await inPage('dialog', 'window.host.extensions.list()')).error === 'Open Settings first.', 10000));
  inPage('sidebar', `window.host.addWorktree(${JSON.stringify(repo)})`);
  // Text only its form has: closing Settings leaves its form on the page until another dialog
  // shows, and that one says "branch" too.
  check('the add-worktree dialog opens', await waitFor('the dialog', async () => (await pageText('dialog')).includes('Suggest a branch name')));
  const plan = await inPage('dialog', `window.host.worktree.plan(${JSON.stringify(repo)}, 'smoke-plan')`);
  check('it plans a new branch, with the files to copy', plan && plan.from === 'new' && plan.copies === 1);
  check('it reads a task', (await inPage('dialog', `window.host.worktree.task(${JSON.stringify(repo)}, 'do something')`)).kind === 'text');
  check('it refuses another repository', (await inPage('dialog', "window.host.worktree.plan('/elsewhere', 'x')")).error === 'The dialog that adds a worktree is closed');
  await call('key', { id: 'dialog', keyCode: 'Escape' });
  await sleep(500);

  // ---- The side bar with the mouse
  const edge = await call('eval', { id: 'sidebar', js: "(() => { const r = document.getElementById('edge').getBoundingClientRect(); return Math.round(r.left + r.width / 2); })()" });
  await call('mouse', { id: 'sidebar', event: { type: 'mouseDown', x: edge, y: 300, button: 'left', clickCount: 1 } });
  // The drag itself is checked through IPC above: under Xvfb, Chromium sends a move without the
  // button as the view grows, which ends it.
  const resizing = await waitFor('resizing', () => call('eval', { id: 'sidebar', js: "document.documentElement.classList.contains('resizing') || document.body.style.width !== ''" }), 3000);
  await call('mouse', { id: 'sidebar', event: { type: 'mouseUp', x: edge, y: 300, button: 'left', clickCount: 1 } });
  check('a press on the side bar\'s edge starts a resize', resizing);
  await waitFor('the resize ends', async () => !(await call('layout')).dragging, 5000);
  if (!OFFLINE) {
    const mark = await call('eval', { id: 'sidebar', js: "(() => { const m = document.querySelector('.gh-mark'); if (!m) return null; const r = m.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()" });
    if (mark) {
      await call('mouse', { id: 'sidebar', event: { type: 'mouseMove', x: 5, y: 900 } });
      await sleep(400);
      await call('mouse', { id: 'sidebar', event: { type: 'mouseMove', x: mark.x - 1, y: mark.y } });
      await call('mouse', { id: 'sidebar', event: { type: 'mouseMove', x: mark.x, y: mark.y } });
      const buttons = await waitFor('the GitHub bar', () => call('eval', { id: 'sidebar', js: "(() => { const b = document.getElementById('gh-bar'); return !b.hidden && b.querySelectorAll('button').length; })()" }), 5000);
      check('resting on a GitHub mark shows the GitHub bar', buttons >= 4, `${buttons} buttons`);
      await call('key', { id: 'sidebar', keyCode: 'Escape' });
      check('Escape closes the GitHub bar', await waitFor('closed', () => call('eval', { id: 'sidebar', js: "document.getElementById('gh-bar').hidden" }), 3000));
    } else check('the cloned repository has a GitHub mark', false);
  }

  // ---- The rest of the control port, and stopping
  check('window', (await call('window')).bounds.width > 0);
  check('focused', ['sidebar', 'dialog', id, null].includes(await call('focused')));
  check('risks', Array.isArray(await call('risks', { id })));
  const shot = await call('shot', { id: 'sidebar' });
  check('a screenshot of the side bar', fs.existsSync(shot), shot);
  await call('suspend', { id });
  check('suspending a tab stops its code-server', await waitFor('suspended', async () => (await tabOf((t) => t.id === id)).server !== 'running'));
}

// ---- Run ---------------------------------------------------------------------------------------

async function main() {
  need(process.platform === 'linux', 'The smoke check runs on Linux. On Windows and macOS, use the dev-*-check.js scripts (docs/development.md).');
  need(process.env.DISPLAY || has('xvfb-run'), 'Needs xvfb-run (apt install xvfb), or a DISPLAY.');
  need(has('curl') && has('tar') && has('git'), 'Needs curl, tar, and git.');
  let electron;
  try {
    electron = require('electron');
  } catch {
    electron = null;
  }
  need(electron && fs.existsSync(electron), 'Electron\'s binary is missing: run node node_modules/electron/install.js (see docs/development.md).');

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const serverDir = codeServer();
  const extensionsDir = path.join(WORK, 'extensions');
  standInExtension(serverDir, extensionsDir);

  const repo = path.join(WORK, 'smoke-repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'smoke\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(repo, '.worktreeinclude'), '.env\n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const ghqRepo = path.join(WORK, 'ghq', 'github.com', 'me', 'from-ghq');
  fs.mkdirSync(ghqRepo, { recursive: true });
  git(ghqRepo, 'init', '-q', '-b', 'main');
  const bin = path.join(WORK, 'bin');
  standInCommands(bin, ghqRepo);

  const configFile = path.join(WORK, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    repos: [repo], repoSources: ['ghq'], codeServerDir: serverDir, extensionsDir,
    updateCheck: false, unclonedRepos: true, locale: 'en',
  }));
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_TOKEN: '',
    WORKTABS_DATA_DIR: path.join(WORK, 'data'),
    WORKTABS_CONFIG: configFile,
    WORKTABS_CONTROL_PORT: String(PORT),
    WORKTABS_CONTROL_TOKEN: process.env.WORKTABS_CONTROL_TOKEN,
  };
  const command = process.env.DISPLAY ? [electron, '--no-sandbox', ROOT] : ['xvfb-run', '-a', '-s', '-screen 0 1600x1000x24', electron, '--no-sandbox', ROOT];
  const appLog = fs.openSync(path.join(WORK, 'app.log'), 'w');
  const child = spawn(command[0], command.slice(1), { env, stdio: ['ignore', appLog, appLog] });
  let failure = null;
  try {
    await checks({ repo, ghqRepo, configFile });
  } catch (error) {
    failure = error;
    check('the check ran to the end', false, error.message);
  } finally {
    await call('quit').catch(() => {});
    await sleep(2000);
    child.kill();
  }
  const leftOver = (() => {
    try {
      return execFileSync('pgrep', ['-f', path.join(WORK, 'data', 'instances')], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();
  check('no code-server is left running after quitting', !leftOver, leftOver);
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) log(`the app's log: ${path.join(WORK, 'app.log')}, code-server's: ${path.join(WORK, 'data', 'logs')}`);
  else if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(failed.length || failure ? 1 : 0);
}

main();
