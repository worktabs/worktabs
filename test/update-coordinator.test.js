const assert = require('node:assert/strict');
const test = require('node:test');
const { UpdateCoordinator } = require('../src/code-server/update-coordinator');
const { applyGalleryUpdate } = require('../src/code-server/update-strategies');

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function setup(overrides = {}) {
  const events = [];
  const tabs = new Map([['a', { id: 'a', server: 'running' }]]);
  const deps = {
    tabs: () => tabs, changed: () => {}, busyError: () => 'busy', startingError: () => 'tab started',
    waitDetail: (unknown) => unknown ? 'unknown Codex' : 'busy tab', resumeDetail: () => 'resuming',
    risks: async () => ({ busy: [], unobserved: false }), sleep: async () => {},
    pause: (tab) => { events.push(`pause ${tab.id}`); tab.server = 'stopped'; },
    start: async (tab) => { events.push(`start ${tab.id}`); tab.server = 'running'; },
    log: (line) => events.push(line), ...overrides,
  };
  const coordinator = new UpdateCoordinator(deps);
  const strategy = {
    applying: 'applying', failure: (error) => error.message,
    prepare: async () => { events.push('prepare'); return 'prepared'; },
    apply: async (prepared) => { events.push(`apply ${prepared}`); return { status: 'done', detail: '' }; },
  };
  const execute = () => coordinator.execute(coordinator.begin([{ kind: 'extension' }], 'preparing'), strategy);
  return { coordinator, deps, strategy, tabs, events, execute };
}

test('a transaction prepares before pausing and always resumes before publishing success', async () => {
  const { coordinator, events, execute } = setup();
  assert.equal(await execute(), true);
  assert.deepEqual(events, ['prepare', 'pause a', 'apply prepared', 'start a']);
  assert.equal(coordinator.state.status, 'done');
  assert.equal(coordinator.busy, false);
});

test('cancel while waiting leaves tabs running and suppresses old progress after a new run begins', async () => {
  const delay = deferred();
  const { coordinator, events, execute } = setup({ risks: async () => ({ busy: ['a'], unobserved: true }), sleep: () => delay.promise });
  const pending = execute();
  await flush();
  assert.equal(coordinator.state.detail, 'unknown Codex');
  const old = coordinator.run;
  coordinator.cancel();
  const next = coordinator.begin([], 'next');
  old.report({ status: 'failed' });
  delay.resolve();
  assert.equal(await pending, false);
  assert.equal(coordinator.run, next);
  assert.equal(coordinator.state.detail, 'next');
  assert.deepEqual(events, ['prepare']);
});

test('a tab starting during the risk read prevents the switch', async () => {
  const risk = deferred();
  const { coordinator, events, execute, tabs } = setup({ risks: () => risk.promise });
  const pending = execute();
  await flush();
  tabs.set('b', { id: 'b', server: 'starting' });
  risk.resolve({ busy: [], unobserved: false });
  assert.equal(await pending, false);
  assert.equal(coordinator.state.detail, 'tab started');
  assert.deepEqual(events, ['prepare', 'tab started']);
  assert.equal(coordinator.switchOwner, null);
});

test('a start still at its gates does not stop the switch: a Codex tab waits there for this very update', async () => {
  const { execute, tabs, events } = setup();
  tabs.set('codex', { id: 'codex', server: 'starting', preparing: true });
  assert.equal(await execute(), true);
  assert.equal(events.includes('tab started'), false);
});

test('starts requested during the switch resume; closed and reopened identities are not confused', async () => {
  const apply = deferred();
  const { coordinator, strategy, execute, tabs, events } = setup();
  strategy.apply = () => apply.promise;
  const pending = execute();
  await flush();
  const blocked = { id: 'b', server: 'sleeping' };
  tabs.set('b', blocked);
  assert.equal(coordinator.canStart(blocked), false);
  tabs.delete('a');
  tabs.set('a', { id: 'a', server: 'sleeping' });
  apply.resolve({ status: 'done' });
  await pending;
  assert.deepEqual(events, ['prepare', 'pause a', 'start b']);
  assert.equal(coordinator.canStart(blocked), true);
});

for (const stage of ['prepare', 'pause', 'apply']) {
  test(`failure during ${stage} releases the transaction and resumes any paused tabs`, async () => {
    const { coordinator, strategy, deps, execute, events } = setup();
    if (stage === 'pause') deps.pause = (tab) => { tab.server = 'stopped'; throw new Error('pause failed'); };
    else strategy[stage] = async () => { throw new Error(`${stage} failed`); };
    assert.equal(await execute(), false);
    assert.equal(coordinator.state.status, 'failed');
    assert.equal(coordinator.busy, false);
    assert.equal(coordinator.switchOwner, null);
    assert.equal(events.includes('start a'), stage !== 'prepare');
  });
}

