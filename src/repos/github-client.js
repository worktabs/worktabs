// Each client owns command dependencies, configured hosts, and coalesced host lookups. What does
// not run commands is apart: reading remotes' addresses (github-remote.js), and the queries and
// their answers (github-queries.js). The client's API includes those too.
const { parseWslPath } = require('../wsl/wsl');
const { hostnameIn, jsonHosts, parseRemote, providerOf, remoteOf, remoteParts, statusHosts } = require('./github-remote');
const {
  APPROVED_QUERY, OID, OWNED_JQ, OWNED_PATH, answerOf, checksUrl, isApproved, mergedAtHead, pullsQuery, readApproved,
  readChecks, readHeads, readOwnedRepos, readPulls, readVisibility, startsChecks, visibilityGroups, visibilityQuery,
} = require('./github-queries');

function createGithubClient({ currentBranch, defaultBranch, mainRemote, runAt, runGit }) {
  // Some queries can use data returned alongside GraphQL errors; each caller chooses that policy.
  async function graphql(host, query, variables = {}, { folder = null, timeout = 20000, partial = false } = {}) {
    const args = ['api', 'graphql', '--hostname', host, '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push('-f', `${key}=${value}`);
    try {
      return JSON.parse(await runAt(folder, 'gh', args, timeout, { shellEnv: true }));
    } catch (error) {
      const answer = partial && answerOf(error);
      if (!answer) throw error;
      return answer;
    }
  }

  const PAGES = { repo: '', issues: '/issues', pulls: '/pulls', actions: '/actions' };

  // ---- Where remotes are ---------------------------------------------------------------------

  // What ssh and gh answered, for each place they run (a WSL distribution, or here), kept until
  // forgetHostLookups (the side bar's refresh button): readRemotes reads the remotes of every
  // listed repository at once, and they share a few hosts. The promises, so that those read at the
  // same time ask once.
  const sshHostnames = new Map();
  const signedIn = new Map();
  // Hosts that the settings say are GitHub (githubHosts in config.json).
  let settingHosts = [];

  const placeOf = (folder) => {
    const wsl = parseWslPath(folder);
    return wsl ? wsl.distro.toLowerCase() : '';
  };

  // The host that the SSH host `host` stands for where `folder` is, as ssh reads ~/.ssh/config
  // there: `ssh -G` prints what it would connect with, without connecting. git does not do this
  // for `git remote get-url` (it does apply url.<base>.insteadOf). null when ssh is not there or
  // fails.
  function sshHostname(folder, host) {
    // A host that would be an option of ssh (git refuses those too).
    if (!/^[a-z0-9_][a-z0-9._-]*$/i.test(host)) return Promise.resolve(null);
    const key = `${placeOf(folder)}\n${host}`;
    if (!sshHostnames.has(key)) sshHostnames.set(key, runAt(folder, 'ssh', ['-G', host], 5000).then(hostnameIn, () => null));
    return sshHostnames.get(key);
  }

  // The hosts gh is signed in to where `folder` is (in WSL, the gh signed in there); none without
  // gh. Its own hosts are GitHub's even when the token no longer works.
  function signedInHosts(folder) {
    const key = placeOf(folder);
    if (!signedIn.has(key)) signedIn.set(key, readSignedInHosts(folder).catch(() => []));
    return signedIn.get(key);
  }

  async function readSignedInHosts(folder) {
    // gh fails when a token no longer works, having printed the hosts all the same.
    const status = (args) =>
      runAt(folder, 'gh', ['auth', 'status', ...args], 15000, { shellEnv: true }).catch((error) => {
        if (error.code === 'ENOENT' || error.code === 127) throw error;
        return `${error.stdout || ''}\n${error.stderr || ''}`;
      });
    return jsonHosts(await status(['--json', 'hosts'])) || statusHosts(await status([]));
  }

  // How the hosts of remotes are looked up (see readRemote); the tests put their own in its place.
  const lookup = { sshHostname, signedInHosts };

  // Hosts that GitHub is at besides those isGithubHost knows by their names and those gh is signed
  // in to: githubHosts in config.json, as host names (a web address is taken for its host).
  function setGithubHosts(hosts) {
    settingHosts = (Array.isArray(hosts) ? hosts : [])
      .filter((host) => typeof host === 'string')
      .map((host) => host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
  }

  // Asks ssh and gh again from now on: after ~/.ssh/config changed, or gh signed in to a host.
  function forgetHostLookups() {
    sshHostnames.clear();
    signedIn.clear();
  }

  async function git(folder, ...args) {
    return (await runGit(folder, args, 5000)).trim();
  }

  // Where `folder`'s main remote (origin, else the first) is (remoteOf), with its name (remote);
  // null without a remote. An SSH remote's host is the one it stands for (sshHostname), and gh is
  // asked only for a host that its name and the settings do not tell. Rejects when git fails.
  async function readRemote(folder) {
    const remote = await mainRemote(folder, 5000);
    if (!remote) return null;
    const parts = remoteParts(await git(folder, 'remote', 'get-url', remote));
    const hostname = parts && parts.ssh ? await lookup.sshHostname(folder, parts.host) : null;
    let found = remoteOf(parts, { hostname, hosts: settingHosts });
    if (parts && found.provider === 'other') found = remoteOf(parts, { hostname, hosts: await lookup.signedInHosts(folder) });
    return { ...found, remote };
  }

  // The GitHub repository of `folder`'s main remote: { url, slug, remote: the remote's name }, or
  // null without a remote or when it is not on GitHub (see readRemote). Rejects when git fails.
  async function githubRemote(folder) {
    const found = await readRemote(folder);
    return found && found.github && { ...found.github, remote: found.remote };
  }

  // The GitHub repository of `folder` (from its main remote: origin, else the first) with the
  // current and default branches, or null when the remote is not on GitHub. Rejects when git fails
  // to read the remote (it took too long, or a WSL distribution did not answer): that says nothing
  // of where the remote is, and the side bar reads it again later (repoInfo in github-pages.js).
  async function readGithubRepo(folder) {
    const found = await githubRemote(folder);
    if (!found) return null;
    const { remote, ...repo } = found;
    const [branch, main] = await Promise.all([currentBranch(folder), defaultBranch(folder, remote, 5000)]);
    // rev-parse --abbrev-ref prints HEAD when no branch is checked out.
    return { ...repo, branch: branch && branch !== 'HEAD' ? branch : null, defaultBranch: main };
  }

  // readGithubRepo, with null when git fails too: for opening a page or naming a branch, where
  // either way there is nothing to do with the repository.
  async function githubRepo(folder) {
    return readGithubRepo(folder).catch(() => null);
  }

  // Whether "this branch's pull request" makes sense: not on the default branch or a detached HEAD.
  function hasBranchPage(repo) {
    return Boolean(repo.branch) && repo.branch !== repo.defaultBranch;
  }

  // Address of a page: repo, issues, pulls, actions, or branch (the pull request of the current
  // branch). The branch page asks gh for the pull request and otherwise opens the compare page,
  // which links to an existing pull request or offers to create one. gh runs where `folder` is,
  // signed in there: in WSL for a folder in WSL.
  async function pageUrl(repo, page, folder = null) {
    if (page !== 'branch') return repo.url + PAGES[page];
    if (!hasBranchPage(repo)) return repo.url + PAGES.pulls;
    try {
      const target = repo.url.replace(/^https:\/\//, '');
      const args = ['pr', 'view', repo.branch, '--repo', target, '--json', 'url', '--jq', '.url'];
      const url = (await runAt(folder, 'gh', args, 10000, { shellEnv: true })).trim();
      if (url.startsWith('https://')) return url;
    } catch {
      // No gh, not signed in, or no pull request for the branch.
    }
    return `${repo.url}/compare/${repo.branch.split('/').map(encodeURIComponent).join('/')}?expand=1`;
  }

  // ---- Pull requests of branches -------------------------------------------------------------

  // The pull requests of `branches` (readPulls) and the checks of the commits `heads` (readHeads)
  // with one call to gh, where `folder` is (see pageUrl): { pulls, heads }. `numbers`: see
  // pullsQuery. Rejects when there is no gh, it is not signed in, it cannot read the repository,
  // or it takes longer than `timeout` (ms).
  async function branchPulls(repo, branches, { folder = null, numbers = {}, heads = [], timeout = 20000 } = {}) {
    heads = heads.filter((oid) => OID.test(oid));
    if (!branches.length && !heads.length) return { pulls: new Map(), heads: new Map() };
    const { query, variables } = pullsQuery(repo, branches, numbers, heads);
    const answer = await graphql(new URL(repo.url).host, query, variables, { folder, timeout });
    return { pulls: readPulls(answer, branches, numbers), heads: readHeads(answer, heads) };
  }

  // ---- Visibility of repositories ------------------------------------------------------------

  // Repositories asked about in one call: the query names each, and a command line has a limit.
  const VISIBILITY_BATCH = 100;

  // Where the main remote of each of `folders` is (readRemote), for the side bar's rows: folder ->
  // { provider: 'github' | 'gitlab' | 'bitbucket' | 'other', or 'none' without a remote; url: the
  // repository's web address on GitHub, else null; owner: whose it is on GitHub, GitLab, or
  // Bitbucket ({ host, owner }, ownerOf in github-remote.js), else null }. Those git fails on (a
  // folder gone, a WSL distribution that does not answer) are left out, to be read another time.
  // `limit` at a time: a long list would otherwise start a git for each at once.
  async function readRemotes(folders, limit = 8) {
    const found = new Map();
    const queue = [...folders];
    const work = async () => {
      while (queue.length) {
        const folder = queue.shift();
        try {
          const remote = await readRemote(folder);
          found.set(folder, remote ? { provider: remote.provider, url: remote.github ? remote.github.url : null, owner: remote.owner } : { provider: 'none', url: null, owner: null });
        } catch {
          // Left out.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, work));
    return found;
  }

  // The visibility of the repositories at `urls`, all on one host (readVisibility), with one call
  // to gh where `folder` is for each VISIBILITY_BATCH of them. gh fails when the answer has errors
  // (a repository gone or not to be seen), but still writes it, with the others in it. Rejects as
  // branchPulls does: without gh, signed out (gh writes GitHub's refusal, which has no data),
  // GitHub out of reach.
  async function repoVisibility(urls, { folder = null, timeout = 20000 } = {}) {
    const found = new Map();
    for (let i = 0; i < urls.length; i += VISIBILITY_BATCH) {
      const batch = urls.slice(i, i + VISIBILITY_BATCH);
      const { query, variables } = visibilityQuery(batch);
      const answer = await graphql(new URL(batch[0]).host, query, variables, { folder, timeout, partial: true });
      for (const [url, visibility] of readVisibility(answer, batch)) found.set(url, visibility);
    }
    return found;
  }

  // ---- Approved pull requests ----------------------------------------------------------------

  // The approved pull requests of the account gh is signed in to on `host` (readApproved), with gh
  // where `folder` is (in WSL for a folder in WSL, signed in there). As repoVisibility, the answer
  // of a gh that failed for some of them still has the others. Rejects without gh, signed out, or
  // when GitHub is out of reach.
  async function approvedPulls(host, { folder = null, timeout = 20000 } = {}) {
    const answer = await graphql(host, APPROVED_QUERY, {}, { folder, timeout, partial: true });
    return readApproved(answer);
  }

  // ---- Repositories of the account -----------------------------------------------------------

  // The repositories of the account gh is signed in to on `host` (readOwnedRepos), with gh here
  // (not in WSL: the sign-in here is the one the side bar shows). Rejects without gh, signed out,
  // or when GitHub is out of reach; an organization with hundreds of repositories takes a page of
  // a hundred at a time.
  async function ownedRepos(host, { timeout = 2 * 60 * 1000 } = {}) {
    const args = ['api', '--hostname', host, '--paginate', OWNED_PATH, '--jq', OWNED_JQ];
    return readOwnedRepos(await runAt(null, 'gh', args, timeout, { shellEnv: true }), host);
  }

  // How git reaches `host` for a new clone where `folder` is: 'ssh' or 'https', as gh is set up
  // there (gh config get git_protocol, which gh auth login asks), as gh repo clone decides it.
  // https without gh, as gh's own default.
  async function gitProtocol(folder, host) {
    try {
      const out = await runAt(folder, 'gh', ['config', 'get', 'git_protocol', '-h', host], 15000, { shellEnv: true });
      return out.trim() === 'ssh' ? 'ssh' : 'https';
    } catch {
      return 'https';
    }
  }
  return {
    approvedPulls,
    branchPulls,
    checksUrl,
    forgetHostLookups,
    gitProtocol,
    githubRepo,
    hasBranchPage,
    hostnameIn,
    isApproved,
    jsonHosts,
    lookup,
    mergedAtHead,
    ownedRepos,
    pageUrl,
    parseRemote,
    providerOf,
    pullsQuery,
    readApproved,
    readChecks,
    readGithubRepo,
    readHeads,
    readOwnedRepos,
    readPulls,
    readRemotes,
    readVisibility,
    repoVisibility,
    setGithubHosts,
    signedInHosts,
    startsChecks,
    statusHosts,
    visibilityGroups,
    visibilityQuery,
  };

}

module.exports = { createGithubClient };
