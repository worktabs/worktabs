# Development

**English** | [日本語](ja/development.md)

The source layout for agents is in [AGENTS.md](../AGENTS.md), and how it works is in [architecture.md](architecture.md).

## Agent sessions

In a new agent session, install the dependencies from `package-lock.json` before running checks:

```sh
npm ci --no-audit --no-fund
```

This is the shared setup path for Codex, Claude Code, and other agents. It is enough for `npm run check` and `npm test`. Claude Code remote sessions also run `.claude/hooks/session-start.sh`, which does this install automatically as a convenience, but the documented setup lives here and in [AGENTS.md](../AGENTS.md).

## Run from source

```sh
npm install
node node_modules/electron/install.js   # Electron 44 downloads its binary on first install
npm run build:native                    # builds the Windows wrappers and helper extension VSIX (uses csc.exe and tar.exe bundled with Windows). On macOS, only the VSIX
cp config.example.json config.local.json
npm start
```

- Use Node.js 22 or later. `.nvmrc` names the version CI uses (`nvm use` or `fnm use` picks it up), and `.editorconfig` sets the indentation and line endings for editors that read it.
- Use these steps when you need the Electron app, code-server, native wrapper, helper VSIX, installer, or local manual UI checks. Agent-only code and documentation changes usually need only the setup and tests above.
- Put your own repositories in `repos` in `config.local.json`. This file differs per environment, so it is not in git. To put it elsewhere, set its path in `WORKTABS_CONFIG`. The available keys are in [config.md](config.md).
- When you start the app from Claude Code (the VS Code extension), the `ELECTRON_RUN_AS_NODE` environment variable is inherited and Electron runs as Node. Run `unset ELECTRON_RUN_AS_NODE` first (or use `env -u ELECTRON_RUN_AS_NODE npm start`).
- How to build the installer and the zip is in [install.md](install.md).

## App icon

The Worktabs mark is three stacked editor windows in a Tokyo Night-inspired blue and violet palette. It belongs to Worktabs and does not use an agent provider's logo.

