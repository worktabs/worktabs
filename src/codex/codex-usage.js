const { quotaWindow } = require('./codex-quota');
const { t } = require('../i18n');
const { timeText, windowPace } = require('../sidebar/time');

const STALE_AFTER = 15 * 60 * 1000;
const SUBSCRIPTION = new Set(['chatgpt', 'chatgptAuthTokens']);

function durationLabel(minutes, key) {
  if (!minutes) return key === 'primary' ? t('Primary') : t('Secondary');
  if (minutes === 300) return t('5 hours');
  if (minutes === 10080) return t('Week');
  if (minutes % 1440 === 0) return t('{count} d', { count: minutes / 1440 });
  if (minutes % 60 === 0) return t('{count} h', { count: minutes / 60 });
  return t('{count} min', { count: minutes });
}

// Account-wide snapshots replace each other; they are never added across tabs. Keep this
// in memory only: after a restart the extension must report the current account and quota.
class CodexUsageTracker {
  constructor() {
    this.sources = new Map();
    this.buckets = new Map();
    this.mode = 'unknown';
    this.accountKey = null;
    this.snapshotKey = null;
    this.awaitingIdentity = false;
    this.barrier = -Infinity;
    this.latest = null;
    this.refreshStatus = '';
    this.refresh = null;
    this.accountEpoch = 0;
  }

  take(tabId, procId, event, now = Date.now()) {
    return this.accept(tabId, procId, event, now).accepted;
  }

  accept(tabId, procId, event, now = Date.now()) {
    if (!procId || !Number.isFinite(event?.at) || !Number.isFinite(event.receivedAt) ||
      event.at > now + 60000 || event.receivedAt > now + 60000 || event.receivedAt < event.at || !Number.isSafeInteger(event.seq)) return { accepted: false, category: 'invalid-event' };
    const id = `${tabId}:${procId}`;
    const source = this.sources.get(id) || { tabId, mode: 'unknown', accountKey: null, seq: -1, blocked: this.barrier !== -Infinity };
    if (event.seq <= source.seq) return { accepted: false, category: 'out-of-order' };
    if (event.at < this.barrier) return { accepted: false, category: 'account-boundary' };
    source.seq = event.seq;
    this.sources.set(id, source);
    if (event.type === 'codex-account') {
      this.accountEpoch++;
      const key = /^[a-f0-9]{64}$/.test(event.accountKey || '') ? event.accountKey : null;
      source.mode = event.authMode;
      source.accountKey = key;
      // Routine account/updated notifications omit identity. Keep the displayed snapshot
      // while rechecking it, but fence incoming quota until the account is known again.
      if (!key || key !== this.accountKey || event.authMode !== this.mode) {
        const keep = SUBSCRIPTION.has(event.authMode) && event.authMode === this.mode &&
          (key ? this.awaitingIdentity && key === this.snapshotKey : this.buckets.size > 0);
        if (!keep) {
          this.buckets.clear();
          this.snapshotKey = null;
          this.latest = null;
        }
        this.barrier = event.at;
        for (const other of this.sources.values()) other.blocked = true;
      }
      this.awaitingIdentity = !key && SUBSCRIPTION.has(event.authMode) && this.buckets.size > 0;
      source.blocked = false;
      this.mode = event.authMode;
      this.accountKey = key;
      return { accepted: true };
    }
    if (event.type !== 'codex-usage' || !Array.isArray(event.buckets)) return { accepted: false, category: 'invalid-event' };
    if (this.awaitingIdentity) return { accepted: false, category: 'identity-pending' };
    if (source.blocked) return { accepted: false, category: 'account-boundary' };
    if ((this.mode !== 'unknown' && !SUBSCRIPTION.has(this.mode)) || (source.mode !== 'unknown' && !SUBSCRIPTION.has(source.mode))) return { accepted: false, category: 'account-mode' };
    if (source.accountKey !== this.accountKey || event.accountKey !== this.accountKey) return { accepted: false, category: 'identity-mismatch' };
    if (this.latest && (event.at < this.latest.at || (event.at === this.latest.at && id !== this.latest.source))) return { accepted: false, category: 'superseded' };
    this.latest = { at: event.at, receivedAt: event.receivedAt, source: id };
    this.snapshotKey = this.accountKey;
    if (event.complete || !event.buckets.length) this.buckets.clear();
    for (const bucket of event.buckets) {
      if (typeof bucket?.id !== 'string' || !bucket.id) continue;
      this.buckets.set(bucket.id, { id: bucket.id, name: typeof bucket.name === 'string' ? bucket.name : null,
        primary: quotaWindow(bucket.primary), secondary: quotaWindow(bucket.secondary), receivedAt: event.receivedAt });
    }
    this.refreshStatus = '';
    return { accepted: true };
  }

