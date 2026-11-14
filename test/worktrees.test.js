const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const worktrees = require('../src/repos/worktrees');
const { windowsPath } = require('../src/wsl/wsl');
const { git, makeRepo, tempDir } = require('./support');

test('gitWorktrees lists the main worktree first, then the linked ones', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', path.join(dir, 'repo-feat-x'));
  git(repo, 'worktree', 'add', '-q', '--detach', path.join(dir, 'repo-detached'));
  git(repo, 'worktree', 'lock', path.join(dir, 'repo-detached'));

  const head = git(repo, 'rev-parse', 'HEAD');
  const [main, ...linked] = await worktrees.gitWorktrees(repo);
  assert.deepEqual(main, { path: repo, branch: 'main', head, main: true, locked: false });
  // git lists the linked ones in the order of their names under .git/worktrees.
  assert.deepEqual(linked.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: path.join(dir, 'repo-detached'), branch: null, head, main: false, locked: true },
    { path: path.join(dir, 'repo-feat-x'), branch: 'feat/x', head, main: false, locked: false },
  ]);
});

test('mainWorktree and repoRoot find the repository from a linked worktree', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  const linked = path.join(dir, 'repo-feat');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', linked);
  fs.mkdirSync(path.join(linked, 'sub'));

  assert.equal(await worktrees.mainWorktree(path.join(linked, 'sub')), repo);
  assert.equal(await worktrees.repoRoot(path.join(linked, 'sub')), linked);
  assert.equal(await worktrees.currentBranch(linked), 'feat');
  assert.equal(await worktrees.repoRoot(dir), null);
  assert.equal(await worktrees.mainWorktree(dir), null);
});

test('currentBranch reads the branch from HEAD as git names it, and asks git elsewhere', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  const linked = path.join(dir, 'repo-feat');
  const detached = path.join(dir, 'repo-detached');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', linked);
  git(repo, 'worktree', 'add', '-q', '--detach', detached);
  fs.mkdirSync(path.join(linked, 'sub'));
  const reads = [];
  const read = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', (file, ...rest) => { reads.push(file); return read(file, ...rest); });

  for (const folder of [repo, linked, detached, path.join(linked, 'sub')]) {
    assert.equal(await worktrees.currentBranch(folder), git(folder, 'rev-parse', '--abbrev-ref', 'HEAD'));
  }
  assert.ok(reads.includes(path.join(repo, '.git', 'HEAD')));
  assert.ok(reads.includes(path.join(repo, '.git', 'worktrees', 'repo-feat', 'HEAD')));
  assert.equal(await worktrees.currentBranch(dir), null);
});

test('currentBranch asks git when the .git file does not name a git directory', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  const linked = path.join(dir, 'repo-feat');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', linked);
  const file = path.join(linked, '.git');
  const real = fs.readFileSync(file, 'utf8');
  // Git for Windows hides .git (core.hideDotFiles), and Windows refuses to create a hidden file
  // anew (EPERM), so the file is emptied and written in place.
  const rewrite = (text) => {
    fs.truncateSync(file, 0);
    fs.writeFileSync(file, text, { flag: 'r+' });
  };
  rewrite('not a link\n');
  assert.equal(await worktrees.currentBranch(linked), null);
  rewrite(real);
  assert.equal(await worktrees.currentBranch(linked), 'feat');
});

test('planWorktree checks out a local branch as it is', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  git(repo, 'branch', 'feat/x');
  assert.deepEqual(await worktrees.planWorktree(repo, ' feat/x '), {
    branch: 'feat/x',
    folder: path.join(dir, 'repo-feat-x'),
    from: 'local',
    base: 'feat/x',
    copies: 0,
  });
});

test('planWorktree tracks a branch that only a remote has, preferring origin', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  git(repo, 'update-ref', 'refs/remotes/upstream/feat', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/feat', 'HEAD');
  git(repo, 'remote', 'add', 'upstream', 'https://example.com/upstream.git');
  git(repo, 'remote', 'add', 'origin', 'https://example.com/origin.git');
  const plan = await worktrees.planWorktree(repo, 'feat');
  assert.equal(plan.from, 'remote');
  assert.equal(plan.base, 'origin/feat');
});

test('addWorktree makes a new branch from the remote default branch, without tracking it', async (t) => {
  const dir = tempDir(t);
  const origin = makeRepo(dir, 'origin');
  git(dir, 'clone', '-q', origin, 'repo');
  const repo = path.join(dir, 'repo');
  // The main worktree is on a branch of its own, and its main is behind origin/main.
  git(repo, 'checkout', '-q', '-b', 'feat/work');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'work');
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'second');
  git(repo, 'fetch', '-q');

  const plan = await worktrees.planWorktree(repo, 'feat/new');
  assert.equal(plan.from, 'new');
  assert.equal(plan.base, 'origin/main');
  const { folder } = await worktrees.addWorktree(repo, 'feat/new');
  assert.equal(git(folder, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'));
  // Without an upstream, so that publishing it pushes to feat/new rather than main.
  assert.throws(() => git(repo, 'config', '--get', 'branch.feat/new.merge'));
});

