// Side bar: one tree of the repositories and their worktrees. A worktree open in a tab shows
// the tab's code-server and Claude state, with a row for each Claude conversation under it. Its
// text is in the UI language: `t` and `listText` come from src/i18n/page.js.
const LABELS = {
  starting: t('Starting'),
  sleeping: t('Suspended'),
  stopped: t('Stopped'),
  error: t('Error'),
  waiting: t('Waiting for approval'),
  working: t('Working'),
  done: t('Done'),
  idle: t('Idle'),
  closed: t('Not open'),
};
// What a row waiting for an answer says at its right end, short so that the name keeps its room;
// its title has the whole state.
const WAITING_SHORT = t('Waiting');
const SOURCE_LABELS = { ghq: 'ghq', config: t('Added by hand'), open: t('Open tab') };
// A folder in WSL: \\wsl.localhost\<distribution>\... (or \\wsl$\...).
const WSL_PATH = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]+([^\\/]+)/i;
// The main worktree's row name. Its folder is the repository itself, so the folder name would
// only repeat the repository's, and "main" would read as the branch.
const PRIMARY = 'primary';
// The group of open folders outside any git repository.
const OTHER_KEY = '<other>';
// Most urgent first: the dot of a collapsed group shows this among its open tabs.
// The buttons under an open repository. The pull request of a branch is on its worktree's row.
const GITHUB_BUTTONS = [
  { page: 'repo', icon: 'repo', title: t('Open the repository on GitHub') },
  { page: 'issues', icon: 'issues', title: 'Issues' },
  { page: 'pulls', icon: 'pulls', title: 'Pull requests' },
  { page: 'actions', icon: 'actions', title: 'Actions' },
];
// The pull request of a worktree's branch (see readPulls in github.js): its state, in GitHub's
// icon and color for it, and what its checks came to (labels in checks.js).
const PULL_STATES = {
  draft: { icon: 'pullDraft', label: t('Draft') },
  open: { icon: 'pulls', label: t('Open') },
  merged: { icon: 'pullMerged', label: t('Merged') },
  closed: { icon: 'pullClosed', label: t('Closed') },
};
const CHECK_ICONS = { success: 'checkPassed', failure: 'checkFailed', pending: 'checkPending' };
// Who can see a repository on GitHub (see readVisibilities in main.js). A private one and an
// internal one have a mark on their row, as GitHub marks a private one with a lock; a public one
// only says so in the row's title.
const VISIBILITIES = {
  public: { label: t('Public') },
  private: { icon: 'lock', label: t('Private') },
  internal: { icon: 'building', label: t('Internal (visible within the enterprise)') },
};
// Where a repository's remote is (see readRemotes in github.js), at the head of its row: the
// service's logo, or a repository for another remote or none. Until it is known, a repository
// too; a folder outside git has a folder.
const PROVIDERS = {
  github: { logo: 'github', label: 'GitHub' },
  gitlab: { logo: 'gitlab', label: 'GitLab' },
  bitbucket: { logo: 'bitbucket', label: 'Bitbucket' },
  other: { label: t('Remote: not GitHub, GitLab, or Bitbucket') },
  none: { label: t('No remote') },
};

