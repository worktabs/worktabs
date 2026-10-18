# Releasing

**English** | [日本語](ja/releasing.md)

When a version tag is pushed, GitHub Actions (`.github/workflows/release.yml`) builds the Windows installer and zip and the macOS zip from the tagged commit and publishes them to GitHub Releases. Release files are not built locally, so that it is clear who built them and from which code.

The rules for commit prefixes are in [CONTRIBUTING.md](../.github/CONTRIBUTING.md). Release notes are made from those prefixes.

## Versioning

- Versions follow [SemVer](https://semver.org/). While at `0.x`, there is no compatibility guarantee (the contents of the settings file and the data folder may change).
- Which part to bump depends on the prefixes of the commits in the release ("1. Prefixes" in [CONTRIBUTING.md](../.github/CONTRIBUTING.md)). If there is a `feat:`, bump minor. If there are only `fix:` and the like, bump patch.
- The version is written only in `version` in `package.json`. The version the app reports, the names of the installer and zips (Windows and macOS), and the tag all follow from it.
- The helper extension's version (`helper-extension/package.json`) is separate. Bump it when you change the helper extension's contents. The app uses the helper extension's version to decide whether to reinstall it into each tab's VS Code.

## Releasing

main takes changes only through pull requests, so the release commit goes through one too, and the tag is put on main once it is merged.

1. Update main.
   ```sh
   git switch main
   git pull
   npm ci
   npm run changelog   # (optional) see what has not been released yet
   npm run pack        # (optional) check the main build with npm run try ("Updating your own build of Worktabs" in install.md)
   ```
2. Bump the version on a branch.
   ```sh
   git switch -c release/v0.6.0
   npm version minor   # 0.5.0 → 0.6.0. Use patch for fixes only
   git commit -am "chore(release): v0.6.0"
   ```
   `npm version` bumps `version` in `package.json` and `package-lock.json`, and regenerates `CHANGELOG.md` with git-cliff (`scripts/changelog.js`, configured in `cliff.toml`). It neither commits nor tags (`.npmrc`), and it does not check the working tree, so start from a clean one: `git commit -am` takes every change.
3. Open a pull request with that title, and squash-merge it once its checks pass. `cliff.toml` leaves the `chore(release)` title out of `CHANGELOG.md`. Merge nothing else until the tag is pushed, so that the tagged commit has the CHANGELOG of what it contains.
   ```sh
   git push -u origin release/v0.6.0
   gh pr create --fill
   gh pr merge --squash --delete-branch   # once the checks pass
   ```
4. Tag the merged commit on main and push the tag.
   ```sh
   git switch main
   git pull
   git tag v0.6.0
   git push origin v0.6.0
   ```
5. When the "Release" workflow in Actions finishes, the release appears in Releases. It goes out as soon as the tag is pushed, so do your checks in step 1.

- The repository started over with a single commit when it was made public, so the CHANGELOG and the tags begin there. The versions up to 0.4.0 were not public.
- `CHANGELOG.md` is regenerated from the full history on every release, so hand edits are lost at the next release. Fix the commit messages instead (with squash merge, the PR titles).

## What the Release workflow does

It runs on a push of a tag that starts with `v`.

- If the tag and the version in `package.json` differ, it fails without building, because the app reports the version in `package.json`.
- The release notes are the section for that version taken from `CHANGELOG.md` at the tag's commit (`scripts/release-notes.js`). The workflow does not run git-cliff, so the CHANGELOG and the release notes never disagree. If the section is missing, it fails before building. A table of which file to download is added at the end.
- The build runs as two parallel jobs, Windows (`npm run dist`) and macOS (`npm run dist:mac`). Both run `npm run check` and `npm test` before building. If one fails, the other is stopped too and no release is created.
- The last job gathers the built files and publishes them in one release.
- `SHA256SUMS.txt` (the SHA-256 of the installer and the two zips) is published with them. If the repository is public, an Artifact attestation (proof of which commit the files were built from) is attached too. It is not available for private repositories, so it is skipped there.
- Versions containing `-` (such as `0.2.0-rc.1`) are published as prereleases.

You can see the same release notes locally.

```sh
node scripts/release-notes.js v0.2.0
```

The workflow runs only on tags. `scripts/release-notes.js` and `cliff.toml` are checked by `npm test` (`test/release-notes.test.js`).

## When it fails

- If the workflow fails partway, remove the cause and Re-run it in Actions. gh publishes the release only after uploading all files, and deletes the partial release if an upload fails, so you can simply build it again.
- If the build or tests fail and the code needs a fix, delete the tag, merge the fix, and release the same version again: steps 2 to 4 of "Releasing", with `npm version 0.6.0 --allow-same-version` so that the CHANGELOG takes in the fix.
  ```sh
  git push origin :refs/tags/v0.6.0
  git tag -d v0.6.0
  ```
- If you find a problem after the release is out, fix it and release the next patch. Do not re-tag a released version, because the files handed out and the code at the tag would disagree.

## Signing

Before describing Codex support as complete in release notes, update the [verification matrix](codex-verification.md) with the shipped app and extension versions. State the checked environments and outstanding limits. Use its release-note scope while signed-in platform checks remain pending.

The installer and `Worktabs.exe` are not signed, so a downloaded copy shows a SmartScreen warning on first launch. The macOS `Worktabs.app` has an ad-hoc signature so Electron can deliver notifications. It has no Developer ID signature and is not notarized, so Gatekeeper still blocks a downloaded copy. Before launching it, remove the download mark with `xattr` ([install.md](install.md#macos-zip)).
