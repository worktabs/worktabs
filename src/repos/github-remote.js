// Where a git remote is, from its address alone: GitHub (and which repository), GitLab,
// Bitbucket, or another host; and the hosts in what ssh and gh print. No commands run here; the
// client in github-client.js reads the remotes and asks ssh and gh.

// A remote's address as a web address, ssh:// or git://, or the scp-like form git takes for SSH
// (git@host:path; not a path to git, which has no colon, or a drive letter's with a slash after
// it). The repository's path on the host comes without .git.
const URL_REMOTE = /^(https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+?)(?:\.git)?\/?$/i;
const SCP_REMOTE = /^(?:[^@/:]+@)?([^/:\\]+):(?![/\\])(.+?)(?:\.git)?\/?$/;
// The hosts of SSH over the HTTPS port, and the services' own hosts.
const SSH_OVER_443 = { 'ssh.github.com': 'github.com', 'altssh.gitlab.com': 'gitlab.com', 'altssh.bitbucket.org': 'bitbucket.org' };

// The parts of a remote's address: { ssh: whether git reaches it over SSH, host (lowercase),
// port: an http(s) address's, else null (another port is not the web's), path: the repository's
// on the host (o/r; group/subgroup/project on GitLab) }, or null for a path or another form.
function remoteParts(remote) {
  const text = String(remote).trim();
  const url = URL_REMOTE.exec(text);
  if (url) {
    const [, scheme, host, port, path] = url;
    const web = /^https?$/i.test(scheme);
    return { ssh: scheme.toLowerCase() === 'ssh', host: host.toLowerCase(), port: web && port ? Number(port) : null, path };
  }
  const scp = SCP_REMOTE.exec(text);
  return scp && { ssh: true, host: scp[1].toLowerCase(), port: null, path: scp[2] };
}

// The host a remote's repository is on: for SSH, the one its host stands for (`hostname`: a Host
// github-work in ~/.ssh/config with HostName github.com) when that is known.
function hostOf(parts, hostname = null) {
  const host = (parts.ssh && hostname) || parts.host;
  return SSH_OVER_443[host] || host;
}

// Whether GitHub is at `host`: github.com, a GitHub Enterprise Server named github.*, GitHub
// Enterprise Cloud with data residency (<tenant>.ghe.com), or one of `hosts` (those gh is signed
// in to, and those the settings add).
function isGithubHost(host, hosts = []) {
  return host === 'github.com' || host.startsWith('github.') || host.endsWith('.ghe.com') || hosts.includes(host);
}

// The service other than GitHub at `host`, by its name: 'gitlab' (gitlab.com, and a GitLab
// server named gitlab.*) or 'bitbucket' (bitbucket.org, and a Bitbucket server named
// bitbucket.*); null for another.
function serviceOf(host) {
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return 'gitlab';
  if (host === 'bitbucket.org' || host.startsWith('bitbucket.')) return 'bitbucket';
  return null;
}

// The web address and owner/name of the repository at the remote's parts (remoteParts), or null
// when it is not on GitHub (isGithubHost). `hostname`: see hostOf.
function githubOf(parts, { hostname = null, hosts = [] } = {}) {
  if (!parts) return null;
  const host = hostOf(parts, hostname);
  const at = parts.port ? `${host}:${parts.port}` : host;
  const [owner, name, ...more] = parts.path.split('/');
  if (!owner || !name || more.length || (!isGithubHost(host, hosts) && !hosts.includes(at))) return null;
  return { url: `https://${at}/${owner}/${name}`, slug: `${owner}/${name}` };
}

// Whose the repository at the remote's parts is, on a service the app knows (`provider`, as
// remoteOf tells it): { host (hostOf), owner: the path before the repository's name }, for the side
// bar's owner rows. On GitLab that is the group with its subgroups; a Bitbucket Server's web
// address has /scm/ before its project. null for another remote.
function ownerOf(parts, provider, hostname = null) {
  if (!parts || !['github', 'gitlab', 'bitbucket'].includes(provider)) return null;
  const names = parts.path.split('/').filter(Boolean);
  if (provider === 'bitbucket' && names[0] === 'scm' && names.length > 2) names.shift();
  return names.length >= 2 ? { host: hostOf(parts, hostname), owner: names.slice(0, -1).join('/') } : null;
}

// Where the repository at the remote's parts is: { provider: 'github' | 'gitlab' | 'bitbucket' |
// 'other', github: its web address and owner/name on GitHub (githubOf), else null, owner: whose
// it is (ownerOf) }. A path to git, or an address of another form, is 'other'.
function remoteOf(parts, options = {}) {
  const github = githubOf(parts, options);
  const provider = github ? 'github' : (parts && serviceOf(hostOf(parts, options.hostname))) || 'other';
  return { provider, github, owner: ownerOf(parts, provider, options.hostname) };
}

// The web address and owner/name of a remote's repository on GitHub, or null (see githubOf).
function parseRemote(remote, options = {}) {
  return githubOf(remoteParts(remote), options);
}

// Where a remote's repository is (remoteOf).
function providerOf(remote, options = {}) {
  return remoteOf(remoteParts(remote), options).provider;
}

// The host in what `ssh -G` printed (its hostname line), or null.
function hostnameIn(output) {
  const match = /^hostname\s+(\S+)\s*$/im.exec(String(output));
  return match ? match[1].toLowerCase() : null;
}

// The hosts in what `gh auth status --json hosts` printed (lowercase), or null when it is not
// that: a gh from before that option says it does not know it.
function jsonHosts(output) {
  try {
    const data = JSON.parse(output);
    return data && data.hosts && typeof data.hosts === 'object' ? Object.keys(data.hosts).map((host) => host.toLowerCase()) : null;
  } catch {
    return null;
  }
}

// The hosts in what `gh auth status` printed: "Logged in to <host> account <login>" ("as
// <login>" before), "Failed to log in to <host>" for one whose token no longer works.
function statusHosts(output) {
  return [...String(output).matchAll(/\blog(?:ged)? in to (\S+)/gi)].map((match) => match[1].toLowerCase());
}

module.exports = { hostOf, hostnameIn, isGithubHost, jsonHosts, ownerOf, parseRemote, providerOf, remoteOf, remoteParts, serviceOf, statusHosts };
