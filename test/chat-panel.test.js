const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { createChatPanel } = require('../src/conversations/chat-panel');
const { BUILT_IN_CHAT, CHAT_WIDTH_SCRIPT, ChatWidths, SECONDARY_VIEW_SCRIPT } = require('../src/conversations/secondary-sidebar');
const { WEBVIEW_FRAME } = require('../src/conversations/chat-frames');
const { VISIBLE_CHAT_FRAMES_SCRIPT } = require('../src/conversations/seen-conversations');

const repo = path.resolve('repo');

function tabOf(id, folder, answers = {}) {
  const scripts = [];
  return {
    id, folder, repo, server: 'running', repoLookup: Promise.resolve(repo), scripts,
    view: {
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: async (script) => {
          scripts.push(script);
          if (script === CHAT_WIDTH_SCRIPT) return answers.width ?? null;
          if (script === SECONDARY_VIEW_SCRIPT) return answers.view ?? null;
          return answers.resized ?? null;
        },
      },
    },
  };
}

function setup(tabList, { agent = 'claude', helper = true } = {}) {
  const calls = [];
  const chatWidths = new ChatWidths();
  const panel = createChatPanel({
    tabs: new Map(tabList.map((tab) => [tab.id, tab])),
    runs: () => 'run',
    tabIdFor: (folder) => (folder === repo ? 'primary' : folder),
    tabAgent: () => agent,
    chatWidths,
    saveTabs: () => calls.push('save'),
    callHelper: async (...args) => { calls.push(['helper', ...args]); return helper; },
    messageBox: async (options) => { calls.push(['dialog', options.detail]); return { response: 0 }; },
    copy: (text) => calls.push(['copy', text]),
    late: () => new Promise(() => {}),
  });
  return { panel, calls, chatWidths };
}

test("a primary's chat width is kept for its repository; another tab's is not", async () => {
  const primary = tabOf('primary', repo, { width: { chat: 420, shared: 1200 } });
  const worktree = tabOf('w', path.resolve('repo-fix'), { width: { chat: 300, shared: 1200 } });
  const { panel, calls, chatWidths } = setup([primary, worktree]);
  assert.deepEqual(await panel.rememberChatWidth(primary), { chat: 420, shared: 1200 });
  assert.equal(chatWidths.get(repo), 420);
  assert.deepEqual(calls, ['save']);
  assert.equal(await panel.rememberChatWidth(worktree), null);
  // The same width again saves nothing.
  await panel.rememberChatWidth(primary);
  assert.deepEqual(calls, ['save']);
});

test("a worktree's chat is sized as wide as its primary's", async () => {
  const primary = tabOf('primary', repo, { width: { chat: 420, shared: 1200 } });
  const worktree = tabOf('w', path.resolve('repo-fix'), { width: { chat: 300, shared: 1200 }, resized: { chat: 420, shared: 1200 } });
  const { panel } = setup([primary, worktree]);
  await panel.fitChat(worktree);
  assert.match(worktree.scripts.at(-1), /420/);
});

test('the agent chat replaces only the built-in chat', async () => {
  const shown = tabOf('w', path.resolve('repo-fix'), { view: BUILT_IN_CHAT });
  const other = tabOf('o', path.resolve('repo-other'), { view: 'explorer' });
  const { panel, calls } = setup([shown, other]);
  await panel.showAgentChat(other);
  assert.deepEqual(calls, []);
  await panel.showAgentChat(shown);
  assert.deepEqual(calls[0], ['helper', 'w', '/show-chat', { agent: 'claude' }]);
});

test("the task's dialog names the agent as the app does", async () => {
  const tab = tabOf('w', path.resolve('repo-fix'), { width: { chat: 300, shared: 1200 } });
  const { panel, calls } = setup([tab], { helper: null });
  await panel.startFirstConversation(tab, 'Fix the bug');
  assert.match(calls.find((call) => call[0] === 'dialog')[1], /^Open a new Claude Code conversation/);
});

test("a worktree's task waits for Codex's chat to load, then is put in it, waiting in its page", async () => {
  const base = `http://127.0.0.1:5001/stable${WEBVIEW_FRAME}`;
  const host = { url: `${base}index.html?id=1&extensionId=openai.chatgpt` };
  const scripts = [];
  const chat = { url: `${base}fake.html?id=1`, parent: host, executeJavaScript: async (script) => { scripts.push(script); return { filled: true }; } };
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    mainFrame: { framesInSubtree: [] },
    executeJavaScript: async (script) => {
      if (script === VISIBLE_CHAT_FRAMES_SCRIPT) return contents.mainFrame.framesInSubtree.length ? [host.url] : [];
      return script === CHAT_WIDTH_SCRIPT ? { chat: 300, shared: 1200 } : null;
    },
  });
  const tab = { ...tabOf('w', path.resolve('repo-fix')), view: { webContents: contents } };
  const { panel, calls } = setup([tab], { agent: 'codex', helper: { opened: true } });
  const started = Date.now();
  const done = panel.startFirstConversation(tab, 'Fix the bug');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(scripts, [], 'no chat to ask yet');
  contents.mainFrame.framesInSubtree = [host, chat];
  contents.emit('did-frame-finish-load');
  await done;
  assert.ok(Date.now() - started < 900, 'asked again as the frame loaded, not a second later');
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /Fix the bug/);
  assert.match(scripts[0], /, 10000, window\);/);
  assert.equal(calls.some((call) => call[0] === 'dialog'), false);
  assert.equal(contents.listenerCount('did-frame-finish-load'), 0);
});
