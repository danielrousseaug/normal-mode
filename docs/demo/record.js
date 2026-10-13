// Records docs/demo.mp4 and docs/demo.gif: docs/demo/demo.html in an offscreen
// Electron window with Normal Mode preloaded exactly as test/harness.js does
// it, driven by real key presses, captured at a steady 30 fps.
//
//   CLAUDE_APP=/path/to/claude-desktop nix shell nixpkgs#ffmpeg nixpkgs#electron -c \
//     electron --no-sandbox docs/demo/record.js [--shot name.png]
//
// CLAUDE_APP (an installed Claude desktop package) supplies the app's real
// stylesheet and fonts; without it the page falls back to plain colors.
// --shot saves one screenshot of the opening state and quits.
'use strict';

const { app, BrowserWindow, protocol, net } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'docs');
const WORK = process.env.DEMO_WORK || path.join(os.tmpdir(), 'normal-mode-demo');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const W = 1280;
const H = 800;
const FPS = 30;
const ZOOM = 1.15; // the app zoomed in a step, so text stays readable in the GIF

fs.rmSync(path.join(WORK, 'data'), { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
require(path.join(ROOT, 'src/main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code);
const show = (code) => js(code).catch(() => {}); // the recording's own layer (captions, key caps)

// ---- keys (as in test/harness.js) ------------------------------------------
// 'j', 'G', '{', '<C-w>', '<Esc>', '<CR>'; capitals imply shift
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
const LABELS = { '<Esc>': 'Esc', '<CR>': 'Enter' };
const label = (k) => LABELS[k] ?? k;

function keyDown(k, repeat = false) {
  const { key, mods } = parse(k);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: repeat ? [...mods, 'isAutoRepeat'] : mods });
  if (!repeat && key.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers: mods });
}
function keyUp(k) {
  const { key, mods } = parse(k);
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
}

// a key press, shown as a key cap; hold > 0 keeps it down with auto-repeat
async function tap(k, { hold = 0, after = 0 } = {}) {
  await show(`__demo.down(${JSON.stringify(label(k))})`); // the cap shows up with the key, not after it
  keyDown(k);
  if (hold) {
    for (let t = 0; t < hold; t += 33) {
      await sleep(33);
      keyDown(k, true);
    }
  } else {
    await sleep(90);
  }
  keyUp(k);
  show(`__demo.up(${JSON.stringify(label(k))})`);
  await sleep(after);
}

// typing in the composer: no key caps, just the text appearing
async function type(text, perChar = 42) {
  for (const ch of text) {
    const mods = /[A-Z]/.test(ch) ? ['shift'] : [];
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch, modifiers: mods });
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch, modifiers: mods });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch, modifiers: mods });
    await sleep(perChar + (ch === ' ' ? 30 : 0));
  }
}

// the hint label Normal Mode put closest to the element matching `find` (page JS)
const hintNear = (find) => js(`(() => {
  const target = (${find})();
  if (!target) return null;
  const r = target.getBoundingClientRect();
  let best = null;
  for (const h of document.querySelector('normal-mode').shadowRoot.querySelectorAll('[data-hint]')) {
    const hr = h.getBoundingClientRect();
    const d = Math.hypot(hr.left - r.left, hr.top - r.top);
    if (!best || d < best.d) best = { d, label: h.dataset.hint };
  }
  return best && best.label;
})()`);

async function pickHint(find) {
  const hint = await hintNear(find);
  if (!hint) throw new Error(`no hint for ${find}`);
  for (const ch of hint) await tap(ch, { after: 60 });
}

// take the pointer off the page after a real click, so nothing stays hovered
const pointerAway = () => win.webContents.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 });

// ---- capture ----------------------------------------------------------------
// Offscreen paint events carry each new frame; a clock writes the latest one
// 30 times a second (repeating it while the page is still), so the video runs
// at the real speed whatever the page does.
let latest = null;
let latestFor = null;
let latestBuf = null;
function frame() {
  if (latest !== latestFor) {
    latestFor = latest;
    let img = latest;
    const s = img.getSize();
    if (s.width !== W || s.height !== H) img = img.resize({ width: W, height: H });
    latestBuf = img.toBitmap();
  }
  return latestBuf;
}

