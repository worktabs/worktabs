const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const { spendView, usageView } = require('../src/agents/usage');
const { CodexUsageTracker } = require('../src/codex/codex-usage');
const { quotaBuckets } = require('../src/codex/codex-quota');
const { ConversationStore } = require('../src/conversations/conversation-store');

const { makeDocument, makeLocalStorage } = require('./support/sidebar-dom');

async function loadSidebar({ localStorageValues = {}, host, frames = null }) {
  const document = makeDocument();
  const windowListeners = new Map();
  const window = {
    document,
    host,
    innerHeight: 800,
    addEventListener(type, fn) { windowListeners.set(type, [...(windowListeners.get(type) || []), fn]); },
    dispatchEvent(event) { for (const fn of windowListeners.get(event.type) || []) fn(event); },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  // Node timers accept a controller as their receiver, but browser timers reject it.
  const browserTimer = (timer) => function () {
    'use strict';
    if (this !== undefined && this !== window) throw new TypeError('Illegal invocation');
    return timer(...arguments);
  };
  const context = {
    console,
    document,
    window,
    localStorage: makeLocalStorage(localStorageValues),
    setTimeout: browserTimer(setTimeout),
    clearTimeout: browserTimer(clearTimeout),
    setInterval: browserTimer(() => 0),
    clearInterval: browserTimer(clearInterval),
    // At once, so a test reads what an update rendered; press.test.js covers the frames.
    // With `frames`, they wait there for the test to run them.
    requestAnimationFrame: (fn) => { if (frames) frames.push(fn); else fn(); return 0; },
  };
  vm.createContext(context);
  const sidebarDir = path.join(__dirname, '..', 'src', 'sidebar');
  const html = fs.readFileSync(path.join(sidebarDir, 'index.html'), 'utf8');
  // Load the page's scripts together, in its own order, rather than injecting required helpers.
  for (const [, file] of html.matchAll(/<script src="([^"]+)"[^>]*><\/script>/g)) {
    const filename = path.resolve(sidebarDir, file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  await new Promise((resolve) => setImmediate(resolve));
  return { document, window };
}

test('subagent rows show names and roles, and completed children do not stay green', async () => {
  const folder = path.join(path.parse(process.cwd()).root, 'repos', 'worktabs');
  const store = new ConversationStore();
  store.handleCodex('tab', { threadId: 'parent', state: 'working', title: 'Parent task', conversation: true }, '100');
  const metadata = { threadId: 'child', subagent: true, parentThreadId: 'parent', agentNickname: 'Locke', agentRole: 'reviewer' };
  store.handleCodex('tab', { ...metadata, state: 'working', conversation: true }, '100');
  let update;
  const revealed = [];
  const snapshot = () => ({ tabs: [{ id: 'tab', folder, repo: null, server: 'running', provider: 'codex',
    agent: store.tabState('tab'), unread: store.hasUnread('tab'), conversations: store.conversations('tab') }],
  removing: [], repoUsed: {}, usage: [] });
  const host = new Proxy({ getState: async () => snapshot(), getRepos: async () => ({ seq: 1, repos: [], reading: false }),
    onUpdate: (callback) => { update = callback; }, revealSession: (...args) => revealed.push(args),
  }, { get: (target, key) => target[key] || (() => {}) });
  const { document } = await loadSidebar({ host });
  const child = () => document.querySelectorAll('.row.conversation')[1];
  assert.equal(child().querySelector('.name').textContent, 'Locke');
  assert.equal(child().style.values['--depth'], '1');
  assert.equal(document.querySelectorAll('.row.conversation')[0].style.values['--depth'], undefined);
  assert.equal(child().querySelector('.tag').textContent, 'Sub');
  assert.match(child().title, /Subagent/);
  assert.match(child().title, /Role: reviewer/);
  assert.equal(child().querySelector('.dot').className, 'dot working');
  child().click();
  assert.deepEqual(revealed, [['tab', 'codex:tab:child']]);
  store.handleCodex('tab', { ...metadata, state: 'done' }, '100');
  store.markUnread('codex:tab:child');
  update(snapshot());
  assert.equal(child().querySelector('.dot').className, 'dot idle');
  assert.equal(store.hasUnread('tab'), false);
  store.handleCodex('tab', { threadId: 'unnamed', parentThreadId: 'parent', subagent: true, state: 'working' }, '100');
  update(snapshot());
  const unnamed = document.querySelectorAll('.row.conversation')[2];
  assert.equal(unnamed.querySelector('.name').textContent, 'Subagent');
  assert.doesNotMatch(unnamed.textContent, /New conversation/);
});

test('the footer distinguishes Claude, Codex and both, with used percentages and warning/full/unknown states', async () => {
  const now = Date.now();
  const resetsAt = Math.floor(now / 1000) + 3600;
  const claude = usageView({ five_hour: { utilization: 0.84, resetsAt, at: now } }, now);
  const codex = new CodexUsageTracker();
  codex.take('tab', '1', { type: 'codex-usage', at: now, receivedAt: now, seq: 1, accountKey: null, complete: true,
    buckets: quotaBuckets({ rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 80, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt } },
      other: { limitName: '<img src=x onerror=alert(1)>', primary: { usedPercent: null, windowDurationMins: 15, resetsAt }, secondary: null },
    } }),
  }, now);
  let update;
  const state = { tabs: [], update: null, removing: [], repoUsed: {}, usage: claude, codexUsage: codex.view(now) };
  const host = new Proxy({
    getState: async () => state,
    getRepos: async () => ({ seq: 1, repos: [], reading: false }),
    onUpdate: (callback) => { update = callback; },
  }, { get: (target, key) => target[key] || (() => {}) });
  const { document } = await loadSidebar({ host });
  const footer = document.getElementById('usage');
  assert.equal(footer.hidden, false);
  assert.deepEqual(footer.querySelectorAll('.usage-heading').map((e) => e.textContent), ['Claude · Used', 'Codex · Used']);
  assert.deepEqual(footer.querySelectorAll('.usage-percent').map((e) => e.textContent), ['84%', '80%', '100%', '—']);
  assert.equal(footer.querySelectorAll('.usage-percent')[3].getAttribute('aria-label'), 'Unknown');
  assert.equal(footer.querySelectorAll('.usage-row.warn').length, 2);
  assert.equal(footer.querySelectorAll('.usage-row.over').length, 1);
  assert.deepEqual(footer.querySelectorAll('.usage-fill').map((e) => e.style.width), ['84%', '80%', '100%']);
  assert.equal(footer.querySelectorAll('.usage-reset').length, 4);
  assert.equal(footer.querySelectorAll('.usage-detail').length, 0);
  assert.equal(footer.querySelectorAll('.usage-received').length, 0);
  assert.doesNotMatch(footer.textContent, /Received|Updated/);
  assert.match(footer.querySelector('.usage-reset').textContent, /^↻ /);
  assert.match(footer.querySelector('.usage-reset').getAttribute('aria-label'), /^Resets /);
  assert.equal(footer.querySelectorAll('img').length, 0);
  assert.match(footer.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(footer.querySelector('.usage-row').title, /84% used/);
  assert.match(footer.querySelector('.usage-row').title, /Received/);

  const weekOnly = new CodexUsageTracker();
  weekOnly.take('tab', '1', { type: 'codex-usage', at: now, receivedAt: now, seq: 1, accountKey: null, complete: true,
    buckets: quotaBuckets({ rateLimits: { primary: { usedPercent: 13, windowDurationMins: 10080, resetsAt }, secondary: null } }),
  }, now);
  update({ ...state, codexUsage: weekOnly.view(now) });
  assert.deepEqual(footer.querySelectorAll('.usage-label').map((element) => element.textContent), ['5 hours', 'Week']);
  assert.equal(footer.querySelectorAll('.usage-bucket').length, 0);
  assert.deepEqual(footer.querySelectorAll('.usage-percent').map((element) => element.textContent), ['84%', '13%']);

  update({ ...state, codexUsage: null });
  assert.deepEqual(footer.querySelectorAll('.usage-heading').map((e) => e.textContent), ['Claude · Used']);
  update({ ...state, usage: [] });
  assert.deepEqual(footer.querySelectorAll('.usage-heading').map((e) => e.textContent), ['Codex · Used']);
  update({ ...state, usage: [], codexUsage: codex.view(now + 15 * 60000) });
  assert.equal(footer.querySelectorAll('.usage-fill').length, 0);
  assert.match(footer.textContent, /Stale usage/);
  codex.refreshStatus = 'Usage unavailable';
  codex.refresh = { active: false, attemptAt: now + 14 * 60000, nextAt: now + 19 * 60000 };
  update({ ...state, usage: [], codexUsage: codex.view(now + 15 * 60000) });
  assert.match(footer.textContent, /Usage unavailable/);
  assert.match(footer.textContent, /Stale usage/);
  assert.match(footer.querySelector('.usage-provider').title, /Last refresh attempt.*\nNext refresh/);
  assert.match(footer.querySelector('.usage-row').title, /Usage unavailable/);
  codex.refresh.active = true;
  update({ ...state, usage: [], codexUsage: codex.view(now + 15 * 60000) });
  assert.match(footer.textContent, /Refreshing usage/);
  update({ ...state, usage: [], codexUsage: { windows: [], status: 'Usage unavailable with API key', received: '' } });
  assert.match(footer.textContent, /Codex · UsedUsage unavailable with API key/);
  assert.equal(footer.querySelectorAll('.usage-percent').length, 0);
  update({ ...state, usage: [], codexUsage: null });
  assert.equal(footer.hidden, true);
  for (const status of ['Waiting for refresh', 'Usage unavailable']) {
    update({ ...state, usage: [], codexUsage: null, claudeUsage: { windows: [], status } });
    assert.equal(footer.hidden, false);
    assert.equal(footer.querySelectorAll('.usage-heading').length, 1);
    assert.match(footer.textContent, /Claude/);
    assert.ok(footer.textContent.includes(status));
    assert.equal(footer.querySelectorAll('.usage-fill').length, 0);
  }

  // A Claude Enterprise account with only a monthly spend limit: the amounts go where a reset time goes.
  const month = spendView({ used: 8500, limit: 10000, places: 2, currency: 'USD', reached: false, at: now }, now);
  update({ ...state, usage: [], codexUsage: null, claudeUsage: { windows: month, status: '' } });
  assert.deepEqual(footer.querySelectorAll('.usage-label').map((e) => e.textContent), ['Month']);
  assert.deepEqual(footer.querySelectorAll('.usage-percent').map((e) => e.textContent), ['85%']);
  assert.equal(footer.querySelectorAll('.usage-row.warn').length, 1);
  assert.equal(footer.querySelector('.usage-reset').textContent, '$85 / $100');
  assert.equal(footer.querySelector('.usage-reset').getAttribute('aria-label'), '$85 / $100');
  assert.match(footer.querySelector('.usage-row').title, /^Monthly spend: \$85\.00 of \$100\.00 used\nReceived /);
});

