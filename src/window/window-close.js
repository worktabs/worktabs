// Closing the window stops every code-server, so it asks first when that would lose something
// (tab-risks.js). The dialogs and the window are injected, so fakes test it.
const { t } = require('../i18n');

// `cancelDialogs()`: answers the dialogs up as canceled. `risks()`: the lines of what quitting
// would lose. `beforeClose()`: what is saved once quitting is confirmed. `close()`: closes the
// window again, this time for good. `canceled()`: told when the user keeps the window open.
function createCloseGuard({ cancelDialogs, risks, messageBox, beforeClose, close, canceled = () => {} }) {
  let confirmed = false;
  // Checking, or asking: closing again meanwhile does nothing.
  let closing = false;

  // The window's 'close' listener.
  async function onClose(event) {
    if (confirmed) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    // The app's dialogs do not hold the window as Windows' did, so it can be closed with one up:
    // it is answered as canceled, and the check goes on.
    cancelDialogs();
    try {
      const details = await risks();
      if (details.length) {
        const { response } = await messageBox({
          type: 'warning',
          buttons: [t('Quit'), t('Cancel')],
          defaultId: 1,
          cancelId: 1,
          message: t('Quitting will have these effects.'),
          detail: details.join('\n'),
        });
        if (response !== 0) {
          canceled();
          return;
        }
      }
      await beforeClose();
    } finally {
      closing = false;
    }
    confirmed = true;
    close();
  }

  return { onClose };
}

module.exports = { createCloseGuard };
