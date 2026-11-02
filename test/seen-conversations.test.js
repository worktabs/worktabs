const assert = require('node:assert/strict');
const test = require('node:test');
const { mountReact } = require('./fixtures/react-tree');
const { reactMountedProps } = require('../src/conversations/webview-react');
const { visibleCodexThread } = require('../src/conversations/conversation-navigation');
const { ConversationStore } = require('../src/conversations/conversation-store');
const { SeenConversations, seenConversationIds, composerProps, shownConversation,
  shownConversationScript, VISIBLE_CHAT_FRAMES_SCRIPT } = require('../src/conversations/seen-conversations');

const conversations = [
  { id: 'claude-one', unread: true }, { id: 'claude-two', unread: true },
  { id: 'codex:tab:one', agent: 'codex', threadId: 'one', unread: true },
  { id: 'codex:tab:two', agent: 'codex', threadId: 'two', unread: true },
];

test('only the exact conversation shown by each agent is seen', () => {
  assert.deepEqual(seenConversationIds(conversations, [{ agent: 'claude', id: 'claude-one' }]), ['claude-one']);
  assert.deepEqual(seenConversationIds(conversations, [{ agent: 'codex', id: 'one' }]), ['codex:tab:one']);
  assert.deepEqual(seenConversationIds(conversations, [{ agent: 'codex', id: 'claude-one' }]), []);
  for (const shown of [null, [], [{}], [{ agent: 'claude' }], [{ agent: 'claude', id: '' }], [{ agent: 'codex', id: 'unknown' }]]) {
    assert.deepEqual(seenConversationIds(conversations, shown), []);
  }
  assert.deepEqual(seenConversationIds(conversations, [{ agent: 'claude', id: 'claude-two' }, { agent: 'codex', id: 'two' }]),
    ['claude-two', 'codex:tab:two']);
});

function inputTree(props, staleProps = {}) {
  const element = { checkVisibility: () => true };
  return { ...mountReact(element, [props], { alternateProps: [staleProps] }), document: { querySelectorAll: () => [element] } };
}

const claudeProps = (id) => ({ session: { sessionId: { value: id }, isLoading: { value: false }, loadFailed: { value: false } } });

test('webview reads the mounted composer after switching an already loaded conversation', () => {
  const tree = inputTree(claudeProps('new'), claudeProps('old'));
  assert.equal(composerProps(tree.element)[0].session.sessionId.value, 'new');
  assert.deepEqual(shownConversation('claude', tree.document, composerProps), { agent: 'claude', id: 'new' });
  tree.context.memoizedProps = claudeProps('next');
  assert.deepEqual(shownConversation('claude', tree.document, composerProps), { agent: 'claude', id: 'next' });
});

test('loading, failed, hidden, unknown, and ambiguous Claude composers keep unread results', () => {
  for (const props of [{}, claudeProps(undefined), claudeProps(null),
    { session: { ...claudeProps('old').session, isLoading: { value: true } } },
    { session: { ...claudeProps('old').session, loadFailed: { value: true } } }]) {
    const tree = inputTree(props);
    assert.equal(shownConversation('claude', tree.document, composerProps), null);
  }
  const tree = inputTree(claudeProps('one'));
  tree.element.checkVisibility = () => false;
  assert.equal(shownConversation('claude', tree.document, composerProps), null);
  assert.equal(shownConversation('claude', { querySelectorAll: () => [] }, composerProps), null);
  assert.equal(shownConversation('claude', { querySelectorAll: () => [inputTree(claudeProps('one')).element,
    inputTree(claudeProps('two')).element] }, composerProps), null);
  assert.deepEqual(composerProps({}), []);
});

test('Codex requires a local conversation in the mounted composer', () => {
  for (const props of [{}, { conversationId: null, hostId: 'local' }, { conversationId: 'one', hostId: 'remote' }]) {
    const tree = inputTree({ triggerButton: {}, ...props });
    assert.equal(shownConversation('codex', tree.document, composerProps), null);
  }
  const tree = inputTree({ triggerButton: {}, conversationId: 'two', hostId: 'local' }, { conversationId: 'one', hostId: 'local' });
  const result = new Function('document', `return ${shownConversationScript('codex')}`)(tree.document);
  assert.deepEqual(result, { agent: 'codex', id: 'two' });
  tree.context.memoizedProps.disabled = true;
  assert.equal(shownConversation('codex', tree.document, composerProps), null);
  tree.context.memoizedProps.disabled = false;
  tree.element.disabled = true;
  assert.equal(shownConversation('codex', tree.document, composerProps), null);
  const claude = inputTree(claudeProps('one'));
  assert.deepEqual(new Function('document', `return ${shownConversationScript('claude')}`)(claude.document), { agent: 'claude', id: 'one' });
});