test('conversation providers and labels stay separate from state badges across updates', async () => {
  const folder = path.join(path.parse(process.cwd()).root, 'repos', 'worktabs');
  const states = ['idle', 'working', 'waiting', 'done', 'error'];
  const conversations = ['claude', 'codex', undefined].flatMap((agent) => states.map((state) => ({
    id: `${agent || 'legacy'}-${state}`, agent, state, unread: true, since: Date.now(),
    title: 'Shared title', prompt: '<img src=x onerror=alert(1)>', cwd: folder,
  })));
  let update;
  const tab = { id: 'tab', folder, repo: null, server: 'running', agent: 'working', provider: 'codex', conversations };
  const initial = { tabs: [tab], removing: [], repoUsed: {}, usage: [] };
  const revealed = [];
  const host = new Proxy({
    getState: async () => initial,
    getRepos: async () => ({ seq: 1, repos: [], reading: false }),
    onUpdate: (callback) => { update = callback; },
    revealSession: (tabId, sessionId) => revealed.push([tabId, sessionId]),
  }, { get: (target, key) => target[key] || (() => {}) });
  const { document } = await loadSidebar({ host });
  const providerPaths = new Map();
  const checkRows = (expectedStates) => {
    const rows = document.querySelectorAll('.row.conversation');
    assert.equal(rows.length, conversations.length);
    rows.forEach((row, index) => {
      const agent = conversations[index].agent === 'codex' ? 'codex' : 'claude';
      const label = agent === 'codex' ? 'Codex' : 'Claude Code';
      const mark = row.querySelector('.agent-icon');
      const badge = row.querySelector('.dot');
      assert.ok(mark.classList.contains(agent));
      assert.equal(mark.getAttribute('aria-hidden'), 'true');
      assert.equal(mark.getAttribute('viewBox'), '0 0 24 24');
      const shape = mark.querySelector('path.fill').getAttribute('d');
      if (providerPaths.has(agent)) assert.equal(shape, providerPaths.get(agent));
      else providerPaths.set(agent, shape);
      assert.ok(badge.classList.contains(expectedStates[index]));
      assert.equal(mark.parentNode, row);
      assert.equal(badge.parentNode, row);
      assert.notEqual(mark, badge);
      assert.ok(row.title.includes(`Agent: ${label}`));
      assert.ok(row.title.includes('Last prompt: <img src=x onerror=alert(1)>'));
      assert.equal(row.getAttribute('role'), 'treeitem');
      assert.equal(row.getAttribute('aria-label'), row.title);
      assert.equal(row.querySelector('.name').textContent, 'Shared title');
      assert.equal(row.querySelectorAll('img').length, 0);
    });
    return rows;
  };
  const rows = checkRows(conversations.map((conversation) => conversation.state));
  assert.notEqual(providerPaths.get('claude'), providerPaths.get('codex'));
  rows[5].click();
  assert.deepEqual(revealed, [['tab', 'codex-idle']]);
  // The tab default and the activity may change without changing a conversation's provider.
  update({ ...initial, tabs: [{ ...tab, provider: 'claude', conversations: conversations.map((conversation) => ({ ...conversation, state: 'working' })) }] });
  checkRows(conversations.map(() => 'working'));
});

