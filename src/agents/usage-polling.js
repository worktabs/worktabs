// Keep scheduling and replay independent of Electron so races can be checked with real trackers.
const { randomUUID } = require('crypto');
const { REFRESH_EVERY, readUsage } = require('./usage-refresh');
const { t } = require('../i18n');

const FAILURE_CATEGORIES = new Set(['timeout', 'cancelled', 'resolution', 'process', 'initialization', 'account-read', 'quota-read']);
const CATEGORIES = new Set([...FAILURE_CATEGORIES, '', 'read-failed', 'account-changing', 'read-in-progress', 'empty-quota', 'missing-quota', 'spend-only', 'no-windows',
  'identity-unavailable', 'invalid-event', 'out-of-order', 'account-boundary', 'identity-pending', 'account-mode', 'identity-mismatch', 'superseded']);

/**
 * @typedef {object} UsagePollingOptions
 * @property {InstanceType<typeof import('./usage').UsageTracker>} usage
 * @property {InstanceType<typeof import('../codex/codex-usage').CodexUsageTracker>} codexUsage
 * @property {() => string[]} enabled
 * @property {() => object} options Extra options for each read (extensionsDir, cwd).
 * @property {() => void} changed
 * @property {(record: object) => void} [log]
 * @property {typeof readUsage} [read]
 * @property {() => number} [now]
 */

class UsagePolling {
  /** @param {UsagePollingOptions} options */
  constructor({ usage, codexUsage, enabled, options, changed, log = () => {}, read = readUsage, now = Date.now }) {
    this.usage = usage;
    this.codexUsage = codexUsage;
    this.enabled = enabled;
    this.options = options;
    this.changed = changed;
    this.log = log;
    this.read = read;
    this.now = now;
    this.reads = new Map();
    this.pending = new Set();
    this.stopped = false;
    this.nextAt = now() + REFRESH_EVERY;
  }

  record(provider, attemptAt, result) {
    const completedAt = this.now();
    // Only fixed categories, counters and times belong here, never an error message,
    // account identity, quota payload, CLI output or path.
    try {
      this.log({ provider, attemptAt, completedAt, durationMs: completedAt - attemptAt,
        outcome: result.outcome, category: CATEGORIES.has(result.category) ? result.category : 'read-failed',
        acceptedAccount: result.acceptedAccount ?? 0, acceptedQuota: result.acceptedQuota ?? 0, rejectedEvents: result.rejectedEvents ?? 0,
        nextAt: this.nextAt, lastReceivedAt: provider === 'codex' ? this.codexUsage.latest?.receivedAt ?? null : null });
    } catch { /* A diagnostic write must not stop the next refresh. */ }
  }

  refreshAll() {
    this.nextAt = this.now() + REFRESH_EVERY;
    if (this.codexUsage.refresh) this.codexUsage.refresh.nextAt = this.nextAt;
    for (const agent of this.enabled()) this.refresh(agent);
  }

  async refresh(agent) {
    if (this.stopped || !this.enabled().includes(agent)) return;
    if (agent === 'codex' && this.codexUsage.mode === 'changing') {
      this.record(agent, this.now(), { outcome: 'skipped', category: 'account-changing' });
      return;
    }
    if (this.reads.has(agent)) {
      this.pending.add(agent);
      this.record(agent, this.now(), { outcome: 'queued', category: 'read-in-progress' });
      return;
    }
    const controller = new AbortController();
    this.reads.set(agent, controller);
    const at = this.now();
    const epoch = this.codexUsage.accountEpoch;
    if (agent === 'claude') this.usage.refreshing();
    else {
      this.codexUsage.refresh = { active: true, attemptAt: at, nextAt: this.nextAt };
      this.codexUsage.refreshStatus = '';
    }
    this.record(agent, at, { outcome: 'started', category: '' });
    this.changed();
    let result;
    try {
      const snapshot = await this.read(agent, { ...this.options(), signal: controller.signal });
      if (this.stopped || !this.enabled().includes(agent)) {
        result = { outcome: 'cancelled', category: 'cancelled' };
      } else if (agent === 'claude') {
        const superseded = at < this.usage.latest;
        this.usage.refresh(snapshot, at, this.now());
        // A read that worked but found no window is not a failure: Claude Enterprise accounts
        // may have only a monthly spend limit (spend-only), or no limit at all (no-windows).
        result = superseded ? { outcome: 'rejected', category: 'superseded' } : { outcome: 'success',
          category: Object.keys(snapshot.windows || {}).length ? '' : this.usage.spend ? 'spend-only' : 'no-windows' };
      } else {
        result = this.codexUsage.applyRefresh(snapshot, randomUUID(), epoch, this.now());
      }
    } catch (error) {
      result = { outcome: 'failed', category: FAILURE_CATEGORIES.has(error?.category) ? error.category : 'read-failed' };
      if (this.stopped) result.outcome = 'cancelled';
      if (agent === 'claude' && at >= this.usage.latest) this.usage.status = 'Usage unavailable';
    } finally {
      if (agent === 'codex') {
        this.codexUsage.refresh = { active: false, attemptAt: at, completedAt: this.now(), nextAt: this.nextAt, ...result };
        this.codexUsage.refreshStatus = result.outcome === 'success' ? '' : result.category === 'timeout' ? t('Usage refresh timed out')
          : result.outcome === 'rejected' ? t('Usage refresh rejected') : t('Usage unavailable');
      }
      this.record(agent, at, result);
      this.reads.delete(agent);
      if (!this.stopped) this.changed();
      if (this.pending.delete(agent)) this.refresh(agent);
    }
  }

  stop() {
    this.stopped = true;
    this.pending.clear();
    for (const controller of this.reads.values()) controller.abort();
  }
}

module.exports = { UsagePolling };
