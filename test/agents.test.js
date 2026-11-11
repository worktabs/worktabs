const assert = require('node:assert/strict');
const test = require('node:test');
const { codexSetupWarnings, managedAgentSettings } = require('../src/agents/agents');

test('managedAgentSettings keeps the Claude wrapper settings', () => {
  assert.deepEqual(managedAgentSettings({ agents: ['claude'], wrapper: 'C:\\app\\claude-wrap.exe', permissionMode: 'auto', locale: 'ja' }), {
    'claudeCode.claudeProcessWrapper': 'C:\\app\\claude-wrap.exe',
    'claudeCode.initialPermissionMode': 'auto',
  });
});

test('managedAgentSettings sets Codex editor settings', () => {
  assert.deepEqual(managedAgentSettings({ agents: ['codex'], locale: 'ja' }), {
    'chatgpt.openOnStartup': false,
    'chatgpt.runCodexInWindowsSubsystemForLinux': false,
    'chatgpt.localeOverride': 'ja',
  });
});

test('managedAgentSettings clears managed optional values', () => {
  assert.deepEqual(managedAgentSettings({ agents: ['claude', 'codex'], wrapper: '/app/claude-wrap', permissionMode: '', locale: 'en' }), {
    'claudeCode.claudeProcessWrapper': '/app/claude-wrap',
    'claudeCode.initialPermissionMode': undefined,
    'chatgpt.openOnStartup': false,
    'chatgpt.runCodexInWindowsSubsystemForLinux': false,
    'chatgpt.localeOverride': undefined,
  });
});

test('codexSetupWarnings checks setup only when Codex is selected for branch suggestions', async () => {
  let calls = 0;
  const resolve = async () => { calls++; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  assert.deepEqual(await codexSetupWarnings({ agents: ['claude'], branchAgent: 'claude', resolve }), []);
  assert.deepEqual(await codexSetupWarnings({ agents: ['claude', 'codex'], defaultAgent: 'claude', branchAgent: 'default', resolve }), []);
  assert.equal(calls, 0);
  const warnings = await codexSetupWarnings({ agents: ['codex'], defaultAgent: 'codex', branchAgent: 'default', resolve });
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /install it from Open VSX.*Settings > Extensions/);
});

test('codexSetupWarnings stays quiet when the extension executable is available', async () => {
  const resolve = async (folder, agent, options) => {
    assert.equal(folder, '');
    assert.equal(agent, 'codex');
    assert.equal(options.extensionsDir, '/extensions');
    return '/extensions/codex';
  };
  assert.deepEqual(await codexSetupWarnings({ agents: ['codex'], defaultAgent: 'codex', branchAgent: 'codex', extensionsDir: '/extensions', resolve }), []);
});
