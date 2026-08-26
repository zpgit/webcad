// Runs the storage conformance suite against both backends, in a real browser.
//
// IndexedDB and OPFS have no Node equivalent worth testing against: a fake
// would reproduce whatever this codebase believes about transactions, quota,
// and file handles, which is exactly what needs checking. So the suite is a
// module the page imports, and this script is the harness that loads it.
//
// Usage: node scripts/verify-storage.mjs [--headed] [--port 5197]

import { chromium } from 'playwright-core';
import process from 'node:process';

import { devOrigin, killTree, startDevServer } from './_browser.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const portIndex = args.indexOf('--port');
const port = portIndex === -1 ? 5197 : Number(args[portIndex + 1]);
const origin = devOrigin(port);

const BACKENDS = ['indexeddb', 'opfs'];

// Small enough that a few megabytes cannot fit, large enough that the browser
// does not round it away.
const REDUCED_QUOTA_BYTES = 1024 * 1024;
const OVERSIZED_PAYLOAD_BYTES = 8 * 1024 * 1024;

let failures = 0;
const skipped = [];

function report(backend, results) {
  for (const { name, status, detail } of results) {
    const mark = status === 'pass' ? 'ok  ' : status === 'skip' ? 'skip' : 'FAIL';
    console.log(`  ${mark}  ${backend}: ${name}${detail ? ` - ${detail}` : ''}`);
    if (status === 'fail') failures++;
    if (status === 'skip') skipped.push(`${backend}: ${name}`);
  }
}

/**
 * Loads the suite in the page and runs it.
 *
 * Imported through the dev server rather than bundled, so the browser runs the
 * same modules the app does.
 */
async function runSuite(page, backend) {
  return page.evaluate(async (which) => {
    const { runStorageConformance } = await import(
      '/tests/browser/storage-conformance.ts'
    );
    const { openStore } = await import('/src/storage/index.ts');
    return runStorageConformance(() => openStore(which));
  }, backend);
}

async function runQuotaCheck(page, backend, payloadBytes) {
  return page.evaluate(
    async ([which, bytes]) => {
      const { checkQuotaExhaustion } = await import(
        '/tests/browser/storage-conformance.ts'
      );
      const { openStore } = await import('/src/storage/index.ts');
      return checkQuotaExhaustion(() => openStore(which), bytes);
    },
    [backend, payloadBytes],
  );
}

let server;
let browser;
try {
  console.log('Starting dev server...');
  server = await startDevServer(port);

  browser = await chromium.launch({
    channel: 'chrome',
    headless: !headed,
    // SwiftShader keeps the page usable on a machine with no real GPU. Storage
    // does not need a renderer, but the app's entry point runs on load and
    // would otherwise spend the timeout failing to find one.
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  console.log(`Opening ${origin} ...`);
  // `domcontentloaded`, not `load`: this run needs an origin to scope storage
  // to and a module graph to import from, not a started application. Waiting
  // for the kernel and the viewport would make a storage check depend on a
  // renderer it never touches.
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  for (const backend of BACKENDS) {
    console.log(`\n${backend}`);
    report(backend, await runSuite(page, backend));
  }

  // Quota runs last, in a context of its own.
  //
  // Both parts matter. The override stays in force for the origin, so running
  // it earlier would starve every check behind it. And it goes on a fresh
  // context, applied before the page has touched storage: Chrome's quota
  // manager settles a bucket's limit when storage is first opened, so
  // overriding afterwards leaves an already-open IndexedDB using the old one.
  console.log('\nquota');
  const quotaContext = await browser.newContext();
  const quotaPage = await quotaContext.newPage();
  const client = await quotaContext.newCDPSession(quotaPage);

  let quotaOverridden = true;
  try {
    await client.send('Storage.overrideQuotaForOrigin', {
      origin,
      quotaSize: REDUCED_QUOTA_BYTES,
    });
  } catch (error) {
    quotaOverridden = false;
    // Reported, not swallowed: a quota check that silently never fires would
    // read as coverage this run does not have.
    report('quota', [
      {
        name: 'quota override via the DevTools protocol',
        status: 'skip',
        detail: `unavailable (${String(error)}) - exhaustion was NOT exercised`,
      },
    ]);
  }

  if (quotaOverridden) {
    await quotaPage.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    for (const backend of BACKENDS) {
      report(backend, [
        await runQuotaCheck(quotaPage, backend, OVERSIZED_PAYLOAD_BYTES),
      ]);
    }
    await client.send('Storage.overrideQuotaForOrigin', { origin });
  }
  await quotaContext.close();

  if (pageErrors.length > 0) {
    console.log(`\nUncaught page errors:\n  ${pageErrors.join('\n  ')}`);
    failures += pageErrors.length;
  }

  if (failures > 0) {
    console.log(`\nStorage verification FAILED (${failures})`);
    process.exitCode = 1;
  } else {
    console.log('\nStorage verification PASSED');
  }

  // Stated after the verdict rather than buried above it. A run that reports
  // PASSED while quietly not having exercised something reads as coverage it
  // does not have.
  if (skipped.length > 0) {
    console.log(`\nNot exercised (${skipped.length}):`);
    for (const entry of skipped) console.log(`  - ${entry}`);
  }
} catch (error) {
  console.error('\nStorage verification FAILED');
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  killTree(server);
}
