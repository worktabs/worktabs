// Read the active extension index for each launch. Old version folders can remain after an
// update or restore, so directory names and previously resolved paths are not authoritative.
const fs = require('fs');
const path = require('path');
const { AGENTS } = require('./agents');
const { readExtensionIndex } = require('../code-server/extension-index');
const { t } = require('../i18n');
const { gitMessage } = require('../commands');
const { parseWslPath, wslDistro } = require('../wsl/wsl');

const PLATFORMS = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const ARCHS = { x64: 'x86_64', arm64: 'aarch64' };

function setupMessage(agent, folder) {
  const wsl = parseWslPath(folder);
  if (wsl) {
    return agent === 'codex'
      ? t('The Codex extension or its executable is missing or incompatible in WSL {distro}. Enable Codex in Settings and open a tab in that distribution to install it from Open VSX, or import a matching Linux Codex extension in Settings > Extensions.', { distro: wsl.distro })
      : t('The Claude Code extension or its executable is missing or incompatible in WSL {distro}. Enable Claude in Settings and open a tab in that distribution to install it, or import a matching Linux extension in Settings > Extensions.', { distro: wsl.distro });
  }
  return agent === 'codex'
    ? t('The Codex extension or its executable is missing or incompatible. Enable Codex in Settings to install it from Open VSX, or press Use Open VSX or import Codex in Settings > Extensions.')
    : t('The Claude Code extension or its executable is missing or incompatible. Enable Claude in Settings and open a tab to install it, or reinstall it through Settings > Extensions.');
}

function setupError(agent, folder) {
  return Object.assign(new Error(setupMessage(agent, folder)), { code: 'AGENT_CLI_SETUP' });
}

// Both chat's Codex proxy and branch suggestions use this selection. Claude's native binary
// is at a fixed location inside a platform-specific extension payload.
/**
 * @param {{ files: AgentCliFiles, extensionsDir: string, agent: string, platform?: string, arch?: string }} options
 * @returns {Promise<string | null>}
 */
async function extensionBinary({ files, extensionsDir, agent, platform = process.platform, arch = process.arch }) {
  let installed;
  try { installed = await readExtensionIndex(files, extensionsDir); } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'INVALID_EXTENSION_INDEX'].includes(error.code)) return null;
    throw error;
  }
  const extension = installed.entries.find((entry) => entry.id === AGENTS[agent].extension.toLowerCase());
  if (!extension?.validLocation || !PLATFORMS[platform] || !ARCHS[arch]) return null;
  const location = extension.relativeLocation;
  const target = extension.targetPlatform;
  if (target && target !== 'undefined' && target !== 'universal' && target !== `${platform}-${arch}` && !(platform === 'darwin' && target === 'darwin-universal')) return null;
  return agent === 'codex'
    ? files.join(extensionsDir, location, 'bin', `${PLATFORMS[platform]}-${ARCHS[arch]}`, platform === 'win32' ? 'codex.exe' : 'codex')
    : files.join(extensionsDir, location, 'resources', 'native-binary', platform === 'win32' ? 'claude.exe' : 'claude');
}

const localFiles = {
  join: path.join,
  async read(file) {
    try { return await fs.promises.readFile(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  },
  async executable(file) {
    try {
      if (!(await fs.promises.stat(file)).isFile()) return false;
      await fs.promises.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch (error) {
      if (['ENOENT', 'EACCES'].includes(error.code)) return false;
      throw error;
    }
  },
};

/**
 * @typedef {object} AgentCliFiles
 * @property {(...paths: string[]) => string} join
 * @property {(file: string) => Promise<string | null>} read
 * @property {(file: string) => Promise<boolean>} executable
 */

/**
 * @param {string} folder
 * @param {string} agent
 * @param {{ extensionsDir?: string, files?: AgentCliFiles, platform?: NodeJS.Platform, arch?: string, distro?: typeof wslDistro }} [options]
 * @returns {Promise<string>}
 */
async function resolveAgentCli(folder, agent, { extensionsDir, files = localFiles, platform = process.platform, arch = process.arch, distro = wslDistro } = {}) {
  const wsl = parseWslPath(folder);
  if (wsl) {
    const linux = distro(wsl.distro);
    // This works before a code-server tab (and its WSL agent) has been started too.
    const [home, machine] = (await linux.exec('sh', ['-c', 'printf "%s\\n%s\\n" "$HOME" "$(uname -m)"'])).trimEnd().split('\n');
    platform = 'linux';
    arch = { x86_64: 'x64', aarch64: 'arm64' }[machine];
    if (!home?.startsWith('/') || !arch) throw setupError(agent, folder);
    extensionsDir = path.posix.join(home, '.worktabs', 'extensions');
    files = {
      join: path.posix.join,
      async read(file) {
        try { return await linux.exec('sh', ['-c', 'if [ -f "$1" ]; then cat "$1"; else exit 44; fi', 'sh', file]); } catch (error) {
          if (error.code === 44) return null;
          throw error;
        }
      },
      async executable(file) {
        try {
          await linux.exec('test', ['-f', file]);
          await linux.exec('test', ['-x', file]);
          return true;
        } catch (error) {
          if (error.code === 1) return false;
          throw error;
        }
      },
    };
  }
  if (!extensionsDir) throw setupError(agent, folder);
  const binary = await extensionBinary({ files, extensionsDir, agent, platform, arch });
  if (!binary || !(await files.executable(binary))) throw setupError(agent, folder);
  return binary;
}

function authenticationFailure(output) {
  return /not (?:logged|signed) in|(?:authentication|login|sign[- ]?in) (?:is )?required|please (?:log|sign)[ -]?in|invalid (?:api key|access token|refresh token|authentication credentials)|(?:access|refresh|auth(?:entication)?) token (?:has )?expired|(?:^|\s)unauthorized(?:\s|$|[(:])|\b(?:http(?:\/[\d.]+)?(?:\s+status)?|status(?:\s+code)?|api error)[:=\s]+401\b/im.test(output);
}

function authenticationMessage(agent, folder) {
  const name = AGENTS[agent].label;
  const wsl = parseWslPath(folder);
  return wsl
    ? t('{name} authentication is missing or expired. Open its chat panel in a Worktabs tab in WSL {distro} and sign in there, then retry.', { name, distro: wsl.distro })
    : t('{name} authentication is missing or expired. Open its chat panel in a Worktabs tab on this computer and sign in, then retry.', { name });
}

function cliFailureMessage(agent, folder, error) {
  if (error.code === 'AGENT_CLI_SETUP') return error.message;
  if (['ENOENT', 'EACCES', 'ENOEXEC', 126, 127].includes(error.code)) return setupMessage(agent, folder);
  // execFile's message includes argv, including the user's task. Only use it as a fallback
  // so a task about sign-in does not turn an unrelated execution error into a login error.
  const diagnostics = [error.stderr, error.stdout].filter(Boolean).join('\n');
  if (authenticationFailure(diagnostics || error.message || '')) return authenticationMessage(agent, folder);
  // Claude writes usage-limit failures to stdout. A warning on stderr should not hide them.
  const output = String(error.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const limit = output.find((line) => /(?:hit|reached|exceeded) (?:your |the )?(?:usage |rate )?limit|rate.?limit|quota|too many requests/i.test(line));
  if (limit) return limit;
  return gitMessage(error);
}

module.exports = { authenticationFailure, authenticationMessage, cliFailureMessage, extensionBinary, resolveAgentCli };
