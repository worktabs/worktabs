const assert = require('node:assert/strict');
const test = require('node:test');
const { MAX_PULL_BRANCHES, createGithubPages } = require('../src/repos/github-pages');

const repo = { url: 'https://github.com/octo/hello', branch: 'fix' };

// `found`: the repository, null outside GitHub, or an Error when git fails to read the remote.
function setup({ found = repo, pulls = null } = {}) {
  const opened = [];
  const asked = [];
  const logged = [];
  const read = async () => {
    if (found instanceof Error) throw found;
    return found;
  };
  const pages = createGithubPages({
    githubRepo: () => read().catch(() => null),
    readGithubRepo: read,
    log: (line) => logged.push(line),
    pageUrl: async (r, page) => `${r.url}/${page}`,
    checksUrl: (r, oid) => (oid ? `${r.url}/commit/${oid}/checks` : null),
    branchPulls: async (r, branches, options) => {
      asked.push({ branches, options });
      if (!pulls) throw new Error('gh is not signed in');
      return pulls;
    },
    hasBranchPage: (r) => r.branch !== 'main',
    openExternal: (url) => opened.push(url),
  });
  return { pages, opened, asked, logged };
}

test('pages open only for a repository on GitHub, and a number must be a positive integer', async () => {
  const { pages, opened } = setup();
  await pages.openGithub('/src/hello', 'actions');
  await pages.openNumbered('/src/hello', 'pull', 12);
  await pages.openNumbered('/src/hello', 'issues', 0);
  await pages.openNumbered('/src/hello', 'issues', '3');
  await pages.openChecks('/src/hello', 'abc');
  await pages.openChecks('/src/hello', '');
  assert.deepEqual(opened, ['https://github.com/octo/hello/actions', 'https://github.com/octo/hello/pull/12', 'https://github.com/octo/hello/commit/abc/checks']);
  const outside = setup({ found: null });
  await outside.pages.openGithub('/src/other', 'repo');
  assert.deepEqual(outside.opened, []);
  assert.equal(await outside.pages.repoInfo('/src/other'), null);
});

test('the branch page is there for a branch other than the default', async () => {
  assert.equal(await setup().pages.branchPage('/src/hello'), 'fix');
  assert.equal(await setup({ found: { ...repo, branch: 'main' } }).pages.branchPage('/src/hello'), null);
  assert.deepEqual(await setup().pages.repoInfo('/src/hello'), { ...repo, branchPage: true });
});

test('the side bar hears of a failed read of the remote apart from "not on GitHub", and the log has it', async () => {
  const failed = setup({ found: new Error('git timed out\nafter 5000 ms') });
  assert.deepEqual(await failed.pages.repoInfo('/src/hello'), { error: 'git timed out after 5000 ms' });
  assert.deepEqual(failed.logged, ['github /src/hello: git timed out after 5000 ms']);
  // Opening a page needs the repository either way: nothing opens, and nothing is logged.
  await failed.pages.openGithub('/src/hello', 'repo');
  assert.deepEqual(failed.opened, []);
  assert.equal(failed.logged.length, 1);
  const outside = setup({ found: null });
  assert.equal(await outside.pages.repoInfo('/src/other'), null);
  assert.deepEqual(outside.logged, []);
});

test('pull requests are asked for at most so many branches, and a failure reads as null', async () => {
  const branches = Array.from({ length: MAX_PULL_BRANCHES + 5 }, (_, i) => `b${i}`);
  const { pages, asked } = setup({ pulls: { pulls: new Map([['b1', { number: 1 }]]), heads: new Map([['abc', { state: 'SUCCESS' }]]) } });
  const read = await pages.pullRequests('/src/hello', branches, new Map([['b1', 7]]), ['abc']);
  assert.deepEqual(read, { pulls: { b1: { number: 1 } }, heads: { abc: { state: 'SUCCESS' } } });
  assert.equal(asked[0].branches.length, MAX_PULL_BRANCHES);
  assert.deepEqual(asked[0].options, { folder: '/src/hello', numbers: { b1: 7 }, heads: ['abc'] });
  assert.equal(await setup().pages.pullRequests('/src/hello', ['b1']), null);
  assert.equal(await setup({ found: null }).pages.pullRequests('/src/hello', ['b1']), null);
});