test('a burst of updates renders the tree once, with the latest state, in the next frame', async () => {
  let update;
  const tab = (id) => ({ id, name: id, folder: `C:\\work\\${id}`, repo: null, server: 'running', agent: null, provider: 'claude', conversations: [] });
  const initial = { tabs: [], removing: [], repoUsed: {}, usage: [] };
  const host = new Proxy({
    getState: async () => initial,
    getRepos: async () => ({ seq: 1, repos: [], reading: false }),
    onUpdate: (callback) => { update = callback; },
  }, { get: (target, key) => target[key] || (() => {}) });
  const frames = [];
  const { document } = await loadSidebar({ host, frames });
  for (const fn of frames.splice(0)) fn();
  const tree = document.getElementById('open-tree');
  let rebuilt = 0;
  const replaceChildren = tree.replaceChildren.bind(tree);
  tree.replaceChildren = (...rows) => { rebuilt++; return replaceChildren(...rows); };
  update({ ...initial, tabs: [tab('a')] });
  update({ ...initial, tabs: [tab('a'), tab('b')] });
  update({ ...initial, tabs: [tab('a'), tab('b'), tab('c')] });
  assert.equal(rebuilt, 0);
  assert.equal(frames.length, 1);
  for (const fn of frames.splice(0)) fn();
  assert.equal(rebuilt, 1);
  assert.equal(document.querySelectorAll('.row.worktree.open').length, 3);
});

