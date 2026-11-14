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

test('sections order the groups under an owner by name, not by recent use, without mutating the catalog', () => {
  const repos = ['z', 'b', 'a', 'c'].map((name) => ({ name, path: `/${name}`, git: true }));
  const view = state({ repos, tabs: [{ id: 'z', folder: '/z', repo: '/z' }, { id: 'a', folder: '/a', repo: '/a' }, { id: 'out', folder: '/out', repo: null }], repoUsed: { '/c': 50 } });
  const sections = model.sections(view, 'Other folders', 'No owner');
  // None of them has an owner: they share the row of those without one.
  assert.deepEqual(sections.open.map((o) => [o.key, o.owner, o.none]), [['<none>', 'No owner', true]]);
  assert.deepEqual(sections.open[0].groups.map((g) => g.key), ['/a', '/z', '<other>']);
  assert.deepEqual(sections.other[0].groups.map((g) => g.key), ['/b', '/c']);
  assert.deepEqual(repos.map((r) => r.name), ['z', 'b', 'a', 'c']);
});

test('a repository\'s owner comes from its remote, else from its ghq folder, else it has none', () => {
  // ghq's layout: <root>/<host>/<owner>/<name>, in Windows, in WSL, and on mac.
  assert.deepEqual(model.ghqOwner('C:\\ghq\\github.com\\Acme\\tool'), { host: 'github.com', owner: 'Acme' });
  assert.deepEqual(model.ghqOwner('\\\\wsl.localhost\\Ubuntu\\home\\me\\ghq\\GitHub.com\\acme\\api'), { host: 'github.com', owner: 'acme' });
  assert.deepEqual(model.ghqOwner('/Users/me/ghq/gitlab.example.com/team/app'), { host: 'gitlab.example.com', owner: 'team' });
  // A folder elsewhere is not taken for one: its grandparent is not named as a host is.
  assert.equal(model.ghqOwner('C:\\project\\novel-writing'), null);
  assert.equal(model.ghqOwner('C:\\Users\\me\\src\\novel-writing'), null);
  assert.equal(model.ghqOwner('/github.com/o/r'), null, 'no root above the host');

  const novel = { path: 'C:\\project\\novel-writing', name: 'novel-writing', owner: 'project', git: true };
  const ghq = { path: 'C:\\ghq\\github.com\\acme\\tool', name: 'tool', owner: 'acme', git: true };
  const moved = { path: 'C:\\ghq\\github.com\\old\\renamed', name: 'renamed', owner: 'old', git: true };
  const local = { path: 'C:\\work\\scratch', name: 'scratch', owner: 'work', git: true };
  const view = state({
    repos: [novel, ghq, moved, local],
    remoteOwners: {
      'c:\\project\\novel-writing': { host: 'github.com', owner: 'sunsetoftanahlot' },
      // The remote wins over the folder: a repository moved to another owner since it was cloned.
      'c:\\ghq\\github.com\\old\\renamed': { host: 'github.com', owner: 'new' },
    },
  });
  assert.deepEqual(model.sections(view).other.map((o) => [o.key, o.groups.map((g) => g.name)]), [
    ['github.com/acme', ['tool']],
    ['github.com/new', ['renamed']],
    // Under its remote's owner, not "project".
    ['github.com/sunsetoftanahlot', ['novel-writing']],
    // Neither a remote's owner nor a ghq folder: last.
    ['<none>', ['scratch']],
  ]);
  const [, , , scratch] = model.groups(view);
  assert.equal(model.ownerKeyOf(view, scratch), '<none>');
  assert.equal(model.ownerOf(view, { other: true, key: '<other>', path: null }), null);
});

