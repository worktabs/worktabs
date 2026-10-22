// Downloads through Electron's net, so the system proxy settings apply, and unpacking with the
// system's tar, which reads zips too (bsdtar on macOS and Windows 10 and later). Cannot be loaded
// without Electron.
const { execFile } = require('child_process');
const fs = require('fs');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { net } = require('electron');
const { t } = require('../i18n');
const { tarCommand } = require('../code-server/install');

async function fetchText(url) {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

// Saves `url` to `file` (through file.part). onProgress(downloadedMB, totalMB) reports it.
async function download(url, file, onProgress) {
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(t('Could not download {url} (HTTP {status})', { url, status: res.status }));
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      onProgress(received / 2 ** 20, total / 2 ** 20);
      callback(null, chunk);
    },
  });
  const partial = `${file}.part`;
  await pipeline(Readable.fromWeb(/** @type {any} */ (res.body)), progress, fs.createWriteStream(partial));
  fs.renameSync(partial, file);
}

function extract(zip, dir) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    execFile(tarCommand(), ['-xf', zip, '-C', dir], { windowsHide: true, maxBuffer: 16 * 2 ** 20 }, (error, _stdout, stderr) =>
      error ? reject(new Error(t('Extracting failed: {error}', { error: stderr || error.message }))) : resolve());
  }));
}

module.exports = { download, extract, fetchText };
