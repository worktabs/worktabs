// The card at the top of the side bar for a new version of Worktabs itself (self-update.js in the
// main process): what is offered or going on, with its buttons. It looks like the update card of
// code-server and the extensions. Made again from the state on every render.

function createAppUpdateCard({ element, host, dom, t, listText, clock = Date.now }) {
  const { el } = dom;

  function title(update) {
    const { version } = update;
    switch (update.status) {
      case 'available': return t('Worktabs {version} is available', { version });
      case 'downloading': return t('Downloading Worktabs {version}', { version });
      case 'ready': return t('Worktabs {version} is ready', { version });
      case 'waiting': return t('Restarts when the working tabs finish');
      case 'done': return t('Updated to Worktabs {version}', { version });
      default: return t('Could not update Worktabs');
    }
  }

  function textButton(label, className, onClick) {
    const button = el('button', className, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  function detailText(update) {
    if (update.status === 'waiting') return [t('Waiting for: {tabs}', { tabs: listText(update.busy) }), update.detail].filter(Boolean).join('\n');
    if (update.status === 'ready') return t('It installs when Worktabs quits.');
    if (update.status === 'available' && !update.canApply) {
      return [update.detail, t('Download it from the release page.')].filter(Boolean).join('\n');
    }
    return update.detail;
  }

  function buttons(update) {
    const notes = (label = t('Release notes')) => textButton(label, 'text-button', () => host.openAppReleaseNotes());
    switch (update.status) {
      case 'available':
        return update.canApply
          ? [textButton(t('Update'), 'text-button primary', () => host.startAppUpdate()), notes(), textButton(t('Skip this version'), 'text-button', () => host.skipAppUpdate())]
          : [notes(t('Release page')), textButton(t('Skip this version'), 'text-button', () => host.skipAppUpdate())];
      case 'ready':
        return [textButton(t('Restart now'), 'text-button primary', () => host.restartAppUpdate()), notes()];
      case 'waiting':
        return [textButton(t('Cancel the restart'), 'text-button', () => host.cancelAppUpdate())];
      case 'done':
        return [notes()];
      case 'failed':
        return update.canApply
          ? [textButton(t('Try again'), 'text-button primary', () => host.startAppUpdate()), notes(t('Release page'))]
          : [notes(t('Release page'))];
      default:
        return [];
    }
  }

  function render(update) {
    element.hidden = !update || update.status === 'none';
    if (element.hidden) {
      element.replaceChildren();
      return;
    }
    const { status } = update;
    const head = el('div', 'update-head');
    head.append(el('span', 'update-title', title(update)));
    if (['available', 'done', 'failed'].includes(status)) {
      const close = textButton('×', 'close', () => host.dismissAppUpdate());
      close.title = t('Close');
      head.append(close);
    }
    const parts = [head];
    if (status === 'downloading') {
      const bar = el('div', 'update-progress');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', t('In progress'));
      // The phase follows the clock, so a redraw does not make the bar jump back (update-card.js).
      bar.style.setProperty('--phase', `${-(clock() % 1400)}ms`);
      parts.push(bar);
    }
    if (update.from && status !== 'done') {
      const list = el('ul', 'update-items');
      const row = el('li');
      row.append(el('span', 'name', 'Worktabs'), el('span', 'detail', `${update.from} → ${update.version}`));
      list.append(row);
      parts.push(list);
    }
    const detail = detailText(update);
    if (detail) parts.push(el('p', 'update-detail', detail));
    const actions = buttons(update);
    if (actions.length) {
      const row = el('div', 'update-actions');
      row.append(...actions);
      parts.push(row);
    }
    element.className = `update ${status === 'downloading' ? 'preparing' : status === 'ready' ? 'available' : status}`;
    element.replaceChildren(...parts);
  }

  return { render };
}

if (typeof module === 'object') module.exports = { createAppUpdateCard };
