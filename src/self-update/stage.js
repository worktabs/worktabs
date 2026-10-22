// Downloads the release zip, checks it against the release's SHA256SUMS.txt, and extracts it next
// to the app, on the same drive, so the swap after quitting is two renames (swap.js). Downloading
// and running tar are injected, so the tests run without Electron.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');
const { checksumOf } = require('./releases');
const { MARKER } = require('./target');

// Electron's fs reads an .asar file as a folder, and cannot remove a folder that holds one.
function removeTree(dir) {
  const noAsar = process.noAsar;
  process.noAsar = true;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  finally { process.noAsar = noAsar; }
}

// Beside the app: the folder the zip is extracted into, and where the app is moved to while the
// new one takes its place.
function stagingPaths(appPath) {
  return { container: `${appPath}.update`, old: `${appPath}.old` };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

// The new app inside the extracted zip: the folder with Worktabs.exe (the zip's root, or one
// folder in it) on Windows, the .app in it on macOS. Null when there is none.
/** @param {string} container @param {string} [platform] */
function findStagedApp(container, platform = process.platform) {
  const entries = fs.readdirSync(container, { withFileTypes: true });
  if (platform === 'darwin') {
    const bundle = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
    return bundle ? path.join(container, bundle.name) : null;
  }
  if (fs.existsSync(path.join(container, 'Worktabs.exe'))) return container;
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (dirs.length === 1 && fs.existsSync(path.join(container, dirs[0].name, 'Worktabs.exe'))) return path.join(container, dirs[0].name);
  return null;
}

function resourcesOf(appPath, platform) {
  return platform === 'darwin' ? path.join(appPath, 'Contents', 'Resources') : path.join(appPath, 'resources');
}

// The installer puts its uninstaller beside Worktabs.exe, and the zip has none. Without it the
// entry in "Apps & features" could no longer uninstall.
function keepUninstaller(appPath, staged) {
  for (const name of fs.readdirSync(appPath)) {
    if (!/^uninstall.*\.exe$/i.test(name) || fs.existsSync(path.join(staged, name))) continue;
    fs.copyFileSync(path.join(appPath, name), path.join(staged, name));
  }
}

/**
 * Makes the release ready beside the app and returns { staged, container }: the new app, and the
 * folder that holds it (the same folder on Windows when the zip has no folder of its own).
 * `download(url, file, onProgress)` saves a URL to a file; `fetchText(url)` reads one;
 * `extract(zip, dir)` unpacks a zip.
 * @param {{ release: { version: string, asset: { name: string, url: string }, checksumsUrl: string },
 *   appPath: string, dataDir: string, platform?: string,
 *   download: (url: string, file: string, onProgress: (mb: number, totalMb: number) => void) => Promise<void>,
 *   fetchText: (url: string) => Promise<string>, extract: (zip: string, dir: string) => Promise<void>,
 *   onProgress?: (mb: number, totalMb: number) => void }} options
 */
async function stageRelease({ release, appPath, dataDir, platform = process.platform, download, fetchText, extract, onProgress = () => {} }) {
  const dir = path.join(dataDir, 'app-update');
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, release.asset.name);
  const expected = checksumOf(await fetchText(release.checksumsUrl), release.asset.name);
  if (!expected) throw new Error(t('{file} has no checksum in the release.', { file: release.asset.name }));
  try {
    await download(release.asset.url, zip, onProgress);
    const actual = await sha256File(zip);
    if (actual !== expected) throw new Error(t('The download of {file} does not match its checksum.', { file: release.asset.name }));

    const { container } = stagingPaths(appPath);
    removeTree(container);
    try { fs.mkdirSync(container); }
    catch (error) { throw new Error(t('Cannot write to {folder}: {error}', { folder: path.dirname(appPath), error: error.message }), { cause: error }); }
    await extract(zip, container);
    const staged = findStagedApp(container, platform);
    if (!staged || !fs.existsSync(path.join(resourcesOf(staged, platform), MARKER))) {
      removeTree(container);
      throw new Error(t('{file} does not hold a Worktabs release.', { file: release.asset.name }));
    }
    if (platform === 'win32') keepUninstaller(appPath, staged);
    return { staged, container };
  } finally {
    fs.rmSync(zip, { force: true });
    fs.rmSync(`${zip}.part`, { force: true });
  }
}

// What an update before this start left beside the app: the extracted zip if it never swapped,
// and the previous version if the swap could not remove it.
function removeLeftovers(appPath) {
  const { container, old } = stagingPaths(appPath);
  for (const dir of [container, old]) {
    if (fs.existsSync(dir)) removeTree(dir);
  }
}

module.exports = { findStagedApp, removeLeftovers, removeTree, stageRelease, stagingPaths };
