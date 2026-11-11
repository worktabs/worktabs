// Releases on Open VSX, read from its API, and downloading them as snapshots (#54). The fetch is
// injected: main.js gives Electron's net.fetch, which follows the system proxy, and the tests a
// fake. Only releases are taken, never pre-releases: Codex numbers its pre-releases 26.5xxxx,
// above its releases (26.1xxx), so a version comparison alone would pick them.
const crypto = require('crypto');
const fs = require('fs');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const semver = require('semver');
const { t } = require('../i18n');

const API = 'https://open-vsx.org/api';
// As for any import: a VSIX is read whole, and Node cannot read 2 GiB or more into one buffer.
const MAX_DOWNLOAD_BYTES = 2 * 1024 ** 3 - 1;

/**
 * @typedef {{ kind: 'openvsx', id: string, name: string, version: string, targetPlatform: string, download: string,
 *   sha256: string, bundled: string[], page: string }} Release
 * @typedef {(url: string, options?: { signal?: AbortSignal }) => Promise<Response>} Fetch
 */

// VS Code checks engines.vscode the same way when it installs (validateBatch does too).
function engineAccepts(range, vscode) {
  return typeof range === 'string' && semver.validRange(range) !== null && semver.satisfies(vscode, range, { includePrerelease: true });
}

/** @param {any} entry @returns {Release} */
function release(entry) {
  return {
    // What ExtensionImports.stage downloads, rather than copying or packing.
    kind: 'openvsx',
    id: `${entry.namespace}.${entry.name}`.toLowerCase(),
    name: typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : `${entry.namespace}.${entry.name}`,
    version: entry.version,
    targetPlatform: entry.targetPlatform || 'universal',
    download: entry.files?.download,
    sha256: entry.files?.sha256,
    bundled: (entry.bundledExtensions || []).map((item) => `${item.namespace}.${item.extension}`.toLowerCase()),
    page: `https://open-vsx.org/extension/${entry.namespace}/${entry.name}`,
  };
}

/** @param {{ fetch: Fetch, timeout?: number }} options */
function createOpenVsx({ fetch, timeout = 20000 }) {
  async function get(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res;
  }

  // The answer of a query, or no extensions when there is no such extension (the API answers
  // that with an empty list, but a 404 means the same).
  /** @returns {Promise<any>} */
  async function json(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (res.status === 404) return { extensions: [] };
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  // The newest release of `id` for `target` whose engines.vscode accepts `vscode`, or null. An
  // extension built once for every platform is published as universal, which a query for a
  // platform does not return, so universal is asked next. The full version list is large (about
  // 1 MB), so it is read only when the latest version does not qualify.
  /** @returns {Promise<Release | null>} */
  async function latestRelease(id, target, vscode) {
    for (const platform of [target, 'universal']) {
      const query = `${API}/-/query?extensionId=${encodeURIComponent(id)}&targetPlatform=${platform}`;
      const usable = (entry) => !entry.preRelease && entry.files?.download && engineAccepts(entry.engines?.vscode, vscode);
      const latest = (await json(query)).extensions || [];
      if (!latest.length) continue;
      if (usable(latest[0])) return release(latest[0]);
      const all = (await json(`${query}&includeAllVersions=true`)).extensions || [];
      const found = all.filter((entry) => usable(entry) && semver.valid(entry.version)).sort((a, b) => semver.rcompare(a.version, b.version))[0];
      return found ? release(found) : null;
    }
    return null;
  }

  // `version` of `id` for `target` (or universal), when it is a release; else null. The members
  // of an extension pack are taken at the version of the pack where they have one.
  /** @returns {Promise<Release | null>} */
  async function releaseOf(id, version, target) {
    const [namespace, name] = id.split('.');
    for (const platform of [target, 'universal']) {
      const res = await fetch(`${API}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${platform}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(timeout) });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`${id} ${version}: HTTP ${res.status}`);
      const entry = /** @type {any} */ (await res.json());
      if (entry.error) continue;
      return entry.preRelease || !entry.files?.download ? null : release(entry);
    }
    return null;
  }

  // Downloads `item`'s VSIX to `file`, checked against the SHA-256 that Open VSX publishes beside
  // it. The checksum comes from the same server, so it catches a broken or cut download, not a
  // server that serves something else. onProgress(receivedMB, totalMB).
  /** @param {Release} item @param {string} file @param {{ onProgress?: (mb: number, totalMb: number) => void }} [options] */
  async function download(item, file, { onProgress = () => {} } = {}) {
    const expected = (await (await get(item.sha256)).text()).trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(t('Open VSX has no checksum for {name} {version}.', { name: item.name, version: item.version }));
    // No timeout: a large file on a slow line takes minutes (380 MB took up to 8 minutes).
    const res = await fetch(item.download);
    if (!res.ok || !res.body) throw new Error(t('Could not download {name} {version} from Open VSX (HTTP {status}).', { name: item.name, version: item.version, status: res.status }));
    const total = Number(res.headers.get('content-length')) || 0;
    if (total > MAX_DOWNLOAD_BYTES) throw new Error(t('The extension archive is too large.'));
    const hash = crypto.createHash('sha256');
    let received = 0;
    const partial = `${file}.part`;
    try {
      await pipeline(Readable.fromWeb(/** @type {any} */ (res.body)), new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES) return callback(new Error(t('The extension archive is too large.')));
          hash.update(chunk);
          onProgress(received / 2 ** 20, total / 2 ** 20);
          callback(null, chunk);
        },
      }), fs.createWriteStream(partial));
      if (hash.digest('hex') !== expected) throw new Error(t('The download of {name} {version} from Open VSX does not match its checksum.', { name: item.name, version: item.version }));
      fs.renameSync(partial, file);
    } finally {
      fs.rmSync(partial, { force: true });
    }
  }

  return { latestRelease, releaseOf, download };
}

module.exports = { createOpenVsx, engineAccepts };
