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

function startViteServer(subcommand, port, label) {
  const origin = devOrigin(port);
  const proc = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', ...subcommand, '--host', DEV_HOST, '--port', String(port), '--strictPort'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      // Own process group on POSIX so killTree can signal the whole tree.
      detached: process.platform !== 'win32',
    },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not start within 60s`)),
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
      reject(new Error(`${label} exited with code ${code}`));
    });
  });
}

/**
 * A dev server for a verification run.
 *
 * `--force` re-bundles dependencies at startup instead of trusting the cache.
 * It costs a few seconds per run and buys determinism: without it, the optimizer
 * can decide mid-page-load that it needs to re-bundle, and a module request that
 * is being held while that happens never resolves - which arrives as
 * `page.goto: Timeout exceeded` against a server that answers every URL in
 * milliseconds when probed by hand. Three runs failed that way, and clearing
 * `node_modules/.vite` was the only thing that reliably fixed it. Doing the
 * re-bundle up front removes the window entirely.
 */
export const startDevServer = (port) =>
  startViteServer(['--force'], port, 'dev server');

/**
 * Serves an existing `dist/` the way a static host would.
 *
 * Separate from the dev server because the two resolve assets differently, and
 * that difference is exactly what shipped a `dist/` unable to load the kernel:
 * dev serves files from their source paths, while a build rewrites them to
 * hashed names under assets/.
 */
export const startPreviewServer = (port) =>
  startViteServer(['preview'], port, 'preview server');

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
