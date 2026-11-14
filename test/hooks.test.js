const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { HookServer, SessionTracker, hookSettings, nextConversation, nextState } = require('../src/conversations/hooks');
const { tempDir } = require('./support');
const { ConversationStore } = require('../src/conversations/conversation-store');

function makeTracker() {
  return new ConversationStore();
}

function makeObserved(t) {
  const tracker = new SessionTracker();
  t.after(() => tracker.close());
  return tracker;
}

// A hook input as claude sends it.
const hook = (event, fields = {}) => ({ session_id: 's1', hook_event_name: event, ...fields });

// The states a tracker emits, as [sessionId, state].
function recordStates(tracker) {
  const states = [];
  tracker.on('state', (tabId, sessionId, state) => states.push([sessionId, state]));
  return states;
}

// A process id that no longer runs.
function deadPid() {
  return String(spawnSync(process.execPath, ['-e', '']).pid);
}

test('nextState maps hook events to session states', () => {
  assert.equal(nextState(hook('SessionStart')), 'idle');
  assert.equal(nextState(hook('UserPromptSubmit')), 'working');
  assert.equal(nextState(hook('PreToolUse', { tool_name: 'Bash' })), 'working');
  assert.equal(nextState(hook('PreToolUse', { tool_name: 'AskUserQuestion' })), 'waiting');
  assert.equal(nextState(hook('PermissionRequest')), 'waiting');
  assert.equal(nextState(hook('Notification', { notification_type: 'permission_prompt' })), 'waiting');
  assert.equal(nextState(hook('Notification', { notification_type: 'idle_prompt' })), undefined);
  assert.equal(nextState(hook('SubagentStart')), 'working');
  assert.equal(nextState(hook('SubagentStop')), undefined);
  assert.equal(nextState(hook('Stop')), 'done');
  assert.equal(nextState(hook('StopFailure')), 'error');
});

test('a conversation goes through working, waiting and done', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const tracker = makeTracker(t);
  const states = recordStates(tracker);
  tracker.handle('tab1', hook('SessionStart', { source: 'startup' }));
  // A panel's claude that has only started is not a conversation yet.
  assert.deepEqual(tracker.conversations('tab1'), []);

  tracker.handle('tab1', hook('UserPromptSubmit', { cwd: '/work' }));
  tracker.handle('tab1', hook('PreToolUse', { tool_name: 'Bash' }));
  tracker.handle('tab1', hook('PermissionRequest', { tool_name: 'Bash' }));
  tracker.handle('tab1', hook('PostToolUse', { tool_name: 'Bash' }));
  tracker.handle('tab1', hook('Stop'));

  assert.deepEqual(states, [['s1', 'working'], ['s1', 'waiting'], ['s1', 'working'], ['s1', 'done']]);
  assert.deepEqual(tracker.conversations('tab1'), [
    { id: 's1', title: null, prompt: null, state: 'done', since: 1000, unread: false, cwd: '/work' },
  ]);
});

test('a conversation records when it came into its state, not when the last event came', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const tracker = makeTracker(t);
  const since = () => tracker.conversations('tab1')[0].since;
  tracker.handle('tab1', hook('UserPromptSubmit'));
  assert.equal(since(), 1000);

  t.mock.timers.tick(5000);
  tracker.handle('tab1', hook('PreToolUse', { tool_name: 'Bash' }));
  tracker.handle('tab1', hook('PostToolUse', { tool_name: 'Bash' }));
  tracker.handle('tab1', hook('Notification', { notification_type: 'idle_prompt' }));
  assert.equal(since(), 1000);

  t.mock.timers.tick(5000);
  tracker.handle('tab1', hook('PermissionRequest', { tool_name: 'Bash' }));
  t.mock.timers.tick(5000);
  // The prompt's notification comes after PermissionRequest; it is still the same wait.
  tracker.handle('tab1', hook('Notification', { notification_type: 'permission_prompt' }));
  assert.equal(since(), 11000);

  t.mock.timers.tick(5000);
  tracker.handle('tab1', hook('PostToolUse', { tool_name: 'Bash' }));
  assert.equal(since(), 21000);
  t.mock.timers.tick(5000);
  tracker.handle('tab1', hook('Stop'));
  assert.equal(since(), 26000);
  assert.equal(tracker.snapshot()[0].since, 26000);
});

