const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { ConversationStore } = require('../src/conversations/conversation-store');
const { TabLifecycle } = require('../src/tabs/tab-lifecycle');
const { StartupGate } = require('../src/tabs/startup-gate');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const folder = (name) => path.resolve('test-repos', name);

function setup(overrides = {}) {
  const events = [];
  const starts = [];
  const sessions = new ConversationStore();
  const manager = {
    start: async (id, dir, port, options) => {
      starts.push({ id, dir, port, options });
      events.push(['start', id]);
      return { port: port || 4000 + starts.length, cookie: { name: id, value: 'cookie' } };
    },
    stop: (id) => events.push(['stop', id]),
    folderUrl: (port, dir) => `http://127.0.0.1:${port}/?folder=${encodeURIComponent(dir)}`,
  };
  const deps = {
    idOf: (dir) => dir.toLowerCase(),
    resolveFolder: path.resolve,
    describe: (dir, provider = 'claude') => ({ name: path.basename(dir), branch: null, provider }),
    mount: (tab) => events.push(['mount', tab.id]),
    unmount: (tab) => events.push(['unmount', tab.id]),
    lookupRepo: async () => ({ repo: folder('primary'), linkedWorktree: true }),
    lookupBranch: async () => 'feature',
    used: (tab) => events.push(['used', tab.id]),
    managerFor: () => manager,
    canStart: () => true,
    startOptions: (tab) => ({ shareSettings: tab.repo }),
    connect: async (tab) => events.push(['connect', tab.id]),
    navigate: (tab, url) => events.push(['navigate', tab.id, url]),
    placeholder: (tab, state, detail) => events.push(['placeholder', tab.id, state, detail]),
    exitError: (code) => `exit ${code}`,
    cleanup: (tab, options) => {
      events.push(['cleanup', tab.id, options.keepCodex]);
      sessions.clearTab(tab.id, options);
    },
    activate: (tab) => events.push(['activate', tab.id]),
    confirm: async () => true,
    confirmTogether: async () => true,
    canClose: () => true,
    remember: async (tab) => events.push(['remember', tab.id]),
    reload: (tab) => events.push(['reload', tab.id]),
    metadata: (tab) => ({ provider: tab.provider, conversations: sessions.codexHistory(tab.id) }),
    restoreMetadata: (tab, entry) => sessions.restoreCodexHistory(tab.id, entry.conversations),
    clearStorage: (ports) => events.push(['clearStorage', ports]),
    save: () => events.push(['save']),
    changed: () => events.push(['changed']),
    ...overrides,
  };
  const lifecycle = new TabLifecycle(deps);
  const open = (name, options = {}) => {
    const id = lifecycle.open(folder(name), { activate: false, start: false, ...options });
    return lifecycle.tabs.get(id);
  };
  return { lifecycle, events, starts, manager, deps, open, sessions };
}

test('early tabs wait for shared preparation before selecting a server manager', async () => {
  const gate = new StartupGate();
  let managers = 0;
  const f = setup({ prepare: () => gate.wait() });
  f.deps.managerFor = () => { managers++; return f.manager; };
  const a = f.open('a', { start: true, activate: true });
  const first = f.lifecycle.start(a);
  const b = f.open('b', { start: true, activate: true });
  const second = f.lifecycle.start(b);
  await flush();
  assert.equal(managers, 0);
  assert.equal(f.starts.length, 0);
  assert.equal(a.server, 'starting');
  assert.equal(b.server, 'starting');
  // At the gate, nothing is launched yet: updates do not wait for these starts.
  assert.deepEqual([a.preparing, b.preparing], [true, true]);
  assert.equal(f.lifecycle.activeId, b.id);
  gate.complete();
  await Promise.all([first, second]);
  assert.equal(managers, 2);
  assert.equal(f.starts.length, 2);
  assert.deepEqual([a.preparing, b.preparing], [false, false]);
  assert.equal(a.server, 'running');
  assert.equal(b.server, 'running');
  assert.equal(f.lifecycle.activeId, b.id);
});

