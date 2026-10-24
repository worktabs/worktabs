const assert = require('node:assert/strict');
const test = require('node:test');
const { waitInPage } = require('../src/conversations/page-wait');

// Runs waitInPage in a page with a MutationObserver that `change()` calls back.
function inPage(check, done, wait) {
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { assert.deepEqual({ ...options }, { childList: true, subtree: true, attributes: true }); this.target = target; }
    disconnect() { observers.splice(observers.indexOf(this), 1); }
  }
  const result = waitInPage(check, done, wait, { document: {}, MutationObserver, setTimeout, clearTimeout, setInterval, clearInterval });
  return { result, observers, change: () => [...observers].forEach((observer) => observer.callback([])) };
}

test('what is there already resolves at once, and the page is no longer watched', async () => {
  const page = inPage(() => 'ready', (value) => value === 'ready', 5000);
  assert.equal(await page.result, 'ready');
  assert.equal(page.observers.length, 0);
});

test('a change of the page is checked a moment later, once for many changes', async () => {
  let checks = 0;
  let ready = false;
  const page = inPage(() => { checks++; return ready; }, Boolean, 5000);
  ready = true;
  page.change();
  page.change();
  page.change();
  assert.equal(await page.result, true);
  assert.equal(checks, 2, 'the first check, and one for the changes');
});

test('the page is checked every second without changes, and the last result comes after the wait', async () => {
  let checks = 0;
  const started = Date.now();
  assert.equal(await inPage(() => ++checks, () => false, 1200).result, 2);
  assert.ok(Date.now() - started >= 1150);
});

test('a check that throws counts as no result', async () => {
  let checks = 0;
  const page = inPage(() => { if (++checks === 1) throw new Error('Not yet'); return 'ready'; }, (value) => value === 'ready', 5000);
  page.change();
  assert.equal(await page.result, 'ready');
  assert.equal(await inPage(() => { throw new Error('Never'); }, Boolean, 20).result, null);
});
