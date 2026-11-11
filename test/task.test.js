const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { lookup } = require('../src/repos/github');
const { setLanguage } = require('../src/i18n');
const task = require('../src/repos/task');
const { runAt } = require('../src/repos/worktrees');
const { git, makeRepo, tempDir } = require('./support');

// GitHub by the remote's host alone, whatever the machine's ~/.ssh/config and gh say.
lookup.sshHostname = async () => null;
lookup.signedInHosts = async () => [];

test('parseTask takes an issue or pull request by its number or address, and anything else as words', () => {
  assert.deepEqual(task.parseTask('  '), { kind: 'none' });
  assert.deepEqual(task.parseTask('#20'), { kind: 'issue', number: 20, address: null });
  assert.deepEqual(task.parseTask(' 116 '), { kind: 'issue', number: 116, address: null });
  assert.deepEqual(task.parseTask('https://github.com/Owner/Name/issues/20#issuecomment-1'), {
    kind: 'issue',
    number: 20,
    address: { host: 'github.com', slug: 'Owner/Name' },
  });
  assert.deepEqual(task.parseTask('https://GitHub.com/owner/name/pull/71/files'), {
    kind: 'pull',
    number: 71,
    address: { host: 'github.com', slug: 'owner/name' },
  });
  assert.deepEqual(task.parseTask('サイドバーの幅を  変えられるようにする'), { kind: 'text', text: 'サイドバーの幅を 変えられるようにする' });
  // Not an issue's number.
  assert.equal(task.parseTask('#0').kind, 'text');
  assert.equal(task.parseTask('#20 と #21').kind, 'text');
});

test('issueOf reads what gh printed, and tells a pull request by its address', () => {
  const json = (url) => JSON.stringify({ number: 20, title: ' GitHub の issue から\nworktree を作る ', state: 'OPEN', url });
  assert.deepEqual(task.issueOf(json('https://github.com/o/r/issues/20')), {
    number: 20,
    title: 'GitHub の issue から worktree を作る',
    state: 'OPEN',
    url: 'https://github.com/o/r/issues/20',
    pull: false,
  });
  assert.equal(task.issueOf(json('https://github.com/o/r/pull/20')).pull, true);
  assert.equal(task.issueOf('not json'), null);
  assert.equal(task.issueOf('{"number":"20"}'), null);
});

// A pull request as gh pr view prints it.
const pullJson = ({ number = 71, state = 'OPEN', head = 'feat/x', cross = false, owner = 'o' } = {}) =>
  JSON.stringify({
    number,
    title: ' PR の番号から\nworktree を作る ',
    state,
    url: `https://github.com/o/r/pull/${number}`,
    headRefName: head,
    isCrossRepository: cross,
    headRepositoryOwner: owner && { id: 'U_1', login: owner },
  });

test('pullRequestOf reads the pull request with its branch and where that is', () => {
  assert.deepEqual(task.pullRequestOf(pullJson({ cross: true, owner: 'alice', head: 'patch-1' })), {
    number: 71,
    title: 'PR の番号から worktree を作る',
    state: 'OPEN',
    url: 'https://github.com/o/r/pull/71',
    head: 'patch-1',
    cross: true,
    owner: 'alice',
  });
  // A fork that was deleted has no owner.
  assert.equal(task.pullRequestOf(pullJson({ owner: null })).owner, null);
  assert.equal(task.pullRequestOf(pullJson({ head: '' })), null);
  assert.equal(task.pullRequestOf('not json'), null);
});

test('pullBranch names the branch for a pull request, a fork\'s with its owner', () => {
  assert.equal(task.pullBranch({ number: 71, head: 'feat/x', cross: false, owner: 'o' }), 'feat/x');
  assert.equal(task.pullBranch({ number: 71, head: 'main', cross: true, owner: 'alice' }), 'alice/main');
  assert.equal(task.pullBranch({ number: 71, head: 'main', cross: true, owner: null }), 'pr-71');
});

