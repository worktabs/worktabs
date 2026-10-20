// Starts and stops the code-server instances of the tabs whose folders are in one WSL
// distribution, the way VS Code's WSL extension runs its server: only the window stays on
// Windows. The Linux build of code-server runs in the distribution with an extensions folder of
// its own (the extensions need their Linux builds), so the terminal, git, tasks, language
// servers and the claude that the Claude Code extension starts all run there. code-server starts
// without the shell's start-up files; like VS Code's server, it resolves the user's shell
// environment for its extension host itself.
//
// The work in the distribution goes through its agent (wsl-agent.js), which the app writes into
// ~/.worktabs/bin and runs with code-server's node. The agent also takes the hooks, which cannot
// reach the app's endpoint on Windows.
const { InstanceManager } = require('./code-server-instances');
const { parseExtensionIndex } = require('./extension-index');
const fs = require('fs');
const path = require('path');
const {
  firstErrorLine, SYSTEM_CA_ENV,
  serverFolderFromUrl,
  serverFolderUrl,
  launchArgs, launchRuntime, waitReady,
} = require('./code-server-launch');
const { hookSettings } = require('../conversations/hooks');
const { t } = require('../i18n');
const { parseWslPath, shellQuote, windowsPath, wslDistro } = require('../wsl/wsl');

// `uname -m` -> the architecture in code-server's release names.
const ARCHS = { x86_64: 'amd64', aarch64: 'arm64' };
const AGENT_SOURCE = path.join(__dirname, '..', 'wsl', 'wsl-agent.js');
const WRAP_SOURCE = path.join(__dirname, '..', 'wsl', 'wsl-claude-wrap.sh');

// The id and version of a VSIX named <id>-<version>.vsix, as build-native.js names them.
function vsixIdentity(file) {
  const match = /^(.+)-(\d+\.\d+\.\d+.*)\.vsix$/i.exec(file.split(/[\\/]/).pop());
  return match ? { id: match[1].toLowerCase(), version: match[2] } : null;
}

// The extensions an extensions.json lists: lowercase id -> version.
function installedVersions(text) {
  try { return parseExtensionIndex(text).versions; } catch { return new Map(); }
}

// What went wrong in a failed command: its first error line, else its first line.
function firstError(error) {
  return firstErrorLine(error.stderr, error.message);
}

class WslCodeServerManager extends InstanceManager {
  // options: distro (its name), dataDir (the app's, on Windows: downloads and logs), version()
  // (the code-server version the tabs run), customDir ('' or an extracted Linux release in the
  // distribution, used instead of downloading one), download({ version, name, onProgress })
  // (resolves the archive's path on Windows), extensions (ids, and VSIX files on Windows),
  // windowsExtensionsDir (the extension versions to install: those the Windows tabs have),
  // hooks (the HookServer), locale, managedSettings (as for CodeServerManager, without the
  // claude wrapper, which is this distribution's)
  /**
   * @param {{ distro: string, dataDir: string, version?: () => string, customDir?: string,
   *   download?: (options: { version: string, name: string, onProgress: (mb: number, totalMb: number) => void }) => Promise<string>,
   *   extensions?: string[], extensionSpecs?: (target: string) => string[], unpinnedExtensions?: string[],
   *   restrictExtensionGallery?: boolean, windowsExtensionsDir?: string, hooks: { token: string },
   *   locale?: string, managedSettings?: Record<string, any>, runtime?: object, wsl?: any }} options
   */
  constructor(options) {
    super();
    this.distro = options.distro;
    this.dataDir = options.dataDir;
    this.version = options.version;
    this.customDir = options.customDir;
    this.download = options.download;
    this.extensions = options.extensions;
    this.extensionSpecs = options.extensionSpecs;
    this.unpinnedExtensions = options.unpinnedExtensions;
    this.restrictExtensionGallery = options.restrictExtensionGallery;
    this.windowsExtensionsDir = options.windowsExtensionsDir;
    this.hooks = options.hooks;
    this.locale = options.locale;
    this.managedSettings = options.managedSettings;
    this.runtime = launchRuntime(options.runtime);
    this.wsl = options.wsl || wslDistro(this.distro);
    this.seq = 0;
    this.home = null; // the distribution's $HOME, once read
    this.codeServerDir = null; // the code-server the tabs start on, once prepared
    this.preparing = null;
    // The instances' files, as code-server.js's localFiles has them on Windows.
    this.files = {
      join: path.posix.join,
      read: (file) => this.wsl.readFile(file),
      write: (file, text) => this.wsl.writeFile(file, text),
      chmod: (file, mode) => this.wsl.exec('chmod', [mode.toString(8), file]),
      remove: (file) => this.wsl.removeFile(file),
      list: (dir) => this.wsl.listFiles(dir),
      mtime: (file) => this.wsl.mtime(file),
      watch: (folders, onChange) => this.wsl.watch(folders, onChange),
    };
    this.wsl.on('instance-exit', (key, code) => this.onExit(key, code));
    this.wsl.on('agent-exit', () => {
      for (const instance of [...this.instances.values()]) this.onExit(instance.key, t('The WSL agent ended'));
    });
    this.wsl.on('output', (key, text) => {
      const [tabId, instance] = this.byKey(key);
      if (!tabId) return;
      instance.output = (instance.output + text).slice(-4000);
      fs.appendFile(this.logFile(tabId), text, () => {});
    });
    this.wsl.on('request', (route, tabId, pid, raw) => this.emit('request', route, tabId, pid ? this.procId(pid) : null, raw));
    this.wsl.on('proc-exit', (pid) => this.emit('proc-exit', this.procId(pid)));
  }

