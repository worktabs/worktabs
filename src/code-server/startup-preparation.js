// Making code-server, the claude wrapper and the extensions ready at start, each step shown on the
// page the window has without tabs. Tabs opened meanwhile wait at the startup gate
// (startup-gate.js), which this opens, or fails with what went wrong. code-server's download and
// manager are injected, so fakes test it.
const { t } = require('../i18n');
const { codeServerProgress } = require('./app-updates');

// What is wrong with the claude wrapper (claudeCode.claudeProcessWrapper), or null. `exists`:
// whether `wrapExe` is there. `error`: why writing it out failed on macOS (installWrapper).
function wrapperProblem({ agents, platform, wrapExe, exists, error }) {
  if (!agents.includes('claude') || (exists && !error)) return null;
  return platform === 'win32'
    ? t('{path} is missing. Run npm run build:native.', { path: wrapExe })
    : t('Could not set up the claude wrapper ({path}). {error}', { path: wrapExe, error: error ? error.message : '' }).trim();
}

// Resolves the code-server manager of the tabs once code-server and the extensions are ready, or
// null when one of them could not be. `show(title, detail, progress)`: the page without tabs, with
// the part done of the download or the extracting (placeholder.js). `startup`: the StartupGate.
// `ensureCodeServer({ version, onProgress, onExtract })`: the folder of code-server, downloaded
// and extracted when needed (install.js). `createServers(dir)`: the CodeServerManager.
// `made(servers)`: what may use it before the extensions are ready (the control port).
// `wrapper()`: wrapperProblem. `specs()`: the extensions to install. `changed()`: the side bar is
// to show the failure.
async function prepareCodeServer({ config, show, startup, ensureCodeServer, createServers, made, wrapper, specs, changed }) {
  let codeServerDir = config.codeServerDir;
  if (!codeServerDir) {
    try {
      show('Worktabs', t('Preparing code-server {version}…', { version: config.codeServerVersion }));
      codeServerDir = await ensureCodeServer({
        version: config.codeServerVersion,
        ...codeServerProgress(config.codeServerVersion, (detail, progress) => show('Worktabs', detail, progress)),
      });
    } catch (error) {
      startup.fail(new Error(t('Could not prepare code-server: {error}', { error: error.message })));
      show(t('Could not prepare code-server'), error.message);
      return null;
    }
  }

  const servers = createServers(codeServerDir);
  made(servers);

  const problem = servers.checkInstall() || wrapper();
  if (problem) {
    startup.fail(new Error(t('{problem} (settings file: {file})', { problem, file: config.file })));
    show(t('Settings needed'), t('{problem} (settings file: {file})', { problem, file: config.file }));
    changed();
    return null;
  }
  try {
    show('Worktabs', t('Checking the extensions…'));
    await servers.ensureExtensions(specs());
    startup.complete();
    show('Worktabs', t('Open a worktree from the side bar on the left.'));
  } catch (error) {
    startup.fail(new Error(t('Could not install the extensions: {error}', { error: error.message })));
    show(t('Could not install the extensions'), error.message);
    return null;
  }
  return servers;
}

module.exports = { prepareCodeServer, wrapperProblem };
