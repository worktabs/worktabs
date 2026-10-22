// Updates of Worktabs itself, offered in a card of the side bar of their own. It finds a newer
// release, downloads and extracts its zip beside the app when asked, and swaps it in once the app
// quits: at once with "Restart now" (after the working tabs finish), or whenever the app quits
// next. Everything that touches the network, the disk, or the window is injected.
const { t } = require('../i18n');

// While these last, a check does not replace what the card shows.
const BUSY = ['downloading', 'ready', 'waiting'];

/**
 * status: 'none' | 'available' (`canApply`: false when the update must be taken by hand, with
 * `detail` saying why) | 'downloading' | 'ready' (waits for the app to quit) | 'waiting' (for the
 * tabs in `busy`) | 'done' | 'failed'. Each but 'none' has { version, from, notesUrl }.
 * @param {{ currentVersion: string, appPath: string | null, reason?: string,
 *   find: () => Promise<any>, stage: (release: any, onProgress: (mb: number, totalMb: number) => void) => Promise<{ staged: string, container: string }>,
 *   swap: (staged: { staged: string, container: string }, version: string, relaunch: boolean) => void,
 *   risks: () => Promise<{ busy: string[], unobserved: boolean }>, quit: () => void,
 *   skipped: () => string, skip: (version: string) => void, lastResult: () => ({ version: string, ok: boolean, error: string } | null),
 *   messageBox: (options: any) => any, changed: () => void, log: (line: string) => void,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number }} deps
 */
function createSelfUpdate({ currentVersion, appPath, reason = '', find, stage, swap, risks, quit, skipped, skip,
  lastResult, messageBox, changed, log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
  let state = { status: 'none' };
  let release = null;
  let staged = null;
  // Set by "Restart now": the swap starts the new version. A plain quit only installs it.
  let relaunch = false;
  // Each wait for the tabs, so a canceled one stops.
  let waitRun = 0;

  function report(next) {
    state = next;
    changed();
  }

  function base() {
    return { version: release.version, from: currentVersion, notesUrl: release.notesUrl };
  }

  // What the last swap wrote, shown once on the start after it.
  function showLastResult() {
    const result = lastResult();
    if (!result) return;
    log(`swap to ${result.version}: ${result.ok ? 'done' : `failed: ${result.error}`}`);
    const notesUrl = `https://github.com/worktabs/worktabs/releases/tag/v${result.version}`;
    if (result.ok && result.version === currentVersion) {
      report({ status: 'done', version: result.version, from: '', notesUrl });
    } else if (!result.ok) {
      report({ status: 'failed', version: result.version, from: currentVersion, notesUrl, detail: swapError(result.error) });
    }
  }

  // `manual`: asked for from the menu, which says so when there is nothing newer.
  async function check({ manual = false } = {}) {
    if (BUSY.includes(state.status)) return;
    let found;
    try {
      found = await find();
    } catch (error) {
      log(`check failed: ${error.message}`);
      if (manual) messageBox({ type: 'error', message: t('Could not check for a new version of Worktabs: {error}', { error: error.message }) });
      return;
    }
    if (BUSY.includes(state.status)) return;
    log(`check: ${found ? `${currentVersion} -> ${found.version}` : 'up to date'}`);
    if (!found || (!manual && found.version === skipped())) {
      if (state.status === 'available') report({ status: 'none' });
      if (manual && !found) messageBox({ type: 'info', message: t('Worktabs {version} is the newest version.', { version: currentVersion }) });
      return;
    }
    release = found;
    // The swap of this version failed at the last quit: the card keeps saying so, and can retry.
    if (state.status === 'failed' && state.version === found.version) {
      report({ ...state, canApply: Boolean(appPath) });
      return;
    }
    report({ status: 'available', ...base(), canApply: Boolean(appPath), detail: appPath ? '' : reason });
  }

  async function start() {
    if (!release || !appPath || !['available', 'failed'].includes(state.status)) return;
    let shown = 0;
    const progress = (mb, totalMb) => {
      if (now() - shown < 1000) return;
      shown = now();
      const of = totalMb ? ` / ${totalMb.toFixed(0)} MB` : ' MB';
      report({ status: 'downloading', ...base(), detail: `${mb.toFixed(0)}${of}` });
    };
    report({ status: 'downloading', ...base(), detail: '' });
    try {
      staged = await stage(release, progress);
      log(`staged ${release.version} at ${staged.staged}`);
      report({ status: 'ready', ...base() });
    } catch (error) {
      log(`staging failed: ${error.message}`);
      staged = null;
      report({ status: 'failed', ...base(), detail: error.message });
    }
  }

  // Quits once no tab would lose work, and starts the new version after the swap.
  async function restart() {
    if (state.status !== 'ready') return;
    const run = ++waitRun;
    for (;;) {
      const { busy, unobserved } = await risks();
      if (run !== waitRun) return;
      if (!busy.length) break;
      const detail = unobserved ? t('Close the tabs where Worktabs cannot see whether Codex is working.') : t('Wait for work to finish and save changes before restarting.');
      report({ status: 'waiting', ...base(), busy, detail });
      await sleep(3000);
      if (run !== waitRun) return;
    }
    report({ status: 'ready', ...base() });
    relaunch = true;
    quit();
  }

  // The window stayed open after "Restart now" (quitting was canceled): a later quit only installs.
  function quitCanceled() {
    relaunch = false;
  }

  function cancel() {
    if (state.status !== 'waiting') return;
    waitRun++;
    report({ status: 'ready', ...base() });
  }

  function skipVersion() {
    if (state.status !== 'available') return;
    skip(release.version);
    report({ status: 'none' });
  }

  function dismiss() {
    if (['available', 'done', 'failed'].includes(state.status)) report({ status: 'none' });
  }

  // From the app's will-quit: an update made ready is swapped in after the app exits.
  function onQuit() {
    if (!staged || !['ready', 'waiting'].includes(state.status)) return;
    log(`swapping in ${release.version}${relaunch ? ' and restarting' : ''}`);
    try { swap(staged, release.version, relaunch); }
    catch (error) { log(`swap failed to start: ${error.message}`); }
  }

  return {
    get state() { return state; },
    showLastResult, check, start, restart, quitCanceled, cancel, skipVersion, dismiss, onQuit,
  };
}

// The words for what the swap reported: the shell script on macOS reports a step.
function swapError(error) {
  if (error === 'wait') return t('Worktabs did not quit in time. The previous version stays.');
  if (error === 'move') return t('Worktabs could not be replaced. The previous version stays.');
  return t('{error}. The previous version stays.', { error: error || t('Unknown error') });
}

module.exports = { createSelfUpdate };
