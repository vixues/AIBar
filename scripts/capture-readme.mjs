/**
 * Capture playground screenshots for README.md using system Chrome.
 *
 * Usage (from packages/):
 *   npm run capture:readme
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const example = join(root, 'examples/playground');
const outDir = join(root, 'docs/images');
const chrome = '/usr/bin/google-chrome';
const port = 4177;
const origin = `http://127.0.0.1:${port}/`;

function startVite() {
  const child = spawn(
    'npx',
    ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: example, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ready = new Promise((resolve, reject) => {
    const onData = (buf) => {
      const text = String(buf);
      if (text.includes('Local:') || text.includes(origin)) resolve(undefined);
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

await mkdir(outDir, { recursive: true });
const vite = startVite();
await vite.ready;
await new Promise((r) => setTimeout(r, 600));

try {
  for (const theme of ['light', 'dark']) {
    const dest = join(outDir, `playground-${theme}.png`);
    await execFileAsync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      `--user-data-dir=/tmp/aibar-capture-${theme}`,
      '--window-size=1100,760',
      '--force-device-scale-factor=2',
      '--virtual-time-budget=8000',
      `--screenshot=${dest}`,
      `${origin}?theme=${theme}`,
    ]);
    console.log('wrote', dest);
  }
} finally {
  vite.child.kill('SIGKILL');
  try {
    process.kill(-vite.child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}
