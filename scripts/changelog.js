// Writes CHANGELOG.md with git-cliff (settings in cliff.toml), taking the version in package.json
// as released. `npm version` runs it after raising the version, so the release commit, and the tag
// put on it once merged, carry the CHANGELOG.md that the release notes are taken from.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appDir = path.join(__dirname, '..');

// The binary the git-cliff npm package installs for this platform. Run directly, without the
// package's ESM wrapper.
function gitCliffPath() {
  const platform = os.platform() === 'win32' ? 'windows' : os.platform();
  const ext = platform === 'windows' ? '.exe' : '';
  return require.resolve(`git-cliff-${platform}-${os.arch()}/bin/git-cliff${ext}`);
}

function main() {
  const { version } = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  // Regenerated from the whole history each time, so CHANGELOG.md is never edited by hand.
  execFileSync(gitCliffPath(), ['--tag', `v${version}`, '--output', 'CHANGELOG.md'], { cwd: appDir, stdio: 'inherit' });
  execFileSync('git', ['add', 'CHANGELOG.md'], { cwd: appDir, stdio: 'inherit' });
}

if (require.main === module) main();

module.exports = { gitCliffPath };