test('a resumed session counts as a conversation from its start', (t) => {
  const tracker = makeTracker(t);
  tracker.handle('tab1', hook('SessionStart', { source: 'resume' }));
  assert.equal(tracker.conversations('tab1').length, 1);
});

// A background subagent still runs after the main agent's turn ends.
test.todo('Stop leaves a session working while a background subagent runs');

test('inState lists the conversations in a state, tab by tab in the given order', (t) => {
  const tracker = makeTracker(t);
  tracker.handle('tab1', hook('PermissionRequest', { session_id: 'a' }));
  tracker.handle('tab2', hook('PermissionRequest', { session_id: 'b' }));
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'c' }));
  tracker.handle('tab1', hook('PreToolUse', { session_id: 'd', tool_name: 'AskUserQuestion' }));
  // A panel's claude that has only started is not a conversation.
  tracker.handle('tab2', hook('SessionStart', { session_id: 'e', source: 'startup' }));

  assert.deepEqual(tracker.inState('waiting', ['tab2', 'tab1']), [
    { tabId: 'tab2', id: 'b' },
    { tabId: 'tab1', id: 'a' },
    { tabId: 'tab1', id: 'd' },
  ]);
  assert.deepEqual(tracker.inState('working', ['tab1', 'tab2']), [{ tabId: 'tab1', id: 'c' }]);
  assert.deepEqual(tracker.inState('idle', ['tab1', 'tab2']), []);
  // A tab not in the order (not open any more) does not count.
  assert.deepEqual(tracker.inState('waiting', ['tab1']).map((c) => c.id), ['a', 'd']);
});

test('nextConversation goes round the list, and starts again from the first when the last one has left it', () => {
  const list = [{ tabId: 'tab1', id: 'a' }, { tabId: 'tab1', id: 'b' }, { tabId: 'tab2', id: 'c' }];
  assert.equal(nextConversation(list, undefined).id, 'a');
  assert.equal(nextConversation(list, 'a').id, 'b');
  assert.equal(nextConversation(list, 'c').id, 'a');
  // "b" was answered.
  assert.equal(nextConversation(list.filter((c) => c.id !== 'b'), 'b').id, 'a');
  assert.equal(nextConversation([], 'a'), null);
});

test('tabState shows the most urgent state among the tab\'s sessions', (t) => {
  const tracker = makeTracker(t);
  tracker.handle('tab1', hook('Stop', { session_id: 'a' }));
  assert.equal(tracker.tabState('tab1'), 'done');
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'b' }));
  assert.equal(tracker.tabState('tab1'), 'working');
  tracker.handle('tab1', hook('PermissionRequest', { session_id: 'c' }));
  assert.equal(tracker.tabState('tab1'), 'waiting');
  assert.equal(tracker.tabState('tab2'), null);
});

// [id, state, unread] of a tab's rows.
const rows = (tracker, tabId) => tracker.conversations(tabId).map((c) => [c.id, c.state, c.unread]);

test('a conversation rests as an idle row once the last process that holds it ends it, and a session with none goes', (t) => {
  const tracker = makeTracker(t);
  tracker.handle('tab1', hook('UserPromptSubmit', { transcript_path: '/t/s1.jsonl' }), '101');
  tracker.handle('tab1', hook('UserPromptSubmit'), '102');
  tracker.handle('tab1', hook('Stop'), '102');
  tracker.markUnread('s1');
  tracker.handle('tab1', hook('SessionEnd'), '101');
  assert.deepEqual(rows(tracker, 'tab1'), [['s1', 'done', true]]);
  tracker.handle('tab1', hook('SessionEnd'), '102');
  assert.deepEqual(rows(tracker, 'tab1'), [['s1', 'idle', false]]);
  // Nothing writes to its transcript now, so it is not read until a hook names it again.
  assert.equal(tracker.sessions.get('s1').transcript, null);
  tracker.handle('tab1', hook('SessionStart', { source: 'resume', transcript_path: '/t/s1.jsonl' }), '103');
  assert.equal(tracker.sessions.get('s1').transcript, '/t/s1.jsonl');

  tracker.handle('tab1', hook('SessionStart', { session_id: 'blank', source: 'startup' }), '104');
  tracker.handle('tab1', hook('SessionEnd', { session_id: 'blank' }), '104');
  assert.equal(tracker.sessions.has('blank'), false);
});

