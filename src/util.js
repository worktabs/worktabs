// Small helpers that several modules share. Testable without Electron.
// wsl-agent.js keeps its own copies: it is written into WSL and runs there by itself.
const path = require('path');

// Resolves after `ms` milliseconds.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An error, or a message, in one line, for the log.
function oneLine(error) {
  return String((error && error.message) || error).replace(/\s*\r?\n\s*/g, ' ');
}

// Whether `a` and `b` name the same folder, ignoring case (Windows and macOS file systems).
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// `fn`, run once on the next turn (`schedule`) however many times it is called before then:
// for work whose callers come in bursts and only the latest state matters.
function coalesce(fn, schedule = setImmediate) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      fn();
    });
  };
}

// `fn` on each of `items`, `limit` at a time, resolving to their results in the order of `items`.
// `fn` handles its own failures: one that rejects rejects the whole.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const work = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
  return results;
}

// An onProgress(mb, totalMb) for a download that hands on report(size, fraction) at most once a
// second: `size` as "70 / 236 MB" ("70 MB" when the server does not say how big it is), and
// `fraction` the part done, from 0 to 1 (null when the size is not known). The end of a download
// of known size is reported at once, to `finished(size)` when given: what follows a download
// (extracting, installing) reports nothing, so its caller says that instead of showing a download
// that never quite ends.
/** @param {(size: string, fraction: number | null) => void} report @param {{ finished?: ((size: string) => void) | null, now?: () => number }} [options] */
function downloadReporter(report, { finished = null, now = Date.now } = {}) {
  let shown = 0;
  let ended = false;
  return (/** @type {number} */ mb, /** @type {number} */ totalMb) => {
    if (ended) return;
    const size = `${mb.toFixed(0)}${totalMb ? ` / ${totalMb.toFixed(0)}` : ''} MB`;
    if (totalMb && mb >= totalMb) {
      ended = true;
      if (finished) finished(size);
      else report(size, 1);
      return;
    }
    if (now() - shown < 1000) return;
    shown = now();
    report(size, totalMb ? mb / totalMb : null);
  };
}

// Keeps an app page (the side bar, the dialog) where it is. A link or file dropped on it would
// otherwise open in its place, with the page's preload and so its IPC; new windows are refused.
// Loads from the main process (loadFile, reload) are not navigations a page starts.
function keepPage(contents) {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

module.exports = { coalesce, downloadReporter, keepPage, mapLimit, oneLine, samePath, sleep };
