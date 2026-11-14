# Extensions and updates

**English** | [日本語](ja/extensions.md)

Open **Settings > Extensions** with the gear at the top of the sidebar. When an update is offered or fails, **Extensions and updates** in the sidebar's update card opens it too. The table shows each extension's source and version. Worktabs uses the extension's own chat panel and bundled executable, not a terminal replacement or a separately updated CLI.

Settings and extension management follow the Worktabs UI language, including action labels, source status, file-picker titles, and import validation errors. Extension and product names, version numbers, paths, and target platform identifiers keep their original text.

## Sources and update responsibilities

| Extension | Default source | How to update |
|---|---|---|
| Claude Code | Publisher's Open VSX release | Check and apply updates in Worktabs |
| Codex | Publisher's Open VSX release, once Codex is enabled; an import from desktop VS Code or a VSIX stays possible | Check and apply updates in Worktabs, or update the source and re-import |
| Extra configured extensions | Open VSX, unless imported | Apply Worktabs updates, or re-import from the recorded source |
| Language pack and Worktabs helper | Worktabs-managed | Keep with code-server and the app's helper version |

Claude does not require desktop VS Code. Anthropic [documents Open VSX installation for VS Code forks](https://code.claude.com/docs/en/vs-code#install-the-extension). Imported extensions are locked to their recorded source and excluded from the gallery updates. Worktabs does not install Codex from the gallery. While Codex is enabled and a target has no Codex, Worktabs takes it from Open VSX as a snapshot, with Codex Audio (see [Taking releases from Open VSX](#taking-releases-from-open-vsx)):

- On this computer, the download starts when Worktabs starts or when Codex is enabled in **Settings**. The update card in the sidebar shows it. Codex tabs show "Installing Codex from Open VSX…" and open once it is there; Claude tabs do not wait. As for any extension that is installed, idle tabs restart once.
- For WSL, it starts when a tab of the distribution starts, for the distribution's architecture (`linux-x64` or `linux-arm64`). It is prepared without waiting for the tabs on Windows, and installs in the distribution before the tab opens. If another update is running then, the tab opens without Codex (that update may be waiting for this tab), and Codex installs at the distribution's next start.
- If the download fails, a Codex tab says why. Selecting the tab tries again, and **Use Open VSX** in **Settings > Extensions** does too.
- An imported Codex keeps its source and is not replaced; **Use Open VSX** moves it. A Codex installed before snapshots keeps running as it is, and **Use Open VSX** moves it too.
- The import stays as the fallback: when Open VSX falls behind (its `win32-x64` build had no release from July to October 2026), or when a new version does not start.

Branch name suggestions also use the executable inside the selected provider's active Worktabs extension. A separate CLI install on `PATH` is not required for Claude or Codex. Each suggestion reads the active extension index again, so applying an update, re-importing, or restoring an extension changes the executable used on the next attempt. Worktabs keeps executable installation and updates with the extension's source above.

If the extension or executable is missing, the add-worktree dialog points to setup in Worktabs. Enable Claude and open a tab to install it. Enable Codex to install it from Open VSX, or press **Use Open VSX** on its row in **Settings > Extensions**, or import it for the computer's platform and architecture. If authentication is missing or expired, open the provider's chat panel in a Worktabs tab and sign in. For WSL, use a tab in the same distribution as the repository; its Linux extension and login are separate from Windows. Worktabs does not manage Codex login or edit its configuration.

For desktop imports, periodically open VS Code and update there. **Open VS Code** launches the desktop app; Worktabs does not operate its updater. Return to Worktabs, check for updates, and apply the newer local version. This checks active versions in the recorded folder, not the latest release worldwide. For VSIX imports, periodically obtain and import a newer compatible file. Desktop VS Code offers **Download VSIX** and **Download Specific Version VSIX** ([official instructions](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#can-i-download-an-extension-directly-from-the-marketplace)).

**Official page** opens the public extension page in your browser. Worktabs does not query or download from Microsoft Marketplace APIs. **No updates found in the configured sources** is not a global freshness guarantee: unavailable desktop sources and VSIX upstream releases are not checked. `updateCheck` controls startup checks and local-source polling every minute; manual checks remain available.

## Importing and permissions

1. Select this computer or a Linux architecture for WSL.
2. Select discovered desktop extensions, another VS Code extensions folder, or VSIX files. Discovery reads active `extensions.json` entries, including VS Code Insiders and `VSCODE_EXTENSIONS`, not obsolete folders.
3. Check the publisher's license and permission for code-server use. Confirm permission and press **Import selected**.

Worktabs validates ID, version, archive paths, platform, VS Code engine requirement, and required extensions. Dependencies must already be installed or included in the same batch. Language packs and the helper cannot be replaced by imports. Complete payloads, including native binaries, are kept together. An import can be up to 4 GiB unpacked and 2 GiB as a VSIX. Packing a large desktop extension can take a minute or more; Codex is over 1 GB because it bundles Windows and Linux binaries.

Copying is not permission to use an extension in another application. The [VS Code FAQ](https://code.visualstudio.com/docs/supporting/faq#extensions) describes Marketplace access restrictions and restrictions on Microsoft extensions. Check publisher terms too. Import support does not promise that every Marketplace extension is licensed or compatible with code-server.

## Taking releases from Open VSX

**Use Open VSX** appears on the rows of imported extensions and of Codex. It takes the newest release from Open VSX for the selected target, as a snapshot like an import:

- Only releases are taken, never pre-releases, and only versions whose VS Code engine requirement accepts the running code-server. Codex numbers its pre-releases above its releases (26.5xxxx and 26.1xxx), so they are told apart by Open VSX's pre-release flag, not by the version.
- An extension built once for every platform (universal) is found too.
- The members of an extension pack come in the same batch, at the pack's version when Open VSX has it, else at their newest release. Codex brings Codex Audio this way. They are updated and restored with the pack, and have no **Use Open VSX** or **Restore previous** of their own, so that restoring the pack brings back the member versions that came with it.
- Worktabs downloads the files itself, through the system proxy, and checks each against the SHA-256 that Open VSX publishes beside it. This catches a broken or cut download, not a server that sends something else.
- The download runs before the update waits for the tabs. The sidebar's update card shows its progress, and the tabs keep running until the switch.
- What the extension had before becomes the previous snapshot. An import stays there, so **Restore previous** goes back to it, with its recorded source. Importing again from VS Code or a VSIX replaces an Open VSX snapshot the same way.

Checking for updates asks Open VSX about the snapshots taken from there, for this computer and for the Linux targets that have them, and offers newer releases. Those for this computer are installed and tried like an import (see below), so a version that does not start goes back to the previous snapshot without a download. Those for WSL are prepared like a Linux import, without waiting for the tabs on Windows, and install when a tab of the distribution next starts. **Use Open VSX** on a Linux target also takes its newest release at once.

Update checks offer neither the extension of an agent that `agents` leaves out nor the rest of its extension pack (Codex Audio comes with Codex, also when it was imported from VS Code as an extension of its own). The tabs do not install them then, and applying such an update would still restart every tab. An update offered before the agent was left out goes at the next check (every minute while `updateCheck` is on).

## Applying and restoring

Local imports are immutable cached snapshots with SHA-256 hashes. Updates wait for Claude and Codex turns to finish and edits to be saved, then restart idle tabs. An extension update may bypass the Codex proxy, so a tab where Codex has started but its proxy has not reported in must be closed first; the sidebar names it. The proxy is set up wherever the Codex extension is installed, also when `agents` leaves Codex out, so such a tab is rare. A Codex status that Worktabs does not know counts as working. The sidebar can cancel a waiting update. Before changing shared extensions, Worktabs stops idle instances and blocks new starts.

After installation, a hidden local workbench checks startup and extensions that declare startup activation. When the import, an update from Open VSX, or **Restore previous** includes Codex, it also opens the Codex chat and checks that the chat starts within 60 seconds and that VS Code keeps responding. Some Codex versions never finish starting their chat in code-server and stop the whole tab from responding; the check keeps such a version from replacing one that works. If installation or this probe fails, previous cached payloads are reinstalled and new additions removed. This does not test every command, login flow, or chat response. **Restore previous** reinstalls the preceding cached snapshot without downloading, preserving its recorded source. The registry keeps one previous snapshot per extension. Older snapshots, and those of an import that failed, are deleted when an import ends and when Worktabs starts.

## Proxies that inspect HTTPS

Some company networks have a proxy that re-signs HTTPS certificates with the company's own root CA. code-server's Node normally trusts only its own list of CAs, so it rejects those certificates ("self-signed certificate in certificate chain"). Worktabs starts code-server with `NODE_USE_SYSTEM_CA=1`, so its Node also trusts the CAs in the OS certificate store (the Windows store, or the macOS keychain). If you set `NODE_USE_SYSTEM_CA` yourself, Worktabs keeps your value. `NODE_EXTRA_CA_CERTS` is passed on too.

In WSL, Node reads the distribution's own store (`/etc/ssl/certs`), not the Windows one. Install the root CA there (for example, with `update-ca-certificates` on Ubuntu).

## WSL

Import matching Linux or universal extensions separately for `linux-x64` or `linux-arm64`. Windows imports are never copied to WSL. Prepared snapshots install when a matching distribution next starts a tab. The table shows the prepared version, not a verified live WSL installation. WSL failures do not yet automatically roll back snapshots; **Restore previous** can restore an existing previous snapshot. Transactional WSL probing and removal of a first import remain follow-up work.

Claude uses its Linux Open VSX publication, not a Windows version pin. Other app-managed extensions retain Windows-version synchronization where applicable.

## Embedded gallery

`restrictExtensionGallery` defaults to `true`. Embedded gallery access and editor automatic updates are disabled. App-managed installs still use Open VSX through Worktabs. This avoids a second update route silently replacing imports.

This is a management policy, not a security sandbox. Manual VSIX installs and filesystem edits can still change shared extensions. Set `restrictExtensionGallery` to `false` only to deliberately restore the embedded Open VSX gallery. It is never redirected to Microsoft Marketplace.
