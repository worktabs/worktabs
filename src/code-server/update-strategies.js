const { t } = require('../i18n');

// Gallery rollback installs the previous versions through the server known to work. Import
// rollback instead uses immutable snapshots (applyImportBatch in extension-imports.js).
async function applyGalleryUpdate({ items, extensions, next, previous, report, log, install, use, probe, commit, wsl }) {
  log(`apply: ${items.map((item) => `${item.id} ${item.to}`).join(', ')}`);
  let failure = null;
  try {
    for (const item of extensions) await install(`${item.id}@${item.to}`);
    if (next) use(next);
    report({ status: 'applying', detail: t('Checking that the new versions start…') });
    await probe();
  } catch (error) {
    log(`failed, going back: ${error.message}`);
    report({ status: 'applying', detail: t('Going back to the previous versions…') });
    try {
      if (next) use(previous);
      for (const item of extensions) await install(`${item.id}@${item.from}`);
      failure = t('{error}. Went back to the previous versions.', { error: error.message });
    } catch (revertError) {
      log(`going back failed: ${revertError.message}`);
      failure = t('{error}. Could not go back to the previous versions either: {revertError}', { error: error.message, revertError: revertError.message });
    }
  }
  // Persist only after the local probe. The previous code-server stays for manual recovery.
  if (!failure && next) commit();
  const failures = [];
  for (const manager of failure ? [] : wsl()) {
    try {
      await manager.applyUpdate((detail, progress) => report({ status: 'applying', detail, progress }));
    } catch (error) {
      log(`WSL ${manager.distro} failed: ${error.message}`);
      failures.push(t('Could not update WSL {distro}: {error}', { distro: manager.distro, error: error.message }));
    }
  }
  log(failure ? 'done with the previous versions' : 'done');
  return failure ? { status: 'failed', detail: failure } : { status: 'done', detail: failures.join('\n') };
}

module.exports = { applyGalleryUpdate };
