// The claude wrapper in WSL (src/wsl/wsl-claude-wrap.sh), which claude-wrap.exe is on Windows.
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { tempDir } = require('./support');
const { settingsCases } = require('./wrap-fixture');

const WRAPPER = path.join(__dirname, '..', 'src', 'wsl', 'wsl-claude-wrap.sh');
const skip = process.platform === 'win32' ? 'needs a POSIX shell' : false;

// The stand-in for claude as one program (see settingsCases). Writes each argument on a line.
const ARGS_CHILD = '#!/bin/sh\nprintf \'%s\\n\' "$@"\n';

test('the WSL wrapper adds the app\'s settings to a session, and leaves a subcommand as it is', { skip }, (t) => {
  const dir = tempDir(t);
  const child = path.join(dir, 'args-child');
  fs.writeFileSync(child, ARGS_CHILD, { mode: 0o755 });
  const settings = path.join(dir, 'hook settings.json');

  for (const { args, expected } of settingsCases(settings)) {
    const out = execFileSync('sh', [WRAPPER, child, ...args], { env: { ...process.env, WORKTABS_CLAUDE_SETTINGS: settings } }).toString();
    assert.deepEqual(out.split('\n').slice(0, -1), expected, `with ${args.join(' ') || 'no arguments'}`);
  }
});