  // A read that overlapped a live account boundary must recheck identity. Comparing an
  // epoch also fences notifications and replies with the same millisecond timestamp.
  applyRefresh(result, procId, epoch, now = Date.now()) {
    if (epoch !== this.accountEpoch) return { outcome: 'rejected', category: 'account-boundary', acceptedAccount: 0, acceptedQuota: 0, rejectedEvents: result.events.length };
    this.clearTab('usage-refresh');
    let acceptedAccount = 0, acceptedQuota = 0, rejectedEvents = 0, category = '';
    for (const event of result.events) {
      const accepted = this.accept('usage-refresh', procId, event, now);
      if (!accepted.accepted) {
        rejectedEvents++;
        category = accepted.category;
      } else if (event.type === 'codex-account') acceptedAccount++;
      else if (event.type === 'codex-usage') acceptedQuota++;
    }
    const counts = { acceptedAccount, acceptedQuota, rejectedEvents };
    if (result.unavailable) return { ...counts, outcome: 'unavailable', category: result.category || 'quota-read' };
    if (acceptedQuota) {
      const known = this.view(now).windows.some((window) => window.percent !== null);
      return { ...counts, outcome: known ? 'success' : 'unavailable', category: known ? category : 'empty-quota' };
    }
    if (rejectedEvents) return { ...counts, outcome: 'rejected', category };
    return { ...counts, outcome: 'unavailable', category: acceptedAccount && !SUBSCRIPTION.has(this.mode) ? 'account-mode' : 'missing-quota' };
  }

  clearTab(tabId) {
    const removed = new Set();
    for (const [id, source] of this.sources) if (source.tabId === tabId) {
      this.sources.delete(id);
      removed.add(id);
    }
    // Closing the reporting tab does not turn its last snapshot into live data from a
    // different account. The usual stale/reset rules still apply to that snapshot.
    if (removed.has(this.latest?.source)) this.latest.source = null;
  }

  view(now = Date.now()) {
    const received = this.latest ? t('Received {time}', { time: timeText(new Date(this.latest.receivedAt), now) }) : '';
    const refreshStatus = this.refresh?.active ? t('Refreshing usage') : this.refreshStatus;
    const refreshTitle = [refreshStatus,
      this.refresh ? t('Last refresh attempt {time}', { time: timeText(new Date(this.refresh.attemptAt), now) }) : '',
      this.refresh && !this.refresh.active && this.refresh.nextAt ? t('Next refresh {time}', { time: timeText(new Date(this.refresh.nextAt), now) }) : '',
    ].filter(Boolean).join('\n');
    const windows = [];
    for (const bucket of this.buckets.values()) {
      for (const key of ['primary', 'secondary']) {
        const window = bucket[key];
        // An absent optional window is not an unknown quota that needs an empty row.
        if (!window || Object.values(window).every((value) => value === null)) continue;
        const stale = now - bucket.receivedAt >= STALE_AFTER;
        const expired = window?.resetsAt && window.resetsAt * 1000 <= now;
        const known = window?.usedPercent !== null && window?.usedPercent !== undefined && window?.resetsAt && !stale && !expired;
        const percent = known ? Math.round(window.usedPercent) : null;
        // A window without a reported length gets no pace: its start is unknown.
        const pace = known ? windowPace(window.resetsAt, window.windowDurationMins, now) : null;
        const resetTime = window.resetsAt && !expired ? timeText(new Date(window.resetsAt * 1000), now) : '';
        const resets = resetTime ? t('Resets {time}', { time: resetTime }) : '';
        const detail = stale ? t('Stale usage') : expired ? t('Waiting for refresh') : !known ? t('Usage unavailable') : '';
        const label = durationLabel(window?.windowDurationMins, key);
        const name = bucket.name || bucket.id;
        const title = [t('Codex usage'), name, known ? t('{name}: {percent}% used', { name: label, percent }) : detail,
          pace !== null ? t('Even pace: {percent}% by now', { percent: Math.round(pace) }) : '',
          window?.resetsAt ? t('Resets {time}', { time: timeText(new Date(window.resetsAt * 1000), now, { weekday: true }) }) : '',
          t('Received {time}', { time: timeText(new Date(bucket.receivedAt), now) }), refreshTitle].filter(Boolean).join('\n');
        windows.push({ key: `${bucket.id}:${key}`, bucket: name, label, percent, pace,
          level: !known ? 'unknown' : window.usedPercent >= 100 ? 'over' : window.usedPercent >= 80 ? 'warn' : 'ok', resets, resetTime, detail, title });
      }
    }
    const status = windows.length ? '' : this.mode === null ? t('Signed out') : this.mode === 'changing' ? t('Waiting for account') : this.mode === 'apikey' ? t('Usage unavailable with API key')
      : this.latest || (this.mode !== 'unknown' && !SUBSCRIPTION.has(this.mode)) ? t('Usage unavailable') : t('Waiting for usage');
    return { windows, status: (this.mode === 'unknown' || SUBSCRIPTION.has(this.mode)) && refreshStatus ? refreshStatus : status, received,
      title: [received, refreshTitle].filter(Boolean).join('\n') };
  }
}

module.exports = { CodexUsageTracker, STALE_AFTER, durationLabel };
