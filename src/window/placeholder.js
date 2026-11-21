// The pages shown where there is no VS Code to show: the window without tabs, and a tab that is
// starting, suspended, or could not start. They take the side bar's colors (theme.js).
const { t } = require('../i18n');

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A bar filled to `progress` (0 to 1), or nothing without it. The page is loaded again for each
// report (about once a second), so the bar is drawn as it is, without moving.
function progressBar(progress) {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return '';
  const percent = Math.round(Math.min(Math.max(progress, 0), 1) * 100);
  return `<div class="bar" role="progressbar" aria-label="${escape(t('In progress'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div style="width: ${percent}%"></div></div>`;
}

// A data: URL of a page with `title` and `detail`. `theme`: sidebarTheme's colors, or null
// before a tab's theme has been read, when it is light or dark as the system is. `lang`: the
// page's language. `progress`: the part done of what the detail says (a download, extracting),
// when it is known; a bar under the detail shows it.
function placeholderUrl(title, detail = '', theme = null, lang = 'en', progress = null) {
  const colors = theme
    ? `:root { color-scheme: ${theme.scheme}; --bg: ${theme.vars['--bg']}; --fg: ${theme.vars['--text']}; --muted: ${theme.vars['--text-muted']}; --accent: ${theme.vars['--accent'] || '#0066b8'}; }`
    : `:root { color-scheme: light dark; --bg: #ffffff; --fg: #333333; --muted: #6f6f6f; --accent: #0066b8; }
    @media (prefers-color-scheme: dark) { :root { --bg: #1e1e1e; --fg: #e6e6e6; --muted: #9d9d9d; --accent: #3794ff; } }`;
  const html = `<!doctype html><html lang="${lang}"><meta charset="utf-8"><style>
    ${colors}
    body { margin: 0; height: 100vh; display: grid; place-content: center; gap: 10px; padding: 0 24px;
      text-align: center; background: var(--bg); color: var(--fg);
      font: 14px/1.6 "Segoe UI", "Yu Gothic UI", system-ui, sans-serif; }
    h1 { margin: 0; font-size: 18px; font-weight: 600; }
    p { margin: 0; color: var(--muted); max-width: 640px; overflow-wrap: anywhere; }
    .bar { justify-self: center; width: min(320px, calc(100vw - 48px)); height: 4px; overflow: hidden; border-radius: 2px;
      background: rgb(from var(--accent) r g b / 0.2); }
    .bar > div { height: 100%; background: var(--accent); }
  </style><h1>${escape(title)}</h1><p>${escape(detail)}</p>${progressBar(progress)}`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// The title, detail, and progress of a tab's page in the lifecycle's `state` ('initial',
// 'starting', 'suspended', 'error'). `preparing`: code-server and the extensions are still being
// made ready (startup-gate.js), which a tab starting waits for. `progress`: the part done of what
// a starting tab's detail says (downloading or extracting code-server for WSL), when known.
function tabPlaceholder(name, state, detail, preparing, progress = null) {
  if (state === 'initial') detail = t('Suspended. Select the tab to start it.');
  else if (state === 'starting' && !detail) detail = preparing ? t('Preparing code-server and extensions…') : t('Starting code-server…');
  else if (state === 'suspended') detail = t('Suspended. Click the tab to start it. Claude conversations can be resumed from the history.');
  const title = state === 'error' ? t('Could not start {name}', { name }) : name;
  return { title, detail, progress: state === 'starting' ? progress : null };
}

module.exports = { placeholderUrl, tabPlaceholder };
