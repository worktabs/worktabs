const assert = require('node:assert/strict');
const test = require('node:test');
const { ConversationStore } = require('../src/conversations/conversation-store');
const { ClaudeObserver, TITLE_TAIL_BYTES } = require('../src/conversations/claude-observer');
const hook = (event, fields = {}) => ({ session_id: 'session', hook_event_name: event, transcript_path: 'transcript', ...fields });
const line = (type, value) => Buffer.from(`${JSON.stringify({ type, [type === 'ai-title' ? 'aiTitle' : type === 'custom-title' ? 'customTitle' : 'lastPrompt']: value })}\n`);
// The reads a hook starts, which run on their own.
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const store = new ConversationStore({ now: () => 123 });
  const files = new Map(); const ranges = []; const probes = []; const timers = new Set(); let starts = 0; let fail = false;
  const observer = new ClaudeObserver(store, {
    size: (path) => files.get(path)?.length || 0,
    range: (path, start, end) => { ranges.push([start, end]); if (fail) throw new Error('unreadable'); return files.get(path).subarray(start, end); },
    alive: (pid) => { probes.push(pid); return pid === 100; },
    schedule: (fn) => { starts++; timers.add(fn); return fn; }, cancel: (fn) => timers.delete(fn),
  });
  return { store, observer, files, ranges, probes, timers, starts: () => starts, fail: (value) => { fail = value; }, append: (value) => files.set('transcript', Buffer.concat([files.get('transcript') || Buffer.alloc(0), value])) };
}

test('a state-only store handles providers, unread and archive state without runtime work', async () => {
  const f = fixture();
  f.store.handle('tab', hook('UserPromptSubmit'), '999');
  f.store.handle('tab', hook('Stop'), '999'); f.store.markUnread('session');
  assert.equal(f.store.markSeen('other', 'session'), false);
  assert.equal(f.store.markSeen('tab', 'session'), true);
  assert.equal(f.store.archive('tab', 'session'), true);
  f.store.handleCodex('tab', { threadId: 'thread', state: 'done', conversation: true }, '888');
  assert.equal(f.store.conversations('tab').length, 1);
  assert.equal(f.store.conversations('tab')[0].since, 123);
  assert.equal(f.store.timer, undefined);
  assert.equal(f.starts(), 0); assert.deepEqual(f.ranges, []); assert.deepEqual(f.probes, []);
});

test('transcript offsets retain incomplete UTF-8 lines and title precedence without duplicate changes', async () => {
  const f = fixture(); f.observer.start(); f.store.handle('tab', hook('UserPromptSubmit'));
  const title = line('ai-title', '日本語'); const split = title.indexOf(Buffer.from('日')) + 1;
  f.append(title.subarray(0, split)); await f.observer.poll(); assert.equal(f.store.conversations('tab')[0].title, null);
  f.append(title.subarray(split)); const changes = []; f.store.on('change', (tab) => changes.push(tab)); await f.observer.poll();
  assert.equal(f.store.conversations('tab')[0].title, '日本語'); assert.deepEqual(changes, ['tab']);
  assert.deepEqual(f.ranges, [[0, split], [split, title.length]]);
  f.append(line('custom-title', 'Renamed')); f.append(line('ai-title', 'Later')); f.append(line('last-prompt', 'Prompt')); await f.observer.poll();
  assert.equal(f.store.conversations('tab')[0].title, 'Renamed'); assert.equal(f.store.conversations('tab')[0].prompt, 'Prompt');
  changes.length = 0; await f.observer.poll(); assert.deepEqual(changes, []); f.observer.stop();
});

test('the first bounded tail skips a cut line and treats old interruptions only as a baseline', async () => {
  const f = fixture();
  f.append(Buffer.alloc(TITLE_TAIL_BYTES + 100, 0x78)); f.append(Buffer.from('\n[Request interrupted by user]\n')); f.append(line('ai-title', 'Resumed'));
  f.observer.start(); f.store.handle('tab', hook('UserPromptSubmit')); await settle();
  assert.equal(f.ranges[0][1] - f.ranges[0][0], TITLE_TAIL_BYTES);
  assert.equal(f.store.conversations('tab')[0].title, 'Resumed'); await f.observer.poll(); assert.equal(f.store.tabState('tab'), 'working');
  f.append(Buffer.from('Tool permission request failed: AbortError\n')); await f.observer.poll();
  assert.equal(f.store.tabState('tab'), 'idle'); assert.equal(f.store.conversations('tab')[0].since, 123);
  f.append(Buffer.from('[Request interrupted by user]\n')); f.store.handle('tab', hook('UserPromptSubmit')); await f.observer.poll();
  assert.equal(f.store.tabState('tab'), 'working'); f.observer.stop();
});

