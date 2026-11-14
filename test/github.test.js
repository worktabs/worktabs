const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  branchPulls,
  checksUrl,
  githubRepo,
  hasBranchPage,
  hostnameIn,
  isApproved,
  jsonHosts,
  lookup,
  mergedAtHead,
  pageUrl,
  parseRemote,
  providerOf,
  pullsQuery,
  readApproved,
  readChecks,
  readHeads,
  readOwnedRepos,
  readPulls,
  readRemotes,
  readVisibility,
  setGithubHosts,
  startsChecks,
  statusHosts,
  visibilityGroups,
  visibilityQuery,
} = require('../src/repos/github');
const { ownerOf, remoteOf, remoteParts } = require('../src/repos/github-remote');
const { git, makeRepo, tempDir } = require('./support');

// The machine's own ~/.ssh/config and gh would decide otherwise: no SSH host stands for another,
// and gh is signed in nowhere, unless a test says so.
const { sshHostname } = lookup;
lookup.sshHostname = async () => null;
lookup.signedInHosts = async () => [];

test('parseRemote reads GitHub remotes in their usual forms', () => {
  const expected = { url: 'https://github.com/worktabs/worktabs', slug: 'worktabs/worktabs' };
  for (const remote of [
    'https://github.com/worktabs/worktabs',
    'https://github.com/worktabs/worktabs.git',
    'https://github.com/worktabs/worktabs/',
    'https://user@github.com/worktabs/worktabs.git',
    'git@github.com:worktabs/worktabs.git',
    'ssh://git@github.com/worktabs/worktabs.git',
    'ssh://git@ssh.github.com:443/worktabs/worktabs.git',
    '  git@GitHub.com:worktabs/worktabs  ',
  ]) {
    assert.deepEqual(parseRemote(remote), expected, remote);
  }
});

test('parseRemote accepts GitHub Enterprise hosts named github.* and GitHub Enterprise Cloud with data residency', () => {
  assert.deepEqual(parseRemote('git@github.example.com:team/app.git'), {
    url: 'https://github.example.com/team/app',
    slug: 'team/app',
  });
  assert.deepEqual(parseRemote('https://acme.ghe.com/team/app.git'), { url: 'https://acme.ghe.com/team/app', slug: 'team/app' });
});

test('parseRemote rejects other hosts and paths', () => {
  assert.equal(parseRemote('https://gitlab.com/worktabs/worktabs.git'), null);
  assert.equal(parseRemote('C:\\repos\\worktabs'), null);
  assert.equal(parseRemote('/srv/git/worktabs.git'), null);
  assert.equal(parseRemote('file:///srv/git/o/worktabs.git'), null);
  // A path to git, which takes host:path for SSH only with the colon.
  assert.equal(parseRemote('github.com/worktabs/worktabs'), null);
  assert.equal(parseRemote('https://github.com/worktabs'), null);
  assert.equal(parseRemote('https://gitlab.com/group/sub/worktabs.git'), null);
});

test('parseRemote takes an SSH host for the host it stands for in ~/.ssh/config', () => {
  const github = { url: 'https://github.com/o/r', slug: 'o/r' };
  // Accounts told apart by Host: github.com-work, github-work, work.github.com.
  assert.deepEqual(parseRemote('git@github.com-work:o/r.git', { hostname: 'github.com' }), github);
  assert.deepEqual(parseRemote('git@github-work:o/r.git', { hostname: 'github.com' }), github);
  assert.deepEqual(parseRemote('ssh://git@work.github.com/o/r.git', { hostname: 'github.com' }), github);
  assert.deepEqual(parseRemote('git@gh:o/r', { hostname: 'ssh.github.com' }), github);
  // Without ssh, by the remote's own host as before.
  assert.equal(parseRemote('git@github-work:o/r.git'), null);
  assert.equal(parseRemote('git@gitlab-work:o/r.git', { hostname: 'gitlab.com' }), null);
  // A web address has no SSH host.
  assert.equal(parseRemote('https://github-work/o/r.git', { hostname: 'github.com' }), null);
});

test('parseRemote takes the hosts gh is signed in to and those the settings add for GitHub', () => {
  const hosts = ['git.example.co.jp', 'ghe.example.com:8443'];
  assert.deepEqual(parseRemote('https://git.example.co.jp/team/app.git', { hosts }), { url: 'https://git.example.co.jp/team/app', slug: 'team/app' });
  assert.deepEqual(parseRemote('git@ghe-work:team/app.git', { hostname: 'git.example.co.jp', hosts }), {
    url: 'https://git.example.co.jp/team/app',
    slug: 'team/app',
  });
  assert.deepEqual(parseRemote('https://ghe.example.com:8443/team/app', { hosts }), { url: 'https://ghe.example.com:8443/team/app', slug: 'team/app' });
  assert.equal(parseRemote('https://git.example.com/team/app.git', { hosts }), null);
});

test('parseRemote keeps the port of a web address, not of SSH', () => {
  assert.deepEqual(parseRemote('https://github.example.com:8443/team/app.git'), {
    url: 'https://github.example.com:8443/team/app',
    slug: 'team/app',
  });
  assert.equal(parseRemote('ssh://git@github.example.com:2222/team/app.git').url, 'https://github.example.com/team/app');
});

