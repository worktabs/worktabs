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

  async waitForIdle(run) {
    while (this.run === run) {
      const { busy, unobserved } = await this.deps.risks();
      if (this.run !== run) return false;
      if (!busy.length) return true;
      const detail = this.deps.waitDetail(unobserved);
      if (this.state.status !== 'waiting' || this.state.busy.join('\n') !== busy.join('\n') || this.state.detail !== detail) {
        run.report({ status: 'waiting', busy, detail });
      }
      await this.deps.sleep(3000);
    }
    return false;
  }

  cancel() {
    if (this.state.status !== 'waiting') return;
    this.run = null;
    this.report(this.state.items.some((item) => item.kind === 'import' && !item.candidate)
      ? { status: 'none' } : { status: 'available', items: this.state.items });
  }

  pause(run) {
    const tabs = [...this.deps.tabs().values()];
    // A start still at its gates has launched nothing; it checks canStart once through them.
    if (tabs.some((tab) => tab.server === 'starting' && !tab.preparing)) throw new Error(this.deps.startingError());
    this.switchOwner = run;
    for (const tab of tabs) {
      if (tab.server !== 'running') continue;
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
      try { await this.deps.start(tab); }
      catch (error) { failures.push(error.message); }
    }
    if (failures.length) throw new Error(failures.join('\n'));
  }

  async execute(run, strategy) {
    let result;
    let phase = 'prepare';
    try {
      const prepared = strategy.prepare ? await strategy.prepare(run.report) : undefined;
      // `shared: false`: the batch changes nothing that running tabs use (snapshots prepared for
      // WSL, which install when its tabs next start), so it neither waits for them nor stops them.
      const shared = strategy.shared !== false;
      if (shared && !(await this.waitForIdle(run))) return false;
      run.report({ status: 'applying', detail: strategy.applying });
      if (shared) this.pause(run);
      phase = 'apply';
      result = await strategy.apply(prepared, run.report);
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
      if (this.run === run) {
        if (result) run.report(result);
        this.run = null;
      }
    }
    return result?.status === 'done';
  }
}

module.exports = { UpdateCoordinator };
