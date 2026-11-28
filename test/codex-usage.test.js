const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexQuotaObserver, quotaBuckets, quotaWindow } = require('../src/codex/codex-quota');
const { CodexUsageTracker, STALE_AFTER } = require('../src/codex/codex-usage');
const { HookServer } = require('../src/conversations/hooks');

const NOW = new Date(2026, 9, 10, 14, 0).getTime();
const RESET = NOW / 1000 + 3600;
const primary = { usedPercent: 25, windowDurationMins: 15, resetsAt: RESET };
const bucket = { limitId: 'codex', limitName: null, primary, secondary: null };
const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
function usage(at = NOW, seq = 1, overrides = {}) {
  return { type: 'codex-usage', at, receivedAt: at, seq, complete: true, accountKey: null, buckets: quotaBuckets({ rateLimits: bucket }), ...overrides };
}
function account(at, seq, accountKey = KEY, authMode = 'chatgpt') {
  return { type: 'codex-account', at, receivedAt: at, seq, accountKey, authMode };
}
function observer() {
  let now = NOW;
  const events = [];
  const proxy = new CodexQuotaObserver((event) => events.push(event), () => now);
  return { proxy, events, tick: (ms = 1) => { now += ms; } };
}

test('Codex quota projects only percentages, reported durations, resets and bucket names', () => {
  assert.deepEqual(quotaBuckets({ rateLimits: { ...bucket, token: 'secret', credits: { balance: 'private' } } }),
    [{ id: 'codex', name: null, primary, secondary: null }]);
  const multiple = quotaBuckets({ rateLimits: bucket, rateLimitsByLimitId: {
    codex: bucket, extra: { limitName: 'Other limit', primary: { ...primary, windowDurationMins: 60, usedPercent: 42 } },
  } });
  assert.equal(multiple.length, 2);
  assert.equal(multiple[1].id, 'extra');
  assert.equal(multiple[1].primary.windowDurationMins, 60);
  assert.deepEqual(quotaBuckets({ rateLimits: bucket, rateLimitsByLimitId: {} }), []);
  assert.deepEqual(quotaBuckets(null), []);
  assert.deepEqual(quotaWindow({ usedPercent: '0', windowDurationMins: -1, resetsAt: 0 }),
    { usedPercent: null, windowDurationMins: null, resetsAt: null });
  assert.equal(quotaWindow({ usedPercent: -1 }).usedPercent, null);
  assert.equal(quotaWindow({ usedPercent: Infinity }).usedPercent, null);
  assert.equal(quotaWindow({ resetsAt: Number.MAX_SAFE_INTEGER }).resetsAt, null);
});

test('Codex observes extension quota reads and notifications; delayed reads cannot replace notifications', () => {
  const { proxy, events, tick } = observer();
  proxy.client({ id: 1, method: 'account/rateLimits/read' });
  tick();
  proxy.server({ method: 'account/rateLimits/updated', params: { rateLimits: { ...bucket, primary: { ...primary, usedPercent: 80 } } } });
  tick();
  proxy.server({ id: 1, result: { rateLimits: bucket } });
  assert.equal(events.length, 1);
  assert.equal(events[0].buckets[0].primary.usedPercent, 80);
  proxy.client({ id: 2, method: 'account/rateLimits/read' });
  proxy.client({ id: 3, method: 'account/rateLimits/read' });
  proxy.server({ id: 3, result: { rateLimits: bucket } });
  proxy.server({ id: 2, result: { rateLimits: { ...bucket, primary: { ...primary, usedPercent: 10 } } } });
  assert.equal(events.length, 2);
  assert.equal(events[1].complete, true);
  proxy.client({ id: 4, method: 'account/rateLimits/read' });
  proxy.server({ id: 4, error: { message: 'private account detail' } });
  assert.equal(events.length, 2);
  assert.equal(events.at(-1).buckets[0].primary.usedPercent, 25);
  assert.doesNotMatch(JSON.stringify(events), /private account detail/);
});

