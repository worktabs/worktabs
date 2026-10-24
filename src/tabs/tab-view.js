// A tab's view, the page its VS Code runs in: what it does with new windows and with leaving, and
// the scripts each agent chat frame gets as it loads. The view and the frames are injected, so
// fakes test it.
const { t } = require('../i18n');
const { unproxiedUrl } = require('../code-server/code-server');
const { CHAT_FOCUS_GUARD, chatAgent, isClaudeChatFrame, isCodexChatFrame, pageFocusScript } = require('../conversations/chat-frames');
const { codexApprovalScript } = require('../codex/codex-approval');
const { codexOnboardingScript } = require('../agents/agent-onboarding');

// `makeView()`: a new WebContentsView. `frameOf(processId, routingId)`: webFrameMain.fromId.
// `folderFromUrl(url)`: the folder a code-server address opens, or null. `hostKeys(event, input,
// contents)`: the keys the app keeps (host-keys.js). `current(tab)`: whether the tab is still
// open (TabLifecycle). `approvalMode()`: the Codex approval mode in the settings. `chatLoaded(tab,
// agent)`: an agent chat's frame has loaded (chat-startup.js watches it start).
function createTabViews({ makeView, frameOf, folderFromUrl, openTab, openExternal, hostKeys, current, approvalMode, changed, chatLoaded }) {
  return function createTabView(tab) {
    const view = makeView();
    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      // "Open in new window" requests from VS Code (the Claude extension's Create Worktree
      // opens the new worktree this way, and so does `code <folder>` in its terminal) become
      // tabs; other links open in the browser, a link to localhost as it read rather than through
      // code-server's proxy (unproxiedUrl).
      const folder = folderFromUrl(url);
      if (folder) openTab(folder);
      else if (/^https?:/i.test(url)) openExternal(unproxiedUrl(url, contents.getURL()) || url);
      return { action: 'deny' };
    });
    // VS Code asks for close confirmation through beforeunload; the tab bar decides instead.
    contents.on('will-prevent-unload', (event) => event.preventDefault());
    contents.on('before-input-event', (event, input) => hostKeys(event, input, contents));
    // The Claude Code chats, on sites of their own, are told whether the page has the focus.
    const tellClaudeChats = () => {
      try {
        const script = pageFocusScript(contents.isFocused());
        for (const frame of contents.mainFrame.framesInSubtree) {
          if (isClaudeChatFrame(frame)) frame.executeJavaScript(script).catch(() => {});
        }
      } catch { /* The page has gone. */ }
    };
    contents.on('focus', tellClaudeChats);
    contents.on('blur', tellClaudeChats);
    // Each Claude Code chat gets the focus guard when its frame loads (VS Code replaces the frame
    // when the chat's page changes).
    contents.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
      if (isMainFrame) return;
      const frame = frameOf(processId, routingId);
      if (frame && isClaudeChatFrame(frame)) {
        frame.executeJavaScript(pageFocusScript(contents.isFocused())).catch(() => {});
        frame.executeJavaScript(CHAT_FOCUS_GUARD).catch(() => {});
      }
      if (frame && isCodexChatFrame(frame)) {
        if (tab.linkedWorktree) frame.executeJavaScript(codexOnboardingScript()).catch(() => {});
        frame.executeJavaScript(codexApprovalScript(approvalMode())).catch(() => {});
      }
      const agent = frame && chatAgent(frame);
      if (agent) chatLoaded(tab, agent);
    });
    contents.on('render-process-gone', (_event, details) => {
      if (!current(tab)) return;
      tab.error = t('The page process ended ({reason}). Reload it from the right-click menu.', { reason: details.reason });
      changed();
    });
    return view;
  };
}

module.exports = { createTabViews };
