const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { setLanguage } = require('../src/i18n');
const { UsageTracker, spendView, usageView, windowsOf } = require('../src/agents/usage');
const { tempDir } = require('./support');

// Local times, so the tests hold in any time zone.
const NOW = new Date(2026, 8, 29, 13, 20).getTime();
const seconds = (date) => Math.floor(date.getTime() / 1000);
const FIVE_HOUR_RESET = seconds(new Date(2026, 8, 29, 15, 0));
const WEEK_RESET = seconds(new Date(2026, 9, 3, 9, 0));

// A rate_limit_event as claude writes it to its stream-json output (2.1.283).
function event(unifiedWindows) {
  return {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', resetsAt: FIVE_HOUR_RESET, rateLimitType: 'five_hour', utilization: 0.42, unifiedWindows },
    uuid: 'u1',
    session_id: 's1',
  };
}

const BOTH = {
  five_hour: { utilization: 0.42, resetsAt: FIVE_HOUR_RESET },
  seven_day: { utilization: 0.18, resetsAt: WEEK_RESET },
};

test('Claude provider stays visible before data, after reset and with stale values', (t) => {
  const tracker = new UsageTracker(path.join(tempDir(t), 'usage.json'));
  assert.deepEqual(tracker.providerView(NOW), { windows: [], status: 'Waiting for usage' });
  tracker.refresh({ windows: BOTH }, NOW, NOW);
  assert.deepEqual(tracker.providerView(NOW).windows.map((window) => window.percent), [42, 18]);
  const stale = tracker.providerView(NOW + 15 * 60000);
  assert.ok(stale.windows.every((window) => window.percent === null && window.detail === 'Stale usage'));
  tracker.expire(WEEK_RESET * 1000);
  assert.deepEqual(tracker.providerView(WEEK_RESET * 1000), { windows: [], status: 'Waiting for refresh' });
  // A read that worked but found no window is not a failed one.
  tracker.refresh({ windows: {} }, WEEK_RESET * 1000);
  assert.equal(tracker.providerView().status, 'No 5-hour or weekly limit');
});

test('a delayed startup quota read cannot overwrite a newer live Claude event', (t) => {
  const tracker = new UsageTracker(path.join(tempDir(t), 'usage.json'));
  tracker.take(event(BOTH), NOW + 1000);
  tracker.refresh({ windows: { five_hour: { utilization: 0.01, resetsAt: FIVE_HOUR_RESET } } }, NOW, NOW + 2000);
  assert.deepEqual(tracker.view(NOW + 2000).map((window) => window.percent), [42, 18]);
  tracker.refresh({ windows: { five_hour: { utilization: 0.5, resetsAt: FIVE_HOUR_RESET } } }, NOW + 3000, NOW + 4000);
  assert.deepEqual(tracker.view(NOW + 4000).map((window) => window.percent), [50]);
});

test('windowsOf takes the 5-hour and weekly windows of a rate_limit_event', () => {
  assert.deepEqual(windowsOf(event({ ...BOTH, seven_day_overage_included: { utilization: 0.5, resetsAt: WEEK_RESET } })), BOTH);
  assert.deepEqual(windowsOf(event({ five_hour: { utilization: 0.42 } })), {});
  assert.deepEqual(windowsOf(event(undefined)), {});
  assert.deepEqual(windowsOf({ type: 'result', rate_limit_info: { unifiedWindows: BOTH } }), {});
  assert.deepEqual(windowsOf(null), {});
});

test('usageView shows each window with its share and reset, orange from 80% and red at the cap', (t) => {
  const at = new Date(2026, 8, 29, 13, 5).getTime();
  const windows = {
    five_hour: { utilization: 0.84, resetsAt: FIVE_HOUR_RESET, at },
    seven_day: { utilization: 0.18, resetsAt: WEEK_RESET, at },
  };
  assert.deepEqual(usageView(windows, NOW), [
    {
      key: 'five_hour',
      label: '5 hours',
      percent: 84,
      level: 'warn',
      resets: 'Resets 15:00',
      resetTime: '15:00',
      received: 'Received 13:05',
      title: '5-hour limit: 84% used\nResets 15:00\nReceived 13:05',
    },
    {
      key: 'seven_day',
      label: 'Week',
      percent: 18,
      level: 'ok',
      resets: 'Resets 10/3 9:00',
      resetTime: '10/3 9:00',
      received: 'Received 13:05',
      title: 'Weekly limit: 18% used\nResets 10/3 (Sat) 9:00\nReceived 13:05',
    },
  ]);
  setLanguage('ja');
  t.after(() => setLanguage('en'));
  const [, week] = usageView(windows, NOW);
  assert.deepEqual([week.label, week.resets, week.title], ['週', '10/3 9:00 にリセット', '週の枠: 18% 使用\n10/3（土）9:00 にリセット\n13:05 に受け取った値']);
  setLanguage('en');
  const over = usageView({ five_hour: { utilization: 1.03, resetsAt: FIVE_HOUR_RESET, at } }, NOW);
  assert.deepEqual([over[0].percent, over[0].level], [103, 'over']);
});

