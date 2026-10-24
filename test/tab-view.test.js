const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { closeTabPage, createTabViews } = require('../src/tabs/tab-view');
const { CHAT_FOCUS_GUARD, WEBVIEW_FRAME, pageFocusScript } = require('../src/conversations/chat-frames');
const { codexApprovalScript } = require('../src/codex/codex-approval');
const { codexOnboardingScript } = require('../src/agents/agent-onboarding');

function setup({ open = true, frame = null, frames = [] } = {}) {
  const calls = [];
  const loaded = [];
  const contents = new EventEmitter();
  contents.getURL = () => 'http://127.0.0.1:5001/?folder=/src/app';
  contents.focused = false;
  contents.isFocused = () => contents.focused;
  contents.mainFrame = { framesInSubtree: frames };
  contents.setWindowOpenHandler = (handler) => { contents.openHandler = handler; };
  const createTabView = createTabViews({
    makeView: () => ({ webContents: contents }),
    frameOf: (processId, routingId) => { calls.push(['frame', processId, routingId]); return frame; },
    folderFromUrl: (url) => (url.includes('folder=') ? '/src/other' : null),
    openTab: (folder) => calls.push(['open', folder]),
    openExternal: (url) => calls.push(['external', url]),
    hostKeys: (_event, input, target) => calls.push(['keys', input.key, target === contents]),
    current: () => open,
    approvalMode: () => 'manual',
    changed: () => calls.push(['changed']),
    chatLoaded: (tab, agent) => loaded.push([tab.id, agent]),
  });
  return { createTabView, contents, calls, loaded };
}

test('new windows of a code-server folder become tabs, web links open in the browser, and nothing opens in Electron', () => {
  const { createTabView, contents, calls } = setup();
  const view = createTabView({ id: 't1' });
  assert.equal(view.webContents, contents);
  assert.deepEqual(contents.openHandler({ url: 'http://127.0.0.1:5001/?folder=/src/other' }), { action: 'deny' });
  assert.deepEqual(contents.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.deepEqual(contents.openHandler({ url: 'file:///etc/passwd' }), { action: 'deny' });
  assert.deepEqual(calls, [['open', '/src/other'], ['external', 'https://example.com/']]);
});

test('leaving the page is not asked about, and the keys go to the app first', () => {
  const { createTabView, contents, calls } = setup();
  createTabView({ id: 't1' });
  let prevented = false;
  contents.emit('will-prevent-unload', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  contents.emit('before-input-event', {}, { key: 'Tab' });
  assert.deepEqual(calls, [['keys', 'Tab', true]]);
});

// A chat's page frame, inside the webview host frame that names its extension.
function chatFrame(extensionId, scripts) {
  const base = `http://127.0.0.1:5001/stable${WEBVIEW_FRAME}`;
  return {
    url: `${base}fake.html`, parent: { url: `${base}index.html?extensionId=${extensionId}` },
    executeJavaScript: async (script) => scripts.push(script),
  };
}

test('a Claude chat frame gets the focus guard, and the main frame nothing', () => {
  const scripts = [];
  const { createTabView, contents, calls } = setup({ frame: chatFrame('Anthropic.claude-code', scripts) });
  createTabView({ id: 't1' });
  contents.emit('did-frame-finish-load', {}, true, 1, 2);
  assert.deepEqual(calls, []);
  contents.emit('did-frame-finish-load', {}, false, 1, 2);
  assert.deepEqual(calls, [['frame', 1, 2]]);
  assert.deepEqual(scripts, [pageFocusScript(false), CHAT_FOCUS_GUARD]);
});

test('the Claude chats are told when the page gets and loses the focus, which they cannot read from their own site', () => {
  const claude = [];
  const codex = [];
  const { createTabView, contents } = setup({ frames: [chatFrame('Anthropic.claude-code', claude), chatFrame('openai.chatgpt', codex)] });
  createTabView({ id: 't1' });
  contents.focused = true;
  contents.emit('focus');
  contents.focused = false;
  contents.emit('blur');
  assert.deepEqual(claude, [pageFocusScript(true), pageFocusScript(false)]);
  assert.deepEqual(codex, []);
  // A page that has gone answers no more.
  Object.defineProperty(contents, 'mainFrame', { get: () => { throw new Error('destroyed'); } });
  assert.doesNotThrow(() => contents.emit('focus'));
});

test('a Codex chat frame gets the approval mode, and in a linked worktree the onboarding too', () => {
  const scripts = [];
  const { createTabView, contents } = setup({ frame: chatFrame('openai.chatgpt', scripts) });
  createTabView({ id: 't1' });
  contents.emit('did-frame-finish-load', {}, false, 1, 2);
  assert.deepEqual(scripts, [codexApprovalScript('manual')]);

  const linked = [];
  const worktree = setup({ frame: chatFrame('openai.chatgpt', linked) });
  worktree.createTabView({ id: 't2', linkedWorktree: true });
  worktree.contents.emit('did-frame-finish-load', {}, false, 1, 2);
  assert.deepEqual(linked, [codexOnboardingScript(), codexApprovalScript('manual')]);
});

test('a page process that ends shows on its open tab only', () => {
  const tab = { id: 't1' };
  const { createTabView, contents, calls } = setup();
  createTabView(tab);
  contents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.match(tab.error, /crashed/);
  assert.deepEqual(calls, [['changed']]);

  const closed = setup({ open: false });
  const gone = { id: 't2' };
  closed.createTabView(gone);
  closed.contents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(gone.error, undefined);
});

// A page that records when it is closed, against a clock the waits move on.
function closingPage() {
  const events = [];
  let destroyed = false;
  let at = 0;
  return {
    events,
    destroy: () => { destroyed = true; },
    contents: { isDestroyed: () => destroyed, close: () => { events.push(['close', at]); destroyed = true; } },
    sleep: async (ms) => { at += ms; events.push(['wait', ms]); },
  };
}

test('a tab\'s page is closed a moment after it leaves the window, so that VS Code can save its state', async () => {
  const page = closingPage();
  await closeTabPage(page.contents, { sleep: page.sleep });
  assert.deepEqual(page.events, [['wait', 500], ['close', 500]]);
});

test('a page that has gone meanwhile, or before, is not closed again', async () => {
  const meanwhile = closingPage();
  await closeTabPage(meanwhile.contents, { sleep: async (ms) => { await meanwhile.sleep(ms); meanwhile.destroy(); } });
  assert.deepEqual(meanwhile.events, [['wait', 500]]);
  const before = closingPage();
  before.destroy();
  await closeTabPage(before.contents, { sleep: before.sleep });
  assert.deepEqual(before.events, []);
});

test('each agent chat frame that loads is watched as it starts; other frames are not', () => {
  for (const [extensionId, agent] of [['Anthropic.claude-code', 'claude'], ['openai.chatgpt', 'codex'], ['vscode.markdown-language-features', null]]) {
    const { createTabView, contents, loaded } = setup({ frame: chatFrame(extensionId, []) });
    createTabView({ id: 't1' });
    contents.emit('did-frame-finish-load', {}, true, 1, 2);
    contents.emit('did-frame-finish-load', {}, false, 1, 2);
    assert.deepEqual(loaded, agent ? [['t1', agent]] : []);
  }
});