// A clone of `origin` (o) whose origin has moved on since: feat/x has a commit the clone has
// not fetched, and the ref GitHub keeps for pull request #7 (from a fork) has one of its own.
function pullRepos(t) {
  const dir = tempDir(t);
  const origin = makeRepo(dir, 'origin');
  git(origin, 'branch', 'feat/x');
  git(dir, 'clone', '-q', origin, 'repo');
  const commitOn = (branch, message) => {
    git(origin, 'checkout', '-q', branch);
    git(origin, 'commit', '-q', '--allow-empty', '-m', message);
    git(origin, 'checkout', '-q', 'main');
    return git(origin, 'rev-parse', branch);
  };
  const featX = commitOn('feat/x', 'more on feat/x');
  git(origin, 'branch', 'fork-work', 'main');
  const fork = commitOn('fork-work', 'from a fork');
  git(origin, 'update-ref', 'refs/pull/7/head', fork);
  git(origin, 'branch', '-D', 'fork-work');
  return { dir, origin, repo: path.join(dir, 'repo'), featX, fork };
}

test('addWorktree fetches an open pull request of the repository and tracks its branch', async (t) => {
  const { dir, repo, featX } = pullRepos(t);
  const pull = { number: 5, head: 'feat/x', cross: false, open: true };
  assert.deepEqual(await worktrees.planWorktree(repo, 'feat/x', pull), {
    branch: 'feat/x',
    folder: path.join(dir, 'repo-feat-x'),
    from: 'pull',
    remote: 'origin',
    number: 5,
    base: 'origin/feat/x',
    ref: 'refs/heads/feat/x',
    track: true,
    copies: 0,
  });
  const { folder } = await worktrees.addWorktree(repo, 'feat/x', pull);
  // What the remote has now, not what was fetched before.
  assert.equal(git(folder, 'rev-parse', 'HEAD'), featX);
  assert.equal(git(folder, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feat/x');
});

test('addWorktree fetches a pull request from a fork into a new branch that pulls from it', async (t) => {
  const { dir, origin, repo, fork } = pullRepos(t);
  const pull = { number: 7, head: 'patch-1', cross: true, open: true };
  const plan = await worktrees.planWorktree(repo, 'alice/patch-1', pull);
  assert.deepEqual([plan.from, plan.ref, plan.track], ['pull', 'refs/pull/7/head', false]);
  const { folder, branch } = await worktrees.addWorktree(repo, 'alice/patch-1', pull);
  assert.equal(folder, path.join(dir, 'repo-alice-patch-1'));
  assert.equal(branch, 'alice/patch-1');
  assert.equal(git(folder, 'rev-parse', 'HEAD'), fork);
  // What is pushed to the pull request later comes with a pull, as after gh pr checkout.
  git(origin, 'checkout', '-q', '--detach', 'refs/pull/7/head');
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'pushed later');
  git(origin, 'update-ref', 'refs/pull/7/head', 'HEAD');
  git(origin, 'checkout', '-q', 'main');
  git(folder, 'pull', '-q', '--ff-only');
  assert.equal(git(folder, 'log', '-1', '--format=%s'), 'pushed later');
});

test('a closed pull request comes from its ref too, and an existing branch is checked out as it is', async (t) => {
  const { repo, fork } = pullRepos(t);
  // Its branch was deleted after the merge; GitHub keeps the ref.
  const merged = { number: 7, head: 'gone', cross: false, open: false };
  assert.equal((await worktrees.planWorktree(repo, 'gone', merged)).ref, 'refs/pull/7/head');
  const { folder } = await worktrees.addWorktree(repo, 'gone', merged);
  assert.equal(git(folder, 'rev-parse', 'HEAD'), fork);

  git(repo, 'branch', 'feat/local');
  const plan = await worktrees.planWorktree(repo, 'feat/local', { number: 5, head: 'feat/x', cross: false, open: true });
  assert.deepEqual([plan.from, plan.base], ['local', 'feat/local']);
});

test('planWorktree needs a remote for a pull request', async (t) => {
  const repo = makeRepo(tempDir(t));
  assert.deepEqual(await worktrees.planWorktree(repo, 'feat/x', { number: 5, head: 'feat/x', cross: false, open: true }), { error: 'There is no remote' });
});

test('planWorktree makes a new branch from the local main or master without origin/HEAD', async (t) => {
  const repo = makeRepo(tempDir(t));
  // A remote added after git init has no HEAD.
  git(repo, 'remote', 'add', 'origin', 'https://example.com/origin.git');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'feat/work');
  const base = async () => (await worktrees.planWorktree(repo, 'feat/new')).base;
  assert.equal(await base(), 'main');
  // One that names a pruned branch is left out too.
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
  assert.equal(await base(), 'main');
  git(repo, 'branch', '-m', 'main', 'master');
  assert.equal(await base(), 'master');
  // With neither, from what the main worktree has checked out.
  git(repo, 'branch', '-D', 'master');
  assert.equal(await base(), 'feat/work');
  git(repo, 'checkout', '-q', '--detach');
  assert.equal(await base(), 'HEAD');
});

