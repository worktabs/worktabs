// Times as the side bar shows them, apart from the page so they can be tested: when the usage
// windows reset and how far into them we are (usage.js and codex-usage.js, in the main process),
// and how long each conversation has been in its state (sidebar.js). The page loads this as a plain script; the main process and the
// tests require it.

// In the main process and the tests, the UI language's `t`; a page has its own (src/i18n/page.js).
if (typeof module === 'object') var { t } = require('../i18n');

function weekdayName(day) {
  return [t('Sun'), t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat')][day];
}

// A local time, short, for the middle of a phrase: "15:00" today, "tomorrow 9:00" or "yesterday
// 9:00" next to it, "10/3 9:00" otherwise ("10/3 (Fri) 9:00" with the weekday).
function timeText(date, now, { weekday = false } = {}) {
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
  // Rounded: a day with a daylight saving change is not 24 hours long.
  const days = Math.round((startOfDay(date) - startOfDay(new Date(now))) / 86400000);
  if (days === 0) return time;
  if (days === 1) return t('tomorrow {time}', { time });
  if (days === -1) return t('yesterday {time}', { time });
  const day = `${date.getMonth() + 1}/${date.getDate()}`;
  return weekday ? t('{date} ({weekday}) {time}', { date: day, weekday: weekdayName(date.getDay()), time }) : `${day} ${time}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// The states whose time a conversation row tells: how long it has worked or waited, or how long
// ago its turn ended. Not idle: such a conversation was opened again (after a restart, say) or
// interrupted, and when the app saw that says little.
const ONGOING = ['working', 'waiting'];
const ENDED = ['done', 'error'];

// How long a conversation has been in its state (`since`, in ms), short enough for its row:
// "12 min", "3 h", "2 d" while it works or waits, "5 min ago" once its turn has ended. Empty in
// its first minute.
function elapsedText(state, since, now) {
  const ended = ENDED.includes(state);
  if (!ended && !ONGOING.includes(state)) return '';
  const minutes = Math.floor((now - since) / 60000);
  // Also without a time (NaN).
  if (!(minutes >= 1)) return '';
  const hours = Math.floor(minutes / 60);
  const amount =
    hours < 1 ? t('{count} min', { count: minutes }) : hours < 24 ? t('{count} h', { count: hours }) : t('{count} d', { count: Math.floor(hours / 24) });
  return ended ? t('{amount} ago', { amount }) : amount;
}

// Since when a conversation has been in its state, for its row's title: "since 14:03", "since
// yesterday 9:00". Empty for the states elapsedText leaves out.
function sinceText(state, since, now) {
  if (![...ONGOING, ...ENDED].includes(state) || !Number.isFinite(since)) return '';
  return t('since {time}', { time: timeText(new Date(since), now) });
}

// How much of a usage window has passed at `now`, in percent to a tenth: where its usage would be
// if it went up evenly and reached 100% at the reset. A window starts its length (`minutes`)
// before its reset (`resetsAt`, unix seconds). null when the length is unknown, or when `now` is
// not inside the window: it has reset, or the reset is further away than the window is long.
function windowPace(resetsAt, minutes, now) {
  const length = minutes * 60000;
  const left = resetsAt * 1000 - now;
  if (!(length > 0) || !(left > 0) || left > length) return null;
  return Math.round((1 - left / length) * 1000) / 10;
}

if (typeof module === 'object') module.exports = { elapsedText, sinceText, timeText, windowPace };
