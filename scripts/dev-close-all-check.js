// Close-all check: presses the button on a repository's row that closes all its tabs,
// as the mouse would. With a Claude turn in progress in one of them, it asks once, naming that
// tab, and Cancel keeps them all. Then a double click: the repository's tabs close (a suspended
// one among them), the tab outside it comes to the front, and the second click, which lands on
// the next repository's row as it moves up, closes nothing. A click there a moment later closes
// that one's tabs. Then the folders outside git, and the ports stay with the closed tabs.
//
// usage: node scripts/dev-close-all-check.js <folder of a repository> <another worktree of it> <folder of another repository> <folder outside git>
// The first repository's name sorts before the other's, both expanded in the side bar and
// neither on GitHub (their rows then have the same buttons). With WORKTABS_DATA_DIR as the app
// has it, also checks the ports in tabs.json.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { appText, call, log, run, sleep, until } = require('./dev-lib');

const [A, B, C, D] = process.argv.slice(2).map((folder) => path.resolve(folder));
const SESSION = 'close-all-check';

const sidebar = (js) => call('eval', { id: 'sidebar', js });
const state = () => call('state');
const tabOf = async (folder) => (await state()).tabs.find((t) => t.folder.toLowerCase() === folder.toLowerCase());
const openNames = async () => (await state()).tabs.map((t) => t.name);
const mouse = (type, { x, y }, clickCount = 1) => call('mouse', { id: 'sidebar', event: { type, x, y, button: 'left', clickCount } });

// The close-all button of the repository row named `name`, and whether it shows (the mouse is
// over its row).
const closeButton = (name) =>
  sidebar(`(() => {
    const row = [...document.querySelectorAll('#repos .row.repo')].find((r) => r.querySelector('.name')?.textContent === ${JSON.stringify(name)});
    const button = row?.querySelector('.close-all');
    if (!button) return null;
    const box = button.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), shown: getComputedStyle(button).visibility === 'visible' };
  })()`);

// What is under the point: the name of the row and whether it is a close-all button.
const under = ({ x, y }) =>
  sidebar(`(() => {
    const hit = document.elementFromPoint(${x}, ${y});
    return { row: hit?.closest('.row')?.querySelector('.name')?.textContent ?? null, closeAll: Boolean(hit?.closest('.close-all')) };
  })()`);

// Moves the mouse over the button until its row shows it.
async function hover(name) {
  return until(`close-all button of ${name}`, async () => {
    const button = await closeButton(name);
    if (!button) return null;
    await mouse('mouseMove', button);
    return button.shown ? button : null;
  }, 15000, 300);
}

const DIALOG = `(() => {
  if (document.getElementById('backdrop').hidden || document.getElementById('box').hidden) return null;
  return { message: document.getElementById('message').textContent, detail: document.getElementById('detail').textContent };
})()`;

function savedPorts() {
  if (!process.env.WORKTABS_DATA_DIR) return null;
  return JSON.parse(fs.readFileSync(path.join(process.env.WORKTABS_DATA_DIR, 'tabs.json'), 'utf8')).ports || {};
}

async function openRunning(folder) {
  const id = await call('open', { folder, activate: false });
  await until(`${folder} running`, async () => (await tabOf(folder))?.server === 'running', 120000);
  return id;
}

run(async () => {
  await until('control port', () => call('state'), 60000);
  const ids = {};
  for (const folder of [A, B, C, D]) ids[folder] = await openRunning(folder);
  const tabA = await tabOf(A);
  const repo1 = path.basename(tabA.repo);
  const repo2 = path.basename((await tabOf(C)).repo);
  await call('suspend', { id: ids[B] });
  await call('activate', { id: ids[A] });
  await until('the side bar shows both repositories with their buttons', async () => (await closeButton(repo1)) && (await closeButton(repo2)), 15000, 300);
  log('open:', JSON.stringify(await openNames()), `${path.basename(B)} suspended`);

  // A turn in progress: asked once, naming that tab; Cancel keeps them all.
  await call('hook', { id: ids[A], input: { session_id: SESSION, hook_event_name: 'UserPromptSubmit', prompt: 'close-all check' } });
  let button = await hover(repo1);
  await mouse('mouseDown', button);
  await mouse('mouseUp', button);
  const dialog = await until('the confirmation', () => call('eval', { id: 'dialog', js: DIALOG }), 10000, 200);
  log('asked:', JSON.stringify(dialog));
  const tt = await appText();
  assert.equal(dialog.message, tt('Closing all the tabs of {name} will have these effects.', { name: repo1 }));
  assert.ok(dialog.detail.startsWith(`${tabA.name}: ${tt('{agent} is working. The turn in progress will be interrupted.', { agent: 'Claude' })}`));
  assert.equal(dialog.detail.split('\n').length, 1);
  await call('key', { id: 'dialog', keyCode: 'Escape' });
  await until('the dialog to go', async () => (await call('eval', { id: 'dialog', js: DIALOG })) === null, 5000, 200);
  await sleep(800);
  assert.equal((await state()).tabs.length, 4);
  log('Cancel: all four still open');
  await call('hook', { id: ids[A], input: { session_id: SESSION, hook_event_name: 'SessionEnd' } });

  // A double click: the first closes the repository's tabs without asking, the second lands on
  // the next repository's row, which has moved up, and does nothing.
  button = await hover(repo1);
  await mouse('mouseDown', button, 1);
  await mouse('mouseUp', button, 1);
  await until(`${repo1}'s tabs to close`, async () => !(await tabOf(A)) && !(await tabOf(B)), 5000, 50);
  const second = await under(button);
  log('the second click lands on:', JSON.stringify(second));
  await mouse('mouseDown', button, 2);
  await mouse('mouseUp', button, 2);
  await sleep(1000);
  const after = await state();
  log('after the double click:', JSON.stringify(after.tabs.map((t) => ({ name: t.name, active: t.active, server: t.server }))));
  assert.deepEqual(after.tabs.map((t) => t.folder.toLowerCase()), [C, D].map((f) => f.toLowerCase()));
  assert.equal(after.tabs.find((t) => t.active)?.folder.toLowerCase(), C.toLowerCase());
  assert.equal(second.row, repo2, `the second click should land on ${repo2}'s row`);

  // A moment later, a click there closes the next repository's tabs.
  button = await hover(repo2);
  await mouse('mouseDown', button);
  await mouse('mouseUp', button);
  await until(`${repo2}'s tab to close`, async () => !(await tabOf(C)), 5000, 100);
  assert.equal((await state()).tabs.find((t) => t.active)?.folder.toLowerCase(), D.toLowerCase());
  log(`${repo2}: closed with a click after the pause; ${path.basename(D)} in front`);

  // The folders outside git, as their row's button does.
  assert.equal(await call('closeTogether', { ids: [ids[D]] }), true);
  assert.equal((await state()).tabs.length, 0);
  log('the folders outside git: closed, no tab left');

  const ports = savedPorts();
  if (ports) {
    const kept = Object.keys(ports).map((f) => f.toLowerCase());
    for (const folder of [A, B, C, D]) assert.ok(kept.includes(folder.toLowerCase()), `the port of ${folder} is kept`);
    log('tabs.json keeps the ports of all four');
  }
  const reopened = await openRunning(A);
  log(`${path.basename(A)} opened again on port ${(await tabOf(A)).port} (was ${tabA.port})`);
  assert.equal((await tabOf(A)).port, tabA.port);
  await call('close', { id: reopened });
  log('OK');
});