test('a failed resume still tries the other tabs and reports failure without holding the switch', async () => {
  const { coordinator, deps, execute, tabs, events } = setup();
  tabs.set('b', { id: 'b', server: 'running' });
  deps.start = async (tab) => { events.push(`start ${tab.id}`); if (tab.id === 'a') throw new Error('resume failed'); };
  assert.equal(await execute(), false);
  assert.equal(coordinator.state.detail, 'resume failed');
  assert.ok(events.includes('start b'));
  assert.equal(coordinator.busy, false);
  assert.equal(coordinator.switchOwner, null);
});

// A batch of one agent's extensions with tab 'b' busy outside that agent: the risk reads answer
// from `busy` (which tabs are still busy at each read), and the strategy records what it is given.
function agentSetup(busy) {
  const reads = [];
  const context = setup({
    restartDetail: (names) => `restart ${names.join(',')}`, settleDetail: (names) => `settle ${names.join(',')}`,
    risks: async (scope) => {
      reads.push(scope?.agent || 'all');
      if (scope) return { busy: [], deferrable: [context.tabs.get('b')], unobserved: false };
      const still = busy.shift() || [];
      return { busy: still, busyTabs: still.map((id) => context.tabs.get(id)), unobserved: false };
    },
  });
  context.tabs.set('b', { id: 'b', name: 'B', server: 'running' });
  context.strategy.agent = 'codex';
  context.strategy.release = () => context.events.push('release');
  context.reads = reads;
  context.details = [];
  context.coordinator.deps.changed = () => context.details.push(context.coordinator.state.detail);
  return context;
}

test('a batch of one agent\'s extensions leaves busy tabs of other work running, and restarts each once it is idle', async () => {
  const { coordinator, strategy, execute, events, reads, details } = agentSetup([['b'], ['b'], []]);
  strategy.apply = async (prepared, _report, { deferred }) => {
    events.push(`apply ${prepared} beside ${deferred.map((tab) => tab.id).join(',')}`);
    return { status: 'done', detail: '' };
  };
  assert.equal(await execute(), true);
  assert.deepEqual(events, ['prepare', 'pause a', 'apply prepared beside b', 'start a', 'pause b', 'start b', 'release']);
  assert.deepEqual(reads, ['codex', 'all', 'all', 'all']);
  assert.ok(details.includes('restart B'));
  assert.equal(coordinator.state.status, 'done');
  assert.equal(coordinator.busy, false);
});

test('a deferred tab that closes or stops is not restarted; one that fails to restart fails the update', async () => {
  const closed = agentSetup([['b']]);
  closed.deps.sleep = async () => { closed.tabs.delete('b'); };
  assert.equal(await closed.execute(), true);
  assert.deepEqual(closed.events, ['prepare', 'pause a', 'apply prepared', 'start a', 'release']);

  const failing = agentSetup([[]]);
  const start = failing.deps.start;
  failing.deps.start = async (tab) => { if (tab.id === 'b') throw new Error('b did not start'); return start(tab); };
  assert.equal(await failing.execute(), false);
  assert.equal(failing.coordinator.state.status, 'failed');
  assert.equal(failing.coordinator.state.detail, 'b did not start');
  assert.ok(failing.events.includes('release'));
});

test('deferred tabs restart one per read of the risks, so one busy again by then waits', async () => {
  // b and c are idle at the first read; c starts a turn while b restarts, and finishes later.
  const { tabs, deps, execute, events } = agentSetup([]);
  tabs.set('c', { id: 'c', name: 'C', server: 'running' });
  const reads = [[], ['c'], []];
  deps.risks = async (scope) => {
    if (scope) return { busy: [], deferrable: [tabs.get('b'), tabs.get('c')], unobserved: false };
    const still = reads.shift() || [];
    return { busy: still, busyTabs: still.map((id) => tabs.get(id)), unobserved: false };
  };
  deps.sleep = async () => { events.push('wait'); };
  assert.equal(await execute(), true);
  assert.deepEqual(events, ['prepare', 'pause a', 'apply prepared', 'start a', 'pause b', 'start b', 'wait', 'pause c', 'start c', 'release']);
});

test('a tab that the lifecycle could not start fails the update, though its start did not reject', async () => {
  const deferredTab = agentSetup([[]]);
  const start = deferredTab.deps.start;
  deferredTab.deps.start = async (tab) => {
    if (tab.id !== 'b') return start(tab);
    tab.server = 'error';
    tab.error = 'code-server ended (code 1)';
  };
  assert.equal(await deferredTab.execute(), false);
  assert.equal(deferredTab.coordinator.state.detail, 'code-server ended (code 1)');

  // The same for a tab stopped for the switch; one closed meanwhile has not failed.
  const paused = setup();
  paused.tabs.set('b', { id: 'b', server: 'running' });
  paused.deps.start = async (tab) => {
    if (tab.id === 'a') { tab.server = 'stopped'; tab.error = 'Codex could not be installed.'; }
    else paused.tabs.delete('b');
  };
  assert.equal(await paused.execute(), false);
  assert.equal(paused.coordinator.state.detail, 'Codex could not be installed.');
});

