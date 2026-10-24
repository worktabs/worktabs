const assert = require('node:assert/strict');
const test = require('node:test');
const { Document, makeDocument } = require('./support/sidebar-dom');
const { PROGRESS_CYCLE_MS, createUpdateCard } = require('../src/sidebar/update-card');
const { createAppUpdateCard } = require('../src/sidebar/app-update-card');
const { createPageTheme } = require('../src/sidebar/page-theme');
const { attachSidebarResize } = require('../src/sidebar/resize');
const { createGithubBar } = require('../src/sidebar/github-bar');
const { createIcons, ICONS, LOGOS } = require('../src/sidebar/icons');
const { createUnclonedSection } = require('../src/sidebar/uncloned');
const fs = require('node:fs');
const path = require('node:path');

const t = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name]));

function dom() {
  const document = new Document();
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className || '';
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (name) => el('span', `icon ${name}`);
  return { document, el, icon };
}

function fakeWindow(extra = {}) {
  const listeners = new Map();
  return {
    innerWidth: 260,
    innerHeight: 800,
    listeners,
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)); },
    emit(type, event = {}) { for (const fn of listeners.get(type) || []) fn({ type, ...event }); },
    ...extra,
  };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('the update card hides without an update, and offers what each state allows', () => {
  const { document, el } = dom();
  const element = document.createElement('section');
  const calls = [];
  const host = new Proxy({}, { get: (_target, name) => () => calls.push(name) });
  const card = createUpdateCard({ element, host, dom: { el }, t, listText: (items) => items.join(', '), clock: () => PROGRESS_CYCLE_MS * 3 + 100 });
  card.render(null);
  assert.equal(element.hidden, true);
  card.render({ status: 'none', items: [] });
  assert.equal(element.hidden, true);

  card.render({ status: 'available', items: [{ name: 'code-server', from: '1', to: '2' }] });
  assert.equal(element.hidden, false);
  assert.equal(element.className, 'update available');
  assert.match(element.textContent, /Update available.*code-server.*1 → 2/);
  const labels = element.querySelectorAll('.update-actions button').map((button) => button.textContent);
  assert.deepEqual(labels, ['Update', 'Later', 'Extensions and updates']);
  for (const button of element.querySelectorAll('button')) button.click();
  assert.deepEqual(calls, ['dismissUpdate', 'startUpdate', 'dismissUpdate', 'showExtensions']);

  card.render({ status: 'waiting', items: [], busy: ['a', 'b'], detail: '' });
  assert.match(element.querySelector('.update-detail').textContent, /^Waiting for: a, b$/);
  assert.deepEqual(element.querySelectorAll('button').map((button) => button.textContent), ['Cancel the update']);

  card.render({ status: 'applying', items: [] });
  const bar = element.querySelector('.update-progress');
  assert.equal(bar.style.values['--phase'], '-100ms');
  assert.equal(element.querySelectorAll('button').length, 0);
});