test('planWorktree explains what it cannot do', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  assert.deepEqual(await worktrees.planWorktree(repo, '  '), { error: null });
  assert.match((await worktrees.planWorktree(repo, 'bad..name')).error, /cannot be a branch name/);
  assert.match((await worktrees.planWorktree(repo, '-x')).error, /cannot be a branch name/);
  assert.match((await worktrees.planWorktree(repo, 'main')).error, /main is in use in repo/);
  fs.mkdirSync(path.join(dir, 'repo-taken'));
  assert.match((await worktrees.planWorktree(repo, 'taken')).error, /repo-taken already exists/);
});

test('addWorktree adds the planned worktree, and removeWorktree removes it', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  const { folder, branch, copied, failed } = await worktrees.addWorktree(repo, ' feat/y ');
  assert.equal(folder, path.join(dir, 'repo-feat-y'));
  assert.equal(branch, 'feat/y');
  assert.deepEqual([copied, failed], [[], []]);
  assert.equal(await worktrees.currentBranch(folder), 'feat/y');

  fs.writeFileSync(path.join(folder, 'new.txt'), 'x\n');
  assert.equal(await worktrees.worktreeChanges(folder), 1);
  git(folder, 'add', '.');
  git(folder, 'commit', '-q', '-m', 'only on feat/y');
  assert.equal(await worktrees.worktreeChanges(folder), 0);
  assert.equal(await worktrees.unsharedCommits(folder, 'feat/y'), 1);

  await worktrees.removeWorktree(repo, folder);
  assert.equal(fs.existsSync(folder), false);
  assert.deepEqual((await worktrees.gitWorktrees(repo)).map((w) => w.path), [repo]);
  const tip = git(repo, 'rev-parse', '--short', 'feat/y');
  assert.equal(await worktrees.deleteBranch(repo, 'feat/y'), tip);
  assert.equal(git(repo, 'branch', '--list', 'feat/y'), '');
  // What the notification says brings it back.
  git(repo, 'branch', 'feat/y', tip);
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'feat/y'), 'only on feat/y');
});

test('removeWorktree removes links in the worktree without emptying what they point to', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  const shared = path.join(dir, 'shared');
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'keep.txt'), 'keep\n');
  const { folder } = await worktrees.addWorktree(repo, 'linked');
  fs.symlinkSync(shared, path.join(folder, 'node_modules'), 'junction');

  await worktrees.removeWorktree(repo, folder);
  assert.equal(fs.existsSync(folder), false);
  assert.equal(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf8'), 'keep\n');
});

test('removeWorktree refuses the main worktree and folders that are not its worktrees', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  const other = path.join(dir, 'other');
  fs.mkdirSync(other);
  await assert.rejects(worktrees.removeWorktree(repo, repo), /The main worktree cannot be removed/);
  await assert.rejects(worktrees.removeWorktree(repo, other), /is not a worktree of/);
  assert.equal(fs.existsSync(other), true);
});

test('removableWorktree finds the repository of a linked worktree, and refuses the others', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  const { folder } = await worktrees.addWorktree(repo, 'feat');
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.deepEqual(await worktrees.removableWorktree(folder), { repo, branch: 'feat', head, locked: false, missing: false });
  assert.equal(await worktrees.removableWorktree(repo), null);
  fs.mkdirSync(path.join(folder, 'sub'));
  assert.equal(await worktrees.removableWorktree(path.join(folder, 'sub')), null);
  const other = path.join(dir, 'other');
  fs.mkdirSync(other);
  assert.equal(await worktrees.removableWorktree(other, repo), null);
});

test('a worktree whose folder was deleted by hand can still be removed, with its commits counted', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  const { folder } = await worktrees.addWorktree(repo, 'feat');
  fs.writeFileSync(path.join(folder, 'new.txt'), 'x\n');
  git(folder, 'add', '.');
  git(folder, 'commit', '-q', '-m', 'only on feat');
  const head = git(folder, 'rev-parse', 'HEAD');
  fs.rmSync(folder, { recursive: true, force: true });

  // git still lists it; without its folder, only the row's repository can tell whose it is.
  assert.equal(await worktrees.removableWorktree(folder), null);
  const target = await worktrees.removableWorktree(folder, repo);
  assert.deepEqual(target, { repo, branch: 'feat', head, locked: false, missing: true });
  assert.equal(await worktrees.unsharedCommits(repo, 'feat', target.head), 1);

  await worktrees.removeWorktree(repo, folder);
  assert.deepEqual((await worktrees.gitWorktrees(repo)).map((w) => w.path), [repo]);
});

