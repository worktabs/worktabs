const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const path = require('node:path');
const { readUsage, claudeSpend, claudeWindows } = require('../src/agents/usage-refresh');
const { CodexUsageTracker } = require('../src/codex/codex-usage');
const { UsagePolling } = require('../src/agents/usage-polling');
const { UsageTracker } = require('../src/agents/usage');
const { tempDir } = require('./support');

const NOW = Date.UTC(2026, 9, 10, 7);
const RESET = NOW / 1000 + 3600;

// Mimic the actual JSONL/control protocols, including fragmented output and private fields.
function connection(agent, respond) {
  const sent = [];
  let args, options, killed = false;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { killed = true; };
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const message = JSON.parse(chunk.toString());
    sent.push(message);
    queueMicrotask(() => {
      const response = respond(message);
      if (!response) return;
      const line = Buffer.from(`${JSON.stringify(response)}\n`);
      child.stdout.write(line.subarray(0, 7));
      child.stdout.write(line.subarray(7));
    });
    callback();
  } });
  const read = (extra = {}) => readUsage(agent, {
    now: () => NOW, resolve: async () => '/bundled/cli',
    launch: (binary, argv, opts) => { assert.equal(binary, '/bundled/cli'); args = argv; options = opts; return child; },
    timeout: 100, ...extra,
  });
  return { read, sent, child, get args() { return args; }, get options() { return options; }, get killed() { return killed; } };
}

test('Codex quota read initializes then reads identity and limits, without starting a turn', async () => {
  const fixture = connection('codex', (request) => {
    if (request.id === 'init') return { id: 'init', result: { userAgent: 'cli' } };
    if (request.id === 'account') return { id: 'account', result: { account: { type: 'chatgpt', email: 'private@example.test', token: 'secret' } } };
    if (request.id === 'quota') return { id: 'quota', result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: RESET }, credits: { balance: 'private' } } } };
  });
  const result = await fixture.read();
  assert.deepEqual(fixture.sent.map((message) => message.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.deepEqual(fixture.args, ['app-server']);
  assert.equal(fixture.options.windowsHide, true);
  assert.equal(fixture.killed, true);
  assert.equal(result.events[1].buckets[0].primary.usedPercent, 12);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|email|token|credits/);
});

test('the quota-only protocol read reaches the footer through polling and tracker acceptance', async () => {
  const fixture = connection('codex', (request) => {
    if (request.method === 'initialized') return null;
    return { id: request.id, result: request.id === 'account' ? { account: { type: 'chatgpt', email: 'private@example.test' } }
      : request.id === 'quota' ? { rateLimits: { secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: RESET } } } : {} };
  });
  const codexUsage = new CodexUsageTracker(), logs = [];
  const polling = new UsagePolling({ codexUsage, usage: {}, enabled: () => ['codex'], options: () => ({}),
    now: () => NOW, changed: () => {}, log: (record) => logs.push(record), read: (_agent, options) => fixture.read(options) });
  await polling.refresh('codex');
  assert.equal(codexUsage.view(NOW).windows[0].percent, 1);
  assert.equal(logs.at(-1).outcome, 'success');
  assert.equal(logs.at(-1).acceptedQuota, 1);
  assert.equal(fixture.killed, true);
  assert.doesNotMatch(JSON.stringify(logs), /private|email|accountKey/);
});

test('Codex signed-out and API-key accounts do not issue a quota read', async () => {
  for (const account of [null, { type: 'apiKey' }]) {
    const fixture = connection('codex', (request) => ({ id: request.id, result: request.id === 'account' ? { account } : {} }));
    const result = await fixture.read();
    assert.equal(result.events[0].authMode, account ? 'apikey' : null);
    assert.equal(fixture.sent.some((message) => message.method === 'account/rateLimits/read'), false);
  }
});

test('a failed Codex quota read still reports the account boundary', async () => {
  const fixture = connection('codex', (request) => request.id === 'quota' ? { id: 'quota', error: { message: 'private failure' } }
    : { id: request.id, result: request.id === 'account' ? { account: { type: 'chatgpt', email: 'new@example.test' } } : {} });
  const result = await fixture.read();
  assert.equal(result.unavailable, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'codex-account');
  assert.doesNotMatch(JSON.stringify(result), /private|new@example/);
});

test('account notifications during identity or quota reads recheck identity before finishing', async () => {
  for (const stage of ['account', 'quota']) {
    const fixture = connection('codex', (request) => {
      if (request.id === stage) {
        fixture.child.stdout.write(`${JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt' } })}\n`);
      }
      if (request.method === 'initialize') return { id: request.id, result: {} };
      if (request.method === 'account/read') return { id: request.id, result: { account: { type: 'chatgpt', email: request.id === 'account' ? 'old@example.test' : 'new@example.test' } } };
      if (request.method === 'account/rateLimits/read') return { id: request.id, result: { rateLimits: { primary: { usedPercent: request.id === 'quota' ? 99 : 12, resetsAt: RESET } } } };
    });
    const result = await fixture.read();
    assert.equal(result.events.at(-1).buckets[0].primary.usedPercent, 12);
    assert.equal(result.events.at(-1).accountKey, result.events.at(-2).accountKey);
    assert.equal(fixture.sent.filter((message) => message.method === 'account/read').length, 2);
    assert.equal(fixture.killed, true);
  }
});

