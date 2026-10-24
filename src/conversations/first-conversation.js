const { webviewReactScript } = require('./webview-react');
const { waitInPage } = require('./page-wait');

// The input's answers after which the task is not tried again.
const REJECTED = ['input-rejected', 'input-unconfirmed'];

// How long the task's script waits in the chat's page at most, before the app asks again: a frame
// that VS Code replaced meanwhile no longer answers.
const PAGE_WAIT = 10000;

// Use the editor's native input path only in an empty, local, new-thread composer.
// A retained history panel or a draft the user has started must never be overwritten.
function prefillCodexTask(document, prompt, propsOf) {
  const result = (reason) => ({ filled: false, reason });
  try {
    if (typeof prompt !== 'string' || !prompt) return result('empty-prompt');
    const visible = (selector) => [...document.querySelectorAll(selector)].filter((node) =>
      node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
    const pickers = visible('[data-composer-navigation-target="permissions"]');
    const editors = visible('[contenteditable="true"][role="textbox"]');
    if (pickers.length !== 1 || editors.length !== 1) return result('unknown-composer');
    const context = propsOf(pickers[0]).find((props) => props && Object.hasOwn(props, 'conversationId') && Object.hasOwn(props, 'hostId'));
    if (context?.hostId !== 'local' || context.conversationId !== null || pickers[0].disabled) return result('existing-conversation');
    const editor = editors[0];
    if (editor.innerText.trim()) return result('existing-draft');
    editor.focus();
    const selection = document.getSelection();
    if (document.activeElement !== editor || !selection) return result('unfocused-editor');
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    if (!editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return result('unfocused-editor');
    if (!document.execCommand('insertText', false, prompt)) return result('input-rejected');
    return editor.innerText.replace(/\r\n/g, '\n').trimEnd() === prompt.replace(/\r\n/g, '\n').trimEnd()
      ? { filled: true } : result('input-unconfirmed');
  } catch { return result('unavailable'); }
}

// Waits in the chat's page, for up to `wait` milliseconds, until its composer is ready for the
// task and puts the task in (prefillCodexTask), or the input rejects it. Resolves the last result.
function codexTaskScript(prompt, wait = PAGE_WAIT) {
  return webviewReactScript(`const propsOf = (node) => { const found = reactAncestors(node); return found.available ? found.props : []; };
    return (${waitInPage})(() => (${prefillCodexTask})(document, ${JSON.stringify(prompt)}, propsOf),
      (result) => Boolean(result?.filled || ${JSON.stringify(REJECTED)}.includes(result?.reason)), ${wait}, window);`);
}

// How long the Codex chat has to show its composer for the task. The helper opens the new
// conversation as soon as the tab's extension host is up, before the chat has started: it starts
// in about 8 seconds, and in 10 or more on a busy machine (three worktrees added at once).
const COMPOSER_WAIT = 60000;

// Keep opening, bounded input retries, cancellation, and recovery testable without Electron.
// `fill(wait)`: puts the task in the chat, waiting in its page for up to `wait` milliseconds;
// resolves the result, or null when there is no chat to ask. `pause()`: until the page may have a
// chat to ask (it has loaded a frame).
async function startTaskConversation({ agent, prompt, open, fill, current, recover, pause,
  wait = COMPOSER_WAIT, now = Date.now }) {
  if (!current()) return;
  let answer;
  try { answer = await open(); } catch { answer = null; }
  if (!current()) return;
  if (agent !== 'codex') {
    if (!answer) await recover();
    return;
  }
  if (answer?.opened && !prompt) return;
  if (answer?.opened) {
    for (const end = now() + wait; now() < end;) {
      if (!current()) return;
      let result;
      try { result = await fill(Math.min(PAGE_WAIT, end - now())); } catch { result = null; }
      if (!current()) return;
      if (result?.filled) return;
      if (REJECTED.includes(result?.reason)) break;
      if (!result) await pause();
    }
  }
  if (current()) await recover();
}

module.exports = { prefillCodexTask, codexTaskScript, startTaskConversation };
