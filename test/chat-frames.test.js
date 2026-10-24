const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { VISIBLE_CHAT_FRAMES_SCRIPT } = require('../src/conversations/seen-conversations');
const { CHAT_FOCUS_GUARD, chatAgent, codexChatFrames, isClaudeChatFrame, isCodexChatFrame, pageFocusScript, shownConversations, visibleCodexFrames } = require('../src/conversations/chat-frames');

// A chat frame for the focus guard to run in. `top`: what window.top.document.hasFocus() answers,
// or 'cross-site' for a chat that may not read the page.
function guardedChat({ top, frameFocused = false }) {
  const focused = [];
  class HTMLElement { focus() { focused.push(this.name); } }
  class SVGElement { focus() { focused.push(this.name); } }
  const window = {
    get top() {
      if (top === 'cross-site') return { get document() { throw new Error('SecurityError: cross-origin frame'); } };
      return { document: { hasFocus: () => top } };
    },
  };
  const context = vm.createContext({ window, HTMLElement, SVGElement, document: { hasFocus: () => frameFocused } });
  vm.runInContext(CHAT_FOCUS_GUARD, context);
  const input = Object.assign(new HTMLElement(), { name: 'input' });
  return { focused, focus: () => input.focus(), run: (script) => vm.runInContext(script, context) };
}

test('a chat without the focus may not take it while another part of the page has it', () => {
  const sameSite = guardedChat({ top: true });
  sameSite.focus();
  assert.deepEqual(sameSite.focused, []);
  const windowAway = guardedChat({ top: false });
  windowAway.focus();
  assert.deepEqual(windowAway.focused, ['input']);
  const hasIt = guardedChat({ top: true, frameFocused: true });
  hasIt.focus();
  assert.deepEqual(hasIt.focused, ['input']);
});

test('a chat on a site of its own goes by what the app tells it about the page\'s focus', () => {
  const chat = guardedChat({ top: 'cross-site' });
  chat.focus();
  assert.deepEqual(chat.focused, ['input']);
  chat.run(pageFocusScript(true));
  chat.focus();
  assert.deepEqual(chat.focused, ['input']);
  chat.run(pageFocusScript(false));
  chat.focus();
  assert.deepEqual(chat.focused, ['input', 'input']);
});

const host = (extensionId, n = 1) => ({ url: `http://127.0.0.1:1/stable/x/static/out/vs/workbench/contrib/webview/browser/pre/index.html?id=${n}&extensionId=${extensionId}` });
const chat = (parent, conversation) => ({
  parent,
  url: 'http://127.0.0.1:1/stable/x/static/out/vs/workbench/contrib/webview/browser/pre/fake.html',
  executeJavaScript: async () => conversation,
});

function page(frames, visible) {
  let asked = 0;
  return {
    mainFrame: { framesInSubtree: frames },
    executeJavaScript: async (script) => {
      assert.equal(script, VISIBLE_CHAT_FRAMES_SCRIPT);
      return typeof visible === 'function' ? visible(asked++) : visible;
    },
  };
}

test('a chat frame is known by the extension its host frame names', () => {
  const claude = chat(host('Anthropic.claude-code'));
  const codex = chat(host('openai.chatgpt'));
  assert.equal(isClaudeChatFrame(claude), true);
  assert.equal(isCodexChatFrame(codex), true);
  assert.equal(chatAgent(claude), 'claude');
  assert.equal(chatAgent(codex), 'codex');
  assert.equal(chatAgent(chat(host('other.extension'))), null);
  // The host frame itself, a frame outside webviews, and a host whose URL cannot be read.
  assert.equal(chatAgent({ ...host('openai.chatgpt'), parent: null }), null);
  assert.equal(chatAgent({ url: 'http://127.0.0.1:1/', parent: host('openai.chatgpt') }), null);
  assert.equal(chatAgent(chat({ url: 'not a url /contrib/webview/browser/pre/' })), null);
});

test('only the Codex chats in view are found', async () => {
  const shownHost = host('openai.chatgpt', 1);
  const hiddenHost = host('openai.chatgpt', 2);
  const shown = chat(shownHost);
  const hidden = chat(hiddenHost);
  const claude = chat(host('anthropic.claude-code', 3));
  const contents = page([shownHost, shown, hiddenHost, hidden, claude], [shownHost.url, claude.parent.url]);
  assert.deepEqual(await visibleCodexFrames(contents), [shown]);
  assert.deepEqual(codexChatFrames(contents), [shown, hidden]);
});

test('the conversations shown leave out a chat that left the view while it was asked', async () => {
  const claudeHost = host('anthropic.claude-code', 1);
  const codexHost = host('openai.chatgpt', 2);
  const claude = chat(claudeHost, { agent: 'claude', id: 'a' });
  const codex = chat(codexHost, { agent: 'codex', id: 'b' });
  const both = [claudeHost.url, codexHost.url];
  assert.deepEqual(await shownConversations(page([claude, codex], both)), [{ agent: 'claude', id: 'a' }, { agent: 'codex', id: 'b' }]);
  const left = page([claude, codex], (asked) => (asked === 0 ? both : [codexHost.url]));
  assert.deepEqual(await shownConversations(left), [{ agent: 'codex', id: 'b' }]);
  // A chat that cannot be asked shows no conversation.
  const failing = { ...claude, executeJavaScript: async () => { throw new Error('gone'); } };
  assert.deepEqual(await shownConversations(page([failing], both)), [null]);
});
