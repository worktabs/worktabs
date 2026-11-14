// Repository cache and refresh scheduling do not depend on Electron. Readers are injected
// so deferred and failed source reads can be tested independently of the sidebar.
const { addToCatalog } = require('./worktrees');
const { clonedKeys, mergeOwned, repoKey, unclonedGroups } = require('./clone');
const { visibilityGroups } = require('./github');
const { ownerOf, remoteParts } = require('./github-remote');
const { parseWslPath } = require('../wsl/wsl');
const { mapLimit, oneLine } = require('../util');

// How many gh calls for visibility run at once.
const VISIBILITY_AT_ONCE = 4;

// Whose a listed repository is on its remote's host ({ host, owner }), for the side bar's owner
// rows: where GitHub has it now, for one moved to another owner since it was cloned; else as its
// remote says. A remote on GitHub kept without its owner (one just cloned, or kept by a version
// before) has it in its address. null for a remote on another host, and for none.
function remoteOwner(remote) {
  const github = (url) => (url ? ownerOf(remoteParts(url), 'github') : null);
  return github(remote.current) || remote.owner || github(remote.url);
}

class RepositoryService {
  constructor(deps, saved = null) {
    this.deps = deps;
    this.list = saved ? saved.repos : null;
    this.catalogRead = null;
    this.catalogAgain = false;
    this.revision = 0;
    this.additions = [];
    this.seq = 0;
    this.worktrees = new Map(Object.entries(saved?.worktrees || {}));
    this.worktreesRead = new Set();
    this.remotes = new Map(Object.entries(saved?.remotes || {}));
    this.owned = saved?.owned || [];
    this.ghqDistros = new Map();
    this.savedJson = saved ? JSON.stringify(saved) : '';
    this.remotesStale = false;
    this.visibilityRead = null;
    this.visibilityAgain = false;
    this.approved = new Map();
    this.approvedRead = null;
    this.approvedAgain = null;
    this.approvedAt = 0;
  }

  add(folder, source, remote = null) {
    this.list = addToCatalog(this.list || [], folder, source);
    this.additions.push({ folder, source, revision: ++this.revision });
    if (remote) this.remotes.set(folder.toLowerCase(), remote);
    if (this.catalogRead) this.catalogAgain = true;
    this.save();
    this.deps.changed();
  }

  invalidateRemotes() {
    this.remotesStale = true;
  }

  message() {
    const visibility = [...this.remotes].filter(([, remote]) => remote.visibility).map(([key, remote]) => [key, remote.visibility]);
    const providers = [...this.remotes].map(([key, remote]) => [key, remote.provider]);
    const owners = [...this.remotes].map(([key, remote]) => [key, remoteOwner(remote)]).filter(([, owner]) => owner);
    // The owners of the accounts gh is signed in to ('user') and of their organizations ('org'),
    // which the side bar puts first.
    const ownerTypes = this.owned.map((repo) => [`${repo.host}/${repo.owner}`.toLowerCase(), repo.type]);
    return {
      seq: ++this.seq,
      repos: this.list,
      reading: Boolean(this.catalogRead),
      visibility: Object.fromEntries(visibility),
      providers: Object.fromEntries(providers),
      owners: Object.fromEntries(owners),
      ownerTypes: Object.fromEntries(ownerTypes),
      uncloned: this.uncloned(),
      approved: Object.fromEntries(this.approved),
    };
  }

  uncloned() {
    if (this.deps.config().unclonedRepos === false) return [];
    const urls = [...this.remotes.values()].flatMap((remote) => [remote.url, remote.current]).filter(Boolean);
    const folders = [...(this.list || []).map((repo) => repo.path), ...[...this.deps.tabs().values()].map((tab) => tab.repo).filter(Boolean)];
    return unclonedGroups(this.owned, clonedKeys({ urls, folders }), this.deps.config().hiddenGithubOwners);
  }

  refresh({ again = false } = {}) {
    if (this.catalogRead) {
      this.catalogAgain ||= again;
      return this.catalogRead;
    }
    this.catalogRead = this.readCatalog().finally(() => {
      this.catalogRead = null;
      this.deps.changed();
      this.refreshVisibility();
      if (this.catalogAgain) {
        this.catalogAgain = false;
        this.refresh();
      }
    });
    this.deps.changed();
    return this.catalogRead;
  }