test('the Worktabs update card offers what each state allows', () => {
  const { document, el } = dom();
  const element = document.createElement('section');
  const calls = [];
  const host = new Proxy({}, { get: (_target, name) => () => calls.push(name) });
  const card = createAppUpdateCard({ element, host, dom: { el }, t, listText: (items) => items.join(', '), clock: () => 1500 });
  const labels = () => element.querySelectorAll('.update-actions button').map((button) => button.textContent);
  const base = { version: '0.6.0', from: '0.5.2', notesUrl: 'https://example.test' };
  card.render(null);
  assert.equal(element.hidden, true);
  card.render({ status: 'none' });
  assert.equal(element.hidden, true);

  card.render({ status: 'available', ...base, canApply: true, detail: '' });
  assert.equal(element.hidden, false);
  assert.equal(element.className, 'update available');
  assert.match(element.textContent, /Worktabs 0\.6\.0 is available.*Worktabs.*0\.5\.2 → 0\.6\.0/);
  assert.deepEqual(labels(), ['Update', 'Release notes', 'Skip this version']);
  for (const button of element.querySelectorAll('button')) button.click();
  assert.deepEqual(calls, ['dismissAppUpdate', 'startAppUpdate', 'openAppReleaseNotes', 'skipAppUpdate']);

  card.render({ status: 'available', ...base, canApply: false, detail: 'Worktabs is at the root of a drive.' });
  assert.deepEqual(labels(), ['Release page', 'Skip this version']);
  assert.equal(element.querySelector('.update-detail').textContent, 'Worktabs is at the root of a drive.\nDownload it from the release page.');

  card.render({ status: 'downloading', ...base, detail: '5 / 100 MB' });
  assert.equal(element.className, 'update preparing');
  assert.equal(element.querySelector('.update-progress').style.values['--phase'], '-100ms');
  assert.deepEqual(labels(), []);

  card.render({ status: 'ready', ...base });
  assert.match(element.textContent, /installs when Worktabs quits/);
  assert.deepEqual(labels(), ['Restart now', 'Release notes']);
  assert.equal(element.querySelector('.close'), null);

  card.render({ status: 'waiting', ...base, busy: ['a', 'b'], detail: 'Wait.' });
  assert.equal(element.querySelector('.update-detail').textContent, 'Waiting for: a, b\nWait.');
  assert.deepEqual(labels(), ['Cancel the restart']);

  card.render({ status: 'failed', ...base, canApply: true, detail: 'HTTP 404' });
  assert.deepEqual(labels(), ['Try again', 'Release page']);
  card.render({ status: 'done', version: '0.6.0', from: '', notesUrl: '' });
  assert.match(element.textContent, /Updated to Worktabs 0\.6\.0/);
  assert.equal(element.querySelector('.update-items'), null);
});

test('the page theme puts a theme\'s colors on the root, and follows the system without one', () => {
  const { document } = dom();
  let change;
  const media = { matches: true, addEventListener: (_type, fn) => { change = fn; } };
  const applyTheme = createPageTheme({ document, window: { matchMedia: () => media } });
  const root = document.documentElement;
  assert.equal(root.dataset.scheme, 'dark');
  applyTheme({ scheme: 'light', contrast: true, vars: { '--bg': '#fff' } });
  assert.equal(root.dataset.scheme, 'light');
  assert.equal(root.style.values['--bg'], '#fff');
  assert.notEqual(root.getAttribute('data-contrast'), null);
  // A change of the system's scheme matters only without a theme of VS Code's.
  media.matches = false;
  change();
  assert.equal(root.dataset.scheme, 'light');
  applyTheme(null);
  assert.equal(root.dataset.scheme, 'light');
  media.matches = true;
  change();
  assert.equal(root.dataset.scheme, 'dark');
});

test('dragging the edge resizes within the limits, and a double click resets', async () => {
  const { document } = dom();
  const edge = document.createElement('div');
  const calls = [];
  const host = {
    startResize: async () => { calls.push(['start']); return { min: 200, max: 400 }; },
    resize: (width) => calls.push(['resize', width]),
    endResize: async (width) => { calls.push(['end', width]); return width ?? 260; },
    resetWidth: async () => { calls.push(['reset']); return 260; },
  };
  const window = fakeWindow();
  attachSidebarResize({ edge, host, window, document });
  edge.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 258, pointerId: 1 });
  assert.equal(document.body.style.width, '260px');
  assert.ok(document.documentElement.classList.contains('resizing'));
  await settle();
  window.emit('pointermove', { clientX: 500, buttons: 1 });
  window.emit('pointermove', { clientX: 100, buttons: 1 });
  window.emit('pointermove', { clientX: 298, buttons: 1 });
  window.emit('pointerup');
  await settle();
  assert.deepEqual(calls, [['start'], ['resize', 400], ['resize', 200], ['resize', 300], ['end', 300]]);
  assert.equal(document.body.style.width, '');
  assert.ok(!document.documentElement.classList.contains('resizing'));
  edge.dispatchEvent({ type: 'dblclick' });
  await settle();
  assert.deepEqual(calls.at(-1), ['reset']);
});

