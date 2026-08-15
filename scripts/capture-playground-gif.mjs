/**
 * Record a looping playground GIF: type + send, then expand the emoji picker.
 *
 * Usage (from packages/):
 *   npm run capture:gif
 */
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const example = join(root, 'examples/playground');
const theme = process.argv[2] === 'light' ? 'light' : 'dark';
const outGif = join(
  root,
  'docs/images',
  theme === 'light' ? 'playground-send-emoji-light.gif' : 'playground-send-emoji.gif',
);
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const port = 4189;
const debugPort = 9346;
const origin = `http://127.0.0.1:${port}/?theme=${theme}`;
const VIEW_W = 1100;
const VIEW_H = 760;
const GIF_W = 880;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startVite() {
  const child = spawn(
    'npx',
    ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: example, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  const ready = new Promise((resolve, reject) => {
    const onData = (buf) => {
      const text = String(buf);
      if (text.includes('Local:') || text.includes(`http://127.0.0.1:${port}`)) {
        resolve(undefined);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      if (code) reject(new Error(`vite exited ${code}`));
    });
    setTimeout(() => resolve(undefined), 8000);
  });
  return { child, ready };
}

function startChrome() {
  const userData = join(tmpdir(), `aibar-gif-chrome-${process.pid}`);
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${userData}`,
      `--window-size=${VIEW_W},${VIEW_H}`,
      '--force-device-scale-factor=2',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  return { child, userData };
}

async function waitForDebugger(timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      // chrome still booting
    }
    await sleep(150);
  }
  throw new Error('Chrome debugger did not come up');
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const handlers = new Map();

    const send = (method, params, sessionId) => {
      const id = ++nextId;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify(payload));
      });
    };

    ws.addEventListener('open', () => {
      resolve({
        send,
        on(method, fn) {
          const list = handlers.get(method) ?? [];
          list.push(fn);
          handlers.set(method, list);
          return () => {
            handlers.set(
              method,
              (handlers.get(method) ?? []).filter((h) => h !== fn),
            );
          };
        },
        close() {
          try {
            ws.close();
          } catch {
            // already closed
          }
        },
      });
    });
    ws.addEventListener('error', (err) => reject(err));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.method ?? msg.id})`));
        else res(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of handlers.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
      }
    });
  });
}

async function attachPage(browser, url) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const send = (method, params) => browser.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VIEW_W,
    height: VIEW_H,
    deviceScaleFactor: 2,
    mobile: false,
  });
  const loaded = new Promise((resolve) => {
    const off = browser.on('Page.loadEventFired', (_p, sid) => {
      if (sid === sessionId) {
        off();
        resolve(undefined);
      }
    });
  });
  await send('Page.navigate', { url });
  await Promise.race([loaded, sleep(8000)]);
  return { send, sessionId };
}

async function evaluate(send, expression) {
  const out = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (out.exceptionDetails) {
    throw new Error(out.exceptionDetails.text || 'evaluate failed');
  }
  return out.result?.value;
}

async function waitFor(send, expression, timeoutMs = 12_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await evaluate(send, `(${expression}) ? true : false`);
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`timeout waiting for: ${expression}`);
}

async function boxOf(send, selector) {
  return evaluate(
    send,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );
}

