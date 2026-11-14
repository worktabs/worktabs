// Conversation state and provider ownership, without timers, files, or process probes.
const { EventEmitter } = require('events');
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);
const PRIORITY = ['waiting', 'error', 'working', 'done', 'idle'];
// The IDs a saved Claude session or Codex thread may have (Claude's are UUIDs).
const SAVED_ID = /^[A-Za-z0-9_-]{1,200}$/;

function nextState(input) {
  switch (input.hook_event_name) {
    case 'SessionStart':
      return 'idle';
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
    case 'SubagentStart':
      return 'working';
    case 'PreToolUse':
      return input.tool_name === 'AskUserQuestion' ? 'waiting' : 'working';
    case 'PermissionRequest':
      return 'waiting';
    case 'Notification':
      return WAITING_NOTIFICATIONS.has(input.notification_type) ? 'waiting' : undefined;
    case 'Stop':
      return 'done';
    case 'StopFailure':
      return 'error';
    default:
      return undefined;
  }
}

function isConversation(input) {
  const event = input.hook_event_name;
  if (event === 'SessionStart') return input.source === 'resume';
  return !['SessionEnd', 'Notification'].includes(event);
}

function titleOf(session) {
  return session.customTitle || session.aiTitle || null;
}

function nextConversation(list, lastId) {
  if (!list.length) return null;
  const at = list.findIndex((conversation) => conversation.id === lastId);
  return list[(at + 1) % list.length];
}

class ConversationStore extends EventEmitter {
  constructor({ now = () => Date.now() } = {}) {
    super();
    this.now = now;
    // sessionId -> { tabId, state, since, procs, transcript, conversation,
    //                seq, aiTitle, customTitle, lastPrompt, unread, archived, at, cwd }
    this.sessions = new Map();
    this.procs = new Map(); // procId -> the sessionId it runs now
    this.codexProcs = new Map(); // app-server procId -> all the threads it holds
    this.seq = 0;
  }

  handle(tabId, input, procId = null) {
    const id = input.session_id;
    if (!id) return;
    if (input.hook_event_name === 'SessionEnd') {
      if (procId && this.procs.get(procId) === id) this.procs.delete(procId);
      if (this.drop(id, procId)) this.emit('change', tabId);
      return;
    }
    // A panel whose claude moves on to another conversation (/clear, say) no longer shows the
    // one before.
    const before = procId && this.procs.get(procId);
    if (before && before !== id) this.drop(before, procId);
    if (procId) this.procs.set(procId, id);

    const now = this.now();
    let session = this.sessions.get(id);
    if (!session) {
      session = { tabId, state: 'idle', since: now, procs: new Set(), transcript: null, conversation: false, seq: ++this.seq, unread: false, archived: false };
      this.sessions.set(id, session);
    }
    session.tabId = tabId;
    if (procId) session.procs.add(procId);
    if (input.transcript_path) session.transcript = input.transcript_path;
    // Where Claude works now: it follows a move into another worktree, while the panel stays
    // in the tab's VS Code.
    if (typeof input.cwd === 'string') session.cwd = input.cwd;
    if (!session.conversation && isConversation(input)) {
      session.conversation = true;
      this.emit('observe-claude', session);
    }
    const state = nextState(input);
    if (state && state !== session.state) {
      if ((state === 'working' || state === 'waiting') && !['working', 'waiting'].includes(session.state)) {
        // Watch for interruptions from here on, so an older one does not count.
        this.emit('observe-claude', session);
        // An archived conversation that works again (a prompt sent from the panel's history)
        // is back on the list.
        session.archived = false;
      }
      this.setState(id, session, state, now);
    }
    session.at = now;
    this.emit('change', tabId);
  }

  // Moves a session into a state, which it has been in since `now`.
  setState(id, session, state, now = this.now()) {
    session.state = state;
    session.since = now;
    this.emit('state', session.tabId, id, state);
  }