test('hostnameIn reads the host ssh -G would connect to', () => {
  assert.equal(hostnameIn('user git\nhostname GitHub.com\nport 22\n'), 'github.com');
  assert.equal(hostnameIn('user git\r\nhostname ssh.github.com\r\nport 443\r\n'), 'ssh.github.com');
  assert.equal(hostnameIn(''), null);
});

test('jsonHosts and statusHosts read the hosts gh is signed in to', () => {
  const json = JSON.stringify({
    hosts: {
      'github.com': [{ state: 'success', active: true, host: 'github.com', login: 'o' }],
      'Git.Example.co.jp': [{ state: 'error', active: true, host: 'git.example.co.jp', login: 'o' }],
    },
  });
  assert.deepEqual(jsonHosts(json), ['github.com', 'git.example.co.jp']);
  assert.deepEqual(jsonHosts('{"hosts":{}}'), []);
  // A gh from before --json.
  assert.equal(jsonHosts('unknown flag: --json\n\nUsage:  gh auth status [flags]\n'), null);
  const words = [
    'github.com',
    '  ✓ Logged in to github.com account o (keyring)',
    '  - Active account: true',
    'git.example.co.jp',
    '  X Failed to log in to git.example.co.jp account o (GH_ENTERPRISE_TOKEN)',
    'ghe.example.com',
    '  ✓ Logged in to ghe.example.com as o (/home/o/.config/gh/hosts.yml)',
  ].join('\n');
  assert.deepEqual(statusHosts(words), ['github.com', 'git.example.co.jp', 'ghe.example.com']);
  assert.deepEqual(statusHosts('You are not logged into any GitHub hosts. To log in, run: gh auth login\n'), []);
});

test('the SSH host is never given to ssh as an option', async () => {
  assert.equal(await sshHostname(process.cwd(), '-oProxyCommand=calc'), null);
});

test('hasBranchPage is false on the default branch and a detached HEAD', () => {
  assert.equal(hasBranchPage({ branch: 'feat/x', defaultBranch: 'main' }), true);
  assert.equal(hasBranchPage({ branch: 'main', defaultBranch: 'main' }), false);
  assert.equal(hasBranchPage({ branch: null, defaultBranch: 'main' }), false);
});

test('pageUrl builds the fixed pages from the repository address', async () => {
  const repo = { url: 'https://github.com/o/r', branch: 'main', defaultBranch: 'main' };
  assert.equal(await pageUrl(repo, 'repo'), 'https://github.com/o/r');
  assert.equal(await pageUrl(repo, 'issues'), 'https://github.com/o/r/issues');
  assert.equal(await pageUrl(repo, 'actions'), 'https://github.com/o/r/actions');
  // On the default branch, "this branch's pull request" is the pull request list.
  assert.equal(await pageUrl(repo, 'branch'), 'https://github.com/o/r/pulls');
});

