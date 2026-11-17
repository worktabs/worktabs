const { reactAncestors, reactElementProps, webviewReactScript } = require('../conversations/webview-react');

// Use the extension's permission picker, including its availability checks and mode mapping.
// There is no public chatgpt setting for this preference. Unknown picker shapes fail closed;
// Worktabs never sends a reviewer enum to the app-server or edits the user's Codex config.
function normalizeCodexApproval(value) {
  return value === 'manual' ? 'manual' : 'auto-review';
}

// These functions also run in the extension's webview. Keep them independent of Electron.
function pickerProbe(trigger) {
  try {
    const found = reactAncestors(trigger);
    if (!found.available) return found;
    let picker = null, context = null;
    for (const props of found.props) {
      if (!picker && props?.triggerButton) picker = props;
      if (picker && props && Object.hasOwn(props, 'conversationId') && Object.hasOwn(props, 'hostId')) { context = props; break; }
    }
    if (!picker || !context) return { available: false, reason: 'unknown-picker' };
    let unavailable = null;
    const nodes = (value) => {
      const found = reactElementProps(value);
      if (!found.available) unavailable = found.reason;
      return found.available ? found.props : [];
    };
    const labels = {
      'composer.permissionsDropdown.default.approvalOptionLabel': 'manual',
      'composer.permissionsDropdown.default.shortLabel': 'manual',
      'composer.permissionsDropdown.guardianApproval.optionLabel': 'auto-review',
      'composer.permissionsDropdown.guardianApproval.triggerLabel': 'auto-review',
    };
    const mode = (selection) => selection?.kind === 'agent-mode'
      ? ({ auto: 'manual', granular: 'manual', 'read-only': 'manual', 'guardian-approvals': 'auto-review' })[selection.agentMode]
      : undefined;
    const triggerNodes = nodes(picker.triggerButton);
    const selectionNode = triggerNodes.find((props) => props.selectedPermissionSelection || props.permissionSelection);
    const selection = selectionNode?.selectedPermissionSelection || selectionNode?.permissionSelection;
    const current = selection ? mode(selection) : triggerNodes.map((props) => labels[props.id]).find(Boolean);
    const options = {};
    for (const props of nodes(picker.children)) {
      if (props.selection && typeof props.selectPermission === 'function') {
        const choice = mode(props.selection.permissionSelection);
        if (choice) options[choice] = {
          disabled: props.selection.disabledReason !== null,
          select: () => props.selectPermission(props.selection.permissionSelection),
        };
      } else if (typeof props.onClick === 'function' && typeof props.disabled === 'boolean') {
        const choice = nodes(props.children).map((child) => labels[child.id]).find(Boolean);
        if (choice) options[choice] = { disabled: props.disabled, select: props.onClick };
      }
    }
    if (unavailable) return { available: false, reason: unavailable };
    return { available: true, snapshot: {
      conversationId: context.conversationId, hostId: context.hostId,
      loading: picker.disabled === true || trigger.disabled === true,
      current, options,
    } };
  } catch { return { available: false, reason: 'unreadable-probe' }; }
}

function pickerSnapshot(trigger) {
  const found = pickerProbe(trigger);
  return found.available ? found.snapshot : null;
}

/** @typedef {{ mode?: string, reason?: string }} CodexApprovalResult */

/** @returns {Promise<CodexApprovalResult>} */
async function applyCodexApproval(snapshot, preference) {
  if (!snapshot) return { reason: 'unknown-picker' };
  if (snapshot.hostId !== 'local') return { reason: 'other-host' };
  if (snapshot.conversationId !== null) return { reason: 'existing-conversation' };
  if (snapshot.loading) return { reason: 'loading' };
  // Full Access and custom profiles are explicit choices. Do not replace them on reopen.
  if (!snapshot.current) return { reason: 'explicit-or-unknown-mode' };
  if (snapshot.current === preference) return { mode: preference };
  const option = snapshot.options[preference];
  if (!option || option.disabled) return { mode: snapshot.current, reason: option ? 'restricted' : 'unavailable' };
  try {
    await option.select();
    // A later snapshot must confirm the selection before it is reported as effective.
    return { reason: 'selected' };
  } catch {
    return { mode: snapshot.current, reason: 'selection-failed' };
  }
}

