// The card at the top of the side bar for updates of code-server and the extensions: what is
// offered or going on, with its buttons. Made again from the update's state on every render.

// One sweep of the update card's progress bar (its animation in sidebar.css).
const PROGRESS_CYCLE_MS = 1400;

// The bar of an update in progress, for this card and Worktabs' own (app-update-card.js).
// `progress`, the part done from 0 to 1, is known only while a download whose size is known
// runs, and fills the bar. Other steps report nothing (the installer reports no percentage), so
// the bar sweeps, showing only that the update is still going. Every state push redraws the card;
// the sweep's phase follows the clock, so it does not jump back.
/** @param {{ el: Function, t: Function, progress?: number | null, clock?: () => number }} options */
function updateProgressBar({ el, t, progress = null, clock = Date.now }) {
  const known = typeof progress === 'number' && Number.isFinite(progress);
  const bar = el('div', known ? 'update-progress determinate' : 'update-progress');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', t('In progress'));
  if (known) {
    const percent = Math.round(Math.min(Math.max(progress, 0), 1) * 100);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(percent));
    bar.style.setProperty('--done', `${percent}%`);
  } else {
    bar.style.setProperty('--phase', `${-(clock() % PROGRESS_CYCLE_MS)}ms`);
  }
  return bar;
}

function createUpdateCard({ element, host, dom, t, listText, clock = Date.now }) {
  const { el } = dom;
  const titles = {
    available: t('Update available'),
    preparing: t('Preparing the update'),
    waiting: t('Updates when the working tabs finish'),
    applying: t('Updating'),
    done: t('Updated'),
    failed: t('Could not update'),
  };

  function textButton(label, className, onClick) {
    const button = el('button', className, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  function render(update) {
    element.hidden = !update || update.status === 'none';
    if (element.hidden) {
      element.replaceChildren();
      return;
    }
    const { status, items } = update;
    const head = el('div', 'update-head');
    head.append(el('span', 'update-title', titles[status]));
    if (['available', 'done', 'failed'].includes(status)) {
      const close = textButton('×', 'close', () => host.dismissUpdate());
      close.title = t('Close');
      head.append(close);
    }
    const list = el('ul', 'update-items');
    for (const item of items) {
      const row = el('li');
      row.append(el('span', 'name', item.name), el('span', 'detail', status === 'done' ? item.to : `${item.from} → ${item.to}`));
      list.append(row);
    }
    const parts = [head];
    if (['preparing', 'applying'].includes(status)) parts.push(updateProgressBar({ el, t, progress: update.progress, clock }));
    parts.push(list);
    const detail = status === 'waiting' ? [t('Waiting for: {tabs}', { tabs: listText(update.busy) }), update.detail].filter(Boolean).join('\n') : update.detail;
    if (detail) parts.push(el('p', 'update-detail', detail));
    // Settings > Extensions has the sources, the versions, and restoring a previous one; the gear
    // opens it too, so the card links there only when an update needs a look.
    const extensions = () => textButton(t('Extensions and updates'), 'text-button', () => host.showExtensions());
    if (status === 'available') {
      const actions = el('div', 'update-actions');
      actions.append(
        textButton(t('Update'), 'text-button primary', () => host.startUpdate()),
        textButton(t('Later'), 'text-button', () => host.dismissUpdate()),
        extensions(),
      );
      parts.push(actions);
    } else if (status === 'waiting') {
      const actions = el('div', 'update-actions');
      actions.append(textButton(t('Cancel the update'), 'text-button', () => host.cancelUpdate()));
      parts.push(actions);
    } else if (status === 'failed') {
      const actions = el('div', 'update-actions');
      actions.append(extensions());
      parts.push(actions);
    }
    element.className = `update ${status}`;
    element.replaceChildren(...parts);
  }

  return { render };
}

if (typeof module === 'object') module.exports = { PROGRESS_CYCLE_MS, createUpdateCard, updateProgressBar };
