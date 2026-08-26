// Shared plumbing for the scripts that drive the real app in a real browser.
//
// Both the verification run and the demo recording need a dev server, a way to
// tear it down completely, and a shift-click that actually holds shift. Each of
// those encodes a bug that was awkward to find, so they live in one place.

import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * Terminates the dev server and everything it spawned.
 *
 * `proc.kill()` alone kills the npx shim and orphans the actual vite process,
 * which keeps holding the port. Repeated runs then pile up abandoned servers and
 * the next `--strictPort` start fails.
 */
export function killTree(proc) {
  if (proc === undefined || proc.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
  }
}

// Bind and connect over IPv4 explicitly rather than through `localhost`.
//
// Vite binds ::1 only, and resolving `localhost` on a dual-stack Windows box
// costs seconds per request - enough that the dev server looks hung and a page
// load of many ES modules never finishes inside a normal timeout.
export const DEV_HOST = '127.0.0.1';
export const devOrigin = (port) => `http://${DEV_HOST}:${port}`;

export function startDevServer(port) {
  const origin = devOrigin(port);
  const proc = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', '--host', DEV_HOST, '--port', String(port), '--strictPort'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      // Own process group on POSIX so killTree can signal the whole tree.
      detached: process.platform !== 'win32',
    },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('dev server did not start within 60s')),
      60_000,
    );
    const onData = (chunk) => {
      if (String(chunk).includes('ready in') || String(chunk).includes(origin)) {
        clearTimeout(timer);
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`dev server exited with code ${code}`));
    });
  });
}

/**
 * Shift-click.
 *
 * `page.mouse.click()` accepts no `modifiers` option - that belongs to
 * locator.click() - so passing one is silently ignored and the click arrives
 * with shiftKey false. The modifier has to be held around the click.
 */
export async function shiftClick(page, x, y) {
  await page.keyboard.down('Shift');
  try {
    await page.mouse.click(x, y);
  } finally {
    await page.keyboard.up('Shift');
  }
}
