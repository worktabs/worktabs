// The main process's IPC channels, as the table registerIpc takes (ipc-routes.js), and the guards
// several channels share. `app` holds the operations they call, from main.js, so tests can call
// the channels with fakes.
const { t } = require('../i18n');
const { checkedTask } = require('../repos/task');
const { stringList, stringOrNull, withEvent } = require('./ipc-routes');

function appIpcRoutes(app) {
  // The dialog that adds a worktree answers only for its repository while it is in front. Each
  // resolves { error } when it cannot be done.
  const notAdding = () => ({ error: t('The dialog that adds a worktree is closed') });
  const whileAdding = (handler) => (repo, ...args) => (app.addingTo(repo) ? handler(repo, ...args) : notAdding());
  // The Extensions pane answers only from the Settings dialog while it is open; a failure
  // resolves { error }.
  const fromSettings = (handler) => withEvent(async (event, ...args) => {
    if (!app.fromSettingsDialog(event.sender)) return { error: t('Open Settings first.') };
    try { return await handler(...args); } catch (error) { return { error: error.message }; }
  });

  return {
    // The pages' UI language, asked for by their preloads before the pages' scripts run.
    sync: {
      'i18n:get': () => app.uiLanguage(),
    },
    on: {
      'sidebar:resize': (width) => app.resizeSidebar(width),
    },
    handle: {
      // ---- Tabs and the side bar
      'tabs:get': () => app.viewState(),
      'tabs:activate': (id) => app.activateTab(id),
      'tabs:close': (id) => app.closeTab(id),
      'tabs:open': (folder) => app.openTab(folder),
      'tabs:tab-menu': (id) => app.showTabMenu(id),
      // A row of the side bar names its open tabs (those it lists under it, collapsed or
      // filtered out too), and closing all of them closes those: the side bar decides which row a
      // tab is under. `repo` is null for the row of the folders outside git.
      'repos:menu': (repo, ids) => app.showRepoMenu(stringOrNull(repo), stringList(ids)),
      'tabs:close-together': (repo, ids) => app.closeTabsTogether(stringList(ids), app.groupName(stringOrNull(repo))),
      'sidebar:add-menu': () => app.showAddMenu(),
      'sidebar:settings': () => app.openSettingsDialog(),
      'sidebar:extensions': () => app.openSettingsDialog('extensions'),
      'sidebar:more-menu': () => app.showMoreMenu(),
      'sidebar:resize-start': () => app.startSidebarResize(),
      'sidebar:resize-end': (width) => app.endSidebarResize(width),
      'sidebar:reset-width': () => app.resetSidebarWidth(),
      'sessions:next': (state) => {
        if (state === 'waiting' || state === 'working') app.revealNext(state);
      },
      'sessions:reveal': (tabId, sessionId) => app.revealSession(tabId, sessionId),
      'sessions:archive': (tabId, sessionId) => app.archiveSession(tabId, sessionId),

      // ---- Repositories and worktrees
      // With the worktrees of the last run, for the rows under the expanded repositories until
      // they are read again. The first start, without repos.json, waits for the list.
      'repos:get': async () => app.reposWithWorktrees(),
      'repos:refresh': () => app.refreshReposAgain(),
      // Resolves { error } with what git said: a rejection reaches the side bar as Electron's
      // "Error invoking remote method ..." with git's whole output. A list that could not be read
      // leaves the last one for the next start: WSL may only have been slow to start.
      'repos:worktrees': (repo) =>
        app.listWorktrees(repo).then(
          (items) => {
            app.rememberWorktrees(repo, items);
            return items;
          },
          (error) => ({ error: app.gitMessage(error) }),
        ),
      // A worktree row names its repository too: removableWorktree checks it against git's list.
      'worktrees:menu': (folder, repo) => app.showWorktreeMenu(folder, stringOrNull(repo)),
      // The trash button of a worktree row: the same as "Remove worktree…" in its menu.
      'worktrees:remove': (folder, repo) => {
        if (typeof folder === 'string') return app.confirmRemoveWorktree(folder, stringOrNull(repo));
      },
      'worktrees:add-dialog': (repo) => app.addWorktreeDialog(repo),

      // ---- The dialog that adds a worktree
      'worktree:task': whileAdding((repo, text) => app.describeTask(repo, text).catch((error) => ({ error: error.message }))),
      // With the task when it is a pull request: what the branch checks out.
      'worktree:plan': whileAdding((repo, name, task = null) => {
        const checked = checkedTask(task);
        const pull = checked && checked.kind === 'pull' ? checked : null;
        return app.planWorktree(repo, name, pull).catch((error) => ({ error: app.gitMessage(error) }));
      }),
      'worktree:suggest': whileAdding((repo, task) => {
        const checked = checkedTask(task);
        return checked ? app.suggestBranch(repo, checked) : { error: t('Enter an issue, a PR, or what to do') };
      }),
      'worktree:create': whileAdding((repo, name, task) => app.addWorktreeTab(repo, name, checkedTask(task))),

      // ---- The section of the repositories not cloned: each row is named by its address on
      // GitHub, and each owner's by host/owner
      'uncloned:clone': (url) => app.showCloneMenu(url),
      'uncloned:menu': (url) => app.showUnclonedMenu(url),
      'uncloned:owner-menu': (key) => {
        if (typeof key === 'string') app.showOwnerMenu(key);
      },
      // The dialog that asks where to clone. Each resolves { error } when it cannot be done.
      'clone:check': (text) => app.cloneRequests.check(text),
      'clone:browse': (text) => app.cloneRequests.browse(text),
      'clone:start': (text) => app.cloneRequests.start(text),

      // ---- Settings and extensions
      'settings:save': (settings) => app.saveSettings(settings).catch((error) => ({ error: error.message })),
      'extensions:list': fromSettings(app.extensionState),
      'extensions:browse': fromSettings(app.browseExtensionSource),
      'extensions:import': fromSettings((keys, target) => app.queueExtensionImports(keys, target)),
      'extensions:rollback': fromSettings(app.rollbackExtension),
      'extensions:open-code': fromSettings(app.openDesktopCode),
      'extensions:page': fromSettings((id) => {
        if (!/^[a-z0-9-]+\.[a-z0-9-]+$/i.test(id)) throw new Error(t('Invalid extension ID.'));
        return app.openExternal(`https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(id)}`);
      }),
      'extensions:check': fromSettings(async (target) => { await app.checkForUpdates(); return app.extensionState(target); }),
      'extensions:update': fromSettings(async () => {
        if (!app.updateAvailable()) throw new Error(t('No updates are available.'));
        app.queueUpdate();
        return { queued: true };
      }),

      // ---- GitHub
      'github:get': (folder) => app.repoInfo(folder),
      'github:open': (folder, page) => app.openGithub(folder, page),
      'github:issue': (folder, number) => app.openNumbered(folder, 'issues', number),
      'github:pull': (folder, number) => app.openNumbered(folder, 'pull', number),
      'github:checks': (folder, oid) => app.openChecks(folder, oid),
      // `numbers`: [branch, number] for each branch made from a pull request. `heads`: the
      // commits of the worktrees.
      'github:pulls': (folder, branches, numbers = [], heads = []) => {
        if (!Array.isArray(branches) || !branches.every((branch) => typeof branch === 'string') || !Array.isArray(numbers)) return null;
        if (!Array.isArray(heads) || !heads.every((oid) => typeof oid === 'string')) return null;
        const made = numbers.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && Number.isInteger(entry[1]) && entry[1] > 0);
        return app.pullRequests(folder, branches, new Map(made), heads);
      },

      // ---- Updates
      'update:start': () => app.startUpdate(),
      'update:cancel': () => app.cancelUpdate(),
      'update:dismiss': () => app.dismissUpdate(),
      // Of Worktabs itself. The release notes are the release's own page, not one the page names.
      'app-update:start': () => app.selfUpdate.start(),
      'app-update:restart': () => app.selfUpdate.restart(),
      'app-update:cancel': () => app.selfUpdate.cancel(),
      'app-update:skip': () => app.selfUpdate.skipVersion(),
      'app-update:dismiss': () => app.selfUpdate.dismiss(),
      'app-update:notes': () => {
        const url = app.selfUpdate.state.notesUrl;
        if (url) return app.openExternal(url);
      },

      // ---- The app's dialogs
      'dialog:ready': () => app.dialogReady(),
      'dialog:answer': (id, response, checkboxChecked) => {
        app.answerDialog(id, response, checkboxChecked);
      },
      // Ctrl+C with nothing selected copies the whole dialog, as Windows' own dialogs do.
      'dialog:copy': () => app.copyDialog(),
    },
  };
}

module.exports = { appIpcRoutes };
