# Changelog

Built with [git-cliff](https://git-cliff.org) from the prefixes of the commits ([Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)), not written by hand. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org/).

## [0.11.0] - 2026-11-14

### Features
- group the open and other repositories in the sidebar under their owners ([#72](https://github.com/worktabs/worktabs/pull/72))
- update Codex without waiting for tabs where no Codex turn is in progress ([#71](https://github.com/worktabs/worktabs/pull/71))
- bring back each tab's Claude conversation rows after a restart, as idle rows ([#67](https://github.com/worktabs/worktabs/pull/67))

### Bug fixes
- start every WSL tab opened at once in a new distribution, installing each extension once ([#70](https://github.com/worktabs/worktabs/pull/70))
- offer no update for an agent's extensions while agents leaves the agent out ([#66](https://github.com/worktabs/worktabs/pull/66))
- draw the terminal's text at its font size again, with Electron 45.3.2 ([#65](https://github.com/worktabs/worktabs/pull/65))

## [0.10.0] - 2026-11-11

### Features
- install Codex from Open VSX by default, and keep the import as a fallback ([#59](https://github.com/worktabs/worktabs/pull/59))
- take Open VSX releases as import snapshots, so a failed update goes back without a download ([#58](https://github.com/worktabs/worktabs/pull/58))
- delete import snapshots that no record keeps, after each import and at start ([#56](https://github.com/worktabs/worktabs/pull/56))

### Bug fixes
- show Claude's monthly spend limit, and no "Usage unavailable", when an account has no 5-hour or weekly window ([#52](https://github.com/worktabs/worktabs/pull/52))

### Documentation
- link the 40-second video from the READMEs ([#57](https://github.com/worktabs/worktabs/pull/57))

### Build
- bump the npm-minor group with 5 updates ([#49](https://github.com/worktabs/worktabs/pull/49))

## [0.9.2] - 2026-11-07

### Bug fixes
- keep a repository's GitHub buttons when git fails to read its remote, and read it again later ([#47](https://github.com/worktabs/worktabs/pull/47))
- collapse a repository in the sidebar when its last tab closes ([#44](https://github.com/worktabs/worktabs/pull/44))

### Build
- bump electron from 44.9.3 to 45.2.2 ([#34](https://github.com/worktabs/worktabs/pull/34))
- bump the npm-minor group with 2 updates ([#33](https://github.com/worktabs/worktabs/pull/33))

### Chores
- look up the dialog text the app has in the close-all check ([#46](https://github.com/worktabs/worktabs/pull/46))

## [0.9.1] - 2026-11-02

### Bug fixes
- highlight a Codex subagent's row while the chat shows it, and archive subagents with their parent ([#40](https://github.com/worktabs/worktabs/pull/40))
- let updates go on without closing tabs, when the Codex extension is installed but agents leaves Codex out ([#38](https://github.com/worktabs/worktabs/pull/38))

## [0.9.0] - 2026-11-02

### Features
- highlight the conversation row that a chat in view shows, not only its worktree row ([#36](https://github.com/worktabs/worktabs/pull/36))

## [0.8.0] - 2026-10-24

### Features
- tell when an agent's chat does not start in a tab, and offer to go back to the previous version of its extension ([#25](https://github.com/worktabs/worktabs/pull/25))

### Bug fixes
- update Electron to 44.9.3, and undici and fast-uri, for their security fixes ([#29](https://github.com/worktabs/worktabs/pull/29))
- keep a Codex version whose chat does not start from replacing one that works ([#19](https://github.com/worktabs/worktabs/pull/19))
- keep what VS Code saved last, such as a closed side bar, when its tab closes ([#22](https://github.com/worktabs/worktabs/pull/22))
- give the Codex chat a minute to start before putting a new worktree's task in it, so that the task lands on a busy machine ([#24](https://github.com/worktabs/worktabs/pull/24))
- keep Codex's chat from appending thousands of modulepreload links, so that its chat starts and the tab keeps working ([#23](https://github.com/worktabs/worktabs/pull/23))
- give each webview a process of its own, so that a busy chat no longer stops the whole tab ([#21](https://github.com/worktabs/worktabs/pull/21))

### Refactoring
- wait in the chat's page for the Codex thread a conversation row asked for ([#27](https://github.com/worktabs/worktabs/pull/27))
- wait in the chat's page for the composer and for the chat to start, rather than asking it again and again ([#26](https://github.com/worktabs/worktabs/pull/26))

### Tests
- remove the self-update tests' temporary folders after each test ([#31](https://github.com/worktabs/worktabs/pull/31))

### Chores
- check the conversation rows with Claude Code's chat in the side bar, and press approvals once Claude Code takes them ([#30](https://github.com/worktabs/worktabs/pull/30))
- find the Claude chat's "New session" button by its label in the dev checks ([#28](https://github.com/worktabs/worktabs/pull/28))

## [0.7.0] - 2026-10-24

### Features
- show the version of Worktabs at the end of the "…" menu ([#17](https://github.com/worktabs/worktabs/pull/17))

### Bug fixes
- install for the current user only, so that Worktabs can update itself ([#16](https://github.com/worktabs/worktabs/pull/16))

## [0.6.0] - 2026-10-24

### Features
- check for new versions of Worktabs and update it from the sidebar ([#12](https://github.com/worktabs/worktabs/pull/12))

### Chores
- stop the smoke check from planning a worktree before its dialog is up ([#13](https://github.com/worktabs/worktabs/pull/13))

## [0.5.2] - 2026-10-22

### Bug fixes
- let the Claude Code panel sign in, by not adding --settings to claude's subcommands ([#9](https://github.com/worktabs/worktabs/pull/9))

## [0.5.1] - 2026-10-20

### Bug fixes
- install extensions behind proxies that inspect HTTPS, and show the real error ([#6](https://github.com/worktabs/worktabs/pull/6))

## [0.5.0] - 2026-10-18

### Build
- bump electron from 44.7.0 to 44.7.2 in the npm-minor group ([#1](https://github.com/worktabs/worktabs/pull/1))

### CI
- bring back the Windows and macOS CI and the releases from tags ([#3](https://github.com/worktabs/worktabs/pull/3))
- run the checks on every pull request, since main requires them ([#2](https://github.com/worktabs/worktabs/pull/2))

### Chores
- start the public repository from Worktabs 0.4.0


