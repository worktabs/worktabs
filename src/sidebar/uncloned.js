// The third section of the tree: the repositories of the accounts gh is signed in to (their own
// and their organizations') that are not cloned, under a row for each owner (the account's own
// first). A repository's row clones it with its button, or from its menu (see startClone in
// main.js). sidebar.js creates it with its state and elements, and keeps what is folded.

/**
 * @typedef {object} UnclonedSectionOptions
 * @property {any} state the page's state (sidebar.js)
 * @property {Pick<SidebarHost, 'cloneRepo' | 'showUnclonedMenu' | 'showOwnerMenu'>} host
 * @property {Pick<Document, 'getElementById'>} document
 * @property {{ el: Function, logo: Function, rowButton: Function, ownerRow: Function }} dom
 * @property {{ shownOwners: () => Array<{ group: any, repos: any[], expanded: boolean }>, visibilityMark: Function }} select
 * @property {{ toggleOwner: (group: any) => void }} actions
 * @property {Record<string, { icon?: string, label: string }>} visibilities who can see a repository (VISIBILITIES in sidebar.js)
 * @property {(text: string, values?: Record<string, any>) => string} t
 */

/** @param {UnclonedSectionOptions} options */
function createUnclonedSection({ state, host, document, dom, select, actions, visibilities, t }) {
  const { el, logo, rowButton, ownerRow } = dom;

  // A date, for when a repository was last pushed to.
  function dateText(ms) {
    const date = new Date(ms);
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }

  // An owner (renderOwner in rows.js, as the other sections' owners): whose repositories are
  // under it, with how many. Its menu hides it from this section.
  function renderOwner(group, count, expanded) {
    return ownerRow(group, {
      count,
      expanded,
      lines: [t('Repositories not cloned: {count}', { count })],
      toggle: () => actions.toggleOwner(group),
      menu: () => host.showOwnerMenu(group.key),
    });
  }

  // A repository not cloned: the button clones it (on Windows, asking first whether into Windows or
  // WSL), and it says so while it is cloned.
  function renderRepo(repo) {
    const busy = state.cloning.has(repo.key);
    const row = el('div', `row uncloned${busy ? ' removing' : ''}`);
    row.setAttribute('role', 'treeitem');
    const mark = logo('github');
    mark.classList.add('provider');
    row.append(mark, el('span', 'name', repo.name));
    const visibility = visibilities[repo.visibility];
    if (visibility && visibility.icon) row.append(select.visibilityMark(visibility));
    row.title = [
      repo.url,
      repo.description,
      repo.fork ? t('Fork') : '',
      visibility ? `GitHub: ${visibility.label}` : '',
      repo.pushedAt ? t('Last push: {date}', { date: dateText(repo.pushedAt) }) : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (busy) row.append(el('span', 'state', t('Cloning…')));
    else row.append(rowButton('clone', t('Clone'), () => host.cloneRepo(repo.url)));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      host.showUnclonedMenu(repo.url);
    });
    return row;
  }

  // The section, folded unless unfolded (it opens up while filtering), with the number of
  // repositories in its heading. Hidden while there are none: without gh, or signed out.
  function render() {
    const shown = select.shownOwners();
    const expanded = !state.folded.has('uncloned') || Boolean(state.filter);
    const rows = shown.flatMap(({ group, repos, expanded: open }) => [renderOwner(group, repos.length, open), ...(open ? repos.map(renderRepo) : [])]);
    document.getElementById('uncloned-tree').replaceChildren(...(expanded ? rows : []));
    document.getElementById('uncloned-toggle').setAttribute('aria-expanded', String(expanded));
    document.getElementById('uncloned-count').textContent = String(shown.reduce((sum, { repos }) => sum + repos.length, 0));
    document.getElementById('uncloned-section').hidden = !state.uncloned.length || (Boolean(state.filter) && !shown.length);
  }

  return { render };
}

if (typeof module === 'object') module.exports = { createUnclonedSection };
