# WSL repositories

**English** | [日本語](ja/wsl.md)

Repositories inside WSL (`\\wsl.localhost\<distro>\...`) also open as tabs. It works like the VS Code WSL extension: the app window stays on Windows, and code-server (the Linux build) runs inside WSL. WSL also needs git inside it.

## Opening them

- If you manage repositories with ghq in WSL, they appear in the list without any settings. For each installed distro (`wsl.exe -l -q`, which does not start WSL), the app reads `ghq list` inside it. Distros without ghq and Docker Desktop's distros show nothing.
  - To choose which distros to read, write `"wsl:<distro>"` instead of `"wsl"` in the `repoSources` setting (for example, `["ghq", "wsl:Ubuntu-24.04"]`).
  - If the settings file has `repoSources`, the default `["ghq", "wsl"]` is not used. In earlier versions, "Add repository…" wrote `"repoSources": ["ghq"]`. To show WSL repositories, add `"wsl"` or delete that line.
  - At startup, the app starts the agent ([architecture.md](architecture.md)) only in the distros that had repositories last time. Other distros are only read when the list is reloaded.
  - On a PC without WSL, `"wsl"` does nothing (no error, and startup is not slower).
- You can also pick a folder inside WSL from "Linux" in Explorer with "Add repository…" or "Open folder…".

In the sidebar, WSL repository rows show "WSL" (hover to see the distro name). Windows repositories do not.

## Cloning

You can also clone into WSL from "Repositories not cloned" in the sidebar ([usage.md](usage.md#repositories-not-cloned)).

- Pressing the clone button shows a menu to choose the destination: "Windows" or "WSL: <distro>".
  - The WSL choices are the distros read by `repoSources` that have ghq installed or have repositories in the list. Whether ghq is installed is found out when the list is reloaded (until the list is read after startup, only distros with repositories in the list appear).
  - If Windows is the only choice, no menu appears and the app clones into Windows right away.
- If ghq is installed, the app runs `ghq get` inside WSL. ghq may also be one that the shell's startup files put on the PATH (such as `~/go/bin`).
  - If `repoSources` does not read that distro, the cloned folder is added to the `repos` setting.
- Without ghq, the clone destination dialog appears, and the app runs `git clone` with git inside WSL. The suggested locations come from where that distro's repositories are. The field holds a `\\wsl.localhost\<distro>\...` path, and the Linux path is shown below it.
- https or SSH follows the gh setting inside WSL (`gh config get git_protocol`). Without gh, it is https.
- Authentication uses the git settings inside WSL. They are separate from the gh sign-in and Git Credential Manager on Windows, so for private repositories, run `gh auth login` and `gh auth setup-git` inside WSL, or set up git in WSL to use the Git Credential Manager on Windows.
- The list of repositories itself comes from gh on Windows (not gh inside WSL). Whether a repository is already cloned is checked against both Windows and WSL repositories.

## What runs in WSL inside a tab

In a tab, everything except the screen runs inside WSL.

- The VS Code terminal opens a WSL shell, and its working folder is the worktree's Linux path.
- The Linux build of the Claude Code extension is installed, and claude also runs inside WSL. claude's Bash tool, hook commands, and MCP servers run inside WSL too. Conversation history and settings are in `~/.claude` in WSL.
- Extensions such as git for source control, tasks, and language servers also run inside WSL.
- The PATH is the same as in a WSL terminal. code-server reads environment variables from a login shell (`$SHELL -i -l`) for the extension host (as the VS Code server does). node installed with nvm and the like are visible.
- `code <file>` in the terminal opens the file in that tab. `code <folder>` opens it in a new tab.

Adding and removing worktrees, branch names, and the GitHub buttons (`git remote` and `gh`) in the sidebar also use git and gh inside WSL.

"Copy Linux path" in the tab menu copies the path inside WSL (`/home/...`). "Copy path" gives `\\wsl.localhost\...`.

VS Code settings are shared among the tabs of worktrees of the same repository, as with Windows repositories ([usage.md](usage.md#vs-code-settings)). They are not shared with tabs of Windows repositories. The shared settings are kept in the Windows data folder (`repos\`) and written to `~/.worktabs/instances/<tab ID>/User` in WSL for each tab.

## First use

- The first time you open a WSL tab, the app downloads the Linux build of code-server (about 210 MB) on Windows and extracts it to `~/.worktabs/code-server` in WSL. Extensions of the same versions as the Windows tabs are installed to `~/.worktabs/extensions` in WSL. Other tabs opened in the same distribution meanwhile wait for this and then start.
- claude needs a separate login in `~/.claude` in WSL (start `claude` once in a WSL terminal and log in).
- When WSL is stopped, the first tab takes a few extra seconds to start.

- Claude in WSL tabs does not report usage yet ([usage.md](usage.md#claude-usage)).

The environments where WSL was tested are in [limitations.md](limitations.md), and how it works is in [architecture.md](architecture.md#wsl-windows).
