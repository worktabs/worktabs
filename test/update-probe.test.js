const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UPDATE_PROBE_ID, createUpdateProbe, waitForActivation, waitForCodexChat, waitForWorkbench } = require('../src/code-server/update-probe');

// A clock that moves on as the waits sleep.
function clock() {
  let at = 0;
  return { now: () => at, sleep: async (ms) => { at += ms; } };
}

const pageOf = (answers) => {
  let i = 0;
  return { executeJavaScript: async () => answers[Math.min(i++, answers.length - 1)] };
};

test('the workbench is ready once it shows the folder, in the display language', async () => {
  const workbench = { workbench: true, title: 'probe - Visual Studio Code', explorer: 'エクスプローラー' };
  await waitForWorkbench(pageOf([null, { workbench: false, title: '' }, workbench]), 'probe', { locale: 'ja', ...clock() });
  await assert.rejects(waitForWorkbench(pageOf([{ login: true }]), 'probe', { locale: 'en', ...clock() }), /login page/);
  await assert.rejects(waitForWorkbench(pageOf([{ ...workbench, explorer: 'Explorer' }]), 'probe', { locale: 'ja', ...clock() }), /did not become ja/);
  await assert.rejects(waitForWorkbench(pageOf([{ ...workbench, title: 'Welcome' }]), 'probe', { locale: 'en', ...clock() }), /did not open/);
  await assert.rejects(waitForWorkbench(pageOf([null]), 'probe', { locale: 'en', ...clock() }), /did not appear/);
});

test('the startup extensions must activate, and one that fails says which', async () => {
  const log = (activated, failed = []) => ({ extensionActivation: () => ({ activated: new Set(activated), failed: new Set(failed) }) });
  await waitForActivation(log(['a.b', 'c.d']), 'id', 0, ['a.b'], clock());
  await assert.rejects(waitForActivation(log([], ['a.b']), 'id', 0, ['a.b'], clock()), /a\.b failed to start/);
  await assert.rejects(waitForActivation(log(['a.b']), 'id', 0, ['a.b', 'c.d'], clock()), /c\.d did not start/);
});

// A page with Codex chat frames (chat-frames.js finds them by their host frame's extensionId).
const WEBVIEW = 'http://127.0.0.1:4100/stable-1/static/out/vs/workbench/contrib/webview/browser/pre/index.html';
const never = () => new Promise(() => {});
function codexPage(frames, { answers = true } = {}) {
  const host = { url: `${WEBVIEW}?id=1&extensionId=openai.chatgpt` };
  return {
    executeJavaScript: async () => answers ? true : never(),
    mainFrame: { framesInSubtree: [host, ...frames.map((executeJavaScript) => ({ url: `${WEBVIEW}?id=1`, parent: host, executeJavaScript }))] },
  };
}

test('the Codex chat has started once a Codex frame shows what React rendered', async () => {
  const options = { answerTimeout: 5, ...clock() };
  let polls = 0;
  await waitForCodexChat(codexPage([never, async () => ++polls > 2]), options);
  assert.equal(polls, 3);
  await assert.rejects(waitForCodexChat(codexPage([async () => false]), options), /Codex chat did not start within 60 seconds/);
  await assert.rejects(waitForCodexChat(codexPage([]), options), /did not start/);
  await assert.rejects(waitForCodexChat(codexPage([never], { answers: false }), options), /stopped responding/);
});

test('the probe opens the Codex chat and waits for it only when Codex is expected', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktabs-probe-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const starts = [];
  let page;
  const probe = createUpdateProbe({
    dataDir, config: { resolvedLocale: 'en', resolvedExtensions: ['a.b', 'OpenAI.chatgpt'], resolvedExtensionsDir: '/ext' },
    servers: () => ({
      start: async (id, folder, port, options) => { starts.push(options.settings); return { port: 4100, cookie: {} }; },
      stop: () => {},
      extensionActivation: () => ({ activated: new Set(['a.b', 'openai.chatgpt']), failed: new Set() }),
    }),
    reserved: () => [], startupExtensions: (dir, ids) => ids.map((id) => id.toLowerCase()),
    timing: { answerTimeout: 5, ...clock() }, connect: async () => {}, clearPortStorage: async () => {},
    hiddenView: () => ({
      webContents: {
        loadURL: async () => {},
        executeJavaScript: async (script) => script === 'true' || { workbench: true, title: `${UPDATE_PROBE_ID} - VS Code`, explorer: 'Explorer' },
        get mainFrame() { return page.mainFrame; },
      },
      close: () => {},
    }),
  });
  page = codexPage([async () => true]);
  await probe(['OpenAI.chatgpt']);
  page = codexPage([async () => false]);
  await assert.rejects(probe(['OpenAI.chatgpt']), /Codex chat did not start/);
  // A Codex that does not start is left alone unless the update can change it (code-server).
  await probe();
  await probe([], { codex: false });
  await assert.rejects(probe([], { codex: true }), /Codex chat did not start/);
  const open = { 'chatgpt.openOnStartup': true };
  assert.deepEqual(starts, [open, open, {}, {}, open]);
});

test('the probe runs off the tabs\' ports and cleans up after itself, also when it fails', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktabs-probe-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  const manager = {
    start: async (id, folder, port, options) => { calls.push(['start', id, path.basename(folder), options.avoid]); return { port: 4100, cookie: { name: 'key' } }; },
    stop: (id) => calls.push(['stop', id]),
    extensionActivation: () => ({ activated: new Set(['a.b']), failed: new Set() }),
  };
  const probe = createUpdateProbe({
    dataDir, config: { resolvedLocale: 'en', resolvedExtensions: ['a.b'], resolvedExtensionsDir: '/ext' },
    servers: () => manager, reserved: () => [4000], startupExtensions: (dir, ids) => ids,
    timing: clock(),
    connect: async (port, cookie) => calls.push(['connect', port, cookie.name]),
    clearPortStorage: async (ports) => calls.push(['clear', ports]),
    hiddenView: () => ({
      webContents: {
        loadURL: async (url) => calls.push(['load', new URL(url).port]),
        executeJavaScript: async () => ({ workbench: true, title: `${UPDATE_PROBE_ID} - VS Code`, explorer: 'Explorer' }),
      },
      close: () => calls.push(['close']),
    }),
  });
  await probe();
  assert.deepEqual(calls, [['start', UPDATE_PROBE_ID, UPDATE_PROBE_ID, [4000]], ['connect', 4100, 'key'], ['load', '4100'], ['close'], ['clear', [4100]], ['stop', UPDATE_PROBE_ID]]);
  calls.length = 0;
  await assert.rejects(probe(['x.y']), /x\.y did not start/);
  assert.deepEqual(calls.slice(-3), [['close'], ['clear', [4100]], ['stop', UPDATE_PROBE_ID]]);
});
