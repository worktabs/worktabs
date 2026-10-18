# Worktabs

An app that starts code-server (VS Code in the browser) for each git worktree and switches between them as tabs of an Electron window. It runs on Windows and macOS (WSL tabs are Windows only). The overview (why it exists, what it does, how to install it) is in README.md, usage, settings, and how it works are in docs/, and the reasons behind the design are in docs/research.md. The English documents are the originals; the Japanese versions are README.ja.md and docs/ja/ (research.md is English only). The documents for contributors (CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md) are in .github/, in English only.

## Layout

The main process's modules are grouped by what they deal with, one folder each under `src/`. Modules marked "testable without Electron" take Electron's objects (windows, views, dialogs, notifications) as arguments from `main.js`.

- `src/main.js`: Electron's main process. Makes the window and its views, and wires the modules below together. Cannot be loaded without Electron
- `src/config.js`, `src/commands.js`, `src/shell-env.js`: The settings file, running commands (and git's messages), and on mac the login shell's environment (Homebrew's PATH and so on) for an app started from Finder and the like
- `src/util.js`: Small helpers several modules share (`sleep`, `oneLine`, `samePath`, `coalesce`, `mapLimit`). `wsl/wsl-agent.js` keeps its own, as it runs inside WSL by itself
- `src/window/`: The window and what the side bar asks of it. Testable without Electron
  - `window-layout.js`: Laying out the views, dragging the side bar's edge, and window.json. `sidebar-width.js`: the side bar's width (minimum, maximum, and the width that fits the window)
  - `menus.js`: The side bar's context menus. `settings-actions.js`: saving settings, adding a repository by hand, and picking extensions. `host-keys.js`: the keys the app keeps from VS Code. `theme.js`: the colors of the VS Code theme in the tab in front. `app-icons.js`: the app's icon
  - `ipc-routes.js`: Registers the main process's IPC channels from a table (`registerIpc`), and checks the types of what a page sent. `ipc-table.js`: the table, with the guards several channels share
  - `message-box.js`: Filling in the options of the app's dialogs, queueing them, and the contents of the worktree removal confirmation (the dialog page is `src/dialog/`)
  - `web-preferences.js`: The webPreferences of every view (`viewPreferences`): context isolation and the sandbox on, Node integration off
  - `control.js`, `control-handlers.js`: The development control port, and its handlers, which take the app's operations and views from `main.js`
  - `dialog-view.js`: Showing the app's dialogs on the dialog page and giving the focus back when they close. `window-close.js`: asking before closing the window when quitting would lose something
  - `view-state.js`: The state the side bar shows, pushed once per burst, and the window title. `theme-state.js`: the theme of the tab in front (theme.json, the window background, the dialog page). `placeholder.js`: the pages shown where there is no VS Code
- `src/tabs/`: Tabs. Testable without Electron
  - `tab-lifecycle.js`: Owns tab identity, order, selection, start and stop transitions, and restore snapshots. Injects views, server managers, dialogs, and persistence from `main.js`. Serializes starts of the same tab ID and ignores stale completions and exits. `startup-gate.js`: holds tab starts until code-server and the extensions are ready
  - `tab-ports.js`: The code-server port of each tab. Remembers the ports of closed tabs too and keeps other tabs off them (VS Code keeps its screen state per port). `tab-store.js`: tabs.json
  - `tab-close.js`: When closing tabs together ("Close all tabs" on a repository row), which tabs to close and which tab to move to. `tab-risks.js`: what stopping a tab would lose, asking before it, and suspending idle tabs
  - `helper-client.js`: Calls to the helper extension in each tab's VS Code
  - `tab-view.js`: A tab's view: new windows become tabs or browser links, host keys go to the app first, the chat frames get their scripts, and a crashed page shows an error
- `src/conversations/`: The agents' conversations and their chats. Testable without Electron
  - `hooks.js`: Receives Claude Code's hooks (`HookServer`). `conversation-store.js` keeps Claude and Codex conversation state without runtime work; `claude-observer.js` attaches local process and Claude transcript observation. `SessionTracker` in hooks.js preserves the combined API. `hook-events.js` hands what the hook server reports to the store and the usage trackers
  - `session-notices.js`: Notifications of conversation states, and clicks on them. `notifications.js`: the XML of notification toasts, and the arguments a click passes to the app (tab and conversation). `session-risks.js`: what a conversation would lose if its tab stopped
  - `first-conversation.js`: Starts the selected agent's first task conversation. Codex drafts use a guarded native editor input path, bounded retries, and a copy-task recovery dialog. `conversation-navigation.js`: confirms a Codex row click against the visible mounted thread context, with a deadline and cancellation. `conversation-opening.js`: brings a conversation to the front. `seen-conversations.js`: which conversations are in view, for unread results
  - `secondary-sidebar.js`: A script that reads what the right side bar of a tab's VS Code shows, and how to wait until it can be read. If it shows VS Code's built-in chat, the helper extension replaces it with the Claude Code chat panel. Also the width of the chat panel in a tab opened for the first time (the primary width, or 2:1), the script that sets it by dragging the sash, and how the primary width is remembered (`ChatWidths`). `chat-panel.js` does these in a tab; `chat-frames.js` finds the agents' chat frames
  - `webview-react.js`: Bounded mounted React and element-prop discovery shared by visibility, Codex approval, and onboarding probes, with serialization for injected scripts
- `src/agents/`: The agent providers (Claude Code, Codex), their CLIs and onboarding, and their usage
  - `usage.js`: Claude's usage (the 5-hour and weekly limits). Receives the `rate_limit_event` that claude-wrap.exe picks up from claude's output. `usage-polling.js`, `usage-refresh.js`: reading it again on a schedule
  - `mac-claude-wrap.js`: The claude wrapper on mac (the counterpart of claude-wrap.exe), and `installWrapper`, which writes it out at start. Testable without Electron
- `src/codex/`: Codex's approvals, events, quota, and usage, and the launcher (`codex-wrap.js`). `codex-launch.js` copies `codex-wrap.js`, `codex-events.js`, and `codex-quota.js` out together, so those three require only one another
- `src/repos/`: Repositories, worktrees, GitHub, and cloning
  - `worktrees.js`: Lists repositories, and lists, adds, and removes worktrees (calls git, ghq, and Orca). The repository list and its cache (repos.json) are in `repo-catalog.js`, and the files a new worktree gets from `.worktreeinclude` in `worktree-include.js`; `worktrees.js` exports their names too. `worktree-removal.js`: removing a worktree and its branch
  - `repository-service.js`: Owns repository caches, source refreshes, GitHub visibility and owned repositories, approved PR refreshes, and ordered sidebar snapshots. Readers and persistence are injected. Testable without Electron
  - `github.js`: Where a git remote is (GitHub, GitLab, Bitbucket; SSH aliases are resolved with `ssh -G`), and GitHub pages, PRs, CI, visibility, and the repositories of the accounts and orgs gh is signed in to. `github-client.js` runs git, ssh, and gh for them; `github-remote.js` (where a remote's address points) and `github-queries.js` (the queries GitHub is asked and reading the answers) run no commands. `github-pages.js`: opening a folder's GitHub pages, and its branches' PRs and checks for the worktree rows
  - `clone.js`: The account's repositories that are not cloned (matching them against the remotes and folders in the list, ordering by owner), and cloning them (ghq or git, destination candidates, the command line, explaining failures). `clone-coordinator.js`: where an account's repository can be cloned (here and the WSL distributions), starting a clone, the dialog that asks where, and putting the cloned repository in the list. Testable without Electron
  - `task.js`: The "issue, PR, or task" field of the add-worktree dialog. Reads issues and PRs with gh, has `claude -p` think of a branch name (a PR uses its own branch), and builds the prompt put in the new conversation's input box
  - `worktree-adding.js`: The add-worktree dialog, and adding the worktree and opening it with its first conversation
- `src/code-server/`: code-server, the extensions, and their updates
  - `code-server.js`, `install.js`, `updates.js`: Starting, downloading, and updating code-server and the extensions. `extension-index.js` reads the active extension inventory for local and WSL callers. `code-server-launch.js` owns common launch policy, preparation, readiness, and shared helpers. `code-server-instances.js` (`InstanceManager`) keeps the running instances of both managers (this one and `code-server-wsl.js`), stopping them and which exits count
  - `code-server-wsl.js`: Downloading, starting, and stopping code-server (the Linux build) for WSL tabs, and syncing the extensions. It copies `src/wsl/wsl-agent.js` and `src/wsl/wsl-claude-wrap.sh` into WSL
  - `app-updates.js`: Checking for updates and applying them. `update-probe.js`: the hidden instance that tries new versions out. `update-coordinator.js`, `update-strategies.js`: update transaction ownership, idle waiting, cancellation, tab pause/resume, and gallery restoration. Imports retain their snapshot transaction in `extension-imports.js`; `extension-management.js` selects and stages them. Testable without Electron
  - `settings-sync.js`, `jsonc.js`: The VS Code settings shared by the tabs of one repository's worktrees (import, write, migration), and reading and writing JSON with comments
  - `server-registry.js`: The code-server manager for each folder (the local one, and one per WSL distribution). `startup-preparation.js`: making code-server, the claude wrapper, and the extensions ready at start, step by step on the empty page
- `src/wsl/`: `wsl.js`: WSL paths (`\\wsl.localhost\<distro>\...` and Linux paths), and running commands inside WSL. `wsl-agent.js`, `wsl-claude-wrap.sh`: the agent and the claude wrapper written into WSL and run there. The agent runs only on Linux (it reads `/proc`)
- `src/i18n/`: The language of the app's own UI, and `t()`, which puts an English UI string into it. `ja.json` is the Japanese, keyed by the English text; `translate.js` is shared with the pages, and `page.js` makes a page's `t()` and fills in its HTML (`data-i18n`). Testable without Electron
- `src/sidebar/`: The sidebar's page (renderer). `model.js` contains pure tree and row selectors, and `pulls.js` the PRs and checks the worktree rows show; `data.js` coordinates worktree, GitHub, and PR reads and polling. These are testable without a DOM. `icons.js` (the SVG icons and logos), `rows.js`, `uncloned.js` (the section of repositories not cloned), `github-bar.js`, `update-card.js`, `usage-footer.js`, `resize.js` (dragging the edge), and `page-theme.js` are parts that `sidebar.js` creates with its state and elements; they are tested with the fake DOM in `test/support/sidebar-dom.js`
- `src/dialog/`: The page of confirmation and warning dialogs, the add-worktree dialog (`dialog/add-worktree.js`), and the clone destination dialog (`dialog/clone.js`). Drawn in theme colors on a page laid over the whole window. `dialog/keys.js` (keys) is testable without Electron
- `helper-extension/`: The helper extension installed into code-server. `extension.js` cannot be loaded without VS Code, so put what you want to test in separate files (`location.js` and so on)
- `native/ClaudeWrap.cs`: The wrapper that starts claude (claude-wrap.exe). Built with the csc.exe that comes with Windows. The mac one is `src/agents/mac-claude-wrap.js` and the WSL one is `src/wsl/wsl-claude-wrap.sh`. All three take the same command line and share the test fixture (`test/wrap-fixture.js`)
- `scripts/smoke-check.js` (`npm run smoke`): Starts the whole app on Linux under Xvfb and checks its main flows through the development control port (see "How to verify")
- `scripts/dev-*-check.js`: Scripts that drive a running app through the development control port to check it (Windows only). The port's handlers are in `src/window/control-handlers.js`
- `cliff.toml`, `scripts/changelog.js`, `scripts/release-notes.js`: Building `CHANGELOG.md` from the commit prefixes with git-cliff (from `npm version`), and taking the release notes out of it (from `release.yml`)
- `scripts/translations.js`: Lists the Japanese documents that are behind their English originals, and the UI strings with no Japanese (`npm run translations`)
- `docs/translations.md`: The shared workflow for bringing the Japanese documents and UI strings up to date
- `.claude/skills/sync-ja/`: The Claude Code skill that points to the shared translation workflow
- `test/`: Unit tests (node:test)
- `docs/`, `docs/ja/`: Documents for users and developers (usage, worktrees, WSL, settings, limitations, how it works, development, design background). The list is under "Documentation" in README.md

## Agent setup

In a new agent session, install the package-lock dependencies before running checks:

```sh
npm ci --no-audit --no-fund
```

This is enough for the unit tests and syntax check. The app itself, Electron, code-server, and the installer still need a local Windows or macOS machine.

Use the source-running steps in docs/development.md only when you need to start or package the app:

```sh
node node_modules/electron/install.js
npm run build:native
npm start
```

Claude Code remote sessions also run `.claude/hooks/session-start.sh`, which performs the same dependency install as a convenience. Do not rely on that hook as the only documented setup path; keep shared agent setup here.

## How to verify

On any environment:

```sh
npm test        # unit tests
npm run check   # syntax check of every .js file
npm run lint    # ESLint (eslint.config.js)
npm run typecheck  # tsc on the JavaScript and its JSDoc (jsconfig.json, and one per page)
npm run coverage  # unit tests with coverage; fails below the thresholds in package.json
```

- On Linux, `npm run smoke` also starts the whole app (Electron under Xvfb, with the Linux build of code-server) and drives its main flows through the development control port. Run it for changes to `main.js`, the pages, or the code-server managers, on `main` too to compare. Its setup is under "Smoke check on Linux" in docs/development.md.
- In the cloud environment (Linux), the unit tests, the syntax check, and the smoke check are what can be checked. Windows and macOS themselves, WSL tabs, the exchange with the real Claude Code and Codex extensions, claude-wrap.exe, and the installer can only be checked on a real machine.
- Check a fix that touches both Windows and mac on both. If you checked it on only one, say so in the PR.
- When fixing logic, move it into a form that does not depend on Electron or VS Code, and write tests.
- Write what can only be checked on a real machine in the PR as checklists under "To verify on Windows" and "To verify on mac".
- Tests that use git create a real repository in a temporary folder with `makeRepo` in `test/support.js`. Write them so they pass on Windows too (build paths with `path`).
- CI (`.github/workflows/ci.yml`): `npm run check` on Ubuntu and Windows, `npm run coverage` on Ubuntu and `npm test` on Windows, `npm run lint`, `npm run typecheck`, and `npm audit --omit=dev --audit-level=high` on Ubuntu, `npm run smoke` on Ubuntu, and `npm run pack` on Windows. Every pull request runs it, because main requires its check to pass; a push to main that changes only documentation (docs/ and .md files such as the README) does not.
  - For now, because of the Actions budget, the Windows and macOS CI are stopped and only Ubuntu runs (docs/development.md). Run the Windows and macOS tests locally before merging.
- Dependabot (`.github/dependabot.yml`) opens a pull request a week for the npm packages' minor and patch updates and one for the GitHub Actions; each major update comes on its own. Run a major Electron update on Windows and macOS before merging it.
- macOS CI (`.github/workflows/mac.yml`): `npm run check`, `npm test`, `npm run pack:mac`. macOS minutes cost 10 times as much, so it does not run on push; it runs every night, only when the head of main has not been checked on macOS yet. For a PR that touches the mac side, run it by hand with `gh workflow run mac.yml --ref <branch>`.
- Release (`.github/workflows/release.yml`): pushing a `v*` tag builds the Windows installer and zip and the macOS zip, and publishes them on GitHub Releases. The release notes come from `CHANGELOG.md`. The steps are in docs/releasing.md.
  - For now, because of the Actions budget, tags are not pushed; the Windows zip and installer are built locally and handed out. After bumping the version, push only main, and keep the tag only on the machine that bumped it ("Build locally and hand out for now" in docs/releasing.md).

## Rules

- Comments in code are in English. Match the style of the comments around them (why, rather than what).
- Commit messages, PRs, and issues are in English, in short sentences of plain English.
  - Commit and PR titles start with a Conventional Commits prefix (`feat:`, `fix:`, `docs:`, and so on). The CHANGELOG and the release notes are built from them. The rules are in .github/CONTRIBUTING.md.
  - After the prefix, the first line of a commit says what it fixes or what it makes possible, in the imperative mood (for example, `feat: add and remove worktrees from the sidebar`). The body is a bulleted list of the reasons and of what changed in how to verify it.
  - Write the issues to close as `Closes #number`.
- The documents are written in English first (README.md, docs/, .github/), in short sentences of plain English. Updating the Japanese versions (README.ja.md, docs/ja/) is optional, and they may lag behind. Do not update them unless asked; when asked, follow docs/translations.md. When an English change needs no Japanese one (a typo, a UI label the Japanese page has in Japanese), add the line `Translation: not needed` to the commit message.
- `npm run typecheck` checks the code with TypeScript (no build step; the code stays JavaScript). Give the shapes tsc cannot infer JSDoc types (`@param`, `@typedef`, `/** @type {...} */`), especially options objects and what main.js injects. Assign a class's fields one by one rather than with `Object.assign(this, options)`, which tsc cannot see. Do not silence it with `@ts-ignore` or `@ts-nocheck`. The sidebar and the dialog pages are separate projects (`src/sidebar/jsconfig.json`, `src/dialog/jsconfig.json`), which list their scripts in the page's order; `globals.d.ts` beside them declares what their preloads expose and the names their files share. Add a new page script to both the page's index.html and its jsconfig.json. `helper-extension/`, `scripts/`, and `test/` are not checked yet.
- If you change anything in `helper-extension/`, bump `version` in `helper-extension/package.json`. The app uses the version to decide whether to reinstall it in each tab's VS Code.
- Write UI text in English, as a string literal passed to `t()` (`src/i18n/`; "UI language" in docs/architecture.md). Make each sentence one string, with `{name}` placeholders, rather than joining parts. Adding its Japanese to `src/i18n/ja.json` is optional, as for the documents. In a page's HTML, write the English in `data-i18n` (or `data-i18n-title` and the like).
- If you change behavior, also update the matching page in docs/. Keep the README to an overview and write the details in docs/.
