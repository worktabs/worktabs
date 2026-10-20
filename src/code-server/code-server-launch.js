// Shared instance policy and neutral helpers; transport and platform preparation stay in
// the local and WSL managers. Legacy exports in code-server.js remain for callers.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { t } = require('../i18n');
const { mergeSettings } = require('./settings-sync');
const { prepareCodex } = require('../codex/codex-launch');
const { readExtensionIndex } = require('./extension-index');
const { sleep } = require('../util');

// Variables that a VS Code terminal or a Claude session leaks into child processes. Passed on,
// they reach code-server's extension host and the claude it starts (CLAUDECODE, for one, makes
// claude behave as a nested session), so they are dropped. A deliberate OAuth token is kept.
// CODE_SERVER_PARENT_PID, from a code-server terminal, makes code-server exit with "not spawned
// with IPC".
const LEAKY_ENV = /^(ELECTRON_|VSCODE_|CLAUDE|CODE_SERVER_)/i;
const KEEP_ENV = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);
// code-server reads these as its own login secret; the app sets HASHED_PASSWORD itself.
const DROP_ENV = new Set(['MCP_CONNECTION_NONBLOCKING', 'PASSWORD', 'HASHED_PASSWORD']);

// code-server's Node trusts only its own CA list unless told to also trust the OS store. A proxy
// that inspects HTTPS re-signs certificates with a root CA that only the OS store has, so the
// extension gallery fails with "self-signed certificate in certificate chain" (Electron itself
// trusts the store). Node versions without the option ignore it. Locally, a value the user set
// is kept; WSL sets it for code-server (code-server-wsl.js).
const SYSTEM_CA_ENV = { NODE_USE_SYSTEM_CA: '1' };

function cleanEnv(extra = {}) {
  const env = { ...SYSTEM_CA_ENV };
  for (const [key, value] of Object.entries(process.env)) {
    if (LEAKY_ENV.test(key) && !KEEP_ENV.has(key.toUpperCase())) continue;
    if (DROP_ENV.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

// Node's own warnings on stderr: "(node:123) [DEP0169] DeprecationWarning: ... prone to errors ..."
// and the "(Use `node --trace-deprecation ...` ...)" line after it. They say nothing about what
// failed, and the first one would pass for the error line.
const NODE_WARNING = /^\(node:\d+\) |^\(Use `node --trace-/;

// What went wrong in a failed command's stderr (which may hold a whole stack trace): its first
// error line, else its first line, else `fallback`.
function firstErrorLine(stderr, fallback) {
  const lines = String(stderr || '').split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !NODE_WARNING.test(line));
  return lines.find((line) => /error/i.test(line)) || lines[0] || fallback;
}

// Resolves `preferred` when it can be bound, otherwise a free port chosen by the OS that is not
// one of `avoid` (those other tabs keep, see tab-ports.js).
async function pickPort(preferred = 0, avoid = new Set()) {
  if (preferred) {
    const server = await listen(preferred).catch(() => null);
    if (server) {
      await closeServer(server);
      return preferred;
    }
  }
  // Each port the OS gives stays bound until one to take turns up, so that it is not given again.
  const held = [];
  try {
    for (;;) {
      const server = await listen(0);
      held.push(server);
      const { port } = server.address();
      if (!avoid.has(port)) return port;
    }
  } finally {
    await Promise.all(held.map(closeServer));
  }
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** @returns {Promise<void>} */
function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function httpStatus(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(0);
    });
  });
}

// URL that opens the folder at `serverPath` (as the code-server sees it) in the instance on
// `port`.
function serverFolderUrl(port, serverPath) {
  const encoded = encodeURIComponent(serverPath).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
  return `http://127.0.0.1:${port}/?folder=${encoded}`;
}

// URL that opens `folder` in the instance on `port`. code-server on Windows redirects to
// ?folder=C:\..., which its browser side treats as a relative path and cannot open; the
// /c:/... form resolves, so the URL is always built here.
function folderUrl(port, folder) {
  let p = path.resolve(folder).replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(p)) p = `/${p[0].toLowerCase()}${p.slice(1)}`;
  return serverFolderUrl(port, p);
}

// The folder (as the code-server sees it) that a URL of one of the instances on `ports` points
// at, or null when it is not one of theirs.
function serverFolderFromUrl(url, ports) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== '127.0.0.1' || !ports.includes(Number(parsed.port))) return null;
  return parsed.searchParams.get('folder') || null;
}