test('removableWorktree does not take the row\'s word for a folder that is there', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  const { folder } = await worktrees.addWorktree(repo, 'feat');
  // Its .git file gone, git cannot tell the folder is a worktree: what it holds is not deleted.
  fs.rmSync(path.join(folder, '.git'));
  fs.writeFileSync(path.join(folder, 'keep.txt'), 'keep\n');
  assert.equal(await worktrees.removableWorktree(folder, repo), null);
});

// Writes files (relative, with /) under the folder, making their folders.
function writeFiles(folder, files) {
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(folder, ...file.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
}

test('includedFiles lists the ignored files that .worktreeinclude names, and nothing else', async (t) => {
  const repo = makeRepo(tempDir(t));
  writeFiles(repo, {
    '.gitignore': '.env*\n*.log\nconfig/local.json\nsub/secret.txt\n',
    'tracked.env.example': 'tracked\n',
  });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'ignore');
  writeFiles(repo, {
    '.env': 'A=1\n',
    '.env.local': 'B=2\n',
    'app.log': 'log\n',
    'config/local.json': '{}\n',
    'sub/secret.txt': 'secret\n',
    'sub/.env': 'C=3\n',
    // Named, but not ignored: git would show it as a new file in the worktree, so it stays.
    'notes.env.txt': 'untracked\n',
    '.worktreeinclude': '# env files\n.env*\n!.env.local\nconfig/local.json\n/sub/secret.txt\n*.txt\n',
  });
  assert.deepEqual(await worktrees.includedFiles(repo), ['.env', 'config/local.json', 'sub/.env', 'sub/secret.txt']);
});

test('includedFiles searches a folder ignored as a whole only for the patterns that name it', async (t) => {
  const repo = makeRepo(tempDir(t));
  writeFiles(repo, { '.gitignore': 'node_modules/\n.claude/\nvendor/\n' });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'ignore');
  writeFiles(repo, {
    'node_modules/pkg/config.json': '{}\n',
    'node_modules/pkg/.env': 'X=1\n',
    '.claude/skills/a.md': 'a\n',
    '.claude/skills/b.txt': 'b\n',
    'vendor/lib/config.json': '{}\n',
    '.worktreeinclude': '.env\n**/config.json\n**/.claude/skills/*.md\nvendor/**/config.json\n',
  });
  assert.deepEqual(await worktrees.includedFiles(repo), ['.claude/skills/a.md', 'vendor/lib/config.json']);

  // A pattern that matches the folder itself takes all of it.
  writeFiles(repo, { '.worktreeinclude': '.claude/\n' });
  assert.deepEqual(await worktrees.includedFiles(repo), ['.claude/skills/a.md', '.claude/skills/b.txt']);
});

test('includedFiles is empty without a .worktreeinclude', async (t) => {
  const repo = makeRepo(tempDir(t));
  writeFiles(repo, { '.gitignore': '.env\n' });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'ignore');
  writeFiles(repo, { '.env': 'A=1\n' });
  assert.deepEqual(await worktrees.includedFiles(repo), []);
});

test('addWorktree copies the files .worktreeinclude names, as planWorktree says', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  writeFiles(repo, { '.gitignore': '.env\nconfig/local.json\n', '.worktreeinclude': '.env\nconfig/local.json\n' });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'include');
  writeFiles(repo, { '.env': 'A=1\n', 'config/local.json': '{"a":1}\n' });

  assert.equal((await worktrees.planWorktree(repo, 'feat')).copies, 2);
  const { folder, copied, failed } = await worktrees.addWorktree(repo, 'feat');
  assert.deepEqual(copied, ['.env', 'config/local.json']);
  assert.deepEqual(failed, []);
  assert.equal(fs.readFileSync(path.join(folder, '.env'), 'utf8'), 'A=1\n');
  assert.equal(fs.readFileSync(path.join(folder, 'config', 'local.json'), 'utf8'), '{"a":1}\n');
  // Ignored in the new worktree too, so it has nothing to commit.
  assert.equal(await worktrees.worktreeChanges(folder), 0);
});

test('ignoredOnlyHere lists the ignored files that the main worktree lacks or has with other content', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  writeFiles(repo, { '.gitignore': 'node_modules/\ndist\n.env\n*.log\nconfig/local.json\n' });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'ignore');
  writeFiles(repo, { '.env': 'A=1\n', 'config/local.json': '{"a":1}\n' });
  const { folder } = await worktrees.addWorktree(repo, 'feat');
  writeFiles(folder, {
    // Changed in the worktree.
    '.env': 'A=2\n',
    // As .worktreeinclude would have copied it.
    'config/local.json': '{"a":1}\n',
    // Only in the worktree; logs/ holds nothing but ignored files.
    'notes.log': 'note\n',
    'logs/run.log': 'run\n',
    // In folders ignored as a whole.
    'node_modules/pkg/index.js': 'x\n',
    'dist/app.js': 'x\n',
  });
  assert.deepEqual(await worktrees.ignoredOnlyHere(folder, repo), ['.env', 'logs/run.log', 'notes.log']);
  // Not a change: removing is not blocked for them.
  assert.equal(await worktrees.worktreeChanges(folder), 0);
});