  get base() {
    return `${this.home}/.worktabs`;
  }

  get extensionsDir() {
    return `${this.base}/extensions`;
  }

  get hookSettingsFile() {
    return `${this.base}/hook-settings.json`;
  }

  get nodeExe() {
    return `${this.codeServerDir}/lib/node`;
  }

  // A claude process in this distribution, as the SessionTracker names it: its pid alone
  // could be a process of Windows or of another distribution.
  procId(pid) {
    return `wsl:${this.distro}:${pid}`;
  }

  logFile(tabId) {
    return path.join(this.dataDir, 'logs', `code-server-${tabId}.log`);
  }

  byKey(key) {
    return [...this.instances].find(([, instance]) => instance.key === key) || [];
  }

  // The code-server the tabs are to start on: the configured one, else the app's release.
  wantedDir() {
    return this.customDir || `${this.base}/code-server/code-server-${this.version()}-linux-${this.arch}`;
  }

  // Whether the agent runs and the tabs can start on the wanted code-server.
  ready() {
    return Boolean(this.home && this.wsl.agent && this.codeServerDir === this.wantedDir());
  }

  exists(file) {
    return this.wsl.exec('test', ['-e', file]).then(() => true, () => false);
  }

  // Gets the distribution ready for the tabs: code-server there (downloaded first when
  // `install`; without it, resolves false when code-server is missing), the agent running, and
  // the claude wrapper and the hook settings written. onProgress(text) tells what takes long.
  /** @param {{ install?: boolean, onProgress?: (text: string) => void }} [options] */
  async prepare({ install = true, onProgress = () => {} } = {}) {
    while (this.preparing) await this.preparing.catch(() => {});
    if (this.ready()) return true;
    this.preparing = this.doPrepare(install, onProgress);
    try {
      return await this.preparing;
    } finally {
      this.preparing = null;
    }
  }

