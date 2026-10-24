const assert = require('node:assert/strict');
const test = require('node:test');
const { isCodexWebviewHost, skipModulePreloadsInPages } = require('../src/codex/codex-frame-preload');

const PRE = 'http://127.0.0.1:5001/stable-abc/static/out/vs/workbench/contrib/webview/browser/pre';

test('only the host frame of Codex\'s webview is acted in', () => {
  assert.equal(isCodexWebviewHost(`${PRE}/index.html?id=1&extensionId=openai.chatgpt&purpose=webviewView`), true);
  assert.equal(isCodexWebviewHost(`http://abc.localhost:5001/stable-abc/static/out/vs/workbench/contrib/webview/browser/pre/index.html?extensionId=OpenAI.chatgpt`), true);
  assert.equal(isCodexWebviewHost(`${PRE}/index.html?id=1&extensionId=Anthropic.claude-code`), false);
  assert.equal(isCodexWebviewHost(`${PRE}/fake.html?id=1`), false);
  assert.equal(isCodexWebviewHost('http://127.0.0.1:5001/?folder=/src/app&extensionId=openai.chatgpt'), false);
  assert.equal(isCodexWebviewHost('about:blank'), false);
  assert.equal(isCodexWebviewHost('not a url'), false);
});

// A window of a frame the host creates: its own Node and HTMLLinkElement, and DOMContentLoaded.
function pageWindow() {
  const appended = [];
  const listeners = {};
  class Node { appendChild(node) { appended.push(node); return node; } }
  class HTMLLinkElement extends Node {
    constructor(rel) { super(); this.rel = rel; this.relList = { contains: (value) => rel.split(' ').includes(value) }; }
  }
  return {
    appended, Node, HTMLLinkElement,
    addEventListener: (type, listener) => { (listeners[type] ||= []).push(listener); },
    fire: (type) => (listeners[type] || []).forEach((listener) => listener()),
  };
}

// The host frame's world: its frames as the parser or a script adds them.
function hostScope() {
  let callback = null;
  class HTMLIFrameElement {}
  return {
    HTMLIFrameElement,
    document: {},
    MutationObserver: class { constructor(cb) { callback = cb; } observe(target, options) { assert.equal(options.subtree, true); } },
    add: (...nodes) => callback([{ addedNodes: nodes }]),
    frame: (contentWindow) => Object.assign(new HTMLIFrameElement(), { contentWindow }),
  };
}

test('a frame\'s page appends no modulepreload links once it has loaded, and everything else as before', () => {
  const scope = hostScope();
  skipModulePreloadsInPages(scope);
  const win = pageWindow();
  scope.add({ nodeName: 'DIV' }, scope.frame(win));
  const body = new win.Node();
  body.appendChild(new win.HTMLLinkElement('modulepreload'));
  assert.equal(win.appended.length, 1, 'before DOMContentLoaded, nothing has changed yet');
  win.fire('DOMContentLoaded');
  const preload = new win.HTMLLinkElement('modulepreload');
  assert.equal(body.appendChild(preload), preload);
  const stylesheet = new win.HTMLLinkElement('stylesheet');
  const other = new win.Node();
  body.appendChild(stylesheet);
  body.appendChild(other);
  assert.deepEqual(win.appended.slice(1), [stylesheet, other]);
});

test('a window is changed once, and a frame whose window cannot be reached is left alone', () => {
  const scope = hostScope();
  skipModulePreloadsInPages(scope);
  const win = pageWindow();
  scope.add(scope.frame(win));
  win.fire('DOMContentLoaded');
  const patched = win.Node.prototype.appendChild;
  win.fire('DOMContentLoaded');
  assert.equal(win.Node.prototype.appendChild, patched);

  const gone = { addEventListener: (_type, listener) => listener() };
  assert.doesNotThrow(() => scope.add(scope.frame(gone), scope.frame(null)));
});
