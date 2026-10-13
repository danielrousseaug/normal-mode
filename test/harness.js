// Runs Normal Mode against test/mock.html in a real, offscreen Electron, the
// way the app runs it: main.js registers the preload and the IPC bridge, the
// page is served as app://localhost, and keys arrive as real input events.
//   electron --no-sandbox test/harness.js [scenario ...]
'use strict';

const { app, BrowserWindow, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
app.setPath('userData', process.env.HARNESS_DATA || path.join(require('os').tmpdir(), 'normal-mode-harness'));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
require(path.join(ROOT, 'src/main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code);

// 'j', 'G', '{', '<C-w>', '<Esc>', '<A-Esc>'
function parse(k) {
  const m = /^<((?:[CAS]-)*)(.+)>$/.exec(k);
  const mods = [];
  let key = k;
  if (m) {
    if (m[1].includes('C-')) mods.push('control');
    if (m[1].includes('A-')) mods.push('alt');
    if (m[1].includes('S-')) mods.push('shift');
    key = { Esc: 'Escape', CR: 'Enter', BS: 'Backspace' }[m[2]] ?? m[2];
  } else if (/^[A-Z]$/.test(k)) {
    mods.push('shift');
  }
  return { key, mods };
}

async function press(keys, { hold = 0, gap = 40 } = {}) {
  for (const k of keys.match(/<[^>]+>|./g)) {
    const { key, mods } = parse(k);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods });
    if (key.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers: mods });
    for (let t = 0; t < hold; t += 33) {
      await sleep(33);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: [...mods, 'isAutoRepeat'] });
    }
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
    await sleep(gap);
  }
}

// one key at a time, for overlapping presses (hold j, press k, release j)
function keyDown(k, repeat = false) {
  const { key, mods } = parse(k);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: repeat ? [...mods, 'isAutoRepeat'] : mods });
}
function keyUp(k) {
  const { key, mods } = parse(k);
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
}
async function holdFor(k, ms) {
  for (let t = 0; t < ms; t += 33) {
    await sleep(33);
    keyDown(k, true);
  }
}

const state = () => js(`(() => {
  const sc = document.getElementById('sc');
  const host = document.querySelector('normal-mode');
  return {
    mode: host?.dataset.vimMode,
    active: document.activeElement.id || document.activeElement.tagName,
    top: Math.round(sc.scrollTop),
    fromBottom: Math.round(sc.scrollHeight - sc.clientHeight - sc.scrollTop),
    hash: location.hash,
    log: document.getElementById('log').textContent.split('\\n').filter(Boolean).slice(0, 3),
  };
})()`);

// per-frame scroll positions while fn runs
async function record(fn, settle = 400) {
  await js(`window.__rec = []; window.__recOn = true;
    (function f() { __rec.push(document.getElementById('sc').scrollTop); if (__recOn) requestAnimationFrame(f); })(); 1`);
  await fn();
  await sleep(settle);
  const frames = await js('window.__recOn = false; __rec');
  const d = frames.slice(1).map((v, i) => Math.round((v - frames[i]) * 10) / 10);
  const moving = d.filter((x) => x !== 0);
  const flips = moving.slice(1).filter((x, i) => Math.sign(x) !== Math.sign(moving[i])).length;
  return { frames: frames.length, distance: Math.round(frames.at(-1) - frames[0]), flips, deltas: d.join(' ') };
}

async function load(query = '', { scrollInput } = {}) {
  await win.loadURL(`app://localhost/test/mock.html${query}`);
  if (scrollInput) {
    await js(`localStorage.setItem('normal-mode:scrollInput', '${scrollInput}'); 1`);
    await win.loadURL(`app://localhost/test/mock.html${query}`);
  } else {
    await js(`localStorage.removeItem('normal-mode:scrollInput'); 1`);
  }
  win.focus(); // offscreen windows get no keyboard focus by themselves
  win.webContents.focus();
  await sleep(400);
}

const hintFor = (text) => js(`(() => {
  const hints = [...document.querySelector('normal-mode').shadowRoot.querySelectorAll('[data-hint]')];
  const target = [...document.querySelectorAll('a,button,[data-take-back-entry],[data-epitaxy-entry]')]
    .find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)}));
  if (!target) return null;
  const r = target.getBoundingClientRect();
  let best = null;
  for (const h of hints) {
    const hr = h.getBoundingClientRect();
    const d = Math.hypot(hr.left - r.left, hr.top - r.top);
    if (!best || d < best.d) best = { d, label: h.dataset.hint };
  }
  return best && best.label;
})()`);

const SHOTS = process.env.SHOTS || path.join(require('os').tmpdir(), 'normal-mode-shots');
async function shot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), img.toPNG());
}

