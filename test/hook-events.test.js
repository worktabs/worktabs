const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { localHookInput, localPath, wireHooks } = require('../src/conversations/hook-events');

const WSL = '\\\\wsl.localhost\\Ubuntu\\home\\me\\app';

test('Linux paths from a tab in WSL are read through \\\\wsl.localhost', () => {
  assert.equal(localPath(WSL, '/home/me/app/x.jsonl'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\app\\x.jsonl');
  assert.equal(localPath('/src/app', '/src/app/x.jsonl'), '/src/app/x.jsonl');
  assert.equal(localPath(WSL, undefined), undefined);
  const input = { transcript_path: '/home/me/t.jsonl', cwd: '/home/me/app', session_id: 's' };
  assert.deepEqual(localHookInput(WSL, input), { transcript_path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\t.jsonl', cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app', session_id: 's' });
  assert.equal(localHookInput('/src/app', input), input);
});

function setup() {
  const hooks = new EventEmitter();
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  const tabs = new Map([
    ['wsl', { id: 'wsl', folder: WSL, server: 'running' }],
    ['local', { id: 'local', folder: '/src/app', server: 'running' }],
    ['stopped', { id: 'stopped', folder: '/src/old', server: 'suspended' }],
  ]);
  wireHooks({
    hooks, tabs,
    sessions: { handle: record('handle'), handleCodex: record('codex') },
    usage: { take: () => true }, codexUsage: { take: () => false },
    usagePolling: { refresh: record('poll') }, pushState: record('push'), onToolUsed: record('tool'),
    conversationStarted: (tab) => calls.push(['started', tab.id]), helperRegistered: record('helper'), readTheme: (tab) => calls.push(['theme', tab.id]),
    reveal: record('reveal'), exists: (target) => target !== '/gone',
  });
  return { hooks, calls, tabs };
}

test('hooks reach the conversations, with Linux paths made local', () => {
  const { hooks, calls } = setup();
  hooks.emit('hook', 'wsl', { cwd: '/home/me/app' }, 7);
  assert.deepEqual(calls, [['handle', 'wsl', { cwd: WSL }, 7], ['tool', 'wsl', { cwd: '/home/me/app' }]]);
  calls.length = 0;
  hooks.emit('codex', 'wsl', { cwd: '/home/me/app', type: 'turn' }, 8);
  hooks.emit('codex', 'stopped', { cwd: '/src/old' }, 9);
  assert.deepEqual(calls, [['codex', 'wsl', { cwd: WSL, type: 'turn' }, 8]]);
});

test('a conversation started, resumed, or sent to has its tab read the chat in view', () => {
  const { hooks, calls } = setup();
  for (const hook_event_name of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) hooks.emit('hook', 'local', { hook_event_name }, 1);
  hooks.emit('codex', 'local', { threadId: 't', state: 'idle', loaded: true }, 2);
  hooks.emit('codex', 'local', { threadId: 't', state: 'working' }, 2);
  hooks.emit('codex', 'stopped', { threadId: 't', state: 'idle', loaded: true }, 3);
  assert.deepEqual(calls.filter(([name]) => name === 'started'), [['started', 'local'], ['started', 'local'], ['started', 'local']]);
});

test('Codex reports count only from a tab that runs', () => {
  const { hooks, calls, tabs } = setup();
  hooks.emit('codex-observer', 'local');
  hooks.emit('codex-observer', 'stopped');
  assert.equal(tabs.get('local').codexObserved, true);
  assert.equal(tabs.get('stopped').codexObserved, undefined);
  hooks.emit('codex-usage', 'local', { type: 'codex-account' }, 1);
  hooks.emit('codex-usage', 'stopped', { type: 'codex-account' }, 1);
  hooks.emit('usage', {});
  assert.deepEqual(calls, [['poll', 'codex'], ['push']]);
});

test('a reveal opens only a path that is there, of a tab that is open', () => {
  const { hooks, calls } = setup();
  hooks.emit('explore', 'local', '/src/app/a.txt');
  hooks.emit('explore', 'local', '/gone');
  hooks.emit('explore', 'local', 'relative.txt');
  hooks.emit('explore', 'closed', '/src/app/a.txt');
  hooks.emit('theme', 'local');
  hooks.emit('theme', 'closed');
  assert.deepEqual(calls, [['reveal', '/src/app/a.txt'], ['theme', 'local']]);
});
