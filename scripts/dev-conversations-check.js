// End-to-end check of the conversation rows, with Claude Code's chat in the side bar: starts a
// long conversation (B) there, then a short one (A) with the chat's "New session", which leaves
// B working behind A, and switches to another tab. A must show as finished and unread while B
// still works. Bringing A to the front must switch the chat to A without another claude or an
// editor tab, and clear its mark. B then finishes behind A, in the tab in front: B must turn
// unread, as the chat does not show it, and bringing B to the front must clear its mark.
//
// usage: node scripts/dev-conversations-check.js <other worktree> <worktree with the conversations>
// Keep the app's window in front: a conversation counts as seen only while it is. Needs a data
// folder with a short path (WORKTABS_DATA_DIR): under a long one, Chromium cannot open the
// webviews' Cache Storage and the Claude panels stay blank.
const { approveFirstOption, call, log, newSidebarSession, run, sendInSidebarChat, sidebarChatShows, until } = require('./dev-lib');

const [OTHER, TARGET] = process.argv.slice(2);
const PROMPT_B = 'CHECK-B: Use the Bash tool to run `sleep 45`, then reply with just the word DONE.';
const PROMPT_A = 'CHECK-A: Reply with just the word OK.';

const tabOf = async (id) => (await call('state')).tabs.find((t) => t.id === id);
const conversationOf = async (id, conversation) => (await tabOf(id)).conversations.find((c) => c.id === conversation);
const claudes = async (id) => (await call('state')).sessions.filter((s) => s.tabId === id).flatMap((s) => s.procs).sort().join(',');
const editorTabs = (id) => call('eval', {
  id,
  js: `[...document.querySelectorAll('.tabs-container .tab')].map((t) => t.getAttribute('aria-label') || '')`,
});

// The conversation rows of `folder`'s tab in the side bar (those right under its row), as
// "<badge> <name>". Null when the side bar shows no row for it.
const conversationRows = (folder) => call('eval', {
  id: 'sidebar',
  js: `(() => {
    const rows = [...document.querySelectorAll('#repos .row')];
    const start = rows.findIndex((row) => row.dataset.folder?.toLowerCase() === ${JSON.stringify(folder.toLowerCase())});
    if (start < 0) return null;
    const found = [];
    for (const row of rows.slice(start + 1)) {
      if (!row.classList.contains('conversation')) break;
      found.push(row.querySelector('.dot').className.replace('dot ', '') + ' ' + row.querySelector('.name').textContent);
    }
    return found;
  })()`,
});

// Brings `conversation` to the front as its row does, and waits for the chat to show `marker`
// and the conversation's mark to clear.
async function reveal(id, conversation, marker) {
  const before = { claudes: await claudes(id), tabs: (await editorTabs(id)).length };
  await call('reveal', { id, session: conversation });
  await until(`the chat to show ${marker}`, async () => (await sidebarChatShows(id)) === marker, 15000, 300);
  await until(`${marker}'s mark to clear`, async () => !(await conversationOf(id, conversation))?.unread, 10000, 300);
  if ((await claudes(id)) !== before.claudes) throw new Error(`bringing ${marker} to the front started or stopped a claude`);
  if ((await editorTabs(id)).length !== before.tabs) throw new Error(`bringing ${marker} to the front opened an editor tab`);
  log(`${marker} in front, its mark cleared`);
}

run(async () => {
  await until('control port', () => call('state'), 60000);
  const other = await call('open', { folder: OTHER, activate: true });
  const target = await call('open', { folder: TARGET, activate: true });
  await until('both servers running', async () => {
    const state = await call('state');
    return state.tabs.filter((t) => [other, target].includes(t.id)).every((t) => t.server === 'running');
  });
  // The helper shows the chat in the side bar.
  await until('the helper extension', () => call('helper', { id: target, route: '/new-conversation' }), 60000, 1000);
  log('servers running', { other, target });

  await sendInSidebarChat(target, PROMPT_B);
  await until('B to start', async () => (await tabOf(target)).conversations.some((c) => c.prompt?.startsWith('CHECK-B')), 60000, 500);
  log('sent B');
  await newSidebarSession(target);
  await sendInSidebarChat(target, PROMPT_A);
  log('sent A');
  await call('activate', { id: other });

  const done = await until('A to finish while B works', async () => {
    const tab = await tabOf(target);
    const a = tab.conversations.find((c) => c.prompt?.startsWith('CHECK-A'));
    return a && a.state === 'done' ? { tab, a } : false;
  }, 120000, 1000);
  const b = done.tab.conversations.find((c) => c.prompt?.startsWith('CHECK-B'));
  log('A finished', { tabBadge: done.tab.agent, a: { state: done.a.state, unread: done.a.unread }, b: { state: b.state, unread: b.unread } });
  if (!['working', 'waiting'].includes(done.tab.agent) || !done.a.unread) throw new Error('A should be unread while the tab shows B busy');
  const rows = await conversationRows(done.tab.folder);
  log('side bar rows', rows);
  if (rows?.length !== 2) throw new Error('expected two conversation rows');

  await call('activate', { id: target });
  await reveal(target, done.a.id, 'CHECK-A');

  // B finishes behind A, in the tab in front.
  const finished = await until('B to finish', async () => {
    const conversation = await conversationOf(target, b.id);
    // B's command may need an approval, depending on the permission mode.
    if (conversation?.state === 'waiting') log(`approved: ${await approveFirstOption(target)}`);
    return conversation?.state === 'done' ? conversation : false;
  }, 180000, 1000);
  log('B finished behind A', { unread: finished.unread });
  if (!finished.unread) throw new Error('B should be unread while the chat shows A');
  await reveal(target, b.id, 'CHECK-B');
  log('OK');
});