// A repository whose origin is o/r on GitHub.
function githubRepo(t) {
  const repo = makeRepo(tempDir(t));
  git(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  return repo;
}

test('describeTask reads an issue of the repository with gh', async (t) => {
  const repo = githubRepo(t);
  const asked = [];
  const view = async (folder, github, number) => {
    asked.push([folder, github.slug, number]);
    return JSON.stringify({ number, title: 'worktree を作る', state: 'CLOSED', url: `https://github.com/o/r/issues/${number}` });
  };
  assert.deepEqual(await task.describeTask(repo, '#20', { view }), {
    kind: 'issue',
    number: 20,
    title: 'worktree を作る',
    state: 'CLOSED',
    url: 'https://github.com/o/r/issues/20',
  });
  assert.deepEqual(await task.describeTask(repo, 'https://github.com/O/R/issues/21', { view }), {
    kind: 'issue',
    number: 21,
    title: 'worktree を作る',
    state: 'CLOSED',
    url: 'https://github.com/o/r/issues/21',
  });
  assert.deepEqual(asked, [
    [repo, 'o/r', 20],
    [repo, 'o/r', 21],
  ]);
  // Words and nothing need no gh.
  assert.deepEqual(await task.describeTask(repo, '幅を変える', { view }), { kind: 'text', text: '幅を変える' });
  assert.deepEqual(await task.describeTask(repo, '', { view }), { kind: 'none' });
  assert.equal(asked.length, 2);
});

test('describeTask reads a pull request, by its address or a number gh answers for one', async (t) => {
  const repo = githubRepo(t);
  const asked = [];
  // gh issue view answers for a pull request too, with its address.
  const view = async (folder, github, number) => {
    asked.push(['issue', number]);
    return JSON.stringify({ number, title: 'x', state: 'OPEN', url: `https://github.com/o/r/pull/${number}` });
  };
  const viewPr = async (folder, github, number) => {
    asked.push(['pull', github.slug, number]);
    return pullJson({ number, state: 'MERGED' });
  };
  const expected = {
    kind: 'pull',
    number: 71,
    title: 'PR の番号から worktree を作る',
    state: 'MERGED',
    url: 'https://github.com/o/r/pull/71',
    head: 'feat/x',
    cross: false,
    owner: 'o',
    branch: 'feat/x',
  };
  assert.deepEqual(await task.describeTask(repo, '#71', { view, viewPr }), expected);
  assert.deepEqual(await task.describeTask(repo, 'https://github.com/o/r/pull/71/files', { view, viewPr }), expected);
  assert.deepEqual(asked, [
    ['issue', 71],
    ['pull', 'o/r', 71],
    ['pull', 'o/r', 71],
  ]);
  const fork = async () => pullJson({ cross: true, owner: 'alice', head: 'main' });
  assert.equal((await task.describeTask(repo, 'https://github.com/o/r/pull/71', { viewPr: fork })).branch, 'alice/main');
  const broken = async () => '{}';
  assert.deepEqual(await task.describeTask(repo, 'https://github.com/o/r/pull/71', { viewPr: broken }), { error: 'Could not read PR #71' });
});

test('describeTask explains what names nothing of the repository', async (t) => {
  const repo = githubRepo(t);
  assert.match((await task.describeTask(repo, 'https://github.com/other/r/issues/1')).error, /That is an issue of other\/r\. Enter an issue or PR of o\/r/);
  assert.match((await task.describeTask(repo, 'https://github.com/other/r/pull/1')).error, /That is a PR of other\/r\./);
  const missing = async () => {
    throw Object.assign(new Error('failed'), { code: 'ENOENT' });
  };
  assert.deepEqual(await task.describeTask(repo, '#1', { view: missing }), { error: 'gh is not found' });
  const notFound = async () => {
    throw Object.assign(new Error('failed'), { code: 1, stderr: 'GraphQL: Could not resolve to an issue or pull request with the number of 999. (repository.issue)\n' });
  };
  assert.match((await task.describeTask(repo, '#999', { view: notFound })).error, /Could not resolve/);
});

test('describeTask takes everything for words in a repository that is not on GitHub', async (t) => {
  const gitlab = makeRepo(tempDir(t));
  git(gitlab, 'remote', 'add', 'origin', 'git@gitlab.com:g/p.git');
  const local = makeRepo(tempDir(t));
  const view = async () => assert.fail('gh is not asked');
  for (const repo of [gitlab, local]) {
    // Its issues are called #20 too, but there is nothing for gh to read.
    assert.deepEqual(await task.describeTask(repo, ' #20 ', { view, viewPr: view }), { kind: 'text', text: '#20', numberOnly: true });
    assert.deepEqual(await task.describeTask(repo, '20', { view, viewPr: view }), { kind: 'text', text: '20', numberOnly: true });
    // Gitea's, Codeberg's and Bitbucket's issues, and GitLab's of old, have the address of GitHub's.
    for (const address of ['https://gitea.example.com/o/r/issues/12', 'https://gitlab.com/g/p/issues/12', 'https://codeberg.org/o/r/pulls/3']) {
      assert.deepEqual(await task.describeTask(repo, address, { view, viewPr: view }), { kind: 'text', text: address });
    }
    assert.deepEqual(await task.describeTask(repo, 'https://gitlab.com/g/p/-/issues/12'), { kind: 'text', text: 'https://gitlab.com/g/p/-/issues/12' });
    assert.deepEqual(await task.describeTask(repo, '幅を変える'), { kind: 'text', text: '幅を変える' });
  }
  // The words are what the new conversation starts with.
  assert.equal(task.firstPrompt(task.checkedTask(await task.describeTask(gitlab, '#20'))), '#20');
});

test('checkedTask keeps only a task as describeTask gives it', () => {
  assert.deepEqual(task.checkedTask({ kind: 'issue', number: 20, title: 't', state: 'OPEN', url: 'u' }), { kind: 'issue', number: 20, title: 't' });
  const pull = { kind: 'pull', number: 71, title: 't', state: 'OPEN', url: 'u', head: 'feat/x', cross: false, owner: 'o', branch: 'feat/x' };
  assert.deepEqual(task.checkedTask(pull), { kind: 'pull', number: 71, title: 't', head: 'feat/x', cross: false, open: true });
  assert.equal(task.checkedTask({ ...pull, state: 'MERGED' }).open, false);
  assert.equal(task.checkedTask({ ...pull, head: '' }), null);
  assert.equal(task.checkedTask({ ...pull, cross: 'no' }), null);
  assert.deepEqual(task.checkedTask({ kind: 'text', text: ' 幅を変える ' }), { kind: 'text', text: '幅を変える' });
  assert.equal(task.checkedTask({ kind: 'issue', number: '20', title: 't' }), null);
  assert.equal(task.checkedTask({ kind: 'text', text: ' ' }), null);
  assert.equal(task.checkedTask({ kind: 'none' }), null);
  assert.equal(task.checkedTask(null), null);
});

test('namingPrompt tells the work and the recent branches on one line', () => {
  const issue = { kind: 'issue', number: 20, title: 'worktree を作る' };
  assert.equal(task.namingPrompt(issue, ['feat/issue66', 'issue/14']), 'GitHub issue #20: worktree を作る (recent branches, newest first: feat/issue66, issue/14)');
  assert.equal(task.namingPrompt({ kind: 'pull', number: 71, title: 'レビュー用' }, []), 'GitHub pull request #71: レビュー用');
  assert.equal(task.namingPrompt({ kind: 'text', text: '幅を変える' }, []), 'The work: 幅を変える');
});

test('branchNameIn takes the name out of what claude answered', () => {
  assert.equal(task.branchNameIn('feat/issue20-worktree-from-issue\n'), 'feat/issue20-worktree-from-issue');
  assert.equal(task.branchNameIn('`feat/x`'), 'feat/x');
  assert.equal(task.branchNameIn('Here it is:\n\n"fix/20-sleep"\n'), 'fix/20-sleep');
  assert.equal(task.branchNameIn('I cannot name this.'), null);
  assert.equal(task.branchNameIn(''), null);
});

test('suggestBranch asks with the repository recent branches, and says why it could not', async (t) => {
  const repo = makeRepo(tempDir(t));
  git(repo, 'branch', 'feat/issue66');
  const prompts = [];
  const answer = (output) => async (folder, prompt) => {
    prompts.push(prompt);
    return output;
  };
  const issue = { kind: 'issue', number: 20, title: 'worktree を作る' };
  assert.deepEqual(await task.suggestBranch(repo, issue, { ask: answer('feat/issue20-worktree\n') }), { name: 'feat/issue20-worktree' });
  assert.match(prompts[0], /^GitHub issue #20: worktree を作る \(recent branches, newest first: (main, feat\/issue66|feat\/issue66, main)\)$/);
  assert.deepEqual(await task.suggestBranch(repo, issue, { ask: answer('I would call it something nice.') }), {
    error: 'Could not suggest a name: I would call it something nice.',
  });
  const missing = async () => {
    throw Object.assign(new Error('failed'), { code: 127, stderr: 'sh: 1: claude: not found\n' });
  };
  assert.match((await task.suggestBranch(repo, issue, { ask: missing })).error, /Could not suggest a name: The Claude Code extension.*Settings > Extensions/);
});

test('suggestBranch reports the selected agent when branch naming cannot run', async (t) => {
  const repo = makeRepo(tempDir(t));
  const issue = { kind: 'issue', number: 20, title: 'worktree を作る' };
  const missing = async () => {
    throw Object.assign(new Error('failed'), { code: 127, stderr: 'sh: 1: codex: not found\n' });
  };
  assert.match((await task.suggestBranch(repo, issue, { agent: 'codex', ask: missing })).error, /Could not suggest a name: The Codex extension.*Open VSX/);
});

test('suggestions use extension binaries without a PATH CLI and keep execution restrictions', async (t) => {
  const extensionsDir = path.join(tempDir(t), 'extensions with spaces');
  fs.mkdirSync(extensionsDir);
  const repo = makeRepo(tempDir(t));
  const issue = { kind: 'issue', number: 184, title: 'Use bundled CLIs' };
  for (const agent of ['claude', 'codex']) {
    const id = agent === 'claude' ? 'Anthropic.claude-code' : 'OpenAI.chatgpt';
    fs.writeFileSync(path.join(extensionsDir, 'extensions.json'), JSON.stringify([{ identifier: { id }, relativeLocation: 'current' }]));
    const { extensionBinary } = require('../src/agents/agent-cli');
    const { localFiles } = require('../src/code-server/code-server');
    const binary = await extensionBinary({ files: localFiles, extensionsDir, agent });
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, 'bundled', { mode: 0o755 });
    const run = async (folder, command, args, timeout, options) => {
      assert.equal(folder, repo);
      assert.equal(command, binary);
      assert.equal(timeout, 90000);
      assert.equal(options.cwd, agent === 'claude' ? os.tmpdir() : repo);
      assert.equal(options.input, '');
      if (agent === 'claude') {
        assert.deepEqual(args.slice(-7), ['--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '']);
        assert.deepEqual(args.slice(0, 1), ['-p']);
        assert.ok(args.includes('--system-prompt'));
        assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
      } else {
        assert.deepEqual(args.slice(0, 3), ['exec', '--sandbox', 'read-only']);
      }
      return 'fix/184-bundled-clis\n';
    };
    assert.deepEqual(await task.suggestBranch(repo, issue, { agent, extensionsDir, run }), { name: 'fix/184-bundled-clis' });
  }
});

test('WSL suggestions execute Linux binaries in the matching repository or temporary folder', async () => {
  const folder = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo with spaces';
  for (const agent of ['claude', 'codex']) {
    const binary = `/home/me/.worktabs/extensions/${agent}-1/binary`;
    const resolve = async (repo, provider) => { assert.equal(repo, folder); assert.equal(provider, agent); return binary; };
    const run = async (repo, command, args, timeout, options) => {
      assert.equal(repo, folder);
      assert.equal(command, 'sh');
      assert.deepEqual(args.slice(0, 6), ['-c', 'cd "$1" && shift && exec "$@"', 'sh', agent === 'claude' ? '/tmp' : '/home/me/repo with spaces', binary, agent === 'claude' ? '-p' : 'exec']);
      assert.equal(timeout, 90000);
      assert.deepEqual(options, { shellEnv: true, input: '' });
      return 'fix/184-bundled-clis';
    };
    assert.equal(await (agent === 'claude' ? task.askClaude : task.askCodex)(folder, 'Name a branch', { resolve, run }), 'fix/184-bundled-clis');
  }
});

test('suggestions close stdin so bundled CLIs do not wait for additional input', async (t) => {
  const folder = tempDir(t);
  const resolve = async () => process.execPath;
  // A real child that cannot answer until it receives EOF reproduces Codex's input wait.
  const run = (repo, command, _args, _timeout, options) => runAt(repo, command,
    ['-e', "process.stdin.on('end', () => console.log('fix/184-bundled-clis')); process.stdin.resume()"], 3000, options);
  for (const ask of [task.askClaude, task.askCodex]) {
    assert.equal((await ask(folder, 'Name a branch', { resolve, run })).trim(), 'fix/184-bundled-clis');
  }
});

test('suggestBranch handles authentication output even when the CLI exits successfully', async (t) => {
  const repo = makeRepo(tempDir(t));
  for (const agent of ['claude', 'codex']) {
    const result = await task.suggestBranch(repo, { kind: 'text', text: 'Do work' }, { agent, ask: async () => 'Unauthorized' });
    assert.match(result.error, /authentication.*sign in/);
    assert.deepEqual(await task.suggestBranch(repo, { kind: 'text', text: 'Do work' }, { agent, ask: async () => 'fix/401-unauthorized-response' }), { name: 'fix/401-unauthorized-response' });
    const error = await task.suggestBranch(repo, { kind: 'text', text: 'Do work' }, { agent, ask: async () => { throw Object.assign(new Error('failed'), { stderr: 'error: server unavailable' }); } });
    assert.equal(error.error, 'Could not suggest a name: server unavailable');
  }
});

test('firstPrompt is what the new conversation starts with', () => {
  assert.equal(task.firstPrompt({ kind: 'issue', number: 20, title: 'Make worktrees' }), 'Implement GitHub issue #20 "Make worktrees"');
  assert.equal(task.firstPrompt({ kind: 'pull', number: 71, title: 'Make worktrees' }), 'Review GitHub PR #71 "Make worktrees"');
  assert.equal(task.firstPrompt({ kind: 'text', text: '幅を変える' }), '幅を変える');
  assert.equal(task.firstPrompt(null), null);
});

test('in Japanese, firstPrompt asks in Japanese, as it did before the UI was in English', (t) => {
  setLanguage('ja');
  t.after(() => setLanguage('en'));
  assert.equal(task.firstPrompt({ kind: 'issue', number: 20, title: 'worktree を作る' }), 'GitHub の issue #20「worktree を作る」を実装して');
  assert.equal(task.firstPrompt({ kind: 'pull', number: 71, title: 'worktree を作る' }), 'GitHub の PR #71「worktree を作る」をレビューして');
});