Edit `build/icon.svg`, then run `npm run build:icons`. This generates the light variant, the multi-size Windows ICO and macOS ICNS, the runtime PNGs in `src/assets/`, and `docs/images/social-preview.png` (1280 × 640, for the repository's social preview). Commit the generated files with the SVG. Building or installing the app does not need to regenerate them.

The executable, installer, and macOS bundle use the dark icon. While Worktabs runs, its macOS Dock icon and Windows window icon follow the OS light or dark appearance. Windows uses the system appearance, which can differ from its app appearance. This is independent of the active VS Code theme. Windows shortcuts and pinned taskbar entries may keep the packaged icon. The README has dark and light variants too.

This uses PNGs for runtime changes and a static ICNS for the macOS bundle. It does not use Icon Composer or change the Finder icon with the appearance. Check the small sizes and both appearances on Windows and macOS after editing the artwork.

## Tests

```sh
npm test        # unit tests (test/*.test.js, node:test)
npm run check   # syntax check of every JavaScript file
npm run lint    # ESLint with its recommended rules (eslint.config.js)
npm run typecheck  # TypeScript checks the JavaScript and its JSDoc types (jsconfig.json)
npm run coverage   # the unit tests with coverage; fails below the thresholds in package.json
```

- The tests cover the modules that work without Electron or VS Code (`src/conversations/hooks.js`, `src/agents/usage.js`, `src/repos/worktrees.js`, `src/repos/github.js`, `src/repos/clone.js`, `src/conversations/notifications.js`, `src/repos/task.js`, `src/wsl/wsl.js`, `src/wsl/wsl-agent.js`, `src/code-server/code-server-wsl.js`, `src/code-server/settings-sync.js`, `src/code-server/jsonc.js`, `src/window/theme.js`, `src/conversations/secondary-sidebar.js`, `src/window/sidebar-width.js`, `src/window/message-box.js`, `src/dialog/keys.js`, `helper-extension/location.js`). They also run on Linux, so you can use them in cloud environments such as Claude Code on the web.
  - The tests of the WSL agent (`src/wsl/wsl-agent.js`), apart from file operations and watching, run only on Linux (they read `/proc`). On Windows, run `node --test test/wsl-agent.test.js` inside WSL.
  - The tests of the claude wrappers wrap a process that stands in for claude, and check that the output passes through unchanged and that `rate_limit_event` is sent. They share the fixture `test/wrap-fixture.js`.
    - `test/claude-wrap.test.js` (Windows) builds `native/ClaudeWrap.cs` into a temporary folder and tests it.
    - `test/mac-claude-wrap.test.js` (everything but Windows) runs `src/agents/mac-claude-wrap.js` through the same sh script the app writes out. It also runs on Linux, so it runs in CI too.
  - The release notes test (`test/release-notes.test.js`) has git-cliff (installed with npm) build `CHANGELOG.md` in a repository in a temporary folder, and checks the grouping in `cliff.toml` and extracting the release notes from it.
  - Sidebar renderer tests load the scripts listed in `src/sidebar/index.html` together, in page order, with a small DOM fixture. Their timers reject invalid browser receivers. A GitHub repository scenario covers pending CI reads, startup and agent badge changes, archive clicks, and returning archived conversations. These checks run in `npm test` and CI. The fixture does not check Chromium layout or native input; keep the local Electron checks below.
- GitHub Actions tests on Ubuntu and Windows for each PR and each push to main, and runs `npm run pack` on Windows (`.github/workflows/ci.yml`).
  - On Ubuntu it also runs `npm run typecheck`: TypeScript's checker (`tsc`) over the JavaScript and its JSDoc types, with `jsconfig.json` for the main process and one project for each page (`src/sidebar/jsconfig.json`, `src/dialog/jsconfig.json`).
  - On Ubuntu the tests run as `npm run coverage`: Node's coverage of `src/` and `helper-extension/`, which fails the run when the lines, branches, or functions covered fall below the thresholds in `package.json`. Raise them when the coverage goes up; lower them only for a reason the PR gives.
  - On Ubuntu it also runs `npm audit --omit=dev --audit-level=high`: a high or critical advisory in the packages the app ships fails the run. The development tools' advisories do not, as they never reach a user's machine.
  - On Ubuntu it also runs the smoke check (`npm run smoke`, below). Electron's binary and the Linux build of code-server are cached (code-server by its version), so only the first run after a change of either downloads them. When the smoke check fails, the run keeps the app's and code-server's logs as the `smoke-logs` artifact.
  - A push to main does not run it for documentation-only changes (docs/, README.md, README.ja.md, AGENTS.md, CLAUDE.md, CHANGELOG.md, and CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, and the issue and PR templates in .github/), because the tests do not read them and they are not part of the app. Every pull request runs it, even one that changes only documentation: main takes only pull requests whose `Test (ubuntu-latest)` and `Test (windows-latest)` checks passed, and a check that never runs would keep the pull request waiting.
  - A new push to a PR cancels the previous run that is still going. Pushes to main run to the end for every merge commit (the sidebar shows that CI on the row of the merged PR).
- Dependabot (`.github/dependabot.yml`) checks the npm packages and the GitHub Actions every week. The minor and patch updates of each come as one PR; each major update comes as a PR of its own. Run a major Electron update on Windows and macOS before merging it.
- On macOS, a nightly run a little after 3:00 (Japan time) tests the head of main and runs `npm run pack:mac` (`.github/workflows/mac.yml`).
  - It does not run on push. GitHub rounds each job up to whole minutes and counts macOS minutes at 10x, so even a job that ends in 20 seconds counts as 10 minutes.
  - If the head of main has already been tested on macOS (the night before or by hand), it does not run. Checking that takes about a minute on Ubuntu.
  - To test a PR on macOS, run `gh workflow run mac.yml --ref <branch>`.
  - Releases test on macOS separately before building ([releasing.md](releasing.md)).
- Every job is cut off after 10 minutes. Otherwise a test that never ends keeps running up to GitHub's limit of 6 hours.
- The tests cannot check the UI, code-server, or the interaction with the Claude Code extension. Check those on a real Windows or macOS machine with the development checks below. The smoke check below runs the whole app on Linux, for the main flows.

## Smoke check on Linux

`npm run smoke` (`scripts/smoke-check.js`) starts the whole app on Linux, Electron under Xvfb with the Linux build of code-server, and drives it through the development control port: it opens a tab and loads VS Code, adds a worktree (with a file from `.worktreeinclude`) and removes it with its branch, clones a repository of the account, opens the message, Settings, Extensions, add-worktree, and clone dialogs, calls the side bar's IPC channels, checks a code-server that ends on its own, suspends a tab, and checks that no code-server is left after quitting. Each step prints `PASS` or `FAIL`; it exits with 1 when one fails.

CI runs it on Ubuntu for each PR. Use it locally for changes the unit tests cannot see (`main.js`, the pages, the code-server managers) where there is no Windows or macOS, as in a cloud session. Run it on `main` too: when a step fails, it shows whether the change broke it or the step already failed. It does not replace the checks on a real machine: Windows and macOS themselves, WSL tabs, notifications, and the real Claude Code and Codex extensions.

```sh
sudo apt-get install -y xvfb            # or run where a DISPLAY is set
node node_modules/electron/install.js   # Electron's binary
npm run smoke                           # -- --offline leaves out the clone; -- --keep keeps the folder
```

- Nothing of your own is used. It works in a new folder (`$TMPDIR/worktabs-smoke`, or `--work <folder>`) with its own data folder, settings file, and git repositories, and puts stand-ins on `PATH` for gh (signed in to github.com, with octocat/Hello-World as its own repository) and ghq (listing one repository). The Claude Code extension is an empty stand-in under its id, since Open VSX may be out of reach.
- code-server is downloaded once into `~/.cache/worktabs-smoke` (`--cache <folder>`). The clone step clones github.com/octocat/Hello-World; `--offline` leaves it out. The control port is 47831 (`--port <n>`).
- When a step fails, the folder stays, with the app's log (`app.log`) and code-server's logs (`data/logs/`).
- Behind a proxy, Electron's download needs `ELECTRON_GET_USE_PROXY=1` and `GLOBAL_AGENT_HTTPS_PROXY` (set it to the proxy's address); curl takes `HTTPS_PROXY`.
- Under Xvfb, a drag of the side bar's edge with the mouse ends at once (Chromium sends a move without the button as the view grows), so the check presses the edge with the mouse and drags it through IPC.

