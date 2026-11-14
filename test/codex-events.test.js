const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexObserver, runtimeState } = require('../src/codex/codex-events');
const { ConversationStore } = require('../src/conversations/conversation-store');
const { HookServer } = require('../src/conversations/hooks');
const { sessionRisks } = require('../src/conversations/session-risks');

function setup() {
  const tracker = new ConversationStore();
  const events = [];
  const observer = new CodexObserver((event) => { events.push(event); tracker.handleCodex('tab', event, 'wsl:ubuntu:100'); });
  const send = (method, params = {}, id) => observer.server({ method, params: { threadId: 'thread', ...params }, ...(id === undefined ? {} : { id }) });
  const state = () => tracker.conversations('tab').find((c) => c.threadId === 'thread')?.state;
  return { tracker, observer, events, send, state };
}

test('Codex turns share badges, counters, unread results and archiving with Claude', (t) => {
  const { tracker, send, state } = setup(t);
  send('thread/started', { thread: { id: 'thread', cwd: '/repo', status: { type: 'idle' } } });
  assert.equal(tracker.conversations('tab').length, 0);
  send('turn/started', { turn: { id: 'turn1' } });
  send('item/started', { turnId: 'turn1', item: { type: 'userMessage', content: [{ type: 'text', text: 'Fix the bug' }] } });
  assert.equal(state(), 'working');
  assert.equal(tracker.inState('working', ['tab']).length, 1);
  assert.equal(tracker.tabState('tab'), 'working');
  send('thread/name/updated', { threadName: 'Bug fix' });
  const conversation = tracker.conversations('tab')[0];
  assert.equal(conversation.agent, 'codex');
  assert.equal(conversation.title, 'Bug fix');
  assert.equal(conversation.prompt, 'Fix the bug');
  assert.equal(conversation.cwd, '/repo');
  send('turn/completed', { turn: { id: 'turn1', status: 'completed' } });
  send('thread/status/changed', { status: { type: 'idle' } });
  assert.equal(state(), 'done');
  tracker.markUnread(conversation.id);
  assert.equal(tracker.hasUnread('tab'), true);
  assert.equal(tracker.markSeen('tab', conversation.id), true);
  assert.equal(tracker.archive('tab', conversation.id), true);
  assert.equal(tracker.conversations('tab').length, 0);
  send('turn/started', { turn: { id: 'turn2' } });
  assert.equal(state(), 'working');
});

test('Codex waits for every concurrent approval, permission request and user question', (t) => {
  const { tracker, send, state } = setup(t);
  send('turn/started', { turn: { id: 'turn' } });
  const methods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'];
  methods.forEach((method, id) => send(method, { turnId: 'turn', itemId: `item${id}` }, id));
  assert.equal(state(), 'waiting');
  assert.equal(tracker.inState('waiting', ['tab']).length, 1);
  send('item/started', { turnId: 'turn', item: { type: 'agentMessage' } });
  send('thread/status/changed', { status: { type: 'active', activeFlags: [] } });
  assert.equal(state(), 'waiting');
  for (let requestId = 0; requestId < methods.length - 1; requestId++) {
    send('serverRequest/resolved', { requestId });
    assert.equal(state(), 'waiting');
  }
  send('serverRequest/resolved', { requestId: methods.length - 1 });
  assert.equal(state(), 'working');
});

test('Codex interruption clears waiting and ignores old completions and approvals', (t) => {
  const { send, state } = setup(t);
  send('turn/started', { turn: { id: 'old' } });
  send('item/commandExecution/requestApproval', { turnId: 'old', itemId: 'tool' }, 'request');
  send('turn/completed', { turn: { id: 'old', status: 'interrupted' } });
  send('serverRequest/resolved', { requestId: 'request' });
  assert.equal(state(), 'idle');
  send('turn/started', { turn: { id: 'new' } });
  send('item/commandExecution/requestApproval', { turnId: 'old', itemId: 'tool' }, 'request2');
  send('turn/completed', { turn: { id: 'old', status: 'completed' } });
  assert.equal(state(), 'working');
});

test('Codex tool failures and retryable errors do not finish a turn, but turn failures do', (t) => {
  const { send, state } = setup(t);
  send('turn/started', { turn: { id: 'turn' } });
  send('error', { willRetry: true });
  send('item/completed', { item: { id: 'cmd', type: 'commandExecution', status: 'failed' } });
  assert.equal(state(), 'working');
  send('error', { willRetry: false });
  assert.equal(state(), 'error');
  send('turn/completed', { turn: { id: 'turn', status: 'failed' } });
  send('thread/status/changed', { status: { type: 'idle' } });
  assert.equal(state(), 'error');
});