test('a start whose gate opens during an update switch leaves the start to the update, which starts it after', async () => {
  const { UpdateCoordinator } = require('../src/code-server/update-coordinator');
  const gate = new StartupGate();
  const f = setup({ prepare: () => gate.wait() });
  const tabs = new Map();
  const coordinator = new UpdateCoordinator({
    tabs: () => tabs, changed: () => {}, busyError: () => 'busy', startingError: () => 'a tab started',
    waitDetail: () => '', resumeDetail: () => '', risks: async () => ({ busy: [] }), sleep: async () => {},
    pause: () => {}, start: (tab) => f.lifecycle.start(tab), log: () => {},
  });
  f.deps.canStart = (tab) => coordinator.canStart(tab);
  const a = f.open('a', { start: true, activate: true });
  tabs.set(a.id, a);
  const pending = f.lifecycle.start(a);
  await flush();
  // The gate opens in the middle of the switch (as Codex's install does for a Codex tab).
  const done = await coordinator.execute(coordinator.begin([{ kind: 'import' }], 'preparing'), {
    applying: 'applying', failure: (error) => error.message,
    apply: async () => {
      gate.complete();
      await pending;
      assert.equal(f.starts.length, 0);
      assert.equal(a.server, 'stopped');
      return { status: 'done', detail: '' };
    },
  });
  assert.equal(done, true);
  assert.equal(f.starts.length, 1);
  assert.equal(a.server, 'running');
});

test('close and reopen cancel preparation waits without holding the replacement', async () => {
  const gate = new StartupGate();
  const { lifecycle, starts, events, open } = setup({ prepare: () => gate.wait() });
  const old = open('a', { start: true });
  const pending = lifecycle.start(old);
  await flush();
  await lifecycle.close(old.id, { force: true });
  await pending;
  assert.equal(starts.length, 0);
  assert.ok(!events.some(([name]) => name === 'stop'));
  const replacement = open('a', { start: true });
  const next = lifecycle.start(replacement);
  gate.complete();
  await next;
  assert.equal(starts.length, 1);
  assert.equal(replacement.server, 'running');
  assert.equal(events.filter(([name]) => name === 'navigate').length, 1);
});

test('restart during preparation launches only the replacement run', async () => {
  const gate = new StartupGate();
  const { lifecycle, starts, open } = setup({ prepare: () => gate.wait() });
  const tab = open('a', { start: true });
  const pending = lifecycle.start(tab);
  await flush();
  const next = lifecycle.restartNow(tab);
  await pending;
  assert.equal(starts.length, 0);
  gate.complete();
  await next;
  assert.equal(starts.length, 1);
  assert.equal(tab.server, 'running');
});

test('preparation failure marks waiting and later tabs as errors without starting servers', async () => {
  const gate = new StartupGate();
  const { lifecycle, starts, events, open } = setup({ prepare: () => gate.wait() });
  const a = open('a', { start: true });
  const pending = lifecycle.start(a);
  gate.fail(new Error('Could not install the extensions: offline'));
  await pending;
  const b = open('b', { start: true });
  await lifecycle.start(b);
  for (const tab of [a, b]) {
    assert.equal(tab.server, 'error');
    assert.match(tab.error, /Could not install the extensions: offline/);
  }
  assert.equal(starts.length, 0);
  assert.ok(!events.some(([name]) => name === 'stop'));
});

test('a gate that may pass next time leaves the tab stopped, and selecting it tries again', async () => {
  let attempts = 0;
  const { lifecycle, starts, open } = setup({ prepare: async () => {
    if (++attempts === 1) throw Object.assign(new Error('Could not install Codex from Open VSX: offline'), { retryable: true });
  } });
  const tab = open('a', { start: true });
  await lifecycle.start(tab);
  assert.equal(tab.server, 'stopped');
  assert.match(tab.error, /offline/);
  lifecycle.activate(tab.id);
  await lifecycle.starts.get(tab.id);
  assert.equal(attempts, 2);
  assert.equal(starts.length, 1);
  assert.equal(tab.server, 'running');
});