test('usageView leaves out the windows that have reset', () => {
  const windows = { five_hour: { utilization: 0.9, resetsAt: FIVE_HOUR_RESET, at: NOW }, seven_day: { utilization: 0.2, resetsAt: WEEK_RESET, at: NOW } };
  assert.deepEqual(usageView(windows, FIVE_HOUR_RESET * 1000).map((w) => w.key), ['seven_day']);
  assert.deepEqual(usageView({}, NOW), []);
});

test('UsageTracker keeps the latest value of each window, also across a restart', (t) => {
  const file = path.join(tempDir(t), 'usage.json');
  const tracker = new UsageTracker(file);
  assert.deepEqual(tracker.view(NOW), []);

  assert.equal(tracker.take(event(BOTH), NOW), true);
  assert.deepEqual(tracker.view(NOW).map((w) => w.percent), [42, 18]);
  // A window the event lacks keeps its value.
  assert.equal(tracker.take(event({ five_hour: { utilization: 0.5, resetsAt: FIVE_HOUR_RESET } }), NOW + 1000), true);
  assert.deepEqual(tracker.view(NOW).map((w) => w.percent), [50, 18]);
  // Nothing to take.
  assert.equal(tracker.take(event({}), NOW), false);
  assert.equal(tracker.take({ type: 'assistant' }), false);

  const restarted = new UsageTracker(file);
  assert.deepEqual(restarted.windows, {
    five_hour: { utilization: 0.5, resetsAt: FIVE_HOUR_RESET, at: NOW + 1000 },
    seven_day: { utilization: 0.18, resetsAt: WEEK_RESET, at: NOW },
  });
});

test('UsageTracker forgets the windows that have reset', (t) => {
  const file = path.join(tempDir(t), 'usage.json');
  const tracker = new UsageTracker(file);
  tracker.take(event(BOTH), NOW);
  assert.equal(tracker.expire(NOW), false);
  assert.equal(tracker.expire(FIVE_HOUR_RESET * 1000), true);
  assert.deepEqual(Object.keys(tracker.windows), ['seven_day']);
  assert.deepEqual(Object.keys(new UsageTracker(file).windows), ['seven_day']);
});

test('UsageTracker starts empty from a missing or broken file', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(new UsageTracker(path.join(dir, 'none.json')).windows, {});
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{"windows": {"five_hour": {"utilization": "a lot"}}}');
  assert.deepEqual(new UsageTracker(broken).windows, {});
  fs.writeFileSync(broken, 'not json');
  assert.deepEqual(new UsageTracker(broken).windows, {});
});

// The monthly spend limit of a Claude Enterprise account (USD 0.09 used of USD 100.00), as
// readUsage projects it (claudeSpend in usage-refresh.js).
const SPEND = { used: 9, limit: 10000, places: 2, currency: 'USD', reached: false };

test('a read with only a monthly spend limit shows a Month row, with the amounts where a reset time goes', (t) => {
  const tracker = new UsageTracker(path.join(tempDir(t), 'usage.json'));
  tracker.refresh({ windows: {}, spend: SPEND }, NOW, NOW);
  assert.deepEqual(tracker.providerView(NOW), {
    windows: [{
      key: 'spend',
      label: 'Month',
      percent: 0,
      level: 'ok',
      resets: '',
      resetTime: '',
      detail: '$0.09 / $100',
      received: 'Received 13:20',
      title: 'Monthly spend: $0.09 of $100.00 used\nReceived 13:20',
    }],
    status: '',
  });
  setLanguage('ja');
  t.after(() => setLanguage('en'));
  const [ja] = tracker.providerView(NOW).windows;
  assert.deepEqual([ja.label, ja.detail, ja.title], ['月', '$0.09 / $100', '月の利用額: $100.00 のうち $0.09 使用\n13:20 に受け取った値']);
  setLanguage('en');
  // The windows come first, as before.
  tracker.refresh({ windows: BOTH, spend: SPEND }, NOW + 1, NOW + 1);
  assert.deepEqual(tracker.view(NOW + 1).map((row) => row.key), ['five_hour', 'seven_day', 'spend']);
});

