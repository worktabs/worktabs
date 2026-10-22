// What the claude wrapper is given in the tests, and what it must do with it. There is one
// wrapper per platform (native/ClaudeWrap.cs on Windows, src/agents/mac-claude-wrap.js on macOS);
// they take the same command line, so they are held to the same run here.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// As claude 2.1.283 writes it.
const USAGE = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1790659800,
    rateLimitType: 'five_hour',
    isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.22, resetsAt: 1790659800 }, seven_day: { utilization: 0.51, resetsAt: 1791007200 } },
  },
  uuid: 'u1',
  session_id: 's1',
});
const REORDERED = JSON.stringify({ uuid: 'u2', type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
// What the stand-in for claude writes: FIRST, then (once a line comes in on stdin) "got <line>"
// and the REST, a piece at a time.
const FIRST = '{"type":"system","subtype":"init"}\nready\n';
const REST = [
  `{"type":"user","text":"${'x'.repeat(200000)}"}\n`,
  // Name the event, but are not one.
  `{"type":"assistant","text":${JSON.stringify(USAGE)}}\n`,
  `{"type":"other","inner":${USAGE}}\n`,
  USAGE.slice(0, 10),
  `${USAGE.slice(10)}\r\n`,
  `${REORDERED}\n`,
  '{"type":"result","text":"日本語"}\n',
  'no newline at the end',
];
const CHILD = `
const fs = require('fs');
const path = require('path');
const { first, rest } = JSON.parse(fs.readFileSync(path.join(__dirname, 'pieces.json'), 'utf8'));
process.stdout.write(first);
process.stdin.once('data', async (data) => {
  process.stdin.destroy();
  process.stdout.write('got ' + data.toString().trim() + '\\n');
  for (const piece of rest) {
    process.stdout.write(piece);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  process.stderr.write('to stderr\\n');
  process.exitCode = 3;
});
`;
// What the wrapper's own output must be: everything the stand-in wrote, in order.
const EXPECTED_OUT = `${FIRST}got go\n${REST.join('')}`;
const EXPECTED_ERR = 'to stderr\n';
const EXPECTED_CODE = 3;

// Writes the stand-in for claude into `dir` and returns its command line (node and the script).
function writeChild(dir) {
  fs.writeFileSync(path.join(dir, 'pieces.json'), JSON.stringify({ first: FIRST, rest: REST }));
  const child = path.join(dir, 'child.js');
  fs.writeFileSync(child, CHILD);
  return [process.execPath, child];
}

// Runs the wrapper over the stand-in and returns its output and exit code. A line goes to its
// standard input as soon as "ready" comes back, which only happens while the stand-in still
// runs if the wrapper passes output on as it comes.
function runWrapper(command, args, env) {
  const wrapper = spawn(command, args, { env });
  const out = [];
  let err = '';
  let sent = false;
  wrapper.stdout.on('data', (chunk) => {
    out.push(chunk);
    if (!sent && Buffer.concat(out).toString().includes('ready\n')) {
      sent = true;
      wrapper.stdin.write('go\n');
    }
  });
  wrapper.stderr.on('data', (chunk) => (err += chunk));
  return new Promise((resolve) => {
    wrapper.on('close', (code) => resolve({ code, out: Buffer.concat(out).toString('utf8'), err }));
  });
}

// What claude must be given, with `settings` as the app's settings file. A session gets the file;
// a subcommand gets its arguments as they are, as claude rejects --settings after "auth status",
// which the extension runs to check the sign-in. The stand-in for claude has to be one program
// here, as claude is: the wrappers look at the argument after it.
function settingsCases(settings) {
  return [
    { args: ['--print', '--verbose'], expected: ['--print', '--verbose', '--settings', settings] },
    { args: [], expected: ['--settings', settings] },
    { args: ['auth', 'status', '--json'], expected: ['auth', 'status', '--json'] },
  ];
}

module.exports = {
  CHILD, EXPECTED_CODE, EXPECTED_ERR, EXPECTED_OUT, FIRST, REORDERED, REST, USAGE, runWrapper, settingsCases, writeChild,
};
