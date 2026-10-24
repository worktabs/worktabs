const { webviewReactScript } = require('./webview-react');
const { waitInPage } = require('./page-wait');

// How long a check waits in the chat's page for the thread, before the app asks again.
const PAGE_WAIT = 5000;

// A successful URI dispatch is not proof that the requested chat rendered. Read the
// mounted local thread context, including busy composers whose permission control is disabled.
function visibleCodexThread(document, propsOf) {
  try {
    const pickers = [...document.querySelectorAll('[data-composer-navigation-target="permissions"]')]
      .filter((node) => node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
    if (pickers.length !== 1) return null;
    const context = propsOf(pickers[0]).find((props) => props && Object.hasOwn(props, 'conversationId') && Object.hasOwn(props, 'hostId'));
    return context?.hostId === 'local' && typeof context.conversationId === 'string' ? context.conversationId : null;
  } catch { return null; }
}

// Waits in the chat's page, for up to `wait` milliseconds, until it shows `threadId`. Resolves
// the thread it shows then (visibleCodexThread).
function codexNavigationScript(threadId, wait = PAGE_WAIT) {
  return webviewReactScript(`const propsOf = (node) => { const found = reactAncestors(node); return found.available ? found.props : []; };
    return (${waitInPage})(() => (${visibleCodexThread})(document, propsOf), (shown) => shown === ${JSON.stringify(threadId)}, ${wait}, window);`);
}

// Fresh official webviews can take several seconds to load after the helper's URI ack. `read()`:
// the threads the Codex chats in view show, each waiting in its page for `threadId` a while.
async function confirmCodexThread({ threadId, current, read, pause, timeout = 15000,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false, timer;
  const wait = async () => {
    while (!stopped && current()) {
      let shown;
      try { shown = await read(); } catch { shown = null; }
      if (stopped || !current()) return false;
      if (Array.isArray(shown) && shown.length === 1 && shown[0] === threadId) return true;
      await pause();
    }
    return false;
  };
  try {
    return await Promise.race([wait(), new Promise((resolve) => { timer = setTimer(resolve, timeout, false); })]);
  } finally { stopped = true; clearTimer(timer); }
}

module.exports = { visibleCodexThread, codexNavigationScript, confirmCodexThread };