test('saved tabs, history and ports survive opening and closing tabs during preparation', async () => {
  const gate = new StartupGate();
  const { lifecycle, sessions, starts, open } = setup({ prepare: () => gate.wait() });
  const a = folder('a'), b = folder('b');
  lifecycle.restore({ tabs: [{ folder: a, port: 4200, provider: 'codex',
    conversations: [{ agent: 'codex', threadId: 'saved', archived: true }] }, { folder: b, port: 4201 }], active: a }, () => true);
  const early = open('early', { start: true, activate: true });
  assert.deepEqual(lifecycle.snapshot().tabs.map((tab) => tab.folder), [a, b, early.folder]);
  assert.equal(sessions.codexHistory(a.toLowerCase())[0].archived, true);
  await lifecycle.close(a.toLowerCase(), { force: true });
  const during = lifecycle.snapshot();
  assert.deepEqual(during.tabs.map((tab) => tab.folder), [b, early.folder]);
  assert.equal(during.tabs[0].port, 4201);
  assert.equal(during.ports[a], 4200);
  assert.equal(during.active, early.folder);
  assert.equal(sessions.codexHistory(a.toLowerCase()).length, 0);
  gate.complete();
  await lifecycle.start(early);
  assert.equal(starts.length, 1);
  assert.equal(lifecycle.tabs.get(b.toLowerCase()).server, 'sleeping');
  assert.deepEqual(starts[0].options.avoid, new Set([4200, 4201]));
});

test('opening the same folder preserves identity, order, and provider', async () => {
  const { lifecycle, events, open } = setup();
  const tab = open('a', { provider: 'codex' });
  assert.equal(open('a', { provider: 'claude' }), tab);
  assert.deepEqual(lifecycle.order, [tab.id]);
  assert.equal(events.filter(([name]) => name === 'mount').length, 1);
  assert.equal(tab.provider, 'codex');
  await tab.repoLookup;
  assert.equal(tab.linkedWorktree, true);
});

test('a start waits for repository settings and duplicate starts share its completion', async () => {
  const lookup = deferred();
  const { lifecycle, starts, open } = setup({ lookupRepo: () => lookup.promise });
  const tab = open('a');
  const pending = lifecycle.start(tab);
  assert.equal(lifecycle.start(tab), pending);
  await flush();
  assert.equal(starts.length, 0);
  assert.equal(tab.server, 'starting');
  lookup.resolve({ repo: folder('primary'), linkedWorktree: true });
  await pending;
  assert.equal(starts.length, 1);
  assert.equal(starts[0].options.shareSettings, folder('primary'));
  assert.equal(tab.server, 'running');
  assert.equal(tab.codexObserved, false);
});

test('closing during git lookup releases the next start without waiting for old git', async () => {
  const lookup = deferred();
  const branch = deferred();
  let first = true;
  const { lifecycle, starts, events, open } = setup({
    lookupRepo: () => {
      if (first) { first = false; return lookup.promise; }
      return { repo: null, linkedWorktree: false };
    },
    lookupBranch: () => branch.promise,
  });
  const old = open('a');
  const pending = lifecycle.start(old);
  await flush();
  await lifecycle.close(old.id, { force: true });
  const replacement = open('a');
  await lifecycle.start(replacement);
  await pending;
  assert.equal(starts.length, 1);
  assert.equal(replacement.server, 'running');
  const before = events.length;
  lookup.resolve({ repo: folder('old'), linkedWorktree: true });
  branch.resolve('old-branch');
  await flush();
  assert.equal(old.repo, undefined);
  assert.equal(old.branch, null);
  assert.equal(replacement.repo, null);
  assert.ok(events.slice(before).every(([name]) => name !== 'used'));
});

