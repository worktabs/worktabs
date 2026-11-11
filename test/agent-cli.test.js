const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { cliFailureMessage, extensionBinary, resolveAgentCli } = require('../src/agents/agent-cli');
const { codexSetupWarnings } = require('../src/agents/agents');
const { prepareCodex } = require('../src/codex/codex-launch');
const { localFiles } = require('../src/code-server/code-server');
const { tempDir } = require('./support');

const entry = (agent, location, target) => ({ identifier: { id: agent === 'codex' ? 'OpenAI.chatgpt' : 'Anthropic.claude-code' }, relativeLocation: location, metadata: { targetPlatform: target } });

test('extension binaries match each supported platform and architecture', async () => {
  for (const [platform, prefix] of [['win32', 'windows'], ['darwin', 'macos'], ['linux', 'linux']]) {
    for (const [arch, suffix] of [['x64', 'x86_64'], ['arm64', 'aarch64']]) {
      const join = platform === 'win32' ? path.win32.join : path.posix.join;
      const extensionsDir = platform === 'win32' ? 'C:\\extensions with spaces' : '/extensions with spaces';
      for (const agent of ['claude', 'codex']) {
        const files = { join, read: async () => JSON.stringify([entry(agent, 'active-1', `${platform}-${arch}`)]) };
        const binary = await extensionBinary({ files, extensionsDir, agent, platform, arch });
        assert.equal(binary, agent === 'codex'
          ? join(extensionsDir, 'active-1', 'bin', `${prefix}-${suffix}`, platform === 'win32' ? 'codex.exe' : 'codex')
          : join(extensionsDir, 'active-1', 'resources', 'native-binary', platform === 'win32' ? 'claude.exe' : 'claude'));
      }
    }
  }
});

test('selection rejects malformed indexes, wrong targets and paths outside the extension folder', async () => {
  for (const data of ['broken', 'null', '{}', '[]', '[null, {"identifier":{"id":123}}]', JSON.stringify([entry('claude', 'old', 'linux-x64')]), JSON.stringify([entry('codex', 'wrong-platform', 'linux-x64')]), ...['../outside', '..\\outside', '/outside', 'C:\\outside'].map((location) => JSON.stringify([entry('codex', location, 'win32-x64')]))]) {
    assert.equal(await extensionBinary({ files: { join: path.posix.join, read: async () => data }, extensionsDir: '/extensions', agent: 'codex', platform: 'win32', arch: 'x64' }), null);
  }
  const files = { join: path.posix.join, read: async () => JSON.stringify([entry('claude', 'claude-1', 'darwin-universal')]) };
  assert.equal(await extensionBinary({ files, extensionsDir: '/extensions', agent: 'claude', platform: 'darwin', arch: 'arm64' }), '/extensions/claude-1/resources/native-binary/claude');
  assert.equal(await extensionBinary({ files, extensionsDir: '/extensions', agent: 'claude', platform: 'linux', arch: 'x64' }), null);
  assert.equal(await extensionBinary({ files, extensionsDir: '/extensions', agent: 'claude', platform: 'darwin', arch: 'ia32' }), null);
});

async function install(extensionsDir, agent, version) {
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.writeFileSync(path.join(extensionsDir, 'extensions.json'), JSON.stringify([entry(agent, `${agent}-${version}`, `${process.platform}-${process.arch}`)]));
  const binary = await extensionBinary({ files: localFiles, extensionsDir, agent });
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'bundled executable', { mode: 0o755 });
  return binary;
}

test('each resolution and Codex chat launch follow updates, re-imports and restores', async (t) => {
  const extensionsDir = path.join(tempDir(t), 'extensions');
  for (const agent of ['claude', 'codex']) {
    const binaries = [];
    for (const version of ['1', '2', '3', '1']) {
      const binary = await install(extensionsDir, agent, version);
      binaries.push(binary);
      assert.equal(await resolveAgentCli('', agent, { extensionsDir }), binary);
      if (agent === 'codex') {
        const dir = path.join(extensionsDir, 'proxy');
        const nativeLauncher = path.join(extensionsDir, 'launcher.exe');
        fs.writeFileSync(nativeLauncher, 'launcher');
        await prepareCodex({ files: localFiles, extensionsDir, dir, node: process.execPath, nativeLauncher });
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'codex-launch.json'))).binary, binary);
      }
    }
    assert.notEqual(binaries[0], binaries[1]);
    assert.equal(binaries[0], binaries[3]);
  }
});