test('the GitHub bar shows the repository\'s pages and its approved pull requests, and closes', () => {
  const { document, el, icon } = dom();
  const reposEl = document.createElement('div');
  reposEl.setAttribute('id', 'repos');
  document.body.append(reposEl);
  const row = el('div', 'row');
  const mark = el('span', 'gh-mark');
  mark.dataset.key = 'repo';
  mark.append(icon('github'));
  row.append(mark);
  reposEl.append(row);
  const barEl = document.createElement('div');
  barEl.hidden = true;
  document.body.append(barEl);
  const group = { key: 'repo', path: '/repo' };
  const state = { github: new Map([['repo', { slug: 'o/repo', url: 'https://github.com/o/repo' }]]) };
  const calls = [];
  const host = { openGithub: (...args) => calls.push(['github', ...args]), openPull: (...args) => calls.push(['pull', ...args]) };
  // Shows and hides at once, in place of hover.js's delays.
  let shown = null;
  const hoverIntent = ({ show, hide }) => ({
    get shown() { return shown; },
    enter: (key) => { shown = key; show(key); },
    enterBar: () => {},
    leave: () => {},
    close: () => { if (shown !== null) { shown = null; hide(); } },
  });
  const loads = [];
  const window = fakeWindow();
  const bar = createGithubBar({
    barEl, reposEl, state, host, dom: { el, icon }, t,
    buttons: [{ page: 'repo', icon: 'repo', title: 'Repository' }, { page: 'pulls', icon: 'pulls', title: 'Pull requests' }],
    groups: () => [group], load: (g) => loads.push(g.key), approvedOf: () => [{ number: 7, title: 'Fix' }], hoverIntent, document, window,
  });
  reposEl.dispatchEvent({ type: 'pointerover', target: mark.firstElementChild });
  assert.deepEqual(loads, ['repo']);
  assert.equal(barEl.hidden, false);
  assert.equal(barEl.getAttribute('aria-label'), 'GitHub（o/repo）');
  assert.ok(mark.classList.contains('open'));
  const buttons = barEl.querySelectorAll('button');
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-label')), ['Repository', 'Pull requests', 'PR #7 approved']);
  buttons[2].click();
  assert.deepEqual(calls, [['pull', '/repo', 7]]);
  assert.equal(barEl.hidden, true);
  assert.ok(!mark.classList.contains('open'));

  reposEl.dispatchEvent({ type: 'pointerleave' });
  reposEl.dispatchEvent({ type: 'pointerover', target: mark });
  assert.equal(barEl.hidden, false);
  window.emit('keydown', { key: 'Escape' });
  assert.equal(barEl.hidden, true);
  // A repository found not to be on GitHub after all takes the bar away as the page redraws.
  reposEl.dispatchEvent({ type: 'pointerleave' });
  reposEl.dispatchEvent({ type: 'pointerover', target: mark });
  state.github.set('repo', null);
  bar.place();
  assert.equal(barEl.hidden, true);
});