// The folder a code-server URL points at, or null when it is not one of ours.
function folderFromUrl(url, ports) {
  const folder = serverFolderFromUrl(url, ports);
  return folder && path.resolve(folder.replace(/^\/([a-zA-Z]:)/, '$1'));
}

// The address a link that code-server sent through its own proxy stands for, or null for any
// other URL. `page` is the URL of the tab that opens the link. VS Code assumes the browser may be on
// another machine than the server, so it turns a link to localhost:<port> (the address a dev
// server prints in the terminal, or "Open in Browser" when it notices a port) into one through
// code-server's proxy: <the page's origin>/proxy/<port>/<path>. That wants code-server's login,
// which the default browser does not have, and strips the start of the path. Here the browser is
// on the same machine, so the link goes back to the port itself, as it read. A tab in WSL reaches
// the distribution's localhost through WSL's forwarding, as the app reaches its code-server.
// code-server's template for the proxy (VSCODE_PROXY_URI) cannot be the port itself instead: its
// page reads the template as a URL, and {{port}} where the port goes is not one.
function unproxiedUrl(url, page) {
  let link;
  let origin;
  try {
    link = new URL(url);
    origin = new URL(page).origin;
  } catch {
    return null;
  }
  const proxied = link.origin === origin && /^\/proxy\/(\d+)(\/.*)?$/.exec(link.pathname);
  return proxied ? `http://localhost:${proxied[1]}${proxied[2] || '/'}${link.search}${link.hash}` : null;
}

// Settings every instance starts with; the user can change them in VS Code.
const DEFAULT_SETTINGS = {
  'workbench.startupEditor': 'none',
  'security.workspace.trust.enabled': false,
  // The built-in Copilot chat is not used here (agents come from extensions such as Claude
  // Code); turning it off hides its panel and saves memory in every instance.
  'chat.disableAIFeatures': true,
  // Follow the OS light/dark theme, like the tab bar does.
  'window.autoDetectColorScheme': true,
  // Keep the tested extension version until it is updated on purpose.
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'telemetry.telemetryLevel': 'off',
};

// Access to the files of the instances: those on this machine. The instances in WSL have theirs
// in the distribution, read and written through its agent (code-server-wsl.js).
const localFiles = {
  join: path.join,
  async read(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  async write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  },
  async chmod(file, mode) {
    fs.chmodSync(file, mode);
  },
  async remove(file) {
    fs.rmSync(file, { force: true });
  },
  // The files (not folders) in a folder; none when it does not exist.
  async list(dir) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  },
  async mtime(file) {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  },
  // Watches folders (creating them): onChange(folder, name) for each change in one. Resolves a
  // function that stops it.
  async watch(folders, onChange) {
    const watchers = folders.map((folder) => {
      fs.mkdirSync(folder, { recursive: true });
      const watcher = fs.watch(folder, (_event, name) => onChange(folder, name ? String(name) : ''));
      // The folder went away (the worktree was removed): nothing more to watch there.
      watcher.on('error', () => {});
      return watcher;
    });
    return () => {
      for (const watcher of watchers) watcher.close();
    };
  },
};

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Writes the settings the instance's VS Code starts with. For a tab in a git repository,
// `shareSettings({ files, userDir, managed })` brings its User folder to the settings that the
// repository's worktrees share (settings-sync.js), and resolves a handle whose stop() ends the
// sharing when the instance stops. Otherwise the instance has settings of its own, the defaults
// filled in. Some extension settings are machine-scoped, so the managed ones go into both files.
// `userDir(tabId)` is where an instance's User folder is.
async function writeSettings({ files, userDataDir, userDir, managed, shareSettings }) {
  await mergeSettings(files, files.join(userDataDir, 'Machine', 'settings.json'), {}, managed);
  if (shareSettings) return shareSettings({ files, userDir, managed });
  await mergeSettings(files, files.join(userDataDir, 'User', 'settings.json'), DEFAULT_SETTINGS, managed);
  return null;
}

