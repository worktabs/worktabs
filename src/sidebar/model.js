// Pure row and tree selectors shared by the renderer and unit tests.
const sidebarModel = (() => {
  const keyOf = (p) => p.toLowerCase();
  const basename = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
  const dirname = (p) => p.split(/[\\/]/).filter(Boolean).slice(0, -1).join('\\');
  const pathKey = (p) => keyOf(p).replace(/\//g, '\\').replace(/\\+$/, '');
  const isInside = (p, folder) => pathKey(p) === pathKey(folder) || pathKey(p).startsWith(`${pathKey(folder)}\\`);
  const PRIMARY = 'primary';
  const OTHER_KEY = '<other>';
  // The owner of the repositories whose owner is not known, and of the folders outside git.
  const NO_OWNER = '<none>';
  // A folder named as a host is (github.com, ghe.example.com), as ghq names the first folder under
  // its root (HOST_NAME in clone.js).
  const HOST_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
  // localeCompare with a locale sets up a collator on every call; sorting hundreds of
  // repositories on each render shares this one.
  const NAMES = new Intl.Collator('ja', { sensitivity: 'base' });
  const URGENCY = ['waiting', 'error', 'stopped', 'working', 'starting', 'done', 'idle', 'sleeping'];
  function tabForFolder(state, folder) {
    return state.tabs.find((tab) => keyOf(tab.folder) === keyOf(folder));
  }

  function matches(state, ...texts) {
    const filter = state.filter.toLowerCase();
    return !filter || texts.some((text) => text && text.toLowerCase().includes(filter));
  }

  function groupKeyOf(state, tab) {
    if (tab.repo === undefined) return undefined;
    if (tab.repo) return keyOf(tab.repo);
    const [home] = state.repos
      .filter((repo) => !repo.git && isInside(tab.folder, repo.path))
      .sort((a, b) => b.path.length - a.path.length);
    return home ? keyOf(home.path) : OTHER_KEY;
  }

  function groups(state, otherName = 'Other folders') {
    const repos = new Map(state.repos.map((repo) => [keyOf(repo.path), repo]));
    for (const tab of state.tabs) {
      if (tab.repo && !repos.has(keyOf(tab.repo))) {
        repos.set(keyOf(tab.repo), { path: tab.repo, name: basename(tab.repo), owner: basename(dirname(tab.repo)), git: true, sources: ['open'] });
      }
    }
    // The tabs of each group, in one pass over them (in their order).
    const tabsByKey = new Map();
    for (const tab of state.tabs) {
      const key = groupKeyOf(state, tab);
      if (!tabsByKey.has(key)) tabsByKey.set(key, []);
      tabsByKey.get(key).push(tab);
    }
    const tabsIn = (key) => tabsByKey.get(key) || [];
    const list = [...repos.values()].map((repo) => ({ ...repo, key: keyOf(repo.path), tabs: tabsIn(keyOf(repo.path)) }));
    const other = tabsIn(OTHER_KEY);
    if (other.length) list.push({ key: OTHER_KEY, other: true, git: false, path: null, name: otherName, owner: '', sources: [], tabs: other });
    return list;
  }

  // Whose a repository is by where ghq puts one (<root>/<host>/<owner>/<name>): { host, owner },
  // or null for a folder that is not so, its third name from the end not being a host's (as
  // cloneRoots in clone.js tells it). C:\project\novel-writing is not.
  function ghqOwner(folder) {
    const names = String(folder || '').split(/[\\/]/).filter(Boolean);
    const host = names[names.length - 3];
    return names.length >= 4 && HOST_NAME.test(host) ? { host: host.toLowerCase(), owner: names[names.length - 2] } : null;
  }

  // Whose a group is ({ host, owner }): its remote's owner (state.remoteOwners, from the main
  // process), else its ghq folder's, while its remote is not read or when it is not on GitHub,
  // GitLab, or Bitbucket; null for one with neither, and for the folders outside git.
  function ownerOf(state, group) {
    if (group.other) return null;
    return (state.remoteOwners || {})[group.key] || ghqOwner(group.path);
  }

  // The key of a group's owner row: host/owner, lowercase, or NO_OWNER.
  function ownerKeyOf(state, group) {
    const owner = ownerOf(state, group);
    return owner ? `${owner.host}/${owner.owner}`.toLowerCase() : NO_OWNER;
  }

  // The groups of a section under their owners' rows, ordered as those of the repositories not
  // cloned (unclonedGroups in clone.js): the accounts gh is signed in to first (github.com before
  // the other hosts), then the other owners by name, and last the row of those without one, named
  // `noOwnerName`. [{ key (ownerKeyOf), host, owner, type: 'user' for an account's own, 'org' for
  // its organizations (state.ownerTypes), else undefined; none: whether it is the last; groups }].
  // An owner's repositories in Windows and in WSL share its row. Under it, the repositories go by
  // name (they stay where they are), and the folders outside git last.
  function byOwner(state, list, noOwnerName = 'No owner') {
    const owners = new Map();
    for (const group of list) {
      const found = ownerOf(state, group);
      const key = found ? `${found.host}/${found.owner}`.toLowerCase() : NO_OWNER;
      if (!owners.has(key)) {
        owners.set(key, found
          ? { key, host: found.host, owner: found.owner, type: (state.ownerTypes || {})[key], none: false, groups: [] }
          : { key, host: '', owner: noOwnerName, type: undefined, none: true, groups: [] });
      }
      owners.get(key).groups.push(group);
    }
    const sorted = [...owners.values()];
    for (const owner of sorted) owner.groups.sort((a, b) => Number(Boolean(a.other)) - Number(Boolean(b.other)) || NAMES.compare(a.name, b.name));
    const rank = (owner) => (owner.none ? 2 : owner.type === 'user' ? 0 : 1);
    const hosts = (a, b) => Number(a.host !== 'github.com') - Number(b.host !== 'github.com') || NAMES.compare(a.host, b.host);
    return sorted.sort((a, b) => rank(a) - rank(b)
      || (rank(a) === 0 ? hosts(a, b) || NAMES.compare(a.owner, b.owner) : NAMES.compare(a.owner, b.owner) || hosts(a, b)));
  }

  // The two sections of the tree, each under its owners' rows (byOwner): the groups with open tabs
  // ('open'), and the repositories without ('other').
  function sections(state, otherName = 'Other folders', noOwnerName = 'No owner') {
    const all = groups(state, otherName);
    return {
      open: byOwner(state, all.filter((g) => g.tabs.length), noOwnerName),
      other: byOwner(state, all.filter((g) => !g.tabs.length), noOwnerName),
    };
  }

  // The groups expanded once the open tabs changed, from the groups that held an open tab before
  // (null before the tabs were first known) and those that hold one now. A group expands when a
  // tab first opens in it, so collapsing it by hand sticks while it is open, and collapses when its
  // last tab closes, so the other repositories show just their own rows. The first time, the groups
  // without a tab collapse too: the last run may have left them expanded.
  function followOpenTabs(expanded, before, now) {
    const next = new Set(expanded);
    for (const key of expanded) if (!now.has(key) && (!before || before.has(key))) next.delete(key);
    for (const key of now) if (!before || !before.has(key)) next.add(key);
    return next;
  }

  function expandedRepos(state, paths = null) {
    return groups(state).filter((group) => group.git && state.expanded.has(group.key) && (!paths || paths.some((p) => keyOf(p) === group.key)));
  }

  function foldersOf(state, group) {
    const repo = group.git ? group.path : null;
    let listed = [];
    if (group.git) listed = state.worktrees.get(group.key)?.items || state.savedWorktrees.get(group.key) || [];
    else if (!group.other) listed = [{ path: group.path, branch: null, main: false }];
    const folders = listed.map((folder) => ({ ...folder, repo, tab: tabForFolder(state, folder.path) }));
    for (const tab of group.tabs) {
      if (folders.some((folder) => keyOf(folder.path) === keyOf(tab.folder))) continue;
      folders.push({ path: tab.folder, branch: tab.branch, main: Boolean(tab.repo) && keyOf(tab.folder) === keyOf(tab.repo), repo, tab });
    }
    return folders;
  }

  function ownerExpanded(state, group) {
    return (group.type === 'user') !== state.ownersToggled.has(group.key);
  }

  function shownOwners(state) {
    const shown = [];
    for (const group of state.uncloned) {
      const ownerMatches = matches(state, group.owner, group.host === 'github.com' ? '' : group.host);
      const repos = ownerMatches ? group.repos : group.repos.filter((repo) => matches(state, repo.name, repo.description));
      if (!repos.length) continue;
      shown.push({ group, repos, expanded: ownerExpanded(state, group) || (Boolean(state.filter) && !ownerMatches) });
    }
    return shown;
  }

  function shownFolder(state, folder, groupMatches, newName = 'New conversation') {
    const conversations = folder.tab ? folder.tab.conversations : [];
    const numbered = [folder.issue, folder.pull].filter(Boolean).flatMap(({ number, title }) => [`#${number}`, title]);
    if (groupMatches || matches(state, folderName(folder), basename(folder.path), branchOf(folder), ...numbered)) return { folder, conversations };
    const hits = conversations.filter((c) => matches(state, conversationName(c, newName), c.prompt || ''));
    return hits.length ? { folder, conversations: hits } : null;
  }

  // `ownerMatches`: whether the filter matches the owner the groups are under, which shows them all.
  function shownGroups(state, list, newName = 'New conversation', ownerMatches = false) {
    const shown = [];
    for (const group of list) {
      const groupMatches = ownerMatches || matches(state, group.name, group.path);
      const entries = foldersOf(state, group).map((folder) => shownFolder(state, folder, groupMatches, newName)).filter(Boolean);
      if (!groupMatches && !entries.length) continue;
      // While filtering, groups with matching rows open up so the matches are visible.
      const expanded = state.expanded.has(group.key) || (Boolean(state.filter) && entries.length > 0);
      shown.push({ group, entries, expanded });
    }
    return shown;
  }

  // The owners of a section (byOwner) that the filter leaves, with the groups to show under each
  // (shownGroups): all of those of an owner whose name (or host) matches, as shownOwners does. An
  // owner is expanded unless folded by hand (`folded`: the keys of the section's owners folded),
  // and opens up while filtering when rows under it matched.
  function shownOwnerGroups(state, owners, folded, newName = 'New conversation') {
    const shown = [];
    for (const owner of owners) {
      const ownerMatches = Boolean(state.filter) && !owner.none && matches(state, owner.owner, owner.host === 'github.com' ? '' : owner.host);
      const list = shownGroups(state, owner.groups, newName, ownerMatches);
      if (!list.length) continue;
      shown.push({ owner, groups: list, expanded: !folded.has(owner.key) || (Boolean(state.filter) && !ownerMatches) });
    }
    return shown;
  }

  function badgeOf(tab) {
    if (tab.server !== 'running') return tab.server;
    if (tab.agent === 'done') return tab.unread ? 'done' : 'idle';
    return tab.agent || 'idle';
  }

  function conversationBadge(conversation) {
    if (conversation.state === 'done') return conversation.unread ? 'done' : 'idle';
    return conversation.state;
  }

  function conversationName(conversation, newName = 'New conversation') {
    if (conversation.subagent) {
      return conversation.agentNickname || conversation.title || conversation.agentRole
        || conversation.agentPath?.split('/').filter(Boolean).at(-1) || newName;
    }
    return conversation.title || conversation.prompt || newName;
  }

  // A tab's conversations with each subagent right after its parent, and how deep it sits. A child
  // whose parent is not in the list (archived, or hidden by the filter) stays at the top level.
  function nestConversations(conversations) {
    const byThread = new Map(conversations.filter((c) => c.threadId).map((c) => [c.threadId, c]));
    const children = new Map();
    const roots = [];
    for (const conversation of conversations) {
      const parent = conversation.subagent ? byThread.get(conversation.parentThreadId) : undefined;
      if (!parent || parent === conversation) roots.push(conversation);
      else children.set(parent, [...(children.get(parent) || []), conversation]);
    }
    const nested = [];
    const seen = new Set();
    const visit = (conversation, depth) => {
      if (seen.has(conversation)) return;
      seen.add(conversation);
      nested.push({ conversation, depth });
      for (const child of children.get(conversation) || []) visit(child, depth + 1);
    };
    for (const conversation of roots) visit(conversation, 0);
    // Parents that name each other have no root; they still get a row.
    for (const conversation of conversations) visit(conversation, 0);
    return nested;
  }

  function shortName(folderPath, repoPath) {
    const name = basename(folderPath);
    if (!repoPath || keyOf(dirname(folderPath)) !== keyOf(dirname(repoPath))) return name;
    const prefix = `${basename(repoPath)}-`.toLowerCase();
    return name.toLowerCase().startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
  }

  function folderName(folder) {
    return folder.main ? PRIMARY : shortName(folder.path, folder.repo);
  }

  function branchOf(folder) {
    return (folder.tab && folder.tab.branch) || folder.branch;
  }

  function mostUrgent(tabs) {
    return tabs.map(badgeOf).sort((a, b) => URGENCY.indexOf(a) - URGENCY.indexOf(b))[0];
  }
  return { tabForFolder, matches, groupKeyOf, groups, ghqOwner, ownerOf, ownerKeyOf, byOwner, sections, followOpenTabs, expandedRepos, foldersOf, ownerExpanded, shownOwners, shownFolder, shownGroups, shownOwnerGroups, badgeOf, conversationBadge, conversationName, nestConversations, shortName, folderName, branchOf, mostUrgent, keyOf, basename, dirname, pathKey, isInside };
})();
if (typeof module === 'object') module.exports = sidebarModel;