test('icons are 16px line drawings, logos fill a 24px box, and every icon the page asks for exists', () => {
  const document = new Document();
  const { icon, logo, agentIcon } = createIcons({ document });
  const pulls = icon('pulls');
  assert.equal(pulls.getAttribute('class'), 'icon');
  assert.equal(pulls.getAttribute('viewBox'), '0 0 16 16');
  assert.equal(pulls.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(pulls.children.map((part) => part.localName), ['circle', 'circle', 'circle', 'path']);
  assert.equal(pulls.children[0].getAttribute('r'), '1.5');
  const more = icon('more');
  assert.ok(more.children.every((part) => part.getAttribute('class') === 'fill'));

  const github = logo('github');
  assert.equal(github.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(github.firstElementChild.getAttribute('d'), LOGOS.github);
  assert.deepEqual([...agentIcon('codex').classList], ['icon', 'agent-icon', 'codex']);
  // Any other agent is Claude's.
  assert.deepEqual([...agentIcon(undefined).classList], ['icon', 'agent-icon', 'claude']);

  const dir = path.join(__dirname, '..', 'src', 'sidebar');
  const source = fs.readdirSync(dir).filter((file) => file.endsWith('.js')).map((file) => fs.readFileSync(path.join(dir, file), 'utf8')).join('\n');
  // icon('name'), rowButton('name', ...), and tables of { icon: 'name' } or { logo: 'name' }.
  const asked = [...source.matchAll(/\b(?:icon|logo|rowButton)(?:\(|: )'(\w+)'/g)].map((match) => match[1]);
  assert.ok(asked.length > 20);
  for (const name of new Set(asked)) assert.ok(ICONS[name] || LOGOS[name], `no icon "${name}"`);
});

test('the section of the repositories not cloned lists them under their owners, and clones from a row', () => {
  const document = makeDocument();
  const { el, icon } = dom();
  const logo = (name) => el('span', `logo ${name}`);
  const rowButton = (name, title, onClick) => {
    const button = el('button', `gh ${name}`);
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
  };
  const me = { key: 'github.com/me', owner: 'me', host: 'github.com', type: 'user' };
  const org = { key: 'ghe.example/org', owner: 'org', host: 'ghe.example', type: 'org' };
  const tool = { key: 'tool', name: 'tool', url: 'https://github.com/me/tool', description: 'A tool', visibility: 'private', fork: true, pushedAt: new Date(2026, 9, 15).getTime() };
  const site = { key: 'site', name: 'site', url: 'https://ghe.example/org/site', visibility: 'public' };
  const state = { uncloned: [me, org], cloning: new Set(['site']), folded: new Set(), filter: '' };
  let shown = [{ group: me, repos: [tool], expanded: true }, { group: org, repos: [site], expanded: true }];
  const calls = [];
  const host = new Proxy({}, { get: (_target, name) => (...args) => calls.push([name, ...args]) });
  const section = createUnclonedSection({
    state, host, document, dom: { el, icon, logo, rowButton },
    select: { shownOwners: () => shown, visibilityMark: ({ label }) => el('span', 'visibility', label) },
    actions: { toggleOwner: (group) => calls.push(['toggle', group.key]) },
    visibilities: { public: { label: 'Public' }, private: { icon: 'lock', label: 'Private' } }, t,
  });
  section.render();
  const tree = document.getElementById('uncloned-tree');
  const rows = tree.children;
  assert.deepEqual(rows.map((row) => row.className), ['row repo owner', 'row uncloned', 'row repo owner', 'row uncloned removing']);
  assert.equal(document.getElementById('uncloned-count').textContent, '2');
  assert.equal(document.getElementById('uncloned-section').hidden, false);
  assert.equal(rows[0].title, 'me (your account)\ngithub.com\nRepositories not cloned: 1');
  assert.equal(rows[2].querySelector('.detail').textContent, 'ghe.example');
  assert.match(rows[2].title, /^org \(organization\)/);
  assert.equal(rows[1].title, 'https://github.com/me/tool\nA tool\nFork\nGitHub: Private\nLast push: 2026/10/15');
  assert.equal(rows[1].querySelector('.visibility').textContent, 'Private');
  // A public one says so only in its title, and one being cloned has no button.
  assert.equal(rows[3].querySelector('.visibility'), null);
  assert.equal(rows[3].querySelector('.state').textContent, 'Cloning…');
  assert.equal(rows[3].querySelector('button'), null);

  rows[1].querySelector('button').click();
  rows[0].click();
  rows[1].dispatchEvent({ type: 'contextmenu' });
  rows[2].dispatchEvent({ type: 'contextmenu' });
  assert.deepEqual(calls, [['cloneRepo', tool.url], ['toggle', me.key], ['showUnclonedMenu', tool.url], ['showOwnerMenu', org.key]]);

  // Folded, it keeps its count; filtering opens it up.
  state.folded.add('uncloned');
  section.render();
  assert.equal(tree.children.length, 0);
  assert.equal(document.getElementById('uncloned-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(document.getElementById('uncloned-count').textContent, '2');
  state.filter = 'nothing';
  shown = [];
  section.render();
  assert.equal(document.getElementById('uncloned-section').hidden, true);
  state.filter = '';
  state.uncloned = [];
  section.render();
  assert.equal(document.getElementById('uncloned-section').hidden, true);
});