// code-server translates its UI with the language packs listed in <user-data-dir>/languagepacks.json,
// which only an install from inside VS Code writes. The app installs extensions through the CLI
// into the shared folder, so it writes the file for each instance the way VS Code would.
async function writeLanguagePacks(files, userDataDir, extensionsDir) {
  let installed;
  try { installed = await readExtensionIndex(files, extensionsDir); }
  catch (error) {
    if (error instanceof SyntaxError || error.code === 'INVALID_EXTENSION_INDEX') return;
    throw error;
  }
  if (!installed.available) return;
  const packs = {};
  for (const extension of installed.entries) {
    if (!extension.id || !extension.validLocation) continue;
    const location = files.join(extensionsDir, extension.relativeLocation);
    const manifest = parseJson(await files.read(files.join(location, 'package.json')));
    if (!manifest) continue;
    for (const localization of manifest.contributes?.localizations || []) {
      const pack = (packs[localization.languageId] ||= {
        hash: '',
        extensions: [],
        translations: {},
        label: localization.localizedLanguageName ?? localization.languageName,
      });
      pack.extensions.push({ extensionIdentifier: extension.identifier, version: manifest.version });
      for (const translation of localization.translations || []) {
        pack.translations[translation.id] = files.join(location, translation.path);
      }
    }
  }
  // The hash names the folder of generated translations, so it changes with the pack version.
  for (const pack of Object.values(packs)) {
    const hash = crypto.createHash('md5');
    for (const { extensionIdentifier, version } of pack.extensions) hash.update(extensionIdentifier.id).update(version);
    pack.hash = hash.digest('hex');
  }
  await files.write(files.join(userDataDir, 'languagepacks.json'), JSON.stringify(packs));
}

// Cookie suffixes keep instances apart because browser cookies are not separated by port.
function launchAuthentication(tabId) {
  const sessionKey = crypto.randomBytes(32).toString('hex');
  return { sessionKey, cookie: { name: `code-server-session-${tabId}`, value: sessionKey } };
}
function launchArgs({ baseArgs, port, tabId, locale, folder }) {
  return [...baseArgs, '--bind-addr', `127.0.0.1:${port}`, '--auth', 'password',
    '--cookie-suffix', tabId, '--ignore-last-opened', '--disable-telemetry',
    '--disable-update-check', ...(locale ? ['--locale', locale] : []), folder];
}
async function prepareLaunch({ files, extensionsDir, userDataDir, userDir, managed = {},
  shareSettings, wrapperOptions, prepare = prepareCodex }) {
  const wrapper = Object.hasOwn(managed, 'chatgpt.openOnStartup')
    ? await prepare({ files, extensionsDir, dir: files.join(userDataDir, 'codex'), ...wrapperOptions }) : null;
  await writeLanguagePacks(files, userDataDir, extensionsDir);
  return writeSettings({ files, userDataDir, userDir, shareSettings,
    managed: { ...managed, 'chatgpt.cliExecutable': wrapper || undefined } });
}
/** @param {{ spawn?: typeof import('child_process').spawn, kill?: (pid: number) => void, [key: string]: any }} [overrides] */
function launchRuntime(overrides = {}) {
  return { pickPort, health: httpStatus, now: () => Date.now(), sleep,
    authentication: launchAuthentication, prepare: prepareLaunch, timeout: 60000, ...overrides };
}
// The settings handle belongs to one start, even when error, exit, and stop all race to release it.
function stopSettings(instance) {
  if (!instance || instance.settingsStopped) return;
  instance.settingsStopped = true;
  instance.shared?.stop();
}
async function waitReady({ port, error, current, runtime }) {
  const deadline = runtime.now() + runtime.timeout;
  const check = () => {
    const failed = error();
    if (failed) throw failed;
    if (!current()) throw new Error(t('code-server was stopped while starting'));
  };
  while (runtime.now() < deadline) {
    check();
    const status = await runtime.health(`http://127.0.0.1:${port}/healthz`);
    check(); // A stop or exit during the health request cannot complete a canceled start.
    if (status === 200) return;
    await runtime.sleep(300);
  }
  throw new Error(t('code-server did not start within 60 seconds'));
}
module.exports = { cleanEnv, firstErrorLine, SYSTEM_CA_ENV, DEFAULT_SETTINGS, folderUrl, folderFromUrl, httpStatus, localFiles, pickPort,
  serverFolderFromUrl, serverFolderUrl, unproxiedUrl, writeLanguagePacks, writeSettings,
  launchAuthentication, launchArgs, prepareLaunch, launchRuntime, stopSettings, waitReady };
