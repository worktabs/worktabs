const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexUsageTracker, STALE_AFTER } = require('../src/codex/codex-usage');
const { UsagePolling } = require('../src/agents/usage-polling');
const { REFRESH_EVERY } = require('../src/agents/usage-refresh');

const NOW = Date.UTC(2026, 9, 10, 7);
const KEY = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const account = (at, seq = 1, key = KEY, authMode = 'chatgpt') => ({ type: 'codex-account', at, receivedAt: at, seq, accountKey: key, authMode });
const quota = (at, seq = 2, key = KEY, usedPercent = 12) => ({ type: 'codex-usage', at, receivedAt: at, seq, accountKey: key, complete: true,
  buckets: [{ id: 'codex', primary: { usedPercent, resetsAt: NOW / 1000 + 86400, windowDurationMins: 300 } }] });
const snapshot = (at, key = KEY) => ({ events: [account(at, 1, key), quota(at, 2, key)] });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(read) {
  let now = NOW;
  const codexUsage = new CodexUsageTracker(), logs = [], changes = [];
  const polling = new UsagePolling({ codexUsage, usage: {}, enabled: () => ['codex'], options: () => ({}),
    now: () => now, read, log: (record) => logs.push(record), changed: () => changes.push(codexUsage.view(now)) });
  return { codexUsage, polling, logs, changes, tick: (value) => { now = value; } };
}

test('failed scheduled reads preserve stale data and recover on the next five-minute refresh', async () => {
  let finish;
  const state = setup(() => new Promise((resolve, reject) => { finish = { resolve, reject }; }));
  const { codexUsage, polling, logs } = state;
  codexUsage.take('tab', 'proc', account(NOW), NOW);
  codexUsage.take('tab', 'proc', quota(NOW), NOW);
  state.tick(NOW + STALE_AFTER);
  polling.refreshAll();
  let view = codexUsage.view(NOW + STALE_AFTER);
  assert.equal(view.status, 'Refreshing usage');
  assert.equal(view.windows[0].detail, 'Stale usage');
  assert.equal(view.windows[0].percent, null);
  assert.match(view.windows[0].title, /Last refresh attempt/);
  finish.reject(Object.assign(new Error('private@example.test token secret'), { category: 'timeout' }));
  await flush();
  view = codexUsage.view(NOW + STALE_AFTER);
  assert.equal(view.status, 'Usage refresh timed out');
  assert.match(view.title, /Received .*\nUsage refresh timed out\nLast refresh attempt .*\nNext refresh/);
  assert.equal(codexUsage.latest.receivedAt, NOW);
  assert.equal(codexUsage.buckets.get('codex').receivedAt, NOW);
  assert.equal(logs.at(-1).outcome, 'failed');
  assert.equal(logs.at(-1).category, 'timeout');
  assert.equal(logs.at(-1).nextAt, NOW + STALE_AFTER + REFRESH_EVERY);

  const next = NOW + STALE_AFTER + REFRESH_EVERY;
  state.tick(next);
  polling.refreshAll();
  finish.resolve(snapshot(next));
  await flush();
  view = codexUsage.view(next);
  assert.equal(view.status, '');
  assert.equal(view.windows[0].percent, 12);
  assert.equal(codexUsage.latest.receivedAt, next);
  assert.equal(logs.at(-1).outcome, 'success');
  assert.equal(logs.at(-1).acceptedAccount, 1);
  assert.equal(logs.at(-1).acceptedQuota, 1);
  assert.doesNotMatch(JSON.stringify(logs), /private|secret|token|email|aaaaaaa/);
});

test('protocol success with rejected events is a rejected refresh, and a later read recovers', async () => {
  let response = snapshot(NOW);
  const { polling, codexUsage, logs, tick } = setup(async () => response);
  codexUsage.take('tab', 'proc', account(NOW + 1), NOW + 1);
  codexUsage.take('tab', 'proc', quota(NOW + 1), NOW + 1);
  tick(NOW + 2);
  await polling.refresh('codex');
  assert.equal(logs.at(-1).outcome, 'rejected');
  assert.equal(logs.at(-1).category, 'account-boundary');
  assert.equal(logs.at(-1).rejectedEvents, 2);
  assert.equal(codexUsage.latest.receivedAt, NOW + 1);
  assert.equal(codexUsage.view(NOW + 2).status, 'Usage refresh rejected');
  response = snapshot(NOW + 3);
  tick(NOW + 3);
  await polling.refresh('codex');
  assert.equal(logs.at(-1).outcome, 'success');
  assert.equal(codexUsage.view(NOW + 3).status, '');
  assert.equal([...codexUsage.sources.values()].filter((source) => source.tabId === 'usage-refresh').length, 1);
});