## Verify Codex conversation state

Use the [Codex verification matrix](codex-verification.md) to record the platform, extension versions, provider choices, failures, and lifecycle results. An offline fixture passing does not complete the signed-in official-extension checks.

Run `npm run build:native` after changing the helper extension or a Windows launcher. Enable Codex in the app's agent settings and open a tab with the Codex extension signed in. The app manages the extension's CLI path in that tab. Branch suggestions also use the selected agent extension's bundled CLI, not a CLI on PATH.

Automated tests cover the protocol adapter, concurrent approval requests, interruption, process ownership, pipe forwarding, and stop risks. The following checks also need the real extension and a Windows or macOS machine:

- Run a turn, switch to another tab, and check the working badge, conversation row, elapsed time, and top counter.
- Make the turn request command, file, or permission approval. Check the waiting badge, counter, notification, and next-waiting navigation. The conversation opened must be the one requesting approval.
- Keep two conversations waiting at once. Answer one and check that the other stays waiting. Reject or interrupt a turn and check that its waiting state clears.
- Finish a background turn and trigger a failed turn. Check the done/error badge, notification, unread result, and notification click. Open the result and check that unread clears.
- Attempt close, suspend, and restart while a conversation works or waits. Each must warn, including when another conversation in the tab has an error. Automatic suspension must leave busy tabs running.
- Keep two Codex threads in one tab. Click each row and check that the chat sidebar shows that exact thread, without creating editor tabs.
- Suspend or stop the tab and check that wrapper processes disappear but used Codex threads remain as idle history rows. Restart Worktabs and click a saved row before the helper registers; it must open that thread after startup.
- Hide an idle Codex row with Worktabs's archive button and restart; it must stay hidden. Send a new prompt from Codex history to bring it back. Archive or delete a thread from the running Codex extension and check that its saved row disappears.
- Try a missing thread and a tab without the Codex extension. Check that a warning and sidebar fallback replace silent failure.

