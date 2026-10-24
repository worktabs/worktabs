// Helpers for the dev-*.js checks, which drive the app through its development control port
// (start the app with WORKTABS_CONTROL_PORT=47821).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TOKEN_FILE, TOKEN_HEADER } = require('../src/window/control');

const CONTROL = `http://127.0.0.1:${process.env.WORKTABS_CONTROL_PORT || 47821}`;

// The app's data folder: WORKTABS_DATA_DIR as the app takes it, else Electron's userData.
function dataDir() {
  if (process.env.WORKTABS_DATA_DIR) return path.resolve(process.env.WORKTABS_DATA_DIR);
  const appData = {
    win32: process.env.APPDATA,
    darwin: path.join(os.homedir(), 'Library', 'Application Support'),
  }[process.platform] || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(appData, 'Worktabs');
}

// The token the app wrote at start; read on each call, as the app may have been restarted.
function controlToken() {
  if (process.env.WORKTABS_CONTROL_TOKEN) return process.env.WORKTABS_CONTROL_TOKEN;
  const file = path.join(dataDir(), TOKEN_FILE);
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`no control token at ${file} (set WORKTABS_DATA_DIR as for the app)`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const log = (...args) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s]`, ...args);

async function call(action, body = {}) {
  const res = await fetch(`${CONTROL}/${action}`, { method: 'POST', headers: { [TOKEN_HEADER]: controlToken() }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!json.ok) throw new Error(`${action}: ${json.error}`);
  return json.result;
}

async function until(what, check, timeoutMs = 120000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

async function tabNamed(name) {
  const tab = (await call('state')).tabs.find((t) => t.name === name);
  if (!tab) throw new Error(`no tab named ${name}`);
  return tab;
}

// Runs `js` in the Claude panel's webview frame of a tab (undefined when there is none).
async function inPanel(id, js) {
  const results = await call('eval', {
    id,
    target: 'webviews',
    js: `document.querySelector('[aria-label="Message input"]') ? (${js}) : undefined`,
  });
  return results.find((r) => r !== undefined && r !== null);
}

// Badge classes of the open tabs in the side bar, keyed by tab name (the folder name; a row
// shows "primary" for a main worktree instead). Only rows in expanded repositories show.
async function badges() {
  return call('eval', {
    id: 'sidebar',
    js: `Object.fromEntries([...document.querySelectorAll('#repos .row.worktree.open')].map((t) => [t.dataset.folder.split(/[\\\\/]/).pop(), t.querySelector('.dot').className.replace('dot ', '')]))`,
  });
}

// Opens a new Claude conversation: the activity bar item shows the Session Manager, whose
// "New session" button opens a chat tab. Webviews are only created while the tab is visible.
// The activity bar item toggles the view, so it is clicked only when the Session Manager is
// not already showing.
async function openClaudePanel(id) {
  let lastToggle = 0;
  await until(`Claude panel in ${id}`, async () => {
    if (await inPanel(id, 'true')) return true;
    const clickedNew = await call('eval', {
      id,
      target: 'webviews',
      js: `(() => {
        const button = [...document.querySelectorAll('button, [role=button]')].find((b) => (b.innerText.trim() || b.getAttribute('aria-label')) === 'New session');
        if (!button) return false;
        button.click();
        return true;
      })()`,
    });
    if (!clickedNew.includes(true) && Date.now() - lastToggle > 8000) {
      lastToggle = Date.now();
      await call('eval', {
        id,
        js: `(() => {
          const item = [...document.querySelectorAll('.activitybar .action-item a')].find((a) => a.getAttribute('aria-label') === 'Claude Code');
          if (item) item.click();
          return !!item;
        })()`,
      });
    }
    return false;
  }, 60000, 1000);
}

async function sendPrompt(id, text) {
  await inPanel(id, `(() => {
    const input = document.querySelector('[aria-label="Message input"]');
    // The chat first, as a click would: the app keeps a chat without the focus from taking it.
    window.focus();
    input.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, ${JSON.stringify(text)});
    return true;
  })()`);
  await until('send button', () => inPanel(id, `(() => {
    const send = document.querySelector('button[aria-label="Send message"]');
    if (!send || send.disabled) return false;
    send.click();
    return true;
  })()`), 10000, 300);
}

async function approveFirstOption(id) {
  return until('permission options', () => inPanel(id, `(() => {
    const option = [...document.querySelectorAll('button')].find((b) => /^1\\s*Yes/.test(b.innerText.trim()));
    if (!option) return false;
    option.click();
    return option.innerText.trim().replace(/\\s+/g, ' ');
  })()`), 30000, 500);
}

function run(main) {
  main().catch((error) => {
    log('FAILED', error.message);
    process.exit(1);
  });
}

// The app's t(): the text of a UI string in the language the app runs in, so that a check can
// expect it whatever the language is.
async function appText() {
  const { TRANSLATIONS } = require('../src/i18n');
  const { translator } = require('../src/i18n/translate');
  return translator(TRANSLATIONS[await call('language')]);
}

module.exports = { appText, approveFirstOption, badges, call, inPanel, log, openClaudePanel, run, sendPrompt, sleep, tabNamed, until };
