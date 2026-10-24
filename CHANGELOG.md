# Changelog

Built with [git-cliff](https://git-cliff.org) from the prefixes of the commits ([Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)), not written by hand. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org/).

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


