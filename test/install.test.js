// Which code-server release the app downloads for the machine it runs on, and how it unpacks it.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { serverNode } = require('../src/code-server/code-server');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { downloadRelease, ensureCodeServer, extractArchive, releaseName, removeOldCodeServers, tarCommand } = require('../src/code-server/install');
const { tempDir } = require('./support');

test('releaseName names the release for the platform and the architecture', () => {
  assert.equal(releaseName('4.139.1', null, { platform: 'win32', arch: 'x64' }), 'code-server-4.139.1-windows-amd64');
  assert.equal(releaseName('4.139.1', null, { platform: 'darwin', arch: 'arm64' }), 'code-server-4.139.1-macos-arm64');
  assert.equal(releaseName('4.139.1', null, { platform: 'darwin', arch: 'x64' }), 'code-server-4.139.1-macos-amd64');
  // Nothing to download: the app then asks for a code-server in the settings. There is no
  // Windows release for arm64, and the app does not run on Linux itself (WSL is below).
  assert.equal(releaseName('4.139.1', null, { platform: 'win32', arch: 'arm64' }), null);
  assert.equal(releaseName('4.139.1', null, { platform: 'linux', arch: 'x64' }), null);
  assert.equal(releaseName('4.139.1', null, { platform: 'darwin', arch: 'ia32' }), null);
  // A tab in WSL takes the Linux release, whatever this machine is.
  assert.equal(releaseName('4.139.1', 'amd64', { platform: 'darwin', arch: 'arm64' }), 'code-server-4.139.1-linux-amd64');
});

test('tarCommand takes the tar that comes with Windows, and the one on PATH elsewhere', () => {
  assert.equal(tarCommand('darwin'), 'tar');
  assert.match(tarCommand('win32'), /System32[\\/]tar\.exe$/);
});

test('serverNode names the node of an extracted release', () => {
  assert.equal(serverNode(path.join('r', 'code-server'), 'win32'), path.join('r', 'code-server', 'lib', 'node.exe'));
  assert.equal(serverNode(path.join('r', 'code-server'), 'darwin'), path.join('r', 'code-server', 'lib', 'node'));
});

test('downloadRelease keeps an archive downloaded before, without going to the network', async (t) => {
  const dataDir = tempDir(t);
  const archive = path.join(dataDir, 'code-server', 'code-server-4.139.1-linux-amd64.tar.gz');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, 'kept');
  // Electron is not loaded here: reaching net.fetch would throw.
  assert.equal(await downloadRelease({ dataDir, version: '4.139.1', name: 'code-server-4.139.1-linux-amd64' }), archive);
  assert.equal(fs.readFileSync(archive, 'utf8'), 'kept');
});

test('ensureCodeServer uses an extracted release and refuses a machine with no release', async (t) => {
  const dataDir = tempDir(t);
  const name = releaseName('4.139.1');
  if (!name) {
    // Linux, where the tests run in CI: there is no release to download for the app itself.
    await assert.rejects(ensureCodeServer({ dataDir, version: '4.139.1' }), /codeServerDir/);
    return;
  }
  const dir = path.join(dataDir, 'code-server', name);
  fs.mkdirSync(path.dirname(serverNode(dir)), { recursive: true });
  fs.writeFileSync(serverNode(dir), '');
  assert.equal(await ensureCodeServer({ dataDir, version: '4.139.1' }), dir);
});

// A .tar.gz of `files` (relative path -> contents) under `name`, in that order, made with the tar
// the app uses.
function makeArchive(dir, name, files) {
  const source = path.join(dir, 'source');
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, name, file)), { recursive: true });
    fs.writeFileSync(path.join(source, name, file), contents);
  }
  const archive = path.join(dir, `${name}.tar.gz`);
  execFileSync(tarCommand(), ['-czf', archive, '-C', source, ...Object.keys(files).map((file) => `${name}/${file}`)]);
  fs.rmSync(source, { recursive: true, force: true });
  return archive;
}

test('extractArchive reads the archive through tar\'s standard input, and reports how much it has read', async (t) => {
  const dir = tempDir(t);
  // Random bytes do not compress, so the archive is read in several chunks.
  const big = crypto.randomBytes(512 * 1024);
  const archive = makeArchive(dir, 'release', { 'lib/node': 'node', 'big.bin': big });
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const progress = [];
  await extractArchive(archive, out, (mb, totalMb) => progress.push([mb, totalMb]));
  assert.equal(fs.readFileSync(path.join(out, 'release', 'lib', 'node'), 'utf8'), 'node');
  assert.ok(fs.readFileSync(path.join(out, 'release', 'big.bin')).equals(big));
  const total = fs.statSync(archive).size / 2 ** 20;
  assert.ok(progress.length > 1);
  assert.deepEqual(progress.at(-1), [total, total]);
  assert.ok(progress.every(([mb, of], i) => of === total && (i === 0 || mb > progress[i - 1][0])));
});

test('extractArchive fails with what tar says about a broken archive', async (t) => {
  const dir = tempDir(t);
  const archive = path.join(dir, 'broken.tar.gz');
  fs.writeFileSync(archive, 'not an archive');
  await assert.rejects(extractArchive(archive, dir), /^Error: Extracting failed: \S/);
  await assert.rejects(extractArchive(archive, dir, () => {}, path.join(dir, 'missing-tar')), /Extracting failed: .*ENOENT/);
});

test('ensureCodeServer extracts a downloaded release, and removes what a failed extract left', async (t) => {
  const name = releaseName('4.139.1');
  // Linux, where the tests run in CI, has no release to download for the app itself.
  if (!name) return;
  const dataDir = tempDir(t);
  const root = path.join(dataDir, 'code-server');
  fs.mkdirSync(root);
  const node = path.relative(path.join('r'), serverNode('r')).split(path.sep).join('/');
  const big = crypto.randomBytes(512 * 1024);
  // An archive cut short after the node: tar writes it, then fails.
  const archive = makeArchive(root, name, { [node]: 'node', 'big.bin': big });
  const whole = fs.readFileSync(archive);
  fs.writeFileSync(archive, whole.subarray(0, Math.floor(whole.length / 2)));
  await assert.rejects(ensureCodeServer({ dataDir, version: '4.139.1' }), /Extracting failed/);
  assert.equal(fs.existsSync(path.join(root, name)), false);

  fs.writeFileSync(archive, whole);
  const extracting = [];
  const dir = await ensureCodeServer({ dataDir, version: '4.139.1', onExtract: (mb, totalMb) => extracting.push(mb / totalMb) });
  assert.equal(dir, path.join(root, name));
  assert.equal(fs.readFileSync(serverNode(dir), 'utf8'), 'node');
  assert.equal(extracting.at(-1), 1);
  assert.equal(fs.existsSync(archive), false);
});

test('removeOldCodeServers removes the releases it is not told to keep, and nothing else', (t) => {
  const dataDir = tempDir(t);
  const root = path.join(dataDir, 'code-server');
  for (const name of ['code-server-4.138.0-linux-amd64', 'code-server-4.139.1-linux-amd64', 'other']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'code-server-4.139.1-linux-amd64.tar.gz'), '');
  removeOldCodeServers(dataDir, [path.join(root, 'code-server-4.139.1-linux-amd64')]);
  assert.deepEqual(fs.readdirSync(root).sort(), ['code-server-4.139.1-linux-amd64', 'code-server-4.139.1-linux-amd64.tar.gz', 'other']);
  // No code-server folder yet: nothing to do.
  removeOldCodeServers(path.join(dataDir, 'missing'), []);
});