test('a session from an older wrapper, without process ids, rests with SessionEnd', (t) => {
  const tracker = makeTracker(t);
  tracker.handle('tab1', hook('UserPromptSubmit'));
  tracker.handle('tab1', hook('SessionEnd'));
  assert.deepEqual(rows(tracker, 'tab1'), [['s1', 'idle', false]]);
});

test('a process that moves on to another conversation no longer holds the one before', (t) => {
  const tracker = makeTracker(t);
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'before' }), '101');
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'after' }), '101');
  assert.deepEqual(rows(tracker, 'tab1'), [['before', 'idle', false], ['after', 'working', false]]);
  assert.equal(tracker.sessions.get('before').procs.size, 0);
});

test('Claude rows are saved without runtime state, come back idle and archived as they were, and resume in place', (t) => {
  const tracker = makeTracker(t);
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'named', cwd: '/repo', transcript_path: '/t/named.jsonl' }), '101');
  tracker.updateTranscript(tracker.sessions.get('named'), [{ type: 'ai-title', aiTitle: 'AI title' },
    { type: 'custom-title', customTitle: 'Mine' }, { type: 'last-prompt', lastPrompt: 'Fix it' }]);
  tracker.handle('tab1', hook('Stop', { session_id: 'named' }), '101');
  tracker.markUnread('named');
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'hidden' }), '102');
  tracker.handle('tab1', hook('Stop', { session_id: 'hidden' }), '102');
  assert.ok(tracker.archive('tab1', 'hidden'));
  tracker.handle('tab1', hook('SessionStart', { session_id: 'blank', source: 'startup' }), '103');
  const saved = JSON.parse(JSON.stringify(tracker.history('tab1')));
  assert.deepEqual(saved, [
    { agent: 'claude', sessionId: 'named', title: 'Mine', aiTitle: 'AI title', prompt: 'Fix it', cwd: '/repo', archived: false },
    { agent: 'claude', sessionId: 'hidden', title: null, aiTitle: null, prompt: null, cwd: null, archived: true },
  ]);

  const restored = makeTracker(t);
  restored.restoreHistory('tab1', [...saved, { agent: 'claude', sessionId: '../bad' }, { agent: 'claude', sessionId: 7 },
    { agent: 'claude', threadId: 'other' }, { agent: 'claude', sessionId: 'named', title: 'Duplicate' }]);
  // A session is one tab's at a time.
  restored.restoreHistory('tab2', saved);
  assert.deepEqual(restored.conversations('tab1').map((c) => [c.id, c.title, c.prompt, c.state, c.unread, c.cwd]),
    [['named', 'Mine', 'Fix it', 'idle', false, '/repo']]);
  assert.deepEqual(restored.conversations('tab2'), []);
  assert.equal(restored.sessions.get('hidden').archived, true);
  assert.equal(restored.sessions.get('named').transcript, null);
  assert.equal(restored.procs.size, 0);
  assert.deepEqual(restored.history('tab1'), saved);

  // Clicking the row resumes the conversation, whose hooks come to the same row.
  restored.handle('tab1', hook('SessionStart', { session_id: 'named', source: 'resume', transcript_path: '/t/named.jsonl' }), '201');
  restored.handle('tab1', hook('UserPromptSubmit', { session_id: 'named' }), '201');
  assert.deepEqual(restored.conversations('tab1').map((c) => [c.id, c.state]), [['named', 'working']]);
  assert.deepEqual([...restored.sessions.get('named').procs], ['201']);
});

test('poll ends the sessions whose processes have exited', async (t) => {
  const tracker = makeObserved(t);
  const changes = [];
  tracker.on('change', (tabId) => changes.push(tabId));
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'alive' }), String(process.pid));
  tracker.handle('tab2', hook('UserPromptSubmit', { session_id: 'gone' }), deadPid());
  changes.length = 0;

  await tracker.poll();
  assert.deepEqual(rows(tracker, 'tab1'), [['alive', 'working', false]]);
  assert.deepEqual(rows(tracker, 'tab2'), [['gone', 'idle', false]]);
  assert.deepEqual(changes, ['tab2']);
});

