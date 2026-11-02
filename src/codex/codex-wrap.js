// The Codex extension runs this in place of its bundled CLI. Pipes and arguments stay the
// extension's; only conversation metadata and sanitized quota state are copied to Worktabs,
// with approvals left in the UI.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { CodexObserver } = require('./codex-events');

// Protocol lines may split anywhere, including inside a UTF-8 character. Oversized lines are
// still forwarded, but need not be held in memory for observation.
function jsonScanner(onMessage, maxBytes = 4 * 1024 * 1024) {
  let parts = [], length = 0, keep = true;
  return (chunk) => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (keep) {
        length += end - start;
        keep = length <= maxBytes;
        if (keep) parts.push(chunk.subarray(start, end));
        else parts = [];
      }
      if (newline < 0) break;
      if (keep) {
        let value;
        try { value = JSON.parse(Buffer.concat(parts, length).toString('utf8')); } catch {}
        if (value) onMessage(value);
      }
      parts = []; length = 0; keep = true;
      start = newline + 1;
    }
  };
}

function post(event, procId) {
  const { WORKTABS_HOOK_URL: url, WORKTABS_HOOK_TOKEN: token, WORKTABS_TAB_ID: tab } = process.env;
  if (!url || !token || !tab) return Promise.resolve();
  return new Promise((resolve) => {
    const req = http.request(new URL('/codex', url), {
      method: 'POST', timeout: 2000,
      headers: { 'Content-Type': 'application/json', 'X-Wrapper-Token': token, 'X-Wrapper-Tab': tab, 'X-Wrapper-Proc': procId },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.on('timeout', () => req.destroy());
    req.end(JSON.stringify(event));
  });
}

// Keep events ordered while HTTP runs independently of the protocol pipes. Repeated metadata
// for the same thread can be folded when the app is slow, without losing state transitions.
function eventQueue(send) {
  const queue = [];
  let draining = null;
  function push(event) {
    const last = queue[queue.length - 1];
    if (event.threadId && last?.threadId === event.threadId && last.state === event.state && last.ended === event.ended
      && last.reason === event.reason && last.restoreFailed === event.restoreFailed) {
      // A folded thread load still tells the app to read the chat.
      queue[queue.length - 1] = last.loaded ? { ...event, loaded: true } : event;
    }
    else queue.push(event);
    if (!draining) draining = drain();
  }
  async function drain() {
    while (queue.length) await send(queue.shift()).catch(() => {});
    draining = null;
  }
  return { push, flush: () => draining || Promise.resolve() };
}

function run({ binary, args, input = process.stdin, output = process.stdout, error = process.stderr, send = post, procId = String(process.pid) }) {
  const events = eventQueue((event) => send(event, procId));
  const observer = new CodexObserver(events.push);
  const watching = args.includes('app-server');
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const onClient = jsonScanner((msg) => observer.client(msg));
  const onServer = jsonScanner((msg) => observer.server(msg));
  if (watching) {
    input.on('data', onClient);
    child.stdout.on('data', onServer);
  }
  input.pipe(child.stdin);
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(error, { end: false });
  child.stdin.on('error', () => {});
  const stop = () => child.kill();
  const onEnd = () => { if (watching) stop(); };
  input.once('end', onEnd);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return new Promise((resolve) => {
    child.once('error', (err) => { error.write(`${err.message}\n`); });
    child.once('close', async (code) => {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      input.removeListener('end', onEnd);
      input.removeListener('data', onClient);
      child.stdout.removeListener('data', onServer);
      input.unpipe(child.stdin);
      await events.flush();
      resolve(code ?? 1);
    });
  });
}

if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'codex-launch.json'), 'utf8'));
  run({ binary: config.binary, args: process.argv.slice(2), procId: process.env.WORKTABS_CODEX_PROC_ID || String(process.pid) })
    .then((code) => process.exit(code));
}

module.exports = { eventQueue, jsonScanner, run };
