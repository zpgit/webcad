// Drives the real app in a real browser and records MVP-0's browser-side
// measurements.
//
// Uses playwright-core against the installed system Chrome, so no browser
// binaries are downloaded. This is the only place the render path, the WebGPU/
// WebGL2 backend choice, and the GPU upload can actually be exercised - node
// tests cover everything up to the buffers a renderer consumes.
//
// Usage: node scripts/verify-browser.mjs [--headed] [--port 5199]

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import {
  devOrigin,
  killTree,
  shiftClick,
  startDevServer,
} from './_browser.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
// Exercises the WebGL2 fallback: the design keeps WebGL2 as the correctness
// reference, so it needs verifying too rather than being assumed to work.
const forceWebgl = args.includes('--force-webgl');
const expectedBackend = forceWebgl ? 'webgl2' : null;
const portIndex = args.indexOf('--port');
const port = portIndex === -1 ? 5199 : Number(args[portIndex + 1]);
const origin = devOrigin(port);

const findings = [];
const note = (message) => {
  findings.push(message);
  console.log(`  ${message}`);
};

/**
 * Measures what moving the kernel into a Worker cost and bought.
 *
 * Three questions, in the order the findings asked them: is the main thread
 * actually free while the kernel works, what does the round trip add on top of
 * kernel time, and what does moving a mesh across the boundary cost - with
 * transferables measured against plain structured cloning rather than assumed
 * better.
 */
