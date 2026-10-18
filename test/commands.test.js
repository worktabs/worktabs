const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const commands = require('../src/commands');
const { tempDir } = require('./support');

test('local commands preserve stdin, cwd, environment, timeout, and hidden Windows processes', async () => {
  const calls = [];
  const input = [];
  const runner = commands.createCommandRunner({ execFile: (program, args, options, done) => {
    calls.push({ program, args, options });
    queueMicrotask(() => done(null, 'answer', ''));
    return { stdin: { on: (event) => input.push(['on', event]), end: (text) => input.push(['end', text]) } };
  }, distro: () => { throw new Error('Local commands must not enter WSL'); } });
  assert.equal(await runner.runAt('C:\\repo', 'gh', ['api'], 123, {
    input: 'query', cwd: path.resolve('repo'), env: { WORKTABS_COMMAND_TEST: 'value' }, shellEnv: true,
  }), 'answer');
  assert.deepEqual(input, [['on', 'error'], ['end', 'query']]);
  const { options } = calls[0];
  assert.equal(options.cwd, path.resolve('repo'));
  assert.equal(options.timeout, 123);
  assert.equal(options.windowsHide, true);
  assert.equal(options.maxBuffer, 16 * 1024 * 1024);
  assert.equal(options.env.WORKTABS_COMMAND_TEST, 'value');
  // Windows names it Path, and a copy of process.env no longer finds it as PATH.
  const pathKey = Object.keys(options.env).find((key) => key.toUpperCase() === 'PATH');
  assert.equal(options.env[pathKey], process.env.PATH);
});

test('real local commands receive stdin and run from the requested directory', async (t) => {
  const dir = tempDir(t);
  const script = "let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ input, cwd: process.cwd() })))";
  const result = JSON.parse(await commands.run(process.execPath, ['-e', script], 15000, { input: 'task\ntext', cwd: dir }));
  assert.deepEqual(result, { input: 'task\ntext', cwd: dir });
});

test('WSL commands keep distribution, Linux paths, explicit environment, and shell environment', async () => {
  const calls = [];
  const runner = commands.createCommandRunner({
    execFile: () => { throw new Error('WSL commands must not use local execFile'); },
    distro: (name) => ({ exec: async (...args) => { calls.push([name, ...args]); return 'answer'; } }),
  });
  const folder = '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo';
  await runner.runAt(folder, 'gh', ['api'], 321, { input: 'query', shellEnv: true,
    env: { GIT_TERMINAL_PROMPT: '0', WORKTABS_COMMAND_TEST: 'value' } });
  await runner.runGit(folder, ['status'], 456, 'stdin');
  assert.deepEqual(calls, [
    ['Ubuntu', 'env', ['GIT_TERMINAL_PROMPT=0', 'WORKTABS_COMMAND_TEST=value', 'gh', 'api'],
      { timeout: 321, shellEnv: true, input: 'query' }],
    ['Ubuntu', 'git', ['-C', '/home/user/repo', 'status'], { timeout: 456, shellEnv: false, input: 'stdin' }],
  ]);
  assert.equal(runner.hostPath(folder), '/home/user/repo');
  assert.equal(runner.localPath(folder, '/home/user/repo/file'), `${folder}\\file`);
  assert.equal(runner.localPath(null, 'relative'), path.resolve('relative'));
});

test('local Git commands retain -C paths and the original failure with both output streams', async () => {
  const failure = Object.assign(new Error('failed'), { code: 1 });
  const calls = [];
  const runner = commands.createCommandRunner({ execFile: (program, args, _options, done) => {
    calls.push([program, args]);
    queueMicrotask(() => done(failure, '{"data":{}}', 'gh: failed'));
    return { stdin: { on() {}, end() {} } };
  } });
  await assert.rejects(runner.runGit('repo', ['status']), (error) => {
    assert.equal(error, failure);
    assert.equal(error.stdout, '{"data":{}}');
    assert.equal(error.stderr, 'gh: failed');
    return true;
  });
  assert.deepEqual(calls, [['git', ['-C', 'repo', 'status']]]);
});

test('gitMessage keeps what git said, without its prefix', () => {
  const error = new Error('Command failed');
  error.stderr = 'hint: something\nfatal: not a git repository (or any of the parent directories): .git\n';
  assert.equal(commands.gitMessage(error), 'not a git repository (or any of the parent directories): .git');
  assert.equal(commands.gitMessage(new Error('spawn git ENOENT')), 'spawn git ENOENT');
});

test('run rejects a command that fails with what it wrote', async () => {
  // As gh writes GitHub's answer and fails when the answer has errors.
  const script = "process.stdout.write('{\"data\":{}}'); process.stderr.write('gh: not found'); process.exit(1)";
  const error = await commands.run(process.execPath, ['-e', script]).then(
    () => null,
    (e) => e,
  );
  assert.equal(error.code, 1);
  assert.equal(error.stdout, '{"data":{}}');
  assert.equal(error.stderr, 'gh: not found');
});

test('run and runAt set the variables they are given, keeping the rest', async () => {
  const script = 'process.stdout.write(`${process.env.GIT_TERMINAL_PROMPT}:${Boolean(process.env.PATH)}`)';
  assert.equal(await commands.run(process.execPath, ['-e', script], 15000, { env: { GIT_TERMINAL_PROMPT: '0' } }), '0:true');
  assert.equal(await commands.runAt(null, process.execPath, ['-e', script], 15000, { env: { GIT_TERMINAL_PROMPT: '0' } }), '0:true');
  assert.equal(await commands.run(process.execPath, ['-e', script]), `${process.env.GIT_TERMINAL_PROMPT}:true`);
});
