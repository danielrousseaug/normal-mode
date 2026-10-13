// Normal Mode, main-process half. A one-line hook added to the app's entry
// file at build time loads this once at startup. It:
//   1. runs normal-mode.js in the app's pages before the page's own code, and
//   2. passes the page's requests to bridge.js (real key presses, clicks,
//      debug dumps). bridge.js is re-read on gR, so edits there need no restart.
'use strict';

if (!global.__normalModeMain) {
  global.__normalModeMain = true;

  const { app, ipcMain, session } = require('electron');
  const path = require('path');

  const PRELOAD = path.join(__dirname, 'normal-mode.js');
  const BRIDGE = path.join(__dirname, 'bridge.js');

  const attached = new WeakSet();
  const attach = (ses) => {
    if (!ses || attached.has(ses)) return;
    attached.add(ses);
    try {
      ses.registerPreloadScript({ type: 'frame', id: 'normal-mode', filePath: PRELOAD });
    } catch (err) {
      console.error('[normal-mode] could not register preload', err);
    }
  };
  app.on('session-created', attach);
  app.on('web-contents-created', (_e, wc) => attach(wc.session));
  app.whenReady().then(() => attach(session.defaultSession));

  // only the app's own top-level page may drive input (same rule the app uses)
  const fromAppPage = (event) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent) return false;
    try {
      const u = new URL(frame.url);
      return (u.protocol === 'app:' && u.host === 'localhost') ||
        (u.protocol === 'https:' && u.host === 'claude.ai');
    } catch {
      return false;
    }
  };

  let bridge = null;
  const loadBridge = () => {
    delete require.cache[require.resolve(BRIDGE)];
    bridge = require(BRIDGE);
  };

  ipcMain.on('normal-mode', (event, msg) => {
    if (!msg || !fromAppPage(event)) return;
    try {
      if (msg.type === 'reload' || !bridge) loadBridge();
      bridge.handle(event.sender, msg);
    } catch (err) {
      console.error('[normal-mode]', err);
    }
  });
}
