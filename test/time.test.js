const assert = require('node:assert/strict');
const test = require('node:test');
const { setLanguage } = require('../src/i18n');
const { elapsedText, sinceText, timeText, windowPace } = require('../src/sidebar/time');

// Local times, so the tests hold in any time zone.
const NOW = new Date(2026, 8, 29, 13, 20).getTime();
const MINUTE = 60 * 1000;
const ago = (minutes) => NOW - minutes * MINUTE;

test('timeText gives a short local time, with the day when it is not today', () => {
  assert.equal(timeText(new Date(2026, 8, 29, 15, 0), NOW), '15:00');
  assert.equal(timeText(new Date(2026, 8, 29, 9, 5), NOW), '9:05');
  assert.equal(timeText(new Date(2026, 8, 30, 1, 0), NOW), 'tomorrow 1:00');
  assert.equal(timeText(new Date(2026, 8, 28, 23, 30), NOW), 'yesterday 23:30');
  assert.equal(timeText(new Date(2026, 9, 3, 9, 0), NOW), '10/3 9:00');
  assert.equal(timeText(new Date(2026, 9, 3, 9, 0), NOW, { weekday: true }), '10/3 (Sat) 9:00');
});

test('elapsedText says how long a conversation has worked or waited, in whole minutes, hours or days', () => {
  assert.equal(elapsedText('working', ago(1), NOW), '1 min');
  assert.equal(elapsedText('working', ago(12.9), NOW), '12 min');
  assert.equal(elapsedText('waiting', ago(59.9), NOW), '59 min');
  assert.equal(elapsedText('working', ago(60), NOW), '1 h');
  assert.equal(elapsedText('waiting', ago(119), NOW), '1 h');
  assert.equal(elapsedText('working', ago(23 * 60 + 59), NOW), '23 h');
  assert.equal(elapsedText('waiting', ago(24 * 60), NOW), '1 d');
  assert.equal(elapsedText('waiting', ago(3 * 24 * 60 + 5), NOW), '3 d');
});

test('elapsedText says how long ago a turn ended', () => {
  assert.equal(elapsedText('done', ago(5), NOW), '5 min ago');
  assert.equal(elapsedText('error', ago(5), NOW), '5 min ago');
  assert.equal(elapsedText('done', ago(3 * 60 + 30), NOW), '3 h ago');
  assert.equal(elapsedText('done', ago(2 * 24 * 60), NOW), '2 d ago');
});

test('elapsedText says nothing in the first minute, for an idle conversation, or without a time', () => {
  assert.equal(elapsedText('working', NOW, NOW), '');
  assert.equal(elapsedText('done', ago(0.99), NOW), '');
  // A clock that has gone back.
  assert.equal(elapsedText('working', NOW + MINUTE, NOW), '');
  assert.equal(elapsedText('idle', ago(30), NOW), '');
  assert.equal(elapsedText('working', undefined, NOW), '');
  assert.equal(elapsedText('working', NaN, NOW), '');
});

test('sinceText gives the clock time a conversation came into its state, but not for an idle one', () => {
  assert.equal(sinceText('working', new Date(2026, 8, 29, 13, 8).getTime(), NOW), 'since 13:08');
  assert.equal(sinceText('done', new Date(2026, 8, 28, 22, 0).getTime(), NOW), 'since yesterday 22:00');
  // In its first minute too, when the row shows no time yet.
  assert.equal(sinceText('waiting', NOW, NOW), 'since 13:20');
  assert.equal(sinceText('idle', ago(30), NOW), '');
  assert.equal(sinceText('working', undefined, NOW), '');
});

test('in Japanese, the times read as they did before the UI was in English', (t) => {
  setLanguage('ja');
  t.after(() => setLanguage('en'));
  assert.equal(timeText(new Date(2026, 8, 30, 1, 0), NOW), '明日 1:00');
  assert.equal(timeText(new Date(2026, 8, 28, 23, 30), NOW), '昨日 23:30');
  assert.equal(timeText(new Date(2026, 9, 3, 9, 0), NOW, { weekday: true }), '10/3（土）9:00');
  assert.equal(elapsedText('working', ago(12.9), NOW), '12 分');
  assert.equal(elapsedText('waiting', ago(119), NOW), '1 時間');
  assert.equal(elapsedText('waiting', ago(24 * 60), NOW), '1 日');
  assert.equal(elapsedText('done', ago(5), NOW), '5 分前');
  assert.equal(sinceText('done', new Date(2026, 8, 28, 22, 0).getTime(), NOW), '昨日 22:00 から');
});

test('windowPace says how much of a window has passed, from its reset and its length', () => {
  const reset = (minutes) => (NOW + minutes * MINUTE) / 1000;
  // A 5-hour window that resets in 2.5 hours is half over.
  assert.equal(windowPace(reset(150), 300, NOW), 50);
  assert.equal(windowPace(reset(100), 300, NOW), 66.7);
  assert.equal(windowPace(reset(300), 300, NOW), 0);
  assert.equal(windowPace(reset(1), 7 * 24 * 60, NOW), 100);
  // Nothing to place: no length, a reset that has passed, or one further away than the window is long.
  assert.equal(windowPace(reset(150), null, NOW), null);
  assert.equal(windowPace(reset(150), 0, NOW), null);
  assert.equal(windowPace(reset(0), 300, NOW), null);
  assert.equal(windowPace(reset(-10), 300, NOW), null);
  assert.equal(windowPace(reset(301), 300, NOW), null);
  assert.equal(windowPace(null, 300, NOW), null);
});
