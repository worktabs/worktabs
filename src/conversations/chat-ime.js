// Keeps the IME usable in the agents' chats (issue #86). The chats run in frames on sites of their
// own (tab-preload.js), and Chromium 156 (Electron 45) can leave such a frame's input field without
// the IME: its TextInputManager stores an input state that arrives while the browser does not count
// the frame as focused, without making it active (cfa51540e4, "Validate view focus before updating
// TextInputManager active view"). Once the frame has the focus, later updates with the same field,
// type, and flags do not count as changes, so the browser does not hand the field to the IME again.
// Typing works but the IME-on key does nothing, until the focus moves to another field and back.
// Chromium fixed it in d4c2706438 and 0250f19391, which Electron 45 does not have and Electron 46
// (Chromium 160) does; remove this once the app runs an Electron with both (issue #90).
//
// A moment after a chat's frame or one of its fields gets the focus, and when an IME key reaches the
// page instead of the IME, the field's autocomplete attribute flips for one frame. Chromium sends
// the field's input state again for the flip and for the flip back, each with other flags, so the
// browser takes the field as active and hands it to the IME. The focus and the text do not move.

// Runs in the chat's frame: keep it independent of Electron and of this module's scope.
// `window`: the frame's window (a fake in the tests). Returns false when already installed.
/** @param {any} window */
function resyncImeOnFocus(window, delay = 100) {
  if (window.worktabsImeResync) return false;
  window.worktabsImeResync = true;
  const { document } = window;
  // Keys that switch an IME on or off, as KeyboardEvent names them on Windows and macOS. One that
  // reaches the page as a key of its own (not 229, "Process") was not taken by an IME.
  const imeKeys = ['Convert', 'NonConvert', 'KanaMode', 'KanjiMode', 'Hiragana', 'Katakana', 'HiraganaKatakana',
    'Zenkaku', 'Hankaku', 'ZenkakuHankaku', 'Romaji', 'Alphanumeric', 'Eisu', 'HangulMode', 'HanjaMode'];
  const imeCodes = ['Convert', 'NonConvert', 'KanaMode', 'Lang1', 'Lang2'];
  const textInputs = ['text', 'search', 'url', 'email', 'tel'];
  let timer = null;
  let composing = false;
  // Puts the flipped attribute back; set while a flip is in progress.
  let restore = null;
  const editable = (element) => Boolean(element) && (element.isContentEditable === true || element.tagName === 'TEXTAREA' ||
    (element.tagName === 'INPUT' && textInputs.includes(element.type)));
  const resync = () => {
    timer = null;
    const element = document.activeElement;
    // Mid-composition, the IME already has the field, and a flag change could end the composition.
    if (restore || composing || !document.hasFocus() || !editable(element)) return;
    const before = element.getAttribute('autocomplete');
    element.setAttribute('autocomplete', String(before).toLowerCase() === 'off' ? 'on' : 'off');
    restore = () => {
      restore = null;
      if (before === null) element.removeAttribute('autocomplete');
      else element.setAttribute('autocomplete', before);
    };
    // Chromium sends the state at the end of the next frame; the attribute goes back after it, or
    // after a composition that started meanwhile.
    window.requestAnimationFrame(() => window.setTimeout(() => {
      if (restore && !composing) restore();
    }, 0));
  };
  const schedule = (wait) => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(resync, wait);
  };
  // Focus events do not bubble, but a capturing listener on the window sees the window's own and
  // each field's. The wait lets the browser take in the focus change first.
  window.addEventListener('focus', () => schedule(delay), true);
  window.addEventListener('compositionstart', () => { composing = true; }, true);
  window.addEventListener('compositionend', () => {
    composing = false;
    if (restore) restore();
  }, true);
  // In case the focus came without an event here: the key is lost, and the next press works.
  window.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.isComposing || event.keyCode === 229) return;
    if (!imeKeys.includes(event.key) && !imeCodes.includes(event.code)) return;
    if (editable(document.activeElement)) schedule(0);
  }, true);
  return true;
}

// The script each agent chat's frame gets as it loads (tab-view.js).
const CHAT_IME_RESYNC = `(${resyncImeOnFocus})(window)`;

module.exports = { CHAT_IME_RESYNC, resyncImeOnFocus };