test('Codex runtime status detects approval and input waits when no request is observed', (t) => {
  const { send, state } = setup(t);
  for (const flag of ['waitingOnApproval', 'waitingOnUserInput']) {
    send('thread/status/changed', { status: { type: 'active', activeFlags: [flag] } });
    assert.equal(state(), 'waiting');
    send('item/completed', { item: { type: 'agentMessage', id: 'message' } });
    assert.equal(state(), 'waiting');
  }
  send('thread/status/changed', { status: { type: 'active', activeFlags: [] } });
  assert.equal(state(), 'working');
});

test('An unknown runtime status from a newer extension counts as working, not idle', (t) => {
  assert.equal(runtimeState({ type: 'idle' }), 'idle');
  assert.equal(runtimeState({ type: 'notLoaded' }), 'idle');
  assert.equal(runtimeState(undefined), 'idle');
  assert.equal(runtimeState({ type: 'paused' }), 'working');
  const { send, state } = setup(t);
  send('turn/started', { turn: { id: 'turn1' } });
  send('thread/status/changed', { status: { type: 'paused' } });
  assert.equal(state(), 'working');
});

test('The proxy reports in once the app-server answers the extension\'s initialize', () => {
  const events = [];
  const observer = new CodexObserver((event) => events.push(event));
  observer.server({ id: 1, result: {} });
  observer.client({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_vscode' } } });
  observer.server({ id: 1, error: { message: 'Not ready' } });
  assert.deepEqual(events, []);
  observer.client({ id: 2, method: 'initialize', params: {} });
  observer.server({ id: 2, result: { userAgent: 'codex' } });
  observer.client({ id: 3, method: 'initialize', params: {} });
  observer.server({ id: 3, result: {} });
  assert.deepEqual(events, [{ type: 'codex-observer' }]);
});

test('Codex resume makes an idle row without loading listed history or auth responses', (t) => {
  const { tracker, observer, state } = setup(t);
  observer.client({ id: 1, method: 'thread/list' });
  observer.server({ id: 1, result: { data: [{ id: 'history' }] } });
  observer.client({ id: 2, method: 'account/read' });
  observer.server({ id: 2, result: { account: { token: 'private' } } });
  assert.equal(tracker.sessions.size, 0);
  observer.client({ id: 'resume', method: 'thread/resume' });
  observer.server({ id: 'resume', result: { thread: { id: 'thread', name: 'Resumed', status: { type: 'idle' } } } });
  assert.equal(state(), 'idle');
  assert.equal(tracker.conversations('tab')[0].title, 'Resumed');
});

test('One Codex app-server holds multiple conversations and process exit releases all of them', (t) => {
  const { tracker, send } = setup(t);
  send('turn/started', { turn: { id: 't1' } });
  send('turn/started', { threadId: 'other', turn: { id: 't2' } });
  assert.equal(tracker.conversations('tab').length, 2);
  tracker.handle('tab', { session_id: 'thread', hook_event_name: 'UserPromptSubmit' }, 'wsl:ubuntu:101');
  tracker.handleCodex('anotherTab', { threadId: 'thread', state: 'waiting', conversation: true }, 'wsl:ubuntu:102');
  assert.equal(tracker.conversations('tab').length, 3);
  tracker.endProc('wsl:ubuntu:100');
  assert.deepEqual(tracker.conversations('tab').map((c) => c.agent || 'claude'), ['codex', 'codex', 'claude']);
  assert.ok(tracker.conversations('tab').filter((c) => c.agent === 'codex').every((c) => c.state === 'idle'));
  assert.equal(tracker.conversations('anotherTab').length, 1);
  tracker.clearTab('anotherTab');
  assert.equal(tracker.codexProcs.size, 0);
});

test('bidirectional request IDs can overlap and a late resume snapshot cannot clear waiting', (t) => {
  const { observer, send, state } = setup(t);
  observer.client({ id: 0, method: 'thread/resume' });
  send('turn/started', { turn: { id: 'turn' } });
  send('item/commandExecution/requestApproval', { turnId: 'turn', itemId: 'cmd' }, 0);
  assert.equal(state(), 'waiting');
  observer.server({ id: 0, result: { thread: { id: 'thread', status: { type: 'idle' } } } });
  assert.equal(state(), 'waiting');
  send('serverRequest/resolved', { requestId: 0 });
  assert.equal(state(), 'working');
});

test('Closing a Codex thread releases one holder, and subagent threads have no rows', (t) => {
  const { tracker, send } = setup(t);
  send('turn/started', { turn: { id: 'turn' } });
  tracker.handleCodex('tab', { threadId: 'thread', state: 'working', conversation: true }, 'wsl:ubuntu:200');
  send('thread/closed');
  assert.equal(tracker.conversations('tab').length, 1);
  tracker.endProc('wsl:ubuntu:200');
  assert.equal(tracker.conversations('tab').length, 1);
  assert.equal(tracker.conversations('tab')[0].state, 'idle');
  send('thread/archived');
  assert.equal(tracker.conversations('tab').length, 0);
  send('thread/started', { thread: { id: 'child', source: { subAgent: { threadId: 'parent' } } } });
  send('turn/started', { threadId: 'child', turn: { id: 'childTurn' } });
  assert.equal(tracker.conversations('tab').length, 0);
});

test('delegated thread metadata labels children, persists their parent, and keeps results read', (t) => {
  const { observer, tracker, send } = setup(t);
  for (const source of [{ subAgent: { thread_spawn: { parent_thread_id: 'parent', agent_nickname: 'Locke', agent_role: 'reviewer' } } },
    { subagent: { thread_spawn: { parent_thread_id: 'parent', agent_nickname: 'Locke', agent_role: 'reviewer' } } }]) {
    send('thread/started', { thread: { id: 'child', source, status: { type: 'idle' } } });
    send('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
    const row = tracker.conversations('tab')[0];
    assert.equal(row.subagent, true);
    assert.equal(row.parentThreadId, 'parent');
    assert.equal(row.agentNickname, 'Locke');
    assert.equal(row.agentRole, 'reviewer');
    send('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } });
    tracker.markUnread(row.id);
    assert.equal(tracker.hasUnread('tab'), false);
    assert.equal(tracker.isSubagent(row.id), true);
    observer.load({ id: 'child', parentThreadId: 'parent', status: { type: 'active' } }, true);
    assert.equal(tracker.conversations('tab')[0].agentNickname, 'Locke');
    const saved = tracker.history('tab');
    const restored = new ConversationStore();
    restored.restoreHistory('tab', saved);
    assert.equal(restored.conversations('tab')[0].subagent, true);
    assert.equal(restored.conversations('tab')[0].parentThreadId, 'parent');
    assert.equal(restored.conversations('tab')[0].agentNickname, 'Locke');
  }
});

test('top-level parent metadata identifies a child without a session source', (t) => {
  const { send, tracker } = setup(t);
  send('thread/started', { thread: { id: 'child', parentThreadId: 'parent', agentNickname: 'Ada', agentRole: 'explorer' } });
  send('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  assert.equal(tracker.conversations('tab')[0].agentNickname, 'Ada');
  assert.equal(tracker.conversations('tab')[0].subagent, true);
});

test('guardian subagents remain excluded, including the rollout source spelling', (t) => {
  const { send, tracker } = setup(t);
  for (const key of ['subAgent', 'subagent']) {
    send('thread/started', { thread: { id: key, source: { [key]: { other: 'guardian' } } } });
    send('turn/started', { threadId: key, turn: { id: 'turn' } });
  }
  assert.equal(tracker.conversations('tab').length, 0);
});

function collaboration(send, { id = 'call', method = 'item/completed', tool = 'wait', status = 'completed', targets = ['child'], states = {} } = {}) {
  send(method, { threadId: 'parent', item: { id, type: 'collabAgentToolCall', tool, status,
    senderThreadId: 'parent', receiverThreadIds: targets, agentsStates: states } });
}

test('spawn and wait states recover a missing child completion without exposing child output', (t) => {
  const { send, tracker, events } = setup(t);
  send('turn/started', { threadId: 'parent', turn: { id: 'parent-turn' } });
  collaboration(send, { tool: 'spawnAgent', states: { child: { status: 'running' } } });
  let row = tracker.conversations('tab').find((c) => c.threadId === 'child');
  assert.equal(row.state, 'working');
  assert.equal(row.subagent, true);
  assert.equal(row.parentThreadId, 'parent');
  send('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  collaboration(send, { id: 'wait', method: 'item/started' });
  collaboration(send, { id: 'wait', states: { child: { status: 'completed', message: 'private child output' } } });
  row = tracker.conversations('tab').find((c) => c.threadId === 'child');
  assert.equal(row.state, 'done');
  assert.equal(tracker.hasUnread('tab'), false);
  assert.equal(tracker.conversations('tab').find((c) => c.threadId === 'parent').state, 'working');
  assert.ok(!JSON.stringify(events).includes('private child output'));
});

test('subagent activity in the parent labels a child whose own events carry no source', (t) => {
  const { send, tracker } = setup(t);
  const activity = (kind, agentThreadId = 'child', threadId = 'parent') => send('item/completed', { threadId,
    item: { id: `call-${kind}`, type: 'subAgentActivity', kind, agentThreadId, agentPath: '/root/review_docs' } });
  send('turn/started', { threadId: 'parent', turn: { id: 'parent-turn' } });
  send('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  const row = () => tracker.conversations('tab').find((c) => c.threadId === 'child');
  assert.equal(row().subagent, undefined);
  activity('started');
  assert.equal(row().subagent, true);
  assert.equal(row().parentThreadId, 'parent');
  assert.equal(row().agentPath, '/root/review_docs');
  assert.equal(row().state, 'working');
  // A child messaging its parent must not make the parent a subagent of its own child.
  activity('interacted', 'parent', 'child');
  assert.equal(tracker.conversations('tab').find((c) => c.threadId === 'parent').subagent, undefined);
  activity('started', 'unseen');
  assert.equal(tracker.conversations('tab').find((c) => c.threadId === 'unseen').state, 'working');
});

test('a completed collaboration tool does not finish running, waiting or unknown targets', (t) => {
  const { send, tracker } = setup(t);
  send('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  send('item/tool/requestUserInput', { threadId: 'child', turnId: 'child-turn' }, 'approval');
  collaboration(send, { states: { child: { status: 'running' } } });
  assert.equal(tracker.conversations('tab').find((c) => c.threadId === 'child').state, 'waiting');
  collaboration(send, { tool: 'spawnAgent', targets: ['other'], states: { other: { status: 'future-status' } } });
  assert.equal(tracker.conversations('tab').find((c) => c.threadId === 'other').state, 'working');
  collaboration(send, { id: 'empty', targets: ['not-spawned'], states: {} });
  assert.ok(!tracker.conversations('tab').some((c) => c.threadId === 'not-spawned'));
});

test('older collaboration completions cannot finish a newer child turn', (t) => {
  const { send, tracker } = setup(t);
  send('turn/started', { threadId: 'child', turn: { id: 'old' } });
  collaboration(send, { method: 'item/started' });
  send('turn/started', { threadId: 'child', turn: { id: 'new' } });
  collaboration(send, { states: { child: { status: 'completed' } } });
  assert.equal(tracker.conversations('tab').find((c) => c.threadId === 'child').state, 'working');
});

test('a completed parent does not hide a child that is still working', (t) => {
  const { send, tracker } = setup(t);
  send('turn/started', { threadId: 'parent', turn: { id: 'parent-turn' } });
  collaboration(send, { tool: 'spawnAgent', states: { child: { status: 'running' } } });
  send('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
  send('turn/completed', { threadId: 'parent', turn: { id: 'parent-turn', status: 'completed' } });
  assert.equal(tracker.tabState('tab'), 'working');
  assert.equal(tracker.inState('working', ['tab']).length, 1);
  send('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } });
  assert.equal(tracker.inState('working', ['tab']).length, 0);
});

test('messages to a parent do not reclassify the parent as a child', (t) => {
  const { send, tracker } = setup(t);
  send('turn/started', { threadId: 'root', turn: { id: 'root-turn' } });
  collaboration(send, { tool: 'sendMessage', targets: ['root'], states: { root: { status: 'running' } } });
  assert.equal(tracker.conversations('tab').find((c) => c.threadId === 'root').subagent, undefined);
});

test('late active statuses cannot revive a completed turn and the next turn still starts', (t) => {
  const { send, state } = setup(t);
  send('turn/started', { turn: { id: 'old' } });
  send('turn/completed', { turn: { id: 'old', status: 'completed' } });
  for (const activeFlags of [[], ['waitingOnApproval']]) {
    send('thread/status/changed', { status: { type: 'active', activeFlags } });
    assert.equal(state(), 'done');
  }
  send('turn/started', { turn: { id: 'new' } });
  assert.equal(state(), 'working');
});

test('stop risks include every provider even when an error wins the tab badge', () => {
  assert.deepEqual(sessionRisks([
    { agent: 'codex', state: 'error' }, { agent: 'codex', state: 'working' },
    { agent: 'codex', state: 'working' }, { agent: 'claude', state: 'waiting' },
  ]), [
    'Codex is working. The turn in progress will be interrupted.',
    'Claude is waiting for approval. The turn in progress will be interrupted.',
  ]);
});

test('Codex events use the authenticated endpoint, including the WSL receive path', async (t) => {
  const server = new HookServer();
  await server.listen();
  t.after(() => server.close());
  const events = [];
  server.on('codex', (...args) => events.push(args));
  const event = { threadId: 'thread', state: 'waiting', conversation: true };
  const post = (token) => fetch(new URL('/codex', server.url), {
    method: 'POST', headers: { 'X-Wrapper-Token': token, 'X-Wrapper-Tab': 'tab', 'X-Wrapper-Proc': '123' }, body: JSON.stringify(event),
  });
  assert.equal((await post('wrong')).status, 404);
  assert.equal((await post(server.token)).status, 200);
  server.receive('codex', 'wsl-tab', 'wsl:ubuntu:1', JSON.stringify(event));
  server.receive('codex', 'tab', null, JSON.stringify({ state: 'working' }));
  assert.deepEqual(events, [['tab', event, '123'], ['wsl-tab', event, 'wsl:ubuntu:1']]);
  const observed = [];
  server.on('codex-observer', (...args) => observed.push(args));
  server.receive('codex', 'tab', null, JSON.stringify({ type: 'codex-observer' }));
  server.receive('codex', 'tab', '123', JSON.stringify({ type: 'codex-observer' }));
  assert.deepEqual(observed, [['tab', '123']]);
  assert.equal(events.length, 2);
});

test('Resume and fork metadata use the last user prompt and remember the last turn', (t) => {
  const { observer, tracker } = setup(t);
  for (const [index, method] of ['thread/resume', 'thread/fork'].entries()) {
    observer.client({ id: index, method });
    observer.server({ id: index, result: { thread: { id: `history-${index}`, name: 'Saved title',
      cwd: '/repo/worktree', preview: 'First prompt', status: { type: 'idle' }, turns: [
        { id: 'older', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'First prompt' }] }] },
        { id: 'latest', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Last prompt' }] }] },
      ] } } });
  }
  assert.deepEqual(tracker.conversations('tab').map((c) => [c.threadId, c.turnId, c.title, c.prompt, c.cwd]), [
    ['history-0', 'latest', 'Saved title', 'Last prompt', '/repo/worktree'],
    ['history-1', 'latest', 'Saved title', 'Last prompt', '/repo/worktree'],
  ]);
});

test('An old resume snapshot cannot replace the live prompt or turn', (t) => {
  const { observer, tracker, send } = setup(t);
  send('turn/started', { turn: { id: 'live' } });
  send('item/started', { item: { type: 'userMessage', content: [{ type: 'text', text: 'Live prompt' }] } });
  observer.client({ id: 3, method: 'thread/resume' });
  observer.server({ id: 3, result: { thread: { id: 'thread', preview: 'Old preview',
    turns: [{ id: 'old', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Old prompt' }] }] }] } } });
  assert.equal(tracker.conversations('tab')[0].turnId, 'live');
  assert.equal(tracker.conversations('tab')[0].prompt, 'Live prompt');
  send('turn/completed', { turn: { id: 'live', status: 'completed' } });
  observer.client({ id: 4, method: 'thread/resume' });
  observer.server({ id: 4, result: { thread: { id: 'thread', preview: 'Old preview',
    turns: [{ id: 'old', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Old prompt' }] }] }] } } });
  assert.equal(tracker.conversations('tab')[0].turnId, 'live');
  assert.equal(tracker.conversations('tab')[0].prompt, 'Live prompt');
});

test('Codex navigation metadata survives JSON persistence without reviving busy state', (t) => {
  const { tracker, send } = setup(t);
  send('turn/started', { turn: { id: 'turn-1' } });
  send('thread/name/updated', { threadName: 'Saved conversation' });
  send('item/started', { item: { type: 'userMessage', content: [{ type: 'text', text: 'Latest task' }], cwd: '/repo' } });
  tracker.markUnread(tracker.conversations('tab')[0].id);
  tracker.handleCodex('tab', { threadId: 'hidden', state: 'idle', conversation: true, prompt: 'Hidden task' }, 'wsl:ubuntu:100');
  tracker.archive('tab', 'codex:tab:hidden');
  tracker.handle('tab', { session_id: 'claude', hook_event_name: 'UserPromptSubmit' }, 'wsl:ubuntu:200');
  const saved = JSON.parse(JSON.stringify(tracker.history('tab')));
  assert.deepEqual(saved.map((item) => item.agent), ['codex', 'codex', 'claude']);
  assert.ok(!JSON.stringify(saved).includes('procs'));
  assert.ok(!JSON.stringify(saved).includes('unread'));
  const restored = new ConversationStore();
  restored.restoreHistory('tab', saved);
  const [row, claude] = restored.conversations('tab');
  assert.deepEqual([claude.id, claude.state, claude.agent], ['claude', 'idle', undefined]);
  assert.equal(row.id, 'codex:tab:thread');
  assert.equal(row.title, 'Saved conversation');
  assert.equal(row.prompt, 'Latest task');
  assert.equal(row.cwd, '/repo');
  assert.equal(row.turnId, 'turn-1');
  assert.equal(row.state, 'idle');
  assert.equal(row.unread, false);
  assert.equal(restored.tabState('tab'), 'idle');
  assert.equal(restored.codexProcs.size, 0);
  restored.handleCodex('tab', { threadId: 'thread', state: 'working', conversation: true }, 'wsl:ubuntu:300');
  assert.equal(restored.conversations('tab').length, 2);
  assert.equal(restored.conversations('tab')[0].state, 'working');
  restored.handleCodex('tab', { threadId: 'hidden', state: 'working', conversation: true }, 'wsl:ubuntu:300');
  assert.equal(restored.conversations('tab').length, 3);
});

test('History restoration ignores malformed records and cannot overwrite live sessions', (t) => {
  const { tracker, send } = setup(t);
  send('turn/started', { turn: { id: 'live' } });
  tracker.restoreHistory('tab', null);
  tracker.restoreHistory('tab', [null, {}, { agent: 'claude', threadId: 'other' },
    { agent: 'codex', threadId: '../bad' }, { agent: 'codex', threadId: 12 },
    { agent: 'codex', threadId: 'thread', state: 'idle', title: 'Stale' },
    { agent: 'codex', threadId: 'valid', title: {}, prompt: [], cwd: 1, procs: ['999'] },
    { agent: 'codex', threadId: 'valid', title: 'Duplicate' }]);
  const rows = tracker.conversations('tab');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, 'working');
  assert.equal(rows[0].title, null);
  assert.equal(rows[1].title, null);
  assert.equal(rows[1].prompt, null);
  assert.equal(rows[1].cwd, null);
  assert.equal(tracker.sessions.get(rows[1].id).procs.size, 0);
});

test('Suspension keeps the Codex and Claude rows idle, but closing the tab removes them', (t) => {
  const { tracker, send } = setup(t);
  send('turn/started', { turn: { id: 'turn' } });
  tracker.handle('tab', { session_id: 'claude', hook_event_name: 'UserPromptSubmit' }, 'wsl:ubuntu:200');
  tracker.handle('tab', { session_id: 'blank', hook_event_name: 'SessionStart', source: 'startup' }, 'wsl:ubuntu:201');
  tracker.clearTab('tab', { keepRows: true });
  assert.deepEqual(tracker.conversations('tab').map((c) => [c.id, c.state]), [['codex:tab:thread', 'idle'], ['claude', 'idle']]);
  assert.equal(tracker.sessions.has('blank'), false);
  assert.equal(tracker.codexProcs.size, 0);
  assert.equal(tracker.procs.size, 0);
  tracker.clearTab('tab');
  assert.deepEqual(tracker.history('tab'), []);
});

test('Codex archive/delete discard saved rows held by every process', (t) => {
  const { tracker, send } = setup(t);
  for (const reason of ['archived', 'deleted']) {
    send('thread/started', { thread: { id: 'thread' } });
    send('turn/started', { turn: { id: 'turn' } });
    tracker.handleCodex('tab', { threadId: 'thread', state: 'working', conversation: true }, 'wsl:ubuntu:200');
    send(`thread/${reason}`);
    assert.deepEqual(tracker.history('tab'), []);
    assert.equal(tracker.codexProcs.size, 0);
  }
});

test('A failed thread resume reports restoration failure without changing state or leaking errors', (t) => {
  const { observer, tracker, send, events } = setup(t);
  const failed = [];
  tracker.on('restore-failed', (...args) => failed.push(args));
  send('turn/started', { turn: { id: 'turn' } });
  observer.client({ id: 15, method: 'thread/resume', params: { threadId: 'thread' } });
  observer.server({ id: 15, error: { code: -1, message: 'Private error details' } });
  assert.deepEqual(failed, [['tab', 'codex:tab:thread']]);
  assert.deepEqual(events.at(-1), { threadId: 'thread', restoreFailed: true });
  assert.equal(tracker.conversations('tab')[0].state, 'working');
});

test('Archive and delete ignore late item events until the thread is explicitly loaded again', (t) => {
  const { observer, send, tracker } = setup(t);
  send('turn/started', { turn: { id: 'turn' } });
  send('thread/deleted');
  send('item/completed', { item: { type: 'userMessage', content: [{ type: 'text', text: 'Late' }] } });
  assert.deepEqual(tracker.history('tab'), []);
  observer.client({ id: 20, method: 'thread/resume' });
  observer.server({ id: 20, result: { thread: { id: 'thread', preview: 'Restored' } } });
  assert.equal(tracker.conversations('tab').length, 1);
});

test('Temporary Codex threads are shown live but never persisted as restorable history', (t) => {
  const { tracker, send } = setup(t);
  send('thread/started', { thread: { id: 'thread', ephemeral: true } });
  send('turn/started', { turn: { id: 'temporary' } });
  assert.equal(tracker.conversations('tab')[0].ephemeral, true);
  assert.deepEqual(tracker.history('tab'), []);
  tracker.endProc('wsl:ubuntu:100');
  assert.deepEqual(tracker.conversations('tab'), []);
});

for (const threadSource of ['thread_title', 'thread_description']) {
  for (const method of ['thread/start', 'thread/fork']) {
    for (const responseFirst of [true, false]) {
      test(`${threadSource} via ${method} stays hidden with response ${responseFirst ? 'before' : 'after'} notifications`, (t) => {
        const { tracker, observer, send, events } = setup(t);
        const states = [];
        tracker.on('state', (...args) => states.push(args));
        observer.client({ id: 1, method, params: { threadId: 'parent', ephemeral: true, threadSource } });
        const response = { id: 1, result: { thread: { id: 'thread', status: { type: 'idle' } } } };
        if (responseFirst) observer.server(response);
        // The server may omit the request's threadSource and ephemeral fields.
        send('thread/started', { thread: { id: 'thread' } });
        send('turn/started', { turn: { id: 'generation' } });
        send('item/started', { item: { type: 'userMessage', content: [
          { type: 'text', text: 'You are a helpful assistant. Generate a short title for a task.' },
        ] } });
        send('thread/status/changed', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
        send('item/commandExecution/requestApproval', { itemId: 'tool' }, 1);
        send('serverRequest/resolved', { requestId: 1 });
        send('thread/name/updated', { threadName: 'Internal metadata' });
        send('turn/completed', { turn: { id: 'generation', status: 'completed' } });
        // Assert before the response too: removing an already published row is too late.
        assert.deepEqual(events, []);
        if (!responseFirst) observer.server(response);
        send('thread/closed');
        send('thread/started', { thread: { id: 'thread', preview: 'Late snapshot' } });
        observer.client({ id: 2, method: 'thread/resume', params: { threadId: 'thread' } });
        observer.server({ id: 2, result: { thread: { id: 'thread', preview: 'Late resume' } } });
        send('item/completed', { item: { type: 'userMessage', content: [{ type: 'text', text: 'Late' }] } });
        send('error', { willRetry: false });
        assert.deepEqual(events, []);
        assert.deepEqual(states, []); // No notification or unread-result trigger reaches the app.
        assert.equal(tracker.sessions.size, 0);
        assert.equal(tracker.codexProcs.size, 0);
        assert.deepEqual(tracker.conversations('tab'), []);
        assert.deepEqual(tracker.history('tab'), []);
        assert.deepEqual(tracker.inState('working', ['tab']), []);
        assert.deepEqual(tracker.inState('waiting', ['tab']), []);
        assert.equal(tracker.tabState('tab'), null);
        assert.equal(tracker.hasUnread('tab'), false);
        assert.deepEqual(sessionRisks(tracker.conversations('tab')), []);
      });
    }
  }
}

test('Thread snapshots identify internal metadata and keep subagents excluded after late loads', (t) => {
  const { observer, send, events } = setup(t);
  for (const metadata of [{ threadSource: 'thread_title' }, { threadSource: 'thread_description' },
    { source: 'subAgent' }, { source: { subAgent: { threadId: 'parent' } } }]) {
    const threadId = `hidden-${events.length}-${JSON.stringify(metadata)}`;
    send('thread/started', { thread: { id: threadId, ...metadata, preview: 'Internal', status: { type: 'active' } } });
    send('turn/started', { threadId, turn: { id: 'turn' } });
    send('thread/closed', { threadId });
    observer.client({ id: 1, method: 'thread/fork' });
    observer.server({ id: 1, result: { thread: { id: threadId, preview: 'Snapshot without source' } } });
  }
  assert.deepEqual(events, []);
});

test('A fork for metadata generation does not hide its active parent or another new conversation', (t) => {
  const { observer, tracker, send } = setup(t);
  send('turn/started', { threadId: 'parent', turn: { id: 'parentTurn' } });
  observer.client({ id: 'metadata', method: 'thread/fork', params: { threadId: 'parent', threadSource: 'thread_description', ephemeral: true } });
  observer.client({ id: 'user', method: 'thread/start', params: { threadSource: 'vscode' } });
  send('thread/started', { thread: { id: 'user' } });
  send('turn/started', { threadId: 'user', turn: { id: 'userTurn' } });
  send('item/started', { threadId: 'user', item: { type: 'userMessage', content: [{ type: 'text', text: 'User task' }] } });
  send('thread/name/updated', { threadId: 'parent', threadName: 'Parent task' });
  assert.equal(tracker.conversations('tab')[0].title, 'Parent task');
  observer.server({ id: 'user', result: { thread: { id: 'user', status: { type: 'idle' } } } });
  assert.deepEqual(tracker.conversations('tab').map((c) => [c.threadId, c.state]), [['parent', 'working'], ['user', 'working']]);
  assert.equal(tracker.conversations('tab')[1].prompt, 'User task');
  observer.server({ id: 'metadata', result: { thread: { id: 'internal' } } });
  send('turn/started', { threadId: 'internal', turn: { id: 'metadataTurn' } });
  assert.equal(tracker.inState('working', ['tab']).length, 2);
});

test('Failed creation releases unrelated deferred events without losing state transitions', (t) => {
  const { observer, send, events, state } = setup(t);
  observer.client({ id: 1, method: 'thread/start', params: { threadSource: 'thread_title' } });
  send('turn/started', { turn: { id: 'turn' } });
  send('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.deepEqual(events, []);
  observer.server({ id: 1, error: { code: -1 } });
  assert.deepEqual(events.map((e) => e.state), ['working', 'done']);
  assert.equal(state(), 'done');
});

test('A fork response cannot replace deferred live navigation metadata or revive a closed thread', (t) => {
  const { observer, send, tracker } = setup(t);
  observer.client({ id: 1, method: 'thread/fork', params: { threadId: 'parent' } });
  send('thread/started', { thread: { id: 'thread' } });
  send('turn/started', { turn: { id: 'live' } });
  send('item/started', { item: { type: 'userMessage', content: [{ type: 'text', text: 'Live task' }] } });
  observer.server({ id: 1, result: { thread: { id: 'thread', status: { type: 'idle' }, turns: [
    { id: 'old', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Old task' }] }] },
  ] } } });
  const [row] = tracker.conversations('tab');
  assert.equal(row.turnId, 'live');
  assert.equal(row.prompt, 'Live task');
  assert.equal(row.state, 'working');
  observer.client({ id: 2, method: 'thread/start', params: { ephemeral: true } });
  send('turn/started', { threadId: 'temporary', turn: { id: 'temporaryTurn' } });
  send('thread/closed', { threadId: 'temporary' });
  observer.server({ id: 2, result: { thread: { id: 'temporary', preview: 'Old temporary task' } } });
  assert.deepEqual(tracker.conversations('tab').map((c) => c.threadId), ['thread']);
});

test('Temporary user threads inherit request metadata without matching their prompt text', (t) => {
  const { observer, tracker, send } = setup(t);
  observer.client({ id: 1, method: 'thread/start', params: { ephemeral: true, threadSource: 'vscode' } });
  send('thread/started', { thread: { id: 'thread' } });
  send('turn/started', { turn: { id: 'turn' } });
  send('item/started', { item: { type: 'userMessage', content: [
    { type: 'text', text: 'You are a helpful assistant. Generate a short title for a task.' },
  ] } });
  observer.server({ id: 1, result: { thread: { id: 'thread' } } });
  const [row] = tracker.conversations('tab');
  assert.equal(row.state, 'working');
  assert.equal(row.ephemeral, true);
  assert.match(row.prompt, /^You are a helpful assistant/);
  assert.deepEqual(tracker.history('tab'), []);
  send('thread/closed');
  assert.deepEqual(tracker.conversations('tab'), []);
});

test('Account and quota observation continues while internal conversation events are filtered', (t) => {
  const { observer, send, events, tracker } = setup(t);
  observer.client({ id: 'internal', method: 'thread/start', params: { threadSource: 'thread_title' } });
  send('turn/started', { turn: { id: 'turn' } });
  observer.client({ id: 'account', method: 'account/read' });
  observer.client({ id: 'quota', method: 'account/rateLimits/read' });
  observer.server({ id: 'account', result: { account: { type: 'apiKey', token: 'PRIVATE_TOKEN' } } });
  observer.server({ id: 'quota', result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 42 } } } });
  observer.server({ id: 'internal', result: { thread: { id: 'thread' } } });
  observer.server({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 43 } } } });
  assert.deepEqual(events.map((e) => e.type), ['codex-account', 'codex-usage', 'codex-usage']);
  assert.equal(events[0].authMode, 'apikey');
  assert.equal(events[1].buckets[0].primary.usedPercent, 42);
  assert.equal(events[2].buckets[0].primary.usedPercent, 43);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_TOKEN/);
  assert.equal(tracker.sessions.size, 0);
});

test('A resume preview cannot overwrite a last prompt restored from Worktabs history', (t) => {
  const { tracker, observer, send } = setup(t);
  tracker.restoreHistory('tab', [{ agent: 'codex', threadId: 'thread', prompt: 'Saved latest task' }]);
  observer.client({ id: 5, method: 'thread/resume' });
  observer.server({ id: 5, result: { thread: { id: 'thread', preview: 'First prompt', status: { type: 'idle' } } } });
  assert.equal(tracker.conversations('tab')[0].prompt, 'Saved latest task');
  send('item/started', { item: { type: 'userMessage', content: [{ type: 'text', text: 'Next task' }] } });
  assert.equal(tracker.conversations('tab')[0].prompt, 'Next task');
});

test('archiving a Codex conversation takes its subagents with it, even ones left working', () => {
  const tracker = new ConversationStore();
  const codex = (threadId, state, extra = {}) => tracker.handleCodex('tab', { threadId, state, conversation: true, ...extra }, 'proc');
  codex('parent', 'done');
  codex('child', 'working', { subagent: true, parentThreadId: 'parent' });
  codex('grandchild', 'waiting', { subagent: true, parentThreadId: 'child' });
  codex('other', 'working', { subagent: true, parentThreadId: 'elsewhere' });
  tracker.handleCodex('tab2', { threadId: 'child2', state: 'working', conversation: true, subagent: true, parentThreadId: 'parent' }, 'proc2');
  assert.equal(tracker.archive('tab', 'codex:tab:parent'), true);
  assert.deepEqual(tracker.conversations('tab').map((c) => c.threadId), ['other']);
  assert.equal(tracker.tabState('tab'), 'working');
  assert.equal(tracker.conversations('tab2').length, 1);
  // A turn the subagent starts later brings it back.
  codex('child', 'working', { subagent: true, parentThreadId: 'parent' });
  assert.deepEqual(tracker.conversations('tab').map((c) => c.threadId), ['child', 'other']);
});