test('retained hidden webviews and frames outside the viewport are excluded', () => {
  const frame = (src, visible, box = {}) => ({ src, checkVisibility: () => visible,
    getBoundingClientRect: () => ({ width: 400, height: 500, left: 20, top: 20, right: 420, bottom: 520, ...box }) });
  const document = { querySelectorAll: () => [frame('shown', true), frame('hidden', false),
    frame('empty', true, { width: 0 }), frame('offscreen', true, { left: 1200 })] };
  assert.deepEqual(new Function('document', 'innerWidth', 'innerHeight', `return ${VISIBLE_CHAT_FRAMES_SCRIPT}`)(document, 1000, 800), ['shown']);
});

function watcher(t, read) {
  const tracker = new ConversationStore();
  for (const id of ['claude-one', 'claude-two']) {
    tracker.handle('tab', { hook_event_name: 'Stop', session_id: id });
    tracker.markUnread(id);
  }
  tracker.handleCodex('tab', { threadId: 'one', state: 'done', conversation: true }, 'process');
  tracker.markUnread('codex:tab:one');
  const state = { tab: 'tab', focused: true, changed: 0, timers: [], shown: [{ agent: 'claude', id: 'claude-one' }] };
  const watch = new SeenConversations({ activeTab: () => state.tab, focused: () => state.focused,
    hasUnread: (tab) => tracker.hasUnread(tab), conversations: (tab) => tracker.conversations(tab),
    read: read || (async () => state.shown), markSeen: (tab, id) => tracker.markSeen(tab, id), changed: () => state.changed++,
    setTimer: (callback, delay) => { const timer = { callback, delay }; state.timers.push(timer); return timer; },
    clearTimer: (timer) => { state.timers = state.timers.filter((value) => value !== timer); },
  });
  const tick = async () => { const timer = state.timers.shift(); assert.ok(timer); await timer.callback(); };
  return { watch, state, tracker, tick };
}

test('polling clears only the conversation shown and follows agent/history switches until all are seen', async (t) => {
  const { watch, state, tracker, tick } = watcher(t);
  watch.refresh();
  await tick();
  assert.deepEqual(tracker.conversations('tab').filter((c) => c.unread).map((c) => c.id), ['claude-two', 'codex:tab:one']);
  assert.equal(state.timers[0].delay, 1500);
  state.shown = [{ agent: 'codex', id: 'one' }];
  await tick();
  assert.equal(tracker.conversations('tab').find((c) => c.id === 'claude-two').unread, true);
  state.shown = [{ agent: 'claude', id: 'claude-two' }];
  await tick();
  assert.equal(tracker.hasUnread('tab'), false);
  assert.equal(state.changed, 3);
  assert.equal(state.timers.length, 0);
});

test('failed and unknown reads retry without clearing unread', async (t) => {
  const { watch, state, tracker, tick } = watcher(t, async () => { throw new Error('gone'); });
  watch.refresh();
  await tick();
  assert.equal(tracker.hasUnread('tab'), true);
  assert.equal(state.changed, 0);
  assert.equal(state.timers[0].delay, 1500);
  watch.read = async () => null;
  await tick();
  assert.equal(state.changed, 0);
});

test('focus and tab changes cancel pending reads, even after switching back', async (t) => {
  for (const change of ['tab', 'focus']) {
    let resolve;
    const { watch, state, tracker, tick } = watcher(t, () => new Promise((done) => { resolve = done; }));
    watch.refresh();
    const pending = tick();
    if (change === 'tab') state.tab = 'other';
    else state.focused = false;
    watch.refresh();
    assert.equal(state.timers.length, 0, 'No overlapping read');
    if (change === 'tab') state.tab = 'tab';
    else state.focused = true;
    watch.refresh();
    resolve([{ agent: 'claude', id: 'claude-one' }]);
    await pending;
    assert.equal(tracker.conversations('tab').find((c) => c.id === 'claude-one').unread, true);
    assert.equal(state.changed, 0);
    assert.equal(state.timers[0].delay, 0);
    state.focused = false;
    watch.refresh();
    assert.equal(state.timers.length, 0);
  }
});

test('a result completed during a read invalidates that read', async (t) => {
  let resolve;
  const { watch, tracker, tick } = watcher(t, () => new Promise((done) => { resolve = done; }));
  watch.refresh();
  const pending = tick();
  tracker.markUnread('claude-one');
  watch.refresh();
  resolve([{ agent: 'claude', id: 'claude-one' }]);
  await pending;
  assert.equal(tracker.conversations('tab').find((c) => c.id === 'claude-one').unread, true);
});

