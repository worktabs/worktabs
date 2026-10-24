// Tries new versions of code-server and the extensions before any tab restarts on them: starts
// code-server on an empty folder in a hidden view and checks what the tabs rely on. The view, the
// server manager and the session cookie are injected.
const fs = require('fs');
const path = require('path');
const { t, listText } = require('../i18n');
const { codexChatFrames } = require('../conversations/chat-frames');
const { CHAT_STARTED_SCRIPT } = require('../conversations/chat-startup');
const { folderUrl } = require('./code-server');
const { sleep: wait } = require('../util');

// The code-server instance that tries out new versions.
const UPDATE_PROBE_ID = 'update-check';

const CODEX_EXTENSION = 'openai.chatgpt';

const WORKBENCH_SCRIPT = `({
  login: /\\/login\\/?$/.test(location.pathname),
  workbench: !!document.querySelector('.monaco-workbench'),
  title: document.title,
  explorer: document.querySelector('.activitybar .action-item a')?.getAttribute('aria-label') || '',
})`;

// Waits until the page shows VS Code with `folderName` open, in the display language set.
// Throws with what went wrong.
/**
 * @param {import('electron').WebContents} contents
 * @param {string} folderName
 * @param {{ locale?: string, timeout?: number, sleep?: (ms: number) => Promise<any>, now?: () => number }} [options]
 */
async function waitForWorkbench(contents, folderName, { locale, timeout = 60000, sleep = wait, now = Date.now } = {}) {
  const deadline = now() + timeout;
  for (;;) {
    const page = await contents.executeJavaScript(WORKBENCH_SCRIPT).catch(() => null);
    if (page?.login) throw new Error(t('The login page appeared (code-server may have changed how it authenticates)'));
    // The window title shows the open folder's name. With a display language set, the
    // Explorer's label should not be the English one (languagepacks.json was not understood).
    const opened = page?.workbench && page.title.includes(folderName);
    const english = locale !== 'en' && /^Explorer\b/.test(page?.explorer || '');
    if (opened && !english) return;
    if (now() > deadline) {
      if (english) throw new Error(t('The display language did not become {locale} (the way language packs load may have changed)', { locale }));
      throw new Error(page?.workbench ? t('The folder did not open (title: {title})', { title: page.title }) : t('VS Code did not appear within 60 seconds'));
    }
    await sleep(500);
  }
}

// Waits until the extensions that activate at startup have, in the instance's log since `since`.
async function waitForActivation(manager, instanceId, since, expected, { timeout = 60000, sleep = wait, now = Date.now } = {}) {
  const deadline = now() + timeout;
  for (;;) {
    const { activated, failed } = manager.extensionActivation(instanceId, since);
    const broken = expected.find((id) => failed.has(id));
    if (broken) throw new Error(t('The extension {id} failed to start', { id: broken }));
    const missing = expected.filter((id) => !activated.has(id));
    if (!missing.length) return;
    if (now() > deadline) throw new Error(t('The extensions {ids} did not start within 60 seconds', { ids: listText(missing) }));
    await sleep(1000);
  }
}

// What `promise` resolves, or `fallback` once `ms` have passed: a page whose main thread is stuck
// never answers.
function within(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(resolve, ms, fallback); }),
  ]).finally(() => clearTimeout(timer));
}

// Waits until the Codex chat in the side bar has started. code-server keeps a webview in the
// workbench's page, so a chat that never finishes starting can stop the whole VS Code from
// answering (Codex 26.1021.22027 preloads 3,203 modules before it starts). `answerTimeout`: how
// long the page may take to answer before it counts as stuck.
/**
 * @param {import('electron').WebContents} contents
 * @param {{ timeout?: number, answerTimeout?: number, sleep?: (ms: number) => Promise<any>, now?: () => number }} [options]
 */
async function waitForCodexChat(contents, { timeout = 60000, answerTimeout = 10000, sleep = wait, now = Date.now } = {}) {
  const deadline = now() + timeout;
  for (;;) {
    if (!(await within(contents.executeJavaScript('true'), answerTimeout, false))) {
      throw new Error(t('VS Code stopped responding while the Codex chat started'));
    }
    for (const frame of codexChatFrames(contents)) {
      // The check the tabs make (chat-startup.js): React's own elements in #root.
      if (await within(frame.executeJavaScript(CHAT_STARTED_SCRIPT), answerTimeout, false)) return;
    }
    if (now() > deadline) throw new Error(t('The Codex chat did not start within 60 seconds'));
    await sleep(1000);
  }
}

// `hiddenView`: makes a hidden view in the window, with `close()` to take it away. `reserved`:
// the ports the tabs keep (TabPorts.reserved). `connect`: sets the instance's session cookie.
// `startupExtensions`: those of the extensions that activate at startup (updates.js). `timing`:
// { sleep, now, answerTimeout } for the waits.
function createUpdateProbe({ dataDir, config, servers, hiddenView, reserved, connect, clearPortStorage, startupExtensions, timing = {} }) {
  // Throws with what went wrong. `extraIds`: extensions to expect besides those configured.
  // `codex`: also start the Codex chat, if Codex is installed. By default only when the
  // extensions tried out include Codex, so that a Codex that does not start leaves unrelated
  // updates alone.
  return async function probeInstance(extraIds = [], { codex: tryCodex = extraIds.some((id) => id.toLowerCase() === CODEX_EXTENSION) } = {}) {
    const folder = path.join(dataDir, UPDATE_PROBE_ID);
    fs.mkdirSync(folder, { recursive: true });
    const manager = servers();
    // The new versions are installed by now.
    const expected = startupExtensions(config.resolvedExtensionsDir, [...new Set([...config.resolvedExtensions, ...extraIds])]);
    const codex = tryCodex && expected.includes(CODEX_EXTENSION);
    const view = hiddenView();
    const since = Date.now();
    let port = 0;
    try {
      // Not on a tab's port, whose VS Code state it would write to. Codex opens its chat itself
      // here, as the tabs leave that to Worktabs.
      let cookie;
      ({ port, cookie } = await manager.start(UPDATE_PROBE_ID, folder, 0, {
        avoid: reserved(UPDATE_PROBE_ID), settings: codex ? { 'chatgpt.openOnStartup': true } : {},
      }));
      await connect(port, cookie);
      view.webContents.loadURL(folderUrl(port, folder)).catch(() => {});
      await waitForWorkbench(view.webContents, path.basename(folder), { locale: config.resolvedLocale, ...timing });
      await waitForActivation(manager, UPDATE_PROBE_ID, since, expected, timing);
      if (codex) await waitForCodexChat(view.webContents, timing);
    } finally {
      view.close();
      // While its code-server still holds the port, so that no tab takes it meanwhile.
      if (port) await clearPortStorage([port]);
      manager.stop(UPDATE_PROBE_ID);
    }
  };
}

module.exports = { UPDATE_PROBE_ID, createUpdateProbe, waitForActivation, waitForCodexChat, waitForWorkbench };
