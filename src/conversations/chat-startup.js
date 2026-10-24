// Whether the agent chats start in the tabs. An update of an agent's extension can bring a chat
// that never starts in code-server, or that stops its page while it starts (Codex 26.1021.22027
// did, before codex-frame-preload.js). An agent whose chat has not started in a tab a minute
// after it first loaded there, or whose chat stopped answering meanwhile, is told to the person
// once for each version of its extension, with the previous version to go back to when there is
// one. Electron's frames and the dialog are injected, so fakes test it.
const { t } = require('../i18n');
const { AGENTS } = require('../agents/agents');
const { waitInPage } = require('./page-wait');

// Run in a chat's page: whether it has started, which it has once React has put its own elements
// in #root, in place of what the page comes with (Codex's startup loader). The chats of Claude
// Code and Codex both do.
function chatStarted(document) {
  const root = document.getElementById('root');
  return !!root && [...root.children].some((child) => Object.keys(child).some((key) => key.startsWith('__reactFiber$')));
}

const CHAT_STARTED_SCRIPT = `(${chatStarted})(document)`;

// Waits in the chat's page, for up to `wait` milliseconds, until it has started. Resolves whether
// it has.
function chatStartedScript(wait) {
  return `(${waitInPage})(() => (${chatStarted})(document), (started) => started, ${wait}, window)`;
}

const STUCK = Symbol('stuck');

// What `promise` resolves, or `fallback` once `ms` have passed: a page whose main thread is stuck
// never answers.
function within(promise, ms, fallback) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms, fallback); })])
    .finally(() => clearTimeout(timer));
}

// How an agent's chat, in the frames `framesNow()` gives, starts: 'started', once one of them
// has; 'gone', when they or their tab go away first; 'late', when none has started within
// `timeout`; 'stuck', when one does not answer for `answerTimeout` past the `pageWait` its check
// waits in the page. The frames are looked up for each check: Electron gives a frame another
// object as VS Code writes the chat's page into it, and VS Code replaces the frame when the
// extension sets the page again (Codex does after 30 seconds without its chat), so the minute
// runs on across them.
async function chatStartup(framesNow, { current, timeout = 60000, answerTimeout = 10000, pageWait = 5000,
  interval = 1000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
  const deadline = now() + timeout;
  for (;;) {
    const frames = current() ? framesNow() : [];
    if (!frames.length) return 'gone';
    const wait = Math.max(0, Math.min(pageWait, deadline - now()));
    // A frame disposed meanwhile is looked up again on the next check.
    const answers = await Promise.all(frames.map((frame) =>
      within(frame.executeJavaScript(chatStartedScript(wait)).catch(() => false), wait + answerTimeout, STUCK)));
    if (answers.includes(true)) return 'started';
    if (!current() || !framesNow().length) return 'gone';
    if (answers.includes(STUCK)) return 'stuck';
    if (now() >= deadline) return 'late';
    await sleep(interval);
  }
}

// `current(tab)`: whether the tab is still open. `chatFrames(tab, agent)`: the frames of the
// agent's chats in the tab's page. `versions(tab, agent)`: { id, version, previous } of the
// agent's extension the tab runs (version '' when not known; previous: the version Settings can go
// back to, or null). `ask(options)`: a message box. `rollback(id)`: goes back to the previous
// version. `reload(tab)`. `timing`: chatStartup's options.
function createChatStartupWatch({ current, chatFrames, versions, ask, rollback, reload, log = (_line) => {}, timing = {} }) {
  const watching = new Set();
  const told = new Set();

  // Watches the chat of `agent` that has just loaded in the tab's page, unless it is watched
  // there already (its frame loads fake.html first, then the chat's page).
  async function watch(tab, agent) {
    const key = `${tab.id}/${agent}`;
    if (watching.has(key)) return;
    watching.add(key);
    let outcome;
    try {
      outcome = await chatStartup(() => chatFrames(tab, agent), { current: () => current(tab), ...timing });
    } finally {
      watching.delete(key);
    }
    if (!['late', 'stuck'].includes(outcome) || !current(tab)) return;
    const { id, version, previous } = versions(tab, agent);
    log(`${tab.name}: ${id} ${version || '(version not known)'} ${outcome}`);
    if (told.has(`${id}@${version}`)) return;
    told.add(`${id}@${version}`);
    const agentName = AGENTS[agent].label;
    const name = version ? `${agentName} ${version}` : agentName;
    const detail = [
      outcome === 'late'
        ? t('{name} did not start its chat in {tab} within a minute.', { name, tab: tab.name })
        : t('The {name} chat in {tab} stopped responding while it started.', { name, tab: tab.name }),
      previous
        ? t('Going back to the previous version, {previous}, restarts the tabs.', { previous })
        : t('Reload the tab to try again.'),
    ].join('\n\n');
    const buttons = [...(previous ? [t('Go back to {version}', { version: previous })] : []), t('Reload the tab'), t('Close')];
    const { response } = await ask({ type: 'warning', message: t('The {agent} chat did not start.', { agent: agentName }),
      detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
    if (previous && response === 0) {
      try {
        await rollback(id);
      } catch (error) {
        await ask({ type: 'warning', message: t('Could not go back to the previous version.'), detail: error.message });
      }
    } else if (response === buttons.length - 2 && current(tab)) {
      reload(tab);
    }
  }

  return { watch };
}

module.exports = { CHAT_STARTED_SCRIPT, chatStartedScript, chatStartup, createChatStartupWatch };
