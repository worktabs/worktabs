const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { CHAT_STARTED_SCRIPT, chatStartup, createChatStartupWatch } = require('../src/conversations/chat-startup');

// A clock that moves on only while chatStartup sleeps.
function clock() {
  let time = 0;
  return { now: () => time, sleep: async (ms) => { time += ms; } };
}

// A chat frame whose page has started after `startsAfter` answers (never with null). `answer`:
// how it answers instead, as a function of the attempt.
function chatFrame({ startsAfter = null, answer = null } = {}) {
  const frame = { attempts: 0 };
  frame.executeJavaScript = async (script) => {
    assert.equal(script, CHAT_STARTED_SCRIPT);
    frame.attempts++;
    if (answer) return answer(frame.attempts);
    return startsAfter !== null && frame.attempts > startsAfter;
  };
  return frame;
}

test('a page has started once React has put its own element in #root', () => {
  const run = (root) => vm.runInNewContext(CHAT_STARTED_SCRIPT, { document: { getElementById: () => root } });
  assert.equal(run(null), false);
  assert.equal(run({ children: [{ className: 'startup-loader' }] }), false);
  assert.equal(run({ children: [{ className: 'startup-loader' }, { __reactFiber$abc: {} }] }), true);
});

test('a chat starts, starts late, gets stuck, or goes away', async () => {
  const outcome = (frames, options = {}) => chatStartup(() => frames, { current: () => true, ...clock(), ...options });
  assert.equal(await outcome([chatFrame({ startsAfter: 5 })]), 'started');
  const late = chatFrame();
  assert.equal(await outcome([late]), 'late');
  assert.equal(late.attempts, 61, 'once a second, for a minute');
  assert.equal(await outcome([chatFrame({ answer: (n) => (n < 3 ? false : new Promise(() => {})) })], { answerTimeout: 5 }), 'stuck');
  let open = true;
  assert.equal(await outcome([chatFrame({ answer: () => { open = false; return false; } })], { current: () => open }), 'gone');
  assert.equal(await outcome([]), 'gone');
  // One of the agent's chats that has started is enough.
  assert.equal(await outcome([chatFrame(), chatFrame({ startsAfter: 0 })]), 'started');
});

test('the frames are looked up for each check, and the minute runs on as they are replaced', async () => {
  // Electron disposes a frame's first object as VS Code writes the chat's page into the frame.
  const disposed = chatFrame({ answer: () => Promise.reject(new Error('Render frame was disposed before WebFrameMain could be accessed')) });
  const written = chatFrame({ startsAfter: 1 });
  let lookups = 0;
  assert.equal(await chatStartup(() => [++lookups <= 2 ? disposed : written], { current: () => true, ...clock() }), 'started');
  // Codex sets its page again after 30 seconds without its chat, and VS Code replaces the frame.
  const time = clock();
  const first = chatFrame();
  const second = chatFrame();
  assert.equal(await chatStartup(() => [time.now() < 30000 ? first : second], { current: () => true, ...time }), 'late');
  assert.equal(time.now(), 60000);
  assert.ok(first.attempts > 0 && second.attempts > 0);
  let present = true;
  const removed = chatFrame({ answer: () => { present = false; return false; } });
  assert.equal(await chatStartup(() => (present ? [removed] : []), { current: () => true, ...clock() }), 'gone');
});

function setup({ previous = '26.51007.21434', response = 0, rollbackError = null, frames = () => [chatFrame()] } = {}) {
  const calls = [];
  const tab = { id: 't1', name: 'app-fix' };
  let open = true;
  const watch = createChatStartupWatch({
    current: () => open,
    chatFrames: (_tab, agent) => frames(agent),
    versions: (_tab, agent) => ({ id: agent === 'codex' ? 'openai.chatgpt' : 'anthropic.claude-code', version: '26.1021.22027', previous }),
    ask: async (options) => { calls.push(['ask', options]); return { response: calls.filter(([kind]) => kind === 'ask').length === 1 ? response : 0 }; },
    rollback: async (id) => { calls.push(['rollback', id]); if (rollbackError) throw new Error(rollbackError); },
    reload: (reloaded) => calls.push(['reload', reloaded === tab]),
    timing: { ...clock(), answerTimeout: 5 },
  });
  return { watch, calls, tab, close: () => { open = false; } };
}

test('a chat that does not start is told once for its version, with the previous version to go back to', async () => {
  const { watch, calls, tab } = setup();
  await watch.watch(tab, 'codex');
  const [[, options], rollback] = calls;
  assert.equal(options.message, 'The Codex chat did not start.');
  assert.match(options.detail, /^Codex 26\.1021\.22027 did not start its chat in app-fix within a minute\./);
  assert.match(options.detail, /previous version, 26\.51007\.21434, restarts the tabs/);
  assert.deepEqual(options.buttons, ['Go back to 26.51007.21434', 'Reload the tab', 'Close']);
  assert.equal(options.cancelId, 2);
  assert.deepEqual(rollback, ['rollback', 'openai.chatgpt']);
  // Another tab on the same version, or the same chat loading again, is not told again.
  await watch.watch({ id: 't2', name: 'app-other' }, 'codex');
  assert.equal(calls.length, 2);
  // Claude Code is another extension.
  await watch.watch(tab, 'claude');
  assert.equal(calls.at(-2)[1].message, 'The Claude Code chat did not start.');
});

test('a chat that stops answering while it starts is told so', async () => {
  const { watch, calls, tab } = setup({ frames: () => [chatFrame({ answer: () => new Promise(() => {}) })] });
  await watch.watch(tab, 'codex');
  assert.match(calls[0][1].detail, /^The Codex 26\.1021\.22027 chat in app-fix stopped responding while it started\./);
});

test('without a previous version, the tab can be reloaded; a failed rollback is told', async () => {
  const reload = setup({ previous: null });
  await reload.watch.watch(reload.tab, 'codex');
  assert.deepEqual(reload.calls[0][1].buttons, ['Reload the tab', 'Close']);
  assert.match(reload.calls[0][1].detail, /Reload the tab to try again\.$/);
  assert.deepEqual(reload.calls[1], ['reload', true]);

  const closed = setup({ previous: null, response: 1 });
  await closed.watch.watch(closed.tab, 'codex');
  assert.equal(closed.calls.length, 1, 'Close does nothing');

  const failed = setup({ rollbackError: 'Another update is in progress.' });
  await failed.watch.watch(failed.tab, 'codex');
  assert.equal(failed.calls[2][1].message, 'Could not go back to the previous version.');
  assert.equal(failed.calls[2][1].detail, 'Another update is in progress.');
});

test('a chat that starts, or whose tab closes, is not told, and an agent is watched once per tab at a time', async () => {
  const frame = chatFrame({ startsAfter: 2 });
  const { watch, calls, tab, close } = setup({ frames: () => [frame] });
  await Promise.all([watch.watch(tab, 'codex'), watch.watch(tab, 'codex')]);
  assert.equal(frame.attempts, 3);
  // Once it has started, the agent's next chat to load is watched again.
  await watch.watch(tab, 'codex');
  assert.equal(frame.attempts, 4);
  close();
  await watch.watch(tab, 'claude');
  assert.deepEqual(calls, []);
});