  async readCatalog() {
    const revision = this.revision;
    try {
      const { repos, problems, ghq } = await this.deps.catalog(this.deps.config(), this.list || []);
      // An immediate clone/add made after this read began must survive its older result.
      this.list = this.additions.filter((entry) => entry.revision > revision)
        .reduce((list, entry) => addToCatalog(list, entry.folder, entry.source), repos);
      this.additions = this.additions.filter((entry) => entry.revision > revision);
      // A distribution that could not be read keeps what was known of its ghq.
      const failed = new Set(problems.map(({ source }) => source.toLowerCase()));
      for (const key of [...this.ghqDistros.keys()]) if (!failed.has('wsl') && !failed.has(`wsl:${key}`)) this.ghqDistros.delete(key);
      for (const source of ghq) {
        const wsl = /^wsl:(.+)$/i.exec(source);
        if (wsl) this.ghqDistros.set(wsl[1].toLowerCase(), wsl[1]);
      }
      this.save();
      // Nothing shows in the side bar: a PC without WSL is not an error.
      for (const { source, message } of problems) this.deps.log(`${source}: ${message}`);
    } catch (error) {
      this.deps.log(`repoCatalog: ${error.message}`);
      this.list = this.list || [];
    }
    return this.list;
  }

  remember(repo, items) {
    const key = repo.toLowerCase();
    this.worktreesRead.add(key);
    this.worktrees.set(key, items);
    this.save();
  }

  save() {
    const listed = new Set((this.list || []).map((repo) => repo.path.toLowerCase()));
    for (const key of this.worktrees.keys()) if (!listed.has(key) && !this.worktreesRead.has(key)) this.worktrees.delete(key);
    for (const key of this.remotes.keys()) if (!listed.has(key)) this.remotes.delete(key);
    const cache = { repos: this.list || [], worktrees: Object.fromEntries(this.worktrees), remotes: Object.fromEntries(this.remotes), owned: this.owned };
    const json = JSON.stringify(cache);
    if (json === this.savedJson) return;
    try {
      this.deps.write(cache);
      this.savedJson = json;
    } catch (error) {
      this.deps.log(`repos.json: ${error.message}`);
    }
  }

  refreshVisibility() {
    if (this.visibilityRead) {
      this.visibilityAgain = true;
      return this.visibilityRead;
    }
    this.visibilityRead = this.readVisibility()
      .catch((error) => this.deps.log(`visibility: ${error.message}`))
      .finally(() => {
        this.visibilityRead = null;
        if (!this.visibilityAgain) return;
        this.visibilityAgain = false;
        this.refreshVisibility();
      });
    return this.visibilityRead;
  }

  async readVisibility() {
    const owned = this.deps.config().unclonedRepos === false ? null : this.readOwned().catch((error) => {
      this.deps.log(`owned repositories: ${oneLine(error.message)}`);
      return this.owned;
    });
    const listed = (this.list || []).filter((repo) => repo.git);
    const again = this.remotesStale;
    this.remotesStale = false;
    // A remote on GitLab or Bitbucket kept by a version before the owners were is read once more,
    // for its owner: its address is not kept.
    const unread = listed.filter((repo) => {
      const known = this.remotes.get(repo.path.toLowerCase());
      return again || !known || (known.owner === undefined && ['gitlab', 'bitbucket'].includes(known.provider));
    });
    const before = new Map(unread.map((repo) => [repo.path.toLowerCase(), this.remotes.get(repo.path.toLowerCase())]));
    const read = await this.deps.remotes(unread.map((repo) => repo.path));
    for (const [folder, { provider, url, owner = null }] of read) {
      const key = folder.toLowerCase();
      if (!(this.list || []).some((repo) => repo.path.toLowerCase() === key)) continue;
      if (this.remotes.get(key) !== before.get(key)) continue;
      const known = this.remotes.get(key);
      // The same repository keeps its mark until GitHub answers.
      const same = Boolean(known) && known.url === url;
      this.remotes.set(key, { provider, url, owner, visibility: same ? known.visibility : null, current: same ? known.current : null });
    }
    if (read.size) {
      this.save();
      this.deps.changed();
    }
    const onGithub = (this.list || []).filter((repo) => repo.git).map((repo) => [repo.path, this.remotes.get(repo.path.toLowerCase())]).filter(([, github]) => github && github.url);
    // url -> { visibility, current }, or null when GitHub did not tell it (gone, or not to be seen).
    const answered = new Map();
    // Each group (a host, here or in one WSL distribution) is its own gh call: a few at once.
    const groups = visibilityGroups(onGithub.map(([folder, github]) => [folder, github.url]));
    const replies = await mapLimit(groups, VISIBILITY_AT_ONCE, ({ folder, urls }) => this.deps.visibility(urls, { folder })
      .catch((error) => {
        this.deps.log(`visibility (gh for ${folder}): ${oneLine(error.message)}`);
        return null;
      }));
    groups.forEach(({ urls }, index) => {
      const found = replies[index];
      if (found) for (const url of urls) answered.set(url, found.get(url) || answered.get(url) || null);
    });
    for (const [folder, github] of onGithub) {
      if (this.remotes.get(folder.toLowerCase()) !== github) continue;
      if (!answered.has(github.url)) continue;
      const told = answered.get(github.url);
      github.visibility = told ? told.visibility : null;
      // Only where it differs: a repository renamed or moved since it was cloned.
      github.current = told && told.current && repoKey(told.current) !== repoKey(github.url) ? told.current : null;
    }
    // Once the addresses GitHub has the repositories at now are known; the list was just read in
    // every WSL distribution, which started them.
    this.refreshApproved(true);
    this.owned = owned ? await owned : [];
    this.save();
    this.deps.changed();
  }

