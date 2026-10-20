// Starts and stops one code-server process per tab.
const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');
const { cleanEnv, firstErrorLine, DEFAULT_SETTINGS, folderUrl, folderFromUrl, httpStatus, localFiles, pickPort,
  serverFolderFromUrl, serverFolderUrl, unproxiedUrl, writeLanguagePacks, writeSettings,
  launchArgs, launchRuntime, stopSettings, waitReady } = require('./code-server-launch');
const { InstanceManager } = require('./code-server-instances');
const { readExtensionIndexSync } = require('./extension-index');

// The node binary of an extracted code-server release, which every instance runs and which
// says whether the release is there at all.
function serverNode(dir, platform = process.platform) {
  return path.join(dir, 'lib', platform === 'win32' ? 'node.exe' : 'node');
}

function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

class CodeServerManager extends InstanceManager {
  // options: codeServerDir, extensionsDir, dataDir, env (extra environment for every
  // instance), managedSettings (claudeCode.* settings forced into every instance), locale
  // (VS Code display language; '' leaves it to code-server)
  /**
   * @param {{ codeServerDir?: string, extensionsDir: string, dataDir: string, env?: Record<string, string>,
   *   managedSettings?: Record<string, any>, locale?: string, codexLauncher?: string, runtime?: object }} options
   */
  constructor(options) {
    super();
    this.codeServerDir = options.codeServerDir;
    this.extensionsDir = options.extensionsDir;
    this.dataDir = options.dataDir;
    this.env = options.env;
    this.managedSettings = options.managedSettings;
    this.locale = options.locale;
    this.codexLauncher = options.codexLauncher;
    this.runtime = launchRuntime({ spawn, kill: killTree, ...options.runtime });
    fs.mkdirSync(path.join(this.dataDir, 'logs'), { recursive: true });
  }

  get nodeExe() {
    return serverNode(this.codeServerDir);
  }

  // A human-readable problem with the code-server install, or null.
  checkInstall() {
    if (!fs.existsSync(this.nodeExe)) return t('code-server is not found: {path}', { path: this.nodeExe });
    return null;
  }

  baseArgs(userDataDir) {
    return [
      this.codeServerDir,
      '--config', path.join(this.dataDir, 'code-server.yaml'),
      '--user-data-dir', userDataDir,
      '--extensions-dir', this.extensionsDir,
    ];
  }

  // Installs each extension that is not in extensionsDir yet: an id (from Open VSX), or the path
  // of an <id>-<version>.vsix, which installs to a folder of the same name.
  async ensureExtensions(extensions) {
    fs.mkdirSync(this.extensionsDir, { recursive: true });
    const installed = readExtensionIndexSync(this.extensionsDir).entries;
    for (const extension of extensions) {
      const isVsix = extension.toLowerCase().endsWith('.vsix');
      const match = isVsix && /^(.+)-(\d+\.\d+\.\d+.*)\.vsix$/i.exec(path.basename(extension));
      const present = isVsix
        ? match && installed.some((item) => item.id === match[1].toLowerCase() && item.version === match[2])
        : installed.some((item) => item.id === extension.toLowerCase());
      if (!present) await this.installExtension(extension);
    }
  }

  // Installs an extension into extensionsDir: an id, <id>@<version> (also to go back to an
  // older version), or a VSIX path. A version it replaces is marked obsolete, and the next
  // code-server that serves a page deletes its folder.
  /** @returns {Promise<void>} */
  installExtension(extension) {
    const name = extension.toLowerCase().endsWith('.vsix') ? path.basename(extension) : extension;
    return new Promise((resolve, reject) => {
      execFile(
        this.nodeExe,
        [...this.baseArgs(path.join(this.dataDir, 'install')), '--install-extension', extension, '--force'],
        { env: cleanEnv({ EXTENSIONS_GALLERY: undefined }), windowsHide: true, timeout: 5 * 60 * 1000 },
        (error, _stdout, stderr) => {
          if (!error) return resolve();
          reject(new Error(`${name}: ${firstErrorLine(stderr, error.message)}`));
        },
      );
    });
  }

  /** @returns {Promise<void>} */
  uninstallExtension(id) {
    return new Promise((resolve, reject) => execFile(this.nodeExe,
      [...this.baseArgs(path.join(this.dataDir, 'install')), '--uninstall-extension', id],
      { env: cleanEnv({ EXTENSIONS_GALLERY: undefined }), windowsHide: true, timeout: 5 * 60 * 1000 },
      (error) => error ? reject(error) : resolve()));
  }