  async doPrepare(install, onProgress) {
    if (!this.home) {
      let out;
      try {
        // The first command starts the distribution, which takes a few seconds when it was stopped.
        out = await this.wsl.execDirect('sh', ['-c', 'printf "%s\\n%s\\n" "$HOME" "$(uname -m)"'], { timeout: 60000 });
      } catch (error) {
        throw new Error(t('Could not start WSL {distro}: {error}', { distro: this.distro, error: firstError(error) }), { cause: error });
      }
      const [home, machine] = out.split('\n');
      if (!ARCHS[machine]) throw new Error(t('There is no code-server for WSL {distro} ({machine})', { distro: this.distro, machine }));
      this.home = home;
      this.arch = ARCHS[machine];
    }
    const dir = this.wantedDir();
    if (!(await this.exists(`${dir}/lib/node`))) {
      if (this.customDir) throw new Error(t('code-server is not found in WSL {distro}: {dir} (wslCodeServerDir)', { distro: this.distro, dir }));
      if (!install) return false;
      await this.installCodeServer(onProgress);
    }
    const node = `${dir}/lib/node`;
    // The agent runs on the node of the code-server in use; one on an older release is replaced
    // once nothing runs on it.
    if (this.wsl.agent && this.wsl.agent.node !== node && !this.instances.size) await this.wsl.stopAgent();
    if (!this.wsl.agent) await this.startAgent(node);
    // code-server's command for its terminals (and the extension host's programs, such as
    // claude) opens files and folders in the window it runs in, but is named code-server; `code`
    // would find the Windows VS Code at the end of PATH instead. VS Code's server names it code.
    const cli = `${dir}/lib/vscode/bin/remote-cli`;
    await this.wsl.exec('sh', ['-c', '[ -e "$1/code" ] || ln -s code-server "$1/code"', 'sh', cli]).catch(() => {});
    this.codeServerDir = dir;
    if (!this.customDir && this.wsl.agent.node === node) {
      const root = `${this.base}/code-server`;
      await this.wsl.exec('sh', ['-c', 'for d in "$1"/code-server-*-linux-*; do [ "$d" = "$2" ] || rm -rf "$d"; done', 'sh', root, dir]).catch(() => {});
    }
    return true;
  }

  // Downloads the Linux release on Windows, where the system's proxy settings apply, and
  // extracts it in the distribution.
  async installCodeServer(onProgress) {
    const version = this.version();
    const name = `code-server-${version}-linux-${this.arch}`;
    let shown = 0;
    const archive = await this.download({
      version,
      name,
      onProgress: (mb, totalMb) => {
        if (Date.now() - shown < 1000) return;
        shown = Date.now();
        const of = totalMb ? ` / ${totalMb.toFixed(0)} MB` : ' MB';
        onProgress(t('Downloading code-server {version} for WSL… {progress}', { version, progress: `${mb.toFixed(0)}${of}` }));
      },
    });
    onProgress(t('Extracting code-server {version} in WSL {distro}…', { version, distro: this.distro }));
    // Extracted beside its place first, so a release cut short never looks installed.
    const script = 'set -e; mkdir -p "$1"; tmp=$(mktemp -d "$1/.extract-XXXXXX"); trap \'rm -rf "$tmp"\' EXIT; tar -xzf - -C "$tmp"; [ -e "$1/$2" ] || mv "$tmp/$2" "$1/$2"';
    try {
      await this.wsl.execDirect('sh', ['-c', script, 'sh', `${this.base}/code-server`, name], {
        input: fs.createReadStream(archive),
        timeout: 10 * 60 * 1000,
      });
    } catch (error) {
      throw new Error(t('Could not extract code-server in WSL: {error}', { error: firstError(error) }), { cause: error });
    }
    fs.rmSync(archive, { force: true });
  }