function record(file) {
  const ff = spawn(FFMPEG, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${W}x${H}`,
    '-framerate', String(FPS), '-i', '-', '-c:v', 'libx264rgb', '-preset', 'ultrafast', '-qp', '0', file],
  { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = performance.now();
  let n = 0;
  const timer = setInterval(() => {
    const due = Math.floor(((performance.now() - t0) * FPS) / 1000);
    while (n <= due) { ff.stdin.write(frame()); n++; }
  }, 4);
  return {
    t: () => (performance.now() - t0) / 1000,
    stop: () => new Promise((resolve, reject) => {
      clearInterval(timer);
      ff.on('close', (code) => (code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve(n)));
      ff.stdin.end();
    }),
  };
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
    p.on('close', (code) => (code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve()));
  });
}

// ---- the script -------------------------------------------------------------
async function play(rec) {
  const beats = [];
  const beat = (keys, text) => {
    beats.push(`${rec.t().toFixed(1).padStart(5)}s  ${keys} · ${text}`);
    show(`__demo.clearKeys(); __demo.caption(${JSON.stringify(keys)}, ${JSON.stringify(text)})`);
  };

  beats.push(`${rec.t().toFixed(1).padStart(5)}s  title card`);
  await sleep(2500);
  show('__demo.card(null)');
  await sleep(450);

  beat('j / k', 'smooth scrolling at one steady speed');
  await sleep(600);
  await tap('j', { hold: 1000, after: 450 });
  await tap('k', { hold: 600, after: 350 });
  await tap('j', { after: 260 });
  await tap('j', { after: 700 });

  beat('{ / }', 'jump between your prompts, past the last one to the bottom');
  await sleep(350);
  for (let i = 0; i < 2; i++) await tap('}', { after: 1150 });
  await tap('}', { after: 1500 }); // past the last prompt: the bottom
  await tap('{', { after: 1300 });

  beat('e', 'edit a prompt: rewinds to it and puts it back in the composer');
  await sleep(300);
  await tap('e', { after: 1000 });
  await pickHint(`() => [...document.querySelectorAll('[data-take-back-entry]')].pop()`);
  await sleep(700);
  pointerAway();
  await sleep(1300);
  await tap('<Esc>', { after: 900 });

  beat('f', 'click anything from the keyboard');
  await sleep(250);
  await tap('f', { after: 1000 });
  await pickHint(`() => [...document.querySelectorAll('a[data-row-main-button]')].find((a) => a.textContent === 'Add dark mode toggle')`);
  await sleep(250);
  pointerAway();
  await sleep(1600);

  beat('i', 'type a prompt; Enter sends it and drops back to normal mode');
  await sleep(300);
  await tap('i', { after: 350 });
  show('__demo.clearKeys()');
  await type('Also remember the choice in localStorage');
  await sleep(250);
  await tap('<CR>', { after: 2600 });

  beat('J / K', 'next / previous session');
  await sleep(250);
  await tap('J', { after: 1050 });
  await tap('J', { after: 1050 });
  await tap('K', { after: 1300 });

  beat('s', 'prefix keys show what can come next');
  await sleep(250);
  await tap('s', { after: 2400 });
  await tap('<Esc>', { after: 600 });

  beat('M then j / k', 'reorder your pinned sessions');
  await sleep(250);
  await tap('M', { after: 650 });
  await tap('k', { after: 900 });
  await tap('k', { after: 900 });
  await tap('<CR>', { after: 900 });

  beat('?', 'every key on one sheet');
  await sleep(250);
  await tap('?', { after: 3300 });
  await tap('<Esc>', { after: 500 });

  beats.push(`${rec.t().toFixed(1).padStart(5)}s  closing card`);
  show('__demo.clearKeys(); __demo.caption("", ""); __demo.card("outro")');
  await sleep(3300);
  return beats;
}

app.whenReady().then(async () => {
  const assets = process.env.CLAUDE_APP &&
    path.join(fs.realpathSync(process.env.CLAUDE_APP), 'lib/claude-desktop/resources/ion-dist/assets/v1');
  if (!assets) console.warn('CLAUDE_APP is not set: recording without the app\'s stylesheet');
  protocol.handle('app', (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname);
    if (p === '/app.css' || p.startsWith('/assets/v1/')) {
      if (!assets) return new Response('', { status: 404 });
      // the app's largest stylesheet holds its design tokens; its fonts sit next to it
      const file = p === '/app.css'
        ? fs.readdirSync(assets).filter((f) => f.endsWith('.css')).map((f) => path.join(assets, f))
          .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
        : path.join(assets, path.basename(p));
      return net.fetch(pathToFileURL(file).toString());
    }
    return net.fetch(pathToFileURL(path.join(ROOT, p)).toString());
  });

  win = new BrowserWindow({
    width: W, height: H, useContentSize: true, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(60);
  win.webContents.on('paint', (_e, _dirty, img) => { latest = img; });
  win.webContents.on('console-message', (e) => { if (e.level === 'error') console.log('[page]', e.message); });
  win.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', p, err.message));

  try {
    await win.loadURL('app://localhost/docs/demo/demo.html#/s1');
    win.webContents.setZoomFactor(ZOOM);
    win.focus(); // offscreen windows get no keyboard focus by themselves
    win.webContents.focus();
    await js('document.fonts.ready.then(() => 1)');
    await sleep(600);
    await js(`document.getElementById('sc').scrollTop = 0; 1`); // start reading from the top
    await sleep(300);

    const shotAt = process.argv.indexOf('--shot');
    if (shotAt > 0) {
      const file = path.resolve(process.argv[shotAt + 1] || path.join(WORK, 'shot.png'));
      fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
      console.log(file);
      return app.quit();
    }

    show('__demo.card("title")');
    await sleep(700); // fully faded in before the first frame
    const master = path.join(WORK, 'master.mkv');
    const rec = record(master);
    const beats = await play(rec);
    const frames = await rec.stop();
    console.log(`${frames} frames, ${(frames / FPS).toFixed(1)} s\n${beats.join('\n')}`);

    const mp4 = path.join(OUT, 'demo.mp4');
    await ffmpeg(['-i', master, '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '20', '-tune', 'animation',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    const gif = path.join(OUT, 'demo.gif');
    await ffmpeg(['-i', master, '-filter_complex',
      'fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
      gif]);
    for (const f of [mp4, gif]) console.log(`${path.relative(ROOT, f)}  ${(fs.statSync(f).size / 1e6).toFixed(2)} MB`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
