// The subscription usage at the foot of the side bar: Claude's and Codex's windows, each with
// how much of it is used, how much of it has passed, and when it resets. Keeps the provider and the meaning of the percentage
// visible, including at narrow widths.

function createUsageFooter({ element, dom, t }) {
  const { el } = dom;

  // `usage` is the state's { usage, claudeUsage, codexUsage }.
  function render({ usage, claudeUsage, codexUsage }) {
    const providers = [];
    if (claudeUsage) providers.push({ name: t('Claude'), ...claudeUsage });
    else if (usage.length) providers.push({ name: t('Claude'), windows: usage });
    if (codexUsage) providers.push({ name: t('Codex'), ...codexUsage });
    element.hidden = !providers.length;
    element.replaceChildren(...providers.map((provider) => {
      const group = el('section', 'usage-provider');
      group.title = provider.title || '';
      group.append(el('div', 'usage-heading', t('{provider} · Used', { provider: provider.name })));
      if (provider.status) group.append(el('div', 'usage-status', provider.status));
      const multipleBuckets = new Set(provider.windows.map((window) => window.bucket).filter(Boolean)).size > 1;
      let bucket;
      for (const window of provider.windows) {
        if (multipleBuckets && window.bucket && window.bucket !== bucket) {
          bucket = window.bucket;
          group.append(el('div', 'usage-bucket', bucket));
        }
        const row = el('div', `usage-row ${window.level}`);
        row.title = window.title;
        const bar = el('span', 'usage-bar');
        bar.setAttribute('aria-hidden', 'true');
        if (Number.isFinite(window.percent)) {
          const fill = el('span', 'usage-fill');
          fill.style.width = `${Math.min(window.percent, 100)}%`;
          bar.append(fill);
          // A line where an even pace to the reset would be now: a fill short of it leaves room,
          // a fill past it reaches the limit before the reset.
          if (Number.isFinite(window.pace)) {
            const pace = el('span', 'usage-pace');
            pace.style.left = `${window.pace}%`;
            bar.append(pace);
          }
        }
        const reset = el('span', 'usage-reset', window.detail || (window.resetTime ? `↻ ${window.resetTime}` : ''));
        reset.setAttribute('aria-label', window.detail || window.resets || '');
        const percent = el('span', 'usage-percent', Number.isFinite(window.percent) ? t('{percent}%', { percent: window.percent }) : '—');
        if (!Number.isFinite(window.percent)) percent.setAttribute('aria-label', t('Unknown'));
        row.append(el('span', 'usage-label', window.label), bar,
          percent, reset);
        group.append(row);
      }
      return group;
    }));
  }

  return { render };
}

if (typeof module === 'object') module.exports = { createUsageFooter };
