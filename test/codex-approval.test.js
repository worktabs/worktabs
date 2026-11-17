const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { mountReact } = require('./fixtures/react-tree');
const { pickerSnapshot, applyCodexApproval, watchCodexApproval, codexApprovalScript } = require('../src/codex/codex-approval');

const element = (props) => ({ props });
const label = (mode) => element({ id: `composer.permissionsDropdown.${mode === 'manual' ? 'default.approvalOptionLabel' : 'guardianApproval.optionLabel'}` });

// Permission picker shapes observed in OpenAI.chatgpt 26.1007.21434. The legacy picker
// supplies guarded onClick callbacks; the profile picker supplies semantic selections.
function picker({ mode = 'manual', supported = true, restricted = false, profile = false,
  conversationId = null, hostId = 'local', select = () => {}, loading = false } = {}) {
  const trigger = { disabled: loading, visible: true, isConnected: true,
    checkVisibility() { return this.visible; }, contains(target) { return target === this || target?.parent === this; } };
  const selection = (value) => ({ kind: 'agent-mode', agentMode: ({ manual: 'auto', 'auto-review': 'guardian-approvals' })[value] || value });
  const children = ['manual', ...(supported ? ['auto-review'] : [])].map((value) => profile
    ? element({ selection: { permissionSelection: selection(value), disabledReason: restricted && value === 'auto-review' ? 'disabled-by-requirements' : null },
      selectedPermissionSelection: selection(mode), selectPermission: (choice) => select(choice.agentMode) })
    : element({ children: label(value), disabled: restricted && value === 'auto-review', onClick: () => select(value) }));
  const triggerButton = profile ? element({ selectedPermissionSelection: selection(mode) })
    : element({ children: element({ selectedValue: ['custom', 'full-access'].includes(mode)
      ? element({ id: `composer.permissionsDropdown.${mode}.shortLabel` }) : label(mode) }) });
  mountReact(trigger, [{ triggerButton, children, disabled: loading }, { conversationId, hostId }]);
  return trigger;
}

test('supported pickers use the extension selection callback, independently of translated labels', async () => {
  for (const profile of [false, true]) {
    const calls = [];
    const trigger = picker({ profile, select: (value) => calls.push(value) });
    assert.deepEqual(await applyCodexApproval(pickerSnapshot(trigger), 'auto-review'), { reason: 'selected' });
    assert.deepEqual(calls, [profile ? 'guardian-approvals' : 'auto-review']);
  }
});

test('older, unavailable, restricted, and unknown pickers receive no unsupported selection', async () => {
  const select = () => assert.fail('must not select an unavailable mode');
  for (const profile of [false, true]) {
    assert.deepEqual(await applyCodexApproval(pickerSnapshot(picker({ profile, supported: false, select })), 'auto-review'),
      { mode: 'manual', reason: 'unavailable' });
    assert.deepEqual(await applyCodexApproval(pickerSnapshot(picker({ profile, restricted: true, select })), 'auto-review'),
      { mode: 'manual', reason: 'restricted' });
  }
  assert.deepEqual(await applyCodexApproval(pickerSnapshot({}), 'auto-review'), { reason: 'unknown-picker' });
});

test('loading, history, other hosts, and explicit profiles are left to Codex', async () => {
  for (const [options, reason] of [[{ loading: true }, 'loading'], [{ conversationId: 'saved' }, 'existing-conversation'],
    [{ hostId: 'remote' }, 'other-host'], [{ mode: 'custom' }, 'explicit-or-unknown-mode'],
    [{ mode: 'full-access' }, 'explicit-or-unknown-mode'], [{ mode: 'full-access', profile: true }, 'explicit-or-unknown-mode']]) {
    const snapshot = pickerSnapshot(picker({ ...options, select: () => assert.fail('must preserve selection') }));
    assert.equal((await applyCodexApproval(snapshot, 'auto-review')).reason, reason);
  }
});

