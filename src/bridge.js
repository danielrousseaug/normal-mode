// Normal Mode, main-process handlers. main.js re-reads this file whenever the
// page sends 'reload' (gR), so changes here apply without restarting the app.
'use strict';

const { app, BrowserWindow, webContents } = require('electron');
const fs = require('fs');
const path = require('path');

// survives reloads of this file: the app page, and one hook on every other
// webContents (side panes, the in-app browser) that calls the current handler
const G = global.__normalModeBridge || (global.__normalModeBridge = { main: null, handler: null, hooked: new WeakSet() });
const trampoline = (event, input) => G.handler?.(event, input);
function hook(wc) {
  if (G.hooked.has(wc)) return;
  G.hooked.add(wc);
  wc.on('before-input-event', trampoline);
}
if (!G.installed) {
  G.installed = true;
  app.on('web-contents-created', (_e, wc) => hook(wc));
}
for (const wc of webContents.getAllWebContents()) hook(wc);

// Alt+Esc in any other pane hands the keyboard back to the app page
G.handler = (event, input) => {
  const main = G.main;
  if (input.type !== 'keyDown' || input.key !== 'Escape' || !input.alt || input.control || input.meta || input.shift) return;
  if (!main || main.isDestroyed() || event.sender === main) return;
  event.preventDefault();
  main.focus();
};

const NAMED = {
  esc: 'Escape', enter: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End',
};
const MODS = { ctrl: 'control', alt: 'alt', shift: 'shift', meta: 'meta' };
const BUTTONS = new Set(['left', 'right', 'middle']);

function sendChord(wc, chord) {
  const parts = chord.toLowerCase().split('+');
  const key = parts.pop();
  const keyCode = NAMED[key] || (/^f\d{1,2}$/.test(key) ? key.toUpperCase() : key);
  const modifiers = parts.map((m) => MODS[m]).filter(Boolean);
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

// x, y arrive in CSS pixels; input events want the view's own pixels
function sendMouse(wc, { x, y, move, leave, button = 'left', modifiers = [] }) {
  if (leave) return wc.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 });
  if (!Number.isFinite(x) || !Number.isFinite(y) || !BUTTONS.has(button)) return;
  const z = wc.getZoomFactor();
  const at = { x: Math.round(x * z), y: Math.round(y * z) };
  const mods = modifiers.map((m) => MODS[m]).filter(Boolean);
  wc.sendInputEvent({ type: 'mouseMove', ...at, modifiers: mods });
  if (move) return;
  wc.sendInputEvent({ type: 'mouseDown', ...at, button, clickCount: 1, modifiers: mods });
  wc.sendInputEvent({ type: 'mouseUp', ...at, button, clickCount: 1, modifiers: mods });
}

// a wheel scroll of dy CSS pixels (positive = down), so the app's scroll logic
// sees an ordinary user scroll. glide: a mouse-wheel notch the browser animates
// smoothly (it caps one notch at about a screen); otherwise it lands at once,
// like a touchpad.
function sendWheel(wc, { x, y, dy, glide }) {
  if (![x, y, dy].every(Number.isFinite)) return;
  const z = wc.getZoomFactor();
  wc.sendInputEvent({
    type: 'mouseWheel', x: Math.round(x * z), y: Math.round(y * z),
    deltaX: 0, deltaY: -dy * z, hasPreciseScrollingDeltas: !glide, canScroll: true,
  });
}

function writeDebug(data) {
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(path.join(require('os').tmpdir(), 'normal-mode-debug.json'), text.slice(0, 4e6));
}

// keyboard focus back to the app page, but only while the app is in front
function focusPage(wc) {
  if (!BrowserWindow.getFocusedWindow()) return;
  if (webContents.getFocusedWebContents() !== wc) wc.focus();
}

exports.handle = (wc, msg) => {
  G.main = wc;
  switch (msg.type) {
    case 'keys':
      if (Array.isArray(msg.chords)) for (const c of msg.chords.slice(0, 8)) sendChord(wc, String(c));
      break;
    case 'mouse':
      sendMouse(wc, msg);
      break;
    case 'wheel':
      sendWheel(wc, msg);
      break;
    case 'focus':
      focusPage(wc);
      break;
    case 'debug':
      writeDebug(msg.data);
      break;
    default:
      break;
  }
};