const SCENARIOS = {
  async shots() {
    for (const mode of ['light', 'dark']) {
      await load(`?${mode}`);
      await press('f');
      await sleep(300);
      await shot(`${mode}-hints`);
      await press('<Esc>');
      await press('g');
      await sleep(600);
      await shot(`${mode}-whichkey`);
      await press('<Esc>');
      await press('?');
      await sleep(300);
      await shot(`${mode}-help`);
      await press('<Esc>');
      await press('i');
      await sleep(200);
      await shot(`${mode}-insert`);
      await press('<Esc>');
      await press('yy');
      await sleep(500);
      await shot(`${mode}-toast`);
      await js(`location.hash = '#/s2'; 1`);
      await sleep(200);
      await press('M');
      await sleep(200);
      await shot(`${mode}-move`);
      await press('<Esc>');
    }
    return SHOTS;
  },

  async startsNormal() {
    await load();
    const s1 = await state();
    await js(`location.hash = '#/s2'; 1`);
    await sleep(200);
    return { onLoad: s1.mode, afterOpeningSession: (await state()).mode };
  },

  async tap() {
    await load();
    await js(`document.getElementById('sc').scrollTop = 2000; 1`);
    await sleep(200);
    return record(() => press('j'));
  },

  // one speed: the per-frame step should be flat from start to release
  async hold() {
    await load();
    const r = await record(() => press('j', { hold: 900 }), 300);
    const d = r.deltas.split(' ').map(Number).filter((x) => x > 0);
    const mid = d.slice(4, -4);
    return { ...r, steadyMin: Math.min(...mid), steadyMax: Math.max(...mid) };
  },

  // hold j, press k without letting go, then release j: frames from the last
  // step down to the first step up
  async reverse() {
    await load();
    await js(`document.getElementById('sc').scrollTop = 3000; 1`);
    await sleep(200);
    const r = await record(async () => {
      keyDown('j');
      await holdFor('j', 400);
      keyDown('k');
      await sleep(20);
      keyUp('j');
      await holdFor('k', 400);
      keyUp('k');
    }, 300);
    const d = r.deltas.split(' ').map(Number);
    const lastDown = d.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0).filter((i) => i < d.findIndex((x) => x < 0)).pop();
    const firstUp = d.findIndex((x) => x < 0);
    return { framesToTurn: firstUp - lastDown, deltas: r.deltas };
  },

  async halfPage() {
    await load();
    return record(() => press('d'), 600);
  },

  // scroll up from the bottom while a reply streams in
  async bottomThenUp() {
    await load('?stream');
    await press('G');
    await sleep(800);
    const atBottom = await state();
    const r = await record(() => press('k', { hold: 500 }), 500);
    const after = await state();
    return { pinnedAtBottom: atBottom.fromBottom, flips: r.flips, endFromBottom: after.fromBottom };
  },

  // holding J switches sessions; no J may reach the page or the composer
  async holdJ() {
    await load();
    await js(`window.__J = 0; document.addEventListener('keydown', (e) => { if (e.key === 'J') __J++; }); 1`);
    await press('J', { hold: 1200 });
    await sleep(300);
    const s = await state();
    return { jReachedPage: await js('__J'), composer: await js(`document.getElementById('composer').textContent`), mode: s.mode, opened: s.log.filter((l) => l.startsWith('OPEN')).length };
  },

  // M moves the open session: a session in a project folder can't move; a pinned one can
  async moveSession() {
    const toastText = () => js(`document.querySelector('normal-mode').shadowRoot.querySelector('.toast')?.textContent ?? ''`);
    const order = () => js('pinnedRows.join(" ")');
    const steps = [];
    await load();
    await js(`location.hash = '#/s2'; 1`);
    await sleep(200);
    await press('M');
    await press('k');
    await sleep(500);
    steps.push(`s2 k: ${await order()} | ${await toastText()}`);
    await press('<Esc>');
    await js(`location.hash = '#/s1'; 1`);
    await sleep(200);
    await press('M');
    for (const k of ['k', 'k', 'j']) {
      await press(k);
      await sleep(500);
      steps.push(`s1 ${k}: ${await order()} | ${await toastText()}`);
    }
    const hoveredRows = await js(`document.querySelectorAll('[data-row-key]:hover').length`);
    await press('<CR>');
    await sleep(100);
    return { steps, hoveredRows, after: (await state()).mode, menusLeftOpen: await js(`document.querySelectorAll('[role=menu]').length`) };
  },

  // J into a session whose side pane grabs focus, then J again
  async paneSteal() {
    await load('?pane');
    await js(`location.hash = '#/s1'; 1`);
    await sleep(200);
    await press('J');
    await sleep(400);
    const landed = await state();
    const activeTag = await js('document.activeElement.tagName');
    await press('J');
    await sleep(400);
    return { landedOn: landed.hash, mode: landed.mode, activeTag, afterSecondJ: (await state()).hash };
  },

  async edges() {
    await load('?tall');
    const total = await js(`document.getElementById('sc').scrollHeight`);
    const down = await record(() => press('G'), 1500);
    const atBottom = (await state()).fromBottom;
    await press('gg');
    await sleep(1500);
    return { total, atBottom, backAtTop: (await state()).top, lastFrames: down.deltas.split(' ').slice(-30).join(' ') };
  },

  async fToSession() {
    await load();
    await press('f');
    await sleep(100);
    const label = await hintFor('Session two');
    await press(label);
    await sleep(400);
    const s = await state();
    return { label, hash: s.hash, mode: s.mode, active: s.active };
  },

  async prompts() {
    await load('?tall');
    const out = [];
    for (const k of ['}', '}', '{', '3}']) {
      await press(k);
      await sleep(1600);
      out.push(await js(`(() => {
        const sc = document.getElementById('sc'); const t = sc.getBoundingClientRect().top;
        const p = [...sc.querySelectorAll('[data-take-back-entry]')].map((el) => [el.dataset.takeBackEntry, Math.round(el.getBoundingClientRect().top - t)]).find(([, y]) => y > -5 && y < 60);
        return k = (p ? p.join('@') : 'none');
      })()`.replace('return k =', 'return')));
    }
    return out;
  },

  // } past the last prompt reaches the bottom; { past the first reaches the top
  async pastLastPrompt() {
    await load('?tall');
    await press('G');
    await sleep(1200);
    await press('{');
    await sleep(1500);
    const onLast = await js(`(() => { const sc = document.getElementById('sc'); const t = sc.getBoundingClientRect().top;
      const p = [...sc.querySelectorAll('[data-take-back-entry]')].map((el) => [el.dataset.takeBackEntry, Math.round(el.getBoundingClientRect().top - t)]).find(([, y]) => y > -5 && y < 60);
      return p ? p.join('@') : 'none'; })()`);
    await press('}');
    await sleep(2000);
    const afterNext = (await state()).fromBottom;
    await press('}');
    await sleep(800);
    const toast = await js(`document.querySelector('normal-mode').shadowRoot.querySelector('.toast')?.textContent ?? ''`);
    await js(`document.getElementById('sc').scrollTop = 900; 1`);
    await sleep(300);
    await press('{');
    await sleep(1500);
    await press('{');
    await sleep(1500);
    return { onLast, afterNextFromBottom: afterNext, againToast: toast, topAfterTwoBraces: (await state()).top };
  },

  async rewind() {
    await load();
    await press('e');
    await sleep(100);
    const label = await hintFor('Prompt 1');
    await press(label);
    await sleep(800);
    const s = await state();
    return { label, mode: s.mode, active: s.active, log: s.log[0] };
  },

  async copyLast() {
    await load();
    await press('yy');
    await sleep(900);
    return (await state()).log[0];
  },

  // Enter sends and drops to normal mode; Shift+Enter and an empty Enter stay in insert
  async sendThenNormal() {
    await load();
    await press('i');
    await press('hi');
    await press('<S-CR>');
    await sleep(150);
    const afterShiftEnter = (await state()).mode;
    await press('<CR>');
    await sleep(400);
    const afterSend = await state();
    await press('j');
    await sleep(300);
    const typedJ = await js(`document.getElementById('composer').textContent`);
    await press('i');
    await press('<CR>');
    await sleep(400);
    return { afterShiftEnter, sent: afterSend.log[0], afterSend: afterSend.mode, jTyped: typedJ, emptyEnter: (await state()).mode };
  },

  async insertAndBack() {
    await load();
    await press('i');
    await press('hi jk');
    const typed = await js(`document.getElementById('composer').textContent`);
    const inInsert = (await state()).mode;
    await press('<Esc>');
    await sleep(100);
    return { typed, inInsert, afterEsc: (await state()).mode };
  },
};

