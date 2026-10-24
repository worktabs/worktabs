// Finds newer versions of code-server (GitHub releases) and of the extensions installed from
// Open VSX. Nothing is installed here; main.js applies an update when the user asks.
const fs = require('fs');
const { readExtensionIndexSync } = require('./extension-index');
const path = require('path');
const { net } = require('electron');
const { t } = require('../i18n');
const { releaseName } = require('./install');

// Short names for the side bar; other extensions show their id.
function extensionName(id) {
  const names = { 'anthropic.claude-code': 'Claude Code', 'ms-ceintl.vscode-language-pack-ja': t('Japanese language pack') };
  return names[id.toLowerCase()] || id;
}

// Negative, zero or positive as version a is older than, equal to or newer than b.
function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// Whether an extension's engines.vscode ("^1.94.0", ">=1.94.0", "*") accepts the VS Code version.
// Like VS Code, a caret only sets the minimum.
function engineAccepts(range, vscodeVersion) {
  if (!range || range === '*') return true;
  const minimum = /(\d+\.\d+\.\d+)/.exec(range);
  return !minimum || compareVersions(vscodeVersion, minimum[1]) >= 0;
}

/** @returns {Promise<any>} */
async function getJson(url) {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    const reset = Number(res.headers?.get('x-ratelimit-reset'));
    if ([403, 429].includes(res.status) && res.headers?.get('x-ratelimit-remaining') === '0' && reset) {
      const time = new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      throw new Error(t('GitHub limits requests from this network until {time}. To check sooner, run gh auth login in a terminal.', { time }));
    }
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return res.json();
}

// The VS Code version inside a code-server install.
function vscodeVersion(codeServerDir) {
  return JSON.parse(fs.readFileSync(path.join(codeServerDir, 'lib', 'vscode', 'package.json'), 'utf8')).version;
}

const RELEASES = 'repos/coder/code-server/releases?per_page=20';

// GitHub answers 60 API requests an hour to an address that is not signed in, and everyone
// behind an office's address shares them. Through gh, signed in, the account's own limit applies.
async function codeServerReleases(runGh) {
  if (runGh) {
    try { return JSON.parse(await runGh(['api', RELEASES])); }
    catch { /* gh is missing or not signed in to github.com: ask without signing in. */ }
  }
  return getJson(`https://api.github.com/${RELEASES}`);
}

// The newest code-server release with a build for this machine (some releases have no Windows
// build), or null.
async function latestCodeServer(runGh) {
  const releases = await codeServerReleases(runGh);
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = release.tag_name.replace(/^v/, '');
    const name = releaseName(version);
    if (name && release.assets.some((asset) => asset.name === `${name}.tar.gz`)) return version;
  }
  return null;
}

// Installed extensions by lowercase id: { id, version, targetPlatform, location }.
function installedExtensions(extensionsDir) {
  try {
    const inventory = readExtensionIndexSync(extensionsDir);
    return new Map([...inventory.byId].map(([id, entry]) => [id, {
      id: entry.originalId, version: entry.version, targetPlatform: entry.targetPlatform,
      location: path.join(extensionsDir, entry.relativeLocation),
    }]));
  } catch { return new Map(); }
}

// Lowercase ids of the listed extensions that activate as soon as VS Code starts, so a started
// instance can be expected to have activated them.
function startupExtensions(extensionsDir, ids) {
  const installed = installedExtensions(extensionsDir);
  return ids.filter((id) => {
    const extension = installed.get(id.toLowerCase());
    if (!extension) return false;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(extension.location, 'package.json'), 'utf8'));
      return (manifest.activationEvents || []).some((event) => event === '*' || event === 'onStartupFinished');
    } catch {
      return false;
    }
  }).map((id) => id.toLowerCase());
}

// The newest release of an extension on Open VSX for the platform that is not a pre-release
// and runs on the VS Code version, or null. The full version list is large (about 1 MB for
// Claude Code), so it is read only when the latest release does not qualify.
async function latestExtension(id, targetPlatform, vscode) {
  const query = `https://open-vsx.org/api/-/query?extensionId=${encodeURIComponent(id)}&targetPlatform=${targetPlatform}`;
  const usable = (e) => !e.preRelease && engineAccepts(e.engines?.vscode, vscode);
  const latest = (await getJson(query)).extensions || [];
  if (latest[0] && usable(latest[0])) return latest[0].version;
  const all = (await getJson(`${query}&includeAllVersions=true`)).extensions || [];
  return all.filter(usable).sort((a, b) => compareVersions(b.version, a.version))[0]?.version || null;
}

// Updates available now, { updates: [{ kind: 'code-server' | 'extension', id, name, from, to }],
// errors: [message] }. Each source fails on its own, so a GitHub limit does not hide the Open VSX
// updates. codeServerVersion is null when code-server is not managed by the app (codeServerDir is
// set). Extensions are compared against the running code-server's VS Code, so one that needs a
// newer VS Code shows up after code-server is updated. runGh(args) runs gh and resolves its output.
async function findUpdates({ codeServerVersion, codeServerDir, extensionsDir, extensions, lockedExtensions = [], runGh = null }) {
  const updates = [];
  const errors = [];
  if (codeServerVersion) {
    try {
      const latest = await latestCodeServer(runGh);
      if (latest && compareVersions(latest, codeServerVersion) > 0) {
        updates.push({ kind: 'code-server', id: 'code-server', name: 'code-server', from: codeServerVersion, to: latest });
      }
    } catch (error) { errors.push(error.message); }
  }
  const vscode = vscodeVersion(codeServerDir);
  const installed = installedExtensions(extensionsDir);
  for (const id of extensions) {
    if (lockedExtensions.includes(id.toLowerCase())) continue;
    if (id.toLowerCase().endsWith('.vsix')) continue;
    const current = installed.get(id.toLowerCase());
    if (!current) continue;
    try {
      const latest = await latestExtension(current.id, current.targetPlatform, vscode);
      if (latest && compareVersions(latest, current.version) > 0) {
        updates.push({ kind: 'extension', id: current.id, name: extensionName(id) === id ? current.id : extensionName(id), from: current.version, to: latest });
      }
    } catch (error) { errors.push(error.message); }
  }
  return { updates, errors };
}

module.exports = { findUpdates, getJson, startupExtensions };