test('Codex account observation never copies credentials, emails or full auth responses', () => {
  const { proxy, events, tick } = observer();
  proxy.client({ id: 1, method: 'account/login/start', params: { accessToken: 'ACCESS_SECRET', chatgptAccountId: 'private-id', apiKey: 'KEY_SECRET' } });
  proxy.server({ id: 1, result: { authUrl: 'AUTH_SECRET', token: 'TOKEN_SECRET' } });
  proxy.client({ id: 2, method: 'account/read' });
  tick();
  proxy.server({ id: 2, result: { account: { type: 'chatgpt', email: 'private@example.com', planType: 'plus', token: 'TOKEN_SECRET' } } });
  assert.match(events.at(-1).accountKey, /^[a-f0-9]{64}$/);
  proxy.client({ id: 3, method: 'account/rateLimits/read' });
  proxy.server({ id: 3, result: { rateLimits: { ...bucket, credits: { balance: 'BALANCE_SECRET' } }, rateLimitResetCredits: { credits: [{ id: 'CREDIT_SECRET' }] } } });
  proxy.server({ id: 999, result: { account: { token: 'UNREQUESTED_SECRET' } } });
  proxy.server({ method: 'account/chatgptAuthTokens/refresh', id: 5, params: { accessToken: 'REFRESH_SECRET' } });
  assert.doesNotMatch(JSON.stringify(events), /SECRET|private@example|private-id|planType|authUrl|accessToken/);
  assert.doesNotMatch(JSON.stringify([...proxy.requests.values()]), /SECRET/);
});

test('account changes and logout invalidate quota requests and stale account reads in the proxy', () => {
  const { proxy, events, tick } = observer();
  proxy.client({ id: 1, method: 'account/rateLimits/read' });
  proxy.client({ id: 2, method: 'account/read' });
  tick();
  proxy.server({ method: 'account/updated', params: { authMode: null, token: 'secret' } });
  proxy.server({ id: 1, result: { rateLimits: bucket } });
  proxy.server({ id: 2, result: { account: { type: 'chatgpt', email: 'old@example.com' } } });
  assert.equal(events.length, 1);
  assert.equal(events[0].authMode, null);
  proxy.client({ id: 3, method: 'account/rateLimits/read' });
  tick();
  proxy.client({ id: 4, method: 'account/logout' });
  proxy.server({ id: 3, result: { rateLimits: bucket } });
  assert.equal(events.at(-1).type, 'codex-account');
  assert.equal(events.length, 2);
});

test('initial concurrent identity and quota reads reach the tracker, and stable identity reads keep usage', () => {
  const { proxy, events, tick } = observer();
  const tracker = new CodexUsageTracker();
  proxy.client({ id: 1, method: 'account/read' });
  tick();
  proxy.client({ id: 2, method: 'account/rateLimits/read' });
  tick();
  proxy.server({ id: 1, result: { account: { type: 'chatgpt', email: 'user@example.com' } } });
  proxy.server({ id: 2, result: { rateLimits: bucket } });
  for (const event of events) tracker.take('tab', '1', event, NOW + 2);
  assert.equal(tracker.view(NOW + 2).windows[0].percent, 25);
  tick();
  proxy.client({ id: 3, method: 'account/read' });
  proxy.server({ id: 3, result: { account: { type: 'chatgpt', email: 'user@example.com' } } });
  tracker.take('tab', '1', events.at(-1), NOW + 3);
  assert.equal(tracker.view(NOW + 3).windows[0].percent, 25);
});

test('concurrent tabs replace account-wide Codex quotas instead of summing; older responses are ignored', () => {
  const tracker = new CodexUsageTracker();
  assert.equal(tracker.view(NOW).status, 'Waiting for usage');
  tracker.take('a', '1', usage(), NOW);
  tracker.take('b', '2', usage(NOW + 20), NOW + 20);
  assert.equal(tracker.view(NOW + 20).windows[0].percent, 25);
  assert.equal(tracker.take('a', '1', usage(NOW + 10, 2), NOW + 30), false);
  assert.equal(tracker.take('b', '2', usage(NOW + 30, 0), NOW + 30), false);
  assert.equal(tracker.take('a', null, usage(), NOW), false);
  assert.equal(tracker.view(NOW + 30).windows[0].percent, 25);
});

