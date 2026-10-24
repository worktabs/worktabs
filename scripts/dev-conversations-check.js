// End-to-end check of the conversation rows: starts two Claude conversations in one worktree,
// a long one (B) and a short one (A), and switches to another tab. A must show as finished and
// unread while B still works; bringing A to the front must reveal its Claude tab without a
// new one; closing that tab must take A off the rows and leave B's.
//
// usage: node scripts/dev-conversations-check.js <other worktree> <worktree with the conversations>
// Needs a data folder with a short path (WORKTABS_DATA_DIR): under a long one, Chromium cannot
// open the webviews' Cache Storage and the Claude panels stay blank.
const { approveFirstOption, call, log, openClaudePanel, run, sleep, until } = require('./dev-lib');

const [OTHER, TARGET] = process.argv.slice(2);
const PROMPT_B = 'CHECK-B: Use the Bash tool to run `powershell -NoProfile -Command Start-Sleep -Seconds 45`, then reply with just the word DONE.';
const PROMPT_A = 'CHECK-A: Reply with just the word OK.';

// Types a prompt into the one Claude panel that has no conversation yet, and sends it.
async function sendInNewPanel(id, text) {
  await until('an empty Claude panel', async () => {
    const typed = await call('eval', {
      id,
      target: 'webviews',
      js: `(() => {
        const input = document.querySelector('[aria-label="Message input"]');
        if (!input || document.body.innerText.includes('CHECK-')) return undefined;
        // The chat first, as a click would: the app keeps a chat without the focus from taking it.
        window.focus();
        input.focus();
        document.execCommand('selectAll');
        document.execCommand('insertText', false, ${JSON.stringify(text)});
        return 'typed';
      })()`,
    });
    return typed.filter((r) => r === 'typed').length === 1;
  }, 60000, 1000);
  const marker = text.slice(0, 7);
  await until('send button', async () => {
    const sent = await call('eval', {
      id,
      target: 'webviews',
      js: `(() => {
        const input = document.querySelector('[aria-label="Message input"]');
        if (!input || !input.innerText.includes(${JSON.stringify(marker)})) return undefined;
        const send = document.querySelector('button[aria-label="Send message"]');
        if (!send || send.disabled) return false;
        send.click();
        return true;
      })()`,
    });
    return sent.includes(true);
  }, 10000, 300);
}

// Opens another conversation tab with the Session Manager's "New session" button.
async function openAnotherPanel(id) {
  await until('New session', async () => {
    const clicked = await call('eval', {
      id,
      target: 'webviews',
      js: `(() => {
        const button = [...document.querySelectorAll('button, [role=button]')].find((b) => (b.innerText.trim() || b.getAttribute('aria-label')) === 'New session');
        if (!button) return false;
        button.click();
        return true;
      })()`,
    });
    return clicked.includes(true);
  }, 30000, 1000);
}

// Labels of the Claude editor tabs in the tab's VS Code, and which one is active.
async function claudeTabs(id) {
  return call('eval', {
    id,
    js: `[...document.querySelectorAll('.tabs-container .tab')].map((t) => ({
      label: t.getAttribute('aria-label') || '',
      active: t.classList.contains('active'),
    }))`,
  });
}

const tabOf = async (id) => (await call('state')).tabs.find((t) => t.id === id);

// The conversation rows in the side bar, as "<badge> <name>".
const conversationRows = () => call('eval', {
  id: 'sidebar',
  js: `[...document.querySelectorAll('#repos .row.conversation')].map((r) => r.querySelector('.dot').className.replace('dot ', '') + ' ' + r.querySelector('.name').textContent)`,
});

run(async () => {
  await until('control port', () => call('state'), 60000);
  const other = await call('open', { folder: OTHER, activate: true });
  const target = await call('open', { folder: TARGET, activate: true });
  await until('both servers running', async () => {
    const state = await call('state');
    return state.tabs.filter((t) => [other, target].includes(t.id)).every((t) => t.server === 'running');
  });
  log('servers running', { other, target });

  await openClaudePanel(target);
  await sendInNewPanel(target, PROMPT_B);
  log('sent B');
  await openAnotherPanel(target);
  await sendInNewPanel(target, PROMPT_A);
  log('sent A');
  await call('activate', { id: other });

  const done = await until('A to finish while B works', async () => {
    const tab = await tabOf(target);
    const a = tab.conversations.find((c) => c.prompt?.startsWith('CHECK-A') || /check-a/i.test(c.title || ''));
    return a && a.state === 'done' ? { tab, a } : false;
  }, 120000, 1000);
  const b = done.tab.conversations.find((c) => c.id !== done.a.id);
  log('A finished', { tabBadge: done.tab.agent, tabUnread: done.tab.unread, a: done.a, b });
  if (!['working', 'waiting'].includes(done.tab.agent) || !done.a.unread) throw new Error('A should be unread while the tab shows B busy');
  const rows = await conversationRows();
  log('side bar rows', rows);
  if (rows.length !== 2) throw new Error('expected two conversation rows');
  const procs = (await call('state')).sessions.filter((s) => s.tabId === target && s.conversation).map((s) => s.procs);
  log('processes per conversation', procs);

  const before = await claudeTabs(target);
  await call('reveal', { id: target, session: done.a.id });
  await sleep(2000);
  const after = await claudeTabs(target);
  log('editor tabs after reveal', after);
  const active = after.find((t) => t.active);
  if (after.length !== before.length) throw new Error('revealing A opened another tab');
  if (!active || !done.a.title || !active.label.startsWith(done.a.title)) throw new Error('A is not the active tab');
  if ((await tabOf(target)).conversations.find((c) => c.id === done.a.id)?.unread) throw new Error('A is still unread');

  // Closing A's tab ends its claude; its row goes within a poll or two.
  await call('eval', { id: target, js: `document.querySelector('.tabs-container .tab.active .tab-actions .action-label')?.click(), true` });
  await until('A to leave the rows', async () => !(await tabOf(target)).conversations.some((c) => c.id === done.a.id), 15000, 500);
  log('A closed', (await tabOf(target)).conversations);
  // B, now the only conversation, keeps its row.
  await until('B alone to keep its row', async () => (await conversationRows()).length === 1, 5000, 300);

  await until('B to finish', async () => {
    const state = (await tabOf(target)).conversations.find((c) => c.id === b.id)?.state;
    // B's command may need an approval, depending on the permission mode.
    if (state === 'waiting') log(`approved: ${await approveFirstOption(target)}`);
    return state === 'done';
  }, 180000, 1000);
  const tab = await tabOf(target);
  log('B finished', { tabBadge: tab.agent, tabUnread: tab.unread, conversations: tab.conversations });
  log('OK');
});