  async startAgent(node) {
    const agentFile = `${this.base}/bin/wsl-agent.js`;
    await this.wsl.writeDirect(agentFile, fs.readFileSync(AGENT_SOURCE));
    const hookPort = await this.wsl.startAgent(node, agentFile, this.hooks.token);
    await this.wsl.writeFile(`${this.base}/bin/claude-wrap`, fs.readFileSync(WRAP_SOURCE), 0o755);
    this.hookUrl = `http://127.0.0.1:${hookPort}/hook`;
    const settings = hookSettings(this.hookUrl, `${shellQuote(node)} ${shellQuote(agentFile)} hook`);
    await this.wsl.writeFile(this.hookSettingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  }

  // Installs in the distribution the extensions the Windows tabs have, at their versions (the
  // tested ones, or those an update brought): each one missing, and each at another version
  // with `force` (an update) or while no tab runs here. Installing marks the version it replaces
  // obsolete, and the next code-server that serves a page deletes it, even while another tab
  // still runs it. The helper extension goes in at the app's version.
  async syncExtensions({ force = false } = {}) {
    let windowsList = null;
    try {
      windowsList = fs.readFileSync(path.join(this.windowsExtensionsDir, 'extensions.json'), 'utf8');
    } catch {
      // Nothing installed on Windows yet: the latest versions.
    }
    const wanted = installedVersions(windowsList);
    const have = installedVersions(await this.wsl.readFile(`${this.extensionsDir}/extensions.json`));
    const replace = force || !this.instances.size;
    const extensions = this.extensionSpecs ? this.extensionSpecs(`linux-${this.arch === 'arm64' ? 'arm64' : 'x64'}`) : this.extensions;
    for (const extension of extensions) {
      const vsix = extension.toLowerCase().endsWith('.vsix') ? vsixIdentity(extension) : null;
      if (vsix) {
        if (have.get(vsix.id) === vsix.version) continue;
        if (have.has(vsix.id) && !replace) continue;
        const copy = `${this.base}/vsix/${path.basename(extension)}`;
        await this.wsl.writeFile(copy, fs.readFileSync(extension));
        await this.installExtension(copy);
        continue;
      }
      const version = this.unpinnedExtensions?.includes(extension.toLowerCase()) ? null : wanted.get(extension.toLowerCase());
      const current = have.get(extension.toLowerCase());
      if (current && ((!version && !force) || (version && current === version) || !replace)) continue;
      await this.installExtension(version ? `${extension}@${version}` : extension);
    }
  }

  // Installs an extension into the distribution's extensions folder: an id, <id>@<version>, or
  // the path of a VSIX in the distribution. With the user's shell environment, which may set a
  // proxy, and with Node trusting the distribution's CA store (cleanEnv in code-server-launch.js).
  async installExtension(extension) {
    const args = [
      ...Object.entries(SYSTEM_CA_ENV).map(([key, value]) => `${key}=${value}`),
      this.nodeExe,
      this.codeServerDir,
      '--config', `${this.base}/code-server.yaml`,
      '--user-data-dir', `${this.base}/install`,
      '--extensions-dir', this.extensionsDir,
      '--install-extension', extension,
      '--force',
    ];
    try {
      await this.wsl.exec('env', args, { timeout: 5 * 60 * 1000, shellEnv: true });
    } catch (error) {
      throw new Error(`${path.posix.basename(extension)}: ${firstError(error)}`, { cause: error });
    }
  }

  // Brings the distribution to what an update installed on Windows: the code-server release and
  // the extension versions. Only for a distribution in use in this run.
  async applyUpdate(onProgress) {
    if (!this.home) return;
    await this.prepare({ install: true, onProgress });
    await this.syncExtensions({ force: true });
  }

  userDataDir(tabId) {
    return `${this.base}/instances/${tabId}`;
  }

  // As CodeServerManager.start, for a folder in this distribution (its UNC path).
  // onProgress(text) tells what takes long: downloading code-server, installing extensions.
  // `owner` follows the start through a port retry and back with its exit event.
  /**
   * @param {string} tabId
   * @param {string} folder
   * @param {number} [preferredPort]
   * @param {{ onProgress?: (text: string) => void, shareSettings?: Function, avoid?: Set<number>, owner?: any }} [options]
   */
  async start(tabId, folder, preferredPort = 0, { onProgress = () => {}, shareSettings = null, avoid = new Set(), owner = null } = {}) {
    this.stop(tabId);
    const linuxFolder = parseWslPath(folder).path;
    if (!this.ready()) onProgress(t('Preparing WSL {distro}…', { distro: this.distro }));
    await this.prepare({ install: true, onProgress });
    onProgress(t('Checking the extensions…'));
    await this.syncExtensions();
    try {
      return await this.launch(tabId, linuxFolder, preferredPort, shareSettings, avoid, owner);
    } catch (error) {
      // The port was free on Windows but taken in the distribution.
      if (!preferredPort || !error.portTaken) throw error;
      return this.launch(tabId, linuxFolder, 0, shareSettings, new Set([...avoid, preferredPort]), owner);
    }
  }

  async launch(tabId, linuxFolder, preferredPort, shareSettings, avoid, owner) {
    const port = await this.runtime.pickPort(preferredPort, avoid);
    const userDataDir = this.userDataDir(tabId);
    const shared = await this.runtime.prepare({
      files: this.files, extensionsDir: this.extensionsDir, userDataDir,
      userDir: (id) => `${this.userDataDir(id)}/User`,
      managed: { ...this.managedSettings, 'claudeCode.claudeProcessWrapper': `${this.base}/bin/claude-wrap` },
      shareSettings,
      wrapperOptions: { node: this.nodeExe, platform: 'linux', arch: this.arch === 'amd64' ? 'x64' : 'arm64' },
    });
    const instance = { key: `${tabId}:${++this.seq}`, port, started: false, stopping: false, output: '', shared, owner };
    this.instances.set(tabId, instance);
    try {
      const { sessionKey, cookie } = this.runtime.authentication(tabId);
      fs.mkdirSync(path.dirname(this.logFile(tabId)), { recursive: true });
      fs.appendFileSync(this.logFile(tabId), `--- ${new Date().toISOString()} WSL ${this.distro} ${linuxFolder}\n`);
      await this.wsl.request({ op: 'start', name: instance.key, command: this.nodeExe,
        args: launchArgs({ baseArgs: [this.codeServerDir, '--config', `${this.base}/code-server.yaml`,
          '--user-data-dir', userDataDir, '--extensions-dir', this.extensionsDir], port, tabId, locale: this.locale, folder: linuxFolder }),
        env: {
          WORKTABS_TAB_ID: tabId, WORKTABS_HOOK_URL: this.hookUrl, WORKTABS_HOOK_TOKEN: this.hooks.token,
          WORKTABS_CLAUDE_SETTINGS: this.hookSettingsFile, HASHED_PASSWORD: sessionKey, ...SYSTEM_CA_ENV,
          ...(this.restrictExtensionGallery ? { EXTENSIONS_GALLERY: '{}' } : {}),
        },
      });
      // Windows reaches the distribution through WSL's localhost forwarding.
      await waitReady({ port, runtime: this.runtime, current: () => this.isCurrent(tabId, instance),
        error: () => {
          if (instance.exit === undefined) return null;
          return Object.assign(new Error(t('code-server ended ({reason})', { reason: instance.exit })),
            { portTaken: /EADDRINUSE/.test(instance.output) });
        } });
      instance.started = true;
      return { port, cookie };
    } catch (error) {
      this.stop(tabId, instance);
      throw error;
    }
  }

  onExit(key, code) {
    const [tabId, instance] = this.byKey(key);
    if (!tabId) return;
    instance.exit = code;
    this.instanceEnded(tabId, instance, code);
  }

  // Ends the instance and everything under it (InstanceManager.stop): the agent stops it in the
  // distribution, unless it has ended already.
  endInstance(instance) {
    if (instance.exit === undefined) this.wsl.request({ op: 'stop', name: instance.key }).catch(() => {});
  }

  // Stops every instance, and the agent, which stops whatever it still runs.
  stopAll() {
    super.stopAll();
    this.wsl.stopAgent();
  }

  folderUrl(port, folder) {
    return serverFolderUrl(port, parseWslPath(folder).path);
  }

  folderFromUrl(url) {
    const folder = serverFolderFromUrl(url, this.ports());
    return folder && folder.startsWith('/') ? windowsPath(this.distro, folder) : null;
  }

  removeInstanceData(tabId) {
    if (this.home) this.wsl.exec('rm', ['-rf', '--', this.userDataDir(tabId)]).catch(() => {});
  }
}

module.exports = { WslCodeServerManager, installedVersions, vsixIdentity };