  // One Codex app-server holds several threads at once. Unlike Claude, loading another thread
  // must not release those already held by this process.
  handleCodex(tabId, input, procId) {
    if (!procId || typeof input.threadId !== 'string' || !input.threadId) return;
    const id = `codex:${tabId}:${input.threadId}`;
    if (input.restoreFailed) {
      if (this.sessions.has(id)) this.emit('restore-failed', tabId, id);
      return;
    }
    if (input.ended) {
      if (input.reason === 'archived' || input.reason === 'deleted') {
        // These are persisted Codex operations, unlike closing a loaded thread or hiding a row.
        this.sessions.delete(id);
        for (const [holder, ids] of this.codexProcs) {
          ids.delete(id);
          if (!ids.size) this.codexProcs.delete(holder);
        }
        this.emit('change', tabId);
        return;
      }
      const ids = this.codexProcs.get(procId);
      ids?.delete(id);
      if (ids?.size === 0) this.codexProcs.delete(procId);
      if (this.drop(id, procId)) this.emit('change', tabId);
      return;
    }
    if (!PRIORITY.includes(input.state)) return;
    const now = this.now();
    let session = this.sessions.get(id);
    if (!session) {
      session = { tabId, provider: 'codex', threadId: input.threadId, state: 'idle', since: now, procs: new Set(), transcript: null, conversation: false, seq: ++this.seq, unread: false, archived: false };
      this.sessions.set(id, session);
    }
    if (session.tabId !== tabId) return;
    if (!this.codexProcs.has(procId)) this.codexProcs.set(procId, new Set());
    this.codexProcs.get(procId).add(id);
    session.procs.add(procId);
    session.conversation ||= Boolean(input.conversation) || input.state !== 'idle';
    if (typeof input.title === 'string') session.customTitle = input.title;
    if (typeof input.prompt === 'string' && (input.promptSource !== 'preview' || !session.lastPrompt)) session.lastPrompt = input.prompt;
    if (typeof input.cwd === 'string') session.cwd = input.cwd;
    if (typeof input.turnId === 'string') session.turnId = input.turnId;
    if (typeof input.ephemeral === 'boolean') session.ephemeral = input.ephemeral;
    if (input.subagent === true) {
      session.subagent = true;
      session.unread = false;
      for (const key of ['parentThreadId', 'agentNickname', 'agentRole', 'agentPath']) {
        if (typeof input[key] === 'string' && input[key]) session[key] = input[key];
      }
    }
    if (input.state !== session.state) {
      if (input.state === 'working' || input.state === 'waiting') session.archived = false;
      this.setState(id, session, input.state, now);
    }
    session.at = now;
    this.emit('change', tabId);
  }

  // Takes a process off a session. Without a process id, or when no process holds the
  // session any more, the session ends. Returns true when it ended.
  drop(sessionId, procId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (procId) session.procs.delete(procId);
    if (session.procs.size) return false;
    if (this.resumable(session)) {
      // An ended claude or a closed app-server deletes neither the stored conversation nor the
      // persisted thread. Keep a row that resumes it when clicked.
      this.rest(session);
      return true;
    }
    this.sessions.delete(sessionId);
    return true;
  }

  // Whether a session keeps a row once nothing runs it: a conversation that its agent stores
  // (a Claude session, a Codex thread that is not ephemeral).
  resumable(session) {
    return session.conversation && !session.ephemeral;
  }

  // An idle row with nothing running it, which carries no busy state or unread result into the
  // next process. Its transcript is not read until a hook names it again: nothing writes to it,
  // and reading one in WSL would wake the distribution.
  rest(session) {
    session.state = 'idle';
    session.since = this.now();
    session.unread = false;
    session.transcript = null;
  }

  // A wrapper process ended. Returns the tab whose conversations ended with it, if any.
  procEnded(procId) {
    const codex = this.codexProcs.get(procId);
    if (codex) {
      this.codexProcs.delete(procId);
      let tabId;
      for (const id of codex) {
        const tab = this.sessions.get(id)?.tabId;
        if (this.drop(id, procId)) tabId = tab;
      }
      return tabId;
    }
    const sessionId = this.procs.get(procId);
    if (!sessionId) return undefined;
    this.procs.delete(procId);
    const tabId = this.sessions.get(sessionId)?.tabId;
    return this.drop(sessionId, procId) ? tabId : undefined;
  }

