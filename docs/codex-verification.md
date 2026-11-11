# Codex verification

**English** | [日本語](ja/codex-verification.md)

This is the acceptance matrix for Codex support, including thread history and first-task drafts. Record an actual run before marking a cell passed. Unit tests and the offline extension fixture do not prove signed-in official-extension behavior.

## Setup

1. Enable Codex in **Settings**, so that Worktabs installs it from Open VSX, or import a permitted Codex desktop extension or VSIX through **Settings > Extensions**, for the computer's platform and architecture. For WSL, open a tab in the matching distribution so Worktabs installs the Linux version there.
2. Enable **Codex** in **Settings > General**. For coexistence, leave **Claude Code** enabled too. Choose the default agent for new tabs and the agent for branch suggestions. [config.codex.example.json](../config.codex.example.json) is a Codex-only example with manual approvals.
3. Sign in through the Codex chat panel in that environment. Worktabs uses the extension's bundled executable; a separate CLI on PATH is not needed. Windows and WSL have separate extension installations and authentication.
4. Record the Worktabs commit, OS, architecture, WSL distribution/network mode, code-server version, both extension versions, provider choices, and authentication method. Do not attach credentials or authentication responses.

## Recorded results

As of 2026-10-12, the current delivery was checked on macOS 26.5.2, Apple Silicon, Node 26.10.0, Electron 44.4.5, code-server 4.141.0, and helper 0.9.13. The source app used isolated temporary data and extension folders. The user's installed app data was not changed. The signed-in run checked source commit `6ec63188d7c898eb428433dbdbaf82e12b867d4c` with Codex extension 26.1007.21434, bundled CLI 0.162.0-alpha.17.2, and Claude Code extension 2.1.296 for panel switching.

| Environment | Claude only | Codex only | Both agents |
|---|---|---|---|
| Windows native, official extensions | Deferred by maintainer | Deferred by maintainer | Deferred by maintainer |
| WSL, official extensions | Deferred by maintainer | Deferred by maintainer | Deferred by maintainer |
| macOS, official extensions | Signed-in Claude regression pending | Passed navigation and draft checks below; live turns pending | Passed Codex checks and provider panel switching; Claude authentication and live turns pending |
| macOS, offline Codex fixture | Not covered | Passed routing, first-task drafts, persistence, suspension, archive marks | Not covered |
| Ubuntu CI | Automated tests only | Automated tests only | Automated tests only |

The maintainer deferred Windows and WSL real-machine checks and excluded them from this agent delivery. Pending cells stay explicit for later verification. The macOS run reused permitted Codex authentication in a temporary home, completed temporary primary onboarding, and used synthetic saved histories in a real temporary repository and linked worktree. Claude authentication was not copied. App-server inference requests were blocked, none were attempted, and the temporary authentication was removed after the run.

The macOS official run checked:

- Two distinct saved threads, exact content on repeated row clicks, and no conversation editor tabs.
- Content after suspension/resume and Worktabs restart, persisted Codex provider choice, and a Worktabs-hidden row remaining hidden.
- Issue, PR review, and Japanese free-text tasks as editable drafts without sending a turn. The previous verification draft was cleared before each separate task case.
- Automatic linked-worktree onboarding and an editable task draft in that worktree.
- Switching between the installed Claude Code and Codex panels while retaining the Codex draft.
- Archive through the official Codex menu, the resulting `thread/archive` request, and removal of that Worktabs row.
- A nonexistent thread showing the restoration warning and history fallback while retaining its saved Worktabs row.

Windows offline navigation was also checked when thread history was first built. Those results are useful regression evidence, but they are not signed-in official-extension acceptance results for the current build.

The macOS offline run checked two thread routes without new editor tabs, metadata after Worktabs restart, a click before helper registration, suspension/resume, Worktabs archive persistence, and removal after a simulated Codex archive event. Issue, PR review, and Japanese free-text tasks appeared as editable drafts without starting a turn. Unit tests also cover invalid IDs, missing extensions, rejected navigation/resume, ephemeral history, update guards, provider settings, cancellation, and input recovery.

Navigation now confirms the requested thread in the mounted visible composer before clearing unread. The offline Electron run also checks that an accepted URI whose thread never renders reaches the deadline, shows the history fallback warning, and retains the saved row. The official run reproduced the original 100-level React discovery failure: the intro heading had 134 ancestors, the new composer 236, and a restored-thread permission control 257. Raising the bound to 512 fixed mounted context reads while retaining the 10,000-node and malformed-tree guards. Fresh webviews also exceeded the former five-second navigation deadline; the bounded deadline is now 15 seconds. Deep current/alternate-tree and delayed-startup regression tests pass.

