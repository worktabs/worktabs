// Secondary side bar check: opens a folder the app has not opened before (on a new port, where VS
// Code shows its own chat in the secondary side bar) and follows what that side bar shows until
// the Claude chat takes its place. Then closes the side bar, closes the tab, opens it again (on
// the same port) and checks the side bar stays closed.
//
// usage: node scripts/dev-chat-view-check.js <folder the app has not opened>
const path = require('path');
const { SECONDARY_VIEW_SCRIPT } = require('../src/conversations/secondary-sidebar');
const { call, log, run, sleep, until } = require('./dev-lib');

const FOLDER = path.resolve(process.argv[2]);
const BUILT_IN_CHAT = 'workbench.panel.chat';
const CLAUDE = 'workbench.view.extension.claude-sidebar-secondary';

const tabFor = async (folder) => (await call('state')).tabs.find((t) => t.folder.toLowerCase() === folder.toLowerCase());
const shown = (id) => call('eval', { id, js: SECONDARY_VIEW_SCRIPT }).catch(() => null);
// Whether the focus is in the secondary side bar (the Claude chat would have taken it).
const focusInSideBar = (id) => call('eval', { id, js: `!!document.activeElement?.closest('.part.auxiliarybar')` });
// The helper extension has registered once a route answers: /settings with nothing to set.
const helperUp = (id) => call('helper', { id, route: '/settings', body: { set: {}, remove: [] } });

async function openRunning(folder) {
  const id = await call('open', { folder });
  await until(`${folder} running`, async () => (await tabFor(folder))?.server === 'running', 120000);
  return { id, port: (await tabFor(folder)).port };
}

// Logs what the secondary side bar shows each time it changes, and when the helper extension
// registers, until `done(view)` or the time runs out. Resolves the views in the order seen.
async function follow(id, done, timeoutMs = 60000) {
  const seen = [];
  let helper = false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await shown(id);
    if (view !== seen[seen.length - 1]) {
      seen.push(view);
      log('secondary side bar:', view);
    }
    if (!helper && (await helperUp(id))) {
      helper = true;
      log('helper extension registered');
    }
    if (done(view, helper)) break;
    await sleep(200);
  }
  return seen;
}

run(async () => {
  if ((await call('state')).tabs.some((t) => t.folder.toLowerCase() === FOLDER.toLowerCase())) {
    throw new Error(`${FOLDER} is open already; give a folder the app has not opened`);
  }
  const first = await openRunning(FOLDER);
  log(`running on port ${first.port}`);
  const seen = await follow(first.id, (view) => view === CLAUDE);
  const switched = seen[seen.length - 1] === CLAUDE;
  log(seen.includes(BUILT_IN_CHAT) ? 'VS Code showed its own chat first' : 'VS Code did NOT show its own chat first');
  log(switched ? 'the Claude chat took its place' : 'the Claude chat did NOT take its place');
  const focusMoved = await focusInSideBar(first.id);
  log(focusMoved ? 'the focus MOVED to the side bar' : 'the focus stayed out of the side bar');

  // Closes the side bar with its own button. Not with its key: keys do not reach the page of a
  // hidden window (WORKTABS_HIDDEN).
  await call('eval', { id: first.id, js: `document.querySelector('.part.auxiliarybar .codicon-auxiliarybar-close')?.click()` });
  await until('side bar closed', async () => (await shown(first.id)) === 'hidden', 10000, 300);
  // VS Code saves its layout every 5 seconds and when its page loses the focus, not as the page
  // goes away. The page of a hidden window never has the focus, so wait for the 5 seconds.
  await sleep(6000);
  await call('close', { id: first.id });
  log('closed the side bar and the tab');

  const again = await openRunning(FOLDER);
  log(`reopened on port ${again.port} (${again.port === first.port ? 'same' : 'DIFFERENT'})`);
  let registeredAt = 0;
  const after = await follow(again.id, (view, helper) => {
    if (helper && !registeredAt) registeredAt = Date.now();
    // Past the few seconds the app reads the side bar for.
    return registeredAt && Date.now() - registeredAt > 8000;
  });
  const stayedClosed = after[after.length - 1] === 'hidden' && !after.includes(CLAUDE);
  log(stayedClosed ? 'the side bar stayed closed' : 'the side bar did NOT stay closed');

  if (!switched || focusMoved || !stayedClosed || again.port !== first.port) process.exit(1);
});
