// The state the side bar shows (tabs, conversations, usage, updates), and sending it with the
// window's title, which counts the conversations waiting and working. The window and its views
// are injected, so fakes test it.
const { t } = require('../i18n');
const { coalesce } = require('../util');

// The window's title for the conversations { waiting, working }.
function windowTitle(counts) {
  const parts = [];
  if (counts.waiting) parts.push(t('Waiting for approval {count}', { count: counts.waiting }));
  if (counts.working) parts.push(t('Working {count}', { count: counts.working }));
  // ', ' separates the counts (a middle dot in Japanese).
  return parts.length ? t('Worktabs ({counts})', { counts: parts.join(t(', ')) }) : 'Worktabs';
}

// `lifecycle`: TabLifecycle (its tabs, order, ports and the tab in front). `sessions`:
// ConversationStore. `tabAgent(tab)`: the tab's agent. `update()`: the update's state, and
// `appUpdate()` that of Worktabs itself.
// `removing`, `cloning`: Sets of worktrees being removed and repositories being cloned.
// `repoUsed()`: tab-store.js's. `agents()`: the agents turned on. `usage`, `codexUsage`: their
// trackers. `theme()`: the colors of the tab in front. `views()`: { win, sidebar, emptyView },
// once the window is made. `schedule`: when a burst of pushes goes (coalesce in util.js).
function createViewState({ lifecycle, sessions, tabAgent, update, appUpdate = () => ({ status: 'none' }), removing, cloning, repoUsed, agents,
  usage, codexUsage, theme, views, schedule = setImmediate }) {
  function viewState() {
    const enabled = agents();
    return {
      tabs: lifecycle.order.map((id) => {
        const tab = lifecycle.tabs.get(id);
        return {
          id,
          name: tab.name,
          branch: tab.branch,
          // The main worktree of the repository the folder is in; null outside git, and
          // undefined until it has been looked up.
          repo: tab.repo,
          folder: tab.folder,
          server: tab.server,
          port: lifecycle.ports.port(id) || null,
          error: tab.error,
          agent: sessions.tabState(id),
          provider: tabAgent(tab),
          unread: sessions.hasUnread(id),
          conversations: sessions.conversations(id).map((conversation) => ({ ...conversation, agent: conversation.agent || 'claude' })),
          active: id === lifecycle.activeId,
        };
      }),
      update: update(),
      appUpdate: appUpdate(),
      removing: [...removing],
      cloning: [...cloning],
      repoUsed: repoUsed(),
      usage: enabled.includes('claude') ? usage.view() : [],
      claudeUsage: enabled.includes('claude') ? usage.providerView() : null,
      codexUsage: enabled.includes('codex') ? codexUsage.view() : null,
      theme: theme(),
      // Conversations, not tabs: each one waiting needs its own answer.
      counts: { waiting: sessions.inState('waiting', lifecycle.order).length, working: sessions.inState('working', lifecycle.order).length },
    };
  }

  function pushNow() {
    const { win, sidebar, emptyView } = views();
    if (!win || win.isDestroyed()) return;
    const state = viewState();
    if (!sidebar.webContents.isDestroyed()) sidebar.webContents.send('tabs:update', state);
    win.setTitle(windowTitle(state.counts));
    emptyView.setVisible(lifecycle.order.length === 0);
  }

  // Changes come in bursts (a turn's protocol items, a repository read), and each push sends every
  // tab and conversation: they go once on the next turn of the event loop.
  const push = coalesce(pushNow, schedule);

  return { viewState, push };
}

module.exports = { createViewState, windowTitle };