test('owners come as the repositories not cloned do: one\'s own accounts first, then the others by name', () => {
  const repo = (folder) => ({ path: folder, name: folder.split(/[\\/]/).pop(), git: true });
  const view = state({
    repos: [
      repo('C:\\ghq\\github.com\\zeta\\z1'), repo('C:\\ghq\\github.com\\Beta\\b1'), repo('C:\\ghq\\ghe.example.com\\me\\e1'),
      repo('C:\\ghq\\github.com\\me\\m2'), repo('C:\\ghq\\github.com\\me\\M1'), repo('C:\\ghq\\gitlab.com\\alpha\\a1'),
      repo('C:\\ghq\\github.com\\alpha\\a2'), repo('C:\\elsewhere\\x'), repo('C:\\ghq\\github.com\\org\\o1'),
    ],
    ownerTypes: { 'github.com/me': 'user', 'ghe.example.com/me': 'user', 'github.com/org': 'org' },
  });
  const owners = model.sections(view).other;
  assert.deepEqual(owners.map((o) => [o.key, o.type]), [
    // The accounts gh is signed in to, github.com first.
    ['github.com/me', 'user'],
    ['ghe.example.com/me', 'user'],
    // Then the others by name, organizations among them; one name on two hosts, github.com first.
    ['github.com/alpha', undefined],
    ['gitlab.com/alpha', undefined],
    ['github.com/beta', undefined],
    ['github.com/org', 'org'],
    ['github.com/zeta', undefined],
    ['<none>', undefined],
  ]);
  assert.deepEqual(owners[0].groups.map((g) => g.name), ['M1', 'm2'], 'by name, case aside');
  assert.equal(owners[4].owner, 'Beta', 'as its folder spells it');
});

test('an owner\'s repositories in Windows and in WSL share its row, and each section has its own rows', () => {
  const win = { path: 'C:\\ghq\\github.com\\acme\\tool', name: 'tool', git: true };
  const wsl = { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\ghq\\github.com\\acme\\api', name: 'api', git: true };
  const wslOpen = { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\ghq\\github.com\\acme\\web', name: 'web', git: true };
  const view = state({
    repos: [win, wsl, wslOpen],
    tabs: [{ id: 'web', folder: wslOpen.path, repo: wslOpen.path }],
    remoteOwners: { [win.path.toLowerCase()]: { host: 'github.com', owner: 'acme' } },
  });
  const { open, other } = model.sections(view);
  assert.deepEqual(other.map((o) => [o.key, o.groups.map((g) => g.name)]), [['github.com/acme', ['api', 'tool']]]);
  assert.deepEqual(open.map((o) => [o.key, o.groups.map((g) => g.name)]), [['github.com/acme', ['web']]]);
});

test('the filter matches owners, which then show all their repositories, and folded owners open up for matches', () => {
  const repo = (owner, name) => ({ path: `C:\\ghq\\ghe.example.com\\${owner}\\${name}`, name, git: true });
  const view = state({ repos: [repo('acme', 'tool'), repo('acme', 'api'), repo('other', 'toolbox'), repo('other', 'site')] });
  const shown = (filter, folded = new Set()) => {
    view.filter = filter;
    return model.shownOwnerGroups(view, model.sections(view).other, folded)
      .map(({ owner, groups, expanded }) => [owner.owner, groups.map(({ group }) => group.name), expanded]);
  };
  assert.deepEqual(shown(''), [['acme', ['api', 'tool'], true], ['other', ['site', 'toolbox'], true]]);
  assert.deepEqual(shown('', new Set(['ghe.example.com/acme'])), [['acme', ['api', 'tool'], false], ['other', ['site', 'toolbox'], true]]);
  // An owner's name shows all its repositories; the owner stays as it was.
  assert.deepEqual(shown('ACM', new Set(['ghe.example.com/acme'])), [['acme', ['api', 'tool'], false]]);
  // A repository's name shows it alone, and its owner opens up.
  assert.deepEqual(shown('tool', new Set(['ghe.example.com/acme'])), [['acme', ['tool'], true], ['other', ['toolbox'], true]]);
  // A host other than github.com matches too.
  assert.deepEqual(shown('ghe.example').map(([owner]) => owner), ['acme', 'other']);
  // The row of those without an owner is not matched by its own name.
  view.repos.push({ path: 'C:\\work\\scratch', name: 'scratch', git: true });
  view.filter = 'no owner';
  assert.deepEqual(model.shownOwnerGroups(view, model.sections(view, 'Other', 'No owner').other, new Set()), []);
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
  assert.deepEqual(open.flatMap((owner) => owner.groups).map((group) => group.tabs.map((tab) => tab.id)), [['t2', 't1']]);
  const expected = names.filter((name) => name !== 'beta').sort((a, b) => a.localeCompare(b, 'ja', { sensitivity: 'base' }));
  assert.deepEqual(other.flatMap((owner) => owner.groups).map((group) => group.name), expected);
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