test('local exit observation rests the rows of ended processes and leaves WSL exits to their agent', async () => {
  const f = fixture(); f.observer.start();
  f.store.handle('live', hook('UserPromptSubmit', { session_id: 'live' }), '100');
  f.store.handle('dead', hook('UserPromptSubmit', { session_id: 'dead' }), '101');
  f.store.handle('wsl', hook('UserPromptSubmit', { session_id: 'wsl' }), 'wsl:Ubuntu:102');
  f.store.handleCodex('codex', { threadId: 'one', state: 'working' }, '103');
  f.store.handleCodex('codex', { threadId: 'two', state: 'waiting' }, '103');
  await f.observer.poll(); assert.deepEqual(f.probes, [100, 101, 103]);
  assert.deepEqual(f.store.conversations('dead').map((c) => c.state), ['idle']); assert.deepEqual(f.store.conversations('wsl').map((c) => c.state), ['working']);
  assert.deepEqual(f.store.conversations('codex').map((c) => c.state), ['idle', 'idle']);
  f.store.endProc('wsl:Ubuntu:102'); assert.deepEqual(f.store.conversations('wsl').map((c) => c.state), ['idle']); f.observer.stop();
});

test('attachment and disposal are idempotent and a stopped timer or hook cannot read files', async () => {
  const f = fixture(); f.observer.start().start(); assert.equal(f.starts(), 1);
  assert.equal(f.store.listenerCount('observe-claude'), 1); const callback = [...f.timers][0];
  f.observer.stop(); f.observer.stop(); await callback(); f.append(line('ai-title', 'Before restart')); f.store.handle('tab', hook('UserPromptSubmit'));
  await settle(); assert.deepEqual(f.ranges, []); assert.equal(f.timers.size, 0); assert.equal(f.store.listenerCount('observe-claude'), 0);
  f.observer.start(); await f.observer.poll(); assert.equal(f.starts(), 2); assert.equal(f.store.conversations('tab')[0].title, 'Before restart');
  f.observer.stop();
});

test('a temporary read failure preserves byte offsets so the next poll retries the same data', async () => {
  const f = fixture(); f.observer.start(); f.store.handle('tab', hook('UserPromptSubmit'));
  f.append(line('ai-title', 'Recovered')); f.fail(true); await f.observer.poll();
  assert.equal(f.store.conversations('tab')[0].title, null);
  f.fail(false); await f.observer.poll(); assert.equal(f.store.conversations('tab')[0].title, 'Recovered');
  assert.deepEqual(f.ranges[0], f.ranges[1]); f.observer.stop();
});

test('the reads a hook started finish before a poll reads the same transcript, and polls do not overlap', async () => {
  const f = fixture(); f.observer.start();
  const waiting = [];
  const size = f.observer.size;
  f.observer.size = (path) => new Promise((resolve) => waiting.push(() => resolve(size(path))));
  const answer = async () => { waiting.shift()(); await settle(); };
  f.append(line('ai-title', 'First'));
  // A new conversation that starts working: two reads, the second for the interruptions before it.
  f.store.handle('tab', hook('UserPromptSubmit'));
  const poll = f.observer.poll();
  // A poll due meanwhile reads nothing.
  await f.observer.poll();
  await settle();
  // One read at a time: the poll's waits behind the hook's.
  assert.equal(waiting.length, 1);
  await answer();
  assert.equal(f.store.conversations('tab')[0].title, 'First');
  await answer();
  f.append(line('ai-title', 'Second'));
  assert.equal(waiting.length, 1);
  await answer();
  await poll;
  assert.equal(f.store.conversations('tab')[0].title, 'Second');
  assert.deepEqual(f.ranges.map(([start]) => start), [0, line('ai-title', 'First').length]);
  f.observer.stop();
});