test('other repositories show only their own rows, at start and once their last tab closes', async () => {
  const used = '/repos/used';
  const left = '/repos/left';
  const tab = { id: 'tab', folder: used, repo: used, branch: 'main', server: 'running', conversations: [] };
  const snapshot = (tabs) => ({ tabs, removing: [], repoUsed: {}, usage: [] });
  const repo = (folder) => ({ path: folder, name: path.posix.basename(folder), owner: 'repos', git: true, sources: ['ghq'] });
  const worktrees = (folder) => [{ path: folder, branch: 'main', main: true }];
  let update;
  const host = new Proxy({
    getState: async () => snapshot([tab]),
    getRepos: async () => ({ seq: 1, reading: false, repos: [repo(used), repo(left)],
      worktrees: { [used]: worktrees(used), [left]: worktrees(left) } }),
    getWorktrees: async (folder) => worktrees(folder),
    github: async () => null,
    onUpdate: (callback) => { update = callback; },
  }, { get: (target, key) => target[key] || (() => {}) });
  // The last run left a repository without tabs expanded.
  const { document } = await loadSidebar({ host, localStorageValues: { expanded: [used, left] } });
  await new Promise((resolve) => setImmediate(resolve));
  const worktreeRows = (section) => document.querySelectorAll(`#${section}-tree .row.worktree`).length;
  assert.equal(worktreeRows('open'), 1);
  assert.equal(document.querySelectorAll('#other-tree .row.repo').length, 1);
  assert.equal(worktreeRows('other'), 0);

  update(snapshot([]));
  assert.equal(document.querySelectorAll('#other-tree .row.repo').length, 2);
  assert.equal(worktreeRows('other'), 0);

  // A click still shows a repository's worktrees, and they stay while it has no tab.
  document.querySelector('#other-tree .row.repo').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worktreeRows('other'), 1);
  update(snapshot([]));
  assert.equal(worktreeRows('other'), 1);

  update(snapshot([tab]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worktreeRows('open'), 1);
});

