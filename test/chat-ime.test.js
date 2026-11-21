const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { CHAT_IME_RESYNC, resyncImeOnFocus } = require('../src/conversations/chat-ime');

// A field of the chat's page, with the attributes it has.
function field(tagName, { contentEditable = false, type = undefined, attributes = {} } = {}) {
  const values = new Map(Object.entries(attributes));
  const changes = [];
  return {
    tagName, type, isContentEditable: contentEditable, changes,
    getAttribute: (name) => (values.has(name) ? values.get(name) : null),
    setAttribute: (name, value) => { values.set(name, value); changes.push([name, value]); },
    removeAttribute: (name) => { values.delete(name); changes.push([name, null]); },
  };
}

// A chat frame's window with timers and frames run by hand. `focused`: document.hasFocus().
function chatWindow({ active = field('DIV', { contentEditable: true }), focused = true } = {}) {
  const listeners = {};
  const timers = new Map();
  let frames = [];
  let nextTimer = 1;
  const document = { activeElement: active, hasFocus: () => focused };
  const window = {
    document,
    addEventListener: (type, listener, capture) => {
      assert.equal(capture, true);
      (listeners[type] ||= []).push(listener);
    },
    setTimeout: (fn, ms) => { timers.set(nextTimer, { fn, ms }); return nextTimer++; },
    clearTimeout: (id) => { timers.delete(id); },
    requestAnimationFrame: (fn) => { frames.push(fn); },
  };
  const emit = (type, event = {}) => { for (const listener of listeners[type] || []) listener({ isTrusted: true, ...event }); };
  // Runs the timers due now, then the next frame and what it queued.
  const flush = () => {
    for (;;) {
      const due = [...timers].find(([, timer]) => timer);
      if (due) {
        timers.delete(due[0]);
        due[1].fn();
        continue;
      }
      if (!frames.length) return;
      const current = frames;
      frames = [];
      for (const fn of current) fn();
    }
  };
  return { window, document, emit, flush, timers, listeners, frames: () => frames };
}

test('a field that gets the focus has its autocomplete flag flipped for one frame, then put back', () => {
  const chat = chatWindow();
  assert.equal(resyncImeOnFocus(chat.window), true);
  chat.emit('focus');
  assert.deepEqual([...chat.timers.values()].map((timer) => timer.ms), [100]);
  // The flip waits for the browser to take in the focus.
  assert.deepEqual(chat.document.activeElement.changes, []);
  [...chat.timers.values()][0].fn();
  chat.timers.clear();
  assert.deepEqual(chat.document.activeElement.changes, [['autocomplete', 'off']]);
  // Chromium sends the state at the end of the frame, so the flip stays until after it.
  assert.equal(chat.frames().length, 1);
  chat.flush();
  assert.deepEqual(chat.document.activeElement.changes, [['autocomplete', 'off'], ['autocomplete', null]]);
});

test('a field\'s own autocomplete value is flipped to the other flag and restored', () => {
  for (const [value, flipped] of [['off', 'on'], ['OFF', 'on'], ['on', 'off'], ['nope', 'off']]) {
    const active = field('TEXTAREA', { attributes: { autocomplete: value } });
    const chat = chatWindow({ active });
    resyncImeOnFocus(chat.window);
    chat.emit('focus');
    chat.flush();
    assert.deepEqual(active.changes, [['autocomplete', flipped], ['autocomplete', value]]);
  }
});

test('focus events that come together flip the field once', () => {
  const chat = chatWindow();
  resyncImeOnFocus(chat.window);
  chat.emit('focus');
  chat.emit('focus');
  chat.emit('focus');
  assert.equal(chat.timers.size, 1);
  chat.flush();
  assert.deepEqual(chat.document.activeElement.changes, [['autocomplete', 'off'], ['autocomplete', null]]);
});

