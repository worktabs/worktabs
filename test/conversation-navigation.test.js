const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { visibleCodexThread, codexNavigationScript, confirmCodexThread } = require('../src/conversations/conversation-navigation');

// A page's globals for the scripts that wait in it, with a MutationObserver that `change()` calls
// back.
function pageContext(document) {
  let observer = null;
  const page = { document, setTimeout, clearTimeout, setInterval, clearInterval,
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} disconnect() {} },
    change: () => observer?.([]) };
  page.window = page;
  return page;
}

test('navigation identifies the mounted local thread even while permission controls are disabled', async () => {
  const node = { disabled: true, checkVisibility: () => true };
  const props = { hostId: 'local', conversationId: 'thread' };
  const root = { memoizedProps: props, child: { stateNode: node } };
  root.stateNode = { current: root };
  node.__reactFiber$test = { return: root };
  const document = { querySelectorAll: () => [node] };
  assert.equal(visibleCodexThread(document, () => [props]), 'thread');
  assert.equal(await vm.runInNewContext(codexNavigationScript('thread'), pageContext(document)), 'thread');
  for (const invalid of [{ hostId: 'remote', conversationId: 'thread' }, { hostId: 'local', conversationId: null }, {}]) {
    assert.equal(visibleCodexThread(document, () => [invalid]), null);
  }
  node.checkVisibility = () => false;
  assert.equal(visibleCodexThread(document, () => [props]), null);
});

test('the check waits in the page for the requested thread, and gives the one shown after its wait', async () => {
  const props = { hostId: 'local', conversationId: 'previous' };
  const node = { checkVisibility: () => true };
  const root = { memoizedProps: props, child: { stateNode: node } };
  root.stateNode = { current: root };
  node.__reactFiber$test = { return: root };
  const document = { querySelectorAll: () => [node] };
  const page = pageContext(document);
  const shown = vm.runInNewContext(codexNavigationScript('thread', 5000), page);
  props.conversationId = 'thread';
  page.change();
  assert.equal(await shown, 'thread');
  props.conversationId = 'previous';
  assert.equal(await vm.runInNewContext(codexNavigationScript('thread', 30), pageContext(document)), 'previous');
});

test('navigation waits for the exact thread instead of accepting another thread or an ambiguous panel', async () => {
  const reads = [['previous'], ['thread', 'thread'], [null], ['thread']];
  assert.equal(await confirmCodexThread({ threadId: 'thread', current: () => true,
    read: async () => reads.shift(), pause: async () => {} }), true);
  assert.equal(reads.length, 0);
});

test('a blank, rejected, or stuck renderer reaches the deadline without marking navigation successful', async () => {
  for (const read of [async () => [null], async () => { throw Error('Gone'); }, () => new Promise(() => {})]) {
    assert.equal(await confirmCodexThread({ threadId: 'thread', current: () => true, read,
      pause: () => new Promise((resolve) => setTimeout(resolve, 1)), timeout: 5 }), false);
  }
});

test('a fresh official webview can finish loading before navigation falls back', async () => {
  let elapsed = 0, timer;
  const confirmed = await confirmCodexThread({ threadId: 'thread', current: () => true,
    read: async () => elapsed >= 7000 ? ['thread'] : [null],
    pause: async () => {
      elapsed += 1000;
      if (timer && elapsed >= timer.delay) timer.callback(timer.value);
    },
    setTimer: (callback, delay, value) => (timer = { callback, delay, value }),
    clearTimer: () => { timer = null; },
  });
  assert.equal(confirmed, true);
  assert.equal(timer, null);
});

test('switching tabs or replacing a reveal ignores late answers and stops polling', async () => {
  let current = true, finish, reads = 0;
  const result = confirmCodexThread({ threadId: 'thread', current: () => current,
    read: () => { reads++; return new Promise((resolve) => { finish = resolve; }); }, pause: async () => {} });
  current = false;
  finish(['thread']);
  assert.equal(await result, false);
  assert.equal(reads, 1);
});