test('a repository whose remote git failed to read keeps its GitHub icon, and is not read again on every render', async (t) => {
  const repo = path.join(path.parse(process.cwd()).root, 'repos', 'worktabs');
  const key = repo.toLowerCase();
  const folders = [{ path: repo, branch: 'topic', main: true }];
  const snapshot = { tabs: [{ id: 'tab', folder: repo, repo, branch: 'topic', server: 'running', conversations: [] }], removing: [], repoUsed: {}, usage: [] };
  let update;
  let reads = 0;
  let pullReads = 0;
  const host = new Proxy({
    getState: async () => snapshot,
    getRepos: async () => ({ seq: 1, reading: false, repos: [{ path: repo, name: 'worktabs', owner: 'owner', git: true, sources: ['ghq'] }],
      worktrees: { [key]: folders }, providers: { [key]: 'github' } }),
    getWorktrees: async () => folders,
    github: async () => { reads++; return { error: 'git timed out' }; },
    pullRequests: async () => { pullReads++; return null; },
    onUpdate: (callback) => { update = callback; },
  }, { get: (target, property) => target[property] || (() => {}) });
  const { document, window } = await loadSidebar({ host });
  t.after(() => window.dispatchEvent({ type: 'beforeunload' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.ok(document.querySelector('.row.repo .gh-mark'), 'the icon still brings up the GitHub buttons');
  assert.equal(pullReads, 0, 'the pull requests wait for the repository');
  update(snapshot);
  update(snapshot);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.ok(document.querySelector('.row.repo .gh-mark'));
});

test('startup replies cannot replace newer open or closed tab state', async (t) => {
  for (const delayed of ['repos', 'tabs']) {
    for (const open of [true, false]) {
      await t.test(`${delayed} reply arrives after a tab ${open ? 'opens' : 'closes'}`, async () => {
        const repo = '/repos/worktabs';
        const tab = { id: 'tab', folder: repo, repo, branch: 'main', server: 'running', conversations: [] };
        const snapshot = (tabs) => ({ tabs, removing: [], repoUsed: {}, usage: [] });
        const initial = snapshot(open ? [] : [tab]);
        const latest = snapshot(open ? [tab] : []);
        const catalog = { seq: 1, repos: [{ path: repo, name: 'worktabs', owner: 'owner', git: true, sources: ['ghq'] }], reading: false,
          worktrees: { [repo]: [{ path: repo, branch: 'main', main: true }] } };
        let reply;
        const pending = new Promise((resolve) => { reply = resolve; });
        let update;
        const host = new Proxy({
          getState: () => delayed === 'tabs' ? pending : Promise.resolve(initial),
          getRepos: () => delayed === 'repos' ? pending : Promise.resolve(catalog),
          getWorktrees: async () => catalog.worktrees[repo],
          github: async () => null,
          onUpdate: (callback) => { update = callback; },
        }, { get: (target, key) => target[key] || (() => {}) });
        const { document } = await loadSidebar({ host });
        update(latest);
        reply(delayed === 'tabs' ? initial : catalog);
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(document.getElementById('open-section').hidden, !open);
        assert.equal(document.querySelectorAll('#open-tree .row.repo').length, open ? 1 : 0);
        assert.equal(document.querySelectorAll('#other-tree .row.repo').length, open ? 0 : 1);
        assert.equal(document.querySelectorAll('#open-tree .row.worktree').length, open ? 1 : 0);
      });
    }
  }
});

test('GitHub reads and pending CI preserve live badges and archive clicks', async (t) => {
  const repo = path.join(path.parse(process.cwd()).root, 'repos', 'worktabs');
  const key = repo.toLowerCase();
  const id = 'tab';
  const store = new ConversationStore();
  let server = 'starting';
  let update;
  const snapshot = () => ({ tabs: [{ id, folder: repo, repo, branch: 'main', server,
    agent: store.tabState(id), conversations: store.conversations(id) }], removing: [], repoUsed: {},
    counts: { working: store.inState('working', [id]).length, waiting: store.inState('waiting', [id]).length } });
  const event = (threadId, state) => store.handleCodex(id, { threadId, state, conversation: true,
    title: threadId, cwd: repo }, 'proc');
  event('one', 'idle');
  event('two', 'idle');
  store.on('change', () => update?.(snapshot()));
  const head = '1234567890abcdef';
  const folders = [{ path: repo, main: true, branch: 'main', head }];
  let finishGithub;
  let finishChecks;
  const github = new Promise((resolve) => { finishGithub = resolve; });
  const checks = new Promise((resolve) => { finishChecks = resolve; });
  let reads = 0;
  const archived = [];
  const host = new Proxy({
    getState: async () => snapshot(),
    getRepos: async () => ({ seq: 1, reading: false,
      repos: [{ path: repo, name: 'worktabs', owner: 'owner', git: true, sources: ['ghq'] }],
      worktrees: { [key]: folders }, providers: { [key]: 'github' } }),
    getWorktrees: async () => folders,
    github: () => github,
    pullRequests: () => { reads++; return checks; },
    onUpdate: (callback) => { update = callback; },
    archiveSession: (tabId, sessionId) => {
      archived.push([tabId, sessionId]);
      if (store.archive(tabId, sessionId)) update(snapshot());
    },
  }, { get: (target, property) => target[property] || (() => {}) });
  const { document, window } = await loadSidebar({ host });
  t.after(() => window.dispatchEvent({ type: 'beforeunload' }));
  const badge = () => document.querySelector('.row.worktree .dot').className;
  const rows = () => document.querySelectorAll('.row.conversation');
  const turnBadge = () => rows()[0].querySelector('.dot').className;
  assert.equal(badge(), 'dot starting');
  server = 'running';
  update(snapshot());
  assert.equal(badge(), 'dot idle');

  finishGithub({ slug: 'owner/worktabs', url: 'https://github.com/owner/worktabs', defaultBranch: 'main' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, 'exercise GitHub PR reads rather than treating the repository as offline');
  event('one', 'working');
  assert.equal(badge(), 'dot working');
  assert.equal(turnBadge(), 'dot working');
  assert.equal(rows()[0].querySelector('button.gh'), null, 'a working conversation cannot be archived');
  finishChecks({ pulls: {}, heads: { [head]: { oid: head, state: 'pending', total: 1, at: Date.now(),
    runs: [{ name: 'CI', state: 'pending', ref: 'refs/heads/main', at: Date.now() }] } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(document.querySelector('.row.worktree .head-checks'));
  assert.equal(turnBadge(), 'dot working');

  event('one', 'waiting');
  assert.equal(badge(), 'dot waiting');
  assert.equal(turnBadge(), 'dot waiting');
  event('one', 'idle');
  assert.equal(badge(), 'dot idle');
  assert.equal(turnBadge(), 'dot idle');
  const button = rows()[0].querySelector('button.gh');
  window.dispatchEvent({ type: 'pointerdown', target: button });
  event('two', 'idle');
  assert.equal(rows()[0].querySelector('button.gh'), button, 'an update cannot replace the pressed archive button');
  window.dispatchEvent({ type: 'pointerup', target: button });
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(archived, [[id, `codex:${id}:one`]]);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].querySelector('.name').textContent, 'two');
  assert.equal(store.codexHistory(id).find((entry) => entry.threadId === 'one').archived, true);
  event('one', 'idle');
  assert.equal(rows().length, 1, 'idle events do not restore an archived row');
  event('one', 'working');
  assert.equal(rows().length, 2, 'a new turn restores the archived row');
  assert.equal(badge(), 'dot working');
  assert.equal(turnBadge(), 'dot working');
});

test('the open repositories section renders worktree and agent rows when unfolded', async () => {
  const repo = 'C:\\repos\\worktabs';
  const folder = 'C:\\repos\\worktabs-codex';
  const repoKey = repo.toLowerCase();
  const revealed = [];
  const closed = [];
  let update;
  let settingsOpened = 0;
  let extensionsOpened = 0;
  const host = {
    getState: async () => ({
      tabs: [
        {
          id: 'tab-1',
          name: 'worktabs-codex',
          branch: 'codex-support',
          repo,
          folder,
          server: 'running',
          error: null,
          agent: 'working',
          provider: 'codex',
          unread: false,
          active: false,
          conversations: [
            { id: 'claude-1', state: 'done', since: Date.now() - 1000, title: 'Claude pass', agent: 'claude', cwd: folder, unread: true },
            { id: 'codex-1', state: 'working', since: Date.now() - 120000, title: 'Codex pass', prompt: 'Latest Codex task', agent: 'codex', cwd: folder },
            { id: 'codex-2', state: 'idle', since: Date.now(), title: 'Saved Codex thread', agent: 'codex', cwd: folder },
          ],
        },
      ],
      update: null,
      removing: [],
      repoUsed: {},
      usage: [],
      theme: null,
      counts: { waiting: 0, working: 1 },
    }),
    getRepos: async () => ({
      seq: 1,
      repos: [{ path: repo, name: 'worktabs', owner: 'acme', git: true, sources: ['ghq'] }],
      reading: false,
      visibility: {},
      providers: { [repoKey]: 'github' },
      uncloned: [],
      approved: {},
      worktrees: { [repoKey]: [{ path: folder, branch: 'codex-support', main: false }] },
    }),
    getWorktrees: async () => [{ path: folder, branch: 'codex-support', main: false }],
    github: async () => null,
    pullRequests: async () => ({ pulls: {}, heads: {} }),
    revealSession: (tabId, sessionId) => revealed.push({ tabId, sessionId }),
    activate() {},
    addWorktree() {},
    archiveSession() {},
    close() {},
    closeTabs: async (...args) => { closed.push(args); return true; },
    open() {},
    openChecks() {},
    openGithub() {},
    openIssue() {},
    openPull() {},
    removeWorktree() {},
    resetWidth: async () => null,
    showAddMenu() {},
    showSettings: () => settingsOpened++,
    showExtensions: () => extensionsOpened++,
    showMoreMenu() {},
    showRepoMenu() {},
    showTabMenu() {},
    showWorktreeMenu() {},
    startResize: async () => null,
    endResize: async () => null,
    resize() {},
    dismissUpdate() {},
    startUpdate() {},
    cancelUpdate() {},
    onCloned() {},
    onReloadWorktrees() {},
    onRepos() {},
    onUpdate(fn) { update = fn; },
    onWorktreeAdded() {},
  };
  const { document, window } = await loadSidebar({ localStorageValues: { foldedSections: ['open'] }, host });

  document.getElementById('settings').click();
  assert.equal(settingsOpened, 1);
  assert.equal(document.getElementById('extension-manager'), null, 'the gear is the one way into Settings');
  // An update that needs a look links to Settings > Extensions; one in progress does not.
  const tabState = await host.getState();
  const extensionsLink = () => document.querySelectorAll('#update button').find((button) => button.textContent === 'Extensions and updates');
  for (const status of ['available', 'failed', 'applying']) {
    update({ ...tabState, update: { status, items: [{ name: 'Codex', from: '1.0.0', to: '2.0.0' }] } });
    if (status === 'applying') assert.equal(extensionsLink(), undefined);
    else extensionsLink().click();
  }
  assert.equal(extensionsOpened, 2);
  update({ ...tabState, update: null });

  assert.equal(document.getElementById('open-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelectorAll('#open-tree .row.worktree').length, 0);

  document.getElementById('open-toggle').click();

  const worktrees = document.querySelectorAll('#open-tree .row.worktree');
  assert.equal(worktrees.length, 1);
  assert.equal(worktrees[0].querySelector('.name').textContent, 'codex');
  assert.equal(worktrees[0].querySelectorAll('.agent-icon').length, 0);

  const conversations = document.querySelectorAll('#open-tree .row.conversation');
  assert.equal(conversations.length, 3);
  assert.ok(conversations[0].querySelector('.agent-icon.claude'));
  assert.ok(conversations[1].querySelector('.agent-icon.codex'));
  assert.ok(conversations[2].querySelector('.agent-icon.codex'));
  assert.ok(conversations[1].title.includes('Last prompt: Latest Codex task'));
  assert.equal(conversations[1].querySelector('.elapsed').textContent, '2 min');

  conversations[1].click();
  conversations[2].click();
  assert.deepEqual(revealed, [{ tabId: 'tab-1', sessionId: 'codex-1' }, { tabId: 'tab-1', sessionId: 'codex-2' }]);
  const pressed = document.querySelector('.row.worktree');
  window.dispatchEvent({ type: 'pointerdown', target: pressed });
  const changed = await host.getState();
  changed.tabs[0].branch = 'changed-during-press';
  update(changed);
  assert.equal(document.querySelector('.row.worktree'), pressed);
  window.dispatchEvent({ type: 'pointerup', target: pressed });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.notEqual(document.querySelector('.row.worktree'), pressed);
  assert.ok(document.querySelector('.row.worktree').title.includes('changed-during-press'));
  document.querySelector('.close-all').click();
  await new Promise((resolve) => setImmediate(resolve));
  document.querySelector('.close-all').click();
  assert.deepEqual(closed.map(([path, ids]) => [path, [...ids]]), [[repo, ['tab-1']]]);

});