  // A claude process that poll cannot see ended: one in WSL, which the distribution's agent
  // watches.
  endProc(procId) {
    const tabId = this.procEnded(procId);
    if (tabId) this.emit('change', tabId);
  }


  // The observer supplies complete title records; the store owns navigation metadata.
  updateTranscript(session, records) {
    for (const record of records) {
      if (record.type === 'custom-title' && record.customTitle) session.customTitle = record.customTitle;
      else if (record.type === 'ai-title' && record.aiTitle) session.aiTitle = record.aiTitle;
      else if (record.type === 'last-prompt' && record.lastPrompt) session.lastPrompt = record.lastPrompt;
    }
  }

  // The tab's processes are gone. `keepRows`: the tab stays open (suspended, stopped for an
  // update, or restarting), so its conversations stay as idle rows; closing it removes them.
  clearTab(tabId, { keepRows = false } = {}) {
    for (const [id, session] of this.sessions) {
      if (session.tabId !== tabId) continue;
      const keep = keepRows && this.resumable(session);
      if (!keep) this.sessions.delete(id);
      for (const procId of session.procs) this.procs.delete(procId);
      for (const procId of session.procs) {
        const ids = this.codexProcs.get(procId);
        ids?.delete(id);
        if (ids?.size === 0) this.codexProcs.delete(procId);
      }
      session.procs.clear();
      if (keep) this.rest(session);
    }
    this.emit('change', tabId);
  }

  // The most urgent state among the tab's sessions. An archived one does not count: the tab
  // would show an error that no row explains.
  tabState(tabId) {
    let best = null;
    for (const session of this.sessions.values()) {
      if (session.tabId !== tabId || session.archived) continue;
      if (best === null || PRIORITY.indexOf(session.state) < PRIORITY.indexOf(best)) best = session.state;
    }
    return best;
  }

  // The tab's conversations that are not archived, in the order they started: { id, title,
  // prompt, state, since, unread, cwd }. title is the one the extension shows on the
  // conversation's tab (null before it has one); since is when it came into its state (ms); cwd is
  // the folder Claude works in (null before a hook has told it).
  conversations(tabId) {
    return [...this.sessions]
      .filter(([, session]) => session.tabId === tabId && session.conversation && !session.archived)
      .sort(([, a], [, b]) => a.seq - b.seq)
      .map(([id, session]) => ({
        id,
        title: titleOf(session),
        prompt: session.lastPrompt || null,
        state: session.state,
        since: session.since,
        unread: session.unread,
        cwd: session.cwd || null,
        ...(session.provider ? { agent: session.provider, threadId: session.threadId, turnId: session.turnId || null,
          ...(session.subagent ? { subagent: true, parentThreadId: session.parentThreadId,
            agentNickname: session.agentNickname, agentRole: session.agentRole, agentPath: session.agentPath } : {}),
          ...(session.ephemeral ? { ephemeral: true } : {}) } : {}),
      }));
  }

  // The tab's rows for tabs.json, in the order they started. Store only navigation metadata,
  // never process IDs, live state, unread marks, transcripts, or credentials. A Claude row keeps
  // its two titles apart, so that a title given by hand still beats a newer AI one.
  history(tabId) {
    return [...this.sessions]
      .filter(([, s]) => s.tabId === tabId && this.resumable(s))
      .sort(([, a], [, b]) => a.seq - b.seq)
      .map(([id, s]) => (s.provider === 'codex'
        ? { agent: 'codex', threadId: s.threadId, turnId: s.turnId || null,
          title: titleOf(s), prompt: s.lastPrompt || null, cwd: s.cwd || null, archived: s.archived,
          ...(s.subagent ? { subagent: true, parentThreadId: s.parentThreadId,
            agentNickname: s.agentNickname, agentRole: s.agentRole, agentPath: s.agentPath } : {}) }
        : { agent: 'claude', sessionId: id, title: s.customTitle || null, aiTitle: s.aiTitle || null,
          prompt: s.lastPrompt || null, cwd: s.cwd || null, archived: s.archived }));
  }

