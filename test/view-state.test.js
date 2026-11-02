const assert = require('node:assert/strict');
const test = require('node:test');
const { createViewState, windowTitle } = require('../src/window/view-state');

test('windowTitle counts the conversations waiting and working', () => {
  assert.equal(windowTitle({ waiting: 0, working: 0 }), 'Worktabs');
  assert.equal(windowTitle({ waiting: 2, working: 0 }), 'Worktabs (Waiting for approval 2)');
  assert.equal(windowTitle({ waiting: 1, working: 3 }), 'Worktabs (Waiting for approval 1, Working 3)');
});

function setup({ agents = ['claude'], win = true } = {}) {
  const tab = { id: 't1', name: 'app', branch: 'main', repo: '/src/app', folder: '/src/app', server: 'running', error: null, provider: 'codex' };
  const lifecycle = { order: ['t1'], tabs: new Map([['t1', tab]]), activeId: 't1', ports: { port: () => 5001 } };
  const sessions = {
    tabState: () => 'working',
    hasUnread: () => true,
    conversations: () => [{ id: 's1' }, { id: 's2', agent: 'codex' }],
    inState: (state) => (state === 'working' ? [{ id: 's1' }] : []),
  };
  const sent = [];
  const views = {
    win: win ? { isDestroyed: () => false, setTitle: (title) => sent.push(['title', title]) } : null,
    sidebar: { webContents: { isDestroyed: () => false, send: (channel) => sent.push([channel]) } },
    emptyView: { setVisible: (on) => sent.push(['empty', on]) },
  };
  let scheduled = null;
  const state = createViewState({
    lifecycle, sessions, tabAgent: (t) => t.provider, update: () => ({ status: 'none' }),
    removing: new Set(['/src/old']), cloning: new Set(), repoUsed: () => ({ '/src/app': 1 }), agents: () => agents,
    usage: { view: () => ['five-hour'], providerView: () => ({ provider: 'claude' }) },
    codexUsage: { view: () => ({ provider: 'codex' }) }, shown: (t) => (t === tab ? ['s2'] : []),
    theme: () => null, views: () => views, schedule: (fn) => { scheduled = fn; },
  });
  return { state, sent, run: () => { const fn = scheduled; scheduled = null; fn(); }, pending: () => Boolean(scheduled) };
}

test('viewState describes each tab and the usage of the agents turned on', () => {
  const view = setup().state.viewState();
  assert.deepEqual(view.tabs[0], {
    id: 't1', name: 'app', branch: 'main', repo: '/src/app', folder: '/src/app', server: 'running', port: 5001, error: null,
    agent: 'working', provider: 'codex', unread: true,
    conversations: [{ id: 's1', agent: 'claude', shown: false }, { id: 's2', agent: 'codex', shown: true }], active: true,
  });
  assert.deepEqual(view.removing, ['/src/old']);
  assert.deepEqual(view.usage, ['five-hour']);
  assert.equal(view.codexUsage, null);
  assert.deepEqual(view.counts, { waiting: 0, working: 1 });
  const codexOnly = setup({ agents: ['codex'] }).state.viewState();
  assert.deepEqual(codexOnly.usage, []);
  assert.equal(codexOnly.claudeUsage, null);
  assert.deepEqual(codexOnly.codexUsage, { provider: 'codex' });
});

test('pushes in a burst go once, with the title, and none without a window', () => {
  const { state, sent, run, pending } = setup();
  state.push();
  state.push();
  run();
  assert.equal(pending(), false);
  assert.deepEqual(sent, [['tabs:update'], ['title', 'Worktabs (Working 1)'], ['empty', false]]);
  const closed = setup({ win: false });
  closed.state.push();
  closed.run();
  assert.deepEqual(closed.sent, []);
});
