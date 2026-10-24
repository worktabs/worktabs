// The chat webviews of the agent extensions (Claude Code, Codex) in a tab's VS Code, found among
// the frames of its page. Takes Electron's frames and web contents as they are, so fakes test it.
const { VISIBLE_CHAT_FRAMES_SCRIPT, shownConversationScript } = require('./seen-conversations');

const WEBVIEW_FRAME = '/contrib/webview/browser/pre/';
const CHAT_EXTENSIONS = { claude: 'anthropic.claude-code', codex: 'openai.chatgpt' };

// Claude Code's chat moves the focus to its input a moment after its window gets the focus,
// without checking that it still has it. With a chat in the side bar and one on an editor tab,
// a focus that passes from one to the other at once (the page getting the focus back as a click
// lands on the other chat) leaves both waiting, and they take the focus from each other hundreds
// of times a second until the window loses it. So a chat that does not have the
// focus, while another part of the page does, cannot take it by script. Clicks still move the
// focus, and VS Code still gives a chat the focus (it uses window.focus, which is left alone).
// A chat served from a site of its own (tab-preload.js) cannot read the page, so the app tells
// it whether the page has the focus (pageFocusScript).
const CHAT_FOCUS_GUARD = `(() => {
  if (window.__worktabsFocusGuard) return;
  window.__worktabsFocusGuard = true;
  const pageHasFocus = () => {
    try {
      return window.top.document.hasFocus();
    } catch {
      return window.__worktabsPageFocus === true;
    }
  };
  for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
    const focus = proto.focus;
    proto.focus = function (...args) {
      if (!document.hasFocus() && pageHasFocus()) return;
      return focus.apply(this, args);
    };
  }
})()`;

// Tells a chat whether its tab's page has the focus, for CHAT_FOCUS_GUARD.
function pageFocusScript(focused) {
  return `window.__worktabsPageFocus = ${Boolean(focused)}`;
}

// The page of an extension's webview: the frame (fake.html) that VS Code's webview host frame
// writes the page into. The host frame's URL names the extension.
function isAgentChatFrame(frame, extensionId) {
  const host = frame.parent;
  if (!frame.url.includes(WEBVIEW_FRAME) || !host?.url.includes(WEBVIEW_FRAME)) return false;
  try {
    return new URL(host.url).searchParams.get('extensionId')?.toLowerCase() === extensionId;
  } catch {
    return false;
  }
}

const isClaudeChatFrame = (frame) => isAgentChatFrame(frame, CHAT_EXTENSIONS.claude);
const isCodexChatFrame = (frame) => isAgentChatFrame(frame, CHAT_EXTENSIONS.codex);

// 'claude' or 'codex' for a chat's frame, null for any other frame.
function chatAgent(frame) {
  if (isClaudeChatFrame(frame)) return 'claude';
  if (isCodexChatFrame(frame)) return 'codex';
  return null;
}

// The Codex chats of the page, in view or not.
function codexChatFrames(contents) {
  return contents.mainFrame.framesInSubtree.filter(isCodexChatFrame);
}

// The chats of `agent` ('claude' or 'codex') in the page, in view or not; none once the page has
// gone.
function agentChatFrames(contents, agent) {
  try {
    return contents.mainFrame.framesInSubtree.filter((frame) => chatAgent(frame) === agent);
  } catch {
    return [];
  }
}

// The frames of the page whose webview is in view (VISIBLE_CHAT_FRAMES_SCRIPT names their host
// frames). Rejects when the page cannot be asked.
async function visibleFrames(contents) {
  const visible = await contents.executeJavaScript(VISIBLE_CHAT_FRAMES_SCRIPT);
  return contents.mainFrame.framesInSubtree.filter((frame) => visible.includes(frame.parent?.url));
}

async function visibleCodexFrames(contents) {
  return (await visibleFrames(contents)).filter(isCodexChatFrame);
}

// The conversations the chats in view show, as each chat's page tells (see
// shownConversationScript). A chat that left the view while it was asked does not count.
async function shownConversations(contents) {
  const frames = await visibleFrames(contents);
  const shown = await Promise.all(frames.map(async (frame) => {
    const agent = chatAgent(frame);
    if (!agent) return null;
    const conversation = await frame.executeJavaScript(shownConversationScript(agent)).catch(() => null);
    return { frame, conversation };
  }));
  const stillVisible = await contents.executeJavaScript(VISIBLE_CHAT_FRAMES_SCRIPT);
  return shown.filter((view) => view && stillVisible.includes(view.frame.parent?.url)).map((view) => view.conversation);
}

module.exports = {
  CHAT_FOCUS_GUARD,
  WEBVIEW_FRAME,
  agentChatFrames,
  chatAgent,
  codexChatFrames,
  isAgentChatFrame,
  isClaudeChatFrame,
  isCodexChatFrame,
  pageFocusScript,
  shownConversations,
  visibleCodexFrames,
};
