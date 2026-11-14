// The repositories the side bar lists (ghq, ghq in WSL, and the configured ones), and the lists
// kept for the next start (repos.json). worktrees.js exports these too.
const fs = require('fs');
const path = require('path');
const { run } = require('../commands');
const { oneLine } = require('../util');
const { listDistros, normalizeFolder, windowsPath, wslDistro } = require('../wsl/wsl');

// A linked worktree has a .git file (pointing into the main worktree's .git) where a repository
// has a .git folder.
function isLinkedWorktree(folder) {
  try {
    return fs.statSync(path.join(folder, '.git')).isFile();
  } catch {
    return false;
  }
}

// Whether `folder` is the top of a git repository or worktree (.git is a folder, or a file in a
// linked worktree). ghq also lists checkouts of other version control systems (svn, hg), which
// have no worktrees and open as plain folders. A stat instead of asking git, since ghq may list
// hundreds of repositories.
function isGitFolder(folder) {
  return fs.existsSync(path.join(folder, '.git'));
}

// Repositories under the ghq root (`ghq list --full-path`), of any version control system:
// { ghq: whether ghq is installed, repos }. Rejects when ghq fails.
// Worktrees made next to a repository there are listed under that repository instead.
async function ghqRepos() {
  let out;
  try {
    out = await run('ghq', ['list', '--full-path']);
  } catch (error) {
    if (error.code === 'ENOENT') return { ghq: false, repos: [] };
    throw error;
  }
  const repos = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((p) => p && !isLinkedWorktree(p))
    .map((p) => ({ path: path.resolve(p) }));
  return { ghq: true, repos };
}

