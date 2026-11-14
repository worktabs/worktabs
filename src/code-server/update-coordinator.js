// Transactions share a tab stop/resume boundary. Installation and rollback remain strategies:
// gallery versions and immutable imported snapshots have different restoration rules.
class UpdateCoordinator {
  constructor(deps) {
    this.deps = deps;
    this.state = { status: 'none' };
    this.run = null;
    this.switchOwner = null;
    this.paused = new Set();
    this.blocked = new Set();
    // Busy tabs left running on the versions a batch of one agent's extensions replaces (#62).
    this.deferred = new Set();
  }

  get busy() {
    return Boolean(this.run);
  }

  report(state) {
    this.state = state;
    this.deps.changed();
  }

  begin(items, detail) {
    if (this.busy) throw new Error(this.deps.busyError());
    const run = { items };
    run.report = (state) => { if (this.run === run) this.report({ items, ...state }); };
    this.run = run;
    run.report({ status: 'preparing', detail });
    return run;
  }

  canStart(tab) {
    if (!this.switchOwner) return true;
    this.blocked.add(tab);
    return false;
  }

  // Resolves { deferrable } once no tab holds up the switch (`scope`: see execute), or null when
  // the run was cancelled. `deferrable`: the busy tabs that need not be waited for.
  async waitForIdle(run, scope) {
    while (this.run === run) {
      const { busy, unobserved, deferrable = [] } = await this.deps.risks(scope);
      if (this.run !== run) return null;
      if (!busy.length) return { deferrable };
      const detail = this.deps.waitDetail(unobserved);
      if (this.state.status !== 'waiting' || this.state.busy.join('\n') !== busy.join('\n') || this.state.detail !== detail) {
        run.report({ status: 'waiting', busy, detail });
      }
      await this.deps.sleep(3000);
    }
    return null;
  }

  cancel() {
    if (this.state.status !== 'waiting') return;
    this.run = null;
    this.report(this.state.items.some((item) => item.kind === 'import' && !item.candidate)
      ? { status: 'none' } : { status: 'available', items: this.state.items });
  }

  // Stops the running tabs for the switch, apart from `deferrable` ones, which go on running.
  pause(run, deferrable = []) {
    const tabs = [...this.deps.tabs().values()];
    // A start still at its gates has launched nothing; it checks canStart once through them.
    if (tabs.some((tab) => tab.server === 'starting' && !tab.preparing)) throw new Error(this.deps.startingError());
    this.switchOwner = run;
    for (const tab of tabs) {
      if (tab.server !== 'running') continue;
      if (deferrable.includes(tab)) {
        this.deferred.add(tab);
        continue;
      }
      this.paused.add(tab);
      this.deps.pause(tab);
    }
  }

  async resume(run) {
    if (this.switchOwner !== run) return;
    this.switchOwner = null;
    const restart = new Set([...this.paused, ...this.blocked]);
    this.paused.clear();
    this.blocked.clear();
    const failures = [];
    for (const tab of restart) {
      if (this.deps.tabs().get(tab.id) !== tab || tab.server === 'running') continue;
      try { await this.startTab(tab); }
      catch (error) { failures.push(error.message); }
    }
    if (failures.length) throw new Error(failures.join('\n'));
  }

  // Starts a tab, and rejects when it did not come up. The lifecycle's start settles either way,
  // and leaves why on the tab. One closed or suspended meanwhile has not failed.
  async startTab(tab) {
    await this.deps.start(tab);
    if (this.deps.tabs().get(tab.id) === tab && tab.server !== 'running' && tab.error) throw new Error(tab.error);
  }

  // The deferred tabs still open and running. One closed, suspended, or stopped no longer runs
  // the old versions, and starts on the new ones.
  liveDeferred() {
    for (const tab of this.deferred) {
      if (this.deps.tabs().get(tab.id) !== tab || tab.server !== 'running') this.deferred.delete(tab);
    }
    return [...this.deferred];
  }

  // Hands each deferred tab to `act` once it is idle, reporting `detail(names)` of those still
  // busy. Resolves the error messages of `act`. One tab per read of the risks: acting on one can
  // take a while (a restart waits for its server), and another may be busy again by then.
  async whenDeferredIdle(run, detail, act) {
    const failures = [];
    while (this.run === run && this.liveDeferred().length) {
      const { busyTabs = [] } = await this.deps.risks();
      const idle = this.liveDeferred().find((tab) => !busyTabs.includes(tab));
      if (idle) {
        this.deferred.delete(idle);
        try { await act(idle); }
        catch (error) { failures.push(error.message); }
        continue;
      }
      run.report({ status: 'applying', detail: detail(this.liveDeferred().map((tab) => tab.name)) });
      await this.deps.sleep(3000);
    }
    return failures;
  }

  async execute(run, strategy) {
    let result;
    // Whether the new versions are in place, whatever the restarts after it give.
    let applied = false;
    let phase = 'prepare';
    try {
      const prepared = strategy.prepare ? await strategy.prepare(run.report) : undefined;
      // `shared: false`: the batch changes nothing that running tabs use (snapshots prepared for
      // WSL, which install when its tabs next start), so it neither waits for them nor stops them.
      const shared = strategy.shared !== false;
      let deferrable = [];
      if (shared) {
        // `agent`: the batch changes only that agent's extensions. A tab where that agent has no
        // turn in progress is not waited for; it goes on with the old versions until it is idle.
        const idle = await this.waitForIdle(run, strategy.agent ? { agent: strategy.agent } : undefined);
        if (!idle) return false;
        deferrable = idle.deferrable;
      }
      run.report({ status: 'applying', detail: strategy.applying });
      if (shared) this.pause(run, deferrable);
      phase = 'apply';
      result = await strategy.apply(prepared, run.report, {
        deferred: [...this.deferred],
        // Going back to the previous versions replaces the folders the deferred tabs run, so they
        // stop first, once idle, and restart with the others.
        settle: async () => {
          await this.whenDeferredIdle(run, this.deps.settleDetail, async (tab) => {
            this.paused.add(tab);
            this.deps.pause(tab);
          });
        },
      });
      applied = result?.status === 'done';
    } catch (error) {
      this.deps.log(error.message);
      result = { status: 'failed', detail: strategy.failure(error, phase) };
    } finally {
      if (this.switchOwner === run) {
        run.report({ status: 'applying', detail: this.deps.resumeDetail() });
        try { await this.resume(run); }
        catch (error) {
          this.deps.log(error.message);
          result = { status: 'failed', detail: [result?.detail, error.message].filter(Boolean).join('\n') };
        }
      }
      // Once applied, each deferred tab restarts on the new versions when it is idle, also when
      // another tab failed to resume: the held versions are let go only after. A batch that failed
      // went back to the versions they run.
      if (applied && this.deferred.size) {
        const failures = await this.whenDeferredIdle(run, this.deps.restartDetail, async (tab) => {
          this.deps.pause(tab);
          await this.startTab(tab);
        });
        if (failures.length) {
          for (const failure of failures) this.deps.log(failure);
          result = { status: 'failed', detail: [result.detail, ...failures].filter(Boolean).join('\n') };
        }
      }
      this.deferred.clear();
      try { strategy.release?.(); }
      catch (error) { this.deps.log(error.message); }
      if (this.run === run) {
        if (result) run.report(result);
        this.run = null;
      }
    }
    return result?.status === 'done';
  }
}

module.exports = { UpdateCoordinator };