test('githubRepo reads the remote, the current branch and the default branch', async (t) => {
  const repo = makeRepo(tempDir(t));
  assert.equal(await githubRepo(repo), null);

  git(repo, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  assert.deepEqual(await githubRepo(repo), {
    url: 'https://github.com/o/r',
    slug: 'o/r',
    branch: 'feat/x',
    defaultBranch: 'main',
  });

  git(repo, 'checkout', '-q', '--detach');
  assert.equal((await githubRepo(repo)).branch, null);
});

test('pullsQuery asks for each branch in one query, the branches as variables', () => {
  const { query, variables } = pullsQuery({ url: 'https://github.com/o/r', slug: 'o/r' }, ['feat/x', 'fix/"y"']);
  assert.deepEqual(variables, { owner: 'o', name: 'r', b0: 'feat/x', b1: 'fix/"y"' });
  assert.ok(query.startsWith('query($owner: String!, $name: String!, $b0: String!, $b1: String!)'), query);
  assert.ok(query.includes('b0: pullRequests(headRefName: $b0,'), query);
  assert.ok(query.includes('b1: pullRequests(headRefName: $b1,'), query);
  // The branch names never go into the query itself.
  assert.doesNotMatch(query, /feat\/|fix\/|"/);
});

test('pullsQuery also asks for the pull request a branch was made from, by its address', () => {
  const { query, variables } = pullsQuery({ url: 'https://github.com/o/r', slug: 'o/r' }, ['alice/patch-1', 'feat/x'], { 'alice/patch-1': 71 });
  assert.deepEqual(variables, { owner: 'o', name: 'r', b0: 'alice/patch-1', b1: 'feat/x', p0: 'https://github.com/o/r/pull/71' });
  assert.ok(query.startsWith('query($owner: String!, $name: String!, $b0: String!, $b1: String!, $p0: URI!)'), query);
  assert.ok(query.includes('b0: pullRequests(headRefName: $b0,'), query);
  assert.ok(query.includes('b1: pullRequests(headRefName: $b1,'), query);
  // Outside the repository, so that a number it does not have answers null instead of failing
  // the whole query.
  assert.ok(query.includes('} p0: resource(url: $p0) { ... on PullRequest { ...pull } } } fragment pull'), query);
  assert.doesNotMatch(query, /\$p1/);
});

test('pullsQuery asks for the commits of the HEADs in the repository, with the checks of each commit', () => {
  const heads = ['a'.repeat(40), 'b'.repeat(40)];
  const { query, variables } = pullsQuery({ url: 'https://github.com/o/r', slug: 'o/r' }, ['feat/x'], { 'feat/x': 7 }, heads);
  assert.deepEqual(variables, { owner: 'o', name: 'r', b0: 'feat/x', p0: 'https://github.com/o/r/pull/7', h0: heads[0], h1: heads[1] });
  assert.ok(query.startsWith('query($owner: String!, $name: String!, $b0: String!, $p0: URI!, $h0: GitObjectID!, $h1: GitObjectID!)'), query);
  assert.ok(query.includes('h0: object(oid: $h0) { ...commit } h1: object(oid: $h1) { ...commit } }'), query);
  // A pull request's last commit and its merge commit.
  assert.ok(query.includes('isCrossRepository headRefOid commits(last: 1) { nodes { commit { ...commit } } } mergeCommit { ...commit }'), query);
  assert.ok(query.includes('fragment commit on Commit { oid statusCheckRollup { state contexts(first: 30) {'), query);
});

test('pullsQuery asks for HEADs alone', () => {
  const { query, variables } = pullsQuery({ url: 'https://github.com/o/r', slug: 'o/r' }, [], {}, ['a'.repeat(40)]);
  assert.deepEqual(variables, { owner: 'o', name: 'r', h0: 'a'.repeat(40) });
  assert.ok(query.startsWith('query($owner: String!, $name: String!, $h0: GitObjectID!) { repository(owner: $owner, name: $name) { h0: object'), query);
});

// The checks of a commit as the query answers them: v0.2.0's release commit, whose push to main
// ran CI and whose tag ran Release.
const suite = (name, prefix, workflow) => ({ branch: { name, prefix }, workflowRun: { workflow: { name: workflow } } });
const RELEASE = {
  oid: '6c2c52ccbb81ca1cdc577c2a686b2d7f3595f985',
  statusCheckRollup: {
    state: 'PENDING',
    contexts: {
      totalCount: 4,
      nodes: [
        { name: 'Test (ubuntu-latest)', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-01T11:03:07Z', completedAt: '2026-10-01T11:03:33Z', checkSuite: suite('main', 'refs/heads/', 'CI') },
        { name: 'Release (Windows)', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-10-01T11:03:08Z', completedAt: null, checkSuite: suite('v0.2.0', 'refs/tags/', 'Release') },
        { name: 'Test (windows-latest)', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-01T11:03:08Z', completedAt: '2026-10-01T11:04:38Z', checkSuite: suite('main', 'refs/heads/', 'CI') },
        { name: 'Build (Windows)', status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null, checkSuite: suite('main', 'refs/heads/', 'CI') },
      ],
    },
  },
};

test('readChecks names each check after its workflow, with when it last moved and what it ran for', () => {
  assert.deepEqual(readChecks(RELEASE), {
    oid: RELEASE.oid,
    state: 'pending',
    runs: [
      { name: 'CI / Test (ubuntu-latest)', state: 'success', at: Date.parse('2026-10-01T11:03:33Z'), ref: 'refs/heads/main' },
      { name: 'Release / Release (Windows)', state: 'pending', at: Date.parse('2026-10-01T11:03:08Z'), ref: 'refs/tags/v0.2.0' },
      { name: 'CI / Test (windows-latest)', state: 'failure', at: Date.parse('2026-10-01T11:04:38Z'), ref: 'refs/heads/main' },
      { name: 'CI / Build (Windows)', state: 'pending', at: null, ref: 'refs/heads/main' },
    ],
    total: 4,
    at: Date.parse('2026-10-01T11:04:38Z'),
  });
});

test('readChecks reads every outcome, of check runs and of commit statuses', () => {
  const run = (status, conclusion) => ({ name: 'job', status, conclusion, startedAt: null, completedAt: null, checkSuite: null });
  const checks = readChecks({
    oid: 'c'.repeat(40),
    statusCheckRollup: {
      state: 'FAILURE',
      contexts: {
        totalCount: 40,
        nodes: [
          run('COMPLETED', 'SUCCESS'),
          run('COMPLETED', 'NEUTRAL'),
          run('COMPLETED', 'SKIPPED'),
          run('COMPLETED', 'CANCELLED'),
          run('COMPLETED', 'TIMED_OUT'),
          run('COMPLETED', 'ACTION_REQUIRED'),
          run('WAITING', null),
          { context: 'ci/circleci', state: 'ERROR', createdAt: '2026-10-01T09:00:00Z' },
          { context: 'deploy', state: 'EXPECTED', createdAt: 'not a time' },
          // A kind of check this does not know.
          {},
          null,
        ],
      },
    },
  });
  assert.deepEqual(checks.runs.map((r) => r.state), ['success', 'success', 'skipped', 'cancelled', 'failure', 'failure', 'pending', 'failure', 'pending']);
  assert.deepEqual(checks.runs.slice(-2).map((r) => r.name), ['ci/circleci', 'deploy']);
  assert.equal(checks.state, 'failure');
  assert.equal(checks.total, 40);
  assert.equal(checks.at, Date.parse('2026-10-01T09:00:00Z'));
});

test('readChecks reads every outcome of the whole and nothing without checks', () => {
  const states = ['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED'];
  assert.deepEqual(
    states.map((state) => readChecks({ oid: 'c'.repeat(40), statusCheckRollup: { state } }).state),
    ['success', 'failure', 'failure', 'pending', 'pending'],
  );
  // Without contexts (an older answer), none is named and none says when.
  assert.deepEqual(readChecks({ oid: 'c'.repeat(40), statusCheckRollup: { state: 'SUCCESS' } }), { oid: 'c'.repeat(40), state: 'success', runs: [], total: 0, at: null });
  assert.equal(readChecks({ oid: 'c'.repeat(40), statusCheckRollup: null }), null);
  assert.equal(readChecks(null), null);
});

// A pull request as the query answers it.
const rollup = (state) => state && { state };
const pull = (number, state, { draft = false, fork = false, checks = null, merge = null, title = `PR ${number}`, head } = {}) => ({
  number,
  title,
  state,
  isDraft: draft,
  isCrossRepository: fork,
  headRefOid: head,
  commits: { nodes: [{ commit: { oid: `head${number}`, statusCheckRollup: rollup(checks) } }] },
  mergeCommit: state === 'MERGED' ? { oid: `merge${number}`, statusCheckRollup: rollup(merge) } : null,
});
const answer = (...fields) => ({ data: { repository: Object.fromEntries(fields.map((nodes, i) => [`b${i}`, { nodes }])) } });
// The checks of a commit as readChecks gives them, without names or times.
const checks = (oid, state) => ({ oid, state, runs: [], total: 0, at: null });

test('readPulls gives the state of each pull request, the checks of open ones and those of the merge of merged ones', () => {
  const found = readPulls(
    answer(
      [pull(1, 'OPEN', { checks: 'SUCCESS', title: 'Add x' })],
      [pull(2, 'OPEN', { draft: true, checks: 'PENDING' })],
      [pull(3, 'MERGED', { checks: 'SUCCESS', merge: 'FAILURE' })],
      [pull(4, 'CLOSED', { checks: 'FAILURE' })],
      [pull(5, 'MERGED', { checks: 'SUCCESS' })],
      [],
    ),
    ['a', 'b', 'c', 'd', 'e', 'f'],
  );
  assert.deepEqual(Object.fromEntries(found), {
    a: { number: 1, title: 'Add x', state: 'open', head: null, checks: checks('head1', 'success') },
    b: { number: 2, title: 'PR 2', state: 'draft', head: null, checks: checks('head2', 'pending') },
    c: { number: 3, title: 'PR 3', state: 'merged', head: null, checks: checks('merge3', 'failure') },
    d: { number: 4, title: 'PR 4', state: 'closed', head: null, checks: null },
    // No checks ran on the merge.
    e: { number: 5, title: 'PR 5', state: 'merged', head: null, checks: null },
  });
});

test('readPulls gives the last commit of each pull request, when it is a full commit id', () => {
  const head = 'a'.repeat(40);
  const found = readPulls(answer([pull(1, 'MERGED', { head })], [pull(2, 'OPEN', { head: 'a1b2c3d' })], [pull(3, 'CLOSED', { head: null })]), ['a', 'b', 'c']);
  assert.deepEqual([...found.values()].map((p) => p.head), [head, null, null]);
});

test('readPulls reads every outcome of the checks', () => {
  const states = ['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED', null];
  const found = readPulls(answer(...states.map((state, i) => [pull(i + 1, 'OPEN', { checks: state })])), states.map((_, i) => `b${i}`));
  assert.deepEqual([...found.values()].map((p) => p.checks && p.checks.state), ['success', 'failure', 'failure', 'pending', 'pending', null]);
});

test('readPulls picks an open pull request first, else the newest, and none from a fork', () => {
  const found = readPulls(
    answer(
      [pull(9, 'CLOSED'), pull(5, 'OPEN'), pull(2, 'MERGED')],
      [pull(9, 'CLOSED'), pull(2, 'MERGED')],
      [pull(7, 'OPEN', { fork: true }), pull(3, 'MERGED')],
      [pull(8, 'OPEN', { fork: true })],
    ),
    ['a', 'b', 'c', 'd'],
  );
  assert.deepEqual(Object.fromEntries([...found].map(([branch, p]) => [branch, p.number])), { a: 5, b: 9, c: 3 });
});

test('readPulls takes the pull request a branch was made from, from a fork too, else as for any branch', () => {
  const found = readPulls(
    {
      data: {
        ...answer([pull(5, 'OPEN')], [], [pull(8, 'MERGED')], [pull(3, 'OPEN')]).data,
        p0: pull(71, 'OPEN', { fork: true, checks: 'FAILURE' }),
        // Numbers the repository does not have: its remote was changed since.
        p1: null,
        p2: {},
      },
    },
    ['alice/patch-1', 'gone', 'renamed', 'feat/x'],
    { 'alice/patch-1': 71, gone: 9, renamed: 10 },
  );
  assert.deepEqual(Object.fromEntries(found), {
    'alice/patch-1': { number: 71, title: 'PR 71', state: 'open', head: null, checks: checks('head71', 'failure') },
    renamed: { number: 8, title: 'PR 8', state: 'merged', head: null, checks: null },
    'feat/x': { number: 3, title: 'PR 3', state: 'open', head: null, checks: null },
  });
});

test('readPulls finds nothing in an answer without the repository', () => {
  assert.equal(readPulls({ data: { repository: null } }, ['a']).size, 0);
  assert.equal(readPulls(null, ['a']).size, 0);
});

test('readHeads gives the checks of the HEADs GitHub has with checks', () => {
  const heads = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
  const found = readHeads(
    {
      data: {
        repository: {
          h0: RELEASE,
          // Not pushed: GitHub does not have it.
          h1: null,
          // Pushed, but no checks ran on it (yet).
          h2: { oid: heads[2], statusCheckRollup: null },
        },
      },
    },
    heads,
  );
  assert.deepEqual([...found.keys()], [heads[0]]);
  assert.equal(found.get(heads[0]).state, 'pending');
  assert.equal(readHeads({ data: { repository: null } }, heads).size, 0);
});

test('branchPulls does not ask gh without branches or HEADs', async () => {
  const found = await branchPulls({ url: 'https://github.com/o/r', slug: 'o/r' }, [], { heads: ['not a commit id'] });
  assert.equal(found.pulls.size, 0);
  assert.equal(found.heads.size, 0);
});

test('mergedAtHead holds for a merged pull request whose last commit is the HEAD', () => {
  const head = 'a'.repeat(40);
  const merged = { number: 12, state: 'merged', head };
  assert.equal(mergedAtHead(merged, head), true);
  // A commit added after the merge, or one pushed to the pull request and not pulled.
  assert.equal(mergedAtHead(merged, 'b'.repeat(40)), false);
  for (const state of ['open', 'draft', 'closed']) assert.equal(mergedAtHead({ ...merged, state }, head), false, state);
  // GitHub did not say what its last commit is, or the worktree's commit is not known.
  assert.equal(mergedAtHead({ ...merged, head: null }, null), false);
  assert.equal(mergedAtHead({ ...merged, head: 'a1b2c3d' }, 'a1b2c3d'), false);
  assert.equal(mergedAtHead(merged, undefined), false);
  assert.equal(mergedAtHead(null, head), false);
});

test('checksUrl opens the checks of a full commit id only', () => {
  const repo = { url: 'https://github.com/o/r' };
  assert.equal(checksUrl(repo, RELEASE.oid), `https://github.com/o/r/commit/${RELEASE.oid}/checks`);
  assert.equal(checksUrl(repo, '6c2c52c'), null);
  assert.equal(checksUrl(repo, '../../settings'), null);
});

test('startsChecks knows the commands after which GitHub starts checks', () => {
  for (const command of [
    'git push',
    'git push -u origin feat/x',
    'git push --follow-tags',
    'npm version patch && git push && git push --tags',
    'git -C ../worktabs-feat-x push origin HEAD',
    'git -c push.default=current push',
    'git --no-pager push',
    'gh pr create --fill',
    'gh pr merge 93 --squash --delete-branch',
    'gh pr ready',
    'gh release create v0.3.0',
    'gh workflow run ci.yml',
    'gh run rerun 123 --failed',
  ]) {
    assert.equal(startsChecks(command), true, command);
  }
  for (const command of [
    'git status',
    'git stash push -m wip',
    'git commit -m "push the button"',
    'git log origin/main..HEAD',
    'gh pr view 93',
    'gh pr checks 93 --watch',
    'gh run watch',
    'npm test',
  ]) {
    assert.equal(startsChecks(command), false, command);
  }
  assert.equal(startsChecks(undefined), false);
});

test('readRemotes looks up SSH hosts, and asks gh only for the hosts their names do not tell', async (t) => {
  const dir = tempDir(t);
  const remote = (name, address) => {
    const repo = makeRepo(dir, name);
    git(repo, 'remote', 'add', 'origin', address);
    return repo;
  };
  const alias = remote('alias', 'git@github-work:o/alias.git');
  const enterprise = remote('enterprise', 'https://git.example.co.jp/team/enterprise.git');
  const configured = remote('configured', 'https://code.example.com/team/configured.git');
  const github = remote('github', 'https://github.com/o/github.git');
  const gitlab = remote('gitlab', 'git@gitlab-work:g/sub/gitlab.git');
  const bitbucket = remote('bitbucket', 'https://bitbucket.example.com/scm/proj/bitbucket.git');
  const other = remote('other', 'https://git.example.com/o/other.git');
  const asked = { ssh: [], gh: 0 };
  t.mock.method(lookup, 'sshHostname', async (folder, host) => {
    asked.ssh.push(host);
    return { 'github-work': 'github.com', 'gitlab-work': 'gitlab.com' }[host] || host;
  });
  t.mock.method(lookup, 'signedInHosts', async () => {
    asked.gh += 1;
    return ['git.example.co.jp'];
  });
  setGithubHosts(['https://Code.Example.com/', 42]);
  t.after(() => setGithubHosts([]));
  const found = await readRemotes([alias, enterprise, configured, github, gitlab, bitbucket, other], 1);
  // The owner is on the host an SSH alias stands for; on GitLab, a group with its subgroups; on a
  // Bitbucket Server, the project, without the /scm/ of its web address.
  assert.deepEqual(Object.fromEntries(found), {
    [alias]: { provider: 'github', url: 'https://github.com/o/alias', owner: { host: 'github.com', owner: 'o' } },
    [enterprise]: { provider: 'github', url: 'https://git.example.co.jp/team/enterprise', owner: { host: 'git.example.co.jp', owner: 'team' } },
    [configured]: { provider: 'github', url: 'https://code.example.com/team/configured', owner: { host: 'code.example.com', owner: 'team' } },
    [github]: { provider: 'github', url: 'https://github.com/o/github', owner: { host: 'github.com', owner: 'o' } },
    [gitlab]: { provider: 'gitlab', url: null, owner: { host: 'gitlab.com', owner: 'g/sub' } },
    [bitbucket]: { provider: 'bitbucket', url: null, owner: { host: 'bitbucket.example.com', owner: 'proj' } },
    [other]: { provider: 'other', url: null, owner: null },
  });
  // ssh for the SSH remotes only; gh for git.example.co.jp and git.example.com.
  assert.deepEqual(asked, { ssh: ['github-work', 'gitlab-work'], gh: 2 });
});

test('readRemotes reads where the remote of each folder is, and leaves out those git fails on', async (t) => {
  const dir = tempDir(t);
  const github = makeRepo(dir, 'a');
  git(github, 'remote', 'add', 'upstream', 'https://github.com/up/a.git');
  git(github, 'remote', 'add', 'origin', 'git@github.com:o/a.git');
  const elsewhere = makeRepo(dir, 'b');
  git(elsewhere, 'remote', 'add', 'origin', 'https://gitlab.com/o/b.git');
  const local = makeRepo(dir, 'c');
  // A remote that is a path to another repository.
  const nearby = makeRepo(dir, 'd');
  git(nearby, 'remote', 'add', 'origin', local);
  const gone = path.join(dir, 'gone');
  const found = await readRemotes([github, elsewhere, local, nearby, gone], 2);
  assert.deepEqual(
    [...found].sort(([a], [b]) => a.localeCompare(b)),
    [
      [github, { provider: 'github', url: 'https://github.com/o/a', owner: { host: 'github.com', owner: 'o' } }],
      [elsewhere, { provider: 'gitlab', url: null, owner: { host: 'gitlab.com', owner: 'o' } }],
      [local, { provider: 'none', url: null, owner: null }],
      [nearby, { provider: 'other', url: null, owner: null }],
    ],
  );
});

test('providerOf tells GitHub, GitLab and Bitbucket from other remotes', () => {
  assert.equal(providerOf('git@github.com:o/r.git'), 'github');
  assert.equal(providerOf('https://gitlab.com/group/sub/project.git'), 'gitlab');
  assert.equal(providerOf('https://gitlab.example.co.jp/group/project.git'), 'gitlab');
  assert.equal(providerOf('ssh://git@altssh.gitlab.com:443/group/project.git'), 'gitlab');
  assert.equal(providerOf('git@bitbucket.org:team/repo.git'), 'bitbucket');
  assert.equal(providerOf('ssh://git@bitbucket.example.com:7999/proj/repo.git'), 'bitbucket');
  assert.equal(providerOf('git@work:team/repo.git', { hostname: 'bitbucket.org' }), 'bitbucket');
  assert.equal(providerOf('https://codeberg.org/o/r.git'), 'other');
  assert.equal(providerOf('C:\\repos\\r'), 'other');
  assert.equal(providerOf('/srv/git/r.git'), 'other');
  // GitHub has owner/name only.
  assert.equal(providerOf('https://github.com/o/r/extra'), 'other');
});

test('ownerOf tells whose a repository is on GitHub, GitLab and Bitbucket, and on no other host', () => {
  const owner = (remote, options = {}) => remoteOf(remoteParts(remote), options).owner;
  assert.deepEqual(owner('git@github.com:Sunset/novel-writing.git'), { host: 'github.com', owner: 'Sunset' });
  assert.deepEqual(owner('https://github.example.com:8443/team/app'), { host: 'github.example.com', owner: 'team' }, 'the port is not the host\'s');
  assert.deepEqual(owner('ssh://git@ssh.github.com:443/o/r.git'), { host: 'github.com', owner: 'o' });
  assert.deepEqual(owner('git@work:o/r.git', { hostname: 'github.com' }), { host: 'github.com', owner: 'o' });
  assert.deepEqual(owner('https://gitlab.com/group/sub/project.git'), { host: 'gitlab.com', owner: 'group/sub' });
  assert.deepEqual(owner('ssh://git@bitbucket.example.com:7999/proj/repo.git'), { host: 'bitbucket.example.com', owner: 'proj' });
  assert.deepEqual(owner('https://bitbucket.example.com/scm/proj/repo.git'), { host: 'bitbucket.example.com', owner: 'proj' });
  assert.deepEqual(owner('https://bitbucket.org/team/repo.git'), { host: 'bitbucket.org', owner: 'team' });
  assert.equal(owner('https://codeberg.org/o/r.git'), null);
  assert.equal(owner('C:\\repos\\r'), null);
  assert.equal(ownerOf(null, 'github'), null);
  assert.equal(ownerOf(remoteParts('https://gitlab.com/project'), 'gitlab'), null, 'a path of one name has no owner');
});

test('visibilityGroups asks gh once for each place it runs and host, with the folders it asks for', () => {
  const repos = [
    ['C:\\repos\\a', 'https://github.com/o/a'],
    ['C:\\repos\\b', 'https://github.com/o/b'],
    ['C:\\repos\\a-copy', 'https://github.com/o/a'],
    ['C:\\repos\\e', 'https://github.example.com/team/e'],
    ['\\\\wsl.localhost\\Ubuntu\\home\\me\\a', 'https://github.com/o/a'],
    ['\\\\wsl$\\ubuntu\\home\\me\\c', 'https://github.com/o/c'],
  ];
  assert.deepEqual(visibilityGroups(repos), [
    { folder: 'C:\\repos\\a', folders: ['C:\\repos\\a', 'C:\\repos\\b', 'C:\\repos\\a-copy'], urls: ['https://github.com/o/a', 'https://github.com/o/b'] },
    { folder: 'C:\\repos\\e', folders: ['C:\\repos\\e'], urls: ['https://github.example.com/team/e'] },
    // In WSL, with the gh signed in there: the same repository is asked about again.
    {
      folder: '\\\\wsl.localhost\\Ubuntu\\home\\me\\a',
      folders: ['\\\\wsl.localhost\\Ubuntu\\home\\me\\a', '\\\\wsl$\\ubuntu\\home\\me\\c'],
      urls: ['https://github.com/o/a', 'https://github.com/o/c'],
    },
  ]);
  assert.deepEqual(visibilityGroups([]), []);
});

test('visibilityQuery asks for each repository by its owner and name, as variables', () => {
  const { query, variables } = visibilityQuery(['https://github.com/o/a', 'https://github.example.com/team/b.js']);
  assert.deepEqual(variables, { o0: 'o', n0: 'a', o1: 'team', n1: 'b.js' });
  assert.equal(
    query,
    'query($o0: String!, $n0: String!, $o1: String!, $n1: String!) { r0: repository(owner: $o0, name: $n0) { visibility url } r1: repository(owner: $o1, name: $n1) { visibility url } }',
  );
});

test('readVisibility reads what GitHub told, with where it has the repository now, and leaves out the repositories it did not', () => {
  const urls = ['https://github.com/o/a', 'https://github.com/o/b', 'https://github.com/o/c', 'https://github.com/o/gone', 'https://github.com/o/d'];
  // A repository that is gone or not to be seen is null (with an error in the answer). One renamed
  // or moved answers at its old address, with its new one.
  const answer = {
    data: {
      r0: { visibility: 'PRIVATE', url: 'https://github.com/o/a' },
      r1: { visibility: 'INTERNAL', url: 'https://github.com/p/b2' },
      r2: { visibility: 'PUBLIC' },
      r3: null,
      r4: {},
    },
  };
  assert.deepEqual(
    [...readVisibility(answer, urls)],
    [
      ['https://github.com/o/a', { visibility: 'private', current: 'https://github.com/o/a' }],
      ['https://github.com/o/b', { visibility: 'internal', current: 'https://github.com/p/b2' }],
      ['https://github.com/o/c', { visibility: 'public', current: null }],
    ],
  );
  assert.deepEqual([...readVisibility(null, urls)], []);
});

// An open pull request of one's own as APPROVED_QUERY asks for it.
const openPull = (fields = {}) => ({
  number: 7,
  title: 'Fix it',
  url: 'https://github.com/o/a/pull/7',
  isDraft: false,
  reviewDecision: null,
  repository: { url: 'https://github.com/o/a', isArchived: false },
  latestOpinionatedReviews: { nodes: [] },
  ...fields,
});
const reviews = (...states) => ({ nodes: states.map((state) => ({ state })) });

test("isApproved takes GitHub's decision where reviews are required", () => {
  assert.equal(isApproved(openPull({ reviewDecision: 'APPROVED' })), true);
  // The reviews do not overrule it: one approval of two required, or changes asked for since.
  assert.equal(isApproved(openPull({ reviewDecision: 'REVIEW_REQUIRED', latestOpinionatedReviews: reviews('APPROVED') })), false);
  assert.equal(isApproved(openPull({ reviewDecision: 'CHANGES_REQUESTED', latestOpinionatedReviews: reviews('APPROVED', 'CHANGES_REQUESTED') })), false);
});

test('isApproved takes the latest reviews where GitHub decides nothing', () => {
  assert.equal(isApproved(openPull({ latestOpinionatedReviews: reviews('APPROVED') })), true);
  assert.equal(isApproved(openPull({ latestOpinionatedReviews: reviews('APPROVED', 'COMMENTED') })), true);
  assert.equal(isApproved(openPull({ latestOpinionatedReviews: reviews('APPROVED', 'CHANGES_REQUESTED') })), false);
  assert.equal(isApproved(openPull({ latestOpinionatedReviews: reviews('COMMENTED') })), false);
  assert.equal(isApproved(openPull()), false);
  assert.equal(isApproved(openPull({ latestOpinionatedReviews: null })), false);
});

test('isApproved leaves out drafts', () => {
  assert.equal(isApproved(openPull({ isDraft: true, reviewDecision: 'APPROVED' })), false);
  assert.equal(isApproved(openPull({ isDraft: undefined, reviewDecision: 'APPROVED' })), false);
  assert.equal(isApproved(null), false);
});

test('readApproved gives the approved pull requests with the repository each would be merged into', () => {
  const answer = {
    data: {
      viewer: {
        pullRequests: {
          nodes: [
            openPull({ reviewDecision: 'APPROVED' }),
            openPull({
              number: 8,
              title: null,
              url: 'https://github.com/o/b/pull/8',
              repository: { url: 'https://github.com/o/b', isArchived: false },
              latestOpinionatedReviews: reviews('APPROVED'),
            }),
            openPull({ number: 9 }),
            openPull({ number: 10, isDraft: true, reviewDecision: 'APPROVED' }),
            // An archived repository's cannot be merged.
            openPull({ number: 11, reviewDecision: 'APPROVED', repository: { url: 'https://github.com/o/old', isArchived: true } }),
            // One GitHub did not let the account see (an organization's SAML single sign-on).
            null,
            openPull({ number: 12, reviewDecision: 'APPROVED', repository: null }),
          ],
        },
      },
    },
  };
  assert.deepEqual(readApproved(answer), [
    { repo: 'https://github.com/o/a', number: 7, title: 'Fix it', url: 'https://github.com/o/a/pull/7' },
    { repo: 'https://github.com/o/b', number: 8, title: '', url: 'https://github.com/o/b/pull/8' },
  ]);
  assert.deepEqual(readApproved(null), []);
  assert.deepEqual(readApproved({ data: { viewer: null } }), []);
});

// A repository of the account as gh writes it for OWNED_JQ.
const ownedLine = (fields = {}) =>
  JSON.stringify({
    owner: 'worktabs',
    type: 'User',
    name: 'worktabs',
    url: 'https://github.com/worktabs/worktabs',
    fork: false,
    archived: false,
    visibility: 'public',
    description: 'Tabs',
    pushed: '2026-10-01T11:03:07Z',
    ...fields,
  });

test('readOwnedRepos reads each repository gh wrote, the forks too, without the archived ones', () => {
  const output = [
    ownedLine(),
    ownedLine({ owner: 'kumiki-dev', type: 'Organization', name: 'kumiki', url: 'https://github.com/kumiki-dev/kumiki', visibility: 'private', description: null }),
    ownedLine({ name: 'some-fork', url: 'https://github.com/worktabs/some-fork', fork: true, pushed: null }),
    ownedLine({ name: 'old', url: 'https://github.com/worktabs/old', archived: true }),
    '',
  ].join('\n');
  assert.deepEqual(readOwnedRepos(output, 'GitHub.com'), [
    {
      host: 'github.com',
      owner: 'worktabs',
      type: 'user',
      name: 'worktabs',
      url: 'https://github.com/worktabs/worktabs',
      fork: false,
      visibility: 'public',
      description: 'Tabs',
      pushedAt: Date.parse('2026-10-01T11:03:07Z'),
    },
    {
      host: 'github.com',
      owner: 'kumiki-dev',
      type: 'org',
      name: 'kumiki',
      url: 'https://github.com/kumiki-dev/kumiki',
      fork: false,
      visibility: 'private',
      description: '',
      pushedAt: Date.parse('2026-10-01T11:03:07Z'),
    },
    {
      host: 'github.com',
      owner: 'worktabs',
      type: 'user',
      name: 'some-fork',
      url: 'https://github.com/worktabs/some-fork',
      fork: true,
      visibility: 'public',
      description: 'Tabs',
      pushedAt: null,
    },
  ]);
});

test('readOwnedRepos reads the repositories of a GitHub Enterprise Server, internal ones too', () => {
  const output = ownedLine({ owner: 'team', type: 'Organization', name: 'app', url: 'https://ghe.example.com/team/app', visibility: 'internal' });
  const [repo] = readOwnedRepos(`${output}\r\n`, 'ghe.example.com');
  assert.equal(repo.host, 'ghe.example.com');
  assert.equal(repo.url, 'https://ghe.example.com/team/app');
  assert.equal(repo.visibility, 'internal');
  assert.equal(repo.type, 'org');
});

test('readOwnedRepos leaves out what it cannot take for a repository', () => {
  const output = [
    'not json',
    'null',
    ownedLine({ archived: undefined }),
    // Names a command line or a path could take for more.
    ownedLine({ name: '--upload-pack=x' }),
    ownedLine({ name: '..' }),
    ownedLine({ owner: 'o/p' }),
    ownedLine({ url: 'https://github.com/worktabs' }),
    ownedLine({ url: 42 }),
    // A visibility it does not know is no visibility.
    ownedLine({ visibility: 'secret' }),
  ].join('\n');
  const found = readOwnedRepos(output, 'github.com');
  assert.equal(found.length, 1);
  assert.equal(found[0].visibility, null);
});
