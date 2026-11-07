const assert = require('node:assert/strict');
const test = require('node:test');
const { createGithubClient } = require('../src/repos/github-client');

function client(runAt, remote = 'git@work-host:owner/repo.git') {
  return createGithubClient({
    runAt, runGit: async () => remote, mainRemote: async () => 'origin',
    currentBranch: async () => 'task', defaultBranch: async () => 'main',
  });
}

test('pull queries preserve host, cwd, timeout, variables, and WSL shell environment', async () => {
  const calls = [];
  const github = client(async (...args) => { calls.push(args); return '{}'; });
  const repo = { url: 'https://github.example.com/owner/repo', slug: 'owner/repo' };
  await github.branchPulls(repo, ['task'], { folder: '\\\\wsl.localhost\\Ubuntu\\repo', timeout: 321 });
  const { query, variables } = github.pullsQuery(repo, ['task']);
  assert.deepEqual(calls, [[
    '\\\\wsl.localhost\\Ubuntu\\repo', 'gh',
    ['api', 'graphql', '--hostname', 'github.example.com', '-f', `query=${query}`,
      ...Object.entries(variables).flatMap(([key, value]) => ['-f', `${key}=${value}`])],
    321, { shellEnv: true },
  ]]);
});

test('visibility and approved queries accept partial data while branch queries reject the same failure', async () => {
  const failure = Object.assign(new Error('GraphQL failed'), {
    stdout: JSON.stringify({ data: { r0: { url: 'https://github.com/owner/repo', visibility: 'PRIVATE' } }, errors: [{ message: 'Another repository is unavailable' }] }),
  });
  const github = client(async () => { throw failure; });
  const visibility = await github.repoVisibility(['https://github.com/owner/repo']);
  assert.equal(visibility.get('https://github.com/owner/repo').visibility, 'private');
  assert.deepEqual(await github.approvedPulls('github.com'), []);
  await assert.rejects(github.branchPulls({ url: 'https://github.com/owner/repo', slug: 'owner/repo' }, ['task']), (error) => error === failure);
});

test('partial queries still reject transport failures, data-free refusals, and malformed JSON', async () => {
  for (const failure of [new Error('offline'), Object.assign(new Error('unauthorized'), { stdout: '{"errors":[]}' })]) {
    const github = client(async () => { throw failure; });
    await assert.rejects(github.approvedPulls('github.com'), (error) => error === failure);
    await assert.rejects(github.repoVisibility(['https://github.com/owner/repo']), (error) => error === failure);
  }
  const github = client(async () => 'invalid JSON');
  await assert.rejects(github.approvedPulls('github.com'), SyntaxError);
});

test('host lookups coalesce per client and place, and invalidation rereads only that client', async () => {
  const calls = [[], []];
  const clients = calls.map((record) => client(async (folder, command, args) => {
    record.push([folder, command, args]);
    return command === 'ssh' ? 'hostname github.com\n' : '{"hosts":{}}';
  }));
  await Promise.all([clients[0].githubRepo('C:\\one'), clients[0].githubRepo('C:\\two'), clients[1].githubRepo('C:\\one')]);
  assert.equal(calls[0].length, 1);
  assert.equal(calls[1].length, 1);
  clients[0].forgetHostLookups();
  await clients[0].githubRepo('C:\\one');
  await clients[1].githubRepo('C:\\two');
  assert.equal(calls[0].length, 2);
  assert.equal(calls[1].length, 1);
  await clients[0].githubRepo('\\\\wsl.localhost\\Ubuntu\\repo');
  assert.equal(calls[0].length, 3);
});

test('configured GitHub hosts and signed-in hosts stay independent between clients', async () => {
  const runAt = async (_folder, command) => command === 'ssh' ? 'hostname code.example\n' : '{"hosts":{}}';
  const first = client(runAt);
  const second = client(runAt);
  first.setGithubHosts(['code.example']);
  assert.equal((await first.githubRepo('C:\\repo')).url, 'https://code.example/owner/repo');
  assert.equal(await second.githubRepo('C:\\repo'), null);
  assert.deepEqual(await second.signedInHosts('C:\\repo'), []);
  first.lookup.signedInHosts = async () => ['code.example'];
  first.setGithubHosts([]);
  assert.equal((await first.githubRepo('C:\\repo')).url, 'https://code.example/owner/repo');
  assert.equal(await second.githubRepo('C:\\repo'), null);
});

test('a remote git fails to read rejects readGithubRepo, which githubRepo reads as null', async () => {
  const failure = new Error('git timed out');
  let remote = failure;
  let url = 'https://github.com/owner/repo.git';
  const github = createGithubClient({
    runAt: async () => '{"hosts":{}}', runGit: async () => url,
    mainRemote: async () => { if (remote instanceof Error) throw remote; return remote; },
    currentBranch: async () => 'task', defaultBranch: async () => 'main',
  });
  await assert.rejects(github.readGithubRepo('C:\\repo'), (error) => error === failure);
  assert.equal(await github.githubRepo('C:\\repo'), null);
  remote = 'origin';
  const repo = { url: 'https://github.com/owner/repo', slug: 'owner/repo', branch: 'task', defaultBranch: 'main' };
  assert.deepEqual(await github.readGithubRepo('C:\\repo'), repo);
  assert.deepEqual(await github.githubRepo('C:\\repo'), repo);
  // Outside GitHub, and without a remote, is an answer, not a failure.
  url = 'https://gitlab.com/owner/repo.git';
  assert.equal(await github.readGithubRepo('C:\\repo'), null);
  remote = null;
  assert.equal(await github.readGithubRepo('C:\\repo'), null);
});

test('the client\'s API includes the remote and query readers, which need no commands', () => {
  const remote = require('../src/repos/github-remote');
  const queries = require('../src/repos/github-queries');
  const github = client(async () => { throw new Error('no commands'); });
  for (const name of ['parseRemote', 'providerOf', 'hostnameIn', 'jsonHosts', 'statusHosts']) assert.equal(github[name], remote[name], name);
  for (const name of ['pullsQuery', 'readPulls', 'readChecks', 'readHeads', 'mergedAtHead', 'checksUrl', 'startsChecks', 'visibilityGroups',
    'visibilityQuery', 'readVisibility', 'isApproved', 'readApproved', 'readOwnedRepos']) assert.equal(github[name], queries[name], name);
  assert.deepEqual(remote.parseRemote('git@github.com:owner/repo.git'), { url: 'https://github.com/owner/repo', slug: 'owner/repo' });
  assert.equal(remote.providerOf('https://gitlab.example/group/sub/project.git'), 'gitlab');
  assert.equal(queries.checksUrl({ url: 'https://github.com/o/r' }, 'a'.repeat(40)), `https://github.com/o/r/commit/${'a'.repeat(40)}/checks`);
});