test('poll leaves processes of WSL alone, and endProc ends their sessions', async (t) => {
  const tracker = makeObserved(t);
  const changes = [];
  tracker.on('change', (tabId) => changes.push(tabId));
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'wsl' }), 'wsl:Ubuntu:4242');
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'other' }), 'wsl:Ubuntu:4243');
  changes.length = 0;

  await tracker.poll();
  assert.deepEqual(tracker.conversations('tab1').map((c) => c.id), ['wsl', 'other']);
  tracker.endProc('wsl:Ubuntu:4242');
  tracker.endProc('wsl:Ubuntu:9999');
  assert.deepEqual(rows(tracker, 'tab1'), [['wsl', 'idle', false], ['other', 'working', false]]);
  assert.deepEqual(changes, ['tab1']);
});

test('the title comes from the transcript, a renamed one over the generated one', async (t) => {
  const dir = tempDir(t);
  const transcript = path.join(dir, 's1.jsonl');
  const tracker = makeObserved(t);
  tracker.handle('tab1', hook('UserPromptSubmit', { transcript_path: transcript }));

  fs.appendFileSync(transcript, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Generated' })}\n`);
  fs.appendFileSync(transcript, `${JSON.stringify({ type: 'last-prompt', lastPrompt: 'Do it' })}\n`);
  await tracker.poll();
  assert.equal(tracker.conversations('tab1')[0].title, 'Generated');
  assert.equal(tracker.conversations('tab1')[0].prompt, 'Do it');

  fs.appendFileSync(transcript, `${JSON.stringify({ type: 'custom-title', customTitle: 'Renamed' })}\n`);
  // A line still being written waits for the next read.
  fs.appendFileSync(transcript, '{"type":"ai-title","aiTitle":"Half');
  await tracker.poll();
  assert.equal(tracker.conversations('tab1')[0].title, 'Renamed');
});

test('an interruption in the transcript makes a working session idle', async (t) => {
  const dir = tempDir(t);
  const transcript = path.join(dir, 's1.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', text: '[Request interrupted by user] earlier' })}\n`);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const tracker = makeObserved(t);
  const states = recordStates(tracker);
  tracker.handle('tab1', hook('UserPromptSubmit', { transcript_path: transcript }));
  // An interruption from before the turn does not count.
  await tracker.poll();
  assert.equal(tracker.tabState('tab1'), 'working');

  t.mock.timers.tick(5000);
  fs.appendFileSync(transcript, `${JSON.stringify({ type: 'user', text: '[Request interrupted by user for tool use]' })}\n`);
  await tracker.poll();
  assert.equal(tracker.tabState('tab1'), 'idle');
  assert.deepEqual(states, [['s1', 'working'], ['s1', 'idle']]);
  assert.equal(tracker.conversations('tab1')[0].since, 6000);
});

test('unread marks follow the tab and the session', (t) => {
  const tracker = makeTracker(t);
  tracker.handle('tab1', hook('Stop', { session_id: 'a' }));
  tracker.handle('tab1', hook('Stop', { session_id: 'b' }));
  tracker.markUnread('a');
  tracker.markUnread('b');
  assert.equal(tracker.hasUnread('tab1'), true);
  assert.equal(tracker.markSeen('tab1', 'a'), true);
  assert.equal(tracker.markSeen('tab1', 'a'), false);
  assert.equal(tracker.hasUnread('tab1'), true);
  assert.equal(tracker.markSeen('tab1'), false);
  assert.equal(tracker.markSeen('tab1', null), false);
  assert.equal(tracker.markSeen('tab2', 'b'), false);
  assert.equal(tracker.markSeen('tab1', 'missing'), false);
  assert.equal(tracker.hasUnread('tab1'), true);
  assert.equal(tracker.markSeen('tab1', 'b'), true);
  assert.equal(tracker.hasUnread('tab1'), false);
});

test('archive takes a conversation off the list while its claude goes on', (t) => {
  const tracker = makeTracker(t);
  tracker.handle('tab1', hook('Stop', { session_id: 'a' }), '101');
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'b' }), '102');
  tracker.markUnread('a');

  // Not from another tab.
  assert.equal(tracker.archive('tab2', 'a'), false);
  assert.equal(tracker.archive('tab1', 'a'), true);
  assert.equal(tracker.archive('tab1', 'a'), false);
  assert.deepEqual(tracker.conversations('tab1').map((c) => c.id), ['b']);
  // Its result counts as seen, and the tab shows only the rest.
  assert.equal(tracker.hasUnread('tab1'), false);
  assert.equal(tracker.tabState('tab1'), 'working');
  assert.deepEqual([...tracker.procs.keys()], ['101', '102']);
});

test('a conversation that works or waits cannot be archived', (t) => {
  const tracker = makeTracker(t);
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'a' }));
  tracker.handle('tab1', hook('PermissionRequest', { session_id: 'b' }));
  assert.equal(tracker.archive('tab1', 'a'), false);
  assert.equal(tracker.archive('tab1', 'b'), false);
  assert.equal(tracker.archive('tab1', 'missing'), false);
  assert.deepEqual(tracker.conversations('tab1').map((c) => c.id), ['a', 'b']);
});

test('an archived conversation comes back when it works or waits again', (t) => {
  const tracker = makeTracker(t);
  tracker.handle('tab1', hook('Stop', { session_id: 'a' }));
  tracker.handle('tab1', hook('StopFailure', { session_id: 'b' }));
  tracker.archive('tab1', 'a');
  tracker.archive('tab1', 'b');
  // An archived error does not show on the tab.
  assert.equal(tracker.tabState('tab1'), null);

  // Opened again from the panel's history: still archived until a prompt is sent.
  tracker.handle('tab1', hook('SessionStart', { session_id: 'a', source: 'resume' }), '103');
  assert.deepEqual(tracker.conversations('tab1'), []);
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'a' }), '103');
  tracker.handle('tab1', hook('PreToolUse', { session_id: 'b', tool_name: 'AskUserQuestion' }));
  assert.deepEqual(tracker.conversations('tab1').map((c) => [c.id, c.state]), [['a', 'working'], ['b', 'waiting']]);
  // It stays on the list once it is done.
  tracker.handle('tab1', hook('Stop', { session_id: 'a' }));
  assert.deepEqual(tracker.conversations('tab1').map((c) => c.id), ['a', 'b']);
});

test('clearTab forgets the tab\'s sessions and their processes', (t) => {
  const tracker = makeTracker(t);
  tracker.handle('tab1', hook('UserPromptSubmit', { session_id: 'a' }), '101');
  tracker.handle('tab2', hook('UserPromptSubmit', { session_id: 'b' }), '102');
  tracker.clearTab('tab1');
  assert.deepEqual(tracker.snapshot().map((s) => s.id), ['b']);
  assert.deepEqual([...tracker.procs.keys()], ['102']);
});

async function waitFor(condition, timeout = 2000) {
  const until = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Posts to the hook server as claude's http hooks do.
async function post(server, route, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}/${route}`, {
    method: 'POST',
    headers: { 'X-Wrapper-Token': server.token, 'X-Wrapper-Tab': 'tab1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return response.status;
}

test('HookServer passes on hooks and helper messages that carry the token', async (t) => {
  const dir = tempDir(t);
  const logFile = path.join(dir, 'hooks.log');
  const server = new HookServer({ logFile });
  await server.listen();
  t.after(() => server.close());

  const hooks = [];
  const helpers = [];
  const themes = [];
  server.on('hook', (...args) => hooks.push(args));
  server.on('helper', (...args) => helpers.push(args));
  server.on('theme', (...args) => themes.push(args));

  assert.equal(await post(server, 'hook', hook('Stop'), { 'X-Wrapper-Proc': '4242' }), 200);
  assert.equal(await post(server, 'hook', hook('Stop'), { 'X-Wrapper-Proc': 'not-a-pid' }), 200);
  assert.equal(await post(server, 'helper', { port: 1234, token: 'abc' }), 200);
  assert.equal(await post(server, 'theme', {}), 200);
  assert.equal(await post(server, 'hook', 'not json'), 200);

  assert.deepEqual(hooks, [['tab1', hook('Stop'), '4242'], ['tab1', hook('Stop'), null]]);
  assert.deepEqual(helpers, [['tab1', { port: 1234, token: 'abc' }]]);
  assert.deepEqual(themes, [['tab1']]);
  // The log is written after the hook is passed on.
  await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').split('\n').length > 2);
  assert.match(fs.readFileSync(logFile, 'utf8'), /\ttab1\ts1\tStop\t\t4242\n/);
});

test('HookServer passes on the rate_limit_event lines that claude-wrap.exe posts to /usage', async (t) => {
  const dir = tempDir(t);
  const logFile = path.join(dir, 'hooks.log');
  const server = new HookServer({ logFile });
  await server.listen();
  t.after(() => server.close());
  const usage = [];
  const hooks = [];
  server.on('usage', (input) => usage.push(input));
  server.on('hook', (...args) => hooks.push(args));

  const event = {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1790000000 } } },
    session_id: 's1',
  };
  assert.equal(await post(server, 'usage', event, { 'X-Wrapper-Proc': '4242' }), 200);
  assert.equal(await post(server, 'usage', { type: 'assistant' }), 200);
  assert.equal(await post(server, 'usage', 'null'), 200);

  assert.deepEqual(usage, [event]);
  assert.deepEqual(hooks, []);
  await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('\n'));
  assert.match(fs.readFileSync(logFile, 'utf8'), /\ttab1\ts1\trate_limit_event\tfive_hour=0\.42\t4242\n/);
});