test('ignoredOnlyHere tells files of the same size apart by their content', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  writeFiles(repo, { '.gitignore': '*.bin\n' });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'ignore');
  // Larger than a piece of the comparison, differing only at the end.
  const big = Buffer.alloc(200 * 1024, 7);
  fs.writeFileSync(path.join(repo, 'same.bin'), big);
  fs.writeFileSync(path.join(repo, 'other.bin'), big);
  const { folder } = await worktrees.addWorktree(repo, 'feat');
  fs.writeFileSync(path.join(folder, 'same.bin'), big);
  fs.writeFileSync(path.join(folder, 'other.bin'), Buffer.concat([big.subarray(0, big.length - 1), Buffer.from([8])]));
  assert.deepEqual(await worktrees.ignoredOnlyHere(folder, repo), ['other.bin']);
});

test('repoCatalog lists the configured repositories once each', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  const { repos: catalog } = await worktrees.repoCatalog({ repoSources: [], repos: [repo, `${repo}${path.sep}`] });
  assert.deepEqual(catalog, [{ path: repo, name: 'repo', owner: path.basename(dir), git: true, sources: ['config'] }]);
});

test('repoCatalog tells git repositories from checkouts of other version control systems', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  const linked = path.join(dir, 'repo-feat');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', linked);
  const svn = path.join(dir, 'svn-checkout');
  fs.mkdirSync(path.join(svn, '.svn'), { recursive: true });

  const { repos: catalog } = await worktrees.repoCatalog({ repoSources: [], repos: [repo, linked, svn] });
  assert.deepEqual(
    catalog.map((entry) => [entry.name, entry.git]),
    [
      ['repo', true],
      ['repo-feat', true],
      ['svn-checkout', false],
    ],
  );
});

// A repository as the last list had it. The names do not matter here, and path.basename would
// not split a WSL path on Linux.
const listed = (p, ...sources) => ({ path: p, name: 'x', owner: 'y', git: true, sources });
const pathsAndSources = (repos) => repos.map((repo) => [repo.path, repo.sources]);

test('repoCatalog keeps what a source that failed listed last, and drops what a read one no longer lists', async () => {
  const a = path.resolve('/repos/a');
  const ubuntu = windowsPath('Ubuntu', '/home/me/u');
  const debianOld = windowsPath('Debian', '/home/me/old');
  const debianNew = windowsPath('Debian', '/home/me/new');
  const previous = [listed(a, 'ghq'), listed(ubuntu, 'wsl:Ubuntu'), listed(debianOld, 'wsl:Debian')];
  const { repos, problems, ghq } = await worktrees.repoCatalog({ repoSources: ['ghq', 'wsl'], repos: [] }, previous, {
    platform: 'win32',
    ghq: async () => {
      throw new Error('Command failed: ghq list\nsomething broke');
    },
    distros: async () => ({ names: ['Ubuntu', 'Debian'], error: null }),
    wslGhq: async (name) => {
      if (name === 'Ubuntu') throw new Error('Command failed: sh (exit 1)');
      return { ghq: true, repos: [{ path: debianNew, git: true }] };
    },
  });
  assert.deepEqual(pathsAndSources(repos), [
    [debianNew, ['wsl:Debian']],
    [a, ['ghq']],
    [ubuntu, ['wsl:Ubuntu']],
  ]);
  assert.deepEqual(problems.sort((x, y) => x.source.localeCompare(y.source)), [
    { source: 'ghq', message: 'Command failed: ghq list something broke' },
    { source: 'wsl:Ubuntu', message: 'Command failed: sh (exit 1)' },
  ]);
  // Those that failed are not known to have ghq.
  assert.deepEqual(ghq, ['wsl:Debian']);
});

test('repoCatalog says which sources have ghq, with repositories or without', async () => {
  const { repos, ghq } = await worktrees.repoCatalog({ repoSources: ['ghq', 'wsl'], repos: [] }, [], {
    platform: 'win32',
    ghq: async () => ({ ghq: false, repos: [] }),
    distros: async () => ({ names: ['Ubuntu', 'Debian', 'Alpine'], error: null }),
    wslGhq: async (name) => ({ ghq: name !== 'Alpine', repos: name === 'Debian' ? [{ path: windowsPath(name, '/home/me/r'), git: true }] : [] }),
  });
  assert.equal(repos.length, 1);
  assert.deepEqual(ghq, ['wsl:Ubuntu', 'wsl:Debian']);
});