On Windows, repeat the state and navigation checks in a WSL tab. On macOS, check the shell launcher and notification clicks while the app runs. The Windows launcher has a test that kills it and checks that its app-server process tree stops. The CLI override and sidebar URI handler are extension integration points, so repeat the checks when updating Codex.

For the Codex approval preference, unit tests cover both inspected picker shapes, unavailable and restricted options, unknown capability, rejected selections, config persistence, explicit choices, history navigation, and update/downgrade detection. Real-extension checks are still needed:

### To verify on Windows

- [ ] Start a new conversation with a supported extension and check **Approve for me**. Request an action outside the sandbox and verify that the automatic reviewer runs and its denial remains effective.
- [ ] Save **Ask for approval** in Worktabs settings. Check a new conversation, another worktree tab, tab reopening, and Worktabs restart. Check that an existing conversation and an explicit composer choice keep their mode.
- [ ] Repeat in each matching WSL extension/runtime. Try an older extension, a restricted account, and restoration of a previous extension version. Check manual fallback and successful history navigation without an extra user turn.

### To verify on mac

- [ ] Start a new conversation with a supported extension and check **Approve for me**. Request an action outside the sandbox and verify the actual reviewer, including denial and error behavior.
- [ ] Save **Ask for approval**. Check a new conversation, another worktree tab, reopening, and restart. Preserve existing conversations and explicit choices.
- [ ] Try an older extension, a restricted account, and previous-version restoration. Check manual fallback, history navigation, and no extra user turn.

The preference uses an internal extension UI integration point. Repeat these checks after changing the imported Codex version. A failed or unknown picker leaves the extension's mode intact; it never changes global Codex configuration.

An optional integration test starts an isolated Electron app and code-server with an offline extension fixture. It checks sidebar routing without new editor tabs, two threads, metadata after restart, queued startup clicks, suspension, and archive marks. It also checks direct child-thread navigation, subagent labels, and recovering a missing child completion from its parent's collaboration status without leaving a green unread badge or a spinner. Build the helper first, then set `WORKTABS_TEST_CODE_SERVER_DIR` to a locally extracted code-server release and run `node --test test/codex-navigation.test.js`. For example, on PowerShell:

```powershell
npm run build:native
$env:WORKTABS_TEST_CODE_SERVER_DIR = 'C:\path\to\code-server'
node --test test/codex-navigation.test.js
```

Without that environment variable, the test is skipped. The fixture does not log in or send inference requests. It verifies Worktabs and code-server navigation, not the official Codex extension's thread content or approvals. Keep the real-extension checks above as well.

With the same setup, run `node --test test/startup.test.js` to check startup with an empty extension directory and a deliberately paused installation. It checks early tab opens, switching, closing and reopening, saved history, and installation failures. The success cases start real code-server processes and verify the helper, chat sidebar, and VS Code language. Set `WORKTABS_TEST_LANGUAGE_PACK_DIR` to a locally installed `ms-ceintl.vscode-language-pack-ja` extension directory to include the Japanese case. The test uses isolated app data and empty agent homes. It installs the built helper and offline chat fixture without downloading agent extensions. Repeat the startup checks with the official agent extensions on Windows and macOS, in both UI languages.

## Development checks

