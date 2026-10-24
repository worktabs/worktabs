// The context menus of the side bar: its "+" and "…", tabs, repository and worktree rows, and the
// rows of the repositories not cloned. `popup` shows a template (Menu.buildFromTemplate in
// main.js), so tests read the templates instead.
const path = require('path');
const { t } = require('../i18n');
const { openAmong } = require('../tabs/tab-close');
const { parseWslPath } = require('../wsl/wsl');

// The name of a row of the side bar that tabs show under: a repository's (`repo`), or the one of
// the folders outside git (null).
function groupName(repo) {
  return repo ? path.basename(repo) : t('Other folders');
}

// The repository's pages, in the menu of a repository row (the side bar has buttons of its own
// for them). The pull request of a branch is on the worktree rows and in their menus instead: a
// repository row has no branch.
function githubPages() {
  return [
    { page: 'repo', label: t('Repository') },
    { page: 'issues', label: 'Issues' },
    { page: 'pulls', label: 'Pull requests' },
    { page: 'actions', label: 'Actions' },
  ];
}

function createMenus({ popup, platform = process.platform, tabs, order, remotes, owned,
  chooseFolder, addRepository, openTab, canUpdate, checkForUpdates, canCheckApp = () => false, checkAppUpdate = () => {},
  openSettingsDialog, openConfigFile,
  restartServer, suspendTab, reloadTab, closeTab, closeTabsTogether, addWorktreeDialog,
  removableWorktree, confirmRemoveWorktree, isGitFolder, openInExplorer, copy, openExternal,
  openGithub, branchPage, ownedRepo, isCloning, clonePlaces, startClone, hideOwner }) {
  // The "+" at the top of the side bar: only ways to add something to it.
  function showAddMenu() {
    popup([
      { label: t('Add repository…'), click: () => addRepository() },
      {
        label: t('Open folder…'),
        click: async () => {
          const folder = await chooseFolder();
          if (folder) openTab(folder);
        },
      },
    ]);
  }

  // The "…" at the top of the side bar: the rest.
  function showMoreMenu() {
    popup([
      { label: t('Check for code-server and extension updates'), enabled: canUpdate(), click: () => checkForUpdates({ manual: true }) },
      // Builds of your own do not look for releases (self-update/target.js).
      ...(canCheckApp() ? [{ label: t('Check for a new version of Worktabs'), click: () => checkAppUpdate() }] : []),
      { label: t('Extensions'), enabled: canUpdate(), click: () => openSettingsDialog('extensions') },
      { label: t('Open settings file'), click: () => openConfigFile() },
    ]);
  }

  // The menu item that opens a folder in the file manager that openInExplorer opens.
  function openInFileManagerItem(folder) {
    const label = platform === 'darwin' ? t('Open in Finder') : t('Open in File Explorer');
    return { label, click: () => openInExplorer(folder) };
  }

  // Copying the path, and for a folder in WSL also its Linux path, for a terminal there.
  function copyPathItems(folder) {
    const wsl = parseWslPath(folder);
    return [
      { label: t('Copy path'), click: () => copy(folder) },
      ...(wsl ? [{ label: t('Copy Linux path'), click: () => copy(wsl.path) }] : []),
    ];
  }

  // "This branch's pull request" for the menu of a worktree, or nothing when its repository is
  // not on GitHub or it is on the default branch or a detached HEAD.
  async function branchPageItems(folder) {
    const branch = await branchPage(folder);
    return branch ? [{ label: t("This branch's PR ({branch})", { branch }), click: () => openGithub(folder, 'branch') }] : [];
  }

  async function showTabMenu(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    const running = tab.server === 'running';
    const [removable, branchItems] = await Promise.all([removableWorktree(tab.folder), branchPageItems(tab.folder)]);
    popup([
      { label: t('Restart'), click: () => restartServer(tab) },
      { label: t('Suspend'), enabled: running, click: () => suspendTab(tab) },
      { label: t('Reload'), enabled: running, click: () => reloadTab(tab) },
      { type: 'separator' },
      openInFileManagerItem(tab.folder),
      ...branchItems,
      ...copyPathItems(tab.folder),
      { label: t('Developer tools'), click: () => tab.view.webContents.openDevTools({ mode: 'detach' }) },
      { type: 'separator' },
      { label: t('Close'), click: () => closeTab(id) },
      ...(removable ? [{ label: t('Remove worktree…'), click: () => confirmRemoveWorktree(tab.folder) }] : []),
    ]);
  }

  // A repository row's menu, or with `repo` null that of the row of the folders outside git,
  // which has only the item that closes its tabs. A folder of another version control system
  // (from ghq) has no worktrees. `ids`: the row's open tabs, as the side bar groups them. The
  // GitHub pages are here too, for when the buttons that come up over the row's icon cannot (a
  // pen, a touch): for a repository on GitHub as the remotes read for the side bar say
  // (readVisibilities), and for one whose remote is not read yet, as the side bar has the buttons
  // for it then too.
  function showRepoMenu(repo, ids) {
    const open = openAmong(order(), ids);
    const closeItems = open.length ? [{ label: t('Close all tabs'), click: () => closeTabsTogether(open, groupName(repo)) }] : [];
    if (!repo) {
      if (closeItems.length) popup(closeItems);
      return;
    }
    const git = isGitFolder(repo);
    const worktreeItems = git ? [{ label: t('Add worktree…'), click: () => addWorktreeDialog(repo) }, { type: 'separator' }] : [];
    const known = remotes().get(repo.toLowerCase());
    const githubItems =
      git && (known ? known.url : true)
        ? [{ label: 'GitHub', submenu: githubPages().map(({ page, label }) => ({ label, click: () => openGithub(repo, page) })) }, { type: 'separator' }]
        : [];
    popup([
      ...worktreeItems,
      ...githubItems,
      openInFileManagerItem(repo),
      ...copyPathItems(repo),
      ...(closeItems.length ? [{ type: 'separator' }, ...closeItems] : []),
    ]);
  }

  // The menu of a worktree row that is not open in a tab (an open one has the tab's menu).
  // `repo`: the row's repository, for a worktree whose folder is gone (see removableWorktree).
  async function showWorktreeMenu(folder, repo = null) {
    const [removable, branchItems] = await Promise.all([removableWorktree(folder, repo), branchPageItems(folder)]);
    popup([
      { label: t('Open in a tab'), click: () => openTab(folder) },
      { type: 'separator' },
      openInFileManagerItem(folder),
      ...branchItems,
      ...copyPathItems(folder),
      ...(removable ? [{ type: 'separator' }, { label: t('Remove worktree…'), click: () => confirmRemoveWorktree(folder, repo) }] : []),
    ]);
  }

  // The clone button of a repository's row: where to clone it, as a menu, when there is more
  // than one place; at once otherwise.
  function showCloneMenu(url) {
    const repo = ownedRepo(url);
    if (!repo || isCloning(repo)) return;
    const places = clonePlaces();
    if (places.length === 1) {
      startClone(repo, places[0]);
      return;
    }
    popup([
      { label: t('Clone to'), enabled: false },
      ...places.map((place) => ({ label: place.label, click: () => startClone(repo, place) })),
    ]);
  }

  // The menu of a repository's row in the section of those not cloned.
  function showUnclonedMenu(url) {
    const repo = ownedRepo(url);
    if (!repo) return;
    const places = clonePlaces();
    const enabled = !isCloning(repo);
    const clone =
      places.length === 1
        ? { label: t('Clone'), enabled, click: () => startClone(repo, places[0]) }
        : { label: t('Clone'), enabled, submenu: places.map((place) => ({ label: place.label, click: () => startClone(repo, place) })) };
    popup([
      clone,
      { type: 'separator' },
      { label: t('Open on GitHub'), click: () => openExternal(repo.url) },
      { label: t('Copy URL'), click: () => copy(repo.url) },
    ]);
  }

  // The menu of an owner's row (`key`: host/owner, lowercase).
  function showOwnerMenu(key) {
    const repo = owned().find((r) => `${r.host}/${r.owner}`.toLowerCase() === key);
    if (!repo) return;
    popup([
      { label: t('Open on GitHub'), click: () => openExternal(new URL(`/${repo.owner}`, repo.url).href) },
      { type: 'separator' },
      { label: t('Hide this owner'), click: () => hideOwner(repo.host, repo.owner) },
    ]);
  }

  return { showAddMenu, showMoreMenu, showTabMenu, showRepoMenu, showWorktreeMenu, showCloneMenu, showUnclonedMenu, showOwnerMenu };
}

module.exports = { createMenus, groupName };