  // Extension activations in the extension host log of the instance's start at or after
  // `since` (ms): { activated: Set, failed: Set } of lowercase extension ids.
  extensionActivation(tabId, since) {
    const result = { activated: new Set(), failed: new Set() };
    const logs = path.join(this.dataDir, 'instances', tabId, 'logs');
    let latest;
    try {
      // One folder per start, named by its local time (20260927T222921).
      latest = fs.readdirSync(logs).sort().pop();
      if (!latest || fs.statSync(path.join(logs, latest)).mtimeMs < since - 1000) return result;
    } catch {
      return result;
    }
    for (const dir of fs.readdirSync(path.join(logs, latest)).filter((d) => d.startsWith('exthost'))) {
      let text;
      try {
        text = fs.readFileSync(path.join(logs, latest, dir, 'remoteexthost.log'), 'utf8');
      } catch {
        continue;
      }
      for (const [, id] of text.matchAll(/_doActivateExtension ([\w.-]+)/g)) result.activated.add(id.toLowerCase());
      for (const [, id] of text.matchAll(/Activating extension '?([\w.-]+?)'? failed/g)) result.failed.add(id.toLowerCase());
    }
    return result;
  }

  userDataDir(tabId) {
    return path.join(this.dataDir, 'instances', tabId);
  }

  // `preferredPort` should be the port this tab used before: VS Code web keeps its workbench
  // state (open editors, including Claude conversation tabs) in browser storage per origin,
  // so a new port starts from an empty workbench. `avoid`: the ports other tabs keep, which a
  // new port must not be (tab-ports.js). `shareSettings`: see writeSettings. `owner` is returned
  // with exit events so the tab lifecycle can ignore events from an earlier start of this ID.
  async start(tabId, folder, preferredPort = 0, { shareSettings = null, avoid = new Set(), owner = null } = {}) {
    this.stop(tabId);
    const port = await this.runtime.pickPort(preferredPort, avoid);
    const userDataDir = this.userDataDir(tabId);
    const shared = await this.runtime.prepare({
      files: localFiles, extensionsDir: this.extensionsDir, userDataDir,
      userDir: (id) => path.join(this.userDataDir(id), 'User'),
      managed: this.managedSettings, shareSettings,
      wrapperOptions: { node: this.nodeExe, nativeLauncher: this.codexLauncher },
    });
    let instance;
    try {
      const { sessionKey, cookie } = this.runtime.authentication(tabId);
      const log = fs.openSync(path.join(this.dataDir, 'logs', `code-server-${tabId}.log`), 'a');
      let proc;
      try {
        proc = this.runtime.spawn(this.nodeExe, launchArgs({ baseArgs: this.baseArgs(userDataDir), port, tabId, locale: this.locale, folder }), {
          env: cleanEnv({ ...this.env, WORKTABS_TAB_ID: tabId, HASHED_PASSWORD: sessionKey }),
          stdio: ['ignore', log, log], windowsHide: true, detached: process.platform !== 'win32',
        });
      } finally { fs.closeSync(log); }
      instance = { proc, port, started: false, stopping: false, shared, owner };
      this.instances.set(tabId, instance);
      proc.on('exit', (code) => this.instanceEnded(tabId, instance, code));
      proc.on('error', (error) => {
        instance.error = error;
        this.instanceFailed(tabId, instance);
      });
      await waitReady({ port, runtime: this.runtime, current: () => this.isCurrent(tabId, instance),
        error: () => instance.error ? new Error(t('Could not start code-server: {error}', { error: instance.error.message }))
          : proc.exitCode !== null ? new Error(t('code-server ended (code {code})', { code: proc.exitCode })) : null });
      instance.started = true;
      return { port, cookie };
    } catch (error) {
      if (instance) this.stop(tabId, instance);
      else stopSettings({ shared });
      throw error;
    }
  }

  // Ends the instance's process tree (InstanceManager.stop): stopping only the node process would
  // leave its children (extension host, claude processes) running on Windows.
  endInstance(instance) {
    if (instance.proc.pid && instance.proc.exitCode === null) this.runtime.kill(instance.proc.pid);
  }

  folderUrl(port, folder) {
    return folderUrl(port, folder);
  }

  // The folder that a URL of one of this manager's instances points at, or null.
  folderFromUrl(url) {
    return folderFromUrl(url, this.ports());
  }

  // Deletes what the tab's VS Code kept (open editors, Claude tabs), when its folder is gone.
  // The settings it shared stay with its repository.
  removeInstanceData(tabId) {
    fs.rm(this.userDataDir(tabId), { recursive: true, force: true, maxRetries: 5 }, () => {});
  }
}

module.exports = {
  CodeServerManager,
  DEFAULT_SETTINGS,
  folderUrl,
  httpStatus,
  localFiles,
  pickPort,
  serverFolderFromUrl,
  serverFolderUrl,
  serverNode,
  unproxiedUrl,
  writeLanguagePacks,
  writeSettings,
};