test('a reopened tab waits for the old server preparation and its final stop', async () => {
  const { lifecycle, manager, starts, events, open } = setup();
  const result = deferred();
  const originalStart = manager.start;
  manager.start = async (...args) => {
    await originalStart(...args);
    if (starts.length === 1) return result.promise;
    return { port: 4100, cookie: {} };
  };
  const old = open('a');
  const pending = lifecycle.start(old);
  await flush();
  const oldOwner = starts[0].options.owner;
  await lifecycle.close(old.id, { force: true });
  const replacement = open('a');
  const next = lifecycle.start(replacement);
  await flush();
  assert.equal(starts.length, 1);
  const before = events.length;
  starts[0].options.onProgress('late progress');
  lifecycle.exited(old.id, 1, oldOwner);
  assert.equal(events.length, before);
  result.resolve({ port: 4001, cookie: {} });
  await Promise.all([pending, next]);
  assert.equal(starts.length, 2);
  assert.equal(replacement.server, 'running');
  assert.equal(lifecycle.ports.port(old.id), 4100);
  const lastStop = events.findLastIndex(([name]) => name === 'stop');
  const lastStart = events.findLastIndex(([name]) => name === 'start');
  assert.ok(lastStop < lastStart);
  assert.equal(events.filter(([name]) => name === 'navigate').length, 1);
  assert.deepEqual(events.filter(([name]) => name === 'cleanup'), [['cleanup', old.id, false]]);
  lifecycle.exited(replacement.id, 1, oldOwner);
  assert.equal(replacement.server, 'running');
});

test('closing during cookie installation cannot load a destroyed view or overwrite its replacement', async () => {
  const cookie = deferred();
  let first = true;
  const { lifecycle, events, starts, open } = setup({ connect: () => {
    if (first) { first = false; return cookie.promise; }
  } });
  const old = open('a');
  const pending = lifecycle.start(old);
  await flush();
  await lifecycle.close(old.id, { force: true });
  const replacement = open('a');
  const next = lifecycle.start(replacement);
  await flush();
  assert.equal(starts.length, 1);
  cookie.resolve();
  await Promise.all([pending, next]);
  assert.equal(old.server, 'starting');
  assert.equal(replacement.server, 'running');
  assert.equal(events.filter(([name]) => name === 'navigate').length, 1);
  assert.equal(starts[1].port, 4001);
});

test('late startup failure cannot put a reopened tab into an error state', async () => {
  const failure = deferred();
  const { lifecycle, manager, starts, open } = setup();
  const originalStart = manager.start;
  manager.start = async (...args) => {
    const result = await originalStart(...args);
    return starts.length === 1 ? failure.promise : result;
  };
  const old = open('a');
  const pending = lifecycle.start(old);
  await flush();
  await lifecycle.close(old.id, { force: true });
  const replacement = open('a');
  const next = lifecycle.start(replacement);
  failure.reject(new Error('old start failed'));
  await Promise.all([pending, next]);
  assert.equal(replacement.server, 'running');
  assert.equal(replacement.error, null);
});

test('restart during a pending start serializes the replacement on the same tab', async () => {
  const result = deferred();
  const { lifecycle, manager, starts, events, open } = setup();
  const originalStart = manager.start;
  manager.start = async (...args) => {
    const value = await originalStart(...args);
    return starts.length === 1 ? result.promise : value;
  };
  const tab = open('a');
  const pending = lifecycle.start(tab);
  await flush();
  const restart = lifecycle.restartNow(tab);
  await flush();
  assert.equal(starts.length, 1);
  result.resolve({ port: 4001, cookie: {} });
  await Promise.all([pending, restart]);
  assert.equal(tab.server, 'running');
  assert.equal(starts.length, 2);
  assert.deepEqual(events.filter(([name]) => name === 'cleanup'), [['cleanup', tab.id, true]]);
  lifecycle.exited(tab.id, 1, starts[0].options.owner);
  assert.equal(tab.server, 'running');
});

