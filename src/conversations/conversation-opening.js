// Pending navigation and helper registration are independent of Electron frame execution.
const { t } = require('../i18n');
const { confirmCodexThread } = require('./conversation-navigation');

function createConversationOpening({ tabs, helpers, sessions, activeId, runFor, activateTab,
  callHelper, readTheme, startFirstConversation, showAgentChat, read, focused, messageBox,
  pushState, refreshSeen, schedule = setTimeout, cancel = clearTimeout,
  pause = () => new Promise((resolve) => setTimeout(resolve, 250)) }) {
  async function revealSession(tabId, sessionId) {
    if (!tabs.has(tabId)) return;
    const tab = tabs.get(tabId);
    activateTab(tabId);
    const request = Symbol('reveal');
    tab.revealRequest = request;
    tab.revealedThread = null;
    const conversation = sessions.conversations(tabId).find((c) => c.id === sessionId);
    if (!conversation) return;
    if (!helpers.has(tabId) && ['starting', 'running'].includes(tab.server)) {
      // A restored row can be clicked before the extension host is ready. Only the latest click
      // is kept; registering the helper finishes it in this same tab.
      tab.pendingReveal = sessionId;
      cancel(tab.revealTimer);
      tab.revealTimer = schedule(() => {
        if (tabs.get(tabId) !== tab || activeId() !== tabId || tab.pendingReveal !== sessionId) return;
        tab.pendingReveal = null;
        messageBox({ type: 'warning', message: t('The conversation could not be opened.'),
          detail: t('The tab did not register its helper extension in time. Reload the tab and try again.') });
      }, 30000);
      return;
    }
    const codex = conversation.agent === 'codex';
    if (codex && conversation.ephemeral) {
      await callHelper(tabId, '/show-chat', { agent: 'codex' });
      await messageBox({ type: 'warning', message: t('The Codex conversation could not be restored.'),
        detail: t('This is a temporary Codex thread without saved history. Return to the panel that created it.') });
      return;
    }
    tab.revealedThread = codex ? sessionId : null;
    const run = runFor(tabId);
    const current = () => tabs.get(tabId) === tab && runFor(tabId) === run &&
      activeId() === tabId && tab.revealRequest === request && tab.revealedThread === sessionId && tab.server === 'running';
    const answer = await callHelper(tabId, '/reveal', {
      sessionId: conversation.threadId || sessionId, agent: conversation.agent || 'claude',
    }, { result: true });
    const opened = codex && answer?.opened ? await confirmCodexThread({ threadId: conversation.threadId, current,
      read: () => read(tab, conversation.threadId), pause,
    }) : answer?.opened;
    if (opened && (!codex || current()) && tabs.get(tabId) === tab && activeId() === tabId && focused()) {
      if (sessions.markSeen(tabId, sessionId)) pushState();
      refreshSeen();
    }
    if (codex && !opened && current()) {
      await callHelper(tabId, '/show-chat', { agent: 'codex' });
      await messageBox({ type: 'warning', message: t('The Codex conversation could not be opened.'),
        detail: answer?.reason === 'missing-extension'
          ? t('The Codex extension is not installed in this tab. Import it in Settings, then try again.')
          : t('Worktabs tried to open the Codex chat sidebar. Select the conversation from its history, or update the Codex extension and try again.') });
    }
  }


  function helperRegistered(tabId, endpoint) {
    const tab = tabs.get(tabId);
    if (tab?.server !== 'running') return;
    helpers.set(tabId, endpoint);
    readTheme(tab);
    if (tab.pendingReveal) {
      cancel(tab.revealTimer);
      const sessionId = tab.pendingReveal;
      tab.pendingReveal = null;
      revealSession(tabId, sessionId);
      return;
    }
    // A worktree just added from the side bar starts with a new Claude conversation, with the
    // prompt of its task in the input if it has one; the secondary side bar is left to that. Any
    // other tab gets the Claude chat there in place of VS Code's own. A tab opened for the first
    // time has its chat sized either way.
    if (tab.newConversation) {
      const { prompt } = tab.newConversation;
      tab.newConversation = null;
      startFirstConversation(tab, prompt);
    } else {
      showAgentChat(tab);
    }
  }


  function restoreFailed(tabId, sessionId) {
    const tab = tabs.get(tabId);
    if (activeId() !== tabId || tab?.revealedThread !== sessionId) return;
    tab.revealedThread = null;
    callHelper(tabId, '/show-chat', { agent: 'codex' });
    messageBox({ type: 'warning', message: t('The Codex conversation could not be restored.'),
      detail: t('The saved thread may have been archived, deleted, or moved to another Codex home. Select an available conversation from the Codex chat history.') });
  }

  function cancelPending(tab) {
    cancel(tab.revealTimer);
    tab.pendingReveal = null;
  }

  return { revealSession, helperRegistered, restoreFailed, cancelPending };
}

module.exports = { createConversationOpening };
