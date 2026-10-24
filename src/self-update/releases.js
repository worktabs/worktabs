// Finds a newer release of Worktabs itself on GitHub, and the file of it for this machine. The
// fetching is injected, so the tests run without Electron.
const semver = require('semver');

const REPO = 'worktabs/worktabs';
const RELEASES = `repos/${REPO}/releases?per_page=10`;
const CHECKSUMS = 'SHA256SUMS.txt';

// The zip the release workflow publishes for this machine, or null when it publishes none. The
// app updates itself from the zip, not the installer, on Windows too (docs/install.md).
function assetName(version, { platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'win32' && arch === 'x64') return `Worktabs-${version}-win.zip`;
  if (platform === 'darwin' && arch === 'arm64') return `Worktabs-${version}-arm64-mac.zip`;
  return null;
}

// The newest release newer than `current`, as { version, notesUrl, asset: { name, url, size },
// checksumsUrl }, or null. Drafts and prereleases are skipped, and so is a release without both
// the zip for this machine and its checksums.
function newestRelease(releases, current, machine = {}) {
  let best = null;
  for (const release of releases || []) {
    if (release.draft || release.prerelease) continue;
    const version = semver.valid(String(release.tag_name || '').replace(/^v/, ''));
    if (!version || semver.prerelease(version) || !semver.gt(version, current)) continue;
    if (best && !semver.gt(version, best.version)) continue;
    const name = assetName(version, machine);
    const assets = release.assets || [];
    const zip = assets.find((asset) => asset.name === name);
    const sums = assets.find((asset) => asset.name === CHECKSUMS);
    if (!zip || !sums) continue;
    best = {
      version,
      notesUrl: release.html_url || `https://github.com/${REPO}/releases/tag/v${version}`,
      asset: { name, url: zip.browser_download_url, size: zip.size || 0 },
      checksumsUrl: sums.browser_download_url,
    };
  }
  return best;
}

// The releases, through gh when it is signed in to github.com (the account's own rate limit),
// else without signing in. `runGh(args)` resolves gh's output; `getJson(url)` fetches JSON.
async function fetchReleases({ runGh, getJson }) {
  if (runGh) {
    try { return JSON.parse(await runGh(['api', RELEASES])); }
    catch { /* gh is missing or not signed in to github.com: ask without signing in. */ }
  }
  return getJson(`https://api.github.com/${RELEASES}`);
}

// The SHA-256 of `name` in a SHA256SUMS.txt (sha256sum's format), lowercase, or null.
function checksumOf(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  return null;
}

module.exports = { assetName, checksumOf, fetchReleases, newestRelease };
