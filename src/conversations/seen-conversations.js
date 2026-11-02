const { reactAncestors, webviewReactScript } = require('./webview-react');

// A visible agent alone does not identify a conversation. Only a current webview snapshot
// with an exact conversation ID can clear a result; titles and last-opened IDs are not proof.
function seenConversationIds(conversations, shown) {
  if (!Array.isArray(shown)) return [];
  return conversations.filter((conversation) => shown.some((view) =>
    view?.agent === (conversation.agent || 'claude') && typeof view.id === 'string' && view.id.length > 0 &&
    view.id === (conversation.threadId || conversation.id),
  )).map((conversation) => conversation.id);
}

// React keeps an alternate tree on DOM nodes. Read the mounted tree, otherwise switching
// conversations can report the previous composer's props on every other render.
function composerProps(element) {
  const found = reactAncestors(element);
  return found.available ? found.props : [];
}

function shownConversation(agent, document, propsOf) {
  const selector = agent === 'codex' ? '[data-composer-navigation-target="permissions"]' : '[aria-label="Message input"]';
  const inputs = [...document.querySelectorAll(selector)].filter((element) =>
    element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
  if (inputs.length !== 1) return null;
  const props = propsOf(inputs[0]);
  if (agent === 'codex') {
    const picker = props.find((value) => value?.triggerButton);
    if (!picker || picker.disabled === true || inputs[0].disabled === true) return null;
    const context = props.find((value) => value && Object.hasOwn(value, 'conversationId') && Object.hasOwn(value, 'hostId'));
    return context?.hostId === 'local' && typeof context.conversationId === 'string'
      ? { agent, id: context.conversationId } : null;
  }
  const session = props.find((value) => value?.session)?.session;
  return session?.isLoading?.value === false && session?.loadFailed?.value === false && typeof session.sessionId?.value === 'string'
    ? { agent, id: session.sessionId.value } : null;
}

// Explicit diagnostics are available without changing the null snapshot fallback used by
// existing callers. Only a successful semantic result can clear unread state.
function conversationProbe(agent, document) {
  try {
    /** @type {{ available: boolean, reason?: string, props?: any[] } | undefined} */
    let discovery;
    const snapshot = shownConversation(agent, document, (element) => {
      discovery = reactAncestors(element);
      return discovery.available ? discovery.props : [];
    });
    return snapshot ? { available: true, snapshot }
      : { available: false, reason: discovery && !discovery.available ? discovery.reason : 'unknown-conversation' };
  } catch { return { available: false, reason: 'unreadable-probe' }; }
}

function shownConversationScript(agent) {
  return webviewReactScript(`const composerProps = ${composerProps}; return (${shownConversation})(${JSON.stringify(agent)}, document, composerProps);`);
}

// VS Code moves webviews outside their view containers. The iframe's own visibility is needed
// as well as its identity: retained hidden panels still have live webview frames.
const VISIBLE_CHAT_FRAMES_SCRIPT = `(() => [...document.querySelectorAll('iframe')].filter((frame) => {
  if (!frame.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
  const box = frame.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight;
}).map((frame) => frame.src))()`;

// Reads which conversations the chats in view of the tab in front show: for the side bar, which
// marks their rows, and to clear their unread results. A read goes on events that can change them
// (a tab switch, the window's focus, a hook, input in the tab: `refresh` and `soon`), then every
// `interval` while unread results remain, or while a chat in view could not be identified yet (it
// is loading), at most `retries` times. Nothing is read while nothing happens. A focus or tab
// change invalidates pending reads even if the user switches back before they finish. Reads never
// overlap; failures keep unread marks and the side bar marks no conversation.
class SeenConversations {
  constructor({ activeTab, focused, hasUnread, read, conversations, markSeen, changed,
    interval = 1500, settle = 300, retries = 4, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.activeTab = activeTab;
    this.focused = focused;
    this.hasUnread = hasUnread;
    this.read = read;
    this.conversations = conversations;
    this.markSeen = markSeen;
    this.changed = changed;
    this.interval = interval;
    this.settle = settle;
    this.retries = retries;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.generation = 0;
    this.timer = null;
    this.busy = false;
    this.wanted = false;
    this.loading = 0;
    // What the last read found in the tab in front: { tab, views } (see shownConversations in
    // chat-frames.js).
    this.shown = { tab: null, views: [] };
  }

  refresh() {
    this.request(0);
  }

  // Something happened in `tab` that may switch the conversation in view (a click, a key, a hook):
  // read once the chat has had a moment to show it.
  soon(tab) {
    if (tab === this.activeTab()) this.request(this.settle);
  }

  request(delay) {
    this.generation++;
    this.wanted = true;
    this.loading = this.retries;
    this.clearTimer(this.timer);
    this.timer = null;
    // A tab that is no longer in front shows nothing in the window.
    if (this.shown.tab !== this.activeTab() && this.setShown(null, [])) this.changed();
    this.schedule(delay);
  }

  schedule(delay) {
    const tab = this.activeTab();
    if (this.busy || this.timer !== null || !tab || !this.focused()) return;
    if (!this.wanted && this.loading <= 0 && !this.hasUnread(tab)) return;
    this.timer = this.setTimer(() => this.check(), delay);
  }

  async check() {
    this.timer = null;
    const tab = this.activeTab(), generation = this.generation;
    if (!tab || !this.focused()) return;
    this.wanted = false;
    this.busy = true;
    try {
      let shown;
      try {
        shown = await this.read(tab);
      } catch {
        // A reloading or unsupported panel cannot prove that any conversation is in view.
        shown = null;
      }
      if (generation !== this.generation || tab !== this.activeTab() || !this.focused()) return;
      const views = Array.isArray(shown) ? shown : [];
      this.loading = views.some((view) => !view) ? this.loading - 1 : 0;
      let changed = this.setShown(tab, views.filter(Boolean));
      for (const id of seenConversationIds(this.conversations(tab), shown)) {
        if (this.markSeen(tab, id)) changed = true;
      }
      if (changed) this.changed();
    } finally {
      this.busy = false;
      this.schedule(generation === this.generation ? this.interval : 0);
    }
  }

  setShown(tab, views) {
    const same = JSON.stringify(views) === JSON.stringify(this.shown.views) && (!views.length || tab === this.shown.tab);
    this.shown = { tab, views };
    return !same;
  }

  // The IDs of `tab`'s conversations that a chat in view shows, by the exact ID only.
  shownIds(tab) {
    return tab && tab === this.shown.tab ? seenConversationIds(this.conversations(tab), this.shown.views) : [];
  }
}

module.exports = { SeenConversations, seenConversationIds, composerProps, conversationProbe, shownConversation, shownConversationScript, VISIBLE_CHAT_FRAMES_SCRIPT };