test('manual preference uses the default approval option and does not reselect an effective mode', async () => {
  const calls = [];
  assert.deepEqual(await applyCodexApproval(pickerSnapshot(picker({ mode: 'auto-review', select: (mode) => calls.push(mode) })), 'manual'), { reason: 'selected' });
  assert.deepEqual(calls, ['manual']);
  assert.deepEqual(await applyCodexApproval(pickerSnapshot(picker({ select: () => assert.fail('already manual') })), 'manual'), { mode: 'manual' });
});

test('rejected enum, method, and unrelated failures do not trigger retries or another mode', async () => {
  for (const message of ['unknown variant guardian_subagent', 'Method not found', 'Authentication failed']) {
    let calls = 0;
    const snapshot = pickerSnapshot(picker({ select: async () => { calls++; throw new Error(message); } }));
    assert.deepEqual(await applyCodexApproval(snapshot, 'auto-review'), { mode: 'manual', reason: 'selection-failed' });
    assert.equal(calls, 1);
  }
});

function environment(trigger) {
  const timers = [], listeners = new Map();
  let mutate;
  const env = {
    document: { documentElement: {}, querySelectorAll: () => env.triggers || (env.trigger ? [env.trigger] : []),
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name) => listeners.delete(name) },
    MutationObserver: class { constructor(callback) { mutate = callback; } observe() {} disconnect() {} },
    setTimeout: (callback) => { timers.push(callback); return callback; },
    clearTimeout: (callback) => { const index = timers.indexOf(callback); if (index >= 0) timers.splice(index, 1); },
    trigger,
  };
  return { env, listeners, mutate: () => mutate(), tick: async () => { const run = timers.splice(0); for (const callback of run) await callback(); } };
}

test('selection is confirmed, applied once, and preserves later choices across mutations and settings changes', async () => {
  let calls = 0;
  const trigger = picker();
  let snapshot = pickerSnapshot(trigger);
  snapshot.options['auto-review'].select = () => { calls++; snapshot.current = 'auto-review'; };
  const fixture = environment(trigger);
  watchCodexApproval('auto-review', () => snapshot, applyCodexApproval, fixture.env);
  await fixture.tick();
  assert.deepEqual(fixture.env.worktabsCodexApproval.result, { reason: 'selected' });
  await fixture.tick();
  assert.deepEqual(fixture.env.worktabsCodexApproval.result, { mode: 'auto-review' });
  snapshot.current = 'manual';
  fixture.env.trigger = picker({ mode: 'manual' });
  fixture.mutate();
  await fixture.tick();
  fixture.env.worktabsCodexApproval.setPreference('manual');
  fixture.mutate();
  await fixture.tick();
  assert.equal(calls, 1);
  // Resume does not touch the stored thread. Returning to a new composer uses the new default.
  snapshot.conversationId = 'history';
  fixture.mutate(); await fixture.tick();
  assert.equal(fixture.env.worktabsCodexApproval.result.reason, 'existing-conversation');
  snapshot.conversationId = null;
  fixture.mutate(); await fixture.tick();
  assert.deepEqual(fixture.env.worktabsCodexApproval.result, { mode: 'manual' });
});

test('typing or clicking outside permissions before setup does not cancel the default', async () => {
  const fixture = environment(picker());
  watchCodexApproval('auto-review', pickerSnapshot, applyCodexApproval, fixture.env);
  fixture.listeners.get('keydown')({ type: 'keydown', isTrusted: true, key: 'a', target: {} });
  fixture.listeners.get('pointerdown')({ type: 'pointerdown', isTrusted: true, target: {} });
  await fixture.tick();
  assert.equal(fixture.env.worktabsCodexApproval.result.reason, 'selected');
});

