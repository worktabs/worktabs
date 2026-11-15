const assert = require('node:assert/strict');
const test = require('node:test');
const { mountReact } = require('./fixtures/react-tree');
const { reactAncestors, reactElementProps, webviewReactScript } = require('../src/conversations/webview-react');
const { conversationProbe } = require('../src/conversations/seen-conversations');
const { pickerProbe, pickerSnapshot, applyCodexApproval } = require('../src/codex/codex-approval');
const { onboardingProbe, codexOnboardingSnapshot } = require('../src/agents/agent-onboarding');
const element = (props) => ({ props });
const documentOf = (node) => ({ querySelectorAll: () => [node] });
const picker = (select) => ({ triggerButton: element({ id: 'composer.permissionsDropdown.default.shortLabel' }), children: [element({ disabled: false, onClick: select, children: element({ id: 'composer.permissionsDropdown.guardianApproval.optionLabel' }) })] });
const onboarding = (complete) => [{ children: element({ id: 'codex.legal.step.intro.title' }) }, { initialStep: 0, hasCloudAccess: true, onAccept: complete }];

test('shared mounted discovery ignores alternate props for identity, selection and onboarding callbacks', async () => {
  const trigger = { checkVisibility: () => true }; let selected = 0;
  const currentContext = { conversationId: 'new', hostId: 'local' };
  const tree = mountReact(trigger, [picker(() => selected++), currentContext], { alternateProps: [picker(() => assert.fail('alternate selection')), { conversationId: 'old', hostId: 'local' }] });
  assert.deepEqual(conversationProbe('codex', documentOf(trigger)), { available: true, snapshot: { agent: 'codex', id: 'new' } });
  currentContext.conversationId = null;
  assert.deepEqual(await applyCodexApproval(pickerSnapshot(trigger), 'auto-review'), { reason: 'selected' }); assert.equal(selected, 1);
  tree.contexts[1].memoizedProps = { conversationId: 'switched', hostId: 'local' };
  assert.equal(pickerProbe(trigger).snapshot.conversationId, 'switched');
  assert.deepEqual(await applyCodexApproval(pickerSnapshot(trigger), 'auto-review'), { reason: 'existing-conversation' });
  let completed = 0; const intro = {};
  mountReact(intro, onboarding(() => completed++), { alternateProps: onboarding(() => assert.fail('alternate completion')) });
  await codexOnboardingSnapshot(documentOf(intro)).complete(); assert.equal(completed, 1);
});

test('detached and replaced DOM nodes cannot supply semantic snapshots from their old tree', () => {
  const old = { checkVisibility: () => true }; const tree = mountReact(old, [picker(() => assert.fail()), { conversationId: 'old', hostId: 'local' }]);
  const replacement = { checkVisibility: () => true }; const next = mountReact(replacement, [picker(() => {}), { conversationId: 'new', hostId: 'local' }]);
  tree.root.stateNode.current = next.root;
  assert.deepEqual(reactAncestors(old), { available: false, reason: 'unmounted-node' });
  assert.equal(pickerSnapshot(old), null); assert.equal(conversationProbe('codex', documentOf(old)).available, false);
  assert.equal(pickerProbe(replacement).snapshot.conversationId, 'new');
  replacement.isConnected = false;
  assert.deepEqual(pickerProbe(replacement), { available: false, reason: 'detached-node' });
  assert.equal(onboardingProbe(documentOf(replacement)).available, false);
});

test('deep official-style provider trees keep mounted conversation, permission and onboarding context', async () => {
  const providers = Array.from({ length: 340 }, () => ({ children: null }));
  const trigger = { checkVisibility: () => true };
  let selected = 0;
  mountReact(trigger, [picker(() => selected++), { conversationId: 'deep-thread', hostId: 'local' }, ...providers],
    { alternateProps: [{ conversationId: 'stale-thread', hostId: 'local' }, ...providers] });
  assert.deepEqual(conversationProbe('codex', documentOf(trigger)),
    { available: true, snapshot: { agent: 'codex', id: 'deep-thread' } });
  assert.equal(pickerProbe(trigger).snapshot.conversationId, 'deep-thread');
  assert.equal(new Function('node', `return ${webviewReactScript('return reactAncestors(node);')}`)(trigger)
    .props.find((p) => p.conversationId).conversationId, 'deep-thread');
  // Reading a deep tree must still respect the existing-thread approval guard.
  assert.deepEqual(await applyCodexApproval(pickerSnapshot(trigger), 'auto-review'), { reason: 'existing-conversation' });
  assert.equal(selected, 0);
  const intro = {};
  let completed = 0;
  mountReact(intro, [...onboarding(() => completed++), ...providers],
    { alternateProps: [...onboarding(() => assert.fail('alternate completion')), ...providers] });
  await codexOnboardingSnapshot(documentOf(intro)).complete();
  assert.equal(completed, 1);
  const excessive = {};
  mountReact(excessive, Array.from({ length: 600 }, () => ({})));
  assert.equal(reactAncestors(excessive).reason, 'ancestor-limit');
});