test('repoCatalog reads ghq in each distribution for "wsl", once each', async () => {
  const read = [];
  const { repos } = await worktrees.repoCatalog({ repoSources: ['wsl:ubuntu', 'wsl'], repos: [] }, [], {
    platform: 'win32',
    distros: async () => ({ names: ['Ubuntu', 'Debian'], error: null }),
    wslGhq: async (name) => {
      read.push(name);
      return { ghq: true, repos: [{ path: windowsPath(name, '/home/me/r'), git: true }] };
    },
  });
  // The spelling in the settings wins.
  assert.deepEqual(read, ['ubuntu', 'Debian']);
  assert.deepEqual(
    repos.map((repo) => repo.sources),
    [['wsl:ubuntu'], ['wsl:Debian']],
  );
});

test('repoCatalog keeps the repositories of every distribution while the distributions are not known', async () => {
  const ubuntu = windowsPath('Ubuntu', '/home/me/u');
  const timedOut = Object.assign(new Error('Command failed: wsl.exe -l -q'), { killed: true });
  const { repos, problems } = await worktrees.repoCatalog({ repoSources: ['wsl'], repos: [] }, [listed(ubuntu, 'wsl:Ubuntu')], {
    platform: 'win32',
    distros: async () => ({ names: null, error: timedOut }),
    wslGhq: async () => assert.fail('no distribution to read'),
  });
  assert.deepEqual(pathsAndSources(repos), [[ubuntu, ['wsl:Ubuntu']]]);
  assert.deepEqual(problems, [{ source: 'wsl', message: 'Command failed: wsl.exe -l -q' }]);
});

test('repoCatalog lists nothing from WSL without it, and drops what its distributions listed', async () => {
  const a = path.resolve('/repos/a');
  const ubuntu = windowsPath('Ubuntu', '/home/me/u');
  const missing = Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' });
  const { repos, problems } = await worktrees.repoCatalog({ repoSources: ['ghq', 'wsl'], repos: [] }, [listed(ubuntu, 'wsl:Ubuntu')], {
    platform: 'win32',
    ghq: async () => ({ ghq: true, repos: [{ path: a, git: true }] }),
    distros: async () => ({ names: [], error: missing }),
  });
  assert.deepEqual(pathsAndSources(repos), [[a, ['ghq']]]);
  assert.deepEqual(problems, [{ source: 'wsl', message: 'spawn wsl.exe ENOENT' }]);
});

test('repoCatalog drops what ghq listed once ghq lists nothing', async () => {
  const a = path.resolve('/repos/a');
  const { repos, problems } = await worktrees.repoCatalog({ repoSources: ['ghq'], repos: [] }, [listed(a, 'ghq', 'config')], {
    ghq: async () => ({ ghq: true, repos: [] }),
  });
  assert.deepEqual(repos, []);
  assert.deepEqual(problems, []);
});

test('usableSources leaves out the WSL sources where there is no WSL', () => {
  const sources = ['ghq', 'wsl', 'WSL:Ubuntu', 'wslish'];
  assert.deepEqual(worktrees.usableSources(sources, 'win32'), sources);
  assert.deepEqual(worktrees.usableSources(sources, 'darwin'), ['ghq', 'wslish']);
});

test('repoCatalog reads no WSL source where there is no WSL', async () => {
  const a = path.resolve('/repos/a');
  const { repos, problems } = await worktrees.repoCatalog({ repoSources: ['ghq', 'wsl', 'wsl:Ubuntu'], repos: [] }, [], {
    platform: 'darwin',
    ghq: async () => ({ ghq: true, repos: [{ path: a, git: true }] }),
    // Neither is asked for, so neither can fail.
    distros: async () => assert.fail('asked for the distributions'),
    wslGhq: async () => assert.fail('read ghq in a distribution'),
  });
  assert.deepEqual(pathsAndSources(repos), [[a, ['ghq']]]);
  assert.deepEqual(problems, []);
});

test('addToCatalog adds a repository, or its source, without changing the list it is given', (t) => {
  const repo = makeRepo(tempDir(t));
  const before = [listed(repo, 'ghq')];
  assert.deepEqual(pathsAndSources(worktrees.addToCatalog(before, repo, 'config')), [[repo, ['ghq', 'config']]]);
  assert.deepEqual(before[0].sources, ['ghq']);
  const other = makeRepo(path.dirname(repo), 'other');
  const added = worktrees.addToCatalog(before, other, 'config');
  assert.deepEqual(added[1], { path: other, name: 'other', owner: path.basename(path.dirname(repo)), git: true, sources: ['config'] });
});

// A repository of the account, as readOwnedRepos in github.js gives it.
const OWNED = {
  host: 'github.com',
  owner: 'o',
  type: 'org',
  name: 'app',
  url: 'https://github.com/o/app',
  fork: false,
  visibility: 'private',
  description: '',
  pushedAt: 1786282322000,
};

