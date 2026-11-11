// Tab identity and server ownership live here, apart from Electron. A folder can be reopened
// while its previous start is still waiting on git, installation, or the cookie store.
const { nextActive, openAmong } = require('./tab-close');
const { TabPorts } = require('./tab-ports');

class TabLifecycle {
  constructor(deps) {
    this.deps = deps;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.ports = new TabPorts({ idOf: deps.idOf, isOpen: (id) => this.tabs.has(id) });
    this.runs = new Map();
    this.starts = new Map();
    this.closingTogether = false;
  }

  current(tab) {
    return Boolean(tab && this.tabs.get(tab.id) === tab);
  }

  currentRun(run) {
    return this.current(run.tab) && this.runs.get(run.tab.id) === run;
  }

  notify(save = false) {
    if (save) this.deps.save();
    this.deps.changed();
  }

  /**
   * @param {string} folder
   * @param {{ activate?: boolean, start?: boolean, provider?: string }} [options]
   */
  open(folder, { activate = true, start = true, provider } = {}) {
    const resolved = this.deps.resolveFolder(folder);
    const id = this.deps.idOf(resolved);
    if (!this.tabs.has(id)) {
      const tab = { ...this.deps.describe(resolved, provider), id, folder: resolved, server: 'sleeping' };
      this.tabs.set(id, tab);
      this.order.push(id);
      this.deps.mount(tab);
      this.deps.placeholder(tab, 'initial');
      tab.repoLookup = Promise.resolve().then(() => this.deps.lookupRepo(tab)).then((info) => {
        if (this.current(tab)) {
          Object.assign(tab, info);
          this.deps.used(tab);
          this.notify();
        }
        return info.repo;
      });
      // A suspended tab may never start, but a failed lookup still belongs to its next start.
      tab.repoLookup.catch(() => {});
      Promise.resolve().then(() => this.deps.lookupBranch(tab)).then((branch) => {
        if (!this.current(tab)) return;
        tab.branch = branch;
        this.notify();
      }).catch(() => {});
      if (start) this.start(tab);
    }
    if (activate) this.activate(id);
    else this.notify(true);
    return id;
  }

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const previous = this.tabs.get(this.activeId);
    const now = Date.now();
    if (previous) {
      previous.lastUsed = now;
      if (previous !== tab) {
        this.cancelReveal(previous);
      }
    }
    tab.lastUsed = now;
    this.activeId = id;
    this.deps.activate(tab);
    if (tab.server === 'sleeping' || tab.server === 'stopped') this.start(tab);
    this.notify(true);
  }

  start(tab) {
    if (!this.current(tab)) return Promise.resolve();
    if (tab.server === 'starting' || tab.server === 'running') return this.starts.get(tab.id) || Promise.resolve();
    if (!this.deps.canStart(tab)) return Promise.resolve();
    const run = { tab, launched: false };
    run.cancelled = new Promise((resolve) => { run.cancel = resolve; });
    this.runs.set(tab.id, run);
    tab.server = 'starting';
    tab.error = null;
    tab.codexObserved = false;
    this.deps.placeholder(tab, 'starting');
    this.notify();
    const previous = this.starts.get(tab.id) || Promise.resolve();
    const pending = this.startRun(run, previous);
    this.starts.set(tab.id, pending);
    pending.then(() => {
      if (this.starts.get(tab.id) === pending) this.starts.delete(tab.id);
    });
    return pending;
  }

  async startRun(run, previous) {
    const { tab } = run;
    try {
      // Managers stop by tab ID. Do not let an old start's cleanup stop its replacement.
      await previous;
      if (!this.currentRun(run)) return;
      // Until it passes the gates (start-up, Codex from Open VSX), a start has launched nothing and
      // uses no extensions, so an update need not wait for it (idleWaitReason). Codex's install is
      // an update, and a Codex tab waits for it here.
      tab.preparing = true;
      run.gated = true;
      try {
        await Promise.race([this.deps.prepare?.(tab), run.cancelled]);
      } finally {
        tab.preparing = false;
      }
      run.gated = false;
      if (!this.currentRun(run)) return;
      // A gate can open while an update switches the extensions; the update starts the tab again
      // once it is done (canStart remembers it). Stopped, so that start() takes it then, or when
      // the tab is selected.
      if (!this.deps.canStart(tab)) {
        this.runs.delete(tab.id);
        run.cancel();
        tab.server = 'stopped';
        this.notify();
        return;
      }
      if (!this.currentRun(run)) return;
      await Promise.race([tab.repoLookup, run.cancelled]);
      if (!this.currentRun(run)) return;
      const manager = run.manager = this.deps.managerFor(tab);
      run.launched = true;
      const result = await manager.start(tab.id, tab.folder, this.ports.port(tab.id), {
        ...this.deps.startOptions(tab),
        avoid: this.ports.reserved(tab.id),
        owner: run,
        onProgress: (detail) => {
          if (this.currentRun(run)) this.deps.placeholder(tab, 'starting', detail);
        },
      });
      if (!this.currentRun(run)) return;
      run.ready = true;
      if (run.exit) throw new Error(this.deps.exitError(run.exit.code));
      this.deps.clearStorage(this.ports.use(tab.id, tab.folder, result.port));
      await this.deps.connect(tab, result);
      if (!this.currentRun(run)) return;
      tab.server = 'running';
      this.deps.save();
      this.deps.navigate(tab, manager.folderUrl(result.port, tab.folder));
      this.notify();
    } catch (error) {
      if (!this.currentRun(run)) return;
      this.runs.delete(tab.id);
      run.cancel();
      this.cleanup(tab, true);
      // A gate that may pass next time (`retryable`: Codex could not come from Open VSX) leaves the
      // tab stopped, which selecting it starts again; other failures are errors.
      tab.server = run.gated && error.retryable ? 'stopped' : 'error';
      tab.error = error.message;
      this.deps.placeholder(tab, 'error', error.message);
      this.notify();
    } finally {
      // A stop during preparation cannot kill a process that has not been spawned yet.
      if (!this.currentRun(run) && run.launched) run.manager.stop(tab.id);
    }
  }

  exited(id, code, owner) {
    const run = this.runs.get(id);
    if (!run || owner !== run || !this.currentRun(run)) return;
    // Local managers also emit while starting. Let their start reject as a startup error;
    // remember the exit in case a health response arrives just after the process ended.
    if (!run.ready) { run.exit = { code }; return; }
    this.runs.delete(id);
    run.cancel();
    this.cleanup(run.tab, true);
    run.tab.server = 'stopped';
    run.tab.error = this.deps.exitError(code);
    this.notify();
  }

  stopRuntime(tab, keepCodex) {
    const run = this.runs.get(tab.id);
    if (run?.tab === tab) {
      this.runs.delete(tab.id);
      run.cancel();
      if (run.launched) run.manager.stop(tab.id);
    }
    this.cleanup(tab, keepCodex);
  }

  cancelReveal(tab) {
    if (this.deps.cancelReveal) return this.deps.cancelReveal(tab);
    clearTimeout(tab.revealTimer);
    tab.pendingReveal = null;
  }

  cleanup(tab, keepCodex) {
    this.cancelReveal(tab);
    this.deps.cleanup(tab, { keepCodex });
  }

  // Updates use the same stop and cleanup as a restart, without asking a second time.
  stop(tab) {
    if (!this.current(tab)) return;
    this.stopRuntime(tab, true);
    tab.server = 'stopped';
    this.notify();
  }

  async approved(tab, action, force) {
    if (!this.current(tab)) return false;
    const run = this.runs.get(tab.id);
    if (!force && !(await this.deps.confirm(tab, action))) return false;
    return this.current(tab) && this.runs.get(tab.id) === run;
  }

  async close(id, { force = false } = {}) {
    const tab = this.tabs.get(id);
    const run = this.runs.get(id);
    if (!(await this.approved(tab, 'close', force))) return;
    await this.deps.remember(tab);
    // Worktree removal has already authorized a forced close, even if that tab restarted.
    if (this.current(tab) && (force || this.runs.get(id) === run)) this.closeNow([tab]);
  }

  closeNow(tabList) {
    const closing = tabList.filter((tab) => this.current(tab));
    if (!closing.length) return;
    const ids = closing.map((tab) => tab.id);
    const next = nextActive(this.order, this.activeId, ids);
    this.order = this.order.filter((id) => !ids.includes(id));
    for (const tab of closing) {
      this.tabs.delete(tab.id);
      this.stopRuntime(tab, false);
      this.deps.unmount(tab);
      this.deps.used(tab);
      this.deps.clearStorage(this.ports.close(tab.id));
    }
    if (next !== this.activeId) {
      this.activeId = null;
      if (next) this.activate(next);
    }
    this.notify(true);
  }

  async closeTogether(ids, name) {
    if (this.closingTogether) return false;
    this.closingTogether = true;
    const selected = openAmong(this.order, ids).map((id) => ({ tab: this.tabs.get(id), run: this.runs.get(id) }));
    const unchanged = ({ tab, run }) => this.current(tab) && this.runs.get(tab.id) === run;
    try {
      if (!(await this.deps.confirmTogether(selected.map(({ tab }) => tab), name))) return false;
      await Promise.all(selected.filter(unchanged).map(({ tab }) => this.deps.remember(tab)));
      if (!this.deps.canClose()) return false;
      this.closeNow(selected.filter(unchanged).map(({ tab }) => tab));
      return true;
    } finally {
      this.closingTogether = false;
    }
  }

  async suspend(tab, { force = false } = {}) {
    if (!tab || tab.server !== 'running') return;
    const run = this.runs.get(tab.id);
    if (!(await this.approved(tab, 'suspend', force))) return;
    await this.deps.remember(tab);
    if (!this.current(tab) || this.runs.get(tab.id) !== run || tab.server !== 'running') return;
    this.stopRuntime(tab, true);
    tab.server = 'sleeping';
    this.deps.placeholder(tab, 'suspended');
    this.notify();
  }

  async restart(tab) {
    if (await this.approved(tab, 'restart', false)) return this.restartNow(tab);
  }

  restartNow(tab) {
    if (!this.current(tab)) return Promise.resolve();
    this.stop(tab);
    return this.start(tab);
  }

  async reload(tab) {
    if (!(await this.approved(tab, 'reload', false))) return;
    tab.error = null;
    this.deps.reload(tab);
    this.notify();
  }

  snapshot() {
    return {
      tabs: this.order.map((id) => ({ folder: this.tabs.get(id).folder, port: this.ports.port(id),
        ...this.deps.metadata(this.tabs.get(id)) })),
      active: this.tabs.get(this.activeId)?.folder || null,
      ports: this.ports.closed(),
    };
  }

  restore(saved, present) {
    this.deps.clearStorage(this.ports.load(saved, present));
    for (const entry of saved.tabs || []) {
      const folder = typeof entry === 'string' ? entry : entry.folder;
      if (!present(folder)) continue;
      const id = this.open(folder, { activate: false, start: false, provider: entry.provider });
      this.deps.restoreMetadata(this.tabs.get(id), entry);
    }
    const active = saved.active && this.tabs.get(this.deps.idOf(saved.active));
    const id = active?.id || this.order[0];
    if (id) this.activate(id);
    // Metadata is restored after open(), so save even when there is no active tab.
    this.deps.save();
  }
}

module.exports = { TabLifecycle };
