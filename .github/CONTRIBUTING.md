# Contributing guide

These are the rules for branches, commits, and PRs. The goal is to keep the prefixes of commit and PR titles consistent with [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), so that git-cliff can build `CHANGELOG.md` and the release notes (the configuration is `cliff.toml`; the release steps are in [docs/releasing.md](../docs/releasing.md)).

> The CHANGELOG is grouped only by the prefix (`feat:`, `fix:`, and so on) on the first line of each commit that lands on main. With squash merge, the PR title becomes the first line of the commit as is, so **writing the PR title in the Conventional Commits form** matters most. Branch names are not used for grouping.

## 0. Getting started

- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Issues and PRs can be written in Japanese or English. The maintainer tidies up the rules below (such as commit messages in English) when merging, so send your PR even if it does not follow them.
- For large changes, discuss them in an issue before opening a PR.
- Report bugs with an issue template (bug or feature request). Do not report security problems in an issue; report them as described in [SECURITY.md](SECURITY.md).
- If you cannot write to the repository, create a branch in your fork and open a PR from it. The branch naming rules (2.) apply to forks too.
- PRs are accepted under the [MIT License](../LICENSE).

## 1. Prefixes

| Prefix | CHANGELOG heading | Version bump in 0.x |
|---|---|---|
| `feat:` | Features | minor |
| `fix:` | Bug fixes | patch |
| `perf:` | Performance | patch |
| `refactor:` | Refactoring | patch |
| `docs:` | Documentation | (no release for this alone) |
| `test:` | Tests | patch |
| `build:` | Build | patch |
| `ci:` | CI | patch |
| `chore:` | Chores | patch |

- The prefixes match `commit_parsers` in `cliff.toml`. Prefixes not in the table, and commits without a prefix, go under "Other".
- The version is decided by the largest change in the release. If there is even one `feat:`, it is a minor bump; if there are only `fix:` and the like, it is a patch bump.
- While in 0.x, breaking changes also get a minor bump. Add `!`, as in `feat!:`, or write `BREAKING CHANGE:` in the body, and the CHANGELOG line is marked "Breaking change".
- `chore(release):` is for the release commit that `npm version` creates. Do not use it by hand (it is left out of the CHANGELOG).

## 2. Branches

```
<type>/<short description>              e.g. fix/sidebar-wording
<type>/issue<number>-<short description>   e.g. feat/issue77-trash-button
```

- Pick `<type>` from the prefixes in 1. (`feat/` for `feat:`). It reminds you of the prefix for the PR title; it is not used for grouping.
- Write the description in lowercase letters, digits, and hyphens.
- One branch handles one change. If it is getting large, split it into several PRs.
- Branch off main and come back to main through a PR (GitHub Flow). Do not push to main directly. The only exception is the release commit and tag created by `npm version` ([docs/releasing.md](../docs/releasing.md)).
- Update `origin/main` before branching. If you branch off an old main, you work without the PRs merged in the meantime and run into conflicts later.

```sh
git fetch origin
git switch -c <type>/<description> origin/main
git worktree add <path> -b <type>/<description> origin/main   # when creating it as a worktree
```

## 3. Commit messages

```
<type>: <what it fixes or what it makes possible>

- Reason
- What changed in how to verify it

Closes #12
```

- Write the whole message in English, in short sentences of plain English. Write the first line in the imperative mood, starting with a lowercase letter after the prefix.
  - Example: `feat: add and remove worktrees from the sidebar`
  - Example: `fix: move to the conversation's tab when its notification is clicked, even after some time`
- A scope is optional (`feat(sidebar): ...`). Grouping is decided by the prefix.
- Write the issues to close as `Closes #number`.
- Intermediate commits on a branch become one with squash, so their granularity is up to you. When a PR is merged with a merge commit, each commit becomes one CHANGELOG line, so give every one of them a prefix.

## 4. How to merge

