// Requests and cache ownership are independent of DOM rendering. A changed callback goes
// through the renderer's press hold, so asynchronous replies cannot replace a pressed row.

/**
 * The parts of the side bar's state (sidebar.js) this reads and fills in, by repository key.
 * @typedef {object} SidebarDataState
 * @property {Map<string, { status: string, items: any[], error?: string, read?: Promise<void> }>} worktrees
 * @property {Map<string, any[]>} savedWorktrees
 * @property {Map<string, any>} github
 * @property {Map<string, PullsEntry>} pulls
 * @property {Set<string>} expanded
 */
/**
 * @typedef {object} PullsEntry
 * @property {string | null} key the query the entry answers (its branches, numbers, and heads)
 * @property {number} at
 * @property {symbol | null} read the read in flight
 * @property {{ branches: Set<string>, pulls: Map<string, any>, heads: Map<string, any> } | null} result
 * @property {any} timer
 * @property {Promise<void>} [promise]
 */
/**
 * @typedef {{ branches: string[], numbers: Array<[string, number]>, heads: string[] }} PullsQuery
 * @typedef {{ key: string, path: string }} DataGroup
 */
/**
 * @typedef {object} SidebarDataOptions
 * @property {SidebarDataState} state
 * @property {Pick<SidebarHost, 'getWorktrees' | 'github' | 'pullRequests'>} host
 * @property {() => void} changed
 * @property {() => DataGroup[]} groups
 * @property {(group: DataGroup) => PullsQuery} pullBranches
 * @property {(result: PullsEntry['result'], now: number) => boolean} checksRunning
 * @property {() => number} [now]
 * @property {(fn: () => void, ms: number) => any} [schedule]
 * @property {(id: any) => void} [cancel]
 * @property {number} [stale]
 * @property {number} [pending]
 * @property {number} [githubRetry] ms before a repository whose remote git failed to read is read again
 * @property {number} [githubRetryMax] the longest wait between such reads, which double until then
 */