An isolated run with the official Codex extension 26.1007.21434, bundled CLI 0.162.0-alpha.17.2, and an empty `CODEX_HOME` initially left a blank webview. Extension logs report a fatal SQLite state-runtime initialization failure. Shortening the temporary path and removing inherited Codex session environment variables did not resolve it. In a follow-up run, initializing the unsigned-in app-server before launching Worktabs allowed the official extension's sign-in panel to appear. It offered ChatGPT sign-in, API key, and device code; quota remained unavailable. Thread content was not verified in these unsigned-in runs; it was verified in the later permitted signed-in run above. The fresh-home startup failure still needs diagnosis; the preinitialization result does not establish its cause. No credentials were copied in these unsigned-in runs. No model turn was submitted in any recorded run.

The Japanese Electron settings screen was checked for 28 text/accessibility labels, target and version actions, and actual import/restore validation errors. Full native-picker and update/import/restore transactions remain pending.

## Official-extension acceptance

Use this checklist for the remaining live-turn and deferred platform checks. The navigation, draft, and archive items above have macOS evidence, but a passed item does not mark an entire signed-in cell complete. Repeat the full checklist when completing a cell. Run Claude-only cells as a regression check; Codex-specific steps apply to Codex-only and both-agent cells.

- [ ] Open a primary and a linked worktree. Confirm provider selection, primary onboarding, linked-worktree onboarding, and agent switching. In both-agent mode, keep separate rows and badges for each provider.
- [ ] Open two Codex threads in one tab. Confirm titles, latest prompts, cwd, elapsed state, and distinct thread content when clicking each row. No conversation editor tab should open.
- [ ] Run a turn, request approval or user input, finish, fail, and interrupt. Check counters, working/waiting state, unread results, stop warnings, next-waiting navigation, and notification clicks. A click must show the exact requesting thread.
- [ ] Create worktrees for an issue, a PR review, and free text. Check the editable initial draft and unchanged Claude behavior. Nothing should be sent without the user. Keep an existing draft intact; check the warning and Copy task recovery when input is unavailable.
- [ ] Restart code-server, suspend/resume a tab, and restart Worktabs. Check selected tab/provider, restored idle rows, thread content, early startup clicks, and approval preference. Stopped processes must exit.
- [ ] Hide a row in Worktabs and restart. It remains hidden without archiving its Codex log. Sending a new prompt brings it back. Archive/delete through the running Codex extension and confirm removal of the saved row.
- [ ] Open a missing/deleted thread, a temporary thread, and a tab without a usable extension. Confirm an actionable warning and sidebar/history fallback.
- [ ] Check quota with the signed-in account, API-key-only mode, sign-out, account switching, expired data, and failed reads. Unknown quota must not be displayed as zero.
- [ ] Apply an update, re-import, and restore an extension. Confirm idle/busy guards, unsaved edits, process shutdown, rollback errors, and refreshed bundled executable selection.

## Failure matrix

| Condition | Expected result | Current evidence | Real-machine status |
|---|---|---|---|
| Not signed in or expired authentication | Panel offers sign-in; branch suggestion explains where to sign in; quota remains unavailable | CLI error classification and quota tests | macOS official sign-in panel and unavailable quota checked after app-server preinitialization; signed-in comparison and other platforms pending |
| No separate CLI on PATH | Imported extension's bundled executable is used | Local/WSL executable-resolution tests | Pending signed-in end-to-end run |
| Missing or incompatible bundled executable | Setup message names the computer or WSL distribution and how to import the matching extension | Binary/platform validation tests | Pending |
| Extension install/import fails | Settings retains the error; partial imports restore prior versions when possible | Validation, import transaction, and Japanese IPC tests | Full transaction pending |
| Thread or URI route cannot be restored | Warning explains the failure and offers the sidebar/history fallback | Helper, protocol, and persistence tests | macOS official navigation, restart, suspension, archive, and missing-thread fallback checked; other platforms deferred |
| Composer unavailable, changed, or already has a draft | Existing input is untouched; original task is available to copy | Input guard and recovery tests; offline Electron input run | macOS official issue, PR, free-text, and linked-worktree drafts checked; protected-input failures remain covered by automated tests |

For each real failure test, record the displayed message and recovery outcome, with secrets omitted. A failed check remains failed until its fix is retested. Deferred checks belong to later maintainer verification. Keep their pending status in this matrix when closing the implementation and documentation issues; do not label the full matrix passed.

## Release-note scope

Codex integration includes provider settings, state badges, thread navigation metadata, usage, approval preferences, and editable first-task drafts. Claude and Codex can be enabled together. Codex requires a compatible user-provided extension and sign-in in each runtime. Navigation, composer, onboarding, and permission integrations depend on the installed extension version. Official macOS navigation, restoration, task drafts, linked-worktree onboarding, archive handling, and panel switching are verified without model turns. Live-turn behavior, the full Claude authentication regression, Windows, and WSL remain pending; Windows and WSL are deferred by the maintainer. Do not describe this as complete support across those environments yet.