test('the conversation in view is kept for the side bar, by its exact ID, while nothing is unread', async (t) => {
  const { watch, state, tracker, tick } = watcher(t);
  for (const id of ['claude-one', 'claude-two', 'codex:tab:one']) tracker.markSeen('tab', id);
  assert.deepEqual(watch.shownIds('tab'), []);
  watch.refresh();
  await tick();
  assert.deepEqual(watch.shownIds('tab'), ['claude-one']);
  assert.deepEqual(watch.shownIds('other'), []);
  assert.equal(state.changed, 1);
  // Nothing unread and nothing loading: no more reads until something happens.
  assert.equal(state.timers.length, 0);
  // The same conversation again changes nothing.
  watch.refresh();
  await tick();
  assert.equal(state.changed, 1);
  // A chat that shows a conversation with no row yet marks none.
  state.shown = [{ agent: 'claude', id: 'new' }];
  watch.refresh();
  await tick();
  assert.deepEqual(watch.shownIds('tab'), []);
  tracker.handle('tab', { hook_event_name: 'UserPromptSubmit', session_id: 'new' });
  assert.deepEqual(watch.shownIds('tab'), ['new']);
});

test('input in the tab in front reads after a moment; input in another tab does not', async (t) => {
  const { watch, state, tracker } = watcher(t);
  for (const id of ['claude-one', 'claude-two', 'codex:tab:one']) tracker.markSeen('tab', id);
  watch.soon('other');
  assert.equal(state.timers.length, 0);
  watch.soon('tab');
  watch.soon('tab');
  assert.deepEqual(state.timers.map((timer) => timer.delay), [300]);
});

test('a chat still loading is read again a few times, and marks nothing meanwhile', async (t) => {
  const { watch, state, tracker, tick } = watcher(t);
  for (const id of ['claude-one', 'claude-two', 'codex:tab:one']) tracker.markSeen('tab', id);
  state.shown = [null];
  watch.refresh();
  for (let read = 0; read < 4; read++) {
    await tick();
    assert.deepEqual(watch.shownIds('tab'), []);
  }
  assert.equal(state.timers.length, 0, 'It gives up after a few reads');
  state.shown = [null];
  watch.refresh();
  await tick();
  state.shown = [{ agent: 'claude', id: 'claude-two' }];
  await tick();
  assert.deepEqual(watch.shownIds('tab'), ['claude-two']);
  assert.equal(state.timers.length, 0, 'Identified: no more reads');
});

test('a failed read, a hidden panel, and another tab in front mark nothing', async (t) => {
  const { watch, state, tick } = watcher(t);
  watch.refresh();
  await tick();
  assert.deepEqual(watch.shownIds('tab'), ['claude-one']);
  watch.read = async () => { throw new Error('gone'); };
  watch.refresh();
  await tick();
  assert.deepEqual(watch.shownIds('tab'), []);
  watch.read = async () => state.shown;
  watch.refresh();
  await tick();
  assert.deepEqual(watch.shownIds('tab'), ['claude-one']);
  state.shown = [];
  watch.refresh();
  await tick();
  assert.deepEqual(watch.shownIds('tab'), []);
  state.shown = [{ agent: 'claude', id: 'claude-one' }];
  watch.refresh();
  await tick();
  const changed = state.changed;
  state.tab = 'other';
  watch.refresh();
  assert.deepEqual(watch.shownIds('tab'), []);
  assert.equal(state.changed, changed + 1);
});

// A Codex composer whose tree also mounts the subagents panel beside it.
function panelTree(requestedConversationId, { visible = true, parent = 'parent' } = {}) {
  const composer = { checkVisibility: () => true };
  const panelNode = { checkVisibility: () => visible };
  const rootState = {};
  const root = { stateNode: rootState };
  const thread = { memoizedProps: { triggerButton: {}, conversationId: parent, hostId: 'local' }, return: root };
  const leaf = { stateNode: composer, return: thread };
  const panel = { memoizedProps: { hostId: 'local', parentConversationId: parent, requestedConversationId }, return: root };
  const panelHost = { stateNode: panelNode, return: panel };
  root.child = thread; thread.child = leaf; thread.sibling = panel; panel.child = panelHost;
  rootState.current = root;
  composer.__reactFiber$fixture = leaf;
  return { querySelectorAll: () => [composer] };
}

test('a subagent open in the Codex subagents panel is the conversation shown, not its parent', () => {
  for (const script of [false, true]) {
    const read = (document) => (script
      ? new Function('document', `return ${shownConversationScript('codex')}`)(document)
      : shownConversation('codex', document, composerProps, reactMountedProps));
    assert.deepEqual(read(panelTree('child')), { agent: 'codex', id: 'child' });
    assert.deepEqual(read(panelTree(null)), { agent: 'codex', id: 'parent' });
    assert.deepEqual(read(panelTree('child', { visible: false })), { agent: 'codex', id: 'parent' });
  }
  // A subagent row click is confirmed by the same panel.
  assert.equal(visibleCodexThread(panelTree('child'), composerProps, reactMountedProps), 'child');
  assert.equal(visibleCodexThread(panelTree(null), composerProps, reactMountedProps), 'parent');
});
