const assert = require('node:assert/strict');
const test = require('node:test');
const { createConversationOpening } = require('../src/conversations/conversation-opening');

const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

function setup(overrides = {}) {
  const tabs = new Map([['tab', { id: 'tab', server: 'running' }], ['other', { id: 'other', server: 'running' }]]);
  const runs = new Map([['tab', {}], ['other', {}]]);
  const helpers = new Map([['tab', {}]]);
  const calls = [];
  const seen = [];
  const warnings = [];
  const timers = new Map();
  let selected = 'tab';
  let timerId = 0;
  let service;
  const conversations = [
    { id: 'one', threadId: 'thread-one', agent: 'codex' },
    { id: 'two', threadId: 'thread-two', agent: 'codex' },
    { id: 'temporary', threadId: 'temporary', agent: 'codex', ephemeral: true },
    { id: 'claude', agent: 'claude' },
  ];
  service = createConversationOpening({
    tabs, helpers, sessions: { conversations: () => conversations, markSeen: (...args) => { seen.push(args); return true; } },
    activeId: () => selected, runFor: (id) => runs.get(id),
    activateTab: (id) => {
      if (selected !== id) service.cancelPending(tabs.get(selected));
      selected = id;
    },
    callHelper: async (...args) => { calls.push(['helper', ...args]); return { opened: true }; },
    readTheme: (tab) => calls.push(['theme', tab.id]),
    startFirstConversation: (tab, prompt) => calls.push(['first', tab.id, prompt]),
    showAgentChat: (tab) => calls.push(['chat', tab.id]), read: async () => ['thread-one'],
    focused: () => true, messageBox: async (options) => warnings.push(options),
    pushState: () => calls.push(['push']), refreshSeen: () => calls.push(['seen']),
    schedule: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    cancel: (id) => timers.delete(id), ...overrides,
  });
  return { service, tabs, runs, helpers, calls, seen, warnings, timers, select: (id) => { selected = id; } };
}

test('only the latest startup click is dispatched when the running helper registers', async () => {
  const read = [];
  const { service, helpers, tabs, calls, timers, seen } = setup({ read: async (_tab, threadId) => { read.push(threadId); return ['thread-two']; } });
  helpers.clear();
  await service.revealSession('tab', 'one');
  const old = [...timers.values()][0];
  await service.revealSession('tab', 'two');
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, 30000);
  old.fn();
  assert.equal(tabs.get('tab').pendingReveal, 'two');
  service.helperRegistered('tab', { port: 1 });
  await turn();
  assert.equal(timers.size, 0);
  assert.deepEqual(calls.filter(([kind]) => kind === 'helper').map((entry) => entry[3].sessionId), ['thread-two']);
  assert.deepEqual(read, ['thread-two'], 'the chat waits in its page for the thread asked for');
  assert.deepEqual(seen, [['tab', 'two']]);
});

test('a subagent row still opens its own thread rather than the parent', async () => {
  const child = { id: 'child', threadId: 'child-thread', agent: 'codex', subagent: true, parentThreadId: 'parent' };
  const seen = [];
  const { service, calls } = setup({ sessions: { conversations: () => [child], markSeen: (...args) => seen.push(args) },
    read: async () => ['child-thread'] });
  await service.revealSession('tab', child.id);
  assert.equal(calls.find((entry) => entry[0] === 'helper')[3].sessionId, child.threadId);
  assert.deepEqual(seen, [['tab', child.id]]);
});

test('helper timeout warns for its active captured tab and cancellation clears it', async () => {
  const { service, helpers, tabs, timers, warnings } = setup();
  helpers.clear();
  await service.revealSession('tab', 'one');
  [...timers.values()][0].fn();
  assert.equal(warnings.length, 1);
  assert.equal(tabs.get('tab').pendingReveal, null);
  await service.revealSession('tab', 'two');
  const callback = [...timers.values()].at(-1).fn;
  service.cancelPending(tabs.get('tab'));
  callback();
  assert.equal(warnings.length, 1);
  assert.equal(tabs.get('tab').pendingReveal, null);
});

test('tab switching cancels pending startup clicks before helper registration', async () => {
  const { service, helpers, tabs, calls, warnings } = setup();
  helpers.clear();
  await service.revealSession('tab', 'one');
  await service.revealSession('other', 'claude');
  assert.equal(tabs.get('tab').pendingReveal, null);
  service.helperRegistered('tab', {});
  await turn();
  assert.equal(calls.some(([kind]) => kind === 'helper'), false);
  assert.deepEqual(warnings, []);
});

test('later clicks, tab switches, closing, and a replacement server suppress stale reveal results', async (t) => {
  for (const kind of ['click', 'switch', 'close', 'restart']) await t.test(kind, async () => {
    const answer = deferred();
    let count = 0;
    const harness = setup({
      callHelper: async () => ++count === 1 ? answer.promise : { opened: true },
      read: async () => ['thread-two'],
    });
    const { service, tabs, runs, select, seen, warnings } = harness;
    const pending = service.revealSession('tab', 'one');
    if (kind === 'click') await service.revealSession('tab', 'two');
    if (kind === 'switch') select('other');
    if (kind === 'close') { service.cancelPending(tabs.get('tab')); tabs.delete('tab'); runs.delete('tab'); }
    if (kind === 'restart') { service.cancelPending(tabs.get('tab')); runs.set('tab', {}); }
    answer.resolve({ opened: true });
    await pending;
    assert.deepEqual(seen, kind === 'click' ? [['tab', 'two']] : []);
    assert.deepEqual(warnings, []);
  });
});

test('temporary and unavailable Codex threads use recovery without marking them seen', async () => {
  const temporary = setup();
  await temporary.service.revealSession('tab', 'temporary');
  assert.equal(temporary.calls.find(([kind]) => kind === 'helper')[2], '/show-chat');
  assert.match(temporary.warnings[0].detail, /temporary Codex thread/);
  assert.deepEqual(temporary.seen, []);
  const unavailable = setup({ callHelper: async () => ({ opened: false, reason: 'missing-extension' }) });
  await unavailable.service.revealSession('tab', 'one');
  assert.match(unavailable.warnings[0].detail, /not installed in this tab/);
  assert.deepEqual(unavailable.seen, []);
});

test('a new worktree first conversation is dispatched once and ignores premature helper registrations', () => {
  const { service, tabs, calls } = setup();
  const tab = tabs.get('tab');
  tab.newConversation = { prompt: 'Implement this task' };
  tab.server = 'starting';
  service.helperRegistered('tab', {});
  assert.deepEqual(calls, []);
  tab.server = 'running';
  service.helperRegistered('tab', {});
  service.helperRegistered('tab', {});
  assert.deepEqual(calls.filter(([kind]) => kind === 'first'), [['first', 'tab', 'Implement this task']]);
  assert.equal(tab.newConversation, null);
});

test('a resume failure warns only for the currently selected revealed thread', async () => {
  const { service, tabs, warnings, select } = setup();
  tabs.get('tab').revealedThread = 'one';
  service.restoreFailed('tab', 'two');
  select('other');
  service.restoreFailed('tab', 'one');
  assert.equal(warnings.length, 0);
  select('tab');
  service.restoreFailed('tab', 'one');
  assert.equal(warnings.length, 1);
  assert.equal(tabs.get('tab').revealedThread, null);
});
