// Observes the extension's app-server protocol without making requests or approval decisions.
const { CodexQuotaObserver } = require('./codex-quota');
const WAITING_REQUESTS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);
const WAITING_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);
const METADATA_SOURCES = new Set(['thread_title', 'thread_description']);

function excludedThread(value) {
  const source = value?.source?.subAgent || value?.source?.subagent;
  return METADATA_SOURCES.has(value?.threadSource)
    || typeof source === 'string' || Boolean(source?.other)
    || ((value?.source === 'subAgent' || source) && !subagentOf(value));
}

function subagentOf(value) {
  const spawn = (value?.source?.subAgent || value?.source?.subagent)?.thread_spawn;
  const parentThreadId = value?.parentThreadId || spawn?.parent_thread_id;
  if (typeof parentThreadId !== 'string' || !parentThreadId) return null;
  const result = { subagent: true, parentThreadId };
  for (const [key, candidate] of [['agentNickname', value.agentNickname || spawn?.agent_nickname],
    ['agentRole', value.agentRole || spawn?.agent_role], ['agentPath', spawn?.agent_path]]) {
    if (typeof candidate === 'string' && candidate) result[key] = candidate;
  }
  return result;
}

const IDLE_STATUSES = new Set(['idle', 'notLoaded']);

// A status this observer does not know may come from a newer extension. Calling it idle would
// let an update stop a turn in progress, so it counts as working until a known status replaces it.
function runtimeState(status) {
  if (status?.type === 'active') return status.activeFlags?.some((flag) => WAITING_FLAGS.has(flag)) ? 'waiting' : 'working';
  if (status?.type === 'systemError') return 'error';
  if (status?.type === undefined || IDLE_STATUSES.has(status.type)) return 'idle';
  return 'working';
}

function promptOf(content) {
  return Array.isArray(content) ? content.filter((item) => item.type === 'text').map((item) => item.text).join('\n') : '';
}