const SidebarData = (() => {
  class SidebarData {
    // Browser timers reject the controller as their receiver, so defaults must wrap them.
    /** @param {SidebarDataOptions} options */
    constructor({ state, host, changed, groups, pullBranches, checksRunning, now = Date.now,
      schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id), stale = 15000, pending = 60000,
      githubRetry = 15000, githubRetryMax = 5 * 60 * 1000 }) {
      this.state = state;
      this.host = host;
      this.changed = changed;
      this.groups = groups;
      this.pullBranches = pullBranches;
      this.checksRunning = checksRunning;
      this.now = now;
      this.schedule = schedule;
      this.cancel = cancel;
      this.stale = stale;
      this.pending = pending;
      this.githubRetry = githubRetry;
      this.githubRetryMax = githubRetryMax;
      /** @type {Map<string, Promise<void>>} */
      this.githubReads = new Map();
      /** @type {Map<string, { count: number, retryAt: number }>} the failed reads in a row, by repository */
      this.githubFailures = new Map();
      this.disposed = false;
    }

    worktrees(repo) {
      if (this.disposed) return Promise.resolve();
      const key = repo.path.toLowerCase();
      const current = this.state.worktrees.get(key);
      if (current?.status === 'loading') return current.read;
      const entry = { status: 'loading', items: current?.items || this.state.savedWorktrees.get(key) || [] };
      this.state.worktrees.set(key, entry);
      entry.read = (async () => {
        const result = await this.host.getWorktrees(repo.path).catch((error) => ({ error: String(error.message || error) }));
        if (this.disposed || this.state.worktrees.get(key) !== entry) return;
        this.state.worktrees.set(key, Array.isArray(result)
          ? { status: 'ready', items: result }
          : { status: 'error', items: entry.items, error: result.error });
        this.state.savedWorktrees.delete(key);
        this.changed();
      })();
      this.changed();
      return entry.read;
    }

    // Reads where a repository's remote is: its GitHub repository, or null when it is not on GitHub.
    // A read that git failed ({ error }, or a rejection) is not taken for "not on GitHub": the
    // repository stays unknown, so its row trusts the main process's word (state.providers), and
    // a later call (a render, or the mouse on its icon) reads it again. The waits double after each
    // failure in a row, so that a WSL distribution that does not answer is not asked on every render.
    github(group) {
      if (this.disposed) return Promise.resolve();
      if (this.githubReads.has(group.key)) return this.githubReads.get(group.key);
      if (this.state.github.has(group.key)) return Promise.resolve();
      if (this.now() < (this.githubFailures.get(group.key)?.retryAt ?? 0)) return Promise.resolve();
      this.state.github.set(group.key, undefined);
      const read = (async () => {
        const repo = await this.host.github(group.path).catch((error) => ({ error: String(error?.message || error) }));
        if (this.disposed || this.githubReads.get(group.key) !== read) return;
        this.githubReads.delete(group.key);
        if (repo && repo.error) {
          this.state.github.delete(group.key);
          const count = (this.githubFailures.get(group.key)?.count ?? 0) + 1;
          const wait = Math.min(this.githubRetry * 2 ** (count - 1), this.githubRetryMax);
          this.githubFailures.set(group.key, { count, retryAt: this.now() + wait });
          return;
        }
        this.githubFailures.delete(group.key);
        this.state.github.set(group.key, repo);
        this.changed();
      })();
      this.githubReads.set(group.key, read);
      return read;
    }

    forgetGithub() {
      this.githubReads.clear();
      this.githubFailures.clear();
      this.state.github.clear();
    }

    pulls(group, when = 'changed') {
      if (this.disposed || !this.state.github.get(group.key)) return;
      const query = this.pullBranches(group);
      const { branches, numbers, heads } = query;
      const key = JSON.stringify([branches, numbers, heads]);
      const entry = this.state.pulls.get(group.key) || /** @type {PullsEntry} */ ({ key: null, at: 0, read: null, result: null, timer: null });
      if (entry.key === key && (entry.read || when === 'changed' || (when === 'stale' && this.now() - entry.at < this.stale))) return entry.promise;
      this.cancel(entry.timer);
      entry.timer = null;
      this.state.pulls.set(group.key, entry);
      if (!branches.length && !heads.length) {
        Object.assign(entry, { key, read: null, at: this.now(), result: { branches: new Set(), pulls: new Map(), heads: new Map() } });
        return;
      }
      const read = Symbol('read');
      Object.assign(entry, { key, read });
      entry.promise = this.fetchPulls(group, query, entry, read);
      return entry.promise;
    }

    async fetchPulls(group, { branches, numbers, heads }, entry, read) {
      const found = await this.host.pullRequests(group.path, branches, numbers, heads).catch(() => null);
      // A changed query, refresh, or page disposal invalidates the previous owner.
      if (this.disposed || this.state.pulls.get(group.key) !== entry || entry.read !== read) return;
      entry.read = null;
      entry.at = this.now();
      if (found) entry.result = { branches: new Set(branches), pulls: new Map(Object.entries(found.pulls)), heads: new Map(Object.entries(found.heads)) };
      if (found && this.checksRunning(entry.result, this.now())) {
        entry.timer = this.schedule(() => {
          entry.timer = null;
          const current = this.groups().find((g) => g.key === group.key);
          if (current && this.state.expanded.has(group.key)) this.pulls(current, 'now');
        }, this.pending);
      }
      this.changed();
    }

    forgetPulls() {
      for (const entry of this.state.pulls.values()) this.cancel(entry.timer);
      this.state.pulls.clear();
    }

    dispose() {
      this.disposed = true;
      this.forgetGithub();
      this.forgetPulls();
    }
  }
  return SidebarData;
})();
if (typeof module === 'object') module.exports = { SidebarData };