test('a quota notification superseding the response triggers a new full read', async () => {
  const fixture = connection('codex', (request) => {
    if (request.method === 'initialize') return { id: request.id, result: {} };
    if (request.method === 'account/read') return { id: request.id, result: { account: { type: 'chatgpt', email: 'user@example.test' } } };
    if (request.id === 'quota') fixture.child.stdout.write(`${JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 30, resetsAt: RESET } } } })}\n`);
    if (request.method === 'account/rateLimits/read') return { id: request.id, result: { rateLimits: { primary: { usedPercent: request.id === 'quota' ? 99 : 31, resetsAt: RESET } } } };
  });
  const result = await fixture.read();
  assert.equal(result.events.at(-1).complete, true);
  assert.equal(result.events.at(-1).buckets[0].primary.usedPercent, 31);
  assert.equal(fixture.killed, true);
});

test('repeated account notifications remain bounded by the original deadline', async () => {
  const fixture = connection('codex', (request) => {
    if (request.method === 'initialize') return { id: request.id, result: {} };
    if (request.method === 'account/read') {
      setImmediate(() => fixture.child.stdout.write(`${JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt' } })}\n`));
    }
  });
  await assert.rejects(fixture.read({ timeout: 10 }), { category: 'timeout' });
  assert.equal(fixture.killed, true);
});

test('missing account identity fails without making an anonymous quota read', async () => {
  const fixture = connection('codex', (request) => request.method === 'initialized' ? null : { id: request.id,
    result: request.id === 'account' ? { account: { type: 'chatgpt' } } : {} });
  const result = await fixture.read();
  assert.equal(result.unavailable, true);
  assert.equal(result.category, 'identity-unavailable');
  assert.equal(fixture.sent.some((message) => message.method === 'account/rateLimits/read'), false);
});

test('resolution is bounded and cancellable, and late resolution never starts a helper', async () => {
  for (const cancel of [false, true]) {
    const fixture = connection('codex', () => null);
    let release;
    const controller = new AbortController();
    const pending = fixture.read({ timeout: 5, signal: controller.signal, resolve: () => new Promise((resolve) => { release = resolve; }) });
    await new Promise((resolve) => setImmediate(resolve));
    if (cancel) controller.abort();
    await assert.rejects(pending, { category: cancel ? 'cancelled' : 'timeout' });
    release('/bundled/cli');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.args, undefined);
  }
  const fixture = connection('codex', () => null);
  await assert.rejects(fixture.read({ resolve: async () => { throw new Error('private path and identity'); } }), { category: 'resolution', message: 'Usage unavailable' });
});

test('Claude sends only control requests, disables hooks/tools/MCP and projects used percentages', async () => {
  const fixture = connection('claude', (request) => ({ type: 'control_response', response: {
    subtype: 'success', request_id: request.request_id,
    response: request.request_id === 'quota' ? { rate_limits_available: true, session: 'private', behaviors: ['private'], rate_limits: {
      five_hour: { utilization: 84, resets_at: new Date(RESET * 1000).toISOString(), limit_dollars: 123 },
      seven_day: { utilization: 0, resets_at: new Date((RESET + 86400) * 1000).toISOString() },
    } } : {},
  } }));
  const result = await fixture.read();
  assert.deepEqual(fixture.sent.map((message) => message.type), ['control_request', 'control_request']);
  assert.deepEqual(fixture.sent[1].request, { subtype: 'get_usage', skip_behaviors: true });
  assert.ok(fixture.args.includes('--no-session-persistence'));
  assert.ok(fixture.args.includes('{"disableAllHooks":true}'));
  assert.ok(fixture.args.includes('--strict-mcp-config'));
  assert.ok(fixture.args.includes('--tools'));
  assert.deepEqual(result.windows.five_hour, { utilization: 0.84, resetsAt: RESET });
  assert.equal(result.windows.seven_day.utilization, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|dollars|session|behaviors/);
  assert.equal(fixture.killed, true);
});

