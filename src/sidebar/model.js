// Pure row and tree selectors shared by the renderer and unit tests.
const sidebarModel = (() => {
  const keyOf = (p) => p.toLowerCase();
  const basename = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
  const dirname = (p) => p.split(/[\\/]/).filter(Boolean).slice(0, -1).join('\\');
  const pathKey = (p) => keyOf(p).replace(/\//g, '\\').replace(/\\+$/, '');
  const isInside = (p, folder) => pathKey(p) === pathKey(folder) || pathKey(p).startsWith(`${pathKey(folder)}\\`);
  const PRIMARY = 'primary';
  const OTHER_KEY = '<other>';
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

  function sections(state, otherName = 'Other folders') {
    const byName = (a, b) => NAMES.compare(a.name, b.name);
    const used = (group) => state.repoUsed[group.key] || 0;
    const all = groups(state, otherName);
    return {
      open: all.filter((g) => g.tabs.length).sort((a, b) => Number(Boolean(a.other)) - Number(Boolean(b.other)) || byName(a, b)),
      other: all.filter((g) => !g.tabs.length).sort((a, b) => used(b) - used(a) || byName(a, b)),
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

  function shownGroups(state, list, newName = 'New conversation') {
    const shown = [];
    for (const group of list) {
      const groupMatches = matches(state, group.name, group.owner, group.path);
      const entries = foldersOf(state, group).map((folder) => shownFolder(state, folder, groupMatches, newName)).filter(Boolean);
      if (!groupMatches && !entries.length) continue;
      // While filtering, groups with matching rows open up so the matches are visible.
      const expanded = state.expanded.has(group.key) || (Boolean(state.filter) && entries.length > 0);
      shown.push({ group, entries, expanded });
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
  return { tabForFolder, matches, groupKeyOf, groups, sections, followOpenTabs, expandedRepos, foldersOf, ownerExpanded, shownOwners, shownFolder, shownGroups, badgeOf, conversationBadge, conversationName, nestConversations, shortName, folderName, branchOf, mostUrgent, keyOf, basename, dirname, pathKey, isInside };
})();
if (typeof module === 'object') module.exports = sidebarModel;