app.whenReady().then(async () => {
  protocol.handle('app', (req) => {
    const p = new URL(req.url).pathname;
    // optional: the app's own stylesheet (largest CSS in an installed Claude
    // desktop, given as CLAUDE_APP=/path/to/claude-desktop), so the overlay
    // picks up its real design tokens
    if (p === '/app.css') {
      if (!process.env.CLAUDE_APP) return new Response('', { status: 404 });
      const dir = path.join(fs.realpathSync(process.env.CLAUDE_APP), 'lib/claude-desktop/resources/ion-dist/assets/v1');
      const css = fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
      return net.fetch(pathToFileURL(css).toString());
    }
    return net.fetch(pathToFileURL(path.join(ROOT, p)).toString());
  });
  win = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(60);
  win.webContents.on('console-message', (e) => {
    if (/normal-mode/.test(e.message) || e.level === 'error') console.log('[page]', e.message);
  });
  win.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', p, err.message));
  const names = process.argv.slice(2).filter((a) => SCENARIOS[a]);
  for (const name of names.length ? names : Object.keys(SCENARIOS).filter((n) => n !== 'shots')) {
    try {
      console.log(name, JSON.stringify(await SCENARIOS[name]()));
    } catch (err) {
      console.log(name, 'ERROR', err.message);
    }
  }
  app.quit();
});
