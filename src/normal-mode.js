// Normal Mode: vim-style keys for the Claude desktop app.
//
// Runs two ways:
//   1. as a preload that main.js registers: the full version. Key presses,
//      clicks and scrolling go through the main process as real input, so the
//      app reacts exactly as it would to your keyboard, mouse and touchpad.
//   2. pasted into DevTools (Ctrl+Alt+I) as a quick try: same keys, but
//      shortcuts only the main process handles (Ctrl+N, Ctrl+W, ...) won't fire.
//
// Press ? in normal mode for the cheat sheet. The keymap is the MAP section.
(() => {
  'use strict';

  const VERSION = '0.7.0';

  // ---- where to run --------------------------------------------------------
  const onAppPage =
    (location.protocol === 'app:' && location.host === 'localhost') ||
    (location.protocol === 'https:' && location.host === 'claude.ai');
  if (window.top !== window) return;
  if (!onAppPage && !window.__NORMAL_MODE_FORCE) return;
  window.__normalMode?.destroy?.();

  let ipc = null;
  try { ipc = require('electron').ipcRenderer; } catch { /* DevTools paste */ }

  const stored = (key) => {
    try { return localStorage.getItem(`normal-mode:${key}`); } catch { return null; }
  };

  // ---- settings ------------------------------------------------------------
  const CONFIG = {
    hintChars: 'sadfjklewcmpgh', // Vimium C's default
    scrollSpeed: 1000,           // px per second while j / k is down: one speed throughout
    scrollStep: 80,              // the least a tap of j / k moves
    scrollSnap: 40,              // how fast j / k start, stop and turn around (higher = snappier)
    startInNormal: true,         // the composer only takes focus when you ask
    normalAfterSend: true,       // sending a prompt drops back to normal mode
    whichKeyDelay: 350,          // ms before the continuation menu shows
    indicator: 'auto',           // 'auto' (hidden in normal mode), 'always', or false
    // 'wheel': scroll with real touchpad-style input, so the transcript's own
    // logic (sticking to the bottom, keeping your place) sees a normal scroll.
    // 'direct': set the scroll position from the page (DevTools mode uses this).
    scrollInput: stored('scrollInput') || 'wheel',
  };

  // The app's own shortcuts, written as its tables write them: "cmd" is Cmd on
  // macOS and Ctrl elsewhere; "ctrl" is Ctrl everywhere.
  const MAC = /Mac/.test(navigator.platform);
  const APP = {
    newSession: 'cmd+n',
    nextSession: 'ctrl+tab',
    prevSession: 'ctrl+shift+tab',
    jumpSession: (n) => `cmd+${n}`,
    close: 'cmd+w',
    reopen: 'cmd+shift+t',
    commandPalette: 'cmd+k',
    search: 'cmd+shift+k',
    sidebar: 'cmd+b',
    shortcuts: 'cmd+/',
    nextPane: 'ctrl+]',
    prevPane: 'ctrl+[',
    splitRight: 'ctrl+alt+\\',
    splitBelow: 'ctrl+alt+-',
    closePane: 'cmd+\\',
    expandPane: 'cmd+shift+\\',
    nextRegion: 'f6',
    fork: 'cmd+alt+o',
    rename: 'cmd+alt+r',
    pin: 'cmd+alt+p',
    archive: 'cmd+alt+a',
    unread: 'cmd+alt+u',
    copyLink: 'cmd+alt+l',
    openPR: 'cmd+alt+g',
    transcriptView: 'ctrl+o',
    diff: 'cmd+shift+d',
    diffFileList: 'cmd+shift+y',
    nextChange: 'f7',
    prevChange: 'shift+f7',
    goToFile: 'cmd+p',
    terminal: MAC ? 'cmd+j' : 'ctrl+`',
    files: 'cmd+shift+f',
    preview: 'cmd+shift+p', // "Toggle Browser"; some builds use cmd+shift+b
    sideChat: 'cmd+;',
    modelMenu: 'cmd+shift+i',
    modeMenu: 'cmd+shift+m',
    effortMenu: 'cmd+shift+e',
    fastMode: 'cmd+alt+f',
  };

  // Markers in the app's markup. Code tab first, Chat tab as fallback.
  const SEL = {
    transcript: '[data-testid="epitaxy-virtual-transcript"],[data-testid="transcript-rows"]',
    entry: '[data-epitaxy-entry]',                  // one transcript row (Code)
    prompt: '[data-take-back-entry]',               // a prompt you sent (Code)
    userMsg: '[data-testid="user-message"]',        // Chat
    anyMsg: '[data-testid="user-message"],[data-testid="assistant-message"]',
    row: '[data-testid="transcript-row"]',
    sidebarToggle: '[data-testid="desktop-topbar-sidebar-toggle"]',
    menu: '[role=menu],[role=listbox]',
    list: '[role=tree],[role=grid]',
    raw: '.xterm,.monaco-editor,.cm-editor', // terminal / code editors: keys pass through
    clickable: [
      'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary', 'label[for]',
      '[contenteditable=""]', '[contenteditable="true"]', '[aria-haspopup]',
      '[tabindex]:not([tabindex="-1"])',
      ...['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
        'treeitem', 'checkbox', 'radio', 'switch', 'combobox', 'gridcell'].map((r) => `[role=${r}]`),
    ].join(','),
  };

  // Message actions: a hover button if the message has one, otherwise the
  // matching item in the message's right-click menu.
  const MSG_ACTIONS = {
    rewind: {
      btn: '[data-testid="user-message-rewind"],[data-testid="user-message-edit"]',
      label: /^(rewind to here|restart from here|edit)$/i,
      menuItem: /^rewind to here/i,
      thenType: true, // the prompt comes back into the composer for editing
    },
    copy: {
      btn: '[data-testid="user-message-copy"],[data-testid="action-bar-copy"]',
      label: /^copy( message)?$/i,
      menuItem: /^copy message$/i,
      done: 'Copied',
    },
    fork: { menuItem: /^fork from here/i },
    menu: {}, // just open the menu
  };

  // ---- small helpers -------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PASS = Symbol('pass'); // a binding returns this to let the key through

  function activeEl() {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a === document.body ? null : a;
  }

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return el.tagName === 'INPUT' &&
      !/^(button|checkbox|color|file|image|radio|range|reset|submit)$/i.test(el.type);
  }

  function visibleRect(el) {
    for (const r of el.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
      if (getComputedStyle(el).visibility === 'hidden') return null;
      return r;
    }
    return null;
  }

  function centerOf(el) {
    const r = visibleRect(el);
    if (!r) return null;
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    const y = Math.min(Math.max(r.top + Math.min(r.height / 2, 20), 1), innerHeight - 1);
    return { x, y };
  }

  const accessibleName = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();

  // outermost matches only (some rows nest the same marker twice)
  const outermost = (els) => els.filter((el) => !els.some((o) => o !== el && o.contains(el)));

  // rAF stalls while the window is hidden; whichever comes first wins
  function nextFrame(fn) {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      fn();
    };
    const raf = requestAnimationFrame(go);
    const timer = setTimeout(go, 50);
    return true;
  }
  const frames = (n) => new Promise((r) => {
    const step = (k) => (k ? nextFrame(() => step(k - 1)) : r());
    step(n);
  });

  // ---- pressing keys, clicking, scrolling --------------------------------------
  // Our own synthetic events must not loop back into the key handler, and real
  // key presses we asked the main process for must pass straight through. Only
  // those exact chords pass: a key you are holding must never slip by in their place.
  let synthDepth = 0;
  const expected = [];

  function sentByUs(e) {
    const now = performance.now();
    while (expected.length && expected[0].until < now) expected.shift();
    const i = expected.findIndex((x) =>
      (x.key.toLowerCase() === e.key.toLowerCase() || (x.code !== '' && x.code === e.code)) &&
      x.ctrlKey === e.ctrlKey && x.altKey === e.altKey && x.shiftKey === e.shiftKey && x.metaKey === e.metaKey);
    if (i < 0) return false;
    expected.splice(i, 1);
    return true;
  }

  const CODES = {
    '`': 'Backquote', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
    '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash',
  };
  const SHIFTED = {
    '`': '~', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<',
    '.': '>', '/': '?', 1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')',
  };
  const NAMED = {
    esc: 'Escape', enter: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End',
  };

  function parseChord(chord) {
    const parts = chord.split('+');
    const k = parts.pop();
    const mod = new Set(parts);
    const shift = mod.has('shift');
    let key, code;
    if (NAMED[k]) key = code = NAMED[k];
    else if (/^f\d{1,2}$/.test(k)) key = code = k.toUpperCase();
    else if (/^[a-z]$/.test(k)) { key = shift ? k.toUpperCase() : k; code = `Key${k.toUpperCase()}`; }
    else if (/^\d$/.test(k)) { key = shift ? SHIFTED[k] : k; code = `Digit${k}`; }
    else { key = shift ? SHIFTED[k] ?? k : k; code = CODES[k] ?? ''; }
    return { key, code, ctrlKey: mod.has('ctrl'), shiftKey: shift, altKey: mod.has('alt'), metaKey: mod.has('meta') };
  }

  // press('ctrl+alt+o') or press('esc esc'): space-separated chords, in order.
  function press(seq) {
    const chords = seq.split(' ').map((c) => c.replace(/\bcmd\b/, MAC ? 'meta' : 'ctrl'));
    if (ipc) {
      const until = performance.now() + 1000;
      for (const c of chords) expected.push({ ...parseChord(c), until });
      ipc.send('normal-mode', { type: 'keys', chords });
      return;
    }
    const target = activeEl() || document.body;
    synthDepth++;
    try {
      for (const c of chords) {
        const init = { ...parseChord(c), bubbles: true, cancelable: true, composed: true };
        target.dispatchEvent(new KeyboardEvent('keydown', init));
        target.dispatchEvent(new KeyboardEvent('keyup', init));
      }
    } finally { synthDepth--; }
  }

  function synthPointer(el, types, extra = {}) {
    const p = centerOf(el) || { x: 0, y: 0 };
    synthDepth++;
    try {
      for (const type of types) {
        const init = {
          bubbles: !type.endsWith('enter'), cancelable: true, composed: true, view: window,
          clientX: p.x, clientY: p.y, button: 0, pointerType: 'mouse', isPrimary: true, ...extra,
        };
        const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        if (type === 'focus') el.focus?.({ preventScroll: true });
        else el.dispatchEvent(new Ctor(type, init));
      }
    } finally { synthDepth--; }
  }

  function hover(el) {
    const p = centerOf(el);
    if (!p) return;
    if (ipc) return ipc.send('normal-mode', { type: 'mouse', ...p, move: true });
    synthPointer(el, ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']);
  }

  // A click is not a request to type: opening a session with f leaves you in
  // normal mode. Clicking the composer itself (or right next to it) does focus it.
  function click(el, { alt = false } = {}) {
    el.scrollIntoView({ block: 'nearest' });
    if (isEditable(el)) {
      allowFocus();
      return el.focus();
    }
    const p = centerOf(el);
    if (ipc && p) return ipc.send('normal-mode', { type: 'mouse', ...p, modifiers: alt ? ['alt'] : [] });
    synthPointer(el, ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click'],
      { altKey: alt });
  }

  // Scrolling goes in as wheel input on the scroller's own edge (clear of
  // nested scroll boxes), so the app sees an ordinary scroll and the browser
  // animates it off the main thread. glide: one smooth mouse-wheel notch,
  // which the browser caps at about a screen; otherwise an instant move.
  const wheelable = (el) => !!ipc && CONFIG.scrollInput === 'wheel' && el !== document.scrollingElement;

  function wheel(el, dy, glide) {
    const r = el.getBoundingClientRect();
    const x = Math.max(r.left + 1, Math.min(r.right, innerWidth) - 4);
    const y = (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2;
    ipc.send('normal-mode', { type: 'wheel', x, y, dy, glide });
  }

  // ---- the composer and who gets to focus it ---------------------------------
  // The app focuses the composer on its own (opening a session, after a reply).
  // With startInNormal that is undone unless you asked for it: i / a / I, a
  // click on or near it, Tab, or an action that leads to typing (o, rewind).
  let focusIntentUntil = 0;
  let lastPress = { t: -1e9, x: 0, y: 0 };
  let tabAt = -1e9;
  let refocusFights = 0; // focus undone with no key or click in between
  const allowFocus = (ms = 600) => { focusIntentUntil = Math.max(focusIntentUntil, performance.now() + ms); };

  const isComposer = (el) => !!el?.isContentEditable && !el.closest('[role=dialog],[role=menu],[role=listbox]');

  function focusWanted(el) {
    const now = performance.now();
    if (now < focusIntentUntil || now - tabAt < 400) return true;
    if (now - lastPress.t > 900) return false;
    const r = el.getBoundingClientRect();
    const pad = 48;
    return lastPress.x > r.left - pad && lastPress.x < r.right + pad &&
      lastPress.y > r.top - pad && lastPress.y < r.bottom + pad;
  }

  function composer() {
    const eds = [...document.querySelectorAll('[contenteditable="true"],textarea')]
      .filter((el) => (visibleRect(el)?.width ?? 0) > 150);
    if (!eds.length) return null;
    const lowest = (list) => list.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
    const sc = currentScroller();
    if (sc) {
      const s = sc.getBoundingClientRect();
      const inPane = eds.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < s.right && r.right > s.left;
      });
      if (inPane.length) return lowest(inPane);
    }
    return lowest(eds);
  }

  function focusComposer(where = 'keep') {
    const el = composer();
    if (!el) return toast('No composer here');
    allowFocus();
    el.focus();
    if (where === 'keep') return;
    if (el.setSelectionRange) {
      const n = where === 'end' ? el.value.length : 0;
      el.setSelectionRange(n, n);
    } else {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(where === 'start');
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
  }

  // Send keys to the composer (Esc to stop, Esc Esc to rewind), then return
  // to normal mode if focus is still sitting there.
  async function inComposer(seq, { stay = false } = {}) {
    const el = composer();
    if (!el) return toast('No composer here');
    allowFocus(stay ? 2500 : 600);
    el.focus();
    press(seq);
    if (stay) return;
    await sleep(120);
    if (activeEl() === el) leaveInsert(el);
  }

  function stopOrCopy() {
    if (String(getSelection())) return PASS; // let Ctrl+C copy the selection
    inComposer('esc');
    toast('Stopped');
  }

  // ---- scrolling ------------------------------------------------------------
  // j / k steer the transcript frame by frame (steer, below). Glides (d / u,
  // top / bottom, prompt jumps) are browser-animated wheel notches, or in direct
  // mode our own animation (motion): pending distance, or an edge to reach.
  let lastTarget = null;
  let lastPointer = { x: innerWidth / 2, y: innerHeight / 2 };
  const motion = { el: null, running: false, last: 0, pending: 0, edge: 0, frac: 0 };
  let jumpSeq = 0; // a newer jump or scroll key cancels a prompt search in progress

  function isScrollable(n) {
    if (n.clientHeight < 80 || n.scrollHeight <= n.clientHeight + 8) return false;
    return /^(auto|scroll|overlay)$/.test(getComputedStyle(n).overflowY);
  }

  function scrollParent(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) if (isScrollable(n)) return n;
    return null;
  }

  function scrollers() {
    const found = new Set();
    for (const t of document.querySelectorAll(SEL.transcript)) {
      const s = scrollParent(t);
      if (s) found.add(s);
    }
    if (!found.size) {
      for (const n of document.querySelectorAll('div,main,section,article')) if (isScrollable(n)) found.add(n);
    }
    return [...found].filter((s) => visibleRect(s));
  }

  function currentScroller() {
    const list = scrollers();
    if (!list.length) return document.scrollingElement;
    const anchor = lastTarget?.isConnected ? lastTarget : activeEl();
    const area = (s) => s.clientWidth * s.clientHeight;
    const overlaps = (s, el) => {
      const a = el.getBoundingClientRect();
      const b = s.getBoundingClientRect();
      return a.left < b.right && a.right > b.left;
    };
    const under = (s, p) => {
      const r = s.getBoundingClientRect();
      return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
    };
    return (anchor && list.find((s) => s.contains(anchor))) ||
      (anchor && list.find((s) => overlaps(s, anchor))) ||
      list.find((s) => under(s, lastPointer)) ||
      list.sort((a, b) => area(b) - area(a))[0];
  }

  function haltMotion() {
    Object.assign(motion, { pending: 0, edge: 0, frac: 0 });
  }

  function useScroller(el) {
    if (motion.el !== el) {
      haltMotion();
      motion.el = el;
    }
  }

  // ---- direct-mode glides, timed by the clock ----
  function tick() {
    const m = motion;
    const el = m.el;
    if (!el?.isConnected) { m.running = false; haltMotion(); return; }
    const now = performance.now();
    const dt = Math.min(0.05, (now - m.last) / 1000);
    m.last = now;
    const ease = (rate) => 1 - Math.exp(-dt * rate);

    let dy = 0;
    if (m.edge) {
      const dist = (m.edge > 0 ? el.scrollHeight - el.clientHeight : 0) - el.scrollTop;
      if (Math.abs(dist) < 1) m.edge = 0;
      else dy += dist * ease(12) + Math.sign(dist);
    }
    if (m.pending) {
      const step = m.pending * ease(14);
      if (Math.abs(m.pending - step) < 0.5) { dy += m.pending; m.pending = 0; } else { dy += step; m.pending -= step; }
    }

    m.frac += dy;
    const whole = Math.trunc(m.frac);
    if (whole) {
      const before = el.scrollTop;
      el.scrollBy({ top: whole, behavior: 'instant' });
      m.frac -= whole;
      if (el.scrollTop === before && !m.edge) { m.pending = 0; m.frac = 0; }
    }

    if (!m.edge && !m.pending) { m.running = false; m.frac = 0; return; }
    nextFrame(tick);
  }

  function animate() {
    if (motion.running) return;
    motion.running = true;
    motion.last = performance.now();
    nextFrame(tick);
  }

  // an instant move (prompt searches)
  function jumpBy(el, dy) {
    if (!dy) return;
    if (wheelable(el)) wheel(el, dy, false);
    else el.scrollBy({ top: dy, behavior: 'instant' });
  }

  // a smooth move; anything beyond one notch is jumped first
  function glide(el, dy) {
    if (!dy) return;
    if (!wheelable(el)) {
      useScroller(el);
      motion.edge = 0;
      motion.pending += dy;
      return animate();
    }
    const rest = Math.sign(dy) * Math.min(Math.abs(dy), el.clientHeight * 0.8);
    if (dy !== rest) wheel(el, dy - rest, false);
    wheel(el, rest, true);
  }

  // ---- j / k: one steady speed, in step with the screen ----
  // While the key is down the transcript moves at scrollSpeed (a tap still
  // covers scrollStep), and it starts, stops and turns around within a few
  // frames. Each move also hands the transcript a wheel event with no distance
  // in it: the app reads that as you scrolling, as it would a touchpad, so it
  // lets go of the bottom instead of pulling you back down.
  const steer = { el: null, dir: 0, key: '', down: false, owed: 0, v: 0, frac: 0, last: 0, running: false, nudgedAt: 0 };

  function nudge(el, dir) {
    const now = performance.now();
    if (now - steer.nudgedAt < 80) return;
    steer.nudgedAt = now;
    synthDepth++;
    try {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: dir, bubbles: true, cancelable: true, composed: true }));
    } finally { synthDepth--; }
  }

  function steerTick() {
    const s = steer;
    const el = s.el;
    if (!el?.isConnected) { s.running = false; return; }
    const now = performance.now();
    const dt = Math.min(0.05, (now - s.last) / 1000);
    s.last = now;
    const going = s.down || s.owed > 0;
    s.v += ((going ? s.dir * CONFIG.scrollSpeed : 0) - s.v) * (1 - Math.exp(-dt * CONFIG.scrollSnap));
    if (!going && Math.abs(s.v) < 20) s.v = 0;
    const dy = s.v * dt;
    if (s.owed > 0 && Math.sign(dy) === s.dir) s.owed = Math.max(0, s.owed - Math.abs(dy));

    s.frac += dy;
    const whole = Math.trunc(s.frac);
    if (whole) {
      const before = el.scrollTop;
      el.scrollBy({ top: whole, behavior: 'instant' });
      s.frac -= whole;
      if (el.scrollTop === before) { // top or bottom
        s.owed = 0;
        s.frac = 0;
        if (!s.down) s.v = 0;
      } else {
        nudge(el, Math.sign(whole));
      }
    }

    if (!s.down && !s.owed && !s.v) { s.running = false; s.frac = 0; return; }
    nextFrame(steerTick);
  }

  function stopSteering() {
    Object.assign(steer, { down: false, key: '', owed: 0, v: 0 });
  }

  function scrollKey(dir, n, e) {
    jumpSeq++;
    const el = currentScroller();
    if (!el) return;
    if (steer.el !== el) Object.assign(steer, { el, v: 0, frac: 0 });
    if (e?.repeat && steer.down && steer.dir === dir) return; // already moving
    steer.dir = dir;
    steer.down = !!e && n === 1; // a count (5j) covers its distance and stops
    steer.key = e?.code ?? '';
    steer.owed = CONFIG.scrollStep * n;
    if (!steer.running) {
      steer.running = true;
      steer.last = performance.now();
      nextFrame(steerTick);
    }
  }

  function releaseKey(code) {
    if (code && steer.key !== code) return;
    steer.down = false;
    steer.key = '';
  }

  function glideBy(dy) {
    const el = currentScroller();
    if (el) glide(el, dy);
  }

  // all the way to the top / bottom, even if the transcript grows or loads
  // older messages on the way
  async function glideToEdge(dir) {
    const seq = ++jumpSeq;
    stopSteering();
    const el = currentScroller();
    if (!el) return;
    if (!wheelable(el)) {
      useScroller(el);
      haltMotion();
      motion.edge = dir;
      return animate();
    }
    for (let i = 0; i < 6 && seq === jumpSeq; i++) {
      const dist = dir > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : -el.scrollTop;
      if (Math.abs(dist) < 2) return;
      glide(el, dist + dir * 40);
      await sleep(450);
    }
  }

  const halfPage = () => Math.round((currentScroller()?.clientHeight ?? innerHeight) / 2);

  // ---- prompts and messages ----------------------------------------------------
  function promptEls(scope) {
    const code = outermost([...scope.querySelectorAll(SEL.prompt)]);
    return code.length ? code : [...scope.querySelectorAll(SEL.userMsg)];
  }

  function messageEls(scope) {
    const code = outermost([...scope.querySelectorAll(SEL.entry)]);
    return code.length ? code : outermost([...scope.querySelectorAll(SEL.anyMsg)]);
  }

  // The transcript only keeps rows near the viewport in the page, so a prompt
  // further away has to be found by scrolling toward it.
  const PROMPT_MARGIN = 12;

  // after a scroll: wait for the scroll event, then for the transcript to draw
  // the rows that came into range
  const settled = (sc) => new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sc.removeEventListener('scroll', finish);
      clearTimeout(timer);
      frames(2).then(resolve);
    };
    sc.addEventListener('scroll', finish, { passive: true });
    const timer = setTimeout(finish, 150);
  });

  function promptTops(sc) {
    const top = sc.getBoundingClientRect().top;
    return promptEls(sc)
      .map((p) => (p.closest(SEL.entry) || p).getBoundingClientRect().top - top)
      .sort((a, b) => a - b);
  }

  // the next prompt's offset from the top, or null once the search reaches
  // the top / bottom without one (it stays there)
  async function findPrompt(sc, dir, seq) {
    for (let tries = 0; tries < 200; tries++) {
      if (seq !== jumpSeq) return null;
      const tops = promptTops(sc);
      const y = dir > 0
        ? tops.find((t) => t > PROMPT_MARGIN + 4)
        : tops.filter((t) => t < PROMPT_MARGIN - 4).pop();
      if (y !== undefined) return y;
      const atEdge = dir > 0 ? sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 1 : sc.scrollTop <= 0;
      if (atEdge) return null;
      jumpBy(sc, dir * sc.clientHeight * 0.85);
      await settled(sc);
    }
    return null;
  }

  // { / }: prompt to prompt; past the last prompt } carries on to the bottom
  // (the latest output), and past the first { goes to the top
  async function jumpPrompt(dir, count) {
    const sc = currentScroller();
    if (!sc) return;
    useScroller(sc);
    haltMotion();
    stopSteering();
    const seq = ++jumpSeq;
    const start = sc.scrollTop;
    for (let i = 0; i < count; i++) {
      const y = await findPrompt(sc, dir, seq);
      if (seq !== jumpSeq) return;
      if (y === null) {
        if (Math.abs(sc.scrollTop - start) < 2) toast(dir > 0 ? 'Already at the bottom' : 'Already at the top');
        return glideToEdge(dir); // lands exactly, even while a reply is still streaming in
      }
      if (i < count - 1) {
        jumpBy(sc, y - PROMPT_MARGIN);
        await settled(sc);
      } else {
        glide(sc, y - PROMPT_MARGIN);
      }
    }
  }

  async function revealButton(msg, a) {
    if (!a.btn && !a.label) return null;
    const row = msg.closest(SEL.entry) || msg.closest(SEL.row) || msg;
    const find = () => {
      for (const s of [row, row.nextElementSibling].filter(Boolean)) {
        const b = (a.btn && s.querySelector(a.btn)) ||
          [...s.querySelectorAll('button,[role=button]')].find((x) => a.label.test(accessibleName(x)));
        if (b && visibleRect(b) && !b.disabled) return b;
      }
      return null;
    };
    let b = find();
    if (b) return b;
    hover(msg);
    for (let i = 0; i < 6 && !b; i++) {
      await sleep(60);
      b = find();
    }
    return b;
  }

  // a right-click: a real one through the main process, synthetic otherwise
  function rightClick(el, x, y) {
    if (ipc) return ipc.send('normal-mode', { type: 'mouse', x, y, button: 'right' });
    synthDepth++;
    try {
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 2, buttons: 2,
      }));
    } finally { synthDepth--; }
  }

  async function waitForMenu() {
    for (let i = 0; i < 12; i++) {
      await sleep(40);
      const m = [...document.querySelectorAll('[role=menu]')].find((n) => visibleRect(n));
      if (m) return m;
    }
    return null;
  }

  // keep menus that open in the next ms invisible (they still work)
  function hideMenus(ms) {
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1 && (n.matches('[role=menu]') || n.querySelector('[role=menu]'))) n.style.opacity = '0';
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), ms);
  }

  async function openMessageMenu(msg) {
    const r = visibleRect(msg);
    if (!r) return null;
    const x = r.left + Math.min(40, r.width / 2);
    const y = Math.max(r.top, 0) + Math.min(16, r.height / 2);
    const hit = document.elementFromPoint(x, y);
    rightClick(hit && msg.contains(hit) ? hit : msg, x, y);
    return waitForMenu();
  }

  async function messageAction(kind, msg) {
    const a = MSG_ACTIONS[kind];
    const btn = await revealButton(msg, a);
    if (btn) {
      if (a.thenType) allowFocus(3000);
      click(btn);
      if (a.done) toast(a.done);
      return;
    }
    const menu = await openMessageMenu(msg);
    if (!menu) return toast('Couldn’t open that message’s menu');
    if (!a.menuItem) return; // gm: leave it open, j / k / l drive it
    const item = [...menu.querySelectorAll('[role^=menuitem]')].find((i) => a.menuItem.test(accessibleName(i)));
    if (!item) {
      press('esc');
      return toast(`Can’t ${kind} that message`);
    }
    if (a.thenType) allowFocus(3000);
    click(item);
    if (a.done) toast(a.done);
  }

  function pickMessage(kind, which = 'any') {
    const sc = currentScroller() || document;
    const els = which === 'prompt' ? promptEls(sc) : messageEls(sc);
    const items = els.map((el) => ({ el, rect: visibleRect(el) })).filter((it) => it.rect);
    showHints(items, (m) => messageAction(kind, m), 'msg');
  }

  function copyLast() {
    const sc = currentScroller() || document;
    const chatCopy = sc.querySelectorAll('[data-testid="action-bar-copy"]');
    if (chatCopy.length) {
      click(chatCopy[chatCopy.length - 1]);
      return toast('Copied last reply');
    }
    const prompts = new Set(promptEls(sc).map((p) => p.closest(SEL.entry) || p));
    const replies = messageEls(sc).filter((m) => !prompts.has(m) && !m.querySelector(SEL.prompt) && visibleRect(m));
    if (!replies.length) return toast('No reply on screen');
    messageAction('copy', replies[replies.length - 1]);
  }

  // ---- overlay ---------------------------------------------------------------------
  // Everything Normal Mode draws lives in one element styled with the app's own
  // design tokens: it carries the app's `cds-root` class and copies its theme
  // attributes, so colors, fonts and light / dark follow the app.
  let root = null;
  let dock = null;

  function syncTheme(host) {
    const app = [...document.querySelectorAll('.cds-root')].find((n) => n !== host);
    for (const a of ['data-mode', 'data-density', 'data-font']) {
      const v = app?.getAttribute(a);
      if (v == null) host.removeAttribute(a);
      else if (host.getAttribute(a) !== v) host.setAttribute(a, v);
    }
  }

  function ui() {
    if (root?.host.isConnected) {
      syncTheme(root.host);
      return root;
    }
    const parent = document.body || document.documentElement;
    if (!parent) return null;
    const host = document.createElement('normal-mode');
    host.className = 'cds-root';
    host.style.setProperty('all', 'initial');
    root = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
    dock = make('div', 'dock');
    root.append(dock);
    parent.append(host);
    syncTheme(host);
    return root;
  }

  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // key chips: 'gg' → [g][g], '<C-w>v' → [Ctrl W][v]
  const KEY_LABELS = { Esc: 'Esc', CR: 'Enter', Tab: 'Tab', Space: 'Space', BS: 'Backspace' };
  function keyLabel(tok) {
    const m = /^<((?:[CAMS]-)*)(.+)>$/.exec(tok);
    if (!m) return tok;
    const mods = { 'C-': 'Ctrl', 'A-': 'Alt', 'M-': 'Super', 'S-': 'Shift' };
    const parts = (m[1].match(/[CAMS]-/g) || []).map((x) => mods[x]);
    return [...parts, KEY_LABELS[m[2]] ?? m[2].toUpperCase()].join(' ');
  }

  function chips(keys) {
    const span = make('span', 'keys');
    for (const tok of keys.match(/<[^>]+>|[^ ]/g) || []) span.append(make('kbd', null, keyLabel(tok)));
    return span;
  }

  let toastTimer = 0;
  function toast(text) {
    if (!ui()) return;
    dock.querySelector('.toast')?.remove();
    const t = make('div', 'card toast', text);
    dock.insertBefore(t, dock.querySelector('.pill'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 1800);
  }

  // ---- hints -------------------------------------------------------------------
  let hints = null;

  function labelsFor(n) {
    const cs = CONFIG.hintChars;
    let len = 1;
    while (cs.length ** len < n) len++;
    return Array.from({ length: n }, (_, i) => {
      let s = '';
      for (let j = 0, x = i; j < len; j++, x = Math.floor(x / cs.length)) s = cs[x % cs.length] + s;
      return s;
    });
  }

  function reachable(el, r) {
    const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 3, r.top + 3]];
    return pts.some(([x, y]) => {
      const hit = document.elementFromPoint(Math.min(x, innerWidth - 1), Math.min(y, innerHeight - 1));
      return hit && (hit === el || el.contains(hit));
    });
  }

  // strict: only things you could actually click right now (Vimium's rule).
  function collect(selector, { strict = true } = {}) {
    const out = [];
    const taken = new Map();
    for (const node of document.querySelectorAll(selector)) {
      if (node.disabled || node.getAttribute('aria-disabled') === 'true') continue;
      const r = visibleRect(node);
      if (!r || (strict && !reachable(node, r))) continue;
      // skip a clickable nested in another that covers the same box
      let dup = false;
      for (let p = node.parentElement; p && !dup; p = p.parentElement) {
        const pr = taken.get(p);
        dup = !!pr && Math.abs(pr.width - r.width) < 6 && Math.abs(pr.height - r.height) < 6;
      }
      if (dup) continue;
      taken.set(node, r);
      out.push({ el: node, rect: r });
    }
    return out;
  }

  const CHIP_H = 18;

  function showHints(items, onPick, kind = 'click') {
    endHints();
    if (!items.length) return toast('Nothing to pick');
    const r = ui();
    const box = make('div', `hints ${kind}`);
    const labels = labelsFor(items.length);
    hints = { box, typed: '', onPick, items: items.map((it, i) => ({ ...it, label: labels[i], node: null })) };
    for (const h of hints.items) {
      const { left, top, height } = h.rect;
      // centred on the left edge of rows and buttons; top-left corner of big blocks
      const y = kind === 'msg' || height > 44 ? top + 4 : top + (height - CHIP_H) / 2;
      h.node = make('span', 'chip');
      h.node.dataset.hint = h.label;
      h.node.style.left = `${Math.max(2, Math.min(left - 4, innerWidth - 30))}px`;
      h.node.style.top = `${Math.max(2, Math.min(y, innerHeight - CHIP_H - 2))}px`;
      box.append(h.node);
    }
    r.append(box);
    paintHints();
    paintMode();
  }

  function paintHints() {
    for (const h of hints.items) {
      const on = h.label.startsWith(hints.typed);
      h.node.hidden = !on;
      if (!on) continue;
      h.node.replaceChildren(make('span', 'typed', hints.typed), h.label.slice(hints.typed.length));
    }
  }

  function endHints() {
    hints?.box.remove();
    hints = null;
    paintMode();
  }

  function hintKey(tok) {
    if (tok === '<BS>') {
      hints.typed = hints.typed.slice(0, -1);
      return paintHints();
    }
    const ch = tok.length === 1 ? tok.toLowerCase() : '';
    if (!ch || !CONFIG.hintChars.includes(ch)) return endHints();
    hints.typed += ch;
    const left = hints.items.filter((h) => h.label.startsWith(hints.typed));
    if (!left.length) return endHints();
    if (left.length === 1 && left[0].label === hints.typed) {
      const { el: picked } = left[0];
      const pick = hints.onPick;
      endHints();
      return pick(picked);
    }
    paintHints();
  }

  const hintClick = (opts) => showHints(collect(SEL.clickable), (t) => click(t, opts), opts?.alt ? 'alt' : 'click');
  const hintHover = () => showHints(collect(SEL.clickable), hover, 'hover');

  // ---- sessions: sidebar, marks, back ----------------------------------------
  // Opening a session can put keyboard focus in its side pane (an artifact,
  // the browser, the terminal), where these keys don't reach. Right after a
  // switch made with these keys, focus comes back to the app page.
  let switchedAt = -1e9;
  let reclaims = 0;
  const switching = (fn) => (...args) => {
    switchedAt = performance.now();
    reclaims = 0;
    return fn(...args);
  };

  function reclaimFocus() {
    if (disabled || performance.now() - switchedAt > 2500 || reclaims >= 4) return false;
    const a = document.activeElement;
    if (a && (a.tagName === 'IFRAME' || a.tagName === 'WEBVIEW' || a.closest?.(SEL.raw))) {
      reclaims++;
      a.blur();
      return true;
    }
    if (!document.hasFocus() && ipc) {
      reclaims++;
      ipc.send('normal-mode', { type: 'focus' });
      return true;
    }
    return false;
  }

  const MARKS_KEY = 'normal-mode:marks';
  let curHref = location.href;
  let prevHref = null;
  const hrefTimer = setInterval(() => {
    if (location.href !== curHref) { prevHref = curHref; curHref = location.href; }
  }, 400);

  function loadMarks() {
    try { return JSON.parse(localStorage.getItem(MARKS_KEY)) || {}; } catch { return {}; }
  }

  function setMark(_n, ch) {
    if (!/^[a-z]$/i.test(ch)) return toast('Marks are a–z');
    const marks = loadMarks();
    marks[ch] = { href: location.href, title: document.title };
    try { localStorage.setItem(MARKS_KEY, JSON.stringify(marks)); } catch { /* storage blocked */ }
    toast(`Marked ${ch}: ${document.title}`);
  }

  function navigate(href) {
    const u = new URL(href, location.href);
    const link = [...document.querySelectorAll('a[href]')].find((a) => a.href === u.href);
    if (link) return click(link);
    history.pushState(history.state, '', u.pathname + u.search + u.hash);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }

  function jumpMark(_n, ch) {
    const href = ch === "'" ? prevHref : loadMarks()[ch]?.href;
    if (!href) return toast(ch === "'" ? 'No previous session yet' : `No mark ${ch}`);
    navigate(href);
  }

  // ---- moving sessions in the sidebar ----------------------------------------
  // The app keeps a manual order only for pinned sessions (project folders
  // sort by activity), through Move up / Move down in each row's right-click
  // menu. M moves the open session: j / k run those items with the menu kept
  // out of sight.
  const ROW = '[data-row-key]';
  let moving = null; // { key, busy }

  const rowByKey = (key) => [...document.querySelectorAll(ROW)]
    .find((r) => r.dataset.rowKey === key && r.querySelector('[data-row-main-button]'));

  // the open session's sidebar link: the app marks it aria-current on some
  // rows and data-selected="focused" on others; failing both, the link to this page
  function openSessionLink() {
    return document.querySelector('[data-row-main-button][aria-current="page"]') ||
      document.querySelector('[data-row-main-button][data-selected="focused"]') ||
      document.querySelector('[data-row][data-selected="focused"] [data-row-main-button]') ||
      [...document.querySelectorAll('[data-row-main-button][href]')].find((a) => {
        try { return new URL(a.href, location.href).pathname === location.pathname; } catch { return false; }
      });
  }

  function moveOpenSession() {
    const row = openSessionLink()?.closest(ROW);
    if (!row) {
      debugDump({ quiet: true, why: 'M found no open session row' });
      return toast('Couldn’t find the open session in the sidebar');
    }
    moving = { key: row.dataset.rowKey, busy: false };
    paintMode();
  }

  function endMoving() {
    moving = null;
    paintMode();
  }

  async function moveRow(dir) {
    if (moving.busy) return;
    const row = rowByKey(moving.key);
    if (!row) { endMoving(); return toast('That session is no longer in the sidebar'); }
    moving.busy = true;
    try {
      row.scrollIntoView({ block: 'nearest' });
      const main = row.querySelector('[data-row-main-button]') || row;
      const r = main.getBoundingClientRect();
      hideMenus(1500);
      rightClick(main, r.left + Math.min(40, r.width / 2), r.top + r.height / 2);
      const menu = await waitForMenu();
      if (!menu) return toast('Couldn’t open that session’s menu');
      const items = [...menu.querySelectorAll('[role^=menuitem]')];
      const item = (re) => items.find((i) => re.test(accessibleName(i)));
      // labels can carry a shortcut letter ("PinP"), so match how they start
      const step = item(dir < 0 ? /^move up/i : /^move down/i);
      if (step) {
        click(step);
      } else {
        press('esc');
        // unpinned sessions sit in project folders, which sort themselves
        const pinned = !item(/^pin(?!\s*as\b)/i);
        toast(!pinned ? 'Can’t reorder project folders · pin it first (sp)'
          : dir < 0 ? 'Already at the top' : 'Already at the bottom');
      }
      await sleep(80);
    } finally {
      // the right-click and click left the pointer parked over the sidebar,
      // hovering whichever row slid under it; take it away
      ipc?.send('normal-mode', { type: 'mouse', leave: true });
      if (moving) moving.busy = false;
    }
  }

  // keys while a row is picked: j / k move it, Enter / Esc finish, anything
  // else finishes and then does its usual job
  function moveKey(e, tok) {
    const dir = { j: 1, '<Down>': 1, k: -1, '<Up>': -1 }[tok];
    if (dir) {
      swallow(e);
      return moveRow(dir);
    }
    endMoving();
    if (['<CR>', '<Esc>', 'q', 'M'].includes(tok)) {
      swallow(e);
      return true;
    }
    return false;
  }

  function toggleSidebar() {
    const btn = document.querySelector(SEL.sidebarToggle);
    btn ? click(btn) : press(APP.sidebar);
  }

  // ---- debugging: g! writes the page's structure (no message text) ------------
  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    const r = el.getBoundingClientRect();
    const out = { tag: el.tagName.toLowerCase() };
    const cls = (el.className?.baseVal ?? el.className ?? '').toString();
    if (cls) out.cls = cls.slice(0, 140);
    for (const a of el.attributes) {
      if (a.name.startsWith('data-') || ['id', 'role', 'aria-label', 'tabindex', 'contenteditable'].includes(a.name)) {
        out[a.name] = a.value.slice(0, 60);
      }
    }
    out.rect = [r.left, r.top, r.width, r.height].map(Math.round);
    return out;
  }

  const chain = (el, stop) => {
    const out = [];
    for (let n = el; n && n !== stop && out.length < 25; n = n.parentElement) out.push(describe(n));
    return out;
  };

  function debugDump({ quiet = false, why = 'g!' } = {}) {
    const sc = currentScroller();
    const scope = sc || document;
    const prompts = promptEls(scope);
    const first = prompts.find((p) => visibleRect(p));
    const count = (sel) => scope.querySelectorAll(sel).length;
    const testids = {};
    const dataAttrs = {};
    for (const n of scope.querySelectorAll('*')) {
      for (const a of n.attributes) {
        if (a.name === 'data-testid') testids[a.value] = (testids[a.value] || 0) + 1;
        else if (a.name.startsWith('data-')) dataAttrs[a.name] = (dataAttrs[a.name] || 0) + 1;
      }
    }
    const data = {
      why,
      version: VERSION,
      at: new Date().toISOString(),
      path: location.pathname + location.hash,
      mode: context(activeEl()),
      config: CONFIG,
      active: chain(activeEl(), document.body).slice(0, 8),
      scrollers: scrollers().map((s) => ({
        ...describe(s), scrollTop: Math.round(s.scrollTop), scrollHeight: s.scrollHeight,
        clientHeight: s.clientHeight, chosen: s === sc,
      })),
      counts: { prompt: count(SEL.prompt), entry: count(SEL.entry), userMsg: count(SEL.userMsg), anyMsg: count(SEL.anyMsg) },
      firstVisiblePrompt: first && {
        chain: chain(first, sc),
        buttons: [...(first.closest(SEL.entry) || first).querySelectorAll('button,[role=button]')].map(describe),
      },
      composer: describe(composer()),
      sidebar: {
        rows: document.querySelectorAll('[data-row-key]').length,
        mainButtons: document.querySelectorAll('[data-row-main-button]').length,
        current: [...document.querySelectorAll('[aria-current]')].slice(0, 8).map(describe),
        selected: [...document.querySelectorAll('[data-selected]')].slice(0, 8).map((n) => ({ ...describe(n), chain: chain(n, document.body).slice(1, 6) })),
        firstRow: (() => {
          const b = document.querySelector('[data-row-main-button]');
          return b && chain(b, document.body).slice(0, 8);
        })(),
      },
      theme: describe([...document.querySelectorAll('.cds-root')].find((n) => n.tagName !== 'CLAUDE-VIM')),
      menus: [...document.querySelectorAll('[role=menu]')].map((m) => ({
        ...describe(m), items: [...m.querySelectorAll('[role^=menuitem]')].map((i) => accessibleName(i).slice(0, 40)),
      })),
      buttonLabels: [...new Set([...document.querySelectorAll('button[aria-label],[role=button][aria-label]')]
        .filter((b) => visibleRect(b)).map((b) => b.getAttribute('aria-label')))].slice(0, 120),
      testids,
      dataAttrs,
    };
    if (ipc) {
      ipc.send('normal-mode', { type: 'debug', data });
      if (!quiet) toast('Wrote normal-mode-debug.json to the temp folder');
    } else {
      console.log('[normal-mode] debug', data);
      if (!quiet) toast('Debug info is in the console');
    }
  }

  function reloadPage() {
    ipc?.send('normal-mode', { type: 'reload' });
    location.reload();
  }

  // ---- the keymap -------------------------------------------------------------
  // map(keys, group, description, action, options)
  //   keys: vim notation, e.g. 'gg', '<C-w>h', 'G'
  //   action(count, char, event) runs the binding; return PASS to let the key through
  //   { repeat: true }  keeps firing while the key is held
  //   { arg: true }     waits for one more character, passed as action(count, char)
  //   { show: 'j k', as: 'Scroll' }  how the cheat sheet lists it (space: alternatives,
  //                                  'm+a–z': key then range); { show: false } leaves it out
  const MAP = [];
  const tokens = (keys) => keys.match(/<[^>]+>|./g);
  const map = (keys, group, desc, fn, opts = {}) => MAP.push({ keys: tokens(keys), raw: keys, group, desc, fn, ...opts });
  const times = (fn) => (n) => { for (let i = 0; i < n; i++) fn(); };
  const hidden = { show: false };

  map('j', 'Move', 'Scroll down', (n, _c, e) => scrollKey(1, n, e), { repeat: true, show: 'j k', as: 'Scroll down / up' });
  map('k', 'Move', 'Scroll up', (n, _c, e) => scrollKey(-1, n, e), { repeat: true, ...hidden });
  map('d', 'Move', 'Half page down', (n) => glideBy(halfPage() * n), { show: 'd u', as: 'Half page down / up' });
  map('u', 'Move', 'Half page up', (n) => glideBy(-halfPage() * n), hidden);
  map('gg', 'Move', 'Top', () => glideToEdge(-1), { show: 'gg G', as: 'Top / bottom' });
  map('G', 'Move', 'Bottom', () => glideToEdge(1), hidden);
  map('{', 'Move', 'Previous prompt', (n) => jumpPrompt(-1, n), { show: '{ }', as: 'Previous / next prompt' });
  map('}', 'Move', 'Next prompt', (n) => jumpPrompt(1, n), hidden);

  map('f', 'Click', 'Click something', () => hintClick());
  map('F', 'Click', 'Open in split view', () => hintClick({ alt: true }));
  map('gh', 'Click', 'Hover something', hintHover);

  map('e', 'Messages', 'Edit a prompt (rewinds to it)', () => pickMessage('rewind', 'prompt'));
  map('E', 'Messages', 'Rewind picker', () => inComposer('esc esc', { stay: true }));
  map('gF', 'Messages', 'Fork from a message', () => pickMessage('fork'));
  map('gm', 'Messages', 'Message menu', () => pickMessage('menu'));
  map('yy', 'Messages', 'Copy the reply on screen', copyLast);
  map('yf', 'Messages', 'Copy a message', () => pickMessage('copy'));
  map('yl', 'Messages', 'Copy session link', () => press(APP.copyLink));

  map('i', 'Composer', 'Type', () => focusComposer('keep'));
  map('a', 'Composer', 'Type at the end', () => focusComposer('end'));
  map('I', 'Composer', 'Type at the start', () => focusComposer('start'), hidden);
  map('<C-c>', 'Composer', 'Stop Claude', stopOrCopy);
  map('cm', 'Composer', 'Model', () => press(APP.modelMenu));
  map('co', 'Composer', 'Permission mode', () => press(APP.modeMenu));
  map('ce', 'Composer', 'Effort', () => press(APP.effortMenu));
  map('cf', 'Composer', 'Fast mode', () => press(APP.fastMode));

  map('J', 'Sessions', 'Next session', switching(times(() => press(APP.nextSession))), { repeat: true, show: 'J K', as: 'Next / previous session' });
  map('K', 'Sessions', 'Previous session', switching(times(() => press(APP.prevSession))), { repeat: true, ...hidden });
  map('gt', 'Sessions', 'Next session', switching(times(() => press(APP.nextSession))), hidden);
  map('gT', 'Sessions', 'Previous session', switching(times(() => press(APP.prevSession))), hidden);
  for (let i = 1; i <= 9; i++) {
    map(`g${i}`, 'Sessions', 'Go to session', switching(() => press(APP.jumpSession(i))),
      i === 1 ? { show: 'g+1–9', as: 'Go to session 1–9', range: '1–9' } : { show: false, folded: true });
  }
  map('o', 'Sessions', 'New session', () => { allowFocus(2500); press(APP.newSession); });
  map('M', 'Sessions', 'Move this session (then j / k)', moveOpenSession);
  map('x', 'Sessions', 'Close session', switching(() => press(APP.close)), { show: 'x X', as: 'Close / reopen session' });
  map('X', 'Sessions', 'Reopen closed session', switching(() => press(APP.reopen)), hidden);
  map('/', 'Sessions', 'Search sessions', () => press(APP.search));
  map(':', 'Sessions', 'Command palette', () => press(APP.commandPalette));
  map('m', 'Sessions', 'Mark this session', setMark, { arg: true, show: 'm+a–z' });
  map("'", 'Sessions', "Go to mark ('' goes back)", switching(jumpMark), { arg: true, show: "'+a–z" });

  map('sf', 'This session', 'Fork', () => press(APP.fork));
  map('sr', 'This session', 'Rename', () => press(APP.rename));
  map('sp', 'This session', 'Pin / unpin', () => press(APP.pin));
  map('sa', 'This session', 'Archive', () => press(APP.archive));
  map('su', 'This session', 'Mark read / unread', () => press(APP.unread));
  map('sg', 'This session', 'Open PR', () => press(APP.openPR));

  map('H', 'Panes', 'Previous split', () => press(APP.prevPane), { show: 'H L', as: 'Previous / next split' });
  map('L', 'Panes', 'Next split', () => press(APP.nextPane), hidden);
  map('<C-w>h', 'Panes', 'Previous split', () => press(APP.prevPane), hidden);
  map('<C-w>l', 'Panes', 'Next split', () => press(APP.nextPane), hidden);
  map('<C-w>v', 'Panes', 'Split right', () => press(APP.splitRight));
  map('<C-w>s', 'Panes', 'Split below', () => press(APP.splitBelow));
  map('<C-w>q', 'Panes', 'Close pane', () => press(APP.closePane));
  map('<C-w>o', 'Panes', 'Expand pane', () => press(APP.expandPane));
  map('<C-w>w', 'Panes', 'Next region', () => press(APP.nextRegion));

  map('tt', 'Toggle', 'Terminal', () => press(APP.terminal));
  map('td', 'Toggle', 'Changes', () => press(APP.diff));
  map('tl', 'Toggle', 'Changed files list', () => press(APP.diffFileList));
  map('tb', 'Toggle', 'Browser', () => press(APP.preview));
  map('tf', 'Toggle', 'Files', () => press(APP.files));
  map('tc', 'Toggle', 'Side chat', () => press(APP.sideChat));
  map('ts', 'Toggle', 'Sidebar', toggleSidebar);
  map('tv', 'Toggle', 'Transcript view', () => press(APP.transcriptView));
  map(']c', 'Toggle', 'Next change', times(() => press(APP.nextChange)), { show: ']c [c', as: 'Next / previous change' });
  map('[c', 'Toggle', 'Previous change', times(() => press(APP.prevChange)), hidden);
  map('gf', 'Toggle', 'Go to file', () => press(APP.goToFile));

  map('?', 'Help', 'These keys', () => toggleHelp());
  map('g?', 'Help', 'The app’s own shortcuts', () => press(APP.shortcuts));
  map('gR', 'Help', 'Reload Normal Mode', reloadPage);
  map('g!', 'Help', 'Write debug info', () => debugDump());

  // shown on the cheat sheet only; handled outside the keymap
  const ELSEWHERE = [
    ['<Esc>', 'Leave the composer'],
    ['<A-Esc>', 'Out of a side pane'],
    ['<C-j> <C-k>', 'Move in suggestions'],
    ['j k l h', 'In menus'],
    ['<C-A-v>', 'Turn vim keys off / on'],
  ];

  // In an open menu that has focus; other keys go to the menu (type-ahead).
  const MENU_KEYS = {
    j: 'down', k: 'up', l: 'enter', h: 'esc', q: 'esc', g: 'home', G: 'end',
    '<C-j>': 'down', '<C-k>': 'up', '<C-n>': 'down', '<C-p>': 'up',
  };
  // In a focused tree or grid (e.g. a sidebar list); other keys stay normal mode.
  const LIST_NAV = { j: 'down', k: 'up', l: 'enter', h: 'left' };
  // While typing, when a suggestion list is open (slash commands, @-mentions, palettes).
  const LIST_KEYS = { '<C-j>': 'down', '<C-k>': 'up', '<C-n>': 'down', '<C-p>': 'up' };

  // ---- key handling --------------------------------------------------------------
  let disabled = false;
  let pending = [];
  let count = '';
  let argFor = null;
  let whichTimer = 0;
  const swallowedUps = new Set();

  const SPECIAL = {
    Escape: 'Esc', Enter: 'CR', Tab: 'Tab', Backspace: 'BS', ' ': 'Space', Delete: 'Del',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  };
  const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Dead', 'Unidentified', 'Process']);

  function keyName(e) {
    if (MODIFIER_KEYS.has(e.key)) return null;
    const named = SPECIAL[e.key] ?? (e.key.length > 1 ? e.key : null);
    const mods = (e.ctrlKey ? 'C-' : '') + (e.altKey ? 'A-' : '') + (e.metaKey ? 'M-' : '') +
      (named && e.shiftKey ? 'S-' : '');
    const k = named ?? (e.shiftKey && /^[a-z]$/.test(e.key) ? e.key.toUpperCase() : e.key);
    return mods || named ? `<${mods}${k}>` : k;
  }

  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const startsWith = (a, prefix) => prefix.length < a.length && prefix.every((x, i) => x === a[i]);

  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    swallowedUps.add(e.code || e.key);
  }

  function resetPending() {
    pending = [];
    count = '';
    argFor = null;
    clearTimeout(whichTimer);
    closePanel('which');
    paintMode();
  }

  // the key goes through to the app as usual; once the prompt has actually
  // gone (the composer empties), drop back to normal mode
  function afterSend(el) {
    if (!el.textContent.trim()) return;
    let tries = 0;
    const check = () => {
      const now = el.isConnected ? el : activeEl();
      if (now && now.textContent.trim()) {
        if (++tries < 15) setTimeout(check, 40);
        return;
      }
      const a = activeEl();
      if (a && isComposer(a)) leaveInsert(a);
      else paintMode();
    };
    setTimeout(check, 20);
  }

  function leaveInsert(el) {
    el.blur?.();
    getSelection()?.removeAllRanges();
    focusIntentUntil = 0;
    paintMode();
  }

  function run(binding, e, arg) {
    const n = Math.max(1, parseInt(count, 10) || 1);
    resetPending();
    let result;
    try { result = binding.fn(n, arg, e); } catch (err) { console.error('[normal-mode]', binding.raw, err); }
    if (result === PASS) return;
    swallow(e);
  }

  function context(el) {
    if (hints) return 'hint';
    if (disabled) return 'off';
    if (moving) return 'move';
    if (el?.tagName === 'IFRAME' || el?.closest?.(SEL.raw)) return 'pass';
    if (isEditable(el)) return 'insert';
    if (el?.closest?.(SEL.menu)) return 'menu';
    if (el?.closest?.(SEL.list)) return 'list';
    return 'normal';
  }

  const openList = () => [...document.querySelectorAll('[role=listbox],[role=menu]')].some((n) => visibleRect(n));

  function onKeyDown(e) {
    if (synthDepth || e.isComposing) return;
    refocusFights = 0;
    if (sentByUs(e)) return;
    const tok = keyName(e);
    if (!tok) return;
    if (tok === '<Tab>' || tok === '<S-Tab>') tabAt = performance.now();

    // works everywhere: turn the whole layer on and off
    if (tok === '<C-A-v>') {
      disabled = !disabled;
      resetPending();
      endHints();
      if (moving) endMoving();
      closePanel();
      toast(disabled ? 'Vim keys off' : 'Vim keys on');
      paintMode();
      return swallow(e);
    }

    const el = activeEl();
    const ctx = context(el);
    if (ctx === 'off') return;
    if (ctx === 'hint') { swallow(e); return hintKey(tok); }
    if (ctx === 'move' && moveKey(e, tok)) return;

    if (ctx === 'pass' || ctx === 'insert') {
      if (tok === '<A-Esc>' || (ctx === 'insert' && tok === '<Esc>' && !openList())) {
        swallow(e);
        return leaveInsert(el);
      }
      if (ctx === 'insert' && LIST_KEYS[tok] && openList()) {
        swallow(e);
        return press(LIST_KEYS[tok]);
      }
      // Enter sends (Shift+Enter is a new line; Enter in a suggestion list picks)
      if (ctx === 'insert' && CONFIG.normalAfterSend && e.key === 'Enter' && !e.shiftKey && isComposer(el) && !openList()) {
        afterSend(el);
      }
      return;
    }

    if (ctx === 'menu') {
      if (!MENU_KEYS[tok]) return;
      swallow(e);
      return press(MENU_KEYS[tok]);
    }
    if (ctx === 'list' && !pending.length && !count && LIST_NAV[tok]) {
      swallow(e);
      return press(LIST_NAV[tok]);
    }

    normalKey(e, tok);
  }

  function normalKey(e, tok) {
    if (argFor) {
      const b = argFor;
      if (tok.length === 1) return run(b, e, tok);
      resetPending();
      return swallow(e);
    }

    if (panel?.kind === 'help' && !pending.length) {
      const step = { j: 60, k: -60, d: 300, u: -300 }[tok];
      if (step) { panel.scroller.scrollTop += step; return swallow(e); }
      if (tok === 'q' || tok === '?') { closePanel(); return swallow(e); }
    }

    if (tok === '<Esc>' && (pending.length || count || panel)) {
      resetPending();
      closePanel();
      return swallow(e);
    }

    if (!pending.length && /^[0-9]$/.test(tok) && (count || tok !== '0')) {
      count += tok;
      paintMode();
      return swallow(e);
    }

    const seq = [...pending, tok];
    const exact = MAP.find((b) => same(b.keys, seq));
    if (exact) {
      if (e.repeat && !exact.repeat) return swallow(e);
      if (exact.arg) {
        argFor = exact;
        pending = seq;
        paintMode();
        return swallow(e);
      }
      return run(exact, e);
    }
    if (MAP.some((b) => startsWith(b.keys, seq))) {
      pending = seq;
      clearTimeout(whichTimer);
      whichTimer = setTimeout(showWhichKey, CONFIG.whichKeyDelay);
      paintMode();
      return swallow(e);
    }

    const hadPending = pending.length > 0;
    resetPending();
    // unmapped plain characters are eaten so they can't leak into the composer;
    // anything with Ctrl/Alt (and Enter, Tab, arrows...) still reaches the app
    if (hadPending || tok.length === 1) swallow(e);
  }

  function onKeyUp(e) {
    releaseKey(e.code);
    const k = e.code || e.key;
    if (!swallowedUps.has(k)) return;
    swallowedUps.delete(k);
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onFocusIn(e) {
    const t = e.target;
    lastTarget = t;
    if (reclaimFocus()) return;
    // every session you open focuses the composer once; that's undone. If the
    // app keeps grabbing it back with nothing in between, it's a loop: give up
    // until the next key or click.
    if (CONFIG.startInNormal && !disabled && isComposer(t) && !focusWanted(t) && refocusFights < 8) {
      refocusFights++;
      t.blur();
    }
    paintMode();
  }

  function onPointerDown(e) {
    lastTarget = e.target;
    refocusFights = 0;
    if (e.isTrusted) lastPress = { t: performance.now(), x: e.clientX, y: e.clientY };
    if (hints && e.isTrusted) endHints();
  }

  function onMouseMove(e) { lastPointer = { x: e.clientX, y: e.clientY }; }
  function onScroll() { if (hints) endHints(); }
  function onBlur() {
    releaseKey();
    setTimeout(reclaimFocus, 30); // focus went to another view (artifact, browser)
  }

  // ---- mode indicator, which-key, cheat sheet --------------------------------------
  // The indicator stays out of the way in normal mode and shows what vim would
  // show: the mode when it isn't normal, and keys typed so far (counts, prefixes).
  const MODE_LABELS = { insert: 'INSERT', hint: 'HINT', move: 'MOVE  j k  ↵', pass: 'PASSTHROUGH', off: 'VIM OFF' };

  function paintMode() {
    const r = ui();
    if (!r) return;
    const ctx = context(activeEl());
    r.host.dataset.vimMode = ctx; // data-mode is the app's theme, copied by syncTheme
    if (!CONFIG.indicator) return;
    let pill = dock.querySelector('.pill');
    if (!pill) { pill = make('div', 'card pill'); dock.append(pill); }
    const keys = `${count}${pending.map(keyLabel).join('')}`;
    const label = keys || MODE_LABELS[ctx] || (CONFIG.indicator === 'always' ? 'NORMAL' : '');
    pill.hidden = !label;
    pill.classList.toggle('keys', !!keys);
    pill.textContent = label;
  }

  let panel = null;
  function closePanel(kind) {
    if (!panel || (kind && panel.kind !== kind)) return;
    panel.node.remove();
    panel = null;
  }

  function showWhichKey() {
    if (!pending.length) return;
    const next = MAP.filter((b) => startsWith(b.keys, pending) && !b.folded);
    if (!next.length) return;
    closePanel();
    const box = make('div', 'card menu');
    for (const b of next) {
      const row = make('div', 'row');
      const keys = b.range ? make('span', 'range', b.range) : chips(b.keys.slice(pending.length).join(''));
      row.append(make('span', 'label', b.desc), keys);
      box.append(row);
    }
    dock.insertBefore(box, dock.firstChild);
    panel = { kind: 'which', node: box };
  }

  function toggleHelp() {
    if (panel?.kind === 'help') return closePanel();
    closePanel();
    ui();
    const shade = make('div', 'shade');
    const dialog = make('div', 'dialog');
    const head = make('div', 'head');
    head.append(make('div', 'title', 'Vim keys'), make('div', 'sub', `Normal Mode ${VERSION} · j k to scroll · Esc to close`));
    const body = make('div', 'body');
    const section = (title, rows) => {
      const sec = make('section');
      sec.append(make('h3', null, title));
      for (const [keys, desc] of rows) {
        const row = make('div', 'row');
        const alts = make('span', 'alts');
        // 'j k' are alternatives, 'gg' a sequence, 'm a…z' a key and its argument
        keys.split(' ').forEach((alt, i) => {
          if (i) alts.append(make('span', 'or', '/'));
          alts.append(chipsFor(alt));
        });
        row.append(make('span', 'label', desc), alts);
        sec.append(row);
      }
      return sec;
    };
    const groups = [...new Set(MAP.map((b) => b.group))];
    for (const g of groups) {
      const rows = MAP.filter((b) => b.group === g && b.show !== false).map((b) => [b.show || b.raw, b.as || b.desc]);
      body.append(section(g, rows));
    }
    body.append(section('Anywhere', ELSEWHERE.map(([k, d]) => [k, d])));
    dialog.append(head, body);
    shade.append(dialog);
    shade.addEventListener('pointerdown', (ev) => { if (ev.target === shade) closePanel(); });
    root.append(shade);
    panel = { kind: 'help', node: shade, scroller: body };
  }

  // one alternative from a cheat-sheet entry: 'gg' → [g][g], '<C-w>v' → [Ctrl W][v],
  // 'm+a–z' → [m] a–z (a key, then any of a range)
  function chipsFor(alt) {
    const [keys, range] = alt.split('+');
    const out = chips(keys);
    if (range) out.append(make('span', 'range', range));
    return out;
  }

  const CSS = `
    :host {
      --cv-font: var(--cds-font-sans, ui-sans-serif, system-ui, sans-serif);
      --cv-mono: var(--cds-font-mono, ui-monospace, monospace);
      --cv-bg: var(--cds-surface-2, #fff);
      --cv-bg-sunk: var(--cds-surface-1, #f5f4ef);
      --cv-text: var(--cds-text-primary, #1f1e1d);
      --cv-muted: var(--cds-text-muted, #73726c);
      --cv-line: var(--cds-border-strong, rgba(31, 30, 29, .15));
      --cv-shadow: var(--cds-shadow-popover, 0 8px 24px rgba(0, 0, 0, .12), 0 2px 6px rgba(0, 0, 0, .08));
      --cv-accent: var(--cds-clay, #d97757);
      --cv-ease: var(--cds-ease-out, cubic-bezier(.165, .84, .44, 1));
      --cv-fast: var(--cds-dur-snap, .12s);
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .dock {
      position: fixed; right: 14px; bottom: 12px; z-index: 2147483646; pointer-events: none;
      display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
      font: 13px/1.4 var(--cv-font); color: var(--cv-text);
    }
    .card {
      background: var(--cv-bg); border: 1px solid var(--cv-line); border-radius: 8px;
      box-shadow: var(--cv-shadow); animation: cv-in var(--cv-fast) var(--cv-ease);
    }
    .pill {
      padding: 2px 8px; font: 500 11px/18px var(--cv-mono); letter-spacing: .04em;
      color: var(--cv-muted); box-shadow: none;
    }
    .pill.keys { color: var(--cv-accent); letter-spacing: .02em; }
    .toast { padding: 6px 10px; font-size: 12.5px; }

    .menu { min-width: 220px; padding: 4px; border-radius: 10px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
    .menu .row { padding: 4px 8px; border-radius: 6px; min-height: 28px; }
    .label { white-space: nowrap; }
    .keys { display: inline-flex; gap: 3px; }
    kbd {
      min-width: 18px; padding: 0 5px; border: 1px solid var(--cv-line); border-radius: 4px;
      background: var(--cv-bg-sunk); color: var(--cv-muted); text-align: center;
      font: 500 11px/17px var(--cv-mono);
    }
    .range { color: var(--cv-muted); font: 500 11px/17px var(--cv-mono); }

    .hints { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
    .chip {
      position: fixed; height: ${CHIP_H}px; padding: 0 5px; border-radius: 5px;
      font: 600 11px/${CHIP_H}px var(--cv-mono); letter-spacing: .03em; text-transform: uppercase;
      background: var(--cv-accent); color: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
      animation: cv-pop var(--cv-fast) var(--cv-ease);
    }
    .hints.alt .chip { background: var(--cv-text); color: var(--cv-bg); }
    .hints.hover .chip { background: var(--cv-bg); color: var(--cv-accent); border: 1px solid var(--cv-accent); }
    .chip .typed { opacity: .45; }

    .shade {
      position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
      background: rgba(0, 0, 0, .28); animation: cv-fade var(--cv-fast) var(--cv-ease);
      font: 13px/1.4 var(--cv-font); color: var(--cv-text);
    }
    .dialog {
      width: min(920px, 92vw); max-height: 82vh; display: flex; flex-direction: column;
      background: var(--cv-bg); border: 1px solid var(--cv-line); border-radius: 14px;
      box-shadow: var(--cds-shadow-lg, var(--cv-shadow)); animation: cv-in var(--cv-fast) var(--cv-ease);
    }
    .head { padding: 18px 22px 10px; display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    .title { font-size: 15px; font-weight: 600; }
    .sub { color: var(--cv-muted); font-size: 12px; }
    .body { overflow: auto; padding: 4px 22px 20px; columns: 3 250px; column-gap: 28px; }
    section { break-inside: avoid; padding-top: 10px; }
    h3 { margin: 0 0 4px; font-size: 12px; font-weight: 500; color: var(--cv-muted); }
    section .row { min-height: 24px; }
    section .label { color: var(--cv-text); overflow: hidden; text-overflow: ellipsis; }
    .alts { display: inline-flex; gap: 4px; align-items: center; flex: none; }
    .or { color: var(--cv-muted); opacity: .6; font-size: 11px; }

    @keyframes cv-in { from { opacity: 0; transform: translateY(4px); } }
    @keyframes cv-pop { from { opacity: 0; transform: scale(.85); } }
    @keyframes cv-fade { from { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  `;

  // ---- wire up -------------------------------------------------------------------
  const opts = { capture: true };
  window.addEventListener('keydown', onKeyDown, opts);
  window.addEventListener('keyup', onKeyUp, opts);
  window.addEventListener('focusin', onFocusIn, opts);
  window.addEventListener('focusout', paintMode, opts);
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  window.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', endHints);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintMode, { once: true });
  else paintMode();
  ipc?.send('normal-mode', { type: 'hello' }); // lets the bridge know which page is the app

  window.__normalMode = {
    VERSION, MAP, APP, CONFIG, motion,
    destroy() {
      window.removeEventListener('keydown', onKeyDown, opts);
      window.removeEventListener('keyup', onKeyUp, opts);
      window.removeEventListener('focusin', onFocusIn, opts);
      window.removeEventListener('focusout', paintMode, opts);
      window.removeEventListener('pointerdown', onPointerDown, opts);
      window.removeEventListener('mousemove', onMouseMove, opts);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', endHints);
      window.removeEventListener('scroll', onScroll, opts);
      clearInterval(hrefTimer);
      haltMotion();
      root?.host.remove();
    },
  };
})();