test('only the unique visible composer receives the default, even after a hidden history picker', async () => {
  const hidden = picker({ conversationId: 'history', select: () => assert.fail('hidden picker') });
  hidden.visible = false;
  const calls = [];
  const current = picker({ select: (value) => calls.push(value) });
  const fixture = environment(current);
  fixture.env.triggers = [hidden, current];
  watchCodexApproval('auto-review', pickerSnapshot, applyCodexApproval, fixture.env);
  await fixture.tick();
  assert.deepEqual(calls, ['auto-review']);
});

test('hidden, detached and ambiguous composers wait until exactly one is visible', async () => {
  for (const state of ['hidden', 'detached', 'ambiguous']) {
    let calls = 0;
    const current = picker({ select: () => calls++ });
    const fixture = environment(current);
    if (state === 'hidden') current.visible = false;
    if (state === 'detached') current.isConnected = false;
    if (state === 'ambiguous') fixture.env.triggers = [current, picker()];
    watchCodexApproval('auto-review', pickerSnapshot, applyCodexApproval, fixture.env);
    await fixture.tick();
    assert.equal(calls, 0, state);
    current.visible = true; current.isConnected = true; fixture.env.triggers = [current];
    fixture.mutate(); await fixture.tick();
    assert.equal(calls, 1, state);
  }
});

test('permission activation before setup preserves the choice, but tabbing and untrusted input do not', async () => {
  for (const [type, key, trusted, expected] of [
    ['pointerdown', undefined, true, 'user-choice'], ['keydown', 'Enter', true, 'user-choice'],
    ['keydown', ' ', true, 'user-choice'], ['keydown', 'ArrowDown', true, 'user-choice'],
    ['keydown', 'Tab', true, 'selected'], ['pointerdown', undefined, false, 'selected'],
  ]) {
    const fixture = environment(picker());
    watchCodexApproval('auto-review', pickerSnapshot, applyCodexApproval, fixture.env);
    fixture.listeners.get(type)({ type, key, isTrusted: trusted, target: { parent: fixture.env.trigger } });
    await fixture.tick();
    assert.equal(fixture.env.worktabsCodexApproval.result.reason, expected, `${type}: ${key}`);
  }
});

test('a retained new-chat composer does not consume initialization for another new chat', async () => {
  const first = picker();
  const nextCalls = [];
  const next = picker({ select: (mode) => nextCalls.push(mode) });
  next.visible = false;
  const fixture = environment(first);
  fixture.env.triggers = [first, next];
  watchCodexApproval('auto-review', pickerSnapshot, applyCodexApproval, fixture.env);
  fixture.listeners.get('pointerdown')({ type: 'pointerdown', isTrusted: true, target: first });
  await fixture.tick();
  assert.equal(fixture.env.worktabsCodexApproval.result.reason, 'user-choice');
  first.visible = false; next.visible = true;
  fixture.mutate(); await fixture.tick();
  assert.deepEqual(nextCalls, ['auto-review']);
});

test('a choice in the newly visible composer is preserved before its first observer check', async () => {
  const old = picker({ conversationId: 'history' });
  const next = picker({ select: () => assert.fail('user opened permissions') });
  next.visible = false;
  const fixture = environment(old);
  fixture.env.triggers = [old, next];
  watchCodexApproval('auto-review', pickerSnapshot, applyCodexApproval, fixture.env);
  await fixture.tick();
  old.visible = false; next.visible = true;
  fixture.listeners.get('pointerdown')({ type: 'pointerdown', isTrusted: true, target: next });
  fixture.mutate(); await fixture.tick();
  assert.equal(fixture.env.worktabsCodexApproval.result.reason, 'user-choice');
});

test('an asynchronous result from a hidden composer cannot finish initialization in a different chat', async () => {
  const old = picker();
  const next = picker({ conversationId: 'history' });
  next.visible = false;
  let finish;
  const fixture = environment(old);
  fixture.env.triggers = [old, next];
  watchCodexApproval('auto-review', pickerSnapshot, (snapshot, preference) => snapshot.conversationId === null
    ? new Promise((resolve) => { finish = resolve; }) : applyCodexApproval(snapshot, preference), fixture.env);
  const pending = fixture.tick();
  old.visible = false; next.visible = true;
  fixture.mutate(); await fixture.tick();
  finish({ reason: 'selected' }); await pending;
  await fixture.tick();
  assert.equal(fixture.env.worktabsCodexApproval.result.reason, 'existing-conversation');
});