async function measureWorkerBoundary(page) {
  return page.evaluate(async () => {
    const { kernel } = window.__webcad;

    const summarize = (values) => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      return {
        count: sorted.length,
        maxMs: sorted[sorted.length - 1],
        medianMs: sorted[Math.floor(sorted.length / 2)],
      };
    };

    // Transport overhead over the session so far: the demo scene and the
    // Boolean, as actually driven through the UI.
    const transport = kernel.operationLog
      .filter((entry) => entry.roundTripMs !== undefined)
      .map((entry) => ({
        operation: entry.operation,
        kernelMs: Number(entry.durationMs.toFixed(3)),
        roundTripMs: Number(entry.roundTripMs.toFixed(3)),
        transportMs: Number(
          Math.max(0, entry.roundTripMs - entry.durationMs).toFixed(3),
        ),
      }));

    /**
     * How long the main thread goes unavailable while an operation runs.
     *
     * A self-rescheduling timer, not requestAnimationFrame: headless Chrome
     * composites lazily and fires almost no frames, so a rAF probe reports
     * nothing and cannot distinguish a free main thread from a blocked one. A
     * timer measures event-loop availability, which is the actual claim - and a
     * synchronous 66 ms kernel call would show up as one 66 ms gap.
     *
     * The 4 ms period is the browser's own clamp for nested timers, so the
     * baseline gap is ~4-6 ms and anything at frame scale stands out.
     */
    const during = async (label, run) => {
      const gaps = [];
      let last = performance.now();
      let running = true;
      const tick = () => {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        if (running) setTimeout(tick, 4);
      };
      setTimeout(tick, 4);

      const started = performance.now();
      const value = await run();
      const wallMs = performance.now() - started;
      running = false;

      // The first sample spans probe setup rather than the operation.
      return {
        label,
        wallMs: Number(wallMs.toFixed(3)),
        mainThread: summarize(gaps.slice(1)),
        value,
      };
    };

    // Operations chosen to be long enough to sample.
    //
    // A plain drilled block costs ~9 ms here, not the ~66 ms MVP-0 recorded:
    // that figure included one-time OCCT setup which the session has already
    // paid by now. Nine milliseconds is too short to tell a free main thread
    // from a blocked one, so the probes below use genuinely expensive work - an
    // oblique cut through a large cylinder, and the finest tessellation the app
    // can ask for.
    const block = await kernel.createBox({ width: 60, depth: 40, height: 25 });
    const barrel = await kernel.createCylinder({
      radius: 80,
      height: 200,
      origin: [0, 0, -100],
    });
    const oblique = await kernel.createCylinder({
      radius: 30,
      height: 300,
      origin: [-100, -100, -100],
      axis: [1, 1, 1],
    });

    // The baseline the two probes below have to be read against: without it,
    // "6 ms worst stall" could be the kernel's shadow rather than the timer's
    // own scheduling noise.
    const idleProbe = await during(
      'idle baseline',
      () => new Promise((resolve) => setTimeout(resolve, 150)),
    );

    const booleanProbe = await during('oblique Boolean', () =>
      kernel.subtract(barrel, oblique),
    );
    const tessellationProbe = await during('fine tessellation', () =>
      kernel.tessellate(barrel, { linearDeflection: 0.002, angularDeflection: 0.01 }),
    );

    // --- transferables versus structured cloning ---------------------------
    //
    // An echo worker, so the measurement is a real postMessage rather than a
    // stand-in for one. Payloads are built before the timed loop; a transfer
    // detaches its source, so each iteration needs its own.
    const url = URL.createObjectURL(
      new Blob(['self.onmessage=(e)=>{self.postMessage(e.data.tag)}'], {
        type: 'text/javascript',
      }),
    );
    const echo = new Worker(url);

    const clonePayload = (mesh, tag) => ({
      tag,
      positions: mesh.positions.slice(),
      normals: mesh.normals.slice(),
      indices: mesh.indices.slice(),
    });

    const timeSends = async (mesh, iterations, transfer) => {
      const payloads = Array.from({ length: iterations }, (_, i) =>
        clonePayload(mesh, i),
      );
      const started = performance.now();
      for (const payload of payloads) {
        await new Promise((resolve) => {
          echo.onmessage = resolve;
          if (transfer) {
            echo.postMessage(payload, [
              payload.positions.buffer,
              payload.normals.buffer,
              payload.indices.buffer,
            ]);
          } else {
            echo.postMessage(payload);
          }
        });
      }
      return Number(((performance.now() - started) / iterations).toFixed(4));
    };

    const abAt = async (mesh, label, iterations) => {
      const bytes =
        mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength;
      // Warm up: the first postMessage of a session pays one-off costs.
      await timeSends(mesh, 3, true);
      return {
        label,
        bytes,
        triangles: mesh.indices.length / 3,
        transferMs: await timeSends(mesh, iterations, true),
        structuredCloneMs: await timeSends(mesh, iterations, false),
      };
    };

    const smallMesh = (await kernel.tessellate(block, { linearDeflection: 0.1 })).mesh;
    const transferAb = [
      await abAt(smallMesh, 'demo-scene mesh', 40),
      await abAt(tessellationProbe.value.mesh, 'fine tessellation', 12),
    ];

    echo.terminate();
    URL.revokeObjectURL(url);
    for (const id of [block, barrel, oblique]) {
      try {
        await kernel.release(id);
      } catch {
        // already consumed or released; not what is under measurement here
      }
    }

    return {
      responsiveness: [
        { ...idleProbe, value: undefined },
        { ...booleanProbe, value: undefined },
        { ...tessellationProbe, value: undefined },
      ],
      transport,
      transferAb,
      meshCopy: kernel.operationLog
        .filter((entry) => entry.transferBytes !== undefined)
        .map((entry) => ({
          triangles: entry.triangleCount ?? null,
          bytes: entry.transferBytes,
          copyMs: Number((entry.copyMs ?? 0).toFixed(4)),
        })),
    };
  });
}

async function readReadout(page) {
  return page.evaluate(() => {
    const out = {};
    const list = document.getElementById('measurements');
    const terms = [...(list?.querySelectorAll('dt') ?? [])];
    const values = [...(list?.querySelectorAll('dd') ?? [])];
    terms.forEach((dt, i) => {
      out[dt.textContent ?? ''] = values[i]?.textContent ?? '';
    });
    return out;
  });
}