const state = {
  tabs: [],
  tabsKnown: false,
  repos: [],
  // Whether the main process has sent the repository list once: until then it is empty because
  // it is being read, not because there are none.
  reposKnown: false,
  // repo key -> { status: 'loading' | 'ready' | 'error', items, error }
  worktrees: new Map(),
  // repo key -> the worktrees of the last run (repos.json), shown until they are read again.
  savedWorktrees: new Map(),
  // repo key -> the repository on GitHub ({ url, slug, defaultBranch, ... }), null outside
  // GitHub, or undefined while it is read (see loadGithub).
  github: new Map(),
  // repo key -> where its remote is ('github', 'gitlab', 'bitbucket', 'other', 'none'), from the
  // main process, which reads the remotes of all the repositories, collapsed or not
  // (readVisibilities in main.js); absent while not known.
  providers: {},
  // repo key -> the pull requests of its worktrees' branches (see loadPulls).
  pulls: new Map(),
  // repo key -> when the repository last had a tab open (ms), from the main process.
  repoUsed: {},
  // repo key -> who can see it on GitHub ('public' | 'private' | 'internal'), from the main
  // process; absent while not known.
  visibility: {},
  // repo key -> the pull requests of one's own approved and not merged ([{ number, title, url }]),
  // from the main process (readApproved in main.js); absent for a repository with none.
  approved: {},
  expanded: new Set(loadStored('expanded', [])),
  // The folded sections of the tree: 'open', 'other', 'uncloned'. The one of the repositories not
  // cloned is folded unless it was unfolded: there may be hundreds.
  folded: new Set([...loadStored('foldedSections', []), ...(loadStored('unclonedFolded', true) ? ['uncloned'] : [])]),
  // The repositories of the accounts gh is signed in to that are not cloned, by owner
  // (unclonedGroups in clone.js), from the main process.
  uncloned: [],
  // Owners (host/owner, lowercase) whose row was expanded or collapsed against the default: one's
  // own account is expanded, an organization collapsed (it may have hundreds).
  ownersToggled: new Set(loadStored('ownersToggled', [])),
  // Repositories of the accounts being cloned (their keys).
  cloning: new Set(),
  // Groups (repositories, and OTHER_KEY) that held an open tab at the last update; a group is
  // expanded automatically only when a tab first opens in it, so collapsing it by hand sticks.
  openRepos: new Set(),
  filter: '',
  // Updates of code-server and the extensions: { status, items, detail, busy } (see main.js).
  update: null,
  // A new version of Worktabs itself: { status, version, from, detail, busy } (self-update.js).
  appUpdate: null,
  // Worktrees being removed (lowercase folder paths).
  removing: new Set(),
  // Provider-specific usage views from the main process. Both percentages mean used.
  usage: [],
  codexUsage: null,
  claudeUsage: null,
  // The conversations waiting and working, for the badges at the top.
  counts: { waiting: 0, working: 0 },
  // Whether the refresh button is reading the lists again.
  refreshing: false,
  // Whether the main process is reading the repository list again (at start, after adding a
  // repository), and the number of its last word on the list (see takeRepoMessage).
  readingRepos: false,
  repoSeq: 0,
};

const AGENT_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const updateEl = document.getElementById('update');
const appUpdateEl = document.getElementById('app-update');
const filterEl = /** @type {HTMLInputElement} */ (document.getElementById('filter'));
const usageEl = document.getElementById('usage');

// Paths compare case-insensitively, with either slash and without a trailing one (model.js).
const { keyOf, basename, dirname, pathKey, isInside } = sidebarModel;

// Which pull requests and checks the rows show (pulls.js).
const { approvedOf, hasBranchPage, madeFrom, pullBranches, pullOf, pullChecks, headChecks, checksRunning } =
  createPullSelectors({ state, model: sidebarModel, checks: { recentChecks, ownChecks } });

// What is expanded or folded is a per-viewer convenience; storage may be unavailable. A value
// missing or of another type than the fallback gives the fallback.
function loadStored(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return typeof value === typeof fallback && Array.isArray(value) === Array.isArray(fallback) ? value : fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisted; the tree still works for this session.
  }
}