test('an exit during cookie installation leaves the tab stopped', async () => {
  const cookie = deferred();
  const { lifecycle, events, starts, open } = setup({ connect: () => cookie.promise });
  const tab = open('a');
  const pending = lifecycle.start(tab);
  await flush();
  lifecycle.exited(tab.id, 42, starts[0].options.owner);
  cookie.resolve();
  await pending;
  assert.equal(tab.server, 'stopped');
  assert.equal(tab.error, 'exit 42');
  assert.equal(events.filter(([name]) => name === 'navigate').length, 0);
  assert.deepEqual(events.filter(([name]) => name === 'cleanup'), [['cleanup', tab.id, true]]);
});

test('an exit before a delayed health response is reported as a startup error', async () => {
  const result = deferred();
  const { lifecycle, manager, starts, open } = setup();
  const originalStart = manager.start;
  manager.start = async (...args) => { await originalStart(...args); return result.promise; };
  const tab = open('a');
  const pending = lifecycle.start(tab);
  await flush();
  lifecycle.exited(tab.id, 7, starts[0].options.owner);
  result.resolve({ port: 4001, cookie: {} });
  await pending;
  assert.equal(tab.server, 'error');
  assert.equal(tab.error, 'exit 7');
});

test('a slow start only holds back replacements of its own tab ID', async () => {
  const result = deferred();
  const { lifecycle, manager, starts, open } = setup();
  const originalStart = manager.start;
  manager.start = async (...args) => {
    const value = await originalStart(...args);
    return args[1] === folder('a') ? result.promise : value;
  };
  const a = open('a'), b = open('b');
  const pending = lifecycle.start(a);
  await lifecycle.start(b);
  assert.equal(b.server, 'running');
  assert.equal(a.server, 'starting');
  assert.equal(starts.length, 2);
  result.resolve({ port: 4001, cookie: {} });
  await pending;
});

test('startup failure stops the server and clears runtime state before a retry', async () => {
  const { lifecycle, events, starts, open } = setup({ connect: async () => { throw new Error('cookie failed'); } });
  const tab = open('a');
  await lifecycle.start(tab);
  assert.equal(tab.server, 'error');
  assert.equal(tab.error, 'cookie failed');
  assert.ok(events.some(([name]) => name === 'stop'));
  assert.deepEqual(events.filter(([name]) => name === 'cleanup'), [['cleanup', tab.id, true]]);
  lifecycle.deps.connect = async () => {};
  await lifecycle.start(tab);
  assert.equal(starts.length, 2);
  assert.equal(tab.server, 'running');
});

test('a failed repository lookup starts no server and is reported on the tab', async () => {
  const { lifecycle, starts, open } = setup({ lookupRepo: async () => { throw new Error('git failed'); } });
  const tab = open('a');
  await lifecycle.start(tab);
  assert.equal(tab.server, 'error');
  assert.equal(tab.error, 'git failed');
  assert.equal(starts.length, 0);
});

test('suspending keeps Codex history and the port; closing removes the history', async () => {
  const { lifecycle, sessions, starts, open } = setup();
  const tab = open('a', { provider: 'codex' });
  sessions.restoreCodexHistory(tab.id, [{ agent: 'codex', threadId: 'thread-1', title: 'Saved conversation', cwd: tab.folder }]);
  await lifecycle.start(tab);
  const history = sessions.codexHistory(tab.id);
  assert.equal(history.length, 1);
  await lifecycle.suspend(tab, { force: true });
  assert.equal(tab.server, 'sleeping');
  assert.deepEqual(sessions.codexHistory(tab.id), history);
  lifecycle.activate(tab.id);
  await lifecycle.start(tab);
  assert.equal(starts[1].port, starts[0].port || 4001);
  await lifecycle.close(tab.id, { force: true });
  assert.equal(sessions.codexHistory(tab.id).length, 0);
  assert.equal(lifecycle.ports.port(tab.id), 4001);
});