class CodexObserver {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.quota = new CodexQuotaObserver(onEvent);
    this.threads = new Map();
    this.requests = new Map();
    this.ignored = new Set();
    this.excluded = new Set();
    this.deferred = new Map();
    this.collabCalls = new Map();
    this.initializeId = undefined;
    this.observed = false;
  }

  client(message) {
    this.quota.client(message);
    if (message?.id !== undefined && message.method === 'initialize') this.initializeId = message.id;
    // Conversation responses are separate from the quota observer's strict projection.
    // Full auth responses never go to Worktabs; thread/list must not create live rows.
    if (message?.id !== undefined && ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
      const { threadId, threadSource, ephemeral } = message.params || {};
      this.requests.set(message.id, { method: message.method, threadId, threadSource, ephemeral });
    }
  }

  server(message) {
    this.quota.server(message);
    this.observe(message);
  }

  observe(message) {
    if (!message || typeof message !== 'object') return;
    // The app-server answering the extension's initialize shows that this proxy sits on the pipe
    // the extension actually talks over, so the turns that follow are visible.
    if (!this.observed && this.initializeId !== undefined && !message.method && message.id === this.initializeId && message.result) {
      this.observed = true;
      this.onEvent({ type: 'codex-observer' });
      return;
    }
    const request = this.requests.get(message.id);
    if (request && !message.method) {
      this.requests.delete(message.id);
      if (message.result?.thread) this.load(message.result.thread, request.method !== 'thread/start', request);
      else if (message.error && request.method === 'thread/resume' && typeof request.threadId === 'string'
        && !this.excluded.has(request.threadId) && !excludedThread(request)) {
        this.onEvent({ threadId: request.threadId, restoreFailed: true });
      }
      this.flushDeferred();
      return;
    }
    const { method, params: p } = message;
    if (!p || typeof p !== 'object') return;
    if (method === 'thread/started') {
      if (this.excluded.has(p.thread?.id)) return;
      if (!excludedThread(p.thread) && this.defer(message, p.thread?.id)) return;
      return this.load(p.thread, false);
    }
    const id = p.threadId;
    if (typeof id !== 'string' || !id || this.ignored.has(id) || this.excluded.has(id)) return;
    if (['thread/closed', 'thread/archived', 'thread/deleted'].includes(method)) {
      if (this.defer(message, id)) return;
      this.threads.delete(id);
      this.clearCollaborations(id);
      if (method !== 'thread/closed') this.ignored.add(id);
      this.onEvent({ threadId: id, ended: true, reason: method.slice('thread/'.length) });
      return;
    }
    const known = this.threads.get(id);
    const relevant = ['turn/started', 'turn/completed', 'thread/status/changed', 'thread/name/updated',
      'item/started', 'item/completed', 'serverRequest/resolved', 'error'].includes(method) || WAITING_REQUESTS.has(method);
    if (!relevant) return;
    if (this.defer(message, id)) return;
    const thread = known || this.create(id);
    // Late item/approval events from an interrupted turn must not revive it or end a newer turn.
    const turnId = p.turnId || p.turn?.id;
    if (method !== 'turn/started' && turnId && thread.turnId && turnId !== thread.turnId) return;
    if (method === 'turn/started') {
      if (!p.turn?.id) return;
      if (thread.turnId !== p.turn.id) {
        this.clearCollaborations(id);
        thread.pending.clear();
        thread.runtimeWaiting = false;
      }
      thread.turnId = p.turn.id;
      thread.terminal = false;
      thread.conversation = true;
      thread.state = this.waiting(thread) ? 'waiting' : 'working';
    } else if (method === 'turn/completed') {
      const state = { completed: 'done', failed: 'error', interrupted: 'idle' }[p.turn?.status];
      if (!state) return;
      thread.pending.clear();
      this.clearCollaborations(id);
      thread.runtimeWaiting = false;
      thread.terminal = true;
      thread.state = state;
      thread.conversation = true;
    } else if (WAITING_REQUESTS.has(method)) {
      if (message.id === undefined || thread.terminal) return;
      thread.pending.set(message.id, p.itemId);
      thread.conversation = true;
      thread.state = 'waiting';
    } else if (method === 'serverRequest/resolved') {
      if (!thread.pending.delete(p.requestId)) return;
      if (!thread.terminal) thread.state = this.waiting(thread) ? 'waiting' : 'working';
    } else if (method === 'thread/status/changed') {
      const state = runtimeState(p.status);
      // A delayed active status for a finished turn is not a new turn. Only turn/started
      // can revive a terminal thread; otherwise a background child can spin forever.
      if (thread.terminal && p.status?.type === 'active') return;
      thread.runtimeWaiting = state === 'waiting';
      // Runtime idle follows turn/completed; keep the result until another turn starts.
      if (!(state === 'idle' && thread.terminal)) thread.state = this.waiting(thread) ? 'waiting' : state;
      if (state === 'error') thread.terminal = true;
      if (thread.state === 'working' || thread.state === 'waiting') thread.conversation = true;
    } else if (method === 'thread/name/updated') {
      if (typeof p.threadName === 'string') thread.title = p.threadName;
    } else if (method === 'error') {
      // A transient network failure can retry within the same turn.
      if (p.willRetry) return;
      thread.terminal = true;
      thread.pending.clear();
      thread.runtimeWaiting = false;
      thread.state = 'error';
      this.clearCollaborations(id);
      thread.conversation = true;
    } else {
      if (!thread.terminal && p.item?.type === 'collabAgentToolCall') this.collaboration(thread, p.item, method === 'item/completed');
      if (p.item?.type === 'subAgentActivity') this.subAgentActivity(thread, p.item);
      if (p.item?.type === 'userMessage') {
        thread.prompt = promptOf(p.item.content);
        thread.promptSource = 'user';
        thread.conversation = true;
      }
      if (typeof p.item?.cwd === 'string') thread.cwd = p.item.cwd;
      // Older servers resolve tool approvals only by completing the associated item.
      if (method === 'item/completed' && p.item?.id) {
        for (const [requestId, itemId] of thread.pending) if (itemId === p.item.id) thread.pending.delete(requestId);
      }
      if (!thread.terminal && thread.state !== 'idle') thread.state = this.waiting(thread) ? 'waiting' : 'working';
    }
    this.emit(thread);
  }

  create(id) {
    const thread = { threadId: id, state: 'idle', conversation: false, terminal: false, pending: new Map() };
    this.threads.set(id, thread);
    return thread;
  }

  collaboration(parent, item, completed) {
    if (typeof item.id !== 'string' || !item.id) return;
    const key = `${parent.threadId}:${item.id}`;
    if (!completed) {
      this.collabCalls.set(key, new Map((item.receiverThreadIds || []).map((id) => [id, this.threads.get(id)?.turnId])));
      return;
    }
    const turns = this.collabCalls.get(key);
    this.collabCalls.delete(key);
    // Target states, rather than the tool's own completion, tell whether a child finished.
    // A completed spawn or a timed-out wait can still leave the target running.
    for (const id of item.receiverThreadIds || []) {
      if (typeof id !== 'string' || !id || id === parent.threadId || this.excluded.has(id) || this.ignored.has(id)) continue;
      const existing = this.threads.get(id);
      if (!existing && item.tool !== 'spawnAgent') continue;
      // A message can target an ancestor or peer. Only spawn/wait identifies an otherwise
      // unknown child; messages must not turn an ordinary parent into its own descendant.
      if (existing && !existing.subagent && !['spawnAgent', 'wait'].includes(item.tool)) continue;
      const child = existing || this.create(id);
      child.subagent = true;
      // sendInput can target a sibling; it does not change the child's original parent.
      child.parentThreadId ||= item.senderThreadId || parent.threadId;
      child.conversation = true;
      const status = item.agentsStates?.[id]?.status;
      const state = { pendingInit: 'working', running: 'working', completed: 'done', errored: 'error',
        interrupted: 'idle', shutdown: 'idle', notFound: 'idle' }[status] || (status || !existing ? 'working' : null);
      const sameTurn = !turns?.has(id) || turns.get(id) === child.turnId;
      if (state && sameTurn && !(child.terminal && state === 'working')) {
        child.state = state === 'working' && this.waiting(child) ? 'waiting' : state;
        if (!['working', 'waiting'].includes(state)) {
          child.pending.clear();
          child.runtimeWaiting = false;
          child.terminal = true;
        }
      }
      this.emit(child);
    }
  }

  // Newer servers report a spawned child as subAgentActivity in its parent's turn rather than as a
  // spawnAgent call. Only "started" identifies an unknown child: later activity can target an ancestor.
  subAgentActivity(parent, item) {
    const id = item.agentThreadId;
    if (typeof id !== 'string' || !id || id === parent.threadId || this.excluded.has(id) || this.ignored.has(id)) return;
    const existing = this.threads.get(id);
    if (item.kind !== 'started' && !existing?.subagent) return;
    if (existing?.subagent && (existing.agentPath || typeof item.agentPath !== 'string')) return;
    const child = existing || this.create(id);
    child.subagent = true;
    child.parentThreadId ||= parent.threadId;
    if (typeof item.agentPath === 'string' && item.agentPath) child.agentPath ||= item.agentPath;
    child.conversation = true;
    if (!existing) child.state = 'working';
    this.emit(child);
  }

  clearCollaborations(id) {
    for (const key of this.collabCalls.keys()) if (key.startsWith(`${id}:`)) this.collabCalls.delete(key);
  }

  waiting(thread) {
    return thread.pending.size > 0 || thread.runtimeWaiting;
  }

  pendingCreation() {
    return [...this.requests.values()].some((request) => ['thread/start', 'thread/fork'].includes(request.method));
  }

  defer(message, id) {
    // A notification can precede the response that gives a new thread its request's source.
    // Do not guess which pending start/fork owns it, or publish a transient internal row.
    if (typeof id !== 'string' || !id || this.threads.has(id) || !this.pendingCreation()) return false;
    if (!this.deferred.has(id)) this.deferred.set(id, []);
    this.deferred.get(id).push(message);
    return true;
  }

  flushDeferred() {
    for (const [id, messages] of this.deferred) {
      if (!this.threads.has(id) && this.pendingCreation()) continue;
      this.deferred.delete(id);
      for (const message of messages) this.observe(message);
    }
  }

  load(value, resumed, request = {}) {
    if (typeof value?.id !== 'string' || !value.id) return;
    // Exclusion survives close and later snapshots that omit the source. Ephemeral alone
    // does not identify metadata generation: user-created temporary chats stay visible.
    if (this.excluded.has(value.id) || excludedThread(value) || excludedThread(request)) {
      this.excluded.add(value.id);
      this.threads.delete(value.id);
      this.deferred.delete(value.id);
      return;
    }
    const thread = this.threads.get(value.id) || this.create(value.id);
    const subagent = subagentOf(value);
    if (subagent) Object.assign(thread, subagent);
    this.ignored.delete(value.id);
    const ephemeral = typeof value.ephemeral === 'boolean' ? value.ephemeral : request.ephemeral;
    if (typeof ephemeral === 'boolean') thread.ephemeral = ephemeral;
    // Replay live events before applying the response's possibly older snapshot. Set the
    // request's ephemeral flag first so temporary conversations cannot enter saved history.
    const messages = this.deferred.get(value.id);
    this.deferred.delete(value.id);
    if (messages) {
      for (const message of messages) this.observe(message);
      if (this.threads.get(value.id) !== thread) return;
    }
    if (typeof value.cwd === 'string') thread.cwd = value.cwd;
    if (typeof value.name === 'string') thread.title = value.name;
    const turns = Array.isArray(value.turns) ? value.turns : [];
    const lastTurn = turns.at(-1);
    // A preview is often the first prompt, not the last one. Loaded turns take precedence,
    // and an idle resume snapshot must not overwrite an already observed live turn.
    if (!thread.terminal && !['working', 'waiting'].includes(thread.state)) {
      if (typeof lastTurn?.id === 'string') thread.turnId = lastTurn.id;
      const messages = turns.flatMap((turn) => Array.isArray(turn.items) ? turn.items : [])
        .filter((item) => item.type === 'userMessage');
      const prompt = messages.length ? promptOf(messages.at(-1).content) : null;
      if (prompt !== null) {
        thread.prompt = prompt;
        thread.promptSource = 'user';
      } else if (!thread.prompt && typeof value.preview === 'string' && value.preview) {
        thread.prompt = value.preview;
        thread.promptSource = 'preview';
      }
    }
    if (resumed || thread.prompt) thread.conversation = true;
    if (!thread.terminal && value.status) {
      const state = runtimeState(value.status);
      if (state === 'waiting') thread.runtimeWaiting = true;
      // A resume response can arrive while its live turn emits events. Its idle snapshot
      // must not clear a newer turn or an approval request already observed on the stream.
      if (state !== 'idle' || !['working', 'waiting'].includes(thread.state)) {
        thread.state = this.waiting(thread) ? 'waiting' : state;
      }
    }
    // A thread started or opened in the chat: the app reads which one the chat shows.
    this.emit(thread, { loaded: true });
  }

  emit(thread, extra = {}) {
    const { threadId, turnId, state, conversation, title, prompt, promptSource, cwd, ephemeral,
      subagent, parentThreadId, agentNickname, agentRole, agentPath } = thread;
    this.onEvent({ threadId, turnId, state, conversation, title, prompt, promptSource, cwd, ephemeral,
      ...(subagent ? { subagent, parentThreadId, agentNickname, agentRole, agentPath } : {}), ...extra });
  }
}

module.exports = { CodexObserver, promptOf, runtimeState };