  async readOwned() {
    const hosts = await this.deps.hosts(null);
    const found = new Map();
    await Promise.all(
      hosts.map(async (host) => {
        try {
          found.set(host, await this.deps.owned(host));
        } catch (error) {
          found.set(host, null);
          this.deps.log(`owned repositories (gh for ${host}): ${oneLine(error.message)}`);
        }
      }),
    );
    return mergeOwned(this.owned, hosts, found);
  }

  refreshApproved(all = false) {
    if (this.approvedRead) {
      this.approvedAgain = { all: all || Boolean(this.approvedAgain && this.approvedAgain.all) };
      return this.approvedRead;
    }
    this.approvedRead = this.readApproved(all)
      .catch((error) => this.deps.log(`approved pull requests: ${oneLine(error.message)}`))
      .finally(() => {
        this.approvedRead = null;
        const again = this.approvedAgain;
        this.approvedAgain = null;
        if (again) this.refreshApproved(again.all);
      });
    return this.approvedRead;
  }

  async readApproved(all) {
    this.approvedAt = this.deps.now();
    const onGithub = (this.list || [])
      .filter((repo) => repo.git)
      .map((repo) => [repo.path, this.remotes.get(repo.path.toLowerCase())])
      .filter(([, remote]) => remote && remote.url);
    const groups = visibilityGroups(onGithub.map(([folder, remote]) => [folder, remote.url]));
    const running = !all && groups.some(({ folder }) => parseWslPath(folder)) ? await this.deps.running() : null;
    const found = new Map();
    for (const { folder, folders, urls } of groups) {
      const wsl = parseWslPath(folder);
      const { host, hostname } = new URL(urls[0]);
      // null: not read.
      let pulls = null;
      // Only where gh is signed in to the host: without gh, or signed out, there are none, and
      // nothing is asked every few minutes only to fail.
      const signedIn = async () => {
        const hosts = await this.deps.hosts(folder);
        return hosts.includes(host.toLowerCase()) || hosts.includes(hostname.toLowerCase());
      };
      const asleep = wsl && !all && !(running && running.has(wsl.distro.toLowerCase()));
      if (!asleep && !(await signedIn())) pulls = [];
      else if (!asleep) {
        try {
          pulls = await this.deps.pulls(host, { folder });
        } catch (error) {
          this.deps.log(`approved pull requests (gh for ${folder}): ${oneLine(error.message)}`);
        }
      }
      // Those not read (a distribution not running, GitHub out of reach for a moment) keep theirs.
      for (const each of folders) {
        const key = each.toLowerCase();
        const remote = this.remotes.get(key);
        if (!remote || !(this.list || []).some((repo) => repo.path.toLowerCase() === key)) continue;
        const keys = new Set([remote.url, remote.current].filter(Boolean).map(repoKey));
        const list = pulls
          ? pulls.filter((pull) => keys.has(repoKey(pull.repo))).map(({ number, title, url }) => ({ number, title, url }))
          : this.approved.get(key) || [];
        if (list.length) found.set(key, list);
      }
    }
    if (JSON.stringify([...found]) === JSON.stringify([...this.approved])) return;
    this.approved = found;
    this.deps.changed();
  }
}

module.exports = { RepositoryService };
