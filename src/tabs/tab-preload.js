// The preload script of the views that show code-server's workbench (the tabs and the update
// probe). It runs in a sandbox before the page does, so it requires nothing.
//
// code-server serves the webviews (the Claude Code and Codex chats, and every other extension's)
// from the workbench's own origin, so Chromium runs them in the workbench's renderer process, on
// its main thread: a webview that keeps that thread busy stops the whole VS Code. Desktop VS Code
// (vscode-webview://) and vscode.dev (<hash>.vscode-cdn.net) serve them from other sites, which
// gives each one a process of its own. Here the workbench's configuration is rewritten before the
// workbench reads it, so that each webview comes from <hash>.localhost on the same port: Chromium
// resolves *.localhost to the loopback address, and the webview's host page requires its host
// name to start with that hash, which the workbench puts in place of {{uuid}}. webview-sites.js
// has the workbench frame them and gives their host pages the tab's session cookie.

const CONFIGURATION_ID = 'vscode-workbench-web-configuration';
const WEBVIEW_PATH = '/out/vs/workbench/contrib/webview/browser/pre';
const WEBVIEW_HOST = '.localhost';

// The workbench configuration (the JSON in the meta's data-settings) with webviewEndpoint moved to
// <hash>.localhost, or null when there is nothing to move. `page`: the workbench's address, on
// 127.0.0.1 (localhost would be the same site as the webviews).
function crossSiteSettings(text, page) {
  try {
    const here = new URL(page);
    const settings = JSON.parse(text);
    if (here.hostname !== '127.0.0.1' || !here.port || typeof settings?.webviewEndpoint !== 'string') return null;
    const endpoint = new URL(settings.webviewEndpoint, here);
    const pathname = endpoint.pathname.replace(/\/$/, '');
    if (endpoint.origin !== here.origin || !pathname.endsWith(WEBVIEW_PATH)) return null;
    return JSON.stringify({ ...settings, webviewEndpoint: `http://{{uuid}}${WEBVIEW_HOST}:${here.port}${pathname}` });
  } catch {
    return null;
  }
}

// Rewrites the configuration as the parser adds it. The observer's callback runs before the
// parser runs the next script, so before the workbench reads it. A page without it (a
// placeholder) is left alone once it has loaded.
function watchConfiguration(doc, page, Observer) {
  const rewrite = () => {
    const meta = doc.getElementById(CONFIGURATION_ID);
    if (!meta) return false;
    const settings = crossSiteSettings(meta.getAttribute('data-settings'), page);
    if (settings) meta.setAttribute('data-settings', settings);
    return true;
  };
  if (rewrite()) return;
  const observer = new Observer(() => { if (rewrite()) observer.disconnect(); });
  observer.observe(doc, { childList: true, subtree: true });
  doc.addEventListener('DOMContentLoaded', () => observer.disconnect(), { once: true });
}

const scope = /** @type {any} */ (globalThis);
if (scope.document && scope.location && scope.MutationObserver) watchConfiguration(scope.document, scope.location.href, scope.MutationObserver);

if (typeof module !== 'undefined') module.exports = { WEBVIEW_HOST, WEBVIEW_PATH, crossSiteSettings, watchConfiguration };