let server;
let browser;
let exitCode = 0;

try {
  console.log('Starting dev server...');
  server = await startDevServer(port);

  browser = await chromium.launch({
    channel: 'chrome',
    headless: !headed,
    args: [
      // SwiftShader keeps WebGL working on headless machines without a real GPU.
      '--enable-unsafe-swiftshader',
      // Headless treats the page as backgrounded and throttles timers to about
      // one a second. That is fatal to the main-thread responsiveness probe,
      // which needs the event loop ticking at its normal rate to tell a free
      // main thread from a blocked one.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  if (forceWebgl) {
    // The viewport probes `'gpu' in navigator`, so the property has to go from
    // the prototype - assigning undefined would still satisfy the `in` check.
    await page.addInitScript(() => {
      delete Object.getPrototypeOf(navigator).gpu;
    });
  }

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  const failedRequests = [];
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });

  console.log(`Opening ${origin} ...`);
  await page.goto(origin, { waitUntil: 'load' });

  // The fatal panel is how the app reports an unsupported environment or a
  // missing kernel; surfacing its text beats a timeout further down.
  const fatal = page.locator('#fatal:not([hidden])');
  if ((await fatal.count()) > 0) {
    throw new Error(`app reported a fatal error: ${await fatal.innerText()}`);
  }

  // Kernel readiness shows up as a real OCCT version in the readout.
  await page.waitForFunction(
    () => {
      const list = document.getElementById('measurements');
      return (list?.textContent ?? '').match(/\d+\.\d+\.\d+/) !== null;
    },
    { timeout: 60_000 },
  );

  const initial = await readReadout(page);
  note(`render backend: ${initial['Backend']}`);
  if (expectedBackend !== null && initial['Backend'] !== expectedBackend) {
    throw new Error(
      `expected the ${expectedBackend} backend, got ${initial['Backend']}`,
    );
  }
  note(`OCCT: ${initial['OCCT']}`);

  console.log('Building the demo scene...');
  await page.click('#btn-demo');
  await page.waitForFunction(
    () => {
      const list = document.getElementById('measurements');
      const text = list?.textContent ?? '';
      const match = text.match(/Live bodies(\d+)/);
      return match !== null && Number(match[1]) >= 2;
    },
    { timeout: 60_000 },
  );

  const afterCreate = await readReadout(page);
  note(`after demo scene: ${afterCreate['Live bodies']} bodies, ${afterCreate['Triangles']} triangles`);
  note(`WASM memory ${afterCreate['WASM memory']} (peak ${afterCreate['WASM peak']})`);

  mkdirSync('measurements', { recursive: true });
  await page.screenshot({
    path: forceWebgl
      ? 'measurements/viewport-bodies-webgl2.png'
      : 'measurements/viewport-bodies.png',
  });

  // Pick both bodies through the viewport so selection and picking are really
  // exercised, rather than driving the kernel directly.
  //
  // The demo scene overlaps its two bodies on purpose (a drill through a block),
  // so a hardcoded pair of pixels can easily hit the same one. Instead: select
  // something, then scan for a point that adds a *different* body. That verifies
  // picking and ordered multi-select without assuming a screen layout.
  console.log('Selecting both bodies by clicking the viewport...');
  const canvasBox = await page.locator('#viewport').boundingBox();
  const selectedCount = async () =>
    Number((await readReadout(page))['Selected'] ?? '0');

  const at = (fx, fy) => ({
    x: canvasBox.x + canvasBox.width * fx,
    y: canvasBox.y + canvasBox.height * fy,
  });

  // Ask the viewport which body sits under each candidate pixel, using the same
  // raycast the click handler uses. This finds two points that hit *different*
  // bodies instead of hoping two guessed pixels happen to.
  const hitMap = await page.evaluate(
    ({ rect }) => {
      const viewport = window.__webcad?.viewport;
      if (viewport === undefined) return null;
      const found = [];
      for (let fx = 0.15; fx <= 0.85; fx += 0.05) {
        for (let fy = 0.15; fy <= 0.85; fy += 0.05) {
          const x = rect.x + rect.width * fx;
          const y = rect.y + rect.height * fy;
          const bodyId = viewport.pickAt(x, y);
          if (bodyId !== null) found.push({ x, y, bodyId });
        }
      }
      return found;
    },
    { rect: canvasBox },
  );

  if (hitMap === null) {
    throw new Error('the dev verification handle (window.__webcad) is missing');
  }

  const distinct = [...new Set(hitMap.map((h) => h.bodyId))];
  note(`picking found ${distinct.length} distinct bodies across ${hitMap.length} hit points`);
  if (distinct.length < 2) {
    throw new Error(
      `only ${distinct.length} body/bodies are pickable; expected 2 from the demo scene`,
    );
  }

  // Which body is picked FIRST is the Boolean target, so operand order decides
  // what the operation means. Identify the block (6 faces) and the drill (3
  // faces) and select the block first, so this verifies the canonical
  // drilled-block result rather than whichever order the scan happened to find.
  const identified = await page.evaluate(async (ids) => {
    const { kernel } = window.__webcad;
    const out = [];
    for (const id of ids) {
      const info = await kernel.bodyInfo(id);
      out.push({ bodyId: id, faceCount: info.faceCount, volume: info.volume });
    }
    return out;
  }, distinct);

  const block = identified.find((b) => b.faceCount === 6);
  const drill = identified.find((b) => b.faceCount === 3);
  if (block === undefined || drill === undefined) {
    throw new Error(
      `expected a 6-face block and a 3-face cylinder, got ${JSON.stringify(identified)}`,
    );
  }
  note(`block volume ${block.volume.toFixed(1)}, drill volume ${drill.volume.toFixed(1)}`);

  const anchor = hitMap.find((h) => h.bodyId === block.bodyId);
  const other = hitMap.find((h) => h.bodyId === drill.bodyId);

  await page.mouse.click(anchor.x, anchor.y);
  if ((await selectedCount()) !== 1) {
    throw new Error('clicking a body did not select it');
  }
  await shiftClick(page, other.x, other.y);

  const selected = await selectedCount();
  note(`viewport picking selected ${selected} bodies`);
  if (selected !== 2) {
    throw new Error(
      `expected 2 bodies selected, got ${selected} - multi-select is broken`,
    );
  }

  // Clicking empty space must clear the selection.
  await page.mouse.click(canvasBox.x + 6, canvasBox.y + 6);
  const cleared = await selectedCount();
  if (cleared !== 0) {
    throw new Error(`clicking empty space left ${cleared} bodies selected`);
  }
  note('clicking empty space cleared the selection');

  // Restore the two-body selection for the Boolean.
  await page.mouse.click(anchor.x, anchor.y);
  await shiftClick(page, other.x, other.y);
  if ((await selectedCount()) !== 2) {
    throw new Error('could not restore a two-body selection');
  }

  console.log('Applying subtract...');
  await page.click('#btn-subtract');
  await page.waitForFunction(
    () => {
      const text = document.getElementById('measurements')?.textContent ?? '';
      const match = text.match(/Live bodies(\d+)/);
      return match !== null && Number(match[1]) === 1;
    },
    { timeout: 60_000 },
  );

  await page.click('#btn-fit');

  // The demo block is 60x40x25 with a radius-12 drill straight through it, so
  // the result volume is exact arithmetic - a real correctness check rather than
  // "a body came back".
  const resultInfo = await page.evaluate(async () => {
    const { kernel, viewport } = window.__webcad;
    const bodyId = [...viewport.selection][0] ?? null;
    const stats = kernel.stats();
    // Only one body remains after the session releases the operands.
    for (let id = 1; id <= stats.totalBodiesCreated; id++) {
      try {
        const info = await kernel.bodyInfo(id);
        return {
          bodyId: id,
          volume: info.volume,
          faceCount: info.faceCount,
          solidCount: info.solidCount,
          isValid: info.isValid,
          selected: bodyId,
        };
      } catch {
        // released operand; keep looking
      }
    }
    return null;
  });

  if (resultInfo === null) throw new Error('no surviving body after the Boolean');

  const expectedVolume = 60 * 40 * 25 - Math.PI * 12 * 12 * 25;
  const volumeError = Math.abs(resultInfo.volume - expectedVolume);
  note(
    `subtract result: volume ${resultInfo.volume.toFixed(1)} ` +
      `(expected ${expectedVolume.toFixed(1)}), ${resultInfo.faceCount} faces, ` +
      `${resultInfo.solidCount} solid, valid=${resultInfo.isValid}`,
  );
  if (volumeError > 1e-3) {
    throw new Error(
      `drilled-block volume is wrong by ${volumeError.toFixed(4)} - ` +
        'the Boolean or the operand order is incorrect',
    );
  }
  if (!resultInfo.isValid) throw new Error('the Boolean produced an invalid solid');

  const afterBoolean = await readReadout(page);
  note(
    `after subtract: ${afterBoolean['Live bodies']} body, ` +
      `${afterBoolean['Triangles']} triangles, slowest ${afterBoolean['Slowest op']}`,
  );
  await page.screenshot({
    path: forceWebgl
      ? 'measurements/viewport-after-subtract-webgl2.png'
      : 'measurements/viewport-after-subtract.png',
  });

  // Confirms something was actually drawn: an all-background image would mean
  // the upload or the render loop silently did nothing.
  const canvasShot = (await page.locator('#viewport').screenshot()).toString('base64');
  const drawn = await page.evaluate(async (base64) => {
    // Round-tripping through the PNG is what makes this reliable: reading a
    // WebGPU-backed canvas directly via drawImage yields transparent pixels, so
    // an earlier direct check reported "empty" while the app was rendering fine.
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();

    const probe = document.createElement('canvas');
    probe.width = image.width;
    probe.height = image.height;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    if (ctx === null) return { checked: false, reason: 'no 2d context' };
    ctx.drawImage(image, 0, 0);

    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    let nonBackground = 0;
    const total = data.length / 4;
    // Background is #1a1d21.
    for (let i = 0; i < data.length; i += 4) {
      const delta =
        Math.abs(data[i] - 0x1a) +
        Math.abs(data[i + 1] - 0x1d) +
        Math.abs(data[i + 2] - 0x21);
      if (delta > 24) nonBackground++;
    }
    return { checked: true, nonBackgroundFraction: nonBackground / total };
  }, canvasShot);

  if (drawn.checked) {
    note(
      `non-background pixels: ${(drawn.nonBackgroundFraction * 100).toFixed(1)}%`,
    );
    if (drawn.nonBackgroundFraction < 0.005) {
      throw new Error('viewport appears empty - nothing was rendered');
    }
  } else {
    note(`pixel check skipped (${drawn.reason}); relying on screenshots`);
  }

  console.log('Measuring the Worker boundary...');
  const boundary = await measureWorkerBoundary(page);

  const FRAME_MS = 1000 / 60;
  for (const probe of boundary.responsiveness) {
    if (probe.mainThread === null || probe.mainThread.count < 5) {
      throw new Error(
        `too few main-thread samples during ${probe.label}; the responsiveness ` +
          'measurement is inconclusive rather than passing',
      );
    }
    note(
      `${probe.label}: ${probe.wallMs.toFixed(1)} ms wall, ` +
        `worst main-thread stall ${probe.mainThread.maxMs.toFixed(1)} ms ` +
        `(median ${probe.mainThread.medianMs.toFixed(1)} ms over ${probe.mainThread.count} samples)`,
    );
    // A main thread still running the kernel would stall for roughly the whole
    // operation, so the two outcomes are far apart; this sits between them with
    // room for scheduler noise on either side.
    const ceiling = Math.max(3 * FRAME_MS, probe.wallMs * 0.25);
    if (probe.mainThread.maxMs > ceiling) {
      throw new Error(
        `${probe.label} stalled the main thread for ${probe.mainThread.maxMs.toFixed(1)} ms ` +
          `(limit ${ceiling.toFixed(1)} ms) - the kernel is not off the main thread`,
      );
    }
  }

  const transportCosts = boundary.transport.map((entry) => entry.transportMs);
  if (transportCosts.length > 0) {
    const total = transportCosts.reduce((sum, value) => sum + value, 0);
    note(
      `transport overhead across ${transportCosts.length} operations: ` +
        `${total.toFixed(1)} ms total, worst ${Math.max(...transportCosts).toFixed(1)} ms`,
    );
  }

  for (const ab of boundary.transferAb) {
    note(
      `${ab.label} (${(ab.bytes / 1024).toFixed(0)} kB): ` +
        `transfer ${ab.transferMs.toFixed(3)} ms vs clone ${ab.structuredCloneMs.toFixed(3)} ms`,
    );
  }

  // Long operations are still reported, but as latency rather than as dropped
  // frames: with the kernel in a Worker the duration is what the user waits for,
  // not how long the UI was frozen. Main-thread blocking is measured separately.
  const latencyFlags = await page
    .locator('#oplog li')
    .evaluateAll((items) =>
      items.filter((li) => li.textContent?.includes('frame latency')).length,
    );
  note(`operations over a frame of latency in the readout: ${latencyFlags}`);

  if (failedRequests.length > 0) {
    note(`failed requests: ${failedRequests.join(', ')}`);
  }

  // A missing favicon is browser noise, not a defect in the app under test. It
  // is reported above so it stays visible rather than being silently swallowed.
  const isFaviconNoise = (text) => /favicon/i.test(text);
  const realFailures = failedRequests.filter((r) => !isFaviconNoise(r));
  const faviconOnly404 =
    failedRequests.length > 0 && failedRequests.every(isFaviconNoise);
  const realConsoleErrors = consoleErrors.filter(
    (text) =>
      !isFaviconNoise(text) &&
      !(faviconOnly404 && /status of 404/.test(text)),
  );

  if (realFailures.length > 0 || realConsoleErrors.length > 0) {
    throw new Error(
      `page errors:\n  - ${[...realFailures, ...realConsoleErrors].join('\n  - ')}`,
    );
  }

  writeFileSync(
    forceWebgl ? 'measurements/browser-webgl2.json' : 'measurements/browser.json',
    `${JSON.stringify(
      {
        backend: initial['Backend'],
        occtVersion: initial['OCCT'],
        afterDemoScene: afterCreate,
        afterSubtract: afterBoolean,
        nonBackgroundFraction: drawn.nonBackgroundFraction ?? null,
        latencyFlagsShown: latencyFlags,
        findings,
      },
      null,
      2,
    )}\n`,
  );

  // The Worker-boundary numbers land in their own file: they answer a different
  // question from the render-path checks, and MVP-1 will want to track them
  // across builds the way payload.json tracks size.
  const boundaryPath = forceWebgl
    ? 'measurements/worker-webgl2.json'
    : 'measurements/worker.json';
  writeFileSync(
    boundaryPath,
    `${JSON.stringify(
      { backend: initial['Backend'], occtVersion: initial['OCCT'], ...boundary },
      null,
      2,
    )}\n`,
  );

  console.log('\nBrowser verification PASSED');
  console.log('  screenshots: measurements/viewport-*.png');
  console.log(
    `  measurements: measurements/${forceWebgl ? 'browser-webgl2' : 'browser'}.json, ${boundaryPath}`,
  );
} catch (error) {
  exitCode = 1;
  console.error(`\nBrowser verification FAILED\n  ${error.message}`);
} finally {
  await browser?.close();
  killTree(server);
}

process.exit(exitCode);