test('a paused tab that fails to resume does not stop the deferred tabs restarting before the old versions go', async () => {
  const { coordinator, deps, execute, events } = agentSetup([['b'], []]);
  const start = deps.start;
  deps.start = async (tab) => {
    if (tab.id === 'a') { events.push('start a'); throw new Error('a did not start'); }
    return start(tab);
  };
  assert.equal(await execute(), false);
  assert.deepEqual(events, ['prepare', 'pause a', 'apply prepared', 'start a', 'a did not start', 'pause b', 'start b', 'release']);
  assert.equal(coordinator.state.detail, 'a did not start');
});

test('a cancelled run that ends late leaves the deferred tabs of the run after it alone', async () => {
  const waits = [deferred(), deferred()];
  const pending = [...waits];
  let busy = true;
  const { coordinator, strategy, deps, tabs, events } = setup({
    restartDetail: () => 'restart', settleDetail: () => 'settle', sleep: () => waits.shift().promise,
  });
  tabs.set('b', { id: 'b', name: 'B', server: 'running' });
  // The first run waits for b, and is cancelled while it sleeps.
  deps.risks = async () => ({ busy: ['B'], busyTabs: [tabs.get('b')], unobserved: false });
  const old = coordinator.execute(coordinator.begin([{ kind: 'extension' }], 'old'), strategy);
  await flush();
  coordinator.cancel();
  // The next is one agent's: it leaves b running, and waits for it to be idle to restart it.
  deps.risks = async (scope) => (scope ? { busy: [], deferrable: [tabs.get('b')], unobserved: false }
    : { busy: busy ? ['B'] : [], busyTabs: busy ? [tabs.get('b')] : [], unobserved: false });
  const next = coordinator.execute(coordinator.begin([{ kind: 'import' }], 'next'),
    { ...strategy, agent: 'codex', release: () => events.push('release') });
  await flush();
  pending[0].resolve();
  assert.equal(await old, false);
  busy = false;
  pending[1].resolve();
  assert.equal(await next, true);
  assert.deepEqual(events.slice(-3), ['pause b', 'start b', 'release']);
});

test('going back stops the deferred tabs once idle, and restarts them with the others rather than after', async () => {
  const { coordinator, strategy, execute, events, details } = agentSetup([['b'], []]);
  strategy.apply = async (_prepared, _report, { settle }) => {
    events.push('probe failed');
    await settle();
    events.push('restore');
    throw new Error('probe failed');
  };
  assert.equal(await execute(), false);
  assert.deepEqual(events, ['prepare', 'pause a', 'probe failed', 'pause b', 'restore', 'probe failed', 'start a', 'start b', 'release']);
  assert.ok(details.includes('settle B'));
  assert.equal(coordinator.state.status, 'failed');
});

test('a batch that is not one agent\'s waits for every busy tab and defers none', async () => {
  const scopes = [];
  const { execute, strategy } = setup({ risks: async (scope) => { scopes.push(scope); return { busy: [], unobserved: false }; } });
  strategy.apply = async (_prepared, _report, { deferred }) => ({ status: deferred.length ? 'failed' : 'done' });
  assert.equal(await execute(), true);
  assert.deepEqual(scopes, [undefined]);
});

function gallery(overrides = {}) {
  const events = [];
  const options = {
    items: [], extensions: [{ id: 'agent', from: '1', to: '2' }], next: { version: 'new' }, previous: { version: 'old' },
    report: () => {}, log: () => {}, install: async (spec) => events.push(spec),
    use: ({ version }) => events.push(version), probe: async () => events.push('probe'),
    commit: () => events.push('commit'), wsl: () => [], ...overrides,
  };
  return { events, options };
}

test('gallery versions commit only after the probe and report WSL failure separately', async () => {
  const { events, options } = gallery({ wsl: () => [{ distro: 'Ubuntu', applyUpdate: async () => { throw new Error('offline'); } }] });
  const result = await applyGalleryUpdate(options);
  assert.deepEqual(events, ['agent@2', 'new', 'probe', 'commit']);
  assert.equal(result.status, 'done');
  assert.match(result.detail, /Ubuntu.*offline/);
});

for (const failedStage of ['install', 'probe', 'restore']) {
  test(`gallery ${failedStage} failure restores versions before resuming and does not commit`, async () => {
    const { events, options } = gallery();
    if (failedStage === 'install') options.install = async (spec) => { events.push(spec); if (spec.endsWith('@2')) throw new Error('install failed'); };
    else options.probe = async () => { throw new Error('probe failed'); };
    if (failedStage === 'restore') options.install = async (spec) => { events.push(spec); if (spec.endsWith('@1')) throw new Error('restore failed'); };
    const result = await applyGalleryUpdate(options);
    assert.equal(result.status, 'failed');
    assert.ok(events.includes('old'));
    assert.ok(events.includes('agent@1'));
    assert.ok(!events.includes('commit'));
    if (failedStage === 'restore') assert.match(result.detail, /restore failed/);
  });
}