async function click(send, selector) {
  await waitFor(send, `Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const r = await boxOf(send, selector);
  const x = r.x + r.width / 2;
  const y = r.y + Math.min(r.height / 2, 16);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(80);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
}

async function typeText(send, text, delayMs = 90) {
  for (const ch of [...text]) {
    await send('Input.insertText', { text: ch });
    await sleep(delayMs);
  }
}

function startScreencast(browser, send, sessionId, frameDir) {
  let n = 0;
  const writing = [];
  const off = browser.on('Page.screencastFrame', (params, sid) => {
    if (sid && sid !== sessionId) return;
    const idx = ++n;
    const dest = join(frameDir, `frame-${String(idx).padStart(4, '0')}.jpg`);
    writing.push(writeFile(dest, Buffer.from(params.data, 'base64')));
    send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  });
  return {
    async begin() {
      await send('Page.startScreencast', {
        format: 'jpeg',
        quality: 90,
        everyNthFrame: 1,
      });
    },
    async stop() {
      await send('Page.stopScreencast').catch(() => {});
      off();
      await Promise.all(writing);
      return n;
    },
  };
}

function even(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v + 1;
}

function killGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // gone
    }
  }
}

  await mkdir(join(root, 'docs/images'), { recursive: true });
  console.log('recording', theme, '→', outGif);
const frameDir = await mkdtemp(join(tmpdir(), 'aibar-gif-frames-'));
const vite = startVite();
await vite.ready;
await sleep(400);

const chromeProc = startChrome();
let browser;
try {
  const version = await waitForDebugger();
  browser = await connectCdp(version.webSocketDebuggerUrl);
  const { send, sessionId } = await attachPage(browser, origin);

  await waitFor(send, `Boolean(document.querySelector('.aibar-root'))`);
  await waitFor(send, `Boolean(document.querySelector('.preview'))`);
  await sleep(350);

  await evaluate(
    send,
    `(() => {
      const root = document.querySelector('.aibar-root');
      if (root) {
        root.style.setProperty('--aibar-motion-fast', '420ms');
        root.style.setProperty('--aibar-motion-base', '640ms');
        root.style.setProperty('--aibar-motion-slow', '840ms');
      }
      const thread = document.querySelector('.preview-thread');
      if (thread instanceof HTMLElement) thread.style.overflow = 'hidden';
      return true;
    })()`,
  );

  const clip = await boxOf(send, '.preview');
  if (!clip || clip.width < 40) throw new Error('preview clip missing');

  const cast = startScreencast(browser, send, sessionId, frameDir);
  await cast.begin();
  await sleep(200);

  await sleep(550);
  await click(send, '.composer textarea, #draft');
  await sleep(160);
  await typeText(send, 'Ship it', 95);
  await sleep(320);

  await click(send, '.aibar-item[data-type="mainButton"]');
  await waitFor(send, `document.body.innerText.includes('Echo')`, 8_000);
  await evaluate(
    send,
    `(() => {
      const thread = document.querySelector('.preview-thread');
      if (thread) thread.scrollTop = thread.scrollHeight;
      return true;
    })()`,
  );
  await sleep(700);

  await click(send, '[data-aibar-id="com.example.aibar.popover.emoji"]');
  await waitFor(send, `Boolean(document.querySelector('.aibar-scrubber__item'))`, 4_000);
  await sleep(900);

  await click(send, '.aibar-scrubber__item');
  await sleep(1000);

  const count = await cast.stop();
  console.log(`captured ${count} screencast frames → encoding`);
  if (count < 8) throw new Error(`too few frames: ${count}`);

  const first = (await readdir(frameDir))
    .filter((f) => f.endsWith('.jpg'))
    .sort()[0];
  const { stdout: dim } = await execFileAsync('identify', [
    '-format',
    '%w %h',
    join(frameDir, first),
  ]);
  const [imgW, imgH] = dim.trim().split(/\s+/).map(Number);
  const sx = imgW / VIEW_W;
  const sy = imgH / VIEW_H;
  const crop = [
    even(clip.width * sx),
    even(clip.height * sy),
    even(clip.x * sx),
    even(clip.y * sy),
  ];
  const cropFilter = `crop=${crop[0]}:${crop[1]}:${crop[2]}:${crop[3]},scale=${GIF_W}:-1:flags=lanczos`;
  console.log('crop', crop, 'from', imgW, imgH);

  const palette = join(frameDir, 'palette.png');
  await execFileAsync('ffmpeg', [
    '-y',
    '-framerate',
    '18',
    '-i',
    join(frameDir, 'frame-%04d.jpg'),
    '-vf',
    `${cropFilter},palettegen=max_colors=192:stats_mode=diff`,
    palette,
  ]);
  await execFileAsync('ffmpeg', [
    '-y',
    '-framerate',
    '18',
    '-i',
    join(frameDir, 'frame-%04d.jpg'),
    '-i',
    palette,
    '-lavfi',
    `${cropFilter} [x]; [x][1:v] paletteuse=dither=sierra2_4a`,
    outGif,
  ]);
  console.log('wrote', outGif);
} finally {
  browser?.close();
  killGroup(chromeProc.child);
  killGroup(vite.child);
  await rm(frameDir, { recursive: true, force: true }).catch(() => {});
}