// Repositories under the ghq root of a WSL distribution, as ghqRepos. ghq is often installed
// where only the shell's start-up files put it on PATH (~/go/bin, say). Whether each is a git
// repository is seen there too: through \\wsl.localhost, each look would take a round trip.
// Without ghq the script still succeeds, without the line that says ghq is there; it rejects
// when wsl.exe fails or times out. `distroOf` gives the distribution to run in (wslDistro).
async function wslGhqRepos(distro, { distroOf = wslDistro } = {}) {
  // "ghq" once ghq is found, then "g <path>" for a git repository, "- <path>" for another version
  // control system; a linked worktree (a .git file) is left out.
  const script = 'command -v ghq >/dev/null 2>&1 || exit 0; echo ghq; ghq list --full-path | while IFS= read -r p; do if [ -d "$p/.git" ]; then printf "g %s\\n" "$p"; elif [ ! -e "$p/.git" ]; then printf -- "- %s\\n" "$p"; fi; done';
  const out = await distroOf(distro).exec('sh', ['-c', script], { timeout: 30000, shellEnv: true });
  const lines = out.split('\n');
  const repos = lines.filter((line) => /^[g-] \//.test(line)).map((line) => ({ path: windowsPath(distro, line.slice(2)), git: line[0] === 'g' }));
  return { ghq: lines.some((line) => line.trim() === 'ghq'), repos };
}

// Adds a repository to a list being made (lowercase path -> entry), or its source to its entry.
function addEntry(entries, repo, source) {
  const key = repo.path.toLowerCase();
  const entry = entries.get(key) || {
    path: repo.path,
    name: path.basename(repo.path),
    owner: path.basename(path.dirname(repo.path)),
    git: repo.git ?? isGitFolder(repo.path),
    sources: [],
  };
  if (!entry.sources.includes(source)) entry.sources.push(source);
  entries.set(key, entry);
}

// The sources to read on this machine. WSL is Windows' own, so elsewhere its sources are left
// out rather than read and failed on every refresh.
function usableSources(sources, platform = process.platform) {
  if (platform === 'win32') return [...sources];
  return sources.filter((source) => !/^wsl(:|$)/i.test(source));
}

// Every repository for the side bar, from the sources in config.repoSources and config.repos,
// without duplicates. Sources: "ghq", "wsl:<distribution>" for ghq in that WSL distribution, and
// "wsl" for ghq in each distribution installed. Each entry records where it came from (from
// "wsl", as the "wsl:<distribution>" it is in), and whether it is a git repository (`git`; see
// isGitFolder).
//
// A source that could not be read (ghq or wsl.exe failed, or took too long) keeps what it listed
// in `previous`, the last list, so that its repositories do not drop out of the side bar for a
// while. When the distributions are not known, so do those of every distribution. Resolves
// { repos, problems, ghq }: what went wrong, as [{ source, message }] for the log, and the
// sources read whose ghq is installed ("ghq", "wsl:<distribution>"), where a repository can be
// cloned with it (an empty one lists nothing). `list` replaces how the sources are read, for the
// tests: each reader resolves { ghq, repos } as ghqRepos does.
async function repoCatalog(config, previous = [], list = {}) {
  const { ghq = ghqRepos, wslGhq = wslGhqRepos, distros = listDistros, platform } = list;
  const sources = usableSources(config.repoSources || [], platform);
  const problems = [];
  // Lowercase name -> name, those named in the settings first.
  const names = new Map();
  for (const source of sources) {
    const wsl = /^wsl:(.+)$/i.exec(source);
    if (wsl && !names.has(wsl[1].toLowerCase())) names.set(wsl[1].toLowerCase(), wsl[1]);
  }
  let distrosKnown = true;
  if (sources.some((source) => source.toLowerCase() === 'wsl')) {
    const found = await distros();
    if (found.error) problems.push({ source: 'wsl', message: oneLine(found.error) });
    distrosKnown = found.names !== null;
    for (const name of found.names || []) if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  const reads = [...names.values()].map((name) => ({ source: `wsl:${name}`, read: () => wslGhq(name) }));
  if (sources.includes('ghq')) reads.unshift({ source: 'ghq', read: () => ghq() });
  const listed = await Promise.all(
    reads.map(async ({ source, read }) => {
      try {
        return { source, ...(await read()) };
      } catch (error) {
        problems.push({ source, message: oneLine(error) });
        return { source, ghq: false, repos: null };
      }
    }),
  );

  const entries = new Map();
  const done = new Set(listed.map(({ source }) => source.toLowerCase()));
  const failed = new Set(listed.filter(({ repos }) => !repos).map(({ source }) => source.toLowerCase()));
  const kept = (source) => {
    const key = source.toLowerCase();
    return failed.has(key) || (!distrosKnown && key.startsWith('wsl:') && !done.has(key));
  };
  for (const { source, repos } of listed) for (const repo of repos || []) addEntry(entries, repo, source);
  for (const repo of previous) for (const source of repo.sources.filter(kept)) addEntry(entries, repo, source);
  for (const repo of config.repos) addEntry(entries, { path: normalizeFolder(repo) }, 'config');
  return { repos: [...entries.values()], problems, ghq: listed.filter((read) => read.ghq).map(({ source }) => source) };
}

// The list with `folder` in it, from `source` (a repository just added shows at once).
function addToCatalog(list, folder, source) {
  const entries = new Map(list.map((repo) => [repo.path.toLowerCase(), { ...repo, sources: [...repo.sources] }]));
  addEntry(entries, { path: normalizeFolder(folder) }, source);
  return [...entries.values()];
}

// ---- The lists kept for the next start ------------------------------------------------------

const isRepoEntry = (repo) =>
  Boolean(repo) &&
  typeof repo.path === 'string' &&
  typeof repo.name === 'string' &&
  typeof repo.owner === 'string' &&
  typeof repo.git === 'boolean' &&
  Array.isArray(repo.sources) &&
  repo.sources.every((source) => typeof source === 'string');

const isIssue = (issue) => Boolean(issue) && Number.isInteger(issue.number) && typeof issue.title === 'string';

const isWorktreeEntry = (worktree) =>
  Boolean(worktree) &&
  typeof worktree.path === 'string' &&
  (worktree.branch === null || typeof worktree.branch === 'string') &&
  (worktree.issue === undefined || isIssue(worktree.issue)) &&
  (worktree.pull === undefined || isIssue(worktree.pull));

const VISIBILITY_NAMES = ['public', 'private', 'internal'];

const isRemoteEntry = (remote) =>
  Boolean(remote) &&
  ['github', 'gitlab', 'bitbucket', 'other', 'none'].includes(remote.provider) &&
  (remote.url === null || typeof remote.url === 'string') &&
  (remote.visibility === null || VISIBILITY_NAMES.includes(remote.visibility));

// Whose a repository is on its remote's host (ownerOf in github-remote.js).
const isRemoteOwner = (owner) => Boolean(owner) && typeof owner.host === 'string' && typeof owner.owner === 'string';

const isOwnedEntry = (repo) =>
  Boolean(repo) &&
  ['host', 'owner', 'name', 'url', 'description'].every((key) => typeof repo[key] === 'string') &&
  ['user', 'org'].includes(repo.type) &&
  typeof repo.fork === 'boolean' &&
  (repo.visibility === null || VISIBILITY_NAMES.includes(repo.visibility)) &&
  (repo.pushedAt === null || Number.isFinite(repo.pushedAt));

// The lists of the last run (repos.json), which the side bar shows at start while it reads them
// again: { repos, worktrees, remotes, owned }, with the repository list as repoCatalog gives it;
// by lowercase repository path the worktrees as gitWorktrees gives them and where the
// repository's remote is ({ provider, url, owner, visibility, current }, see readVisibility in
// repository-service.js; without `owner` when a version before kept it); and the repositories of
// the accounts gh is signed in to (readOwnedRepos in github.js), of which the side bar shows those
// not cloned. null when there is none, or it cannot be read; entries of another shape are left out. What versions before kept as `github`
// is not read: those went by the remote's host alone, which takes an SSH host for itself (a Host
// github.com-work in ~/.ssh/config for a host of GitHub of its own).
function readRepoCache(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.repos)) return null;
  const worktrees = {};
  for (const [key, items] of Object.entries(data.worktrees || {})) {
    if (Array.isArray(items)) worktrees[key.toLowerCase()] = items.filter(isWorktreeEntry);
  }
  const remotes = {};
  for (const [key, entry] of Object.entries(data.remotes || {})) {
    if (!isRemoteEntry(entry)) continue;
    // Where GitHub has a repository that was renamed or moved since it was cloned; absent before.
    const current = typeof entry.current === 'string' ? entry.current : null;
    const remote = { provider: entry.provider, url: entry.url, visibility: entry.visibility, current };
    // Whose the repository is; left absent from a version before, so that it is read again.
    if (entry.owner === null || isRemoteOwner(entry.owner)) remote.owner = entry.owner && { host: entry.owner.host, owner: entry.owner.owner };
    remotes[key.toLowerCase()] = remote;
  }
  const owned = Array.isArray(data.owned) ? data.owned.filter(isOwnedEntry) : [];
  return { repos: data.repos.filter(isRepoEntry), worktrees, remotes, owned };
}

function writeRepoCache(file, { repos, worktrees, remotes = {}, owned = [] }) {
  fs.writeFileSync(file, `${JSON.stringify({ repos, worktrees, remotes, owned }, null, 2)}\n`);
}

module.exports = {
  addToCatalog,
  ghqRepos,
  isGitFolder,
  isIssue,
  isLinkedWorktree,
  readRepoCache,
  repoCatalog,
  usableSources,
  writeRepoCache,
  wslGhqRepos,
};
