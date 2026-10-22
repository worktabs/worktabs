// What the app would replace to update itself: the install folder on Windows (the installer's or
// an extracted zip's), Worktabs.app on macOS. Only builds from the release workflow update
// themselves; it puts native/release.json in them, so a build of your own is left alone.
const path = require('path');
const { t } = require('../i18n');

const MARKER = path.join('native', 'release.json');

/**
 * { appPath } when the app can replace itself, { appPath: null, checkable, reason } when it
 * cannot. `checkable`: whether to look for new releases at all (a release build).
 * @param {{ execPath: string, resourcesPath: string, isPackaged: boolean, platform?: string,
 *   exists: (file: string) => boolean }} options
 * @returns {{ appPath: string | null, checkable: boolean, reason?: string }}
 */
function updateTarget({ execPath, resourcesPath, isPackaged, platform = process.platform, exists }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!isPackaged || !exists(p.join(resourcesPath, MARKER))) {
    return { appPath: null, checkable: false, reason: t('This is not a build from the Worktabs releases.') };
  }
  if (platform === 'win32') {
    const appPath = p.dirname(execPath);
    if (p.parse(appPath).root === appPath) return { appPath: null, checkable: true, reason: t('Worktabs is at the root of a drive.') };
    return { appPath, checkable: true };
  }
  if (platform === 'darwin') {
    // .../Worktabs.app/Contents/MacOS/Worktabs
    const appPath = p.resolve(execPath, '..', '..', '..');
    if (!appPath.endsWith('.app')) return { appPath: null, checkable: true, reason: t('Worktabs is not in an app bundle.') };
    // A quarantined app started from where it was extracted runs from a read-only copy.
    if (appPath.includes('/AppTranslocation/')) {
      return { appPath: null, checkable: true, reason: t('macOS runs Worktabs from a temporary copy. Move it to Applications and remove the quarantine mark (docs/install.md).') };
    }
    return { appPath, checkable: true };
  }
  return { appPath: null, checkable: true, reason: t('Updating from the app is not supported here.') };
}

module.exports = { MARKER, updateTarget };