test('a long conversation rendered before the input does not hide the mounted session (#75)', () => {
  const session = (id) => ({ session: { isLoading: { value: false }, loadFailed: { value: false }, sessionId: { value: id } } });
  const input = { checkVisibility: () => true };
  const tree = mountReact(input, [session('long')], { alternateProps: [session('stale')] });
  // The messages: a sibling before the composer, with more fibers than the search may visit.
  const messages = { return: tree.root, sibling: tree.root.child };
  let previous = null;
  for (let i = 0; i < 20000; i++) {
    const message = { memoizedProps: { index: i }, return: messages };
    if (previous) previous.sibling = message; else messages.child = message;
    previous = message;
  }
  tree.root.child = messages;
  assert.deepEqual(conversationProbe('claude', documentOf(input)), { available: true, snapshot: { agent: 'claude', id: 'long' } });
  assert.equal(reactAncestors(input).props.find((p) => p.session).session.sessionId.value, 'long');
  // Without the path from the input (no alternate to match), the search of the tree stops.
  delete tree.alternate.contexts[0].alternate; delete tree.context.alternate;
  assert.deepEqual(reactAncestors(input), { available: false, reason: 'tree-limit' });
});

test('missing and malformed roots report explicit unavailable reasons within traversal bounds', () => {
  assert.deepEqual(reactAncestors({}), { available: false, reason: 'missing-fiber' });
  const missing = { __reactFiber$test: {} }; assert.equal(reactAncestors(missing).reason, 'missing-current-root');
  const cycle = {}; cycle.return = cycle; assert.equal(reactAncestors({ __reactFiber$test: cycle }).reason, 'malformed-tree');
  const node = {}; const tree = mountReact(node, [{ id: 'known' }]);
  assert.equal(reactAncestors(node, { maxNodes: 1 }).reason, 'tree-limit');
  assert.equal(reactAncestors(node, { maxDepth: 0 }).reason, 'ancestor-limit');
  tree.root.child = {}; tree.root.child.sibling = tree.root.child;
  assert.equal(reactAncestors(node).reason, 'malformed-tree');
  const unreadable = {}; Object.defineProperty(unreadable, '__reactFiber$test', { enumerable: true, get() { throw new Error('unsupported'); } });
  assert.equal(reactAncestors(unreadable).reason, 'unreadable-tree');
});

test('element-prop traversal bounds cycles, width, depth and unavailable getters', () => {
  const cycle = element({}); cycle.props.children = cycle;
  assert.equal(reactElementProps(cycle).reason, 'malformed-props');
  assert.equal(reactElementProps(Array.from({ length: 20 }, () => element({})), { maxNodes: 10 }).reason, 'props-limit');
  const nested = element({ children: element({ children: element({ id: 'deep' }) }) });
  assert.equal(reactElementProps(nested, { maxDepth: 1 }).reason, 'props-depth-limit');
  assert.deepEqual(reactElementProps(element({ children: element({ id: 'child' }), selectedValue: element({ id: 'selected' }) })).props.map((p) => p.id).filter(Boolean), ['child', 'selected']);
  assert.deepEqual(reactElementProps(element({ selectedValue: element({ id: 'selected' }) }), { includeSelected: false }).props.map((p) => p.id).filter(Boolean), []);
  const unreadable = {}; Object.defineProperty(unreadable, 'props', { get() { throw new Error('unsupported'); } });
  assert.equal(reactElementProps(unreadable).reason, 'unreadable-props');
});

test('unknown feature shapes remain unavailable even when React discovery succeeds', () => {
  const node = { checkVisibility: () => true }; mountReact(node, [{ id: 'unrelated' }]);
  assert.deepEqual(pickerProbe(node), { available: false, reason: 'unknown-picker' });
  assert.deepEqual(onboardingProbe(documentOf(node)), { available: false, reason: 'unknown-onboarding' });
  assert.deepEqual(conversationProbe('claude', documentOf(node)), { available: false, reason: 'unknown-conversation' });
  const bad = picker(() => assert.fail('malformed props must not select')); bad.children.push(bad.children);
  mountReact(node, [bad, { conversationId: null, hostId: 'local' }]);
  assert.equal(pickerProbe(node).available, false); assert.equal(pickerSnapshot(node), null);
});

test('serialized common discovery executes without Node and preserves structured results', () => {
  const node = {}; mountReact(node, [{ id: 'current' }], { alternateProps: [{ id: 'old' }] });
  const script = webviewReactScript('return reactAncestors(node);');
  assert.equal(new Function('node', `return ${script}`)(node).props[0].id, 'current');
  assert.equal(new Function('node', `return ${script}`)({}).reason, 'missing-fiber');
});