for (const action of ['close', 'restart', 'reload', 'suspend']) {
  test(`a pending ${action} confirmation cannot act on a reopened tab`, async () => {
    const approval = deferred();
    const { lifecycle, events, open } = setup({ confirm: () => approval.promise });
    const old = open('a');
    await lifecycle.start(old);
    const pending = action === 'close' ? lifecycle.close(old.id) : lifecycle[action](old);
    await lifecycle.close(old.id, { force: true });
    const replacement = open('a');
    await lifecycle.start(replacement);
    const before = events.length;
    approval.resolve(true);
    await pending;
    assert.equal(events.length, before);
    assert.equal(lifecycle.tabs.get(old.id), replacement);
    assert.equal(replacement.server, 'running');
  });
}

test('canceling a risk confirmation leaves the running server and tab intact', async () => {
  const { lifecycle, events, open } = setup({ confirm: async () => false });
  const tab = open('a');
  await lifecycle.start(tab);
  for (const action of ['close', 'restart', 'reload', 'suspend']) {
    if (action === 'close') await lifecycle.close(tab.id);
    else await lifecycle[action](tab);
  }
  assert.equal(tab.server, 'running');
  assert.equal(lifecycle.tabs.get(tab.id), tab);
  assert.ok(events.every(([name]) => !['stop', 'unmount', 'reload', 'cleanup'].includes(name)));
});

test('a suspend waiting for chat width cannot stop a newer run on the same tab', async () => {
  const width = deferred();
  const { lifecycle, events, open } = setup({ remember: () => width.promise });
  const tab = open('a');
  await lifecycle.start(tab);
  const pending = lifecycle.suspend(tab, { force: true });
  await flush();
  await lifecycle.restartNow(tab);
  const before = events.length;
  width.resolve();
  await pending;
  assert.equal(events.length, before);
  assert.equal(tab.server, 'running');
});

test('forced worktree removal closes the same tab even if it restarts during a width read', async () => {
  const width = deferred();
  const { lifecycle, open } = setup({ remember: () => width.promise });
  const tab = open('a');
  await lifecycle.start(tab);
  const pending = lifecycle.close(tab.id, { force: true });
  await flush();
  await lifecycle.restartNow(tab);
  width.resolve();
  await pending;
  assert.equal(lifecycle.tabs.size, 0);
});

