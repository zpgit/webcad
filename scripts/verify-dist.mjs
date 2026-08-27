// Drives the production build, served the way a static host would serve it.
//
// This exists because `npm run verify:browser` drives the dev server, and the
// dev server resolves assets from their source paths. A build rewrites them to
// hashed names under assets/, and for a while that difference silently shipped
// a `dist/` that could not load the kernel at all: the Emscripten loader looked
// for `webcad_kernel.wasm` next to itself and got a 404. Everything else passed
// the whole time, because nothing ever loaded the built app.
//
// So the assertions here are deliberately narrow. This is not a second copy of
// the browser verification - it checks the things that can only break in a
// build, and leaves geometry and rendering correctness to the run that already
// covers them.
//
// Usage: node scripts/verify-dist.mjs [--headed] [--port 5198]

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import process from 'node:process';

import { devOrigin, killTree, startPreviewServer } from './_browser.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const portIndex = args.indexOf('--port');
const port = portIndex === -1 ? 5198 : Number(args[portIndex + 1]);
const origin = devOrigin(port);

const note = (message) => console.log(`  ${message}`);

if (!existsSync('dist/index.html')) {
  console.error('dist/ is missing or empty. Run `npm run build` first.');
  process.exit(1);
}

let server;
let browser;
let failed = false;