test('absent Codex windows are omitted; invalid, stale and expired values stay unknown', () => {
  const tracker = new CodexUsageTracker();
  tracker.take('a', '1', usage(), NOW);
  const [first] = tracker.view(NOW).windows;
  assert.deepEqual([first.label, first.percent, first.level], ['15 min', 25, 'ok']);
  assert.match(first.title, /25% used\nResets .*\nReceived/);
  // A 15-minute window that resets in an hour: where it started is not known.
  assert.equal(first.pace, null);
  assert.equal(tracker.view(NOW).windows.length, 1);
  assert.match(tracker.view(NOW).received, /^Received /);
  assert.equal(tracker.view(NOW + STALE_AFTER).windows[0].percent, null);
  assert.equal(tracker.view(NOW + STALE_AFTER).windows[0].detail, 'Stale usage');
  tracker.take('a', '1', usage(RESET * 1000 - 1, 2), RESET * 1000 - 1);
  assert.equal(tracker.view(RESET * 1000).windows[0].percent, null);
  assert.equal(tracker.view(RESET * 1000).windows[0].detail, 'Waiting for refresh');
  tracker.take('a', '1', usage(RESET * 1000 + 1, 3, { buckets: [{ id: 'codex', primary: { usedPercent: 0 }, secondary: null }] }), RESET * 1000 + 1);
  assert.equal(tracker.view(RESET * 1000 + 1).windows[0].percent, null);
});

test('Codex uses reported durations, warning/full states and independent buckets; a full read removes absent buckets', () => {
  const tracker = new CodexUsageTracker();
  const buckets = quotaBuckets({ rateLimitsByLimitId: {
    codex: { primary: { ...primary, usedPercent: 80, windowDurationMins: 300 }, secondary: { ...primary, usedPercent: 100, windowDurationMins: 10080 } },
    other: { limitName: 'Other quota', primary: { ...primary, usedPercent: 103, windowDurationMins: 90 } },
  } });
  tracker.take('a', '1', usage(NOW, 1, { buckets }), NOW);
  const view = tracker.view(NOW);
  assert.deepEqual(view.windows.slice(0, 3).map((w) => [w.label, w.percent, w.level]), [['5 hours', 80, 'warn'], ['Week', 100, 'over'], ['90 min', 103, 'over']]);
  assert.equal(view.windows[2].bucket, 'Other quota');
  // Each resets in an hour: how much of its reported length has passed.
  assert.deepEqual(view.windows.slice(0, 3).map((w) => w.pace), [80, 99.4, 33.3]);
  assert.match(view.windows[0].title, /80% used\nEven pace: 80% by now\nResets /);
  assert.equal(tracker.view(NOW + STALE_AFTER).windows[0].pace, null);
  assert.doesNotMatch(tracker.view(NOW + STALE_AFTER).windows[0].title, /Even pace/);
  tracker.take('a', '1', usage(NOW + 1, 2, { complete: false }), NOW + 1);
  assert.equal(tracker.view(NOW + 1).windows.length, 2);
  tracker.take('a', '1', usage(NOW + 2, 3), NOW + 2);
  assert.equal(tracker.view(NOW + 2).windows.length, 1);
  tracker.take('a', '1', usage(NOW + 3, 4, { buckets: [] }), NOW + 3);
  assert.equal(tracker.view(NOW + 3).status, 'Usage unavailable');
});