The unread checks need real agent extensions as well as the unit tests in `test/seen-conversations.test.js`. Repeat them after updating either extension; unknown composer shapes retain unread marks.

### To verify on Windows

- [ ] With Claude in view, a Codex result in the same tab stays unread. Switching to its Codex thread clears only that result. Repeat with the agents swapped and in WSL.
- [ ] With two unread conversations of one agent, showing one clears only that one. Switch between already loaded conversations inside the panel.
- [ ] Click a green conversation row and check that only that row clears. Failed navigation keeps the result unread.
- [ ] Hide the chat, then open the tab or focus the window. Unread stays. Show a Claude conversation in an editor and check that only its result clears.
- [ ] A completion in another chat of the active, focused tab becomes unread without a notification. Background tabs and an inactive window still send notifications.

### To verify on mac

- [ ] Repeat the Windows checks above, except WSL. Check both agent panels, history switches, hidden chat, editor chat, row clicks, window focus, and notifications.

### Webview compatibility checks

Unit tests share mounted and alternate React fixtures across visibility, approval, and onboarding probes. They cover thread switches, replaced or detached DOM nodes, missing roots, malformed trees, traversal limits, serialized scripts, reinjection, and late results after disposal. Repeat the real-extension checks after updating or restoring either agent extension.

- [ ] On Windows, repeat visibility, history, approval selection and confirmation in local and WSL tabs. Check restricted or unsupported approval shapes and confirm that the extension's automatic reviewer still applies. Replace or reopen the chat panel during setup.
- [ ] On macOS, repeat the local checks, including panel replacement and a Worktabs restart. Unknown extension shapes must preserve unread marks and the extension's current mode.
- [ ] On both platforms, open a linked worktree before and after its primary worktree. Only the linked worktree skips the known onboarding walkthrough, through its completion callback. The primary worktree's onboarding remains independent; unrelated authentication pages stay usable.

These scripts drive the running app through the development control port and check it (Windows only; the control port itself also opens on macOS).

- Setting `WORKTABS_CONTROL_PORT` (or `controlPort` in the settings) opens the development control port. Do not set it in normal use.
  - Each request needs the token the app generates at start. The app writes it to `control-token` in its data folder, readable by your user only, and `scripts/dev-lib.js` reads it from there (set `WORKTABS_DATA_DIR` for the scripts as for the app). A script that starts the app itself can choose the token with `WORKTABS_CONTROL_TOKEN` instead.
  - The port refuses requests from web pages (with an `Origin` header) and under any host name other than `127.0.0.1` or `localhost`.
  - If the port cannot be used, the app does not stop; it runs without the control port (stderr shows `control port <number>: listen EADDRINUSE ...`). Port ranges reserved by some software may not show in `netstat` or in `netsh int ipv4 show excludedportrange` (on the development machine, 44620–48715 could not be used, and 47821 was in that range).
- To develop while using an installed Worktabs, set a different data folder with `WORKTABS_DATA_DIR`. With the same data folder, the single-instance lock makes the new app exit.
- With `WORKTABS_HIDDEN=1`, the app starts without showing its window (for checks through the control port; screenshots are not possible).
  - In a hidden window, mouse moves reach the page with a long delay (Chromium sends mouse moves in step with rendering, and it does not render hidden pages). Run the checks that move the mouse (`dev-sidebar-width-check.js`, `dev-close-all-check.js`) with the window shown.
  - In a hidden window, dialog answers do not reach the app either, because the dialog page sends the answer on the next frame after a button is pressed (`answer` in `src/dialog/dialog.js`). Run the checks that answer dialogs (`dev-close-all-check.js` and others) with the window shown.