function watchCodexApproval(preference, snapshotOf, apply, environment) {
  const { document, MutationObserver, setTimeout, clearTimeout } = environment;
  const now = environment.now || Date.now;
  const previous = environment.worktabsCodexApproval;
  previous?.dispose();
  let timer = null, busy = false, stopped = false, active = null, conversationId, hostId;
  let deadline = 0, handled = false, selected = false, selectedPreference = null, interaction = null;
  const state = { preference, result: /** @type {CodexApprovalResult} */ ({ reason: 'loading' }), dispose,
    setPreference(value) { preference = value; state.preference = value; } };
  environment.worktabsCodexApproval = state;
  const schedule = () => {
    if (!stopped && timer === null) timer = setTimeout(check, 100);
  };
  const visible = (element) => element.isConnected !== false &&
    element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
  const visibleTrigger = () => {
    const triggers = [...document.querySelectorAll('[data-composer-navigation-target="permissions"]')].filter(visible);
    // Retained hidden chats are not candidates, and two visible pickers are ambiguous.
    return triggers.length === 1 ? triggers[0] : null;
  };
  const read = (trigger) => {
    try { return snapshotOf(trigger); } catch { return null; }
  };
  const sameContext = (a, b) => a && b ? a.conversationId === b.conversationId && a.hostId === b.hostId : a === b;
  const touched = (event) => {
    if (!event.isTrusted) return;
    const trigger = visibleTrigger();
    if (!trigger || !trigger.contains(event.target)) return;
    if (event.type === 'keydown' && !['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    // Opening the permission picker is an explicit choice. Typing in the chat is not.
    interaction = { trigger, snapshot: read(trigger) };
    handled = true;
    state.result = { reason: 'user-choice' };
  };
  async function check() {
    timer = null;
    if (stopped || busy) return;
    const trigger = visibleTrigger();
    if (!trigger) return;
    const snapshot = read(trigger);
    const retainedSwitch = active && active !== trigger && active.isConnected !== false && !visible(active);
    // Layout changes can replace the button without starting another conversation. Keep an
    // explicit choice across that replacement; only a thread transition resets setup.
    if (!active || retainedSwitch || (snapshot && (conversationId !== snapshot.conversationId || hostId !== snapshot.hostId))) {
      conversationId = snapshot?.conversationId;
      hostId = snapshot?.hostId;
      deadline = now() + 10000;
      handled = Boolean(interaction && (interaction.trigger === trigger || !retainedSwitch) &&
        (interaction.snapshot && snapshot ? sameContext(interaction.snapshot, snapshot) : interaction.trigger === trigger));
      if (handled && !interaction.snapshot) interaction.snapshot = snapshot;
      selected = false;
    }
    active = trigger;
    if (handled) return;
    if (selected) {
      if (snapshot?.current === selectedPreference) state.result = { mode: selectedPreference };
      else if (now() < deadline) { schedule(); return; }
      else state.result = { mode: snapshot?.current, reason: 'selection-failed' };
      handled = true;
      return;
    }
    busy = true;
    try {
      const result = await apply(snapshot, preference);
      if (stopped || handled) return;
      // A selection can finish after another retained composer becomes visible.
      if (visibleTrigger() !== trigger || !sameContext(read(trigger), snapshot)) { schedule(); return; }
      state.result = result;
      if (state.result.reason === 'loading' && now() < deadline) schedule();
      else if (state.result.reason === 'loading') {
        state.result = { mode: snapshot?.current, reason: 'loading-timeout' };
        handled = true;
      }
      else if (state.result.reason === 'selected') { selected = true; selectedPreference = preference; schedule(); }
      else handled = true;
    } finally { busy = false; }
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  document.addEventListener('pointerdown', touched, true);
  document.addEventListener('keydown', touched, true);
  function dispose() {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    observer.disconnect();
    document.removeEventListener('pointerdown', touched, true);
    document.removeEventListener('keydown', touched, true);
  }
  schedule();
  return true;
}

function codexApprovalScript(preference) {
  return webviewReactScript(`const pickerProbe = ${pickerProbe}; const pickerSnapshot = ${pickerSnapshot}; return (${watchCodexApproval})(${JSON.stringify(normalizeCodexApproval(preference))}, pickerSnapshot, ${applyCodexApproval}, window);`);
}

module.exports = { normalizeCodexApproval, pickerProbe, pickerSnapshot, applyCodexApproval, watchCodexApproval, codexApprovalScript };
