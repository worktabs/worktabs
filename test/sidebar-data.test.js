const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SidebarData } = require('../src/sidebar/data');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const group = { key: '/repo', path: '/repo' };
function fixture() {
  const state = { worktrees: new Map(), savedWorktrees: new Map(), github: new Map([['/repo', {}]]), pulls: new Map(), expanded: new Set(['/repo']) };
  const requests = []; const timers = new Map(); let clock = 100; let changes = 0; let query = { branches: ['topic'], numbers: [], heads: ['oid'] };
  const read = (kind) => { const request = deferred(); requests.push({ kind, ...request }); return request.promise; };
  const data = new SidebarData({ state, host: { getWorktrees: () => read('worktrees'), github: () => read('github'), pullRequests: () => read('pulls') }, changed: () => changes++, groups: () => [group], pullBranches: () => query, checksRunning: (result) => [...result.heads.values()].some((c) => c.state === 'pending'), now: () => clock, schedule: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; }, cancel: (id) => timers.delete(id) });
  return { state, requests, timers, data, changes: () => changes, time: (value) => { clock = value; }, query: (value) => { query = value; } };
}
const found = (state = 'success') => ({ pulls: {}, heads: { oid: { state } } });

test('default timers do not pass the controller as the browser receiver', async () => {
  const timers = new Map();
  let cancelled = 0;
  const context = vm.createContext({
    module: { exports: {} },
    setTimeout: function (fn, ms) {
      'use strict';
      assert.equal(this, undefined, 'the controller cannot be a browser timer receiver');
      const id = Symbol();
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: function (id) {
      'use strict';
      assert.equal(this, undefined, 'the controller cannot be a browser timer receiver');
      cancelled++;
      timers.delete(id);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/sidebar/data.js'), 'utf8'), context);
  const state = { github: new Map([['/repo', {}]]), pulls: new Map(), expanded: new Set(['/repo']) };
  let reads = 0;
  const data = new context.module.exports.SidebarData({ state,
    host: { pullRequests: async () => { reads++; return found('pending'); } },
    changed() {}, groups: () => [group], pullBranches: () => ({ branches: ['topic'], numbers: [], heads: ['oid'] }),
    checksRunning: () => true,
  });
  await data.pulls(group);
  assert.equal(reads, 1);
  assert.equal(timers.size, 1);
  const [id, poll] = [...timers][0];
  assert.equal(poll.ms, 60000);
  timers.delete(id);
  poll.fn();
  await state.pulls.get('/repo').promise;
  assert.equal(reads, 2);
  assert.equal(timers.size, 1);
  data.forgetPulls();
  assert.equal(timers.size, 0);
  await data.pulls(group);
  assert.equal(timers.size, 1);
  data.dispose();
  assert.equal(timers.size, 0);
  assert.ok(cancelled >= 5);
});

test('worktree reads deduplicate, retain cached rows through failures, and accept successful empty lists', async () => {
  const f = fixture(); f.state.savedWorktrees.set('/repo', [{ path: '/repo' }]);
  const read = f.data.worktrees(group);
  assert.equal(f.data.worktrees(group), read);
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.worktrees.get('/repo').items.length, 1);
  f.requests[0].reject(new Error('offline')); await read;
  assert.equal(f.state.worktrees.get('/repo').status, 'error');
  assert.equal(f.state.worktrees.get('/repo').items.length, 1);
  const empty = f.data.worktrees(group); f.requests[1].resolve([]); await empty;
  assert.deepEqual(f.state.worktrees.get('/repo'), { status: 'ready', items: [] });
});

test('worktree entries removed during a read and replies after disposal cannot repopulate the view', async () => {
  const f = fixture(); const old = f.data.worktrees(group); f.state.worktrees.delete('/repo');
  const next = f.data.worktrees(group); f.requests[0].resolve([{ path: '/old' }]); await old;
  assert.equal(f.state.worktrees.get('/repo').status, 'loading');
  f.data.dispose(); const changes = f.changes(); f.requests[1].resolve([]); await next;
  assert.equal(f.changes(), changes);
});

test('GitHub reads deduplicate and refresh invalidates older replies', async () => {
  const f = fixture(); f.data.forgetGithub();
  const old = f.data.github(group); assert.equal(f.data.github(group), old);
  f.data.forgetGithub(); const next = f.data.github(group);
  f.requests[0].resolve({ url: 'old' }); await old;
  assert.equal(f.state.github.get('/repo'), undefined);
  f.requests[1].resolve({ url: 'new' }); await next;
  assert.deepEqual(f.state.github.get('/repo'), { url: 'new' });
});

test('a GitHub read git failed stays unknown, and is read again after waits that double up to a limit', async () => {
  const f = fixture(); f.data.forgetGithub();
  let read = f.data.github(group);
  f.requests[0].resolve({ error: 'git timed out' }); await read;
  assert.equal(f.state.github.has('/repo'), false, 'not taken for a repository outside GitHub');
  assert.equal(f.data.pulls(group), undefined);
  await f.data.github(group);
  assert.equal(f.requests.length, 1, 'neither the pull requests nor the remote are asked at once');
  // 15 s after the first failure; a rejected read is a failure too.
  f.time(15099); await f.data.github(group); assert.equal(f.requests.length, 1);
  f.time(15100); read = f.data.github(group); assert.equal(f.requests.length, 2);
  f.requests[1].reject(new Error('offline')); await read;
  assert.equal(f.state.github.has('/repo'), false);
  // Then 30 s, 60 s, and so on, but never more than 5 minutes.
  f.time(45099); await f.data.github(group); assert.equal(f.requests.length, 2);
  let now = 45100;
  for (const wait of [60000, 120000, 240000, 300000, 300000]) {
    f.time(now); read = f.data.github(group); f.requests.at(-1).resolve({ error: 'git timed out' }); await read;
    const asked = f.requests.length;
    f.time(now + wait - 1); await f.data.github(group); assert.equal(f.requests.length, asked, `waits ${wait} ms`);
    now += wait;
  }
  // A read that works ends it.
  const changes = f.changes();
  f.time(now); read = f.data.github(group); f.requests.at(-1).resolve({ url: 'https://github.com/o/r' }); await read;
  assert.deepEqual(f.state.github.get('/repo'), { url: 'https://github.com/o/r' });
  assert.equal(f.changes(), changes + 1);
  f.data.pulls(group); assert.equal(f.requests.at(-1).kind, 'pulls');
});

test('"not on GitHub" is kept, and refresh reads a failed repository again at once', async () => {
  const f = fixture(); f.data.forgetGithub();
  let read = f.data.github(group); f.requests[0].resolve(null); await read;
  assert.equal(f.state.github.get('/repo'), null);
  f.time(10 * 60 * 1000); await f.data.github(group); assert.equal(f.requests.length, 1);
  f.data.forgetGithub();
  read = f.data.github(group); f.requests[1].resolve({ error: 'git timed out' }); await read;
  f.data.forgetGithub();
  read = f.data.github(group); assert.equal(f.requests.length, 3);
  f.requests[2].resolve({ url: 'https://github.com/o/r' }); await read;
  assert.deepEqual(f.state.github.get('/repo'), { url: 'https://github.com/o/r' });
});

test('superseded PR queries and refresh replies cannot replace the current result', async () => {
  const f = fixture(); const old = f.data.pulls(group); assert.equal(f.data.pulls(group), old);
  f.query({ branches: ['new'], numbers: [], heads: ['oid'] }); const next = f.data.pulls(group);
  f.requests[1].resolve(found()); await next;
  f.requests[0].resolve({ pulls: { topic: { number: 1 } }, heads: {} }); await old;
  assert.deepEqual([...f.state.pulls.get('/repo').result.branches], ['new']);
  const invalid = f.data.pulls(group, 'now'); f.data.forgetPulls(); f.requests[2].resolve(found()); await invalid;
  assert.equal(f.state.pulls.size, 0);
});

test('stale timing and failed PR reads preserve results, with bounded pending polling and disposal', async () => {
  const f = fixture(); const read = f.data.pulls(group); f.requests[0].resolve(found('pending')); await read;
  assert.equal(f.timers.size, 1); const timer = [...f.timers.values()][0]; assert.equal(timer.ms, 60000);
  await f.data.pulls(group, 'stale'); assert.equal(f.requests.length, 1);
  f.time(16000); const stale = f.data.pulls(group, 'stale'); assert.equal(f.timers.size, 0);
  f.requests[1].reject(new Error('offline')); await stale;
  assert.equal(f.state.pulls.get('/repo').result.heads.get('oid').state, 'pending');
  const retry = f.data.pulls(group, 'now'); f.requests[2].resolve(found('pending')); await retry;
  const poll = [...f.timers.values()][0]; f.timers.clear(); poll.fn(); assert.equal(f.requests.length, 4);
  f.data.dispose(); const changes = f.changes(); f.requests[3].resolve(found()); await f.state.pulls.get('/repo')?.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.timers.size, 0); assert.equal(f.state.pulls.size, 0); assert.equal(f.changes(), changes);
});

test('pending checks poll only expanded groups and an empty query cancels the old read', async () => {
  const f = fixture(); const read = f.data.pulls(group); f.requests[0].resolve(found('pending')); await read;
  f.state.expanded.clear(); [...f.timers.values()][0].fn(); assert.equal(f.requests.length, 1);
  const old = f.data.pulls(group, 'now'); f.query({ branches: [], numbers: [], heads: [] }); f.data.pulls(group);
  f.requests[1].resolve(found()); await old;
  assert.equal(f.state.pulls.get('/repo').result.heads.size, 0);
});
