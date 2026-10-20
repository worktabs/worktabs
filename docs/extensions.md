# Extensions and updates

**English** | [日本語](ja/extensions.md)

Open **Settings > Extensions** with the gear at the top of the sidebar. When an update is offered or fails, **Extensions and updates** in the sidebar's update card opens it too. The table shows each extension's source and version. Worktabs uses the extension's own chat panel and bundled executable, not a terminal replacement or a separately updated CLI.

Settings and extension management follow the Worktabs UI language, including action labels, source status, file-picker titles, and import validation errors. Extension and product names, version numbers, paths, and target platform identifiers keep their original text.

## Sources and update responsibilities

| Extension | Default source | How to update |
|---|---|---|
| Claude Code | Publisher's Open VSX release | Check and apply updates in Worktabs |
| Codex | User-provided desktop VS Code extension or VSIX | Update the source, then re-import in Worktabs |
| Extra configured extensions | Open VSX, unless imported | Apply Worktabs updates, or re-import from the recorded source |
| Language pack and Worktabs helper | Worktabs-managed | Keep with code-server and the app's helper version |

Claude does not require desktop VS Code. Anthropic [documents Open VSX installation for VS Code forks](https://code.claude.com/docs/en/vs-code#install-the-extension). Imported extensions are locked to their recorded source and excluded from Open VSX updates. Existing Codex installs can still run, but Worktabs no longer installs or offers older Open VSX releases as a fallback for Codex.

Branch name suggestions also use the executable inside the selected provider's active Worktabs extension. A separate CLI install on `PATH` is not required for Claude or Codex. Each suggestion reads the active extension index again, so applying an update, re-importing, or restoring an extension changes the executable used on the next attempt. Worktabs keeps executable installation and updates with the extension's source above.

If the extension or executable is missing, the add-worktree dialog points to setup in Worktabs. Enable Claude and open a tab to install it, or import Codex for the computer's platform and architecture in **Settings > Extensions**. If authentication is missing or expired, open the provider's chat panel in a Worktabs tab and sign in. For WSL, use a tab in the same distribution as the repository; its Linux extension and login are separate from Windows. Worktabs does not manage Codex login or edit its configuration.

For desktop imports, periodically open VS Code and update there. **Open VS Code** launches the desktop app; Worktabs does not operate its updater. Return to Worktabs, check for updates, and apply the newer local version. This checks active versions in the recorded folder, not the latest release worldwide. For VSIX imports, periodically obtain and import a newer compatible file. Desktop VS Code offers **Download VSIX** and **Download Specific Version VSIX** ([official instructions](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#can-i-download-an-extension-directly-from-the-marketplace)).

**Official page** opens the public extension page in your browser. Worktabs does not query or download from Microsoft Marketplace APIs. **No updates found in the configured sources** is not a global freshness guarantee: unavailable desktop sources and VSIX upstream releases are not checked. `updateCheck` controls startup checks and local-source polling every minute; manual checks remain available.

## Importing and permissions

1. Select this computer or a Linux architecture for WSL.
2. Select discovered desktop extensions, another VS Code extensions folder, or VSIX files. Discovery reads active `extensions.json` entries, including VS Code Insiders and `VSCODE_EXTENSIONS`, not obsolete folders.
3. Check the publisher's license and permission for code-server use. Confirm permission and press **Import selected**.

Worktabs validates ID, version, archive paths, platform, VS Code engine requirement, and required extensions. Dependencies must already be installed or included in the same batch. Language packs and the helper cannot be replaced by imports. Complete payloads, including native binaries, are kept together. An import can be up to 4 GiB unpacked and 2 GiB as a VSIX. Packing a large desktop extension can take a minute or more; Codex is over 1 GB because it bundles Windows and Linux binaries.

Copying is not permission to use an extension in another application. The [VS Code FAQ](https://code.visualstudio.com/docs/supporting/faq#extensions) describes Marketplace access restrictions and restrictions on Microsoft extensions. Check publisher terms too. Import support does not promise that every Marketplace extension is licensed or compatible with code-server.

## Applying and restoring

Local imports are immutable cached snapshots with SHA-256 hashes. Updates wait for Claude and Codex turns to finish and edits to be saved, then restart idle tabs. An extension update may bypass the Codex proxy, so a tab where Codex has started but its proxy has not reported in must be closed first; the sidebar names it. A Codex status that Worktabs does not know counts as working. The sidebar can cancel a waiting update. Before changing shared extensions, Worktabs stops idle instances and blocks new starts.

After installation, a hidden local workbench checks startup and extensions that declare startup activation. If installation or this probe fails, previous cached payloads are reinstalled and new additions removed. This does not test every command, login flow, or chat response. **Restore previous** reinstalls the preceding cached snapshot without downloading, preserving its recorded source. The registry keeps one previous snapshot per extension; automatic cache cleanup is not implemented yet.

## Proxies that inspect HTTPS

Some company networks have a proxy that re-signs HTTPS certificates with the company's own root CA. code-server's Node normally trusts only its own list of CAs, so it rejects those certificates ("self-signed certificate in certificate chain"). Worktabs starts code-server with `NODE_USE_SYSTEM_CA=1`, so its Node also trusts the CAs in the OS certificate store (the Windows store, or the macOS keychain). If you set `NODE_USE_SYSTEM_CA` yourself, Worktabs keeps your value. `NODE_EXTRA_CA_CERTS` is passed on too.

In WSL, Node reads the distribution's own store (`/etc/ssl/certs`), not the Windows one. Install the root CA there (for example, with `update-ca-certificates` on Ubuntu).

## WSL

Import matching Linux or universal extensions separately for `linux-x64` or `linux-arm64`. Windows imports are never copied to WSL. Prepared snapshots install when a matching distribution next starts a tab. The table shows the prepared version, not a verified live WSL installation. WSL failures do not yet automatically roll back snapshots; **Restore previous** can restore an existing previous snapshot. Transactional WSL probing and removal of a first import remain follow-up work.

Claude uses its Linux Open VSX publication, not a Windows version pin. Other app-managed extensions retain Windows-version synchronization where applicable.

## Embedded gallery

`restrictExtensionGallery` defaults to `true`. Embedded gallery access and editor automatic updates are disabled. App-managed installs still use Open VSX through Worktabs. This avoids a second update route silently replacing imports.

This is a management policy, not a security sandbox. Manual VSIX installs and filesystem edits can still change shared extensions. Set `restrictExtensionGallery` to `false` only to deliberately restore the embedded Open VSX gallery. It is never redirected to Microsoft Marketplace.