test('nothing changes without a text field in focus, without the focus, or during a composition', () => {
  for (const active of [null, field('BUTTON'), field('DIV'), field('INPUT', { type: 'checkbox' }), field('INPUT', { type: 'password' })]) {
    const chat = chatWindow({ active });
    resyncImeOnFocus(chat.window);
    chat.emit('focus');
    chat.flush();
    assert.deepEqual(active?.changes ?? [], []);
  }
  const unfocused = chatWindow({ focused: false });
  resyncImeOnFocus(unfocused.window);
  unfocused.emit('focus');
  unfocused.flush();
  assert.deepEqual(unfocused.document.activeElement.changes, []);

  const composing = chatWindow();
  resyncImeOnFocus(composing.window);
  composing.emit('compositionstart');
  composing.emit('focus');
  composing.flush();
  assert.deepEqual(composing.document.activeElement.changes, []);
  composing.emit('compositionend');
  composing.emit('focus');
  composing.flush();
  assert.deepEqual(composing.document.activeElement.changes, [['autocomplete', 'off'], ['autocomplete', null]]);
});

test('a composition that starts during the flip has the attribute put back once it ends', () => {
  const chat = chatWindow();
  resyncImeOnFocus(chat.window);
  chat.emit('focus');
  [...chat.timers.values()][0].fn();
  chat.timers.clear();
  chat.emit('compositionstart');
  // Another focus meanwhile does not flip the flipped attribute again.
  chat.emit('focus');
  chat.flush();
  const active = chat.document.activeElement;
  assert.deepEqual(active.changes, [['autocomplete', 'off']]);
  chat.emit('compositionend');
  assert.deepEqual(active.changes, [['autocomplete', 'off'], ['autocomplete', null]]);
  // And the next focus flips it again.
  chat.emit('focus');
  chat.flush();
  assert.equal(active.changes.length, 4);
});

test('an IME key that reaches the page instead of the IME flips the field at once', () => {
  const pressed = (event) => {
    const chat = chatWindow({ active: field('INPUT', { type: 'text' }) });
    resyncImeOnFocus(chat.window);
    chat.emit('keydown', event);
    const waits = [...chat.timers.values()].map((timer) => timer.ms);
    chat.flush();
    return { waits, changes: chat.document.activeElement.changes };
  };
  // Windows' Convert key, and macOS's Kana key.
  for (const event of [{ key: 'Convert', code: 'Convert', keyCode: 28 }, { key: 'KanaMode', code: 'Lang1', keyCode: 0 }, { key: 'Unidentified', code: 'Lang1', keyCode: 0 }]) {
    assert.deepEqual(pressed(event), { waits: [0], changes: [['autocomplete', 'off'], ['autocomplete', null]] });
  }
  // Keys the IME took (229), keys during a composition, script events, and other keys.
  for (const event of [{ key: 'Convert', code: 'Convert', keyCode: 229 }, { key: 'Convert', code: 'Convert', keyCode: 28, isComposing: true },
    { key: 'Convert', code: 'Convert', keyCode: 28, isTrusted: false }, { key: 'a', code: 'KeyA', keyCode: 65 }, { key: 'Enter', code: 'Enter', keyCode: 13 }]) {
    assert.deepEqual(pressed(event), { waits: [], changes: [] });
  }
});

test('the script installs its listeners once per frame', () => {
  const chat = chatWindow();
  const context = vm.createContext({ window: chat.window });
  vm.runInContext(CHAT_IME_RESYNC, context);
  assert.equal(vm.runInContext(CHAT_IME_RESYNC, context), false);
  assert.deepEqual(Object.fromEntries(Object.entries(chat.listeners).map(([type, list]) => [type, list.length])),
    { focus: 1, compositionstart: 1, compositionend: 1, keydown: 1 });
  chat.emit('focus');
  chat.flush();
  assert.deepEqual(chat.document.activeElement.changes, [['autocomplete', 'off'], ['autocomplete', null]]);
});
