// Serialized into an agent chat's page: waits there for what the app looks for, rather than the
// app asking the page again and again. executeJavaScript resolves the promise it returns.
// Self-contained, as it runs in the page.

// Runs `check` now, after the page changes (at most every 50 ms), and every second, until it
// gives a result `done` accepts, or `wait` milliseconds have passed. Resolves the last result
// (null if `check` threw). `environment`: the page's window.
function waitInPage(check, done, wait, environment) {
  const { document, MutationObserver, setTimeout, clearTimeout, setInterval, clearInterval } = environment;
  return new Promise((resolve) => {
    let last = null;
    let scheduled = null;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(scheduled);
      clearInterval(interval);
      clearTimeout(timer);
      resolve(result);
    };
    const run = () => {
      scheduled = null;
      try { last = check(); } catch { last = null; }
      if (done(last)) finish(last);
    };
    const observer = new MutationObserver(() => {
      if (!scheduled && !finished) scheduled = setTimeout(run, 50);
    });
    const interval = setInterval(run, 1000);
    const timer = setTimeout(() => finish(last), wait);
    observer.observe(document, { childList: true, subtree: true, attributes: true });
    run();
  });
}

module.exports = { waitInPage };