test('a newer live quota supersedes a read without renewing or overwriting it', async () => {
  let finish;
  const { polling, codexUsage, logs, tick } = setup(() => new Promise((resolve) => { finish = resolve; }));
  codexUsage.take('tab', 'proc', account(NOW), NOW);
  const pending = polling.refresh('codex');
  tick(NOW + 1);
  codexUsage.take('tab', 'proc', quota(NOW + 1, 2, KEY, 45), NOW + 1);
  finish(snapshot(NOW));
  await pending;
  assert.equal(logs.at(-1).outcome, 'rejected');
  assert.equal(logs.at(-1).category, 'superseded');
  assert.equal(logs.at(-1).acceptedAccount, 1);
  assert.equal(logs.at(-1).acceptedQuota, 0);
  assert.equal(codexUsage.latest.receivedAt, NOW + 1);
  assert.equal(codexUsage.view(NOW + 1).windows[0].percent, 45);
});

test('concurrent account changes fence same-time replies and coalesce overlapping attempts', async () => {
  let finish, calls = 0;
  const { polling, codexUsage, logs, tick } = setup(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  codexUsage.take('tab', 'proc', account(NOW), NOW);
  codexUsage.take('tab', 'proc', quota(NOW), NOW);
  const pending = polling.refresh('codex');
  // A login starts in the same millisecond as this read. Timestamp checks alone cannot fence it.
  codexUsage.take('tab', 'proc', account(NOW, 3, null, 'changing'), NOW);
  await polling.refresh('codex');
  finish(snapshot(NOW));
  await pending;
  assert.equal(calls, 1);
  assert.equal(logs.findLast((record) => record.outcome === 'rejected').category, 'account-boundary');
  assert.deepEqual(codexUsage.view(NOW).windows, []);
  assert.equal(codexUsage.view(NOW).status, 'Waiting for account');

  tick(NOW + 1);
  codexUsage.take('tab', 'proc', account(NOW + 1, 4, OTHER), NOW + 1);
  const recovered = polling.refresh('codex');
  await polling.refresh('codex');
  await polling.refresh('codex');
  assert.equal(calls, 2);
  finish(snapshot(NOW + 1, OTHER));
  await recovered;
  assert.equal(calls, 3);
  assert.equal(codexUsage.refresh.active, true);
  tick(NOW + 2);
  finish(snapshot(NOW + 2, OTHER));
  await flush();
  assert.equal(calls, 3);
  assert.equal(codexUsage.accountKey, OTHER);
  assert.equal(codexUsage.view(NOW + 2).windows[0].percent, 12);
  assert.equal(codexUsage.refresh.active, false);
});

test('a routine notification preserves receipt time but rejects in-flight data until the retry confirms identity', async () => {
  let finish;
  const { polling, codexUsage, logs, tick } = setup(() => new Promise((resolve) => { finish = resolve; }));
  codexUsage.take('tab', 'proc', account(NOW), NOW);
  codexUsage.take('tab', 'proc', quota(NOW), NOW);
  const pending = polling.refresh('codex');
  tick(NOW + 1);
  codexUsage.take('tab', 'proc', account(NOW + 1, 3, null), NOW + 1);
  await polling.refresh('codex');
  finish(snapshot(NOW));
  await pending;
  assert.equal(logs.findLast((record) => record.outcome === 'rejected').category, 'account-boundary');
  assert.equal(codexUsage.latest.receivedAt, NOW);
  assert.equal(codexUsage.awaitingIdentity, true);
  tick(NOW + 2);
  finish(snapshot(NOW + 2));
  await flush();
  assert.equal(codexUsage.awaitingIdentity, false);
  assert.equal(codexUsage.latest.receivedAt, NOW + 2);
});

test('even a matching live identity fences an older read from another account', async () => {
  let finish;
  const { polling, codexUsage, logs } = setup(() => new Promise((resolve) => { finish = resolve; }));
  codexUsage.take('tab', 'proc', account(NOW), NOW);
  const pending = polling.refresh('codex');
  codexUsage.take('tab', 'proc', account(NOW, 2), NOW);
  finish(snapshot(NOW, OTHER));
  await pending;
  assert.equal(logs.at(-1).category, 'account-boundary');
  assert.equal(codexUsage.accountKey, KEY);
});

test('unavailable quota still applies identity changes, and empty/unknown snapshots never mean 0%', async () => {
  let response = { events: [account(NOW + 1, 1, OTHER)], unavailable: true, category: 'quota-read' };
  const { polling, codexUsage, logs, tick } = setup(async () => response);
  codexUsage.take('tab', 'proc', account(NOW), NOW);
  codexUsage.take('tab', 'proc', quota(NOW), NOW);
  tick(NOW + 1);
  await polling.refresh('codex');
  assert.equal(codexUsage.accountKey, OTHER);
  assert.deepEqual(codexUsage.view(NOW + 1).windows, []);
  assert.equal(logs.at(-1).outcome, 'unavailable');
  let at = NOW + 1;
  for (const buckets of [[], [{ id: 'codex', primary: { usedPercent: null, resetsAt: NOW / 1000 + 86400 } }]]) {
    tick(++at);
    response = { events: [account(at, 1, OTHER), { ...quota(at, 2, OTHER), buckets }] };
    await polling.refresh('codex');
    assert.equal(logs.at(-1).outcome, 'unavailable');
    assert.equal(logs.at(-1).category, 'empty-quota');
    assert.equal(codexUsage.view(at).windows.some((window) => window.percent === 0), false);
  }
});

test('shutdown cancels reads, clears queued work and rejects late results', async () => {
  let finish, signal, calls = 0;
  const { polling, codexUsage, logs } = setup((_agent, options) => {
    calls++;
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  });
  const pending = polling.refresh('codex');
  await polling.refresh('codex');
  polling.stop();
  assert.equal(signal.aborted, true);
  finish(snapshot(NOW));
  await pending;
  await polling.refresh('codex');
  assert.equal(calls, 1);
  assert.deepEqual(codexUsage.view(NOW).windows, []);
  assert.equal(logs.at(-1).outcome, 'cancelled');
});

test('diagnostic failures cannot interrupt recovery or expose raw failure categories', async () => {
  const { polling, logs } = setup(async () => { throw Object.assign(new Error('private'), { category: 'secret token' }); });
  await polling.refresh('codex');
  assert.equal(logs.at(-1).category, 'read-failed');
  polling.log = () => { throw new Error('disk failure'); };
  await polling.refresh('codex');
  assert.equal(polling.reads.size, 0);
});

test('a Claude read that works but finds no window is logged as such, not as unavailable', async (t) => {
  const { UsageTracker } = require('../src/agents/usage');
  const { tempDir } = require('./support');
  const usage = new UsageTracker(require('node:path').join(tempDir(t), 'usage.json')), logs = [];
  let finish;
  const polling = new UsagePolling({ usage, codexUsage: new CodexUsageTracker(), enabled: () => ['claude'], options: () => ({}),
    now: () => NOW, changed: () => {}, log: (record) => logs.push(record), read: () => new Promise((resolve, reject) => { finish = { resolve, reject }; }) });
  const reset = NOW / 1000 + 3600;
  const read = async (result) => {
    const pending = polling.refresh('claude');
    const during = usage.providerView(NOW).status;
    if (result instanceof Error) finish.reject(result);
    else finish.resolve(result);
    await pending;
    return [during, usage.providerView(NOW).status, logs.at(-1).outcome, logs.at(-1).category];
  };
  assert.deepEqual(await read({ windows: {}, spend: null }), ['Waiting for refresh', 'No 5-hour or weekly limit', 'success', 'no-windows']);
  // That is known, so the next read does not take it away while it runs.
  assert.deepEqual(await read({ windows: {}, spend: { used: 1, limit: 100, places: 2, currency: 'USD', reached: false } }),
    ['No 5-hour or weekly limit', '', 'success', 'spend-only']);
  assert.deepEqual(await read({ windows: { five_hour: { utilization: 0.5, resetsAt: reset } } }), ['', '', 'success', '']);
  assert.equal(usage.spend, null);
  assert.deepEqual(await read(Object.assign(new Error('private'), { category: 'quota-read' })), ['', '', 'failed', 'quota-read']);
  assert.equal(usage.status, 'Usage unavailable');
});
