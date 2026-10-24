const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { crossSiteSettings, watchConfiguration } = require('../src/tabs/tab-preload');
const { allowWebviewFrames, createWebviewSites } = require('../src/tabs/webview-sites');

const PAGE = 'http://127.0.0.1:5001/?folder=/src/app';
const PRE = 'stable-abc/static/out/vs/workbench/contrib/webview/browser/pre';
const settings = (extra = {}) => JSON.stringify({ remoteAuthority: 'remote', webviewEndpoint: PRE, ...extra });

test('the webviews move to <hash>.localhost on the page\'s port, and nothing else changes', () => {
  assert.deepEqual(JSON.parse(crossSiteSettings(settings(), PAGE)), {
    remoteAuthority: 'remote', webviewEndpoint: 'http://{{uuid}}.localhost:5001/stable-abc/static/out/vs/workbench/contrib/webview/browser/pre',
  });
  assert.match(crossSiteSettings(settings({ webviewEndpoint: `/${PRE}/` }), PAGE), /localhost:5001\/stable-abc\/.*\/pre"/);
});

test('a configuration with nothing to move is left alone', () => {
  for (const [text, page] of [
    [settings(), 'http://localhost:5001/'], // The same site as the webviews would be.
    [settings(), 'file:///placeholder.html'],
    [settings({ webviewEndpoint: 'https://{{uuid}}.vscode-cdn.net/stable/out/vs/workbench/contrib/webview/browser/pre' }), PAGE],
    [settings({ webviewEndpoint: 'stable-abc/static/somewhere-else' }), PAGE],
    [JSON.stringify({ remoteAuthority: 'remote' }), PAGE],
    ['not json', PAGE],
    [null, PAGE],
  ]) assert.equal(crossSiteSettings(text, page), null, `${text} on ${page}`);
});

// A document whose configuration meta the parser adds later, or has from the start.
function page({ meta = null } = {}) {
  const listeners = {};
  let observer = null;
  const doc = {
    meta,
    getElementById: (id) => (id === 'vscode-workbench-web-configuration' ? doc.meta : null),
    addEventListener: (name, listener) => { listeners[name] = listener; },
    fire: (name) => listeners[name]?.(),
  };
  class Observer {
    constructor(callback) { this.callback = callback; this.connected = false; observer = this; }
    observe(target, options) { this.connected = target === doc && options.subtree && options.childList; }
    disconnect() { this.connected = false; }
  }
  return { doc, Observer, observer: () => observer };
}

test('the configuration is rewritten as soon as the parser adds it, and then no more is watched', () => {
  const p = page();
  watchConfiguration(p.doc, PAGE, p.Observer);
  assert.equal(p.observer().connected, true);
  p.observer().callback();
  assert.equal(p.observer().connected, true);
  const meta = { text: settings(), getAttribute: () => meta.text, setAttribute: (_name, value) => { meta.text = value; } };
  p.doc.meta = meta;
  p.observer().callback();
  assert.match(meta.text, /\{\{uuid\}\}\.localhost:5001/);
  assert.equal(p.observer().connected, false);
});

test('a page that has its configuration already is rewritten at once, and one without it is let go once loaded', () => {
  const meta = { text: settings(), getAttribute: () => meta.text, setAttribute: (_name, value) => { meta.text = value; } };
  const ready = page({ meta });
  watchConfiguration(ready.doc, PAGE, ready.Observer);
  assert.match(meta.text, /localhost:5001/);
  assert.equal(ready.observer(), null);

  const placeholder = page();
  watchConfiguration(placeholder.doc, 'file:///placeholder.html', placeholder.Observer);
  placeholder.doc.fire('DOMContentLoaded');
  assert.equal(placeholder.observer().connected, false);
});

test('the workbench may frame the webviews of its port, whichever directive frames fall back to', () => {
  const policy = "default-src 'self'; child-src 'self'; frame-src 'self' https://*.vscode-cdn.net data:; worker-src 'self'";
  assert.equal(allowWebviewFrames(policy, '5001'),
    "default-src 'self'; child-src 'self'; frame-src 'self' https://*.vscode-cdn.net data: http://*.localhost:5001; worker-src 'self';");
  assert.equal(allowWebviewFrames(allowWebviewFrames(policy, '5001'), '5001'), allowWebviewFrames(policy, '5001'));
  assert.equal(allowWebviewFrames("default-src 'self'; child-src 'self' blob:", '5001'),
    "default-src 'self'; child-src 'self' blob:; frame-src 'self' blob: http://*.localhost:5001;");
  assert.equal(allowWebviewFrames("default-src 'none'", '5001'), "default-src 'none'; frame-src http://*.localhost:5001;");
  assert.equal(allowWebviewFrames("script-src 'self'", '5001'), "script-src 'self'");
});

test('only the webview host pages of a known instance get its session cookie', () => {
  const sites = createWebviewSites();
  sites.connect(5001, { name: 'code-server-session-t1', value: 'key' });
  const host = `http://abc123.localhost:5001/${PRE}/index.html?id=1`;
  assert.deepEqual(sites.requestHeaders(host, { Accept: '*/*' }), { Accept: '*/*', Cookie: 'code-server-session-t1=key' });
  assert.deepEqual(sites.requestHeaders(host, { cookie: 'other=1' }), { cookie: 'other=1; code-server-session-t1=key' });
  // The content's own requests, the workbench itself, and other ports go without it.
  assert.equal(sites.requestHeaders('http://abc123.localhost:5001/stable-abc/static/out/vs/code/browser/workbench/workbench.js', {}), null);
  assert.equal(sites.requestHeaders('http://abc123.localhost:5001/vscode-remote-resource?path=/etc/passwd', {}), null);
  assert.equal(sites.requestHeaders(`http://127.0.0.1:5001/${PRE}/index.html`, {}), null);
  assert.equal(sites.requestHeaders(`http://abc123.localhost:5002/${PRE}/index.html`, {}), null);
  assert.equal(sites.requestHeaders('not a url', {}), null);
});

test('only a known instance\'s workbench page gets its policy changed', () => {
  const sites = createWebviewSites();
  sites.connect(5001, { name: 'n', value: 'v' });
  const headers = { 'Content-Security-Policy': ["frame-src 'self'"], 'Content-Type': ['text/html'] };
  assert.deepEqual(sites.responseHeaders(PAGE, 'mainFrame', headers), {
    'Content-Security-Policy': ["frame-src 'self' http://*.localhost:5001;"], 'Content-Type': ['text/html'],
  });
  assert.equal(sites.responseHeaders(PAGE, 'script', headers), null);
  assert.equal(sites.responseHeaders('http://127.0.0.1:5002/', 'mainFrame', headers), null);
  assert.equal(sites.responseHeaders(PAGE, 'mainFrame', { 'Content-Type': ['text/html'] }), null);
});

test('the listeners are attached to the session and answer through its callbacks', () => {
  const sites = createWebviewSites();
  sites.connect(5001, { name: 'n', value: 'v' });
  const webRequest = new EventEmitter();
  const filters = {};
  const session = { webRequest: {
    onBeforeSendHeaders: (filter, listener) => { filters.send = filter; webRequest.on('send', listener); },
    onHeadersReceived: (filter, listener) => { filters.receive = filter; webRequest.on('receive', listener); },
  } };
  sites.attach(/** @type {any} */ (session));
  assert.deepEqual(filters, { send: { urls: ['http://*.localhost/*'] }, receive: { urls: ['http://127.0.0.1/*'] } });
  const answers = [];
  webRequest.emit('send', { url: `http://abc.localhost:5001/${PRE}/index.html`, requestHeaders: {} }, (answer) => answers.push(answer));
  webRequest.emit('send', { url: 'http://abc.localhost:5001/other', requestHeaders: {} }, (answer) => answers.push(answer));
  webRequest.emit('receive', { url: PAGE, resourceType: 'mainFrame', responseHeaders: { 'content-security-policy': ["frame-src 'self'"] } }, (answer) => answers.push(answer));
  webRequest.emit('receive', { url: PAGE, resourceType: 'image' }, (answer) => answers.push(answer));
  assert.deepEqual(answers, [
    { requestHeaders: { Cookie: 'n=v' } }, {},
    { responseHeaders: { 'content-security-policy': ["frame-src 'self' http://*.localhost:5001;"] } }, {},
  ]);
});
