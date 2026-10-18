# Installation

**English** | [日本語](ja/install.md)

Get the installer or the zip for Windows, or the zip for macOS, from [Releases](https://github.com/worktabs/worktabs/releases). You can also build from source ("Building from source" below).

## Requirements

- Windows 11 or macOS (tested on Windows 11 and macOS 26.5 (Apple Silicon))
- git
- (Optional) ghq. The repository list in the sidebar is built from `ghq list` and the repositories you add by hand
- (Optional) WSL2. Repositories inside WSL can be opened too ([wsl.md](wsl.md)). git is also needed inside WSL
- To build from source, you also need Node.js and npm

The app downloads code-server and the extensions (Claude Code, and the language pack when VS Code is not in English) by itself on the first start. code-server is about 200 MB from the GitHub releases, and the Claude Code extension is about 110 MB from Open VSX.

Claude does not require desktop VS Code. For Codex, import a compatible official extension from desktop VS Code or a VSIX through **Settings > Extensions**. Keep that source updated and re-import periodically. Extensions absent from Open VSX still require compatibility and publisher permission ([extensions.md](extensions.md)).

## Downloading

Each version on Releases has the following files. GitHub Actions builds all of them from the commit of that version's tag ([releasing.md](releasing.md)). The changes are in the release notes of each version and in [CHANGELOG.md](../CHANGELOG.md).

| File | Contents |
|---|---|
| `Worktabs-<version>-setup.exe` | Windows installer |
| `Worktabs-<version>-win.zip` | Windows version you extract and run |
| `Worktabs-<version>-arm64-mac.zip` | `Worktabs.app` for macOS (Apple Silicon) |
| `SHA256SUMS.txt` | SHA-256 of the three files above |

To check that a downloaded file was not corrupted or replaced on the way, compare its SHA-256 with `SHA256SUMS.txt`.

```powershell
Get-FileHash .\Worktabs-0.2.0-setup.exe   # correct if it matches the line with the same name in SHA256SUMS.txt (case does not matter)
```

In Git Bash and similar shells, `sha256sum -c SHA256SUMS.txt --ignore-missing` checks all downloaded files at once. On macOS, compare the output of `shasum -a 256 Worktabs-<version>-arm64-mac.zip` with the line of the same name in `SHA256SUMS.txt`.

Versions released after the repository is made public also carry proof of which commit they were built from (a GitHub Artifact attestation). Check it with `gh attestation verify <file> -R worktabs/worktabs`.

## Installer and zip (Windows)

- The installer installs per user and does not need administrator rights.
- The zip needs no installation. Extract it to any folder and run `Worktabs.exe`.
  - You can move the folder later. The path of the Claude wrapper (`resources\native\claude-wrap.exe`) is rewritten on every start.
  - To stop using it, delete the folder. The settings and data ([config.md](config.md)) stay.
- Neither is signed, so a downloaded file shows a SmartScreen warning on the first run. Click "More info", then "Run anyway".
- Both use the settings file `%APPDATA%\Worktabs\config.json`. You can edit it from "Add repository…" under "＋" at the top of the sidebar, and from "Open settings file" under "…". The available settings are in [config.md](config.md).
  - code-server, the extensions, and the open tabs are also kept in the same `%APPDATA%\Worktabs`, so the installed version and the zip version cannot run at the same time (the one started later exits, and the window of the one already running comes to the front).

## macOS zip

- Move the extracted `Worktabs.app` to the Applications folder and start it. There is no installer.
- The app uses an ad-hoc signature for macOS notifications. It has no Developer ID signature and is not notarized, so an app taken from a zip downloaded in a browser is blocked by Gatekeeper and does not start. Before the first start, remove the download mark (the quarantine attribute).
  ```sh
  xattr -dr com.apple.quarantine /Applications/Worktabs.app
  ```
  - Files fetched with `gh release download` or `curl` get no mark, so this is not needed for them.
- It is built for Apple Silicon. On an Intel Mac, build from source ("Building from source" below).
- The settings file is `~/Library/Application Support/Worktabs/config.json`. code-server, the extensions, and the open tabs are kept in the same folder.
- WSL tabs are not available (Windows only).

## App icon

Worktabs uses a blue and violet mark of three stacked editor windows. While the app runs, its macOS Dock icon and Windows window icon follow the OS light or dark appearance, independently of the VS Code theme. On Windows, this follows the system appearance rather than the separate app appearance.

The executable, installer, macOS Finder icon, and Windows shortcuts use the dark version. Pinned Windows taskbar entries may keep that version too.

## Upgrading to a new version

- For the installed version, quit Worktabs, then run the installer of the new version. It replaces the previous version.
- For the zip version, quit Worktabs, delete the contents of the folder, then extract the zip of the new version. Extracting over the old files leaves files that only the previous version had (the helper extension installs every VSIX in `resources\native`, so a leftover VSIX of an old version installs that old version too).
- In both cases, the settings and data (`%APPDATA%\Worktabs`) stay, and the open tabs come back as they were.
- On macOS, quit Worktabs, replace `/Applications/Worktabs.app` with the new version, and remove the mark with `xattr` again ("macOS zip" above). The settings and data (`~/Library/Application Support/Worktabs`) stay.

## Building from source

On Windows:

```sh
npm install
node node_modules/electron/install.js   # Electron 44 downloads its binary on first use
npm run pack          # builds dist/win-unpacked/Worktabs.exe
npm run try           # starts it with test data ("Updating your own build of Worktabs" below)
npm run dist:packed   # builds dist/Worktabs-0.1.0-setup.exe (installer) and dist/Worktabs-0.1.0-win.zip from the checked dist/win-unpacked
```

On macOS:

```sh
npm install
node node_modules/electron/install.js
npm run pack:mac      # builds dist/mac-arm64/Worktabs.app
npm run dist:mac      # builds dist/Worktabs-<version>-arm64-mac.zip
```

- `npm run pack` first runs `npm run build:native` to build `native/claude-wrap.exe` and the helper extension VSIX. It uses csc.exe and tar.exe that come with Windows.
- On macOS, `npm run build:native` builds only the helper extension VSIX. The claude wrapper is JavaScript, and the app writes it to `~/Library/Application Support/Worktabs/bin/` on start ([architecture.md](architecture.md#the-claude-wrapper)).
- The macOS build targets Apple Silicon. To build on an Intel Mac, use `npx electron-builder --mac --x64`.
- The macOS build uses an ad-hoc signature (`mac.identity: "-"`). It needs no signing certificate. Electron's macOS notification API needs the app bundle to be signed; skipping signing with `identity: null` makes notifications fail. A build made on your own machine has no download mark, so it starts as is.
- `npm run pack` does not build the installer and the zip, so it finishes a few minutes sooner than `npm run dist`.
- `npm run dist:packed` does not rebuild. It packages `dist/win-unpacked` as it is, so the installer and the zip contain exactly what you tested.
- To build everything without a check in between, use `npm run dist` (runs `pack` and `dist:packed` in a row).
- While `dist/win-unpacked/Worktabs.exe` is running, `npm run pack` cannot overwrite its files and fails. Close the test build before running it.

## Updating your own build of Worktabs

Keep the Worktabs you use every day in a folder outside `dist` (here `C:\Tools\worktabs`). If you run it from `dist\win-unpacked`, the next `npm run pack` cannot overwrite its files.

After each build, update in this order:

1. Run `npm run pack` in the repository folder to build the new version into `dist\win-unpacked`. Your everyday Worktabs can keep running.
2. (Optional) Run `npm run try` to start the new build next to your everyday one and check that it works. Close it when you are done.
   - Its data goes to `%LOCALAPPDATA%\Worktabs-try`. Tabs, code-server, and extensions are separate from your everyday ones, so both can run at the same time. On the first run only, it downloads code-server and the extensions (about 300 MB).
   - Its settings file is also separate: `%LOCALAPPDATA%\Worktabs-try\config.json`.
3. Quit your everyday Worktabs. The VS Code, terminals, and Claude conversations inside it end too, so do this when nothing is in progress.
4. In Explorer, double-click `update-worktabs.cmd` in the repository folder. It copies the whole contents of `dist\win-unpacked` to `C:\Tools\worktabs` and starts `C:\Tools\worktabs\Worktabs.exe`. The open tabs and settings carry over from `%APPDATA%\Worktabs`.
   - If Worktabs is still running, it waits until it exits. It also waits for a running Worktabs outside `C:\Tools\worktabs` (such as in `dist\win-unpacked`) if that one uses the everyday data, because starting right away would make the new one exit through the single-instance check.
   - If it fails, the window stays open and shows the reason.
   - To copy to another folder, change `DEST` in `update-worktabs.cmd`.

What `update-worktabs.cmd` does:

- It copies the whole contents of `dist\win-unpacked`, not only `Worktabs.exe`. The app code is in `resources\app.asar`, and the Claude wrapper and the helper extension are in `resources\native`.
- It copies with robocopy `/MIR`, so files that exist only in the destination are deleted. The helper extension installs every VSIX in `resources\native`, and this keeps old VSIX files from staying behind.
  - If the destination is not empty and has no `Worktabs.exe`, it stops, so that it does not wipe an unrelated folder.
  - The settings and data are in `%APPDATA%\Worktabs`, so they are not lost when the contents of `C:\Tools\worktabs` are deleted.