test('HookServer refuses requests without the token and unknown routes', async (t) => {
  const server = new HookServer();
  await server.listen();
  t.after(() => server.close());
  const hooks = [];
  server.on('hook', (...args) => hooks.push(args));

  assert.equal(await post(server, 'hook', hook('Stop'), { 'X-Wrapper-Token': 'wrong' }), 404);
  assert.equal(await post(server, 'other', hook('Stop')), 404);
  assert.deepEqual(hooks, []);
});

test('writeSettings sends every hook to the server, and SessionStart through the wrapper', (t) => {
  const file = path.join(tempDir(t), 'settings.json');
  const server = new HookServer();
  server.port = 5555;
  server.writeSettings(file, 'C:\\Tools\\worktabs\\claude-wrap.exe');
  const { hooks } = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.deepEqual(hooks.SessionStart[0].hooks[0], {
    type: 'command',
    command: '"C:/Tools/worktabs/claude-wrap.exe" --hook',
    timeout: 5,
  });
  const stop = hooks.Stop[0].hooks[0];
  assert.equal(stop.type, 'http');
  assert.equal(stop.url, 'http://127.0.0.1:5555/hook');
  assert.equal(stop.headers['X-Wrapper-Token'], '$WORKTABS_HOOK_TOKEN');
  assert.ok(hooks.SubagentStart && hooks.SubagentStop && hooks.PermissionRequest);
});

