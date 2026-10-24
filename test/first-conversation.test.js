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

// A page's globals for the scripts that wait in it: its document, a MutationObserver that
// `change()` calls back, and the timers.
function pageContext(document) {
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { observers.splice(observers.indexOf(this), 1); }
  }
  const page = { document, MutationObserver, setTimeout, clearTimeout, setInterval, clearInterval,
    change: () => [...observers].forEach((observer) => observer.callback([])), observers };
  page.window = page;
  return page;
}

test('the injected script uses the mounted tree and preserves literal task text', async () => {
  const ui = composer();
  const prompt = 'Task ` ${value} \n日本語';
  const answer = await vm.runInNewContext(codexTaskScript(prompt), pageContext(ui.document));
  assert.equal(answer.filled, true);
  assert.equal(ui.editor.innerText, prompt);
});

test('the injected script waits in the page for the composer, and gives up after its wait', async () => {
  const ui = composer({ hidden: true });
  const page = pageContext(ui.document);
  const answer = vm.runInNewContext(codexTaskScript('Task', 5000), page);
  ui.editor.checkVisibility = () => true;
  page.change();
  // Objects made in the page's context compare by their JSON.
  assert.equal(JSON.stringify(await answer), '{"filled":true}');
  assert.equal(page.observers.length, 0);
  const missing = composer({ hidden: true });
  assert.equal(JSON.stringify(await vm.runInNewContext(codexTaskScript('Task', 30), pageContext(missing.document))), '{"filled":false,"reason":"unknown-composer"}');
});

test('unknown props and rejected native input give a recovery result', () => {
  const ui = composer();
  assert.equal(prefillCodexTask(ui.document, 'Task', () => []).filled, false);
  assert.deepEqual(ui.edits, []);
  const rejected = composer({ accepted: false });
  assert.equal(prefillCodexTask(rejected.document, 'Task', rejected.propsOf).reason, 'input-rejected');
});

// A clock that moves on only while the task waits: in the chat's page (`spend`), or for a frame to
// load, a second at most (`pause`).
function clock() {
  let time = 0;
  return { now: () => time, spend: (ms) => { time += ms; }, pause: async () => { time += 1000; } };
}

test("the task waits in the chat's page, ten seconds at a time, stops once it is in, and recovers when the minute is up", async () => {
  for (const ready of [true, false]) {
    let recovered = 0;
    const waits = [];
    const time = clock();
    await startTaskConversation({ agent: 'codex', prompt: 'Task', open: async () => ({ opened: true }), current: () => true,
      fill: async (wait) => {
        waits.push(wait);
        if (ready && waits.length === 2) return { filled: true };
        time.spend(wait);
        return { filled: false, reason: 'unknown-composer' };
      },
      recover: async () => { recovered++; }, now: time.now, pause: () => assert.fail('The page answered'), wait: 55000 });
    assert.deepEqual(waits, ready ? [10000, 10000] : [10000, 10000, 10000, 10000, 10000, 5000]);
    assert.equal(recovered, ready ? 0 : 1);
  }
});

test('the task waits up to a minute for a Codex chat that starts late, asking again as frames load', async () => {
  for (const starts of [10000, null]) {
    let recovered = 0, fills = 0;
    const time = clock();
    await startTaskConversation({ agent: 'codex', prompt: 'Task', open: async () => ({ opened: true }), current: () => true,
      fill: async () => { fills++; return starts !== null && time.now() >= starts ? { filled: true } : null; },
      recover: async () => { recovered++; }, ...time });
    assert.equal(recovered, starts === null ? 1 : 0);
    assert.equal(time.now(), starts ?? 60000);
    assert.equal(fills, starts === null ? 60 : 11);
  }
});

test('a failed open or changed draft recovers once, and canceled starts do nothing', async () => {
  for (const mode of ['open-failed', 'draft', 'canceled', 'canceled-during-fill']) {
    let recovered = 0, fills = 0, current = mode !== 'canceled';
    const time = clock();
    await startTaskConversation({ agent: 'codex', prompt: 'Task', current: () => current, ...time, wait: 250,
      open: async () => ({ opened: mode !== 'open-failed' }),
      fill: async (wait) => { fills++; time.spend(wait); if (mode === 'canceled-during-fill') current = false; return { reason: 'existing-draft' }; },
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
