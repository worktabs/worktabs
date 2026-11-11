// The Claude subscription's usage windows (5-hour and weekly), from the rate_limit_event lines
// that claude writes to its stream-json output and claude-wrap.exe passes on (/usage), and from
// the background reads (usage-refresh.js), which also bring the monthly spend limit.
const fs = require('fs');
const { t, language } = require('../i18n');
const { timeText } = require('../sidebar/time');

// The windows the side bar shows, in its order, with their short label and their name.
// seven_day_overage_included, a weekly bucket that only some accounts have, is left out.
const WINDOWS = [
  { key: 'five_hour', words: () => ({ label: t('5 hours'), name: t('5-hour limit') }) },
  { key: 'seven_day', words: () => ({ label: t('Week'), name: t('Weekly limit') }) },
];
// From this share of a window on, it shows as a warning.
const WARN_AT = 0.8;
const STALE_AFTER = 15 * 60 * 1000;
// What a read that worked says when the account has neither a window nor a spend limit (Claude
// Enterprise without one, say). Unlike a failed read, this is known, so it stays during the next read.
const NO_LIMIT = 'No 5-hour or weekly limit';

// utilization is the share used (0-1, above 1 past the cap); resetsAt is in unix seconds.
const isWindow = (window) => Number.isFinite(window?.utilization) && Number.isInteger(window?.resetsAt);

/**
 * A spend limit: used and limit in minor units, with `places` decimal places (USD 100.00 is 10000
 * and 2), the ISO currency code or null, and whether the account says the limit is reached.
 * @typedef {{ used: number, limit: number, places: number, currency: string | null, reached: boolean }} Spend
 */
/**
 * @param {any} spend
 * @returns {spend is Spend}
 */
function isSpend(spend) {
  return Number.isSafeInteger(spend?.used) && spend.used >= 0 && Number.isSafeInteger(spend.limit) && spend.limit > 0 &&
    Number.isInteger(spend.places) && spend.places >= 0 && spend.places <= 6 &&
    (spend.currency === null || (typeof spend.currency === 'string' && /^[A-Z]{3}$/.test(spend.currency))) && typeof spend.reached === 'boolean';
}

// The windows a rate_limit_event carries: key -> { utilization, resetsAt }. The event names them
// in rate_limit_info.unifiedWindows, which claude marks as internal: anything else gives {}.
function windowsOf(event) {
  const windows = event?.type === 'rate_limit_event' ? event.rate_limit_info?.unifiedWindows : null;
  const result = {};
  for (const { key } of WINDOWS) {
    const window = windows?.[key];
    if (isWindow(window)) result[key] = { utilization: window.utilization, resetsAt: window.resetsAt };
  }
  return result;
}

// The latest value of each window, kept in a file so it shows again after a restart. claude
// only reports the windows when a rounded share or a reset time moves, so a window an event
// lacks keeps its value (as the Claude Code extension does), until it resets.
class UsageTracker {
  constructor(file) {
    this.file = file;
    // key -> { utilization, resetsAt, at }; at is when it came (ms).
    this.windows = {};
    // The monthly spend limit from the last background read: { used, limit, places, currency,
    // reached, at }, or null. It has no reset time, so only becoming stale hides its share.
    this.spend = null;
    this.latest = -Infinity;
    this.status = 'Waiting for usage';
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      // Nothing yet.
    }
    for (const { key } of WINDOWS) {
      const window = saved.windows?.[key];
      if (isWindow(window) && Number.isFinite(window.at)) {
        this.windows[key] = { utilization: window.utilization, resetsAt: window.resetsAt, at: window.at };
      }
    }
    if (isSpend(saved.spend) && Number.isFinite(saved.spend.at)) this.spend = spendOf(saved.spend, saved.spend.at);
  }

  // Takes a rate_limit_event. Returns true when it had a window.
  take(event, now = Date.now()) {
    const windows = windowsOf(event);
    if (!Object.keys(windows).length) return false;
    this.latest = now;
    this.status = '';
    for (const [key, window] of Object.entries(windows)) this.windows[key] = { ...window, at: now };
    this.save();
    return true;
  }

  // Forgets the windows that have reset: their new share comes with a later response. Returns
  // true when one was forgotten.
  expire(now = Date.now()) {
    const reset = Object.keys(this.windows).filter((key) => this.windows[key].resetsAt * 1000 <= now);
    for (const key of reset) delete this.windows[key];
    if (reset.length) this.save();
    return reset.length > 0;
  }

  view(now = Date.now()) {
    return [...usageView(this.windows, now), ...spendView(this.spend, now)];
  }

  // A background read is starting. Without a value to show, the section waits for it, unless the
  // last read found that the account has no limit: that stays, rather than blinking every 5 minutes.
  refreshing() {
    if (this.status !== NO_LIMIT) this.status = 'Waiting for refresh';
  }

  /**
   * A full quota read replaces missing windows, but cannot overwrite a newer live event. A live
   * event never carries the spend limit, so the read's spend limit is taken either way.
   * @param {{ windows?: object, spend?: Spend | null }} snapshot What readUsage resolved with.
   * @param {number} at When the read started (ms).
   * @param {number} [now]
   */
  refresh({ windows = {}, spend = null }, at, now = Date.now()) {
    this.spend = isSpend(spend) ? spendOf(spend, now) : null;
    if (at >= this.latest) {
      this.latest = at;
      this.windows = {};
      for (const { key } of WINDOWS) if (isWindow(windows[key])) this.windows[key] = { ...windows[key], at: now };
      this.status = Object.keys(this.windows).length || this.spend ? '' : NO_LIMIT;
    }
    this.save();
  }

  providerView(now = Date.now()) {
    const windows = this.view(now).map((window) => now - this.receivedAt(window.key) < STALE_AFTER ? window : {
      ...window, percent: null, level: 'unknown', detail: t('Stale usage'),
      title: [t('Stale usage'), window.resets, window.received].filter(Boolean).join('\n'),
    });
    // NO_LIMIT is spelled out for the translation check, which reads t()'s string literals.
    const status = this.status === NO_LIMIT ? t('No 5-hour or weekly limit') : t(this.status || 'Waiting for refresh');
    return { windows, status: windows.length ? '' : status };
  }

  receivedAt(key) {
    return key === 'spend' ? this.spend.at : this.windows[key].at;
  }

  save() {
    try {
      fs.writeFileSync(this.file, `${JSON.stringify({ windows: this.windows, spend: this.spend }, null, 2)}\n`);
    } catch {
      // Shown until the app closes anyway.
    }
  }
}