- Use a short path for the data folder. With a long path (such as a folder over 120 characters like Claude Code's scratchpad), Chromium cannot open the webview cache (Cache Storage), and the Claude panel goes blank. A junction with a short name (`mklink /J`) also works.
  - If the path of the opened folder has `\c` followed by something other than a letter (such as `\claude\c--...` in the scratchpad), code-server's file watcher (parcel) stops with a regular expression error (`regex_error`) (in `remoteagent.log` under `logs\`).
- The checks run in either UI language. Where they expect the app's text, they ask the app which language it runs in (`language` on the control port) and take the text from `src/i18n/` (`appText` in `scripts/dev-lib.js`).

```sh
WORKTABS_CONTROL_PORT=47821 npm start
WORKTABS_DATA_DIR=<another folder> WORKTABS_CONFIG=<settings file> WORKTABS_HIDDEN=1 WORKTABS_CONTROL_PORT=47821 npm start   # start alongside the installed version
node scripts/dev-github-check.js <folder> [<folder> ...]                          # GitHub button, and the PR and CI on rows (does not open a browser)
node scripts/dev-check.js <another worktree> <worktree to send the prompt to> "<prompt>"   # badge transitions
node scripts/dev-conversations-check.js <another worktree> <worktree to start conversations in>       # rows per conversation (a conversation that finished while the other was working, bring to front, close)
node scripts/dev-behind-check.js <worktree>                                         # conversations behind the right panel (switch from the row, archive, back to the list on a prompt)
node scripts/dev-focus-check.js <worktree>                                          # the right panel and the chat in an editor tab do not steal focus from each other
node scripts/dev-suspend-check.js <tab name>                                            # suspend and resume
node scripts/dev-resume-content-check.js <tab name>                                     # restoring conversation content
node scripts/dev-reopen-check.js <folder> [<another folder>]                            # reopen a closed tab (same port, files that were open; a tab of another folder does not take that port)
node scripts/dev-chat-view-check.js <folder never opened in the app>                     # the right sidebar switches from the built-in chat to Claude Code (focus does not move). A closed right sidebar stays closed when reopened
node scripts/dev-chat-width-check.js <folder to create a repository in>                          # width of the right chat panel in a newly opened tab (2:1 for primary, the primary's width for a worktree; from tabs.json even after the primary is closed; a width you changed stays after reopening). Creates a repository, and adds and removes two worktrees. In a narrow window 2:1 becomes 300 pixels, so run it with a wide window
node scripts/dev-unsaved-check.js <tab name>                                            # detecting unsaved edits (with auto save off)
node scripts/dev-update-check.js <tab name> [--idle]                                     # update flow (in a data folder with an old version installed)
node scripts/dev-settings-check.js <main worktree> <another worktree of it>                 # sharing VS Code settings (running, suspended, new worktree, removal; in a test repository; adds and removes one worktree)
node scripts/dev-dialog-check.js <tab name>                                              # dialogs (keys, queueing, focus return, closing while shown)
node scripts/dev-sidebar-width-check.js                                             # sidebar width (overlay while dragging, tabs following, min and max, double-click; also window.json if WORKTABS_DATA_DIR is set)
node scripts/dev-press-check.js <repository name in the sidebar>                                # a click works even if the rows are rebuilt between press and release (while held, rows are not rebuilt for up to 2 seconds)
node scripts/dev-close-all-check.js <repository folder> <another worktree of it> <another repository folder> <folder that is not git>   # close all tabs of a repository (one confirmation, where focus moves, the second click of a double-click does not close a tab on the row that moved up, ports are kept; the first repository's name sorts first, and neither is on GitHub)
node scripts/dev-add-worktree-check.js <main worktree> <issue or PR number>             # add a worktree from an issue or PR (name suggestion or PR branch, input box of the right chat panel, preferredLocation restored, #number on the row; removes it at the end)
node scripts/dev-wsl-check.js '\\wsl.localhost\<distro name>\<worktree>'              # WSL tab (claude runs inside WSL; closing the tab also stops the processes inside WSL)
```

Logs are in `logs\` in the data folder ([config.md](config.md#logs)).

## Releases

How to bump the version, the CHANGELOG, and publishing to GitHub Releases are in [releasing.md](releasing.md). The rules for commits and PRs are in [CONTRIBUTING.md](../.github/CONTRIBUTING.md).
