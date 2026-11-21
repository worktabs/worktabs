const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { coalesce, progressReporter, keepPage, mapLimit, oneLine, samePath, sleep } = require('../src/util');

test('oneLine joins the lines of a message or an error', () => {
  assert.equal(oneLine('fatal: one\n  two\r\nthree'), 'fatal: one two three');
  assert.equal(oneLine(new Error('a\nb')), 'a b');
  assert.equal(oneLine(''), '');
  assert.equal(oneLine(null), 'null');
});

test('samePath compares resolved folders ignoring case', () => {
  const base = path.resolve('Some', 'Folder');
  assert.equal(samePath(base, path.join(base.toLowerCase(), '.')), true);
  assert.equal(samePath(base, path.join(base, 'x', '..')), true);
  assert.equal(samePath(base, path.join(base, 'other')), false);
});

test('samePath ignores case and trailing separators', () => {
  assert.ok(samePath('/Repos/Worktabs/', '/repos/worktabs'));
  assert.ok(!samePath('/repos/worktabs', '/repos/worktabs-feat'));
});

test('sleep resolves after the time', async () => {
  const start = Date.now();
  await sleep(20);
  assert.ok(Date.now() - start >= 15);
});

test('keepPage keeps a page from navigating or opening windows', () => {
  const handlers = {};
  let openHandler;
  keepPage({ on: (name, handler) => (handlers[name] = handler), setWindowOpenHandler: (handler) => (openHandler = handler) });
  let prevented = false;
  handlers['will-navigate']({ preventDefault: () => (prevented = true) }, 'https://evil.example/');
  assert.equal(prevented, true);
  assert.deepEqual(openHandler({ url: 'https://evil.example/' }), { action: 'deny' });
});

test('coalesce runs once on the next turn for a burst of calls, and again for a later one', () => {
  const turns = [];
  let runs = 0;
  const run = coalesce(() => runs++, (fn) => turns.push(fn));
  run();
  run();
  run();
  assert.equal(runs, 0);
  assert.equal(turns.length, 1);
  turns.shift()();
  assert.equal(runs, 1);
  run();
  assert.equal(turns.length, 1);
  turns.shift()();
  assert.equal(runs, 2);
});

test('mapLimit runs at most limit at once and keeps the order of the items', async () => {
  let running = 0, most = 0;
  const results = await mapLimit([30, 10, 20, 0, 5], 2, async (ms, index) => {
    running++;
    most = Math.max(most, running);
    await sleep(ms);
    running--;
    return `${index}:${ms}`;
  });
  assert.deepEqual(results, ['0:30', '1:10', '2:20', '3:0', '4:5']);
  assert.equal(most, 2);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test('progressReporter reports a download at most once a second, with the part done when its size is known', () => {
  let at = 0;
  const shown = [];
  const progress = progressReporter((size, fraction) => shown.push([size, fraction]), { now: () => at });
  at = 1000;
  progress(10, 100);
  at = 1500;
  progress(20, 100);
  at = 2000;
  progress(30, 100);
  at = 3000;
  progress(40, 0);
  assert.deepEqual(shown, [['10 / 100 MB', 0.1], ['30 / 100 MB', 0.3], ['40 MB', null]]);
});

test('progressReporter reports the end of a download at once, and once', () => {
  let at = 1000;
  const shown = [];
  const progress = progressReporter((size, fraction) => shown.push([size, fraction]), { now: () => at });
  progress(99, 100);
  at = 1001;
  progress(100, 100);
  progress(100, 100);
  assert.deepEqual(shown, [['99 / 100 MB', 0.99], ['100 / 100 MB', 1]]);

  // What follows the download reports nothing: `finished` says that instead.
  const finished = [];
  const ended = progressReporter((size, fraction) => shown.push([size, fraction]), { now: () => at, finished: (size) => finished.push(size) });
  ended(236, 236);
  ended(236, 236);
  assert.deepEqual(finished, ['236 / 236 MB']);
  assert.equal(shown.length, 2);
});
