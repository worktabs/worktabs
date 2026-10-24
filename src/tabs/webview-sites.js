// The main process's half of serving the webviews from sites of their own (tab-preload.js): the
// workbench's CSP gets to frame <hash>.localhost on its port, and the webview host pages there get
// the tab's session cookie, without which code-server answers 401. Only the host pages: the
// webview content runs on the same site and should reach no more of code-server than that.
// Testable without Electron; attach() takes the session.
const { WEBVIEW_HOST, WEBVIEW_PATH } = require('./tab-preload');

const parse = (url) => { try { return new URL(url); } catch { return null; } };

// The content security policy with the webviews of `port` allowed as frames. Without frame-src,
// frames fall back to child-src and then default-src, whose sources the new frame-src keeps.
function allowWebviewFrames(policy, port) {
  const source = `http://*${WEBVIEW_HOST}:${port}`;
  const directives = policy.split(';').map((directive) => directive.trim()).filter(Boolean);
  const find = (name) => directives.findIndex((directive) => directive.split(/\s+/)[0].toLowerCase() === name);
  const frames = find('frame-src');
  if (frames >= 0) {
    if (!directives[frames].split(/\s+/).includes(source)) directives[frames] += ` ${source}`;
  } else {
    const fallback = [find('child-src'), find('default-src')].find((index) => index >= 0);
    if (fallback === undefined) return policy;
    const sources = directives[fallback].split(/\s+/).slice(1).filter((item) => item !== "'none'");
    directives.push(['frame-src', ...sources, source].join(' '));
  }
  return `${directives.join('; ')};`;
}

function createWebviewSites() {
  // The session cookie of each instance's port, as "name=value".
  const cookies = new Map();

  // An instance listens on `port` with its session `cookie` ({ name, value }).
  function connect(port, cookie) {
    cookies.set(String(port), `${cookie.name}=${cookie.value}`);
  }

  // The headers of a request to send instead, with the cookie, or null to leave them.
  function requestHeaders(url, headers) {
    const target = parse(url);
    if (!target || !target.hostname.endsWith(WEBVIEW_HOST) || !target.pathname.includes(`${WEBVIEW_PATH}/`)) return null;
    const cookie = cookies.get(target.port);
    if (!cookie) return null;
    const name = Object.keys(headers).find((key) => key.toLowerCase() === 'cookie');
    return { ...headers, [name || 'Cookie']: name ? `${headers[name]}; ${cookie}` : cookie };
  }

  // The headers of a workbench page's response to use instead, with webview frames allowed, or
  // null to leave them.
  function responseHeaders(url, resourceType, headers) {
    const target = parse(url);
    if (resourceType !== 'mainFrame' || target?.hostname !== '127.0.0.1' || !cookies.has(target.port)) return null;
    const keys = Object.keys(headers).filter((key) => key.toLowerCase() === 'content-security-policy');
    if (!keys.length) return null;
    const result = { ...headers };
    for (const key of keys) result[key] = headers[key].map((policy) => allowWebviewFrames(policy, target.port));
    return result;
  }

  // Electron takes one listener of each per session; nothing else in the tabs' session uses them.
  /** @param {import('electron').Session} session */
  function attach(session) {
    session.webRequest.onBeforeSendHeaders({ urls: [`http://*${WEBVIEW_HOST}/*`] }, (details, callback) => {
      const headers = requestHeaders(details.url, details.requestHeaders);
      callback(headers ? { requestHeaders: headers } : {});
    });
    session.webRequest.onHeadersReceived({ urls: ['http://127.0.0.1/*'] }, (details, callback) => {
      const headers = responseHeaders(details.url, details.resourceType, details.responseHeaders || {});
      callback(headers ? { responseHeaders: headers } : {});
    });
  }

  return { connect, requestHeaders, responseHeaders, attach };
}

module.exports = { allowWebviewFrames, createWebviewSites };
