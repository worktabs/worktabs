// Row renderers receive page state, selectors, and actions instead of owning page coordination.
function createSidebarRows({ state, host, dom, select, actions, text, t, clock = Date.now }) {
  const { el, icon, logo, agentIcon, rowButton } = dom;
  const { sourceLabel, providerOf, approvedOf, approvedLines, mostUrgent, folderName, branchOf,
    badgeOf, pullOf, madeFrom, headChecks, hasBranchPage, conversationBadge, conversationName,
    movedTo, pullChecks, checkLabel, checksLines, sinceText, elapsedText, keyOf } = select;
  const { LABELS, WAITING_SHORT, WSL_PATH, VISIBILITIES, PULL_STATES, CHECK_ICONS, AGENT_LABELS } = text;

  // Marks a row whose folder is in WSL, so it is not taken for one on Windows. A repository row
  // carries it for its worktrees; a folder outside any repository carries its own.
  function appendWslTag(row, folderPath) {
    const wsl = WSL_PATH.exec(folderPath || '');
    if (!wsl) return;
    const tag = el('span', 'tag', 'WSL');
    tag.title = `WSL: ${wsl[1]}`;
    row.append(tag);
  }

  // The mark of a repository that is not public on GitHub, after its name.
  function visibilityMark({ icon: name, label }) {
    const mark = icon(name);
    mark.classList.add('visibility');
    mark.removeAttribute('aria-hidden');
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', label);
    return mark;
  }

  // The icon at the head of a repository's row (PROVIDERS). A dot on its corner says the repository
  // has pull requests of one's own approved and not merged (approvedOf): over the icon, so that the
  // row keeps its width, and taking no pointer, so that the icon brings up the GitHub buttons as
  // ever, where they are named (approvedRow).
  function providerMark(group, provider) {
    const mark = !group.git ? icon('folder') : provider?.logo ? logo(provider.logo) : icon('repo');
    mark.classList.add('provider');
    if (!approvedOf(group).length) return mark;
    const box = el('span', 'provider-box approved');
    box.append(mark, el('span', 'approved-dot'));
    return box;
  }

  // The icon of a repository that may be on GitHub, which brings up its GitHub buttons when the
  // mouse rests on it (see the GitHub section). Without a tooltip of its own: the row's would come
  // up over the buttons.
  function githubMark(group, provider) {
    const mark = el('span', 'gh-mark');
    mark.dataset.key = group.key;
    mark.title = '';
    mark.append(providerMark(group, provider));
    return mark;
  }

  // A repository (or the group of folders outside git). Collapsed, it shows the most urgent
  // state among its open tabs. Nothing says whether it is expanded but the rows under it, which
  // are indented: a mark for that would take the width of a column. `github`: whether its icon
  // brings up its GitHub buttons.
  function renderGroup(group, expanded, github) {
    const row = el('div', 'row repo');
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', String(expanded));
    const title = group.other
      ? [t('Folders open outside a git repository')]
      : [group.path, group.sources.map(sourceLabel).join(t(', '))];
    if (!group.git && !group.other) title.push(t('Not a git repository, so the folder opens as it is'));
    const provider = providerOf(group);
    row.append(github ? githubMark(group, provider) : providerMark(group, provider), el('span', 'name', group.name));
    const visibility = !group.other && VISIBILITIES[state.visibility[group.key]];
    if (visibility) {
      if (visibility.icon) row.append(visibilityMark(visibility));
      title.push(`GitHub: ${visibility.label}`);
    } else if (provider) {
      title.push(provider.label);
    }
    const approved = approvedOf(group);
    if (approved.length) title.push(...approvedLines(approved));
    // Its owner is the row above it (renderOwner).
    if (!group.other) appendWslTag(row, group.path);
    if (!expanded && group.tabs.length) {
      const badge = mostUrgent(group.tabs);
      row.append(el('span', `dot ${badge}`));
      if (badge === 'waiting') row.classList.add('attention');
      title.push(LABELS[badge]);
    }
    // Before "+" and set apart from it, rather than at the right end where "+" is on an expanded
    // row: the buttons that were there stay where they were.
    if (group.tabs.length) row.append(closeAllButton(group));
    if (group.git) row.append(rowButton('add', t('Add worktree'), () => host.addWorktree(group.path)));
    // A repository just cloned is scrolled to (see onCloned).
    if (!group.other) row.dataset.repo = group.path;
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      host.showRepoMenu(group.path, group.tabs.map((tab) => tab.id));
    });
    row.title = title.join('\n');
    row.addEventListener('click', () => actions.toggle(group));
    return row;
  }

  // An owner's row, with the rows of its repositories under it, in every section: whose they are
  // (one's own account, an organization, another owner, or none known: `owner.none`), with how
  // many. Another host than github.com (GitHub Enterprise, GitLab) goes beside the name. `lines`:
  // the rest of its title. `badge`: folded, the most urgent state of the open tabs under it, as a
  // folded repository shows. `menu`: what its context menu does, if it has one.
  function renderOwner(owner, { count, expanded, lines, toggle, badge = null, menu = null }) {
    const row = el('div', 'row repo owner');
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', String(expanded));
    const mark = icon(owner.none ? 'folder' : owner.type === 'user' ? 'person' : 'organization');
    mark.classList.add('provider');
    row.append(mark, el('span', 'name', owner.owner));
    if (owner.host && owner.host !== 'github.com') row.append(el('span', 'detail', owner.host));
    const title = owner.none ? [...lines] : [ownerLine(owner), owner.host, ...lines];
    if (badge) {
      row.append(el('span', `dot ${badge}`));
      if (badge === 'waiting') row.classList.add('attention');
      title.push(LABELS[badge]);
    }
    row.append(el('span', 'owner-count', String(count)));
    row.title = title.join('\n');
    row.addEventListener('click', toggle);
    if (menu) {
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        menu();
      });
    }
    return row;
  }

  // Who an owner is, in its row's title.
  function ownerLine(owner) {
    if (owner.type === 'org') return t('{owner} (organization)', { owner: owner.owner });
    if (owner.type === 'user') return t('{owner} (your account)', { owner: owner.owner });
    return owner.owner;
  }

  // The button that closes all the tabs a group shows (closeTabsTogether in main.js).
  function closeAllButton(group) {
    const button = rowButton('closeAll', t('Close all tabs'), () => actions.closeAll(group));
    button.classList.add('close-all');
    return button;
  }

  // A worktree (or an open folder outside git). Clicking it opens it as a tab, or switches to its
  // tab; an open one can be closed here and has the tab's menu. `loose`: in the group of folders
  // outside any repository, where no repository row says whether it is in WSL.
  function renderFolder(folder, loose = false) {
    const { tab } = folder;
    const badge = tab ? badgeOf(tab) : 'closed';
    const name = folderName(folder);
    const branch = branchOf(folder);
    // While a chat in view shows one of its conversations, that row is the one marked, and the
    // worktree's row keeps only the line at its left.
    const active = tab && tab.active ? ((tab.conversations || []).some((c) => c.shown) ? ' active holds-shown' : ' active') : '';
    const row = el('div', `row worktree${tab ? ' open' : ''}${active}${badge === 'waiting' ? ' attention' : ''}`);
    row.setAttribute('role', 'treeitem');
    row.dataset.folder = folder.path;
    row.title = [folder.path, branch && t('Branch: {branch}', { branch }), `${LABELS[badge]}${tab && tab.error ? `: ${tab.error}` : ''}`].filter(Boolean).join('\n');
    row.append(el('span', `dot ${badge}`), el('span', 'name', name));
    if (loose) appendWslTag(row, folder.path);
    // The branch, unless the name already says it: a worktree the side bar adds is named after its
    // branch, slashes as dashes (worktreeFolder in worktrees.js). The row keeps its width for the
    // name and the pull request.
    if (branch && branch.replace(/\//g, '-') !== name) row.append(el('span', 'detail', branch));
    if (folder.issue) row.append(numberButton(folder, 'issue'));
    // The branch's pull request, when it has one. The one it was made from shows by its number
    // until its state is read, or when it cannot be (without gh); once read, a number the
    // repository does not have (its remote was changed since) no longer shows. Without one, the
    // checks of the worktree's HEAD, if any.
    const pull = pullOf(folder.repo, branch);
    const unread = pull === undefined && madeFrom(folder);
    const head = !pull && !unread ? headChecks(folder, branch, pull) : null;
    if (pull) row.append(pullButton(folder, pull));
    else if (unread) row.append(numberButton(folder, 'pull'));
    else if (head) row.append(headButton(folder, head));
    if (state.removing.has(keyOf(folder.path))) {
      row.classList.add('removing');
      row.append(el('span', 'state', t('Removing…')));
      return row;
    }
    if (badge === 'waiting') row.append(el('span', 'state', WAITING_SHORT));
    // Without one, a button for the branch's pull request, which offers to make one, when the
    // repository is on GitHub and the branch is not its default one (hasBranchPage in github.js).
    // A detached HEAD is no branch: the list says null, an open tab "HEAD". While the pull
    // requests are not known, the button finds the pull request too (pageUrl in github.js).
    if (!pull && !unread && hasBranchPage(folder.repo, branch)) {
      const title = pull === null ? t('Create a PR ({branch})', { branch }) : t("This branch's PR ({branch})", { branch });
      row.append(rowButton('branch', title, () => host.openGithub(folder.path, 'branch')));
    }
    // Only on a closed worktree, at the right end where an open one has its ×: closing the tab and
    // then removing the worktree is one click after another in the same place. It only asks, so
    // clicking × twice removes nothing. Beside the × of an open one, closing could remove it.
    // On a worktree whose pull request was merged at its HEAD (mergedAtHead in github.js), it shows
    // without hovering: its branch has nothing left that was not merged, so it is likely done with.
    if (!tab && folder.repo && !folder.main && !folder.locked) {
      const merged = Boolean(pull) && pull.state === 'merged' && Boolean(folder.head) && pull.head === folder.head;
      const title = merged ? t('Remove worktree… (PR #{number} is merged)', { number: pull.number }) : t('Remove worktree…');
      const trash = rowButton('trash', title, () => host.removeWorktree(folder.path, folder.repo));
      if (merged) trash.classList.add('ready');
      row.append(trash);
    }
    if (!tab) {
      row.addEventListener('click', () => {
        actions.unfoldOpenSection();
        host.open(folder.path);
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        host.showWorktreeMenu(folder.path, folder.repo);
      });
      return row;
    }
    row.setAttribute('aria-selected', String(tab.active));

    const close = el('button', 'close', '×');
    close.type = 'button';
    close.title = t('Close');
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      host.close(tab.id);
    });
    row.append(close);

    row.addEventListener('click', () => host.activate(tab.id));
    row.addEventListener('mousedown', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        host.close(tab.id);
      }
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      host.showTabMenu(tab.id);
    });
    return row;
  }

  // The number of the issue a worktree's branch was made for, or of the pull request it was made
  // from (`kind`: 'issue' or 'pull'), which opens it (see setBranchLink in worktrees.js).
  function numberButton(folder, kind) {
    const { number, title } = folder[kind];
    const what = kind === 'issue' ? 'issue' : 'PR';
    const button = el('button', 'issue', `#${number}`);
    button.type = 'button';
    button.title = kind === 'issue' ? `#${number} ${title}\n${t('Click to open the issue on GitHub')}` : `PR #${number} ${title}\n${t('Click to open the PR on GitHub')}`;
    button.setAttribute('aria-label', `${what} #${number} ${title}`);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (kind === 'issue') host.openIssue(folder.path, number);
      else host.openPull(folder.path, number);
    });
    return button;
  }

  // The pull request of a worktree's branch: its number in its state's color, with what its checks
  // came to (pullChecks). Its title names each check, and says whether it is approved and not
  // merged (the dot of its repository's icon). It opens the pull request.
  function pullButton(folder, pull) {
    const { icon: stateIcon, label } = PULL_STATES[pull.state];
    const checks = pullChecks(pull, clock());
    const approved = pull.state === 'open' && Boolean(folder.repo) && (state.approved[keyOf(folder.repo)] || []).some((each) => each.number === pull.number);
    const result = checks && checkLabel(checks.state);
    const summary = [
      `PR #${pull.number} ${label}`,
      approved ? t('Approved') : '',
      checks ? (pull.state === 'merged' ? t('CI after the merge: {result}', { result }) : t('CI: {result}', { result })) : '',
    ]
      .filter(Boolean)
      .join(t(', '));
    const button = el('button', `pull ${pull.state}`);
    button.type = 'button';
    button.title = [summary, pull.title, ...(checks ? checksLines(checks) : []), t('Click to open the PR on GitHub')].filter(Boolean).join('\n');
    button.setAttribute('aria-label', summary);
    button.append(icon(stateIcon), `#${pull.number}`);
    if (checks) button.append(checksMark(checks));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      host.openPull(folder.path, pull.number);
    });
    return button;
  }

  // The checks of a worktree's HEAD, on a row without a pull request: their mark alone, as there
  // is no number. Its title names each check. It opens the commit's checks.
  function headButton(folder, checks) {
    const summary = t('CI of commit {commit}: {result}', { commit: checks.oid.slice(0, 7), result: checkLabel(checks.state) });
    const button = el('button', 'head-checks');
    button.type = 'button';
    button.title = [summary, ...checksLines(checks), t('Click to open the checks on GitHub')].join('\n');
    button.setAttribute('aria-label', summary);
    button.append(checksMark(checks));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      host.openChecks(folder.path, checks.oid);
    });
    return button;
  }

  // ✓ (passed), × (failed) or ● (running), in their colors.
  function checksMark(checks) {
    const mark = icon(CHECK_ICONS[checks.state]);
    mark.classList.add('checks', checks.state);
    return mark;
  }

  // How long a conversation has been in its state (elapsedText in time.js), at the right end of
  // its row. It carries what tickElapsed needs to move it on.
  function elapsedSpan(conversation, now) {
    const span = el('span', 'elapsed', elapsedText(conversation.state, conversation.since, now));
    span.dataset.state = conversation.state;
    span.dataset.since = String(conversation.since);
    return span;
  }

  // An agent conversation in an open tab, with how long it has been in its state. Clicking it
  // switches to the tab and brings the conversation to the front. One that neither works nor waits
  // can be archived: taken off the list, while its claude goes on (the extension keeps a
  // conversation that another has put behind it in the panel). A subagent sits `depth` steps in
  // under its parent.
  function renderConversation(tab, conversation, depth = 0) {
    const now = clock();
    const badge = conversationBadge(conversation);
    const name = conversationName(conversation);
    const moved = movedTo(tab, conversation);
    const since = sinceText(conversation.state, conversation.since, now);
    const row = el('div', `row conversation${conversation.shown ? ' active' : ''}${badge === 'waiting' ? ' attention' : ''}`);
    const provider = AGENT_LABELS[conversation.agent === 'codex' ? 'codex' : 'claude'];
    row.setAttribute('role', 'treeitem');
    if (depth) row.style.setProperty('--depth', String(depth));
    row.title = [
      name,
      t('Agent: {agent}', { agent: provider }),
      conversation.subagent ? t('Subagent') : '',
      conversation.agentRole ? t('Role: {role}', { role: conversation.agentRole }) : '',
      conversation.title && conversation.prompt ? t('Last prompt: {prompt}', { prompt: conversation.prompt }) : '',
      since ? t('{state} ({since})', { state: LABELS[badge], since }) : LABELS[badge],
      moved ? t('Working in: {folder}', { folder: conversation.cwd }) : '',
    ]
      .filter(Boolean)
      .join('\n');
    row.setAttribute('aria-label', row.title);
    // The conversation a chat in view shows (SeenConversations in the main process).
    row.setAttribute('aria-selected', String(Boolean(conversation.shown)));
    row.append(el('span', `dot ${badge}`), agentIcon(conversation.agent));
    // A short tag, so the name keeps the room; the tooltip spells it out.
    if (conversation.subagent && name !== t('Subagent')) row.append(el('span', 'tag', t('Sub')));
    row.append(el('span', 'name', name));
    if (moved) row.append(el('span', 'detail moved', `→ ${moved}`));
    if (badge === 'waiting') row.append(el('span', 'state', WAITING_SHORT));
    row.append(elapsedSpan(conversation, now));
    if (conversation.state !== 'working' && conversation.state !== 'waiting') {
      row.append(rowButton('archive', t('Archive (take off the list)'), () => host.archiveSession(tab.id, conversation.id)));
    }
    row.addEventListener('click', () => host.revealSession(tab.id, conversation.id));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      host.showTabMenu(tab.id);
    });
    return row;
  }

  return { renderOwner, renderGroup, renderFolder, renderConversation, visibilityMark };
}

if (typeof module === 'object') module.exports = { createSidebarRows };
