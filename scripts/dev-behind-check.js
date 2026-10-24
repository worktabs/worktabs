// End-to-end check of the conversations behind the chat in the side bar: starts a
// conversation A there, then B with the chat's "New session", which leaves A behind B with its
// claude running. Bringing A to the front must switch the chat to A without another claude or
// an editor tab, and put claudeCode.preferredLocation back as it was. Archiving B must take its
// row off while its claude goes on, and a prompt sent to B must bring the row back.
//
// usage: node scripts/dev-behind-check.js <worktree>
// Needs a data folder with a short path (WORKTABS_DATA_DIR): under a long one, Chromium cannot
// open the webviews' Cache Storage and the Claude panels stay blank.
const fs = require('fs');
const path = require('path');
const { call, log, newSidebarSession, run, sendInSidebarChat, sidebarChatShows, sleep, until } = require('./dev-lib');

const [FOLDER] = process.argv.slice(2);
const PROMPTS = {
  A: 'CHECK-A: Reply with just the word ALPHA.',
  B: 'CHECK-B: Reply with just the word BRAVO.',
  C: 'CHECK-C: Reply with just the word CHARLIE.',
};

const send = sendInSidebarChat;
const shown = sidebarChatShows;

const tabOf = async (id) => (await call('state')).tabs.find((t) => t.id === id);
const sessionsOf = async (id) => (await call('state')).sessions.filter((s) => s.tabId === id);

// Waits for a conversation other than `known` to finish, and returns its id.
async function finished(id, known, what) {
  return until(what, async () => {
    const done = (await tabOf(id)).conversations.find((c) => !known.includes(c.id) && c.state === 'done');
    return done && done.id;
  }, 180000, 1000);
}

// claudeCode.preferredLocation in the tab's user and machine settings (undefined when absent).
function preferredLocation(id) {
  const dataDir = process.env.WORKTABS_DATA_DIR;
  if (!dataDir) return 'unknown (WORKTABS_DATA_DIR is not set)';
  return Object.fromEntries(['User', 'Machine'].map((scope) => {
    const file = path.join(dataDir, 'instances', id, scope, 'settings.json');
    try {
      return [scope, JSON.parse(fs.readFileSync(file, 'utf8'))['claudeCode.preferredLocation']];
    } catch {
      return [scope, undefined];
    }
  }));
}

const editorTabs = (id) => call('eval', {
  id,
  js: `[...document.querySelectorAll('.tabs-container .tab')].map((t) => t.getAttribute('aria-label') || '')`,
});

run(async () => {
  await until('control port', () => call('state'), 60000);
  const id = await call('open', { folder: FOLDER, activate: true });
  await until('server running', async () => (await tabOf(id))?.server === 'running');
  await until('the helper extension', () => call('helper', { id, route: '/new-conversation' }), 60000, 1000);
  const settingsBefore = preferredLocation(id);
  log('tab', id, 'settings before', settingsBefore);

  await send(id, PROMPTS.A);
  const a = await finished(id, [], 'A to finish');
  log('A finished', a);
  await newSidebarSession(id);
  await send(id, PROMPTS.B);
  const b = await finished(id, [a], 'B to finish');
  log('B finished', b, 'the chat shows', await shown(id));

  const before = await sessionsOf(id);
  log('sessions', before.map((s) => ({ id: s.id, state: s.state, procs: s.procs, conversation: s.conversation })));
  if (!before.find((s) => s.id === a)?.procs.length) throw new Error('A should keep its claude behind B');
  const tabsBefore = await editorTabs(id);

  await call('reveal', { id, session: a });
  const now = await until('the chat to show A', async () => ((await shown(id)) === 'CHECK-A' ? 'CHECK-A' : false), 15000, 300);
  log('after revealing A, the chat shows', now);
  const after = await sessionsOf(id);
  const procs = (list) => list.flatMap((s) => s.procs).sort().join(',');
  log('processes before', procs(before), 'after', procs(after));
  if (procs(after) !== procs(before)) throw new Error('revealing A started or stopped a claude');
  if ((await editorTabs(id)).length !== tabsBefore.length) throw new Error('revealing A opened an editor tab');
  const settings = preferredLocation(id);
  log('settings after', settings);
  if (JSON.stringify(settings) !== JSON.stringify(settingsBefore)) throw new Error('claudeCode.preferredLocation was not put back');

  // Revealing B brings it back to the front; then B is archived, behind A again.
  await call('reveal', { id, session: b });
  await until('the chat to show B', async () => (await shown(id)) === 'CHECK-B', 15000, 300);
  await call('reveal', { id, session: a });
  await until('the chat to show A again', async () => (await shown(id)) === 'CHECK-A', 15000, 300);
  await call('archive', { id, session: b });
  const listed = (await tabOf(id)).conversations.map((c) => c.id);
  log('rows after archiving B', listed);
  if (listed.includes(b)) throw new Error('B still has a row');
  const archived = (await sessionsOf(id)).find((s) => s.id === b);
  if (!archived?.archived || !archived.procs.length) throw new Error("B's claude should go on");

  // B in front again (as from the chat's history), and a prompt to it: its row comes back.
  await call('helper', { id, route: '/reveal', body: { sessionId: b } });
  await until('the chat to show B', async () => (await shown(id)) === 'CHECK-B', 15000, 300);
  await send(id, PROMPTS.C);
  await until("B's row to come back", async () => (await tabOf(id)).conversations.some((c) => c.id === b), 60000, 500);
  await until('B to finish', async () => (await tabOf(id)).conversations.find((c) => c.id === b)?.state === 'done', 180000, 1000);
  log('rows', (await tabOf(id)).conversations.map((c) => ({ id: c.id, state: c.state })));
  await sleep(500);
  log('OK');
});
