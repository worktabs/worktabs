const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../src/sidebar/model');
const state = (extra = {}) => ({ repos: [], tabs: [], filter: '', repoUsed: {}, worktrees: new Map(), savedWorktrees: new Map(), expanded: new Set(), uncloned: [], ownersToggled: new Set(), ...extra });

test('groups wait for repository lookup and place non-git tabs in the nearest listed folder', () => {
  const view = state({ repos: [{ path: '/a', name: 'A', git: false }, { path: '/a/b', name: 'B', git: false }], tabs: [
    { id: 'unknown', folder: '/a/b/unknown' }, { id: 'inside', folder: '/a/b/c', repo: null },
    { id: 'outside', folder: '/elsewhere', repo: null }, { id: 'git', folder: '/owner/r-work', repo: '/owner/r' },
  ] });
  assert.equal(model.groupKeyOf(view, view.tabs[0]), undefined);
  assert.equal(model.groupKeyOf(view, view.tabs[1]), '/a/b');
  const groups = model.groups(view, 'Other');
  assert.deepEqual(groups.map((g) => [g.key, g.tabs.map((t) => t.id)]), [['/a', []], ['/a/b', ['inside']], ['/owner/r', ['git']], ['<other>', ['outside']]]);
  assert.equal(groups[2].owner, 'owner');
  assert.equal(groups[3].name, 'Other');
  assert.equal(model.isInside('C:\\Repo\\Sub\\', 'c:/repo'), true);
  assert.equal(model.isInside('/repo-copy', '/repo'), false);
});

test('sections order open groups by name and other groups by recency without mutating the catalog', () => {
  const repos = ['z', 'b', 'a', 'c'].map((name) => ({ name, path: `/${name}`, git: true }));
  const view = state({ repos, tabs: [{ id: 'z', folder: '/z', repo: '/z' }, { id: 'a', folder: '/a', repo: '/a' }, { id: 'out', folder: '/out', repo: null }], repoUsed: { '/c': 50 } });
  const sections = model.sections(view);
  assert.deepEqual(sections.open.map((g) => g.key), ['/a', '/z', '<other>']);
  assert.deepEqual(sections.other.map((g) => g.key), ['/c', '/b']);
  assert.deepEqual(repos.map((r) => r.name), ['z', 'b', 'a', 'c']);
});

test('groups expand when a tab first opens in them and collapse when their last tab closes', () => {
  const keys = (set) => [...set].sort();
  // The first time, the groups without a tab collapse, even those the last run left expanded.
  let expanded = model.followOpenTabs(new Set(['/old', '/open']), null, new Set(['/open', '/new']));
  assert.deepEqual(keys(expanded), ['/new', '/open']);
  // One collapsed by hand while open stays collapsed; one expanded by hand without a tab stays expanded.
  expanded.delete('/open');
  expanded.add('/browsed');
  expanded = model.followOpenTabs(expanded, new Set(['/open', '/new']), new Set(['/open', '/new']));
  assert.deepEqual(keys(expanded), ['/browsed', '/new']);
  // The last tab of '/new' closes and a tab opens in '/other'.
  const before = new Set(expanded);
  expanded = model.followOpenTabs(expanded, new Set(['/open', '/new']), new Set(['/open', '/other']));
  assert.deepEqual(keys(expanded), ['/browsed', '/other']);
  assert.deepEqual(keys(before), ['/browsed', '/new'], 'the given set is not changed');
});

test('folder rows merge saved or live worktrees with open tabs and use the live branch', () => {
  const view = state({ tabs: [{ id: 'main', folder: '/repo', repo: '/repo', branch: 'new' }, { id: 'added', folder: '/repo-new', repo: '/repo', branch: 'topic' }], savedWorktrees: new Map([['/repo', [{ path: '/repo', branch: 'old', main: true }]]]) });
  const group = model.groups(view)[0];
  let rows = model.foldersOf(view, group);
  assert.equal(rows.length, 2);
  assert.equal(model.branchOf(rows[0]), 'new');
  assert.equal(model.folderName(rows[0]), 'primary');
  assert.equal(model.folderName(rows[1]), 'new');
  view.worktrees.set('/repo', { items: [{ path: '/repo-live', branch: 'live' }] });
  rows = model.foldersOf(view, group);
  assert.deepEqual(rows.map((r) => r.path), ['/repo-live', '/repo', '/repo-new']);
});

test('filters show matching conversations and owners while retaining row metadata', () => {
  const view = state({ filter: 'needle', tabs: [{ id: 'tab', repo: '/repo', folder: '/repo', conversations: [{ title: 'Needle result', prompt: 'prompt' }, { title: 'Hidden' }] }], uncloned: [{ key: 'org', owner: 'Org', host: 'github.com', type: 'org', repos: [{ name: 'One', description: 'needle description' }, { name: 'Two' }] }] });
  const shown = model.shownGroups(view, model.groups(view));
  assert.equal(shown[0].expanded, true);
  assert.equal(shown[0].entries[0].conversations.length, 1);
  assert.equal(model.shownOwners(view)[0].repos.length, 1);
  assert.equal(model.shownOwners(view)[0].expanded, true);
  assert.equal(model.badgeOf({ server: 'running', agent: 'done', unread: false }), 'idle');
  assert.equal(model.conversationBadge({ state: 'done', unread: true }), 'done');
});

test('sections sort names as Japanese, ignoring case and width, and keep each group\'s tabs in order', () => {
  const names = ['beta', 'Alpha', 'ｇａｍｍａ', 'あいう', 'アイウエ', 'alpha2', 'Delta', '漢字'];
  const view = state({
    repos: names.map((name) => ({ path: `/r/${name}`, name, git: true })),
    tabs: [{ id: 't2', folder: '/r/beta-2', repo: '/r/beta' }, { id: 't1', folder: '/r/beta-1', repo: '/r/beta' }],
  });
  const { open, other } = model.sections(view);
  assert.deepEqual(open.map((group) => group.tabs.map((tab) => tab.id)), [['t2', 't1']]);
  const expected = names.filter((name) => name !== 'beta').sort((a, b) => a.localeCompare(b, 'ja', { sensitivity: 'base' }));
  assert.deepEqual(other.map((group) => group.name), expected);
});

test('subagents follow their parent one level in, and orphans stay at the top', () => {
  const rows = [
    { id: 'a', threadId: 'a' }, { id: 'b', threadId: 'b' },
    { id: 'a1', threadId: 'a1', subagent: true, parentThreadId: 'a' },
    { id: 'a1x', threadId: 'a1x', subagent: true, parentThreadId: 'a1' },
    { id: 'orphan', threadId: 'orphan', subagent: true, parentThreadId: 'gone' },
    { id: 'p', threadId: 'p', subagent: true, parentThreadId: 'q' }, { id: 'q', threadId: 'q', subagent: true, parentThreadId: 'p' },
  ];
  assert.deepEqual(model.nestConversations(rows).map(({ conversation, depth }) => `${conversation.id}:${depth}`),
    ['a:0', 'a1:1', 'a1x:2', 'b:0', 'orphan:0', 'p:0', 'q:1']);
  assert.equal(model.conversationName({ subagent: true, agentPath: '/root/review_docs' }), 'review_docs');
});