  // Brings back what history() saved, as idle rows that run nothing until one is clicked.
  restoreHistory(tabId, history) {
    if (!Array.isArray(history)) return;
    for (const item of history) {
      if (!item || typeof item !== 'object') continue;
      const text = (key) => typeof item[key] === 'string' ? item[key] : null;
      const row = { tabId, lastPrompt: text('prompt'), cwd: text('cwd'), archived: item.archived === true,
        state: 'idle', since: this.now(), procs: new Set(), transcript: null, conversation: true, unread: false };
      if (item.agent === 'codex' && typeof item.threadId === 'string' && SAVED_ID.test(item.threadId)) {
        const id = `codex:${tabId}:${item.threadId}`;
        if (this.sessions.has(id)) continue;
        this.sessions.set(id, { ...row, provider: 'codex', threadId: item.threadId, turnId: text('turnId'),
          ...(item.subagent === true ? { subagent: true, parentThreadId: text('parentThreadId'),
            agentNickname: text('agentNickname'), agentRole: text('agentRole'), agentPath: text('agentPath') } : {}),
          customTitle: text('title'), seq: ++this.seq });
      } else if (item.agent === 'claude' && typeof item.sessionId === 'string' && SAVED_ID.test(item.sessionId)) {
        // A Claude session is one tab's at a time: the last tab whose claude ran it.
        if (this.sessions.has(item.sessionId)) continue;
        this.sessions.set(item.sessionId, { ...row, customTitle: text('title'), aiTitle: text('aiTitle'), seq: ++this.seq });
      }
    }
    this.emit('change', tabId);
  }

  // The conversations in a state ('waiting', 'working'), tab by tab in `tabOrder`, each tab's in
  // the order they started: [{ tabId, id }]. The badges at the top of the side bar count them,
  // and go through them in this order.
  inState(state, tabOrder) {
    return tabOrder.flatMap((tabId) => this.conversations(tabId)
      .filter((conversation) => conversation.state === state)
      .map((conversation) => ({ tabId, id: conversation.id })));
  }

  markUnread(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && !session.subagent) session.unread = true;
  }

  isSubagent(sessionId) {
    return this.sessions.get(sessionId)?.subagent === true;
  }

  // An unknown conversation must keep every result unread. Returns true when it was unread.
  markSeen(tabId, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.tabId !== tabId || !session.unread) return false;
    session.unread = false;
    return true;
  }

  hasUnread(tabId) {
    return [...this.sessions.values()].some((session) => session.tabId === tabId && session.unread);
  }

  // Takes one of the tab's conversations off the list, and marks its result as seen. Its claude
  // goes on, as the extension's own archive leaves it; it is back on the list once it works or
  // waits again (see handle). One that works or waits now stays: the list is there to watch
  // those. Returns true when it was taken off.
  // A Codex conversation's subagents (and theirs) go with it, whatever state they show: a child
  // whose completion never arrived would show as working for good, with no way to archive it. They
  // are set idle, so that a turn they start later brings them back, as for any archived row.
  archive(tabId, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.tabId !== tabId || session.archived) return false;
    if (session.state === 'working' || session.state === 'waiting') return false;
    session.archived = true;
    session.unread = false;
    const parents = new Set(session.threadId ? [session.threadId] : []);
    for (let added = true; added;) {
      added = false;
      for (const [id, child] of this.sessions) {
        if (child.tabId !== tabId || !child.subagent || child.archived || !parents.has(child.parentThreadId)) continue;
        child.archived = true;
        child.unread = false;
        if (child.state === 'working' || child.state === 'waiting') this.setState(id, child, 'idle');
        if (child.threadId) parents.add(child.threadId);
        added = true;
      }
    }
    return true;
  }

  snapshot() {
    return [...this.sessions].map(([id, s]) => ({
      id,
      tabId: s.tabId,
      state: s.state,
      since: s.since,
      procs: [...s.procs],
      conversation: s.conversation,
      title: titleOf(s),
      unread: s.unread,
      archived: s.archived,
      at: s.at,
    }));
  }
}

module.exports = { ConversationStore, PRIORITY, nextState, nextConversation, titleOf };
