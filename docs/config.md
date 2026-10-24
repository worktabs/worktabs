# Settings and data folder

**English** | [日本語](ja/config.md)

## Settings file

| How you start the app | Settings file |
|---|---|
| Installer or zip version (Windows) | `%APPDATA%\Worktabs\config.json` |
| Worktabs.app (macOS) | `~/Library/Application Support/Worktabs/config.json` |
| `npm run try` ([install.md](install.md#updating-your-own-build-of-worktabs)) | `%LOCALAPPDATA%\Worktabs-try\config.json` |
| `npm start` ([development.md](development.md)) | `config.local.json` in the repository |

- If the environment variable `WORKTABS_CONFIG` is set, the app uses that path, however it was started.
- You can edit it from "Add repository…" under "＋" and "Open settings file" under "…" at the top of the sidebar.
- Keys you leave out take their default values. See [config.example.json](../config.example.json) for an example.

| Key | Meaning |
|---|---|
| `repoSources` | Where the sidebar gets its list of repositories. `"ghq"` (`ghq list`), `"wsl"` (`ghq list` inside each installed WSL distro), `"wsl:<distro name>"` (`ghq list` inside that distro, e.g. `"wsl:Ubuntu-24.04"`). The default is `["ghq", "wsl"]`. If WSL is not installed, `"wsl"` lists nothing. On anything other than Windows, sources starting with `"wsl"` are not read |
| `repos` | Repositories added by hand (added with "Add repository…") |
| `githubHosts` | Extra hosts to treat as GitHub (e.g. `["git.example.co.jp"]`). github.com, hosts starting with `github.`, `<tenant>.ghe.com`, and hosts gh is signed in to are treated as GitHub without being listed. This is for GitHub Enterprise Server without gh ([architecture.md](architecture.md#github-buttons)) |
| `unclonedRepos` | Shows "Repositories not cloned" in the sidebar (default `true`; [usage.md](usage.md#repositories-not-cloned)). With `false`, gh is not asked either |
| `hiddenGithubOwners` | Owners not shown under "Repositories not cloned". `"<owner>"` (on any host) or `"<host>/<owner>"` (e.g. `["big-org", "ghe.example.com/team"]`). Case-insensitive. This is for leaving out orgs with many repositories. You can also add one with "Hide this owner" in the right-click menu of an owner row |
| `cloneRoot` | When ghq is not installed, where you last cloned (its root if the layout matches ghq, otherwise the parent folder). The app writes it, and the clone destination dialog starts from here. If it is a WSL location, it is used only when cloning into that distro |
| `sidebarWidth` | Default width of the sidebar (pixels, default `260`). Double-clicking the right edge of the sidebar returns it to this width. A width set by dragging the right edge is kept in `window.json` and takes precedence over this ([usage.md](usage.md#width)) |
| `codeServerDir` | To use an existing code-server, the folder it was extracted to (where `lib/node.exe` is, or `lib/node` on macOS). If empty, the app downloads it to `code-server` in the data folder |
| `codeServerVersion` | The code-server version to download (default `4.139.1`, the version tested). When you update from the sidebar, the app writes the new version here. The Linux build of the same version is installed in WSL |
| `wslCodeServerDir` | For WSL tabs, to use an existing code-server (Linux build), the folder inside WSL it was extracted to, as a Linux path (where `lib/node` is). If empty, the app downloads it to `~/.worktabs/code-server` inside WSL |
| `updateCheck` | At startup, checks GitHub and Open VSX for new versions of Worktabs, code-server, and the extensions (default `true`). With `false`, you can still check by hand from "…" at the top of the sidebar |
| `extensionsDir` | The extensions folder shared by all instances. If empty, `extensions` in the data folder |
| `extensions` | Extra IDs to install from Open VSX when missing, unless locked to an import. The language pack is added automatically ([extensions.md](extensions.md)) |
| `restrictExtensionGallery` | Disable the embedded gallery (default `true`). Worktabs manages installs and updates; this is not a security sandbox |
| `agents` | Providers to open. `["claude"]` is the default. Use `["codex"]` or `["claude", "codex"]` after importing Codex. Claude installs from Open VSX by default |
| `defaultAgent` | Agent opened in new tabs when more than one agent is enabled (`"claude"` or `"codex"`) |
| `branchAgent` | Agent used for branch name suggestions (`"claude"`, `"codex"`, or `"default"` to follow `defaultAgent`) |
| `locale` | Display language of the app and of VS Code (default: empty). Empty follows the system's preferred languages: the first of them the app has (English or Japanese), else English, and VS Code takes the same. The app's own menus, dialogs, and messages are in English or Japanese; another language (such as `de` or `zh-cn`) sets VS Code's, and the app's own show in English. The language pack VS Code needs is installed on its own |
| `permissionMode` | Initial permission mode for new conversations (`auto`, `manual`, `acceptEdits`, `plan`). The default is `auto`. If empty, conversations start in Manual |
| `codexApprovalMode` | Initial Codex approval preference: `"auto-review"` (default) or `"manual"`. Automatic review selects **Approve for me** only when the active extension offers it and allows it |
| `pasteFallback` | With `true`, the app catches Ctrl+V and pastes through Electron (a workaround for when the real Ctrl+V key does not work) |
| `idleSuspendMinutes` | Inactive tabs with nothing working, waiting for approval, or unread are suspended after this many minutes (`0` turns it off) |
| `controlPort` | Control port for development ([development.md](development.md)). Normally not set |

In the settings dialog, each provider has its own checkbox under "Agents to use". You can enable one or more providers, and at least one stays enabled. The default-agent and branch-name choices contain only the enabled providers.

For a Codex-only example, see [config.codex.example.json](../config.codex.example.json). Import the matching Codex extension first, then enable Codex and sign in in its chat panel. To use both providers, set `agents` to `["claude", "codex"]`; choose `defaultAgent` for new tabs and `branchAgent` for suggestions. Existing tabs and conversation rows keep their provider after saving and restarting. WSL needs a matching Linux extension and its own sign-in. The [verification matrix](codex-verification.md) separates automated coverage from real-extension results.

**Settings > Extensions** shows sources, versions, imports, and updates. Claude's Open VSX updates are managed by Worktabs. Desktop and VSIX imports need periodic source updates and re-importing. Worktabs does not fetch them from Microsoft Marketplace ([extensions.md](extensions.md)).

Why `permissionMode` is needed is explained in [limitations.md](limitations.md). It applies to Claude Code only. Codex approvals and sandboxing are different settings in Codex, so Worktabs does not show them as the same choice.

Choose **Settings > General > Codex approval for new conversations** to save a Codex preference independently of Claude. It applies to new, empty Codex composers in every Worktabs tab, including after restart or reopening. A setting changed while a composer is open applies to the next new conversation. Resumed conversations keep their selected mode. Worktabs also preserves Full Access and custom profiles, and stops applying the default once you interact with the composer.

The Codex permission control shows the effective mode. An older extension, an unavailable feature, a managed restriction, or an unrecognized permission picker keeps the extension's existing mode, normally **Ask for approval**. Worktabs does not pass unsupported reviewer values to older app-servers. It checks the active picker again when its webview restarts, including after extension updates, re-imports, or restoration of a previous version. Each local or WSL tab uses its own active extension and runtime.

Worktabs selects the extension's own approval option. It does not change global Codex configuration, install a second CLI, accept approval requests itself, or select Full Access. [Automatic review](https://learn.chatgpt.com/docs/sandboxing/auto-review) retains the sandbox and routes eligible requests to a reviewer; denials and errors still prevent the requested action.

When Codex is enabled, Worktabs also manages a few Codex editor settings in each tab's VS Code. It sets `chatgpt.openOnStartup` to `false`, because Worktabs opens the Codex panel itself. It sets `chatgpt.localeOverride` to the VS Code display language, except for English where the setting is cleared.

Worktabs also sets `chatgpt.runCodexInWindowsSubsystemForLinux` to `false`. Worktabs chooses Windows or WSL by opening either a Windows tab or a WSL tab. It does not let the Codex extension redirect a Windows tab into WSL.

Worktabs does not write Codex's `config.toml`. The Codex model, approval policy, sandbox mode, MCP servers, personalization, and login stay in Codex. This keeps Worktabs from mixing Claude Code's permission mode with Codex's own approval and sandbox model.

Branch name suggestions use the selected provider's executable bundled in its active Worktabs extension. Neither provider needs a separate `codex` or `claude` on `PATH`. Enable Claude and open a tab to install its Open VSX extension. For Codex, import an extension for this computer through **Settings > Extensions**. Updates, re-imports, and restores also replace the executable used by subsequent suggestions ([extensions.md](extensions.md)).

For a WSL repository, suggestions use the Linux extension installed in that repository's distribution under `~/.worktabs/extensions`. Import the matching Linux Codex extension and open a tab in the distribution to install it. Claude uses its Linux Open VSX extension there. Windows executables and Windows login credentials are not used for WSL suggestions.

The add-worktree dialog explains how to fix missing extension files and how to sign in when authentication is missing or expired. Sign in through the provider's chat panel in a local Worktabs tab, or in a tab in the matching WSL distribution. Other execution failures keep the CLI's error message. Startup and settings-save warnings for Codex branch suggestions check the local extension executable; the suggestion checks the environment of the selected repository.

## Data folder

The data folder is `%APPDATA%\Worktabs` on Windows and `~/Library/Application Support/Worktabs` on macOS. With `npm run try` it is `%LOCALAPPDATA%\Worktabs-try`, and if the environment variable `WORKTABS_DATA_DIR` is set, it is that folder. The main contents are:

| Location | Contents |
|---|---|
| `tabs.json` | The open tabs and their ports (`tabs`), ports of closed tabs (`ports`, per folder), when a tab was last open for each repository (`repoUsed`), and the width of the chat panel on the right of the primary for each repository (`chatWidths`, in pixels). Why ports are remembered and when they are forgotten: [architecture.md](architecture.md#code-server). The chat panel width: [architecture.md](architecture.md#width-of-the-right-chat-panel) |
| `window.json` | Window size, position, and maximized state, and the sidebar width set by dragging |
| `repos.json` | The last list of repositories read (`repos`), the worktrees read (`worktrees`), the remote of each repository (`remotes`: provider, GitHub URL, visibility, and the current URL of repositories that were renamed or moved to another owner), and the accounts gh is signed in to with the repositories of their orgs (`owned`; the ones not cloned are shown from these). On the next start, the app shows this first |
| `theme.json` | The colors of the VS Code theme last matched |
| `usage.json` | The last Claude usage received |
| `code-server\` | The code-server the app downloaded (the current version and the one before) |
| `extensions\` | Extensions shared by all tabs |
| `extension-imports\` | Imported snapshots, SHA-256 hashes, per-platform source records, and the previous snapshot for restoration |
| `instances\<tab ID>\` | The code-server `user-data-dir` of each tab. For tabs of git repositories, the settings in `User\` are kept the same as in `repos\` below |
| `repos\<repository ID>\` | For each repository, the VS Code settings shared by the tabs of its worktrees (`settings.json`, `keybindings.json`, `tasks.json`, `mcp.json`, `snippets\`, `prompts\`). `repo.json` holds the repository path and the tabs that joined the sharing. It stays after a worktree is removed ([architecture.md](architecture.md#sharing-vs-code-settings)) |
| `bin\` | macOS only. The claude wrapper (`claude-wrap` and `mac-claude-wrap.js`). Rewritten at every start ([architecture.md](architecture.md#the-claude-wrapper)) |
| `logs\` | Logs (below) |

For WSL tabs, code-server, the extensions, and the agent are placed in `~/.worktabs` in WSL ([wsl.md](wsl.md)).

### Logs

Logs are in `logs\`.

- `hooks.log`: Claude Code hooks and the usage received
- `code-server-<tab ID>.log`: code-server for each tab. Logs of code-server for WSL tabs are written under the same name
- `updates.log`: Updates of code-server and the extensions, and the agent chats that did not start
- `repos.log`: Sources whose repository list could not be read, and why (WSL not installed, and so on). Also hosts where gh could not read the visibility or the account's repositories, and the ghq or git output when a clone fails
- `settings.log`: Why VS Code settings could not be shared between tabs
