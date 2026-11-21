const assert = require('node:assert/strict');
const test = require('node:test');
const { placeholderUrl, tabPlaceholder } = require('../src/window/placeholder');

const page = (url) => decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));

test('placeholderUrl escapes the title and detail and takes the theme colors', () => {
  const html = page(placeholderUrl('<repo>', 'a & "b"', { scheme: 'dark', vars: { '--bg': '#111', '--text': '#eee', '--text-muted': '#999' } }, 'ja'));
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /<h1>&lt;repo&gt;<\/h1><p>a &amp; &quot;b&quot;<\/p>/);
  assert.match(html, /color-scheme: dark; --bg: #111; --fg: #eee; --muted: #999;/);
});

test('placeholderUrl without a theme follows the system', () => {
  const html = page(placeholderUrl('Worktabs'));
  assert.match(html, /color-scheme: light dark/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /<p><\/p>/);
});

test('placeholderUrl draws a bar filled to the part done, only when it is known', () => {
  const bar = (html) => /<div class="bar" role="progressbar" aria-label="In progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="(\d+)"><div style="width: (\d+)%"><\/div><\/div>/.exec(html);
  const html = page(placeholderUrl('Worktabs', 'Downloading code-server 4.146.0… 70 / 236 MB', null, 'en', 70 / 236));
  assert.match(html, /<p>Downloading code-server 4\.146\.0… 70 \/ 236 MB<\/p><div class="bar"/);
  assert.deepEqual(bar(html).slice(1), ['30', '30']);
  assert.deepEqual(bar(page(placeholderUrl('Worktabs', '', null, 'en', 1.5))).slice(1), ['100', '100']);
  assert.deepEqual(bar(page(placeholderUrl('Worktabs', '', null, 'en', 0))).slice(1), ['0', '0']);
  for (const progress of [null, undefined, Number.NaN]) {
    assert.doesNotMatch(page(placeholderUrl('Worktabs', 'Starting code-server…', null, 'en', progress)), /class="bar"/);
  }
  // The bar takes the theme's accent, or VS Code's default one.
  const themed = page(placeholderUrl('app', '', { scheme: 'dark', vars: { '--bg': '#111', '--text': '#eee', '--text-muted': '#999', '--accent': '#f0a' } }, 'en', 0.5));
  assert.match(themed, /--accent: #f0a;/);
  assert.match(page(placeholderUrl('app', '', { scheme: 'light', vars: { '--bg': '#fff', '--text': '#333', '--text-muted': '#666' } })), /--accent: #0066b8;/);
  assert.match(page(placeholderUrl('app')), /--accent: #3794ff;/);
});

test('tabPlaceholder says what the tab is waiting for', () => {
  assert.deepEqual(tabPlaceholder('app', 'initial', 'ignored', false), { title: 'app', detail: 'Suspended. Select the tab to start it.', progress: null });
  assert.equal(tabPlaceholder('app', 'starting', '', true).detail, 'Preparing code-server and extensions…');
  assert.equal(tabPlaceholder('app', 'starting', '', false).detail, 'Starting code-server…');
  assert.equal(tabPlaceholder('app', 'starting', 'Installing', true).detail, 'Installing');
  assert.match(tabPlaceholder('app', 'suspended', '', false).detail, /^Suspended. Click the tab/);
  assert.deepEqual(tabPlaceholder('app', 'error', 'boom', false), { title: 'Could not start app', detail: 'boom', progress: null });
  // Only a starting tab shows how far its download or extracting has gone.
  assert.equal(tabPlaceholder('app', 'starting', 'Downloading code-server 4.146.0 for WSL… 21 / 210 MB', false, 0.1).progress, 0.1);
  assert.equal(tabPlaceholder('app', 'error', 'boom', false, 0.1).progress, null);
});
