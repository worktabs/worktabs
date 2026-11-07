// Opening the GitHub pages of a folder's repository, and reading its branches' pull requests and
// checks for the worktree rows. The lookups (github.js), the browser, and repos.log are injected.
const { oneLine } = require('../util');

// At most this many branches, and as many commits, a call: the query names each, and a command
// line has a limit.
const MAX_PULL_BRANCHES = 100;

function createGithubPages({ githubRepo, readGithubRepo, pageUrl, checksUrl, branchPulls, hasBranchPage, openExternal, log }) {
  // Opens a GitHub page of the folder's repository in the default browser. The branch is read
  // again here, since a tab keeps the one it had when it opened.
  async function openGithub(folder, page) {
    const repo = await githubRepo(folder);
    if (repo) openExternal(await pageUrl(repo, page, folder));
  }

  // Opens an issue or pull request of the folder's repository by its number: the issue a
  // worktree's branch was made for, or the branch's pull request (both on the worktree's row).
  // `page`: 'issues' or 'pull'.
  async function openNumbered(folder, page, number) {
    if (!Number.isInteger(number) || number <= 0) return;
    const repo = await githubRepo(folder);
    if (repo) openExternal(`${repo.url}/${page}/${number}`);
  }

  // Opens the checks of a commit (a worktree's HEAD) of the folder's repository.
  async function openChecks(folder, oid) {
    const repo = await githubRepo(folder);
    const url = repo && checksUrl(repo, oid);
    if (url) openExternal(url);
  }

  // The branch whose pull request page the folder has ("This branch's PR"), or null when its
  // repository is not on GitHub or it is on the default branch or a detached HEAD.
  async function branchPage(folder) {
    const repo = await githubRepo(folder);
    return repo && hasBranchPage(repo) ? repo.branch : null;
  }

  // The repository for the side bar: what readGithubRepo reads, and whether it has a branch page;
  // null when it is not on GitHub. When git fails, { error } instead, which the side bar does not
  // take for "not on GitHub" and reads again later (SidebarData.github). It resolves rather than
  // rejects, as 'repos:worktrees' does: a rejection reaches the page as Electron's long message.
  // The failure goes to repos.log, as nothing else shows it.
  async function repoInfo(folder) {
    let repo;
    try {
      repo = await readGithubRepo(folder);
    } catch (error) {
      log(`github ${folder}: ${oneLine(error)}`);
      return { error: oneLine(error) };
    }
    return repo && { ...repo, branchPage: hasBranchPage(repo) };
  }

  // The pull requests of branches of the repository at `folder`, and the checks of its
  // worktrees' HEADs, for the worktree rows: { pulls: { branch: pull }, heads: { oid: checks } }
  // (see readPulls and readHeads in github.js), or null when they cannot be read (outside
  // GitHub, no gh, not signed in, GitHub out of reach). `numbers`: the pull request each branch
  // made from one was made from (see branchPulls).
  async function pullRequests(folder, branches, numbers = new Map(), heads = []) {
    const repo = await githubRepo(folder);
    if (!repo) return null;
    try {
      const found = await branchPulls(repo, branches.slice(0, MAX_PULL_BRANCHES), {
        folder,
        numbers: Object.fromEntries(numbers),
        heads: heads.slice(0, MAX_PULL_BRANCHES),
      });
      return { pulls: Object.fromEntries(found.pulls), heads: Object.fromEntries(found.heads) };
    } catch {
      return null;
    }
  }

  return { openGithub, openNumbered, openChecks, branchPage, repoInfo, pullRequests };
}

module.exports = { MAX_PULL_BRANCHES, createGithubPages };