function spendOf({ used, limit, places, currency, reached }, at) {
  return { used, limit, places, currency, reached, at };
}

// What the side bar shows for each window that has not reset: { key, label, percent, level,
// resets, title }. level is 'ok', 'warn' (from WARN_AT) or 'over' (the cap reached).
function usageView(windows, now = Date.now()) {
  return WINDOWS.filter(({ key }) => windows[key] && windows[key].resetsAt * 1000 > now).map(({ key, words }) => {
    const { label, name } = words();
    const { utilization, resetsAt, at } = windows[key];
    const percent = Math.round(utilization * 100);
    const resets = new Date(resetsAt * 1000);
    const title = [t('{name}: {percent}% used', { name, percent }), t('Resets {time}', { time: timeText(resets, now, { weekday: true }) })];
    if (Number.isFinite(at)) title.push(t('Received {time}', { time: timeText(new Date(at), now) }));
    return {
      key,
      label,
      percent,
      level: utilization >= 1 ? 'over' : utilization >= WARN_AT ? 'warn' : 'ok',
      resets: t('Resets {time}', { time: timeText(resets, now) }),
      resetTime: timeText(resets, now),
      received: Number.isFinite(at) ? t('Received {time}', { time: timeText(new Date(at), now) }) : '',
      title: title.join('\n'),
    };
  });
}

// An amount in minor units as money in the UI language: "$0.09". `short` leaves out the decimals
// of a whole amount ("$100"), for the row; the tooltip keeps them ("$100.00").
function moneyText(minor, places, currency, short = false) {
  const amount = minor / 10 ** places;
  const digits = { minimumFractionDigits: short && minor % 10 ** places === 0 ? 0 : places, maximumFractionDigits: places };
  try {
    return new Intl.NumberFormat(language(), currency ? { style: 'currency', currency, ...digits } : digits).format(amount);
  } catch {
    return amount.toFixed(places);
  }
}

// The monthly spend limit as a row like the windows'. It has no reset time, so the amounts go
// where a window's reset time goes. Red at the limit, or when the account says it is reached.
function spendView(spend, now = Date.now()) {
  if (!spend) return [];
  const { used, limit, places, currency, reached, at } = spend;
  const share = used / limit;
  const received = Number.isFinite(at) ? t('Received {time}', { time: timeText(new Date(at), now) }) : '';
  const amounts = { used: moneyText(used, places, currency), limit: moneyText(limit, places, currency) };
  return [{
    key: 'spend',
    label: t('Month'),
    // Multiplied first: 10350 / 10000 * 100 is 103.49999999999999.
    percent: Math.round(used * 100 / limit),
    level: reached || share >= 1 ? 'over' : share >= WARN_AT ? 'warn' : 'ok',
    resets: '',
    resetTime: '',
    detail: `${moneyText(used, places, currency, true)} / ${moneyText(limit, places, currency, true)}`,
    received,
    title: [t('Monthly spend: {used} of {limit} used', amounts), received].filter(Boolean).join('\n'),
  }];
}

module.exports = { UsageTracker, isSpend, spendView, usageView, windowsOf };
