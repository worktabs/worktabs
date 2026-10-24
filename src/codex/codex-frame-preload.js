// A preload script of every frame of the views that show code-server's workbench (the tabs and
// the update probe), registered on their session. It acts only in the host frame of Codex's chat
// webview. It runs in the sandbox, so it requires nothing but electron.
//
// Codex 26.1021.22027 preloads 3,203 modules before its chat starts: Vite's preload helper adds a
// <link rel="modulepreload"> for each, after comparing it with every <link> already in the page.
// In a webview on screen, on a busy machine (four Codex tabs opened at once), the page's main
// thread then never came back: four times out of four, against none out of two with the list
// emptied at runtime. Without the links, the modules load as the chat imports them.
//
// Electron runs this script in VS Code's webview host frame (.../webview/browser/pre/index.html),
// but not in the frame inside it that holds the chat's page: the host creates that frame from a
// script, loads fake.html in it, and writes the page into it a moment after fake.html's
// DOMContentLoaded (document.write, which keeps the frame's window). So the host frame changes
// each such frame's window at that DOMContentLoaded, before the page's scripts run.

const EXTENSION = 'openai.chatgpt';
const WEBVIEW_PATH = '/out/vs/workbench/contrib/webview/browser/pre/';

// Whether `href` is the host frame of Codex's webview, whose address names its extension.
function isCodexWebviewHost(href) {
  try {
    const url = new URL(href);
    return url.pathname.includes(WEBVIEW_PATH) && url.searchParams.get('extensionId')?.toLowerCase() === EXTENSION;
  } catch {
    return false;
  }
}

// Leaves <link rel="modulepreload"> out of the page of every frame the host frame creates. Runs in
// the host frame's own world (it is serialized there); `scope` is for the tests.
function skipModulePreloadsInPages(scope = globalThis) {
  const skip = (win) => {
    const prototype = win.Node.prototype;
    if (prototype.appendChild.worktabsSkipsModulePreloads) return;
    const append = prototype.appendChild;
    const appendChild = function appendChild(node) {
      if (node instanceof win.HTMLLinkElement && node.relList.contains('modulepreload')) return node;
      return append.call(this, node);
    };
    appendChild.worktabsSkipsModulePreloads = true;
    prototype.appendChild = appendChild;
  };
  const watch = (frame) => {
    frame.contentWindow?.addEventListener('DOMContentLoaded', () => {
      try { skip(frame.contentWindow); } catch { /* Gone, or another site. */ }
    });
  };
  new scope.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof scope.HTMLIFrameElement) watch(node);
    }
  }).observe(scope.document, { childList: true, subtree: true });
}

const page = /** @type {any} */ (globalThis);
if (page.document && page.location && isCodexWebviewHost(page.location.href)) {
  require('electron').contextBridge.executeInMainWorld({ func: skipModulePreloadsInPages });
}

if (typeof module !== 'undefined') module.exports = { isCodexWebviewHost, skipModulePreloadsInPages };