test('account switching fences other tabs and old requests; API keys and sign-out cannot retain quota', () => {
  const tracker = new CodexUsageTracker();
  tracker.take('a', '1', account(NOW, 1), NOW);
  tracker.take('a', '1', usage(NOW + 1, 2, { accountKey: KEY }), NOW + 1);
  tracker.take('b', '2', account(NOW + 2, 1), NOW + 2);
  assert.equal(tracker.view(NOW + 2).windows[0].percent, 25);
  tracker.take('a', '1', account(NOW + 3, 3, null, null), NOW + 3);
  assert.equal(tracker.view(NOW + 3).status, 'Signed out');
  assert.equal(tracker.take('b', '2', usage(NOW + 4, 2, { accountKey: KEY }), NOW + 4), false);
  assert.equal(tracker.take('c', '3', usage(NOW + 4), NOW + 4), false);
  tracker.take('a', '1', account(NOW + 5, 4, null, 'apikey'), NOW + 5);
  assert.equal(tracker.view(NOW + 5).status, 'Usage unavailable with API key');
  tracker.take('a', '1', account(NOW + 6, 5, OTHER), NOW + 6);
  assert.equal(tracker.take('b', '2', usage(NOW + 4, 3, { accountKey: KEY }), NOW + 7), false);
  tracker.take('a', '1', usage(NOW + 7, 6, { accountKey: OTHER }), NOW + 7);
  assert.equal(tracker.view(NOW + 7).windows[0].percent, 25);
  tracker.clearTab('a');
  assert.equal([...tracker.sources.values()].some((s) => s.tabId === 'a'), false);
  assert.equal(tracker.view(NOW + STALE_AFTER + 7).windows[0].percent, null);
  assert.deepEqual(new CodexUsageTracker().view(NOW).windows, []);
});

test('same-mode account updates keep the display while fencing quota until identity is rechecked', () => {
  const tracker = new CodexUsageTracker();
  tracker.take('a', '1', account(NOW, 1), NOW);
  tracker.take('a', '1', usage(NOW + 1, 2, { accountKey: KEY }), NOW + 1);
  tracker.take('a', '1', account(NOW + 2, 3, null), NOW + 2);
  assert.equal(tracker.view(NOW + 2).windows[0].percent, 25);
  assert.equal(tracker.take('new', '2', usage(NOW + 3), NOW + 3), false);
  assert.equal(tracker.take('a', '1', usage(NOW + 3, 4), NOW + 3), false);
  assert.equal(tracker.view(NOW + 3).windows[0].percent, 25);
  tracker.take('refresh', '3', account(NOW + 4, 1), NOW + 4);
  assert.equal(tracker.view(NOW + 4).windows[0].percent, 25);
  tracker.take('refresh', '3', usage(NOW + 5, 2, { accountKey: KEY,
    buckets: quotaBuckets({ rateLimits: { ...bucket, primary: { ...primary, usedPercent: 40 } } }) }), NOW + 5);
  assert.equal(tracker.view(NOW + 5).windows[0].percent, 40);
  assert.equal(tracker.take('a', '1', usage(NOW + 6, 5, { accountKey: KEY }), NOW + 6), false);
});

test('identity rechecks clear the previous snapshot on a different account or sign-out', () => {
  for (const [key, mode] of [[OTHER, 'chatgpt'], [null, null], [null, 'changing'], [null, 'apikey']]) {
    const tracker = new CodexUsageTracker();
    tracker.take('a', '1', account(NOW, 1), NOW);
    tracker.take('a', '1', usage(NOW + 1, 2, { accountKey: KEY }), NOW + 1);
    tracker.take('a', '1', account(NOW + 2, 3, null), NOW + 2);
    assert.equal(tracker.view(NOW + 2).windows[0].percent, 25);
    tracker.take('refresh', '2', account(NOW + 3, 1, key, mode), NOW + 3);
    assert.deepEqual(tracker.view(NOW + 3).windows, []);
    assert.equal(tracker.take('a', '1', usage(NOW + 4, 4, { accountKey: KEY }), NOW + 4), false);
  }
});