test('missing extension files and non-executable payloads give setup instructions', async (t) => {
  const extensionsDir = tempDir(t);
  for (const agent of ['claude', 'codex']) {
    fs.writeFileSync(path.join(extensionsDir, 'extensions.json'), '[]');
    await assert.rejects(resolveAgentCli('', agent, { extensionsDir }), { code: 'AGENT_CLI_SETUP' });
    const binary = await install(extensionsDir, agent, '1');
    fs.unlinkSync(binary);
    await assert.rejects(resolveAgentCli('', agent, { extensionsDir }), /Settings > Extensions/);
    fs.mkdirSync(binary);
    await assert.rejects(resolveAgentCli('', agent, { extensionsDir }), { code: 'AGENT_CLI_SETUP' });
    fs.rmdirSync(binary);
    if (process.platform !== 'win32') {
      fs.writeFileSync(binary, 'no execute permission', { mode: 0o644 });
      await assert.rejects(resolveAgentCli('', agent, { extensionsDir }), { code: 'AGENT_CLI_SETUP' });
    }
  }
});

test('WSL reads and checks only the selected distribution Linux payload, before an agent is started', async () => {
  for (const [machine, arch, suffix] of [['x86_64', 'x64', 'x86_64'], ['aarch64', 'arm64', 'aarch64']]) {
    for (const agent of ['claude', 'codex']) {
      const calls = [];
      let present = true;
      const linux = { async exec(command, args) {
        calls.push([command, args]);
        if (command === 'test') {
          if (!present) throw Object.assign(new Error('missing'), { code: 1 });
          return '';
        }
        if (args.length === 2) return `/home/user with spaces\n${machine}\n`;
        assert.equal(args[3], '/home/user with spaces/.worktabs/extensions/extensions.json');
        return JSON.stringify([entry(agent, 'active', `linux-${arch}`)]);
      } };
      const options = { extensionsDir: 'C:\\windows extensions', platform: 'win32', arch: 'x64', distro: (name) => { assert.equal(name, 'Ubuntu'); return linux; } };
      const folder = '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo';
      const binary = await resolveAgentCli(folder, agent, options);
      assert.equal(binary, agent === 'codex'
        ? `/home/user with spaces/.worktabs/extensions/active/bin/linux-${suffix}/codex`
        : '/home/user with spaces/.worktabs/extensions/active/resources/native-binary/claude');
      assert.deepEqual(calls.slice(-2), [['test', ['-f', binary]], ['test', ['-x', binary]]]);
      present = false;
      await assert.rejects(resolveAgentCli(folder, agent, options), /WSL Ubuntu.*matching Linux/);
      assert.ok(!JSON.stringify(calls).includes('C:\\'));
    }
  }
});

test('setup warnings check the active executable without invoking a PATH CLI', async (t) => {
  const extensionsDir = tempDir(t);
  const settings = { agents: ['codex'], defaultAgent: 'codex', branchAgent: 'default', extensionsDir };
  assert.match((await codexSetupWarnings(settings))[0], /install it from Open VSX.*Settings > Extensions/);
  const binary = await install(extensionsDir, 'codex', '1');
  assert.deepEqual(await codexSetupWarnings(settings), []);
  fs.unlinkSync(binary);
  assert.equal((await codexSetupWarnings(settings)).length, 1);
});

test('failures distinguish missing payloads, authentication and other execution errors', () => {
  for (const agent of ['claude', 'codex']) {
    for (const code of ['ENOENT', 'EACCES', 'ENOEXEC', 126, 127]) assert.match(cliFailureMessage(agent, '', { code }), /Settings > Extensions/);
    for (const stderr of ['Not logged in', 'Unauthorized (401)', 'Please sign in', 'Invalid API key', 'Refresh token has expired', 'API Error: 401 {"message":"Invalid authentication credentials"}']) {
      assert.match(cliFailureMessage(agent, '', { code: 1, stderr }), /authentication.*on this computer and sign in/);
      assert.match(cliFailureMessage(agent, '\\\\wsl$\\Ubuntu\\repo', { code: 1, stdout: stderr }), /WSL Ubuntu and sign in there/);
    }
    assert.equal(cliFailureMessage(agent, '', { code: 1, stderr: 'error: rate limit reached' }), 'rate limit reached');
    assert.equal(cliFailureMessage(agent, '', { code: 1, stderr: 'error: network timeout', message: 'Command failed: name a branch for users not logged in' }), 'network timeout');
    assert.equal(cliFailureMessage(agent, '', { code: 1, stdout: "You've hit your limit · resets 6pm", stderr: 'Warning: no stdin data received in 3s, proceeding without it.' }), "You've hit your limit · resets 6pm");
    assert.equal(cliFailureMessage(agent, '', { code: 1, message: 'network timeout' }), 'network timeout');
  }
});