function saveExpanded() {
  store('expanded', [...state.expanded]);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The line icons and the logos (icons.js).
const { icon, logo, agentIcon } = createIcons({ document });

// A button on a row, shown while the mouse is over it.
function rowButton(name, title, onClick) {
  const button = el('button', 'gh');
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.append(icon(name));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

// What a badge shows: the server state until it runs, then the Claude state. "Done" stays
// green only until the tab has been looked at.
function badgeOf(tab) {
  return sidebarModel.badgeOf(tab);
}

function conversationBadge(conversation) {
  return sidebarModel.conversationBadge(conversation);
}

// The name a conversation row shows: the title on its Claude tab, else its last prompt.
function conversationName(conversation) {
  return sidebarModel.conversationName(conversation, conversation.subagent ? t('Subagent') : t('New conversation'));
}

function matches(...texts) {
  return sidebarModel.matches(state, ...texts);
}

// ---- Groups: repositories, and open folders outside git ---------------------------------

// The key of the group a tab shows in: its repository's; outside git, the listed folder of
// another version control system (a ghq checkout of svn, say) it is in, else the group of other
// folders. Undefined while its repository is still being looked up.
function groupKeyOf(tab) {
  return sidebarModel.groupKeyOf(state, tab);
}

// The catalog plus the repositories of open tabs that are not in it, and a group for open
// folders outside git. `tabs` are the group's open tabs; `git` is false for a folder of another
// version control system, which has no worktrees and opens as it is. A tab whose repository is
// still being looked up waits outside every group.
function groups() {
  return sidebarModel.groups(state, t('Other folders'));
}

// The two sections of the tree. `open`: the groups with open tabs, the repositories by name
// (switching tabs does not reorder them) and then the folders outside git. `other`: the
// repositories without one, those open most recently first, then those never opened by name.
function sections() {
  return sidebarModel.sections(state, t('Other folders'));
}

// Reads a repository's worktrees. The rows it had (at start, those of the last run) stay until
// the new list arrives. Resolves once it has; a read already under way is not started again.
function loadWorktrees(repo) {
  return data.worktrees(repo);
}

// The expanded repositories, or those of them among `paths`.
function expandedRepos(paths = null) {
  return sidebarModel.expandedRepos(state, paths);
}

// Reads the worktrees of the expanded repositories again, or of those among `paths`. Resolves
// once they are read.
function loadExpandedWorktrees(paths = null) {
  return Promise.all(expandedRepos(paths).map((group) => loadWorktrees(group)));
}

function toggle(group) {
  if (state.expanded.has(group.key)) state.expanded.delete(group.key);
  else {
    state.expanded.add(group.key);
    // Read on every expand, for worktrees made or removed outside the app, and pull requests
    // made or merged meanwhile.
    if (group.git) loadWorktrees(group).then(() => loadPulls(group, 'stale'));
  }
  saveExpanded();
  render();
}

// The folders under a group: a repository's worktrees ({ path, branch, main }), or a folder of
// another version control system itself, then its open tabs that the list lacks (a folder inside
// a worktree, or a worktree made since the list was read). `tab` is the tab open on the folder,
// if any; `repo` the group's repository (null outside git).
function foldersOf(group) {
  return sidebarModel.foldersOf(state, group);
}

// A worktree next to its repository and named <repository>-<name>, as the side bar makes them,
// shows as <name>: the repository's name is on the row above.
function shortName(folderPath, repoPath) {
  return sidebarModel.shortName(folderPath, repoPath);
}

function folderName(folder) {
  return sidebarModel.folderName(folder);
}

// The open tab's branch is read again when it may have changed; the list's only on a reload.
function branchOf(folder) {
  return sidebarModel.branchOf(folder);
}

function mostUrgent(tabs) {
  return sidebarModel.mostUrgent(tabs);
}

// ---- Rows -------------------------------------------------------------------------------


// Where a repository in the list came from: "wsl:<distribution>" is ghq in that distribution.
function sourceLabel(source) {
  const wsl = /^wsl:(.+)$/i.exec(source);
  return wsl ? t('ghq (WSL: {distro})', { distro: wsl[1] }) : SOURCE_LABELS[source] || source;
}

// Where a repository's remote is (PROVIDERS), as the main process read it, or as loadGithub did
// once it expanded; undefined until either knows, and for a folder outside git.
function providerOf(group) {
  if (!group.git) return undefined;
  const github = state.github.get(group.key);
  return PROVIDERS[state.providers[group.key] || (github ? 'github' : '')];
}


// The lines of a title that name the pull requests approved and not merged.
function approvedLines(pulls) {
  return [t('PRs approved but not merged:'), ...pulls.map((pull) => `#${pull.number} ${pull.title}`)];
}


// How long the tree takes no clicks once a group's tabs have closed (closeAll).
const CLOSE_ALL_PAUSE = 600;
// Whether a group's tabs are being closed, and when they last were.
let closingAll = false;
let closedAllAt = 0;


// With its tabs gone, the group leaves the open section, and the rows below move up under the
// mouse: the one that comes to its place has buttons of its own there, this one too if it has
// open tabs. So the tree takes no clicks while the tabs close and for a moment after, and the
// second click of a double click does nothing.
async function closeAll(group) {
  if (closingAll) return;
  closingAll = true;
  try {
    if (await window.host.closeTabs(group.path, group.tabs.map((tab) => tab.id))) closedAllAt = Date.now();
  } catch {
    // Nothing closed.
  } finally {
    closingAll = false;
  }
}

function pausedAfterClose() {
  return closingAll || Date.now() - closedAllAt < CLOSE_ALL_PAUSE;
}


// The worktree a conversation works in when Claude has moved on from its tab's folder to
// another one (its panel stays in the tab's VS Code): that worktree's row name, else null.
function movedTo(tab, conversation) {
  if (!conversation.cwd) return null;
  const listed = (tab.repo && state.worktrees.get(keyOf(tab.repo))?.items) || [];
  const open = state.tabs.map((t) => ({ path: t.folder, main: Boolean(t.repo) && keyOf(t.folder) === keyOf(t.repo) }));
  const here = [...listed, ...open]
    .filter((folder) => isInside(conversation.cwd, folder.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!here) return isInside(conversation.cwd, tab.folder) ? null : basename(conversation.cwd);
  if (pathKey(here.path) === pathKey(tab.folder)) return null;
  // "primary" names the main worktree of the tab's own repository only.
  return here.main && tab.repo && pathKey(here.path) === pathKey(tab.repo) ? PRIMARY : shortName(here.path, tab.repo);
}


// The times on the conversation rows move on with the clock. Only their text changes: the rows
// are made again only when the main process sends an update.
function tickElapsed() {
  const now = Date.now();
  for (const span of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.elapsed'))) {
    const text = elapsedText(span.dataset.state, Number(span.dataset.since), now);
    if (span.textContent !== text) span.textContent = text;
  }
}


// ---- Tree -------------------------------------------------------------------------------

// A folder with the conversations to show under it, or null when the filter hides it.
// The groups of a section that the filter leaves, with the folders to show under each.
function shownGroups(list) {
  return sidebarModel.shownGroups(state, list, t('New conversation'));
}

// A group's rows. Each conversation gets a row under its worktree, even when it is the only
// one, so the rows look the same however many there are, and one that finished is not hidden
// behind another that works. A repository's icon brings up its GitHub buttons, unless it is known
// to be outside GitHub: by loadGithub once expanded, else by the main process. Folders outside
// git have none.
function groupRows({ group, entries, expanded }) {
  const github = group.git ? state.github.get(group.key) : null;
  const provider = state.providers[group.key];
  const outside = github === null || (github === undefined && provider !== undefined && provider !== 'github');
  const rows = [renderGroup(group, expanded, !outside)];
  if (!expanded) return rows;
  // The worktree rows need it too, for their pull requests.
  if (group.git) {
    loadGithub(group);
    loadPulls(group);
  }
  for (const { folder, conversations } of entries) {
    rows.push(renderFolder(folder, group.other), ...sidebarModel.nestConversations(conversations)
      .map(({ conversation, depth }) => renderConversation(folder.tab, conversation, depth)));
  }
  if (!group.git) return rows;
  const loaded = state.worktrees.get(group.key);
  if (loaded && loaded.status === 'error') rows.push(el('div', 'row empty', t('Cannot read: {error}', { error: loaded.error })));
  else if (!entries.length) rows.push(el('div', 'row empty', !loaded || loaded.status === 'loading' ? t('Loading…') : t('No worktrees')));
  return rows;
}

function renderTree() {
  const { open, other } = sections();
  renderSection('open', shownGroups(open));
  renderSection('other', shownGroups(other));
  unclonedSection.render();
}

// A section: the groups with open tabs ('open'), or the other repositories ('other'). It folds
// from its heading, and opens up while filtering. Folded, the open
// one's heading shows the most urgent state of its tabs. The open one is hidden while nothing is
// open, the other one only when the filter leaves nothing in it (empty otherwise, it says so).
function renderSection(name, shown) {
  const open = name === 'open';
  const expanded = !state.folded.has(name) || Boolean(state.filter);
  const rows = expanded ? shown.flatMap(groupRows) : [];
  if (!open && expanded && !state.reposKnown && state.readingRepos) {
    rows.push(el('div', 'row empty', t('Loading…')));
  }
  if (!open && expanded && nothingYet()) {
    rows.push(el('div', 'row empty', t('No repositories yet. Add one with "Add repository…" under "＋" at the top, or open a folder with "Open folder…".')));
  }
  document.getElementById(`${name}-tree`).replaceChildren(...rows);
  document.getElementById(`${name}-toggle`).setAttribute('aria-expanded', String(expanded));
  document.getElementById(`${name}-count`).textContent = String(shown.length);
  document.getElementById(`${name}-section`).hidden = open ? !shown.length : Boolean(state.filter) && !shown.length;
  if (!open) return;
  const dot = document.getElementById('open-dot');
  const badge = !expanded && mostUrgent(shown.flatMap((s) => s.group.tabs));
  dot.hidden = !badge;
  if (badge) {
    dot.className = `dot ${badge}`;
    dot.title = LABELS[badge];
  }
}

// Whether the list has nothing at all to show, once it has been read: no repository and no tab.
// The other repositories' section then says how to add one, for someone who starts without ghq.
function nothingYet() {
  return state.reposKnown && !state.readingRepos && !state.filter && !state.repos.length && !state.tabs.length;
}

function toggleSection(name) {
  if (!state.folded.delete(name)) state.folded.add(name);
  saveFolded();
  render();
}

// The section of the repositories not cloned is kept apart, as it is folded by default.
function saveFolded() {
  store('foldedSections', [...state.folded].filter((name) => name !== 'uncloned'));
  store('unclonedFolded', state.folded.has('uncloned'));
}

// A tab opened from the side bar goes to the open section, which is unfolded to show it.
function unfoldOpenSection() {
  if (state.folded.delete('open')) saveFolded();
}

// ---- Repositories not cloned ------------------------------------------------------------

// The section's rows are in uncloned.js; which owners are expanded is stored with the rest here.

function toggleOwner(group) {
  if (!state.ownersToggled.delete(group.key)) state.ownersToggled.add(group.key);
  store('ownersToggled', [...state.ownersToggled]);
  render();
}

// The owners the filter leaves, with the repositories to show under each: all of those of an
// owner whose name (or host) matches, else those whose name or description does. An owner opens
// up while filtering when repositories of its own matched.
function shownOwners() {
  return sidebarModel.shownOwners(state);
}


// ---- GitHub -----------------------------------------------------------------------------

// Reads once whether a repository is on GitHub, when it is first expanded: its pages do not
// depend on the branch, and the remote seldom changes (it is read again on "Refresh list").
function loadGithub(group) {
  return data.github(group);
}

// The bar of a repository's GitHub pages, under its icon (github-bar.js).
const githubBar = createGithubBar({
  barEl: document.getElementById('gh-bar'), reposEl: document.getElementById('repos'), state, host: window.host,
  dom: { el, icon }, t, buttons: GITHUB_BUTTONS, groups, load: loadGithub, approvedOf, hoverIntent, document, window,
});

// ---- Pull requests ----------------------------------------------------------------------

// Reads the pull requests of a repository's branches, once it is known to be on GitHub, if
// its branches or HEADs changed since the last read, or by `when`: 'stale', also when the last
// read is 15 seconds old; 'now', also when it is not. A read under way for the same ones is not
// started again.
function loadPulls(group, when = 'changed') {
  return data.pulls(group, when);
}

function forgetPulls() {
  return data.forgetPulls();
}

// ---- Updates and subscription usage ----------------------------------------------------

const updateCard = createUpdateCard({ element: updateEl, host: window.host, dom: { el }, t, listText });
const appUpdateCard = createAppUpdateCard({ element: appUpdateEl, host: window.host, dom: { el }, t, listText });
const usageFooter = createUsageFooter({ element: usageEl, dom: { el }, t });

// ---- Top --------------------------------------------------------------------------------

const summaryEl = document.getElementById('summary');
const refreshEl = document.getElementById('refresh');
let shownCounts;

// A badge for the conversations waiting for an answer and one for those working, in their
// states' colors, each without a count of 0. What a number counts is in its title and in text
// for screen readers. A click brings the next of them to the front (revealNext in main.js). The
// badges are made again only when a count changes, so the live region does not repeat itself
// and a badge keeps the focus.
function renderSummary() {
  const key = JSON.stringify(state.counts);
  if (key === shownCounts) return;
  shownCounts = key;
  summaryEl.replaceChildren(
    ...['waiting', 'working'].filter((name) => state.counts[name]).map((name) => {
      const count = state.counts[name];
      const button = el('button', `count-badge ${name}`);
      button.type = 'button';
      button.title =
        name === 'waiting'
          ? `${t('Waiting for approval {count}', { count })}\n${t('Click to go through the conversations waiting for approval')}`
          : `${t('Working {count}', { count })}\n${t('Click to go through the working conversations')}`;
      button.append(el('span', 'visually-hidden', LABELS[name]), String(count));
      button.addEventListener('click', () => window.host.revealNext(name));
      return button;
    }),
  );
}

// Reads the repositories again (ghq, ghq in WSL and the configured ones), and with them the
// worktrees, GitHub remotes and pull requests of the expanded ones. The button turns until they are read, for a
// moment at least, so a quick read still shows.
async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  renderRefresh();
  const moment = new Promise((resolve) => setTimeout(resolve, 600));
  try {
    takeRepoMessage(await window.host.refreshRepos());
    // Remotes are read again as the repositories expand (see loadGithub), and with them the
    // pull requests.
    data.forgetGithub();
    forgetPulls();
    render();
    await loadExpandedWorktrees();
  } catch {
    // The list stays as it was.
  }
  await moment;
  state.refreshing = false;
  renderRefresh();
}

// The button also turns while the main process reads the list on its own.
function renderRefresh() {
  const busy = state.refreshing || state.readingRepos;
  refreshEl.classList.toggle('spinning', busy);
  refreshEl.setAttribute('aria-busy', String(busy));
  refreshEl.title = busy ? t('Refreshing the repository list…') : t('Refresh the repository list');
}

// ---- Page -------------------------------------------------------------------------------

// Every render makes the rows and buttons again, and a click on one made again between its press
// and its release would be lost: while a pointer is pressed on the page, renders wait until it is
// let go (pressHold in press.js). The asks come in bursts, so they render once a frame.
const renders = pressHold(renderNow);
// Row actions stay in the page; renderers do not start reads or own interaction timers.
const { renderGroup, renderFolder, renderConversation, visibilityMark } = createSidebarRows({
  state, host: window.host, dom: { el, icon, logo, agentIcon, rowButton },
  select: { sourceLabel, providerOf, approvedOf, approvedLines, mostUrgent, folderName, branchOf,
    badgeOf, pullOf, madeFrom, headChecks, hasBranchPage, conversationBadge, conversationName,
    movedTo, pullChecks, checkLabel, checksLines, sinceText, elapsedText, keyOf },
  actions: { closeAll, toggle, unfoldOpenSection },
  text: { LABELS, WAITING_SHORT, WSL_PATH, VISIBILITIES, PULL_STATES, CHECK_ICONS, AGENT_LABELS }, t,
});

// The section of the repositories not cloned (uncloned.js).
const unclonedSection = createUnclonedSection({
  state, host: window.host, document, dom: { el, icon, logo, rowButton },
  select: { shownOwners, visibilityMark }, actions: { toggleOwner }, visibilities: VISIBILITIES, t,
});

const data = new SidebarData({ state, host: window.host, changed: render, groups, pullBranches, checksRunning });
window.addEventListener('beforeunload', () => data.dispose());

function render() {
  renders.request();
}

function renderNow() {
  appUpdateCard.render(state.appUpdate);
  updateCard.render(state.update);
  usageFooter.render(state);
  renderSummary();
  renderTree();
  githubBar.place();
}

// Expands (and reads) a group when a tab first opens in it.
function expandGroupsOfNewTabs() {
  const open = new Set(state.tabs.map(groupKeyOf).filter((key) => key !== undefined));
  for (const key of open) {
    if (state.openRepos.has(key)) continue;
    state.expanded.add(key);
    const group = groups().find((g) => g.key === key);
    if (group && group.git) loadWorktrees(group);
  }
  state.openRepos = open;
  saveExpanded();
}

function takeTabState(tabState) {
  state.tabsKnown = true;
  state.tabs = tabState.tabs;
  state.update = tabState.update;
  state.appUpdate = tabState.appUpdate || null;
  state.removing = new Set(tabState.removing);
  state.cloning = new Set(tabState.cloning || []);
  state.repoUsed = tabState.repoUsed;
  state.usage = tabState.usage || [];
  state.codexUsage = tabState.codexUsage || null;
  state.claudeUsage = tabState.claudeUsage || null;
  state.counts = tabState.counts || { waiting: 0, working: 0 };
  applyTheme(tabState.theme || null);
}

// Takes the list of repositories. Collapsed ones read their worktrees when they open; the
// expanded ones that have not read them yet read them now.
function takeRepos(repos) {
  state.repos = repos;
  state.reposKnown = true;
  for (const key of [...state.worktrees.keys()]) if (!state.expanded.has(key)) state.worktrees.delete(key);
  for (const group of groups()) {
    if (group.git && state.expanded.has(group.key) && !state.worktrees.has(group.key)) loadWorktrees(group);
  }
  render();
}

// Takes what the main process says of the repository list ({ seq, repos, reading, visibility,
// providers, uncloned, approved }), unless a later word has come first: its replies and its
// messages may cross.
function takeRepoMessage({ seq, repos, reading, visibility, providers, uncloned, approved }) {
  if (seq <= state.repoSeq) return;
  state.repoSeq = seq;
  state.readingRepos = reading;
  state.visibility = visibility || {};
  state.providers = providers || {};
  state.uncloned = uncloned || [];
  state.approved = approved || {};
  renderRefresh();
  // null while the first start reads it.
  if (repos) takeRepos(repos);
  else render();
}

// ---- Width and theme -------------------------------------------------------------------

// The right edge drags to change the side bar's width (resize.js).
attachSidebarResize({ edge: document.getElementById('edge'), host: window.host, window, document });
// The colors of the VS Code theme in the tab in front (page-theme.js).
const applyTheme = createPageTheme({ document, window });

// A tab opened on a folder the list lacks shows under its repository anyway (see foldersOf),
// and the list is read again when the window comes to the front or a Claude turn ends.
window.host.onUpdate((tabState) => {
  takeTabState(tabState);
  expandGroupsOfNewTabs();
  render();
});

window.host.onRepos((message) => takeRepoMessage(message));
// A press anywhere on the page, so the update's buttons and the badges at the top keep their
// clicks too. Only the window's own blur: an element's does not bubble. A right click makes no
// click, and on macOS its menu comes up on the press and takes the release.
window.addEventListener('pointerdown', () => renders.press());
for (const name of ['pointerup', 'pointercancel', 'contextmenu', 'blur']) window.addEventListener(name, () => renders.release());
// The rows move under the mouse as a group's tabs close (see closeAll): before the buttons and
// the rows hear of the click.
document.getElementById('repos').addEventListener(
  'click',
  (event) => {
    if (!pausedAfterClose()) return;
    event.stopPropagation();
    event.preventDefault();
  },
  true,
);
// Often enough that a row shows the next minute soon after it has begun.
setInterval(tickElapsed, 10 * 1000);

// A reload for some repositories follows something done in them (a Claude turn ended, a worktree
// was added or removed), so their pull requests are read at once too; one for all of them follows
// the window coming to the front (see loadPulls).
window.host.onReloadWorktrees(async (paths) => {
  await loadExpandedWorktrees(paths);
  for (const group of expandedRepos(paths)) loadPulls(group, paths ? 'now' : 'stale');
});
// A worktree added in the dialog opens as a tab under its repository, which is shown.
window.host.onWorktreeAdded((repo) => {
  unfoldOpenSection();
  if (!state.expanded.has(keyOf(repo))) {
    state.expanded.add(keyOf(repo));
    saveExpanded();
  }
  const group = groups().find((g) => g.key === keyOf(repo));
  if (group && group.git) loadWorktrees(group);
  else render();
});
// A repository just cloned is one of the other repositories now: that section unfolds, and the
// repository expands to show its primary, which is scrolled to.
window.host.onCloned(async (repo) => {
  if (state.folded.delete('other')) saveFolded();
  if (!state.expanded.has(keyOf(repo))) {
    state.expanded.add(keyOf(repo));
    saveExpanded();
  }
  const group = groups().find((g) => g.key === keyOf(repo));
  if (group && group.git) await loadWorktrees(group);
  else render();
  renders.flush();
  const row = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.row.repo[data-repo]'))].find((r) => keyOf(r.dataset.repo) === keyOf(repo));
  if (row) row.scrollIntoView({ block: 'nearest' });
});

filterEl.addEventListener('input', () => {
  state.filter = filterEl.value.trim();
  render();
});
filterEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    filterEl.value = '';
    state.filter = '';
    render();
  }
});
for (const [id, name, onClick] of /** @type {Array<[string, string, () => void]>} */ ([
  ['refresh', 'refresh', () => refresh()],
  ['add', 'add', () => window.host.showAddMenu()],
  ['settings', 'settings', () => window.host.showSettings()],
  ['more', 'more', () => window.host.showMoreMenu()],
])) {
  const button = document.getElementById(id);
  button.append(icon(name));
  button.addEventListener('click', onClick);
}
for (const name of ['open', 'other', 'uncloned']) document.getElementById(`${name}-toggle`).addEventListener('click', () => toggleSection(name));

// A startup reply may arrive after a live update restored or closed tabs. Keep that newer
// state, and do not wait for the repository catalog before showing open tabs.
window.host.getState().then((tabState) => {
  if (state.tabsKnown) return;
  takeTabState(tabState);
  expandGroupsOfNewTabs();
  render();
});
// The list of the last run comes at once; the main process reads it again meanwhile.
window.host.getRepos().then((saved) => {
  state.savedWorktrees = new Map(Object.entries(saved.worktrees || {}));
  takeRepoMessage(saved);
  expandGroupsOfNewTabs();
  render();
});