test('readRepoCache reads what writeRepoCache wrote, and null for a missing or broken file', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'repos.json');
  assert.equal(worktrees.readRepoCache(file), null);
  const a = path.resolve('/repos/a').toLowerCase();
  const cache = {
    repos: [listed(path.resolve('/repos/a'), 'ghq')],
    worktrees: { [a]: [{ path: path.resolve('/repos/a'), branch: 'main', main: true, locked: false }] },
    remotes: {
      [a]: { provider: 'github', url: 'https://github.com/o/a', owner: { host: 'github.com', owner: 'o' }, visibility: 'private', current: null },
      // Renamed on GitHub since it was cloned.
      [path.resolve('/repos/b').toLowerCase()]: { provider: 'github', url: 'https://github.com/o/b', visibility: 'public', current: 'https://github.com/p/b2' },
      [path.resolve('/repos/c').toLowerCase()]: { provider: 'other', url: null, owner: null, visibility: null, current: null },
    },
    owned: [OWNED],
  };
  worktrees.writeRepoCache(file, cache);
  assert.deepEqual(worktrees.readRepoCache(file), cache);

  // repos.json of a version that did not keep the remotes, and of one that kept the repositories
  // on GitHub by the host's name alone.
  fs.writeFileSync(file, JSON.stringify({ repos: cache.repos, worktrees: cache.worktrees }));
  assert.deepEqual(worktrees.readRepoCache(file), { ...cache, remotes: {}, owned: [] });
  const github = { [a]: { url: 'https://github.com/o/a', visibility: 'private' } };
  fs.writeFileSync(file, JSON.stringify({ repos: cache.repos, worktrees: cache.worktrees, github }));
  assert.deepEqual(worktrees.readRepoCache(file), { ...cache, remotes: {}, owned: [] });
  // One of a version from before the repositories of the account and the current addresses.
  const remotes = { [a]: { provider: 'gitlab', url: null, visibility: null } };
  fs.writeFileSync(file, JSON.stringify({ repos: cache.repos, worktrees: cache.worktrees, remotes }));
  assert.deepEqual(worktrees.readRepoCache(file), { ...cache, remotes: { [a]: { ...remotes[a], current: null } }, owned: [] });

  fs.writeFileSync(file, '{"repos": [');
  assert.equal(worktrees.readRepoCache(file), null);
  fs.writeFileSync(file, '{"worktrees": {}}');
  assert.equal(worktrees.readRepoCache(file), null);
});

test('readRepoCache leaves out entries of another shape', (t) => {
  const file = path.join(tempDir(t), 'repos.json');
  const good = listed(path.resolve('/repos/a'), 'ghq');
  fs.writeFileSync(
    file,
    JSON.stringify({
      repos: [good, { path: 'C:\\b' }, null, { ...good, sources: [1] }],
      worktrees: {
        'C:\\A': [
          { path: 'C:\\a', branch: null },
          { branch: 'x' },
          { path: 'C:\\a-x', branch: 'x', issue: { number: 20, title: 't' } },
          { path: 'C:\\a-y', branch: 'y', issue: { number: '20' } },
          { path: 'C:\\a-z', branch: 'z', pull: { number: 71, title: 't' } },
          { path: 'C:\\a-w', branch: 'w', pull: { title: 't' } },
        ],
        'c:\\b': 'nope',
      },
      remotes: {
        'C:\\A': { provider: 'github', url: 'https://github.com/o/a', visibility: 'internal' },
        'c:\\b': { provider: 'gitlab', url: null, visibility: null },
        'c:\\c': { provider: 'github', url: 'https://github.com/o/c', visibility: 'secret' },
        'c:\\d': { provider: 'github', visibility: 'public' },
        'c:\\e': null,
        'c:\\f': { provider: 'sourceforge', url: null, visibility: null },
        'c:\\g': { url: null, visibility: null },
        'c:\\h': { provider: 'github', url: 'https://github.com/o/h', visibility: null, current: 42 },
        'c:\\i': { provider: 'gitlab', url: null, owner: { host: 'gitlab.com', owner: 7 }, visibility: null },
        'c:\\j': { provider: 'gitlab', url: null, owner: { host: 'gitlab.com', owner: 'g', extra: true }, visibility: null },
      },
      owned: [
        OWNED,
        { ...OWNED, type: 'Organization' },
        { ...OWNED, name: 'b', pushedAt: null, visibility: null },
        { ...OWNED, fork: 'no' },
        { ...OWNED, url: null },
        { ...OWNED, visibility: 'secret' },
        null,
      ],
    }),
  );
  assert.deepEqual(worktrees.readRepoCache(file), {
    repos: [good],
    worktrees: {
      'c:\\a': [
        { path: 'C:\\a', branch: null },
        { path: 'C:\\a-x', branch: 'x', issue: { number: 20, title: 't' } },
        { path: 'C:\\a-z', branch: 'z', pull: { number: 71, title: 't' } },
      ],
    },
    remotes: {
      'c:\\a': { provider: 'github', url: 'https://github.com/o/a', visibility: 'internal', current: null },
      'c:\\b': { provider: 'gitlab', url: null, visibility: null, current: null },
      // A current address that is not one is dropped, not the entry.
      'c:\\h': { provider: 'github', url: 'https://github.com/o/h', visibility: null, current: null },
      // So is an owner that is not one, which leaves it to be read again.
      'c:\\i': { provider: 'gitlab', url: null, visibility: null, current: null },
      'c:\\j': { provider: 'gitlab', url: null, owner: { host: 'gitlab.com', owner: 'g' }, visibility: null, current: null },
    },
    owned: [OWNED, { ...OWNED, name: 'b', pushedAt: null, visibility: null }],
  });
});