test('HookServer takes the requests that WSL agents pass on', () => {
  const server = new HookServer();
  const events = [];
  for (const name of ['hook', 'helper', 'explore', 'theme']) server.on(name, (...args) => events.push([name, ...args]));
  server.receive('hook', 'tab1', 'wsl:Ubuntu:42', JSON.stringify(hook('Stop')));
  server.receive('explore', 'tab1', null, '{"path":"/home/me/a.txt"}');
  server.receive('theme', 'tab1', null, '{}');
  server.receive('hook', '', null, JSON.stringify(hook('Stop')));
  server.receive('other', 'tab1', null, '{}');
  server.receive('hook', 'tab1', null, 'null');
  assert.deepEqual(events, [
    ['hook', 'tab1', hook('Stop'), 'wsl:Ubuntu:42'],
    ['explore', 'tab1', '/home/me/a.txt'],
    ['theme', 'tab1'],
  ]);
});

test('hookSettings sends every event to the URL, and SessionStart through the command', () => {
  const { hooks } = hookSettings('http://127.0.0.1:1/hook', "'node' 'agent.js' hook");
  assert.deepEqual(hooks.SessionStart, [{ hooks: [{ type: 'command', command: "'node' 'agent.js' hook", timeout: 5 }] }]);
  assert.equal(hooks.Stop[0].hooks[0].type, 'http');
  assert.equal(hooks.Stop[0].hooks[0].url, 'http://127.0.0.1:1/hook');
  assert.deepEqual(hooks.Stop[0].hooks[0].allowedEnvVars, ['WORKTABS_HOOK_TOKEN', 'WORKTABS_TAB_ID', 'WORKTABS_PROC_ID']);
});