test('a selection callback that does not change the picker is never reported as effective', async () => {
  const trigger = picker();
  let snapshot = pickerSnapshot(trigger);
  const fixture = environment(trigger);
  watchCodexApproval('auto-review', () => snapshot, applyCodexApproval, fixture.env);
  await fixture.tick();
  assert.deepEqual(fixture.env.worktabsCodexApproval.result, { reason: 'selected' });
  snapshot = { ...snapshot, current: 'manual' };
  await fixture.tick();
  assert.notEqual(fixture.env.worktabsCodexApproval.result.mode, 'auto-review');
  fixture.env.worktabsCodexApproval.dispose();
});

test('inconclusive startup loading stops after the deadline without a startup retry loop', async () => {
  const trigger = picker({ loading: true, select: () => assert.fail('must not select while loading') });
  const fixture = environment(trigger);
  let now = 0;
  fixture.env.now = () => now;
  watchCodexApproval('auto-review', pickerSnapshot, applyCodexApproval, fixture.env);
  await fixture.tick();
  now = 10001;
  await fixture.tick();
  assert.deepEqual(fixture.env.worktabsCodexApproval.result, { mode: 'manual', reason: 'loading-timeout' });
  fixture.mutate(); await fixture.tick();
  assert.equal(fixture.env.worktabsCodexApproval.result.reason, 'loading-timeout');
});

test('new frames re-evaluate capability after update and downgrade, without a cached version decision', async () => {
  for (const [supported, mode] of [[false, 'manual'], [true, 'auto-review'], [false, 'manual']]) {
    const trigger = picker({ supported });
    const snapshot = pickerSnapshot(trigger);
    if (supported) snapshot.options['auto-review'].select = () => { snapshot.current = 'auto-review'; };
    const fixture = environment(trigger);
    watchCodexApproval('auto-review', () => snapshot, applyCodexApproval, fixture.env);
    await fixture.tick(); await fixture.tick();
    assert.equal(fixture.env.worktabsCodexApproval.result.mode, mode);
  }
});

test('generated script runs without Node and disposes its previous observer on replacement', () => {
  const fixture = environment(picker());
  const context = vm.createContext({ window: fixture.env });
  assert.equal(vm.runInContext(codexApprovalScript('auto-review'), context), true);
  const previous = fixture.env.worktabsCodexApproval;
  assert.equal(vm.runInContext(codexApprovalScript('manual'), context), true);
  assert.notEqual(fixture.env.worktabsCodexApproval, previous);
  assert.equal(fixture.env.worktabsCodexApproval.preference, 'manual');
});

test('disposal and trusted choices during asynchronous selection preserve watcher ownership', async () => {
  for (const action of ['dispose', 'reinject', 'user']) {
    let resolve; const pending = new Promise((done) => { resolve = done; });
    const fixture = environment(picker());
    watchCodexApproval('auto-review', pickerSnapshot, () => pending, fixture.env);
    const previous = fixture.env.worktabsCodexApproval; const tick = fixture.tick();
    if (action === 'dispose') previous.dispose();
    else if (action === 'reinject') watchCodexApproval('manual', pickerSnapshot, applyCodexApproval, fixture.env);
    else fixture.listeners.get('keydown')({ type: 'keydown', isTrusted: true, key: 'Enter', target: fixture.env.trigger });
    resolve({ reason: 'selected' }); await tick;
    assert.equal(previous.result.reason, action === 'user' ? 'user-choice' : 'loading');
    if (action === 'reinject') assert.equal(fixture.env.worktabsCodexApproval.result.reason, 'loading');
    fixture.env.worktabsCodexApproval.dispose();
  }
});