test('a Claude Enterprise read has no window but a monthly spend limit, which reaches the footer as a Month row', async (t) => {
  // The get_usage response an Enterprise user shared (issue #51).
  const enterprise = require('./fixtures/claude-usage-enterprise.json');
  const answer = () => connection('claude', (request) => request.request_id === 'quota' ? enterprise
    : { type: 'control_response', response: { subtype: 'success', request_id: 'init', response: {} } });
  const fixture = answer();
  const result = await fixture.read();
  assert.deepEqual(result, { windows: {}, spend: { used: 9, limit: 10000, places: 2, currency: 'USD', reached: false } });
  assert.equal(fixture.killed, true);

  const usage = new UsageTracker(path.join(tempDir(t), 'usage.json')), logs = [];
  const polling = new UsagePolling({ usage, codexUsage: new CodexUsageTracker(), enabled: () => ['claude'], options: () => ({}),
    now: () => NOW, changed: () => {}, log: (record) => logs.push(record), read: (_agent, options) => answer().read(options) });
  await polling.refresh('claude');
  const view = usage.providerView(NOW);
  assert.equal(view.status, '');
  assert.deepEqual(view.windows.map((row) => [row.label, row.percent, row.level, row.detail]), [['Month', 0, 'ok', '$0.09 / $100']]);
  assert.deepEqual([logs.at(-1).outcome, logs.at(-1).category], ['success', 'spend-only']);
});

test('the spend limit comes from spend, or from extra_usage when spend is missing or changed', () => {
  const minor = (amount_minor, exponent = 2, currency = 'USD') => ({ amount_minor, currency, exponent });
  const spend = { used: minor(9), limit: minor(10000), percent: 0, severity: 'normal', enabled: true };
  const extra = { is_enabled: true, monthly_limit: 5000, used_credits: 4500, currency: 'USD', decimal_places: 2, spend_limit_reached: false };
  const read = (limits) => claudeSpend({ rate_limits: limits });
  const usd = (used, limit, reached = false) => ({ used, limit, places: 2, currency: 'USD', reached });
  assert.deepEqual(read({ spend, extra_usage: extra }), usd(9, 10000));
  assert.deepEqual(read({ spend: null, extra_usage: extra }), usd(4500, 5000));
  assert.deepEqual(read({ extra_usage: { ...extra, spend_limit_reached: true } }), usd(4500, 5000, true));
  assert.deepEqual(read({ spend, extra_usage: { ...extra, spend_limit_reached: true } }), usd(9, 10000, true));
  // Fields that have changed shape fall back to extra_usage.
  for (const changed of [{ ...spend, used: 9 }, { ...spend, limit: { amount: 100 } }, { ...spend, enabled: 'yes' },
    { ...spend, used: minor(9, 2, 'EUR') }, { ...spend, used: minor('9') }]) {
    assert.deepEqual(read({ spend: changed, extra_usage: extra }), usd(4500, 5000));
  }
  // Amounts with different places are shown with the larger.
  assert.deepEqual(read({ spend: { ...spend, used: minor(1, 0) } }), usd(100, 10000));
  assert.deepEqual(read({ spend: { ...spend, used: { amount_minor: 9, exponent: 2 }, limit: { amount_minor: 10000, exponent: 2 } } }),
    { used: 9, limit: 10000, places: 2, currency: null, reached: false });
  // No row: turned off, no limit, or nothing that can be read.
  assert.equal(read({ spend: { ...spend, enabled: false }, extra_usage: extra }), null);
  assert.equal(read({ spend: { ...spend, limit: null } }), null);
  assert.equal(read({ spend: { ...spend, limit: minor(0) } }), null);
  assert.equal(read({ extra_usage: { ...extra, is_enabled: false } }), null);
  assert.equal(read({ extra_usage: { ...extra, monthly_limit: null } }), null);
  assert.equal(read({ extra_usage: { ...extra, used_credits: null } }), null);
  assert.equal(read({ extra_usage: { ...extra, decimal_places: undefined } }), null);
  assert.equal(read({ extra_usage: { ...extra, currency: 'dollars' } }), null);
  assert.equal(read({ extra_usage: { ...extra, used_credits: 1.5 } }), null);
  assert.equal(read({}), null);
  assert.equal(claudeSpend(null), null);
});

test('quota projection rejects expired, missing and invalid windows', () => {
  assert.deepEqual(claudeWindows({ rate_limits: {
    five_hour: { utilization: -1, resets_at: new Date(RESET * 1000).toISOString() },
    seven_day: { utilization: 40, resets_at: new Date(NOW).toISOString() },
  } }, NOW), {});
  assert.deepEqual(claudeWindows(null, NOW), {});
});

test('unsupported Claude control API, process failure, timeout and cancellation stop the helper', async () => {
  const unsupported = connection('claude', (request) => ({ type: 'control_response', response: { request_id: request.request_id, subtype: 'error', error: 'secret' } }));
  await assert.rejects(unsupported.read(), /^Error: Usage unavailable$/);
  assert.equal(unsupported.killed, true);
  const stalled = connection('codex', () => null);
  await assert.rejects(stalled.read({ timeout: 5 }), /timed out/);
  assert.equal(stalled.killed, true);
  const failed = connection('codex', () => null);
  const pendingFailure = failed.read();
  await new Promise((resolve) => setImmediate(resolve));
  failed.child.emit('error', new Error('secret'));
  await assert.rejects(pendingFailure, /^Error: Usage unavailable$/);
  const cancelled = connection('claude', () => null);
  const controller = new AbortController();
  const pending = cancelled.read({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(cancelled.killed, true);
});
