const assert = require('node:assert/strict');
const test = require('node:test');
const { createCloseGuard } = require('../src/window/window-close');

function setup({ risks = [], response = 0 } = {}) {
  const calls = [];
  const asked = [];
  let release;
  const guard = createCloseGuard({
    cancelDialogs: () => calls.push('cancel'),
    risks: async () => risks,
    messageBox: (options) => { asked.push(options); return new Promise((resolve) => { release = () => resolve({ response }); }); },
    beforeClose: async () => calls.push('before'),
    close: () => calls.push('close'),
    canceled: () => calls.push('canceled'),
  });
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  return { guard, calls, asked, event, release: () => release() };
}

test('with nothing to lose the window closes after saving', async () => {
  const { guard, calls, asked, event } = setup();
  const first = event();
  await guard.onClose(first);
  assert.equal(first.prevented, true);
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, ['cancel', 'before', 'close']);
  // The close that follows goes through.
  const again = event();
  await guard.onClose(again);
  assert.equal(again.prevented, false);
});

test('it asks first, and canceling keeps the window', async () => {
  const { guard, calls, asked, event, release } = setup({ risks: ['A turn is working'], response: 1 });
  const closing = guard.onClose(event());
  await new Promise(setImmediate);
  assert.equal(asked[0].detail, 'A turn is working');
  assert.equal(asked[0].cancelId, 1);
  // Closing again while it asks does nothing.
  const again = event();
  await guard.onClose(again);
  assert.equal(again.prevented, true);
  assert.equal(asked.length, 1);
  release();
  await closing;
  assert.deepEqual(calls, ['cancel', 'canceled']);
});

test('quitting from the question closes the window', async () => {
  const { guard, calls, event, release } = setup({ risks: ['A turn is working'], response: 0 });
  const closing = guard.onClose(event());
  await new Promise(setImmediate);
  release();
  await closing;
  assert.deepEqual(calls, ['cancel', 'before', 'close']);
});