test('recentBranches lists local and remote branches, newest first, each once', async (t) => {
  const repo = makeRepo(tempDir(t));
  // An empty commit on a new branch from main, committed at `date`.
  const commitAt = (branch, date) => {
    git(repo, 'checkout', '-q', '-b', branch, 'main');
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', branch], {
      cwd: repo,
      env: { ...process.env, GIT_COMMITTER_DATE: date },
      stdio: 'ignore',
    });
  };
  commitAt('feat/old', '2001-01-01T00:00:00Z');
  commitAt('feat/new', '2090-01-01T00:00:00Z');
  git(repo, 'update-ref', 'refs/remotes/origin/feat/new', 'HEAD');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat/new');
  assert.deepEqual(await worktrees.recentBranches(repo), ['feat/new', 'main', 'feat/old']);
  assert.deepEqual(await worktrees.recentBranches(repo, 1), ['feat/new']);
});

test('setBranchLink keeps the issue or pull request of a branch, which the worktree list shows until the branch goes', async (t) => {
  const dir = tempDir(t);
  const repo = makeRepo(dir);
  assert.deepEqual(await worktrees.branchLinks(repo), new Map());
  const { folder, branch } = await worktrees.addWorktree(repo, 'feat/issue20.x');
  const issue = { number: 20, title: 'GitHub の issue から worktree を作る' };
  await worktrees.setBranchLink(repo, branch, 'issue', issue);
  await worktrees.addWorktree(repo, 'Alice/patch-1');
  const pull = { number: 71, title: 'PR の番号から worktree を作る' };
  await worktrees.setBranchLink(repo, 'Alice/patch-1', 'pull', pull);
  await worktrees.addWorktree(repo, 'plain');
  // A title alone names nothing.
  git(repo, 'config', 'branch.plain.worktabs-pull-title', 'x');

  assert.deepEqual(
    await worktrees.branchLinks(repo),
    new Map([
      ['feat/issue20.x', { issue }],
      ['Alice/patch-1', { pull }],
    ]),
  );
  const listed = await worktrees.listWorktrees(repo);
  assert.deepEqual(
    listed.map((w) => [w.branch, w.issue, w.pull]).sort(),
    [
      ['Alice/patch-1', undefined, pull],
      ['feat/issue20.x', issue, undefined],
      ['main', undefined, undefined],
      ['plain', undefined, undefined],
    ],
  );

  await worktrees.removeWorktree(repo, folder);
  await worktrees.deleteBranch(repo, branch);
  assert.deepEqual([...(await worktrees.branchLinks(repo)).keys()], ['Alice/patch-1']);
});

test('gitWorktrees fails outside git with a message that gitMessage keeps short', async (t) => {
  const dir = tempDir(t);
  await assert.rejects(worktrees.gitWorktrees(dir), (error) => /^not a git repository/.test(worktrees.gitMessage(error)));
});

test('wslGhqRepos lists the repositories ghq has in a distribution, as Windows paths', async () => {
  const runs = [];
  const distroOf = (name) => ({
    exec: async (command, args, options) => {
      runs.push([name, command, options]);
      return 'ghq\ng /home/me/repo\n- /home/me/svn-checkout\nnoise\n';
    },
  });
  const { ghq, repos } = await worktrees.wslGhqRepos('Ubuntu', { distroOf });
  assert.equal(ghq, true);
  assert.deepEqual(repos, [
    { path: windowsPath('Ubuntu', '/home/me/repo'), git: true },
    { path: windowsPath('Ubuntu', '/home/me/svn-checkout'), git: false },
  ]);
  assert.deepEqual(runs, [['Ubuntu', 'sh', { timeout: 30000, shellEnv: true }]]);
  const none = await worktrees.wslGhqRepos('Alpine', { distroOf: () => ({ exec: async () => '' }) });
  assert.deepEqual(none, { ghq: false, repos: [] });
});