test('failed refreshes keep the last Codex snapshot without extending its freshness', () => {
  const { proxy, events, tick } = observer();
  const tracker = new CodexUsageTracker();
  proxy.client({ id: 1, method: 'account/read' });
  proxy.server({ id: 1, result: { account: { type: 'chatgpt', email: 'user@example.com' } } });
  proxy.server({ method: 'account/rateLimits/updated', params: { rateLimits: bucket } });
  for (const event of events) tracker.take('a', '1', event, NOW);
  tick();
  proxy.server({ method: 'account/updated', params: { authMode: 'chatgpt' } });
  tracker.take('a', '1', events.at(-1), NOW + 1);
  assert.equal(tracker.view(NOW + 1).windows[0].percent, 25);
  const count = events.length;
  proxy.client({ id: 2, method: 'account/read' });
  proxy.server({ id: 2, error: { message: 'failed identity read' } });
  proxy.client({ id: 3, method: 'account/rateLimits/read' });
  proxy.server({ id: 3, error: { message: 'failed quota read' } });
  assert.equal(events.length, count);
  assert.equal(tracker.view(NOW + 2).windows[0].percent, 25);
  assert.equal(tracker.view(NOW + STALE_AFTER).windows[0].percent, null);
});

test('refresh failures remain visible beside stale windows without renewing their receipt time', () => {
  const tracker = new CodexUsageTracker();
  tracker.take('tab', 'proc', account(NOW, 1), NOW);
  tracker.take('tab', 'proc', usage(NOW, 2, { accountKey: KEY }), NOW);
  tracker.refreshStatus = 'Usage unavailable';
  const view = tracker.view(NOW + STALE_AFTER);
  assert.equal(view.status, 'Usage unavailable');
  assert.equal(view.windows[0].percent, null);
  assert.equal(view.windows[0].detail, 'Stale usage');
  assert.match(view.windows[0].title, /Usage unavailable/);
  assert.equal(tracker.latest.receivedAt, NOW);
  assert.equal(tracker.buckets.get('codex').receivedAt, NOW);
});

test('a pending login cannot revive the previous account through new notifications', () => {
  const { proxy, events, tick } = observer();
  const tracker = new CodexUsageTracker();
  proxy.server({ method: 'account/rateLimits/updated', params: { rateLimits: bucket } });
  tracker.take('a', '1', events.at(-1), NOW);
  tick();
  proxy.client({ id: 1, method: 'account/login/start', params: { type: 'chatgpt' } });
  tracker.take('a', '1', events.at(-1), NOW + 1);
  assert.equal(tracker.view(NOW + 1).status, 'Waiting for account');
  tick();
  proxy.server({ method: 'account/rateLimits/updated', params: { rateLimits: bucket } });
  assert.equal(tracker.take('a', '1', events.at(-1), NOW + 2), false);
  assert.deepEqual(tracker.view(NOW + 2).windows, []);
});

test('Codex quota uses the authenticated endpoint and WSL receive path without conversation rows or logs', async (t) => {
  const server = new HookServer();
  await server.listen();
  t.after(() => server.close());
  const events = [], conversations = [], logs = [];
  server.log = (...args) => logs.push(args);
  server.on('codex-usage', (...args) => events.push(args));
  server.on('codex', (...args) => conversations.push(args));
  const event = usage();
  const post = (token) => fetch(new URL('/codex', server.url), {
    method: 'POST', headers: { 'X-Wrapper-Token': token, 'X-Wrapper-Tab': 'tab', 'X-Wrapper-Proc': '123' }, body: JSON.stringify(event),
  });
  assert.equal((await post('wrong')).status, 404);
  assert.equal((await post(server.token)).status, 200);
  server.receive('codex', 'wsl', 'wsl:ubuntu:1', JSON.stringify(event));
  server.receive('codex', 'tab', null, JSON.stringify(event));
  assert.deepEqual(events, [['tab', event, '123'], ['wsl', event, 'wsl:ubuntu:1']]);
  assert.deepEqual(conversations, []);
  assert.deepEqual(logs, []);
});