test('the Month row is orange from 80% and red at the cap or when the account says the limit is reached', () => {
  const level = (spend) => spendView({ ...SPEND, ...spend, at: NOW }, NOW)[0];
  assert.deepEqual([level({ used: 7999 }).level, level({ used: 8000 }).level, level({ used: 10000 }).level], ['ok', 'warn', 'over']);
  assert.deepEqual([level({ used: 10350 }).percent, level({ used: 10350 }).detail], [104, '$103.50 / $100']);
  assert.equal(level({ used: 500, reached: true }).level, 'over');
  // Without a currency, the amounts are numbers.
  assert.equal(level({ currency: null }).detail, '0.09 / 100');
  assert.match(level({ used: 0, limit: 5000, places: 0, currency: 'JPY' }).detail, /^[¥￥]0 \/ [¥￥]5,000$/);
  assert.deepEqual(spendView(null, NOW), []);
});

test('the monthly spend limit is kept across a restart and a live event, and turns stale after 15 minutes', (t) => {
  const file = path.join(tempDir(t), 'usage.json');
  const tracker = new UsageTracker(file);
  tracker.refresh({ windows: {}, spend: SPEND }, NOW, NOW);
  assert.deepEqual(new UsageTracker(file).spend, { ...SPEND, at: NOW });
  // A rate_limit_event carries no spend limit: it leaves the row as it is.
  tracker.take(event(BOTH), NOW + 1000);
  assert.deepEqual(tracker.view(NOW + 1000).map((row) => row.key), ['five_hour', 'seven_day', 'spend']);
  // A read that started before that event cannot replace its windows, but its spend limit is newer than any.
  tracker.refresh({ windows: {}, spend: { ...SPEND, used: 500 } }, NOW + 500, NOW + 2000);
  assert.deepEqual(tracker.view(NOW + 2000).map((row) => row.percent), [42, 18, 5]);
  assert.equal(tracker.spend.at, NOW + 2000);

  const stale = tracker.providerView(NOW + 2000 + 15 * 60000).windows.at(-1);
  assert.deepEqual([stale.percent, stale.level, stale.detail, stale.title], [null, 'unknown', 'Stale usage', 'Stale usage\nReceived 13:20']);
  assert.equal(tracker.providerView(NOW + 2000 + 15 * 60000 - 1).windows.at(-1).percent, 5);
  // It never resets.
  assert.equal(tracker.expire(WEEK_RESET * 1000 + 86400000), true);
  assert.deepEqual(tracker.view(WEEK_RESET * 1000 + 86400000).map((row) => row.key), ['spend']);

  // A read without one takes it away.
  tracker.refresh({ windows: {} }, NOW + 3000, NOW + 3000);
  assert.equal(tracker.spend, null);
  assert.equal(new UsageTracker(file).spend, null);
  assert.equal(tracker.providerView(NOW + 3000).status, 'No 5-hour or weekly limit');
});

test('an account without any limit keeps saying so while the next read runs', (t) => {
  const tracker = new UsageTracker(path.join(tempDir(t), 'usage.json'));
  tracker.refreshing();
  assert.equal(tracker.providerView(NOW).status, 'Waiting for refresh');
  tracker.refresh({ windows: {} }, NOW, NOW);
  tracker.refreshing();
  assert.equal(tracker.providerView(NOW).status, 'No 5-hour or weekly limit');
  tracker.status = 'Usage unavailable';
  tracker.refreshing();
  assert.equal(tracker.providerView(NOW).status, 'Waiting for refresh');
});

test('UsageTracker ignores a spend limit in the file that it cannot read', (t) => {
  const file = path.join(tempDir(t), 'usage.json');
  for (const spend of [{ ...SPEND }, { ...SPEND, at: NOW, used: '9' }, { ...SPEND, at: NOW, limit: 0 }, { ...SPEND, at: NOW, currency: 'usd' }, { ...SPEND, at: NOW, places: 9 }]) {
    fs.writeFileSync(file, JSON.stringify({ windows: {}, spend }));
    assert.equal(new UsageTracker(file).spend, null);
  }
  fs.writeFileSync(file, 'null');
  assert.deepEqual(new UsageTracker(file).windows, {});
});
