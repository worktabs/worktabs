const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createMenus, groupName } = require('../src/window/menus');

const labels = (template) => template.map((item) => item.label || item.type);

function setup(overrides = {}) {
  const shown = [];
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  const tab = { id: 't1', folder: path.resolve('repo-fix'), server: 'running', view: { webContents: { openDevTools: record('devtools') } } };
  const menus = createMenus({
    popup: (template) => shown.push(template),
    platform: 'win32',
    tabs: new Map([['t1', tab]]),
    order: () => ['t1', 't2'],
    remotes: () => new Map(),
    owned: () => [{ host: 'github.com', owner: 'Octo', url: 'https://github.com/Octo/hello' }],
    chooseFolder: async () => path.resolve('picked'),
    addRepository: record('addRepository'), openTab: record('openTab'),
    canUpdate: () => true, checkForUpdates: record('checkForUpdates'),
    openSettingsDialog: record('openSettingsDialog'), openConfigFile: record('openConfigFile'),
    restartServer: record('restart'), suspendTab: record('suspend'), reloadTab: record('reload'),
    closeTab: record('close'), closeTabsTogether: record('closeTogether'), addWorktreeDialog: record('addWorktree'),
    removableWorktree: async () => true, confirmRemoveWorktree: record('remove'), isGitFolder: () => true,
    openInExplorer: record('explore'), copy: record('copy'), openExternal: record('external'),
    openGithub: record('github'), branchPage: async () => 'fix',
    ownedRepo: (url) => (url.includes('hello') ? { url, host: 'github.com', owner: 'Octo' } : null),
    isCloning: () => false, clonePlaces: () => [{ label: 'Here' }, { label: 'Ubuntu' }],
    startClone: record('clone'), hideOwner: record('hideOwner'),
    ...overrides,
  });
  return { menus, shown, calls, tab };
}

test('a group is named by its repository, or as the folders outside git', () => {
  assert.equal(groupName(path.resolve('work', 'app')), 'app');
  assert.equal(groupName(null), 'Other folders');
});

test("a tab's menu has its actions, its branch's pull request, and removing the worktree", async () => {
  const { menus, shown, calls, tab } = setup();
  await menus.showTabMenu('t1');
  assert.deepEqual(labels(shown[0]), ['Restart', 'Suspend', 'Reload', 'separator', 'Open in File Explorer',
    "This branch's PR (fix)", 'Copy path', 'Developer tools', 'separator', 'Close', 'Remove worktree…']);
  shown[0][5].click();
  shown[0][10].click();
  assert.deepEqual(calls, [['github', tab.folder, 'branch'], ['remove', tab.folder]]);
  await menus.showTabMenu('gone');
  assert.equal(shown.length, 1);
});

test("a repository's menu closes only its tabs that are open", () => {
  const { menus, shown, calls } = setup();
  const repo = path.resolve('repo');
  menus.showRepoMenu(repo, ['t2', 't3']);
  assert.deepEqual(labels(shown[0]), ['Add worktree…', 'separator', 'GitHub', 'separator', 'Open in File Explorer', 'Copy path', 'separator', 'Close all tabs']);
  shown[0].at(-1).click();
  assert.deepEqual(calls, [['closeTogether', ['t2'], 'repo']]);
  // The folders outside git have only the item that closes their tabs, and none without tabs.
  menus.showRepoMenu(null, ['t1']);
  assert.deepEqual(labels(shown[1]), ['Close all tabs']);
  menus.showRepoMenu(null, ['t9']);
  assert.equal(shown.length, 2);
});

test('a repository whose remote is not on GitHub has no GitHub pages', () => {
  const repo = path.resolve('repo');
  const { menus, shown } = setup({ remotes: () => new Map([[repo.toLowerCase(), { url: null }]]) });
  menus.showRepoMenu(repo, []);
  assert.equal(labels(shown[0]).includes('GitHub'), false);
});

test('a folder in WSL can copy its Linux path too', async () => {
  const { menus, shown, calls } = setup({ branchPage: async () => null, removableWorktree: async () => false });
  await menus.showWorktreeMenu('\\\\wsl.localhost\\Ubuntu\\home\\me\\app');
  assert.deepEqual(labels(shown[0]), ['Open in a tab', 'separator', 'Open in File Explorer', 'Copy path', 'Copy Linux path']);
  shown[0][4].click();
  assert.deepEqual(calls, [['copy', '/home/me/app']]);
});

test('the clone button asks where only when there is more than one place', () => {
  const twoPlaces = setup();
  twoPlaces.menus.showCloneMenu('https://github.com/Octo/hello');
  assert.deepEqual(labels(twoPlaces.shown[0]), ['Clone to', 'Here', 'Ubuntu']);
  const onePlace = setup({ clonePlaces: () => [{ label: 'Here' }] });
  onePlace.menus.showCloneMenu('https://github.com/Octo/hello');
  assert.equal(onePlace.shown.length, 0);
  assert.equal(onePlace.calls[0][0], 'clone');
  // Unknown repositories and those being cloned do nothing.
  const cloning = setup({ isCloning: () => true });
  cloning.menus.showCloneMenu('https://github.com/Octo/hello');
  cloning.menus.showCloneMenu('https://github.com/Octo/other');
  assert.equal(cloning.shown.length + cloning.calls.length, 0);
});

test("an owner's menu opens the owner's page and hides the owner", () => {
  const { menus, shown, calls } = setup();
  menus.showOwnerMenu('github.com/octo');
  shown[0][0].click();
  shown[0][2].click();
  assert.deepEqual(calls, [['external', 'https://github.com/Octo'], ['hideOwner', 'github.com', 'Octo']]);
});

test('Open folder opens the folder picked, and updates need code-server', async () => {
  const { menus, shown, calls } = setup({ canUpdate: () => false });
  menus.showAddMenu();
  await shown[0][1].click();
  assert.deepEqual(calls, [['openTab', path.resolve('picked')]]);
  menus.showMoreMenu();
  assert.deepEqual(shown[1].map((item) => item.enabled), [false, false, undefined]);
});

test('the "…" menu ends with the version of Worktabs, whether or not it checks for new ones', () => {
  for (const canCheckApp of [() => true, () => false]) {
    const { menus, shown } = setup({ appVersion: '0.6.0', canCheckApp });
    menus.showMoreMenu();
    const items = shown[0];
    assert.deepEqual(labels(items.slice(-2)), ['separator', 'Worktabs 0.6.0']);
    assert.equal(items.at(-1).enabled, false);
    assert.equal(labels(items).includes('Check for a new version of Worktabs'), canCheckApp());
  }
});
