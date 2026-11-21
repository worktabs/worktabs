// Downloads the code-server release the app was tested with, when no install is configured.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { serverNode } = require('./code-server');
const { t } = require('../i18n');
const { countingStream } = require('../util');

// How code-server names its releases, by platform and architecture. Windows has an amd64
// release only; macOS has one for each, and an Intel Mac must not be given the arm64 one.
const RELEASE_OS = { win32: 'windows', darwin: 'macos' };
const RELEASE_ARCH = { x64: 'amd64', arm64: 'arm64' };

// The release for this machine, or with `linuxArch` (amd64, arm64) the Linux one, for WSL.
// Null when there is none to download; the code-server to use is then a configured one.
function releaseName(version, linuxArch = null, { platform = process.platform, arch = process.arch } = {}) {
  if (linuxArch) return `code-server-${version}-linux-${linuxArch}`;
  const os = RELEASE_OS[platform];
  const cpu = RELEASE_ARCH[arch];
  if (!os || !cpu || (platform === 'win32' && cpu !== 'amd64')) return null;
  return `code-server-${version}-${os}-${cpu}`;
}

// The tar that unpacks the release. On Windows it is the one that comes with it (Windows 10 and
// later): a GNU tar earlier on PATH (Git Bash) would read "C:/..." as a remote host.
function tarCommand(platform = process.platform) {
  if (platform !== 'win32') return 'tar';
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

// Downloads the archive of the release `name` into <dataDir>/code-server, unless it is there
// already, and returns its path. onProgress(downloadedMB, totalMB) reports the download.
/** @param {{ dataDir: string, version: string, name: string, onProgress?: (mb: number, totalMb: number) => void }} options */
async function downloadRelease({ dataDir, version, name, onProgress = () => {} }) {
  const root = path.join(dataDir, 'code-server');
  fs.mkdirSync(root, { recursive: true });
  const archive = path.join(root, `${name}.tar.gz`);
  if (!fs.existsSync(archive)) {
    const partial = `${archive}.part`;
    const url = `https://github.com/coder/code-server/releases/download/v${version}/${name}.tar.gz`;
    // net.fetch goes through Chromium's network stack, so the system proxy settings apply.
    // Required here, not at the top: the rest of the file is read by the tests, without Electron.
    const { net } = require('electron');
    const res = await net.fetch(url);
    if (!res.ok) throw new Error(t('Could not download code-server {version} (HTTP {status})', { version, status: res.status }));
    const total = Number(res.headers.get('content-length')) || 0;
    await pipeline(Readable.fromWeb(res.body), countingStream(total, onProgress), fs.createWriteStream(partial));
    fs.renameSync(partial, archive);
  }
  return archive;
}

// Extracts the .tar.gz `archive` into `dir`. tar reads it from its standard input, through a
// stream that counts the bytes: tar reads only as fast as it writes the files, so the part of the
// archive read is how far it has gone. onProgress(readMB, totalMB) reports it.
/** @param {string} archive @param {string} dir @param {(mb: number, totalMb: number) => void} [onProgress] */
function extractArchive(archive, dir, onProgress = () => {}, command = tarCommand()) {
  const args = ['-xzf', '-', '-C', dir];
  const total = fs.statSync(archive).size;
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => { stderr += text; });
    // A tar that stops reading (a broken archive) closes the pipe; its own error says why.
    pipeline(fs.createReadStream(archive), countingStream(total, onProgress), child.stdin).catch(() => {});
    child.on('error', (error) => reject(new Error(t('Extracting failed: {error}', { error: error.message }))));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(t('Extracting failed: {error}', { error: stderr.trim() || `Command failed: ${command} ${args.join(' ')}` })));
    });
  }));
}

// Returns the code-server directory under <dataDir>/code-server, downloading and extracting
// the release first if needed. onProgress(downloadedMB, totalMB) reports the download, and
// onExtract(readMB, totalMB) the extracting (extractArchive).
/** @param {{ dataDir: string, version: string, onProgress?: (mb: number, totalMb: number) => void, onExtract?: (mb: number, totalMb: number) => void }} options */
async function ensureCodeServer({ dataDir, version, onProgress = () => {}, onExtract = () => {} }) {
  const name = releaseName(version);
  if (!name) {
    throw new Error(t('Downloading code-server is not supported here ({platform}-{arch}). Set codeServerDir in config.local.json.', { platform: process.platform, arch: process.arch }));
  }
  const root = path.join(dataDir, 'code-server');
  const dir = path.join(root, name);
  if (fs.existsSync(serverNode(dir))) return dir;
  const archive = await downloadRelease({ dataDir, version, name, onProgress });

  try {
    await extractArchive(archive, root, onExtract);
  } catch (error) {
    // What tar wrote before it failed must not look like a release at the next start. Failing
    // that too, tar's error is still the one to show.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* tar's error says more */ }
    throw error;
  }
  fs.rmSync(archive, { force: true });
  if (!fs.existsSync(serverNode(dir))) throw new Error(t('{path} is not found after extracting', { path: dir }));
  return dir;
}

// Removes the code-server releases under <dataDir>/code-server other than `keep` (directories),
// so each update leaves only the version before it.
function removeOldCodeServers(dataDir, keep) {
  const root = path.join(dataDir, 'code-server');
  const kept = new Set(keep.map((dir) => path.resolve(dir).toLowerCase()));
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    if (!entry.isDirectory() || !/^code-server-.+/.test(entry.name) || kept.has(dir.toLowerCase())) continue;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

module.exports = { downloadRelease, ensureCodeServer, extractArchive, releaseName, removeOldCodeServers, tarCommand };
