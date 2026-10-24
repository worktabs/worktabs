// The agent chat in a tab's secondary side bar: showing it in place of VS Code's own chat, the
// first conversation of a worktree just added, and its width (see "The chat's width" in
// secondary-sidebar.js). The tabs' pages and the helper extension are injected.
const { t } = require('../i18n');
const { startTaskConversation, codexTaskScript } = require('./first-conversation');
const { visibleCodexFrames } = require('./chat-frames');
const {
  BUILT_IN_CHAT,
  CHAT_WIDTH_SCRIPT,
  SECONDARY_VIEW_SCRIPT,
  chatWidth,
  firstAnswer,
  resizeScript,
  secondaryView,
} = require('./secondary-sidebar');
const { AGENTS } = require('../agents/agents');
const { samePath } = require('../util');

const isPrimary = (tab) => Boolean(tab.repo) && samePath(tab.repo, tab.folder);

// `chatWidths`: the width of the chat in each repository's primary (ChatWidths), kept with the
// tabs by `saveTabs`. `runs`: the tab's current server start (TabLifecycle.runs).
function createChatPanel({ tabs, runs, tabIdFor, tabAgent, chatWidths, saveTabs, callHelper,
  messageBox, copy, pause = () => new Promise((resolve) => setTimeout(resolve, 250)),
  late = () => new Promise((resolve) => setTimeout(resolve, 1000, null)) }) {
  // Puts the agent chat in the tab's secondary side bar when VS Code shows its own chat there, as
  // it does on a new port, leaving the focus where it is. The helper extension does it; that
  // would open the side bar even when it is closed, so the app looks first. A side bar closed, or
  // showing another view, is as the person left it, and stays so. On a new port the tab opens for
  // the first time, and its chat is sized.
  async function showAgentChat(tab) {
    // A tab closed meanwhile has no page to read.
    const read = () => (tabs.get(tab.id) === tab ? tab.view.webContents.executeJavaScript(SECONDARY_VIEW_SCRIPT) : 'closed');
    if ((await secondaryView(read)) !== BUILT_IN_CHAT) return;
    await callHelper(tab.id, '/show-chat', { agent: tabAgent(tab) });
    await fitChat(tab);
  }

  // The first agent conversation of a worktree just added from the side bar, with the prompt of
  // its task in the input if it has one (the helper extension shows the chat for it). A new
  // worktree opens for the first time, so its chat is sized as well.
  async function startFirstConversation(tab, prompt) {
    const agent = tabAgent(tab);
    const run = runs(tab.id);
    const current = () => tabs.get(tab.id) === tab && runs(tab.id) === run && tab.server === 'running' && !tab.view.webContents.isDestroyed();
    await startTaskConversation({ agent, prompt, current,
      open: () => callHelper(tab.id, '/new-conversation', { agent, ...(prompt ? { prompt } : {}) }, { result: agent === 'codex' }),
      fill: async () => {
        const frames = await visibleCodexFrames(tab.view.webContents).catch(() => []);
        if (frames.length !== 1) return null;
        return frames[0].executeJavaScript(codexTaskScript(prompt), true).catch(() => null);
      },
      pause,
      recover: async () => {
        await callHelper(tab.id, '/show-chat', { agent });
        if (!current()) return;
        const answer = await messageBox({ type: 'warning', message: t('The task could not be put in the new conversation.'),
          detail: t('Open a new {agent} conversation and paste this task. Worktabs has not sent it.\n\n{prompt}', { agent: AGENTS[agent].label, prompt: prompt || '' }),
          buttons: prompt ? [t('Close'), t('Copy task')] : [t('Close')], defaultId: 0, cancelId: 0 });
        if (answer.response === 1) copy(prompt);
      },
    });
    if (!current()) return;
    await fitChat(tab);
  }

  // Sizes the chat in the secondary side bar of a tab opened for the first time: as wide as in
  // the repository's primary, or a third of the width it shares with the editor when the
  // primary's is not known (outside git too). VS Code keeps it from then on. A primary's own is
  // kept for the worktrees opened after it.
  async function fitChat(tab) {
    const repo = await tab.repoLookup;
    const primary = repo ? await primaryChatWidth(repo, tab) : null;
    const page = (script) => (tabs.get(tab.id) === tab ? tab.view.webContents.executeJavaScript(script) : null);
    const now = await firstAnswer(() => page(CHAT_WIDTH_SCRIPT), Boolean, { attempts: 4 });
    if (!now) return;
    const fitted = await Promise.resolve(page(resizeScript(chatWidth({ shared: now.shared, primary })))).catch(() => null);
    if (fitted) rememberChatWidth(tab, fitted);
  }

  // The width of the chat in the repository's primary: read from its tab while that runs, else
  // as last read. Null when not known: the primary has not been opened since the app keeps it. A
  // primary opened on a new port (its own was taken) gets back its width.
  async function primaryChatWidth(repo, tab) {
    const primary = tabs.get(tabIdFor(repo));
    const read = primary && primary !== tab ? await rememberChatWidth(primary) : null;
    return read ? read.chat : chatWidths.get(repo);
  }

  // Keeps the width of the chat in a primary's secondary side bar for its repository, for the
  // worktrees opened when the primary does not run: read as its tab closes or is suspended, and
  // as the app quits (its VS Code keeps it per port, which a tab on another port cannot read).
  // `read`: what CHAT_WIDTH_SCRIPT has just read there, if anything. Resolves what was read, or
  // null for another tab, or one whose side bar cannot be read (not running, closed): the width
  // kept before stays.
  async function rememberChatWidth(tab, read = null) {
    if (!isPrimary(tab)) return null;
    const width = read || (await readChatWidth(tab));
    if (width && chatWidths.set(tab.repo, width.chat)) saveTabs();
    return width;
  }

  // What CHAT_WIDTH_SCRIPT reads in the tab's page, or null when its VS Code is not running, or
  // its page does not answer within a second (a busy or stuck page would hold up closing the tab).
  function readChatWidth(tab) {
    if (tab.server !== 'running' || tabs.get(tab.id) !== tab) return Promise.resolve(null);
    return Promise.race([tab.view.webContents.executeJavaScript(CHAT_WIDTH_SCRIPT).catch(() => null), late()]);
  }

  return { showAgentChat, startFirstConversation, fitChat, rememberChatWidth };
}

module.exports = { createChatPanel };