test('close clears the reveal timer of the captured tab after it leaves the map', async () => {
  const { lifecycle, open } = setup();
  const tab = open('a');
  let fired = false;
  tab.pendingReveal = 'conversation';
  tab.revealTimer = setTimeout(() => { fired = true; }, 1);
  await lifecycle.close(tab.id, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(tab.pendingReveal, null);
  assert.equal(fired, false);
});

test('switching and closing delegate cancellation to the captured tab conversation controller', async () => {
  const canceled = [];
  const { lifecycle, open } = setup({ cancelReveal: (tab) => {
    canceled.push(tab);
    tab.pendingReveal = null;
  } });
  const first = open('a'), second = open('b');
  lifecycle.activate(first.id);
  first.pendingReveal = 'conversation';
  lifecycle.activate(second.id);
  assert.equal(first.pendingReveal, null);
  assert.deepEqual(canceled, [first]);
  second.pendingReveal = 'another';
  await lifecycle.close(second.id, { force: true });
  assert.equal(second.pendingReveal, null);
  assert.ok(canceled.includes(second));
});

test('closing a group selects once and never starts another tab in the group', async () => {
  const { lifecycle, events, starts, open } = setup();
  const a = open('a'), b = open('b'), c = open('c'), d = open('d');
  lifecycle.activate(b.id);
  await lifecycle.start(b);
  const before = events.length;
  assert.equal(await lifecycle.closeTogether([b.id, c.id, b.id], 'repo'), true);
  await lifecycle.start(d);
  assert.deepEqual(lifecycle.order, [a.id, d.id]);
  assert.equal(lifecycle.activeId, d.id);
  assert.deepEqual(events.slice(before).filter(([name]) => name === 'activate'), [['activate', d.id]]);
  assert.deepEqual(starts.map(({ id }) => id), [b.id, d.id]);
});

test('group confirmation captures tab identities and suppresses a duplicate request', async () => {
  const approval = deferred();
  const { lifecycle, open } = setup({ confirmTogether: () => approval.promise });
  const a = open('a'), b = open('b');
  const pending = lifecycle.closeTogether([a.id, b.id], 'repo');
  assert.equal(await lifecycle.closeTogether([a.id, b.id], 'repo'), false);
  await lifecycle.close(a.id, { force: true });
  const replacement = open('a');
  approval.resolve(true);
  assert.equal(await pending, true);
  assert.deepEqual([...lifecycle.tabs.values()], [replacement]);
  assert.equal(lifecycle.closingTogether, false);
});

test('a canceled group close can be requested again', async () => {
  const { lifecycle, deps, open } = setup({ confirmTogether: async () => false });
  const tab = open('a');
  assert.equal(await lifecycle.closeTogether([tab.id], 'repo'), false);
  assert.equal(lifecycle.tabs.get(tab.id), tab);
  deps.confirmTogether = async () => true;
  assert.equal(await lifecycle.closeTogether([tab.id], 'repo'), true);
  assert.equal(lifecycle.activeId, null);
});

test('extension switching blocks starts until the caller resumes them', async () => {
  const { lifecycle, deps, starts, open } = setup({ canStart: () => false });
  const tab = open('a');
  lifecycle.activate(tab.id);
  await lifecycle.start(tab);
  assert.equal(tab.server, 'sleeping');
  assert.equal(starts.length, 0);
  deps.canStart = () => true;
  await lifecycle.start(tab);
  assert.equal(tab.server, 'running');
  lifecycle.stop(tab);
  assert.equal(tab.server, 'stopped');
  await lifecycle.start(tab);
  assert.equal(starts.length, 2);
});

test('restore keeps background tabs lazy, metadata and ports, and clears absent folders', async () => {
  const { lifecycle, starts, sessions, events } = setup();
  const a = folder('a'), b = folder('b'), closed = folder('closed'), gone = folder('gone');
  const conversations = [{ agent: 'codex', threadId: 'thread-1', title: 'Saved conversation', cwd: a }];
  lifecycle.restore({
    tabs: [{ folder: a, port: 4200, provider: 'codex', conversations }, { folder: b, port: 4201, provider: 'claude' }, { folder: gone, port: 4202 }],
    active: b,
    ports: { [closed]: 4203 },
  }, (dir) => dir !== gone);
  const active = lifecycle.tabs.get(b.toLowerCase());
  await lifecycle.start(active);
  const snapshot = lifecycle.snapshot();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].dir, b);
  assert.equal(starts[0].port, 4201);
  assert.deepEqual(starts[0].options.avoid, new Set([4200, 4203]));
  assert.equal(lifecycle.tabs.get(a.toLowerCase()).server, 'sleeping');
  assert.equal(snapshot.tabs[0].provider, 'codex');
  assert.equal(sessions.codexHistory(a.toLowerCase()).length, 1);
  assert.equal(snapshot.tabs[0].conversations[0].threadId, 'thread-1');
  assert.equal(snapshot.active, b);
  assert.deepEqual(snapshot.ports, { [closed]: 4203 });
  assert.ok(events.some(([name, ports]) => name === 'clearStorage' && ports.includes(4202)));
});

test('legacy restore and a missing active folder select the first surviving tab', async () => {
  const { lifecycle, starts } = setup();
  lifecycle.restore({ tabs: [folder('a'), folder('b')], active: folder('gone') }, () => true);
  await lifecycle.start(lifecycle.tabs.get(lifecycle.activeId));
  assert.equal(lifecycle.activeId, folder('a').toLowerCase());
  assert.deepEqual(starts.map(({ dir }) => dir), [folder('a')]);
});
