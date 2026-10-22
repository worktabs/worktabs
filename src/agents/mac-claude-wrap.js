// Process wrapper for the Claude Code extension on macOS (claudeCode.claudeProcessWrapper),
// which claude-wrap.exe is on Windows. It takes the same command line, in two modes:
//
//   claude-wrap <path-to-claude> <args...>
//     Starts claude with the same arguments, plus "--settings <file>" when
//     WORKTABS_CLAUDE_SETTINGS names a settings file, so the app's hooks apply only to the
//     sessions it manages. claude inherits this process's stdin and stderr (the extension's
//     stream-json pipes); its stdout is copied through as it comes, and the rate_limit_event
//     lines in it also go to the app, which has no other way to see the usage windows.
//     WORKTABS_PROC_ID (this process's id) goes to claude's environment, and from there into
//     every hook: one extension panel runs one claude, so the app can tell the panels'
//     conversations apart and see a panel's claude end.
//
//   claude-wrap --hook
//     Command hook for events that cannot use http hooks (SessionStart). Posts stdin unchanged
//     to WORKTABS_HOOK_URL with the same headers the http hooks send. Prints nothing and always
//     exits 0, so it never blocks or decides anything.
//
// The extension runs the wrapper as a program, and there is no node on the PATH to rely on, so
// installWrapper writes a shell script that runs this file with the app's own binary (Electron
// as node). code-server's node would do as well, but it is not there yet when the app writes
// the hook settings that name the wrapper.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

// What a rate_limit_event line of claude's stream-json output has. Text inside a JSON string
// cannot match it, as its quotes are escaped there. The app checks the type again.
const USAGE_TYPE = '"type":"rate_limit_event"';
// Longer lines are not looked at; the event is small.
const MAX_USAGE_LINE = 64 * 1024;
// Neither mode may hold up the session when the app is gone.
const POST_TIMEOUT = 2000;

// Single quotes for sh: everything but a single quote is literal inside them.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// The shell script the extension runs: "$@" is claude's path and arguments, or --hook.
function wrapperScript(exe, script) {
  return [
    '#!/bin/sh',
    '# Written by Worktabs (claudeCode.claudeProcessWrapper); edits are overwritten at start.',
    'ELECTRON_RUN_AS_NODE=1',
    'export ELECTRON_RUN_AS_NODE',
    `exec ${shellQuote(exe)} ${shellQuote(script)} "$@"`,
    '',
  ].join('\n');
}

// Writes the wrapper the extension runs, and this program beside it, into `dir`. `exe` is the
// binary that runs the program as node (the app's own). Returns the wrapper's path, which is
// what claudeCode.claudeProcessWrapper and the SessionStart hook name.
function installWrapper({ dir, exe }) {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'mac-claude-wrap.js');
  // Read, not copy: in the packaged app this file is inside the asar archive, which a plain
  // node cannot read.
  fs.writeFileSync(script, fs.readFileSync(__filename));
  const wrapper = path.join(dir, 'claude-wrap');
  fs.writeFileSync(wrapper, wrapperScript(exe, script));
  // A mode passed to writeFileSync applies only when it creates the file.
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

// Picks the rate_limit_event lines out of claude's output, which arrives in chunks that split
// lines anywhere. `onLine` takes each one, as a Buffer, when its line ends.
function usageScanner(onLine) {
  let parts = [];
  let length = 0;
  let keep = true;
  const reset = () => {
    parts = [];
    length = 0;
  };
  return (chunk) => {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline < 0 ? chunk.length : newline;
      if (keep) {
        parts.push(chunk.subarray(start, end));
        length += end - start;
        // Too long to be the event: the rest of the line is not held either.
        keep = length <= MAX_USAGE_LINE;
        if (!keep) reset();
      }
      if (newline < 0) return;
      if (keep) {
        // One part is the whole line, which is the usual case; concatenating copies it.
        const line = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
        if (line.includes(USAGE_TYPE)) onLine(line);
      }
      reset();
      keep = true;
      start = newline + 1;
    }
  };
}

// Posts to a route of the app's hook server (WORKTABS_HOOK_URL is its /hook), with the same
// headers the http hooks send. Resolves however it goes: the app being down must never fail or
// delay the session.
/** @returns {Promise<void>} */
function post(route, body, procId) {
  return new Promise((resolve) => {
    const base = process.env.WORKTABS_HOOK_URL;
    if (!base) {
      resolve();
      return;
    }
    let url;
    try {
      url = new URL(route, base);
    } catch {
      resolve();
      return;
    }
    const req = http.request(url, {
      method: 'POST',
      timeout: POST_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'X-Wrapper-Token': process.env.WORKTABS_HOOK_TOKEN || '',
        'X-Wrapper-Tab': process.env.WORKTABS_TAB_ID || '',
        'X-Wrapper-Proc': procId || '',
      },
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve());
    req.end(body);
  });
}

// --hook: the hook's input reaches the app unchanged, and claude is never told to wait.
function postHook() {
  const chunks = [];
  const done = () => process.exit(0);
  setTimeout(done, POST_TIMEOUT + 1000).unref();
  process.stdin.on('error', done);
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    post('hook', Buffer.concat(chunks), process.env.WORKTABS_PROC_ID).then(done, done);
  });
}

// Runs claude and copies its output through. `argv` is claude's path and its arguments.
function run(argv) {
  const [claude, ...args] = argv;
  const settings = process.env.WORKTABS_CLAUDE_SETTINGS;
  // A subcommand (the extension runs "auth status --json" to check the sign-in) rejects
  // --settings after it, and starts no session for the hooks anyway.
  const session = args.length === 0 || args[0].startsWith('-');
  if (settings && session) args.push('--settings', settings);
  const procId = String(process.pid);
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, WORKTABS_PROC_ID: procId };
  // Set for this process alone (see wrapperScript); claude must not run as node.
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(claude, args, { stdio: ['inherit', 'pipe', 'inherit'], env });
  child.on('error', (error) => {
    process.stderr.write(`claude-wrap: ${claude}: ${error.message}\n`);
    process.exitCode = 1;
  });

  // One at a time, in order: the app keeps the windows of the event it saw last.
  let posting = Promise.resolve();
  const scan = usageScanner((line) => {
    posting = posting.then(() => post('usage', line, procId));
  });
  child.stdout.on('data', (chunk) => {
    scan(chunk);
    // Passing on the backpressure keeps claude's output from piling up here, as it would
    // without the wrapper.
    if (!process.stdout.write(chunk)) {
      child.stdout.pause();
      process.stdout.once('drain', () => child.stdout.resume());
    }
  });
  // The extension closed its end, or claude is gone: its writes then fail, as they would
  // without the wrapper. Neither may end this process before claude's exit code is in.
  process.stdout.on('error', () => {});
  child.stdout.on('error', () => {});

  // Windows gives claude a kill-on-close job; here the signals are passed on. claude also ends
  // by itself when the extension closes the stdin it inherited.
  for (const name of /** @type {NodeJS.Signals[]} */ (['SIGTERM', 'SIGINT', 'SIGHUP'])) {
    process.on(name, () => child.kill(name));
  }
  // Whatever usage is still being posted holds the process until it is sent or times out.
  child.on('exit', (code) => {
    process.exitCode = code === null ? 1 : code;
  });
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--hook') postHook();
  else if (argv.length) run(argv);
  else {
    process.stderr.write('usage: claude-wrap <claude> [args...] | --hook\n');
    process.exitCode = 2;
  }
}

module.exports = { installWrapper, shellQuote, usageScanner, wrapperScript };
