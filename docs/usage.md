# Usage

**English** | [日本語](ja/usage.md)

Pick a worktree in the sidebar on the left, and its VS Code (code-server) opens as a tab on the right. A map of the window, with what you can do in each part, is in [features.md](features.md). Adding and removing worktrees is in [worktrees.md](worktrees.md). Repositories in WSL are in [wsl.md](wsl.md).

## Sidebar

Claude Code and Codex conversations share the state badges and the working and waiting counters. Codex approval, permission, and user-input requests count as waiting. Clicking a Codex conversation row, a notification, or the next-waiting control switches the Codex chat sidebar to that thread, without opening an editor tab. Background completion and errors send notifications and leave an unread result. Closing, suspending, or restarting a tab warns when either agent is working or waiting.

The sidebar is a tree of repositories → worktrees → conversations.

When another window is in front, one click on a row brings the Worktabs window to the front and also does what the row does (such as switching tabs). The same holds on macOS, and one click also works in the VS Code of a tab ([architecture.md](architecture.md#rebuilding-the-sidebar)).

### Sections

The tree has three sections.

- **Open repositories**: repositories with open tabs (by name), and "Other folders". With no tabs, the whole section is hidden.
- **Other repositories**: the remaining repositories. They are ordered by how recently they had an open tab. Ones never opened come after, by name. With no repository and no tab at all (for example, without ghq), it says how to add one.
- **Repositories not cloned**: GitHub repositories of your account and of the orgs you belong to that are not cloned yet (see "[Repositories not cloned](#repositories-not-cloned)" below). Without gh, or when gh is not signed in, the whole section is hidden.

Section headings work like this.

- Click a heading to collapse its section. A collapsed "Open repositories" heading shows the badge of the most urgent state among the open tabs. Opening a worktree from the sidebar expands "Open repositories". While you type in the filter, matches are shown even in a collapsed section.
- "Repositories not cloned" starts collapsed, because with many entries it would make the list of repositories you use every day long. Its heading shows the number of repositories.
- When you scroll, a section heading stays at the top of its section.
- The time each repository last had an open tab is recorded in `tabs.json` in the data folder.

### Repositories

The list shows repositories from ghq (including inside WSL), repositories you added by hand, and the repositories of open tabs.

- The list is kept in `repos.json` in the data folder. On start, the app first shows the previous list, reloads it in the background, and replaces it when done. While it reloads, the circular arrow at the top spins. Worktree rows of expanded repositories also show the previous ones first.
  - Only on the first start, when there is no `repos.json`, the list appears after it is loaded.
  - The list is reloaded on start, when you press the circular arrow, and after "Add repository…". A repository you add appears at once, without waiting for the reload. The list is not reloaded when the window comes to the front, because that would start a stopped WSL each time.
  - For a source that could not be reloaded (such as WSL not answering in time), the previous repositories are kept. The reason is written as one line to `logs\repos.log` in the data folder.

- When you open a tab, its repository moves to "Open repositories" and expands.
- When collapsed, the repository row shows the badge of the most urgent state among its open tabs.
- Before the name, an icon shows where the remote (origin, or the first remote if there is no origin) is hosted.

  | Icon | Remote |
  | --- | --- |
  | GitHub, GitLab, or Bitbucket logo | That service. GitHub includes Enterprise; GitLab and Bitbucket include in-house servers whose host starts with `gitlab.` or `bitbucket.` |
  | Book | Other remotes (Gitea, in-house Git servers, paths, and so on) and repositories with no remote. This also shows before the remote is read (on the first start) |
  | Folder | Folders that are not git, and "Other folders" |

  - Hover to see a name such as `GitLab` or `No remote`.
  - The main process reads the remote of every repository in the list and keeps it in `repos.json`. It reads the remote when a repository first appears in the list and when you press the circular arrow (which hosts count as which service is in [architecture.md](architecture.md#github-buttons)).
- A repository whose remote is GitHub shows its GitHub visibility as an icon next to the name: a lock for private, a building for internal (visible to members of the Enterprise). Public shows nothing. Hover to see text such as "GitHub: Private", also for public.
  - The visibility is asked from GitHub with gh each time the list is reloaded, and kept in `repos.json`. On the next start, the previous value shows before the answer arrives.
  - Without gh, when gh is not signed in, or for repositories you cannot see (deleted, no permission), nothing shows.
- A repository with PRs of your own that are approved but not merged yet shows a red dot at the top right of the icon at the left of its row (the GitHub logo). It shows even when the row is collapsed, and even when you have no worktree for the PR's branch. The row does not get wider.
  - Hover over the row's name to see which PRs: "PRs approved but not merged:", then the number and title of each. They also appear under the GitHub buttons that come up when you hover over the icon. Press one to open that PR (see "[GitHub pages](#github-pages)" below).
  - Whether a PR is approved follows GitHub's decision (for branches that require reviews). In a repository that does not require reviews, a PR is approved when the latest reviews of the people who can write to the repository include an approval and no request for changes. Draft PRs and PRs in archived repositories do not show.
  - PRs by other people (such as one you made a worktree from for a review) do not show. Their authors are the ones who merge them.
  - The PRs are read again after the list is reloaded, every 5 minutes, when the Worktabs window comes to the front (if 1 minute has passed since the last read), and after Claude pushes or merges (`git push`, `gh pr merge`, and so on). People approve PRs on GitHub, and the app is not told about it. In an expanded repository, a PR that its worktree row finds merged or closed goes away at once.
  - For repositories in WSL, the PRs are read again only while the distribution is running, except after the list is reloaded. This keeps a stopped WSL from starting.
  - This works only for repositories on GitHub. MRs and PRs on GitLab and Bitbucket are not read. Without gh, or when gh is not signed in, nothing shows.
- Click to show the list of worktrees (`git worktree list`). The list is reloaded when you expand it, when the Worktabs window comes to the front, and when Claude finishes its work. Worktrees made outside the app show up this way too.
- Worktree rows are indented to the position of the repository name. Conversation rows are indented to the position of the worktree name.
  - There is no expand/collapse marker (▸). A row is expanded when indented rows appear right below it. The width of a marker column goes to the name instead.
- Folders opened outside a git repository are grouped under "Other folders".
- A folder in the ghq list that is not git (such as an SVN checkout) has no worktrees. Expanding it shows just that folder as one row, and clicking opens it as a tab. The "＋" and GitHub buttons do not appear (the "Close all tabs" button below appears if a tab is open). Tabs opened inside that folder appear under that row, not under "Other folders".
- The "＋" that appears on hover, or "Add worktree…" in the right-click menu, opens the dialog for adding a worktree. Claude can also pick the branch name from a GitHub issue or a task ([worktrees.md](worktrees.md)).
- A row with open tabs (including "Other folders" and rows of folders that are not git) shows a "Close all tabs" button on hover, with the same icon as VS Code's "Close All". Press it to close all the tabs of that row at once, including tabs hidden because the row is collapsed or filtered out. "Close all tabs" in the right-click menu does the same.
  - If any of the tabs have Claude working or waiting for approval, or have unsaved files, the app lists them and asks once (the same as the confirmation on exit). If none do, it closes them without asking.
  - When the tab in front is also closed, the app moves to a tab outside that row: the next one in tab order (the order of Ctrl+Alt+PageDown), else the previous one. If there is none, no tab is shown. Tabs being closed are not brought to the front on the way, so suspended tabs are not started.
  - A closed tab returns to the screen it had before closing when you reopen it, the same as when closed with ×.
  - When a row has no tabs left, it moves to "Other repositories", and the row below moves up into its place. So that you do not go on to close the tabs of that row too, clicks on the tree are ignored while closing and for 0.6 seconds after (including the second click of a double click).
  - The button appears to the left of "＋", with a small gap. The "＋" at the right end of an expanded row stays in place.

### Repositories not cloned

This lists the repositories you own (including your forks) and the repositories of the orgs you belong to, in the GitHub account gh is signed in to (GitHub Enterprise included), that are not cloned yet. When you start work on a new PC, or come back to a repository you have not touched for a while, you can clone it from here instead of running `ghq get` in a terminal.

- Not shown: repositories already cloned (in either Windows or WSL), archived repositories, and other people's repositories where you are only a collaborator.
  - Whether a repository is cloned is checked by comparing with the remote URLs of the repositories in the list, ignoring case. Repositories that were renamed or moved to another owner are compared by the current URL GitHub returns, so they do not show here.
  - A repository whose remote has not been read yet (such as one just cloned outside the app) also counts as cloned if its folder follows the ghq layout (`.../<host>/<owner>/<name>`).
- Each time the list is reloaded (on start, with the circular arrow, after "Add repository…"), the app asks GitHub with gh after it has read the remotes. Even on the first start, a cloned repository never shows here, not even for a moment.
  - The result is kept in `repos.json` in the data folder. On the next start, the previous result shows before the answer arrives. For a host that could not be asked, the previous result is kept.
- Under each owner row, the rows of that owner's repositories are indented to the position of the owner's name.
  - Owner rows put your own account first, then orgs by name. Each shows a person or organization icon, the name, and the number of repositories not cloned. For owners on a host other than github.com, the host appears next to the name.
  - Your own account starts expanded and orgs start collapsed (a large org can have hundreds of repositories). The expanded state is remembered.
  - Right-click an owner row for "Open on GitHub" and "Hide this owner". Hidden owners go into the `hiddenGithubOwners` setting (to show one again, remove it from the settings file; see [config.md](config.md)).
- A repository row shows the GitHub logo, the name, and the visibility icon (a lock for private, a building for internal). Rows are ordered by last push.
  - Hover to see the URL, the description, whether it is a fork, and the date of the last push.
  - Clone with the button that appears on hover (a down arrow), or "Clone" in the right-click menu. The right-click menu also has "Open on GitHub" and "Copy URL".
- How it clones:
  - If ghq is available (`ghq root` works), it clones with `ghq get`. ghq decides where.
  - Without ghq, a dialog asks where to clone, and it clones with `git clone` (see "[Clone destination dialog](#clone-destination-dialog)" below).
  - Whether to use https or SSH follows the gh setting (`gh config get git_protocol`, which you chose in `gh auth login`), the same as `gh repo clone`. For SSH it uses `ghq get -p` or `git@<host>:<owner>/<name>.git`.
  - On Windows, you can also clone into a WSL distro. Pressing the button opens a menu to choose the destination from "Windows" and "WSL: <distro name>" ([wsl.md](wsl.md#cloning)). If Windows is the only choice, there is no menu and cloning starts at once. On macOS, cloning also starts at once.
- While cloning, the row shows "Cloning…" and no button. Large repositories exist, so it waits up to 10 minutes.
- When done, the repository moves to "Other repositories" and expands to show its primary row.
  - When it was cloned with ghq and the `repoSources` setting does not read ghq (for WSL, does not read that distro), or when it was cloned with `git clone`, the folder is added to the `repos` setting (the same as "Add repository…").
- On failure, a dialog shows the output of ghq or git.
  - When https authentication fails, the dialog also shows how to give git your GitHub credentials (Git Credential Manager or `gh auth setup-git`). Signing in to gh and git credentials are separate.
  - When the SSH key is rejected or the host key has not been accepted, the dialog tells you to run `ssh -T git@github.com` once in a terminal. The app has no place to ask whether to accept a host key.

#### Clone destination dialog

When ghq is not available, this dialog asks where to clone.

- The field holds the full path of the folder to clone into. If a folder already exists there, you cannot clone (shown in red below the field).
- Below the field, the places where cloned repositories in the list live are shown, the place with the most repositories first. Press one to put the path for cloning there into the field.
  - For a place with repositories in the ghq layout (`<root>/<host>/<owner>/<name>`), it clones into `<root>` in the same layout. For other places, it clones into `<parent folder>/<name>`.
  - When cloning into WSL, the places of that distro's repositories are shown.
- You can also pick a folder with "Browse…". The repository goes into `<name>` under the picked folder. If the picked folder has a host folder (such as `github.com`), the ghq layout is used.
- The last place you cloned into is remembered in the `cloneRoot` setting, and the next clone starts there.
- Enter clones, Esc cancels. The dialog closes when cloning starts.

### Worktrees

A row shows the folder name and, next to it, the branch name.

- The main worktree (the repository folder itself) shows as `primary`. Its folder name is the same as the repository name, and `main` would be confused with the branch.
- A folder named `<repository name>-<name>` next to the repository shows only `<name>` (`feat-x` for `worktabs-feat-x`).
- When the folder name is the same as the branch name (including with `/` changed to `-`), the branch name is not shown, because worktrees added from the sidebar are named after the branch (`feat-x` for `feat/x`). Hover over the row to see the branch name.
- Click to open it as a tab (code-server starts in about 1 second). If it is already open, the app switches to that tab.
- During first-start downloads or extension installation, tabs show "Preparing code-server and extensions…" and wait for preparation to finish. You can switch or close them while waiting. Saved tabs remain available if you open a new one during preparation. If preparation fails, the tab shows the error; correct the problem and restart Worktabs.
- An open worktree has a badge. Close it with × or a middle click. Right-click for the tab menu (see "Tabs" below). Right-click a worktree that is not open for: open, open in Explorer (open in Finder on macOS), the PR for this branch, copy path, and delete.
- Hover over the row of a worktree that is not open to see a trash button at the right end (where × is for an open one). Press it for the same confirmation as "Remove worktree…" in the right-click menu ([worktrees.md](worktrees.md#removing)). It does not appear for primary, locked worktrees, or open worktrees. For a worktree whose PR is merged and whose branch head is the same as the last commit of the PR, it shows without hovering.
- Branch names are reloaded when the Worktabs window comes to the front and when Claude finishes its work.
- A worktree made from a GitHub issue shows the issue number, such as `#20`, next to the branch name. Hover to see the title; press to open the issue on GitHub ([worktrees.md](worktrees.md#after-creating)).
- When the branch has a PR, the PR icon and number appear. Rows without a PR (including the row of the default branch) show the CI result of the HEAD commit (see "[PRs and CI](#prs-and-ci)" below).

### Conversations

When an open worktree has Claude Code or Codex conversations, a row for each conversation appears under it (even when there is only one). The Claude starburst identifies Claude Code; the OpenAI knot, also used by the Codex extension, identifies Codex. These marks follow the conversation's provider, even when the tab's default agent is different. They stay visible beside the separate state badge while an agent works or waits. The Claude mark is in Claude's orange and the Codex mark in black or white, as in their own extensions, in both themes. Both are the size of the repository's GitHub mark and keep it when the sidebar is narrow.

The row shows the state badge first, then the agent icon, then the conversation title. Until it has a title, it shows the last prompt you sent. Hover to read the provider name, state, and, for a named conversation, the last prompt. The row's accessible label includes the same information. The filter searches both the title and prompt.

Codex rows keep the thread ID, last turn ID, title, last prompt, and working folder. After a restart, rows for restored Worktabs tabs come back idle. Suspending a tab or closing its app-server also leaves its used Codex threads available to reopen. Worktabs does not import every thread in Codex history; a thread gets a row when it is used or resumed in that tab. Temporary (ephemeral) threads are not saved as restorable history. The conversation contents remain in Codex's own storage.

Codex's internal title and description generation does not appear as a conversation or affect badges, counters, unread results, notifications, or stop warnings. User-created temporary conversations still appear while they are open.

Delegated Codex agents have a **Sub** label (**Subagent** in the tooltip) and show their nickname, role, or agent path when available. Each sits one step in under the conversation that started it; one whose parent is archived or hidden by the filter stays at the top level. Clicking one opens that subagent's own thread, so its work can be inspected. Children keep working and waiting badges, but their completion does not create a separate green unread result or completion notification; the parent reports the combined result. Worktabs also uses the parent's reported child statuses to recover a missing child completion event. A completed spawn or wait tool alone does not mean the child has finished. Names, roles, and parent IDs survive an app restart once observed. Older saved rows gain these labels when the extension next reports their metadata. Internal guardian, review, and compaction threads stay hidden.

Clicking a restored row waits for the tab's helper extension to register, then switches the chat sidebar to the saved thread. If the extension or route is unavailable, Worktabs explains the failure and tries to show the Codex sidebar. A rejected thread resume also shows a warning. Threads deleted, archived, or moved to a different Codex home may no longer be restorable.

Worktabs also waits up to five seconds for the requested thread to appear in the visible Codex composer. URI dispatch alone is not treated as a successful reveal and does not clear an unread result. A blank or unsupported composer gets the same warning and history fallback. Switching tabs, restarting, or selecting another thread cancels the old confirmation.

- The right end of the row shows how long the conversation has been in its current state. For working and waiting for approval, it is how long that state has lasted ("12 min", "1 h", "2 d"). For done and error, it is the time since the turn ended ("5 min ago").
  - Nothing shows until 1 minute has passed. Idle conversations show nothing.
  - The time advances every minute. Hover over the row to see when the state started ("Working (since 14:03)").
  - The count starts again from 0 each time the state changes. When you approve and Claude goes back to work, the working time counts from the approval.
  - The times live only inside the app. After a restart, conversations start as idle, so no time shows until the next time work starts.
- Click a conversation row to switch to its tab and bring that conversation to the front. For a conversation in an editor tab, that editor tab comes to the front. For a conversation in the right panel (chat panel), the right panel switches to that conversation.
- When you start a new conversation in the right panel, or pick another one from the history, the previous conversation keeps running in the background (its claude process stays). So the row of the previous conversation stays too. Click the row to switch the right panel back to it.
- Hover over the row of an idle, done, or error conversation to see an archive button. Press it to remove the row from the list.
  - The conversation's claude is not stopped. If it is still working in the background, it goes on. This is the same as archiving in the Claude Code extension's conversation list.
  - Working and waiting-for-approval conversations cannot be archived. An archived conversation comes back to the list when it starts working or waits for approval again (such as when you open it from the right panel's history and send a prompt). There is no undo button, so use this to bring one back.
  - Archiving a done conversation you have not seen marks it as seen.
  - The archive is a mark only inside Worktabs. For Codex, this mark survives a restart. It does not call Codex's `thread/archive` or move its stored thread log. When the running Codex extension reports that a thread was actually archived or deleted, Worktabs removes its saved row too. Closing a loaded thread alone does not remove its saved row.
- A worktree row's badge is the most urgent state among the conversations of that worktree. Archived conversations do not count.
- When Claude moves to another worktree to work, the row shows "→ <where it moved>". The conversation panel stays in the VS Code of the original tab, so clicking the row moves to the original tab.

### Filter

Type in the field at the top to filter by repository name, worktree name, branch name, issue number (`#20`) and title, and conversation title. Esc clears it.

- In "Repositories not cloned", the filter matches repository names and descriptions, and owner names. An owner with a matching repository expands. When an owner name matches, all repositories of that owner show (the owner stays expanded or collapsed as it was).

### Top bar

- To the right of "Worktabs", badges show the number of conversations waiting for approval (orange) and working (blue). A badge with 0 is hidden.
  - The badges count conversations, not tabs. Two conversations waiting for approval in one tab count as 2. The count in the window title works the same way.
  - Press a badge to move to a conversation in that state. Each press moves to the next one, and after the last it goes back to the first (in the order tabs were opened, and within a tab, the order conversations started).
- Buttons on the right:
  - Circular arrow (reload the repository list): reloads the repositories from ghq (including inside WSL) and from the settings, the worktrees of expanded repositories, and the remotes (for every repository, for the row icons and visibility icons; it also asks again about SSH aliases and the gh sign-in). The icon spins until loading is done. Then it also asks GitHub again for repositories not cloned (the icon does not spin for this).
  - "＋": "Add repository…" (adds the git repository of the picked folder to the settings) and "Open folder…" (also opens folders not under git).
  - Gear: opens the settings dialog.
  - "…": "Check for code-server and extension updates" (if a new version exists, the sidebar shows it) and "Open settings file" (opens the settings file in the default editor). Its last line shows the version of Worktabs.

### Width

Drag the right edge of the sidebar to change its width. Hover there for a moment and a line appears at the edge.

- While you drag, the tab on the right follows the width.
- The width is 180 to 600 pixels. When the window is narrow, the sidebar stops where 320 pixels are left for the tab on the right. When you widen the window, the sidebar goes back to the width you set by dragging.
- The width you set is kept in `window.json` in the data folder and restored on the next start.
- Double-click the right edge to go back to the default width (the `sidebarWidth` setting, 260 pixels by default; see [config.md](config.md)).

### Colors

The sidebar's colors follow the VS Code theme of the tab in front (background, text, borders, selected row, input field, count badges). They change when you switch tabs and when you change the theme in VS Code. The screen shown while a tab gets ready uses the same colors.

- The colors of the state dots, the "Waiting for approval" text, the WSL mark, and the subscription usage bars are set by the app regardless of the theme (one set for light themes and one for dark). In dark themes, the working and waiting-for-approval dots glow a little (not when animation effects are turned off in the OS).
- The last theme matched is kept in `theme.json` in the data folder, and the next start shows those colors first. If no theme has ever been read, the colors follow the OS light or dark mode.

## Confirmation and warning dialogs

Dialogs such as the confirmation for closing or exiting and for deleting a worktree use the same theme colors as the sidebar and have the same shape as VS Code's dialogs. They dim the whole window and appear in the center.

- Enter presses the focused button (the default button when the focus is not on a button). Esc cancels. Tab cycles only inside the dialog, and the left and right arrow keys move between buttons.
- When a dialog closes, the focus goes back to the tab or the sidebar that had it before.
- You can select and copy the detail text. Pressing Ctrl+C with nothing selected copies the heading and the detail together.
- When two dialogs are due, they appear one after the other. If you close the window while a dialog is shown, the dialog is canceled and the exit confirmation follows.

## Badges and notifications

| Display | State |
|---|---|
| Gray dot | Idle |
| Blue spinner | Working |
| Blinking orange + "Waiting for approval" | Needs an answer to a permission check or a question |
| Green dot | Done (you have not seen that conversation's result yet) |
| Red dot | Error, or code-server stopped |
| Hollow circle | Suspended |

Opening a tab or returning to the window clears unread only for the conversation shown in a visible chat panel or editor. Other conversations stay unread, including another agent's result in the same tab. Switching the panel's agent or conversation clears that conversation's unread mark within a few seconds. If the panel is hidden, still loading, or its conversation cannot be identified, unread marks stay. Clicking a conversation row clears only that row when its conversation can be opened.

When a Claude Code or Codex conversation in a background tab starts waiting for approval, finishes, or fails, an OS notification appears. Notifications also appear when the Worktabs window is inactive. A result behind another chat in the active, focused tab becomes unread without sending a notification.

- Notifications are per conversation, so one arrives even when another conversation in the same tab is working.
- Click a notification to move to its tab and bring that conversation to the front. Clicking it in the notification center after the toast has gone does the same.
- Clicking a notification from before the app was restarted moves to the tab, but does not bring the conversation to the front. If the app has exited, it starts the app.
- When a conversation waits for approval and the window is inactive, the taskbar also flashes.

## Tabs

### Codex approvals

Worktabs prefers **Approve for me** in a new Codex conversation when the extension allows it. To use manual approval, choose **Settings > General > Codex approval for new conversations > Ask for approval**. The preference is shared by Worktabs tabs and survives restarts. Claude's permission setting is separate.

The Codex permission control shows the effective mode. When automatic review is unavailable, the extension normally stays on **Ask for approval**. Resuming a saved conversation keeps its mode. Changing the mode yourself in an open composer takes precedence there; changing the Worktabs setting applies to the next new conversation. Automatic review keeps the sandbox and can deny requests.

### Claude panel

Open the Claude panel with "New session" from the Claude icon (Session Manager) in the activity bar. The conversation history lives in `~/.claude`, so conversations from other VS Code windows and the CLI also appear in the list.

In a tab opened for the first time (such as a new worktree), the app shows the Claude Code chat panel in VS Code's right sidebar. The focus stays in the editor. VS Code first shows its built-in chat there, but it is empty because the AI features are turned off. Tabs where you closed the right sidebar or switched it to another view are left as they are ([architecture.md](architecture.md#helper-extension)).

The chat panel gets the same width as the chat panel of the same repository's primary. When primary is opened for the first time, for worktrees of a repository whose primary has never been opened, and for folders that are not git, the width makes the editor and the chat panel about 2:1. Even when primary is closed (and after the app restarts), the app uses the primary width it remembers. From the second time on, the width stays as VS Code remembers it (the width you set) ([architecture.md](architecture.md#width-of-the-right-chat-panel)).

### VS Code settings

Tabs of worktrees of the same repository share VS Code settings.

- This covers settings (theme, font, and so on), keyboard shortcuts, snippets, and user tasks and MCP settings.
- When you change a setting in one tab, it applies at once to the other running tabs of the same repository. Suspended tabs get it the next time they start. Tabs of new worktrees also start with the same settings.
- Keyboard shortcuts, snippets, tasks, and MCP settings reach other tabs the next time each tab starts (restart or resume from suspension).
- Tabs of different repositories do not share settings. Tabs of folders that are not git have their own settings each.
- Enabled and disabled extensions, panel layout, and command history stay per tab ([limitations.md](limitations.md#vs-code-settings)).

How it works is in [architecture.md](architecture.md#sharing-vs-code-settings).

### Keys

- Ctrl+Alt+PageUp / PageDown moves to the previous or next tab (in the order tabs were opened)
- All other keys (Ctrl+W, Ctrl+Tab, Ctrl+P, and so on) go to VS Code

### Right-click menu

Right-click an open worktree for:

- Restart
- Suspend
- Reload
- Open in File Explorer ("Open in Finder" on macOS)
- This branch's PR (when the remote is GitHub and the branch is not the default branch)
- Copy path
- Developer tools
- Close
- Remove worktree… (not for primary)

Right-click a repository row for: Add worktree… (git repositories only), GitHub (Repository, Issues, Pull requests, Actions; when the remote is GitHub), Open in File Explorer, Copy path, and Close all tabs (when tabs are open). The "Other folders" row shows only Close all tabs.

"Open in File Explorer" and "Reveal in File Explorer" in the right-click menu of VS Code's explorer open a new tab in the frontmost File Explorer window if one is open (windows on another virtual desktop are not used). If none is open, they open a new window.

On macOS, these are "Open in Finder" and "Reveal in Finder", and they open in Finder. They are not grouped into tabs ([limitations.md](limitations.md#macos)).

### Suspend and restore

- Suspending a tab stops its code-server and claude to free memory. Click the tab and it comes back in about 3 seconds, with the open Claude conversation tabs restored along with their content.
- With the `idleSuspendMinutes` setting, unused tabs are suspended automatically ([config.md](config.md)).
- The tabs open last time are restored on the next start. Only the active tab starts; other tabs start when you select them.
- When you reopen a closed tab, it also returns to the screen it had before closing (open files, Claude conversations in editor tabs, the sidebar view, panel sizes). This holds after the app restarts too. Once the worktree is deleted, it can no longer be restored ([architecture.md](architecture.md#code-server)).
- The window's size, position, and maximized state at close (and when moved or resized) are restored on the next start (`window.json` in the data folder). The sidebar width is too ([above](#width)).
  - When the saved position would barely show on any screen, such as after a monitor was unplugged, only the size is restored and the window appears in the center.
  - The size is shrunk to fit the screen it appears on.

## GitHub pages

GitHub pages open in the default browser (only when the remote is GitHub; which hosts count as GitHub is in [architecture.md](architecture.md#github-buttons)).

- Hover over the icon at the left of a repository row (the GitHub logo) for a moment, and buttons for the repository, Issues, Pull requests, and Actions appear right below it. This works in both "Open repositories" and "Other repositories", and also when the row is collapsed.
  - The buttons appear on top of the row below, so other rows do not move. No row is set aside for buttons in each repository, so the list stays compact.
  - Just passing over the icon does not show them (keep the pointer there for 0.3 seconds). This keeps you from pressing a button when you meant to press the row below.
  - They disappear when the pointer leaves both the icon and the buttons. Esc, a click elsewhere, or scrolling also hides them.
  - Clicking the icon expands or collapses the row, like the rest of the row.
  - "GitHub" in the right-click menu opens the same pages. Use it with a pen or touch.
  - For a repository with a red dot on its icon (PRs of your own approved but not merged; see [above](#repositories)), "Approved" and the numbers of those PRs appear under the buttons. Press one to open that PR. The dot only sits on top of the icon, so hovering works the same. In a narrow sidebar, the numbers wrap.
  - They do not appear for repositories known not to be on GitHub (such as GitLab, and repositories with no remote). Even when collapsed, this is known from the remote the main process read (the same as the row icon [above](#repositories)). Only on the first start, before the remotes are read, they appear.
- PR for this branch: open it from the PR number in the worktree row (below) or from the worktree's right-click menu. For a branch without a PR, the branch icon that appears on hover ("Create a PR") opens the page for creating a PR. It does not appear for the default branch or for worktrees with no branch checked out.

### PRs and CI

A worktree row shows the PR icon and number of its branch. The color is the PR state.

| State | Color |
| --- | --- |
| Draft | Gray |
| Open | Green |
| Merged | Purple |
| Closed | Red |

- A PR of your own that is approved but not merged (the same as the dot on the repository icon [above](#repositories)) shows text such as "PR #12 Open, Approved, CI: Successful" on hover.
- To the right of the number is the CI result: ✓ (green) for success, × (red) for failure, ● (yellow) for running.
  - For an open PR (including drafts), it is the CI of the PR's last commit.
  - For a merged PR, it is the CI of the merge commit (the run triggered by the push to main).
  - Closed PRs and PRs without CI show nothing.
- Hover to see the PR title and the name and result of each check (such as `CI / Test (windows-latest): Failed` or `Release / Release (Windows): In progress`). Failed checks come first. More than 10 are grouped as "and 3 more checks". Press to open the PR in the default browser.
- When the same branch has several PRs, the open one is shown, else the newest.
- A worktree made from a PR ([worktrees.md, "Create from a PR"](worktrees.md#creating-from-a-pr)) shows the PR it was made from. This works for PRs from forks too. Until the state is read, or when it cannot be read because gh is missing, only the number shows, such as `#71`.
  - When the remote repository does not have that PR (such as when origin was later changed to another repository), the row shows the PR found by branch name, as for other branches. If there is none, nothing shows. PRs on other rows are not affected.
- Rows without a PR (the default branch, branches with no PR yet, a detached HEAD) show only the CI result of the worktree's HEAD commit. On the main row after `npm version` and push, this is both the CI of the push to main and the Release of the tag push.
  - Hover to see the commit hash and the name and result of each check. Press to open the checks page of that commit.
  - Only runs triggered by pushes to that row's branch are shown. Runs triggered by tag pushes (releases) show only on the default branch row. A branch just made from main has the same HEAD commit as main, but does not show main's CI.
  - When HEAD has not been pushed (is not on GitHub), nothing shows. When HEAD moves forward, CI running on the previous commit no longer shows.
- The CI of the merge commit and of the HEAD commit shows only for a while after the last run (after a check started or finished): 1 hour for success, 1 day for failure and running. This keeps ✓ marks from piling up on old merged PR rows, and keeps results from days ago on a main row you have not pulled. The CI of an open PR always shows.
- Nothing shows for repositories not on GitHub, or without gh or when gh is not signed in.
- The state is reloaded when you expand the repository, when a worktree's branch or HEAD changes, when Claude finishes its work, and when the Worktabs window comes to the front (if 15 seconds have passed since the last read). While a shown CI run is running, it is also reloaded every minute.
  - When Claude pushes, creates a PR, merges, or creates a release (`git push`, `gh pr create`, `gh pr merge`, `gh release create`, and so on), the state is also reloaded 10 and 30 seconds later. Right after a push, GitHub may not have registered the CI yet, so a read may show nothing.

## Claude usage

The bottom of the sidebar labels each provider separately. Both Claude and Codex percentages mean **used**, rather than remaining. Each window fits on one row: period, bar, percentage, and reset time marked with ↻. Both providers use the same labels for 5-hour and weekly windows. Received times are in the hover details, not the normal display. At narrow widths, long reset times are shortened with an ellipsis; hover for the full date and time.

- The bar is orange, and turns red from 80%.
- Hover over a row to see the reset date and time and when the value was received.
- Worktabs reads usage at startup and every 5 minutes, even without an active conversation. Responses in a Worktabs tab also update it immediately. The background read uses the installed extension's CLI and the account signed in on this computer; it sends no message to a model.
- Values are not yet received from Claude in WSL tabs (the WSL wrapper replaces itself with claude, so it cannot see the output). Usage is per account, so if you use Claude in a Windows tab, that value shows.
- The last value is kept in `usage.json` in the data folder. Values older than 15 minutes become unknown; expired limits are removed. The Claude section stays visible while enabled, with "Waiting for refresh" or "Usage unavailable" when no current value is available.
- Background reads use Claude's experimental usage control API. Incompatible versions, API-key accounts, missing authentication or network failures show unavailable usage and retry on the next refresh.

## Codex usage

When Codex is enabled, the sidebar footer also shows **Codex · Used**. Worktabs reads quota at startup and every 5 minutes through a short-lived connection to the installed CLI's app-server, using the account signed in on this computer. No conversation or model turn is started. The extension's notifications and read responses also update usage on Windows, macOS, and WSL; account changes trigger another background read. Sign in with ChatGPT to receive values.

- Only reported windows are shown; absent optional windows do not create empty "Secondary" rows. Window labels use the reported duration, such as "15 min", "5 hours", or "Week". Missing durations use "Primary" or "Secondary". Bucket names appear only when multiple buckets need to be distinguished.
- Percentages show usage. The bar turns red from 80%; a full limit has a bold percentage. Reset times appear on the same row. Hover for each window's full reset date and received time.
- Quotas are account-wide. Tabs report snapshots of the same quota; their percentages are never added together. Older requests cannot replace newer observations. A notification updates its bucket; a full read replaces the bucket list.
- Before data arrives, the footer says "Waiting for usage". Unknown values show a dash rather than 0%, with their status on the same row. After a reset, they say "Waiting for refresh" until another report arrives. After 15 minutes without an update, the percentage becomes unknown and says "Stale usage".
- Background refreshes and routine account notifications keep the last values visible until a successful read replaces them. Failed reads keep those values too, subject to the usual reset and 15-minute stale rules. While account identity is being rechecked, new quota reports cannot replace the displayed values until the same account is confirmed.
- The provider says "Refreshing usage" only while a background read is running. A failed read shows "Usage unavailable", a timeout shows "Usage refresh timed out", and data rejected by the account or snapshot fences shows "Usage refresh rejected", even when an old window remains. These states do not change the old value's received time. Hover over the provider or a window for the last received time, last refresh attempt, and next scheduled refresh. A stale row with no read running is waiting for that next attempt.
- Each background read has a 20-second deadline, including finding the CLI. Account notifications during a read restart identity and quota requests within that deadline. Overlapping refresh requests share one pending retry; the normal 5-minute schedule continues after failures.
- If usage stays stale, inspect `logs/usage-refresh.log` in the data folder. Each JSON line records the provider, attempt and completion times, duration, outcome, failure or rejection category, accepted account/quota event counts, rejected event count, last quota receipt, and next scheduled attempt. This distinguishes a failed acquisition from data that was obtained but could not be applied. The log contains no emails, account identity hashes, tokens, account responses, quota payloads, or raw CLI diagnostics.
- Signing out or confirming a different account clears the Codex values. During a login or logout request, the footer says "Waiting for account". API-key-only accounts say "Usage unavailable with API key". Failed reads without previous values, or successful empty quota reads, show "Usage unavailable".
- The most recently observed account supplies the footer. An account change clears snapshots from other tabs, which must report their account again before contributing. If account identity has not been reported, values are shown conservatively from the latest eligible observation. This is not a comparison of multiple signed-in accounts.
- Codex values are held in memory only. Restarting Worktabs waits for new data. Tokens, account emails, full authentication responses, credits, and reset-credit details are not sent to the sidebar or saved.

## Updating Worktabs

At start and twice a day after it, Worktabs asks GitHub for its newest release. When there is a newer one, "Worktabs <version> is available" appears at the top of the sidebar. "Check for a new version of Worktabs" under "…" asks at once. Builds you made yourself do not ask.

- "Release notes" opens the release on GitHub. "Skip this version" stops offering that version (the menu still finds it).
- "Update" downloads the zip of the release, checks it against `SHA256SUMS.txt`, and extracts it next to the app. The app keeps running meanwhile.
- Then the card says the new version is ready. It installs the next time Worktabs quits. "Restart now" waits until no tab is working or waiting for approval and there are no unsaved edits, then quits and starts the new version. The tabs come back as after any restart.
- After Worktabs quits, a small script waits for it and for everything started from its folder to exit, moves the app aside, moves the new one in, and deletes the old one. If it cannot, the previous version stays, and the card says why at the next start.

It replaces the folder or `Worktabs.app` the app runs from, so the installer and the SmartScreen warning are not needed. On Windows, the entry in "Apps & features" shows the new version, and the uninstaller stays. The app cannot update itself when it cannot write to the folder that holds it (for example, if you installed it under Program Files), or on macOS when it runs from where macOS moved it (start it from Applications after removing the mark, [install.md](install.md#macos-zip)). The card then links to the release page to update by hand.

`updateCheck: false` turns off the checks at start ([config.md](config.md)).

## Updating code-server and extensions

Use **Settings > Extensions** (the gear at the top of the sidebar, or **Extensions and updates** in the update card) to see sources and versions, import desktop extensions or VSIX files, and check for updates. Claude stays on Open VSX by default. Codex uses a user-provided import. Desktop imports need periodic updates in VS Code and re-importing; VSIX imports need newer files. These are local-source checks, not global Marketplace notifications ([extensions.md](extensions.md)). Updates wait for Claude and Codex turns to finish and edits to be saved. If Worktabs cannot see whether Codex is working in a tab, the sidebar asks you to close that tab first. Idle instances stop before shared extensions change.

The app does not update code-server or the extensions (Claude Code and the language pack) on its own. When a new version exists, "Update available" appears at the top of the sidebar.

- Press "Update", and the app first downloads code-server. Then it waits until no tab is working or waiting for approval and there are no unsaved edits, and updates. While it waits, "Cancel the update" cancels it. While it downloads and installs, a moving bar in the card shows that it is still working. The installer reports no percentage.
- Before restarting tabs, the app starts one instance of the new version in the background and checks it: no login screen, the folder opens, the display is in the display language, and Claude Code starts. When code-server itself changes and Codex is installed, it also opens the Codex chat and checks that it starts within 60 seconds without VS Code stopping responding. If these checks fail, it goes back to the previous version.
- Finally, running tabs restart with the new version. Suspended tabs start with the new version the next time you open them.
- Only the one previous version of code-server is kept. To go back by hand, set `codeServerVersion` in the settings file to the previous version and restart.

Why versions are pinned, and how the update works, is in [architecture.md](architecture.md#updates).
