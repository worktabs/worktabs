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