try {
  console.log('Starting preview server...');
  server = await startPreviewServer(port);

  browser = await chromium.launch({
    channel: 'chrome',
    headless: !headed,
    args: ['--enable-unsafe-swiftshader'],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  // Every response, not just the failures: the point of this run is to prove
  // the .wasm was actually fetched, which a failure list cannot show.
  const responses = [];
  page.on('response', (response) => {
    responses.push({ url: response.url(), status: response.status() });
  });

  console.log(`Opening ${origin} ...`);
  await page.goto(origin, { waitUntil: 'load' });

  // Kernel readiness shows up as a real OCCT version in the readout; a build
  // that cannot load the kernel shows the fatal panel instead. Racing the two
  // is what makes a broken build report why rather than time out silently -
  // waiting on readiness alone turns every cause into the same blank timeout.
  const outcome = await Promise.race([
    page
      .waitForFunction(
        () =>
          (document.getElementById('measurements')?.textContent ?? '').match(
            /\d+\.\d+\.\d+/,
          ) !== null,
        undefined,
        { timeout: 60_000 },
      )
      .then(
        () => ({ kind: 'ready' }),
        () => ({ kind: 'timeout' }),
      ),
    page
      .waitForSelector('#fatal:not([hidden])', { timeout: 60_000 })
      .then(
        async (panel) => ({ kind: 'fatal', text: await panel.innerText() }),
        () => ({ kind: 'timeout' }),
      ),
  ]);

  if (outcome.kind === 'fatal') {
    throw new Error(
      `the built app reported a fatal error: ${outcome.text.replace(/\s+/g, ' ')}`,
    );
  }
  if (outcome.kind === 'timeout') {
    const broken = responses.filter((r) => r.status >= 400);
    throw new Error(
      'the kernel never became ready in the built app' +
        (broken.length > 0
          ? `; failing requests:\n  ${broken.map((r) => `${r.status} ${r.url}`).join('\n  ')}`
          : ' and nothing failed outright, so look for a hung fetch'),
    );
  }
  note('kernel initialized from the built assets');

  // The specific regression: the loader has to find the .wasm under its hashed
  // name. Asserting the fetch happened and succeeded is stronger than asserting
  // no request failed, which would also pass if the file were never requested.
  const wasm = responses.filter((r) => r.url.endsWith('.wasm'));
  if (wasm.length === 0) {
    throw new Error(
      'no .wasm was fetched - the kernel reported ready without loading the ' +
        'artifact, which should be impossible',
    );
  }
  for (const request of wasm) {
    if (request.status !== 200) {
      throw new Error(`${request.status} fetching ${request.url}`);
    }
    note(`fetched ${new URL(request.url).pathname} (${request.status})`);
  }

  console.log('Building the demo scene...');
  await page.click('#btn-demo');
  await page.waitForFunction(
    () => {
      const text = document.getElementById('measurements')?.textContent ?? '';
      const match = text.match(/Live bodies(\d+)/);
      return match !== null && Number(match[1]) >= 2;
    },
    undefined,
    { timeout: 60_000 },
  );

  const readout = await page.evaluate(() => {
    const rows = {};
    const list = document.getElementById('measurements');
    const terms = [...(list?.querySelectorAll('dt') ?? [])];
    const values = [...(list?.querySelectorAll('dd') ?? [])];
    terms.forEach((dt, i) => {
      rows[dt.textContent ?? ''] = values[i]?.textContent ?? '';
    });
    return rows;
  });
  const triangles = Number((readout['Triangles'] ?? '0').replace(/[^0-9]/g, ''));
  if (triangles <= 0) {
    throw new Error('the demo scene produced no triangles in the built app');
  }
  note(`demo scene: ${readout['Live bodies']} bodies, ${readout['Triangles']} triangles`);

  // Persistence across a real restart, in the build.
  //
  // The dev-server run already proves this end to end, and proves it more
  // thoroughly - it can reach into the session and compare body identities. It
  // cannot prove it of a *build*, which is the failure this whole script exists
  // for: the document layer's imports are as capable of surviving dev and dying
  // under a bundler as the kernel loader was. So this asks the narrow question
  // the build can break, and asks it entirely through the DOM, because the
  // verification handle is deliberately gone here.
  console.log('Saving, reloading, and reopening...');

  const readRow = async (label) =>
    page.evaluate((wanted) => {
      const list = document.getElementById('measurements');
      const terms = [...(list?.querySelectorAll('dt') ?? [])];
      const values = [...(list?.querySelectorAll('dd') ?? [])];
      const index = terms.findIndex((dt) => dt.textContent === wanted);
      return index === -1 ? null : (values[index]?.textContent ?? null);
    }, label);

  const documentName = 'Dist Verification';
  await page.locator('#doc-name').fill(documentName);
  // The app commits a rename on `change`, which `fill` alone does not fire.
  await page.locator('#doc-name').dispatchEvent('change');

  await page.click('#btn-save');
  await page.waitForFunction(
    () => (document.getElementById('doc-status')?.textContent ?? '').includes('Saved'),
    undefined,
    { timeout: 30_000 },
  );

  const before = {
    triangles: await readRow('Triangles'),
    bodies: await readRow('Live bodies'),
    history: await page.locator('#history li').count(),
  };
  note(`saved “${documentName}”: ${before.bodies} bodies, ${before.history} history entries`);

  await page.reload({ waitUntil: 'load' });

  // Restoration is awaited during startup and reported on the page, so the
  // status line is the signal - and a failure puts its reason there too, which
  // beats timing out with nothing to show.
  await page.waitForFunction(
    () => {
      const text = document.getElementById('doc-status')?.textContent ?? '';
      return text.includes('Opened') || text.includes('could not be reopened');
    },
    undefined,
    { timeout: 60_000 },
  );

  const status = await page.locator('#doc-status').textContent();
  if (!status.includes('Opened')) {
    throw new Error(`the built app did not reopen the document: ${status}`);
  }

  const after = {
    name: await page.locator('#doc-name').inputValue(),
    triangles: await readRow('Triangles'),
    bodies: await readRow('Live bodies'),
    history: await page.locator('#history li').count(),
  };

  note(
    `reopened after a reload: ${after.bodies} bodies, ${after.triangles} triangles, ` +
      `${after.history} history entries`,
  );
  if (after.name !== documentName) {
    throw new Error(`reopened as “${after.name}”, not “${documentName}”`);
  }
  if (after.bodies !== before.bodies || after.triangles !== before.triangles) {
    throw new Error(
      `the restored model differs: ${before.bodies} bodies / ${before.triangles} ` +
        `triangles became ${after.bodies} / ${after.triangles}`,
    );
  }
  if (after.history !== before.history) {
    throw new Error(
      `the construction record did not survive the build's reload: ` +
        `${before.history} entries became ${after.history}`,
    );
  }

  // The recovery instrumentation has to ship, or the phase breakdown describes
  // only the dev server. Read by prefix rather than by name so this does not
  // duplicate the phase names it cannot import from a build.
  const phases = await page.evaluate(() =>
    performance
      .getEntriesByType('measure')
      .filter((entry) => entry.name.startsWith('webcad:'))
      .map((entry) => `${entry.name.slice('webcad:'.length)} ${entry.duration.toFixed(1)} ms`),
  );
  if (phases.length === 0) {
    throw new Error(
      'the built app recorded no recovery phases, so the timings the findings ' +
        'report cannot be reproduced against a build',
    );
  }
  note(`recovery phases recorded in the build: ${phases.join(', ')}`);

  // Deleted so a re-run starts from an empty origin rather than reopening this
  // document before the demo scene is built.
  await page.locator('#doc-list li button', { hasText: 'Delete' }).first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('#doc-list li').length === 0,
    undefined,
    { timeout: 30_000 },
  );
  note('document deleted; the origin is left as it was found');

  // The verification handle is dev-only. If it survives into dist, the build is
  // not actually a production build and the browser run's findings would not
  // describe what ships.
  const devHandle = await page.evaluate(() => window.__webcad !== undefined);
  if (devHandle) {
    throw new Error('window.__webcad leaked into the production build');
  }
  note('dev-only verification handle is absent, as it should be');

  const broken = responses.filter((r) => r.status >= 400);
  if (broken.length > 0) {
    throw new Error(
      `the built app made failing requests:\n  ${broken
        .map((r) => `${r.status} ${r.url}`)
        .join('\n  ')}`,
    );
  }
  if (consoleErrors.length > 0) {
    throw new Error(`console errors:\n  ${consoleErrors.join('\n  ')}`);
  }
  note(`${responses.length} requests, none failing, no console errors`);

  console.log('\nProduction build verified.');
} catch (error) {
  failed = true;
  console.error(`\nProduction build verification failed:\n  ${error.message}`);
} finally {
  if (browser !== undefined) await browser.close();
  killTree(server);
}

process.exit(failed ? 1 : 0);
