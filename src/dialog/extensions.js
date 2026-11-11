const extensionInstalledEl = document.getElementById('extension-installed');
const extensionCandidatesEl = document.getElementById('extension-candidates');
const extensionTargetEl = /** @type {HTMLSelectElement} */ (document.getElementById('extension-target'));
const extensionStatusEl = document.getElementById('extension-status');
const extensionImportEl = /** @type {HTMLButtonElement} */ (document.getElementById('extension-import'));
const extensionPermissionEl = /** @type {HTMLInputElement} */ (document.getElementById('extension-permission'));
const extensionProgressEl = document.getElementById('extension-progress');
let extensionVisible = false;
let extensionBusy = false;
let extensionRead = 0;
let availableImports = [];

function extensionNode(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function extensionButton(label, action) {
  const button = extensionNode('button', label, 'button');
  button.type = 'button';
  button.addEventListener('click', () => extensionAction(action));
  return button;
}

function extensionSelection() {
  return [.../** @type {NodeListOf<HTMLInputElement>} */ (extensionCandidatesEl.querySelectorAll('input:checked'))].map((input) => input.value);
}

function extensionControls() {
  extensionProgressEl.classList.toggle('busy', extensionBusy);
  extensionProgressEl.setAttribute('aria-hidden', String(!extensionBusy));
  extensionTargetEl.disabled = extensionBusy;
  extensionImportEl.disabled = extensionBusy || !extensionPermissionEl.checked || !extensionSelection().length;
}

// Packing a large extension folder (Codex is over 1 GB) takes a while before the update starts.
function importExtensions(keys) {
  extensionStatusEl.textContent = t('Preparing extension imports');
  extensionStatusEl.classList.remove('error');
  return window.host.extensions.import(keys, extensionTargetEl.value);
}

function renderImports(items) {
  availableImports = items;
  extensionCandidatesEl.replaceChildren(...items.map((item) => {
    const label = extensionNode('label', '', 'extension-candidate');
    const input = extensionNode('input');
    input.type = 'checkbox';
    input.value = item.key;
    const name = extensionNode('span', item.name);
    const version = extensionNode('span', `${item.version} / ${item.targetPlatform}`, 'extension-version');
    label.title = item.location;
    label.append(input, name, version);
    return label;
  }));
  if (!items.length) extensionCandidatesEl.append(extensionNode('div', t('No local extension source found.'), 'hint'));
  extensionControls();
}

function renderExtensionState(data) {
  const selected = extensionTargetEl.value || data.target;
  extensionTargetEl.replaceChildren(...data.targets.map((target) => {
    const option = extensionNode('option', target === data.targets[0] ? t('This computer ({target})', { target }) : t('WSL ({target})', { target }));
    option.value = target;
    return option;
  }));
  extensionTargetEl.value = selected;
  document.getElementById('extension-code-server').textContent = `code-server ${data.codeServerVersion}`;
  document.getElementById('extension-update').hidden = data.update?.status !== 'available';
  extensionInstalledEl.replaceChildren(...data.rows.map((item) => {
    const row = extensionNode('tr');
    const name = extensionNode('td', item.name);
    name.title = item.id;
    const source = extensionNode('td', item.source);
    source.title = item.location;
    const version = extensionNode('td', item.version ? (item.prepared ? t('Prepared: {version}', { version: item.version }) : item.version) : t('Not installed'));
    if (item.newer) version.append(extensionNode('div', t('Available: {version}', { version: item.newer }), 'extension-newer'));
    const actions = extensionNode('td', '', 'extension-row-actions');
    if (item.newer) actions.append(extensionButton(t('Re-import'), async () => {
      const candidate = availableImports.find((entry) => entry.id === item.id && entry.version === item.newer);
      if (!candidate) throw new Error(t('Refresh the extension list before importing.'));
      if (!extensionPermissionEl.checked) throw new Error(t('Confirm permission before importing.'));
      return importExtensions([candidate.key]);
    }));
    // Takes the newest release from Open VSX; the current version stays as the previous one.
    if (item.openVsx) actions.append(extensionButton(t('Use Open VSX'), () => window.host.extensions.openVsx(item.id, extensionTargetEl.value)));
    if (item.previous) actions.append(extensionButton(t('Restore previous'), () => window.host.extensions.rollback(item.id, extensionTargetEl.value)));
    actions.append(extensionButton(t('Official page'), () => window.host.extensions.page(item.id)));
    row.append(name, source, version, actions);
    return row;
  }));
  renderImports(data.candidates);
  extensionStatusEl.textContent = data.errors.join('\n');
  extensionStatusEl.classList.toggle('error', Boolean(data.errors.length));
}

async function refreshExtensions(check = false) {
  const read = ++extensionRead;
  extensionStatusEl.textContent = t('Checking extensions');
  let result;
  try {
    result = check ? await window.host.extensions.check(extensionTargetEl.value || undefined) : await window.host.extensions.list(extensionTargetEl.value || undefined);
  } catch (error) {
    if (!extensionVisible || read !== extensionRead) return;
    throw error;
  }
  if (!extensionVisible || read !== extensionRead) return;
  if (result.error) throw new Error(result.error);
  renderExtensionState(result);
  if (check && !result.errors.length && result.update?.status !== 'available') extensionStatusEl.textContent = t('No updates found in the configured sources.');
}

async function extensionAction(action) {
  if (extensionBusy) return;
  extensionBusy = true;
  const dialog = settingsDialog;
  extensionControls();
  try {
    const result = await action();
    if (result?.error) throw new Error(result.error);
    if (extensionVisible && result?.queued && settingsDialog === dialog) window.host.answer(dialog.id, 1, false);
  } catch (error) {
    if (extensionVisible && settingsDialog === dialog) {
      extensionStatusEl.textContent = error.message;
      extensionStatusEl.classList.add('error');
    }
  } finally {
    extensionBusy = false;
    extensionControls();
  }
}

function showExtensionManager() {
  extensionVisible = true;
  extensionPermissionEl.checked = false;
  // Reads have their own generation guard; reopening must not wait on an older read.
  refreshExtensions().catch((error) => {
    if (extensionVisible) { extensionStatusEl.textContent = error.message; extensionStatusEl.classList.add('error'); }
  });
}

function hideExtensionManager() {
  extensionVisible = false;
  extensionRead++;
}

extensionTargetEl.addEventListener('change', () => extensionAction(() => refreshExtensions()));
extensionCandidatesEl.addEventListener('change', extensionControls);
extensionPermissionEl.addEventListener('change', extensionControls);
document.getElementById('extension-refresh').addEventListener('click', () => extensionAction(() => refreshExtensions()));
document.getElementById('extension-open-code').addEventListener('click', () => extensionAction(() => window.host.extensions.openCode()));
document.getElementById('extension-check').addEventListener('click', () => extensionAction(() => refreshExtensions(true)));
document.getElementById('extension-update').addEventListener('click', () => extensionAction(() => window.host.extensions.update()));
for (const [id, kind] of [['extension-browse', 'vscode'], ['extension-vsix', 'vsix']]) {
  document.getElementById(id).addEventListener('click', () => extensionAction(async () => {
    const result = await window.host.extensions.browse(kind);
    if (result.error) throw new Error(result.error);
    if (result.candidates.length) renderImports([...availableImports, ...result.candidates]);
  }));
}
extensionImportEl.addEventListener('click', () => extensionAction(() => importExtensions(extensionSelection())));