- The default is squash merge. The PR title, with `(#12)` appended by GitHub, becomes the first line of the commit on main and one line of the CHANGELOG. `cliff.toml` turns `(#12)` into a link to the PR.
- Only large PRs that contain several separate pieces are merged with a merge commit. This keeps each commit so it can be reverted or bisected. The merge commit itself is left out of the CHANGELOG.
- Rebase merge is not used, because it erases the boundaries between PRs.

GitHub settings (Settings → General → Pull Requests):

- Allow squash merging: on. Set the commit message to "Pull request title and commit details" (the first line is the PR title, the body is the commit messages of the branch).
- Allow merge commits: on (for the exception above)
- Allow rebase merging: off

Branch rules (Settings → Rules → Rulesets, "main"): main takes changes only through pull requests, and only when their `Test (ubuntu-latest)` check passed. It cannot be deleted or force-pushed.

## 5. Releases

- A `v*` tag marks "everything up to here has been distributed". When changes pile up on main and the maintainer decides to distribute them, they become one version. The version is not bumped per commit.
- The maintainer runs `npm version <patch|minor>` on main. This rebuilds `CHANGELOG.md` and creates the release commit and tag. The CHANGELOG is not written by hand.
- `npm run changelog` shows the changes not yet released.

The steps are in [docs/releasing.md](../docs/releasing.md).

## 6. Before opening a PR

```sh
npm run check
npm run lint
npm test
```

- How to run the app from source, the tests, and the development checks that drive the running app (`scripts/dev-*.js`) are in [docs/development.md](../docs/development.md).
- CI (`.github/workflows/ci.yml`) runs the same on Ubuntu and Windows (the lint on Ubuntu only). Every pull request runs it, as main requires it to pass; a push to main that changes only documentation does not.
- On macOS, it runs every night, only when the head of main has not been checked yet (`.github/workflows/mac.yml`; macOS minutes cost 10 times as much). For PRs that touch the mac side, also run it on macOS with `gh workflow run mac.yml --ref <branch>`.
- Write what can only be verified on a real machine in the PR as checklists under "To verify on Windows" and "To verify on mac". The PR template (`.github/pull_request_template.md`) has sections for them.
- If you change anything in `helper-extension/`, bump `version` in `helper-extension/package.json`.
- If you change behavior, also update the matching page in docs/.

## 7. English and Japanese versions of the documents

The English versions are the originals: `README.md` and the pages in `docs/`. The Japanese versions are their translations: `README.ja.md`, and the pages in `docs/ja/`, with the same file names as in `docs/`. `docs/research.md` is in English only, and so are the documents for contributors in `.github/` (this guide, `CODE_OF_CONDUCT.md`, and `SECURITY.md`): issues and PRs may be written in Japanese all the same, and the Contributor Covenant has [an official Japanese translation](https://www.contributor-covenant.org/ja/version/2/1/code_of_conduct/).

- When fixing a document, fix the English version.
- Updating the Japanese version is optional, and it may lag behind. Anyone who notices can bring it up to date later.
- `npm run translations` lists the Japanese pages that are behind, with the English changes left to translate. A Japanese page counts as up to date with the English page as it was when the Japanese page was last committed.
- When an English change needs no change in Japanese (a typo, or a UI label that the Japanese page already has in Japanese), add the line `Translation: not needed` to the commit message. `npm run translations` then leaves that commit's English changes out.
- With Claude Code, the `sync-ja` skill (`.claude/skills/sync-ja/`) does this: it translates only the English changes since the Japanese page was last updated.
- The same goes for the UI. Its text is written in English in the code (`t()` in `src/i18n/`), and its Japanese is in `src/i18n/ja.json`, keyed by the English text. A string without a Japanese translation shows in English. `npm run translations` lists them too.
- Keep the headings of the two in the same structure (number, levels, and order), so that a link to an anchor in the English version can be replaced with the heading at the same position in the Japanese version.
- English pages link to English pages, and Japanese pages to Japanese pages.
- Keep the README to an overview and write the details in docs/.
