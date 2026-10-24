const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { prefillCodexTask, codexTaskScript, startTaskConversation } = require('../src/conversations/first-conversation');
const { firstPrompt } = require('../src/repos/task');

function composer({ text = '', id = null, hostId = 'local', hidden = false, focused = true, accepted = true } = {}) {
  const editor = { innerText: text, checkVisibility: () => !hidden, focus() {}, contains: () => focused };
  const picker = { checkVisibility: () => true };
  const edits = [];
  const document = {
    activeElement: focused ? editor : null,
    querySelectorAll: (selector) => selector.includes('permissions') ? [picker] : [editor],
    getSelection: () => ({ anchorNode: editor, focusNode: editor, removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand: (command, show, value) => { edits.push([command, show, value]); if (accepted) editor.innerText = value; return accepted; },
  };
  const props = [{ conversationId: id, hostId }];
  const root = { memoizedProps: props[0], child: { stateNode: picker } };
  root.stateNode = { current: root };
  picker.__reactFiber$test = { return: root };
  return { document, propsOf: () => props, edits, editor };
}

test('issue, PR, and free text tasks become editable Codex drafts without sending', () => {
  for (const task of [{ kind: 'issue', number: 20, title: 'Make worktrees' },
    { kind: 'pull', number: 71, title: 'Review changes' }, { kind: 'text', text: '日本語\n<text> "quoted"' }]) {
    const prompt = firstPrompt(task);
    const ui = composer();
    assert.deepEqual(prefillCodexTask(ui.document, prompt, ui.propsOf), { filled: true });
    assert.deepEqual(ui.edits, [['insertText', false, prompt]]);
    assert.equal(ui.editor.innerText, prompt);
  }
});

test('existing drafts, history threads, remote hosts, hidden or unfocused editors are untouched', () => {
  for (const options of [{ text: 'My draft' }, { id: 'history' }, { hostId: 'remote' }, { hidden: true }, { focused: false }]) {
    const ui = composer(options);
    assert.equal(prefillCodexTask(ui.document, 'Task', ui.propsOf).filled, false);
    assert.deepEqual(ui.edits, []);
  }
});

test('the injected script uses the mounted tree and preserves literal task text', () => {
  const ui = composer();
  const prompt = 'Task ` ${value} \n日本語';
  const answer = vm.runInNewContext(codexTaskScript(prompt), { document: ui.document });
  assert.equal(answer.filled, true);
  assert.equal(ui.editor.innerText, prompt);
});

test('unknown props and rejected native input give a recovery result', () => {
  const ui = composer();
  assert.equal(prefillCodexTask(ui.document, 'Task', () => []).filled, false);
  assert.deepEqual(ui.edits, []);
  const rejected = composer({ accepted: false });
  assert.equal(prefillCodexTask(rejected.document, 'Task', rejected.propsOf).reason, 'input-rejected');
});

// A clock that moves on only while startTaskConversation pauses, a quarter of a second at a time.
function clock() {
  let time = 0;
  return { now: () => time, pause: async () => { time += 250; } };
}

test('startup retries wait for a composer, stop after success, and recover on timeout', async () => {
  for (const ready of [true, false]) {
    let fills = 0, recovered = 0;
    await startTaskConversation({ agent: 'codex', prompt: 'Task', open: async () => ({ opened: true }), current: () => true,
      fill: async () => ({ filled: ++fills === 2 && ready }), recover: async () => { recovered++; }, ...clock(), wait: 750 });
    assert.equal(fills, ready ? 2 : 3);
    assert.equal(recovered, ready ? 0 : 1);
  }
});

test('the task waits up to a minute for a Codex chat that starts late', async () => {
  for (const starts of [10000, null]) {
    let recovered = 0, fills = 0;
    const time = clock();
    await startTaskConversation({ agent: 'codex', prompt: 'Task', open: async () => ({ opened: true }), current: () => true,
      fill: async () => { fills++; return starts !== null && time.now() >= starts ? { filled: true } : null; },
      recover: async () => { recovered++; }, ...time });
    assert.equal(recovered, starts === null ? 1 : 0);
    assert.equal(time.now(), starts ?? 60000);
    assert.equal(fills, starts === null ? 240 : 41);
  }
});

test('a failed open or changed draft recovers once, and canceled starts do nothing', async () => {
  for (const mode of ['open-failed', 'draft', 'canceled', 'canceled-during-fill']) {
    let recovered = 0, fills = 0, current = mode !== 'canceled';
    await startTaskConversation({ agent: 'codex', prompt: 'Task', current: () => current, ...clock(), wait: 250,
      open: async () => ({ opened: mode !== 'open-failed' }),
      fill: async () => { fills++; if (mode === 'canceled-during-fill') current = false; return { reason: 'existing-draft' }; },
      recover: async () => { recovered++; } });
    assert.equal(fills, ['draft', 'canceled-during-fill'].includes(mode) ? 1 : 0);
    assert.equal(recovered, ['open-failed', 'draft'].includes(mode) ? 1 : 0);
  }
});

test('Claude keeps its helper prefill path and empty Codex tasks only open chat', async () => {
  for (const agent of ['claude', 'codex']) {
    await startTaskConversation({ agent, prompt: null, open: async () => agent === 'claude' ? true : { opened: true },
      current: () => true, fill: () => assert.fail('No editor injection'), recover: () => assert.fail('No recovery'), pause: () => {} });
  }
});

test('failed bridge and renderer promises preserve the copy-task recovery', async () => {
  for (const phase of ['open', 'fill']) {
    let recovered = 0;
    await startTaskConversation({ agent: 'codex', prompt: 'Task', current: () => true, ...clock(), wait: 250,
      open: async () => { if (phase === 'open') throw Error('Bridge gone'); return { opened: true }; },
      fill: async () => { throw Error('Renderer gone'); }, recover: async () => { recovered++; } });
    assert.equal(recovered, 1);
  }
});
