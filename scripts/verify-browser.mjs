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
     * A self-rescheduling MessageChannel, not requestAnimationFrame and not a
     * timer. rAF is out because headless Chrome composites lazily and fires
     * almost no frames, so it cannot tell a free main thread from a blocked
     * one. A timer was the obvious replacement and measured the right thing -
     * event-loop availability, where a synchronous 66 ms kernel call shows up
     * as one 66 ms gap - but it is not portable: on the GitHub runner this
     * probe collected zero samples across a 417 ms window, because a page
     * Chrome considers backgrounded has its timers aligned to about one a
     * second. The three --disable-*-throttling launch flags below do not
     * prevent it, and the page reports itself visible either way, so there is
     * nothing to detect and correct.
     *
     * A postMessage task is not a timer, so no clamp and no alignment applies
     * to it. The cost is that it ticks as fast as the queue drains - roughly
     * 200k times a second, against a timer's 250 - which keeps the main thread
     * busy. That is affordable here and does not bias the result: every probe
     * pays it equally, which is what the idle baseline is for.
     *
     * The floor is now sub-millisecond rather than the timer's 4-6 ms, so
     * anything at frame scale stands out further than it did.
     */
    const during = async (label, run) => {
      const gaps = [];
      let last = performance.now();
      let running = true;
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        if (running) channel.port2.postMessage(0);
      };
      channel.port2.postMessage(0);

      const started = performance.now();
      const value = await run();
      const wallMs = performance.now() - started;
      running = false;
      channel.port1.close();
      channel.port2.close();

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
  // 60 s rather than the 30 s default: the dev server transforms the whole
  // module graph and pre-bundles three.js on the first request, and on a busy
  // machine that has taken longer than 30 s - which arrives as a navigation
  // timeout that looks like a broken app rather than a slow one.
  await page.goto(origin, { waitUntil: 'load', timeout: 60_000 });

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
    undefined,
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
    undefined,
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
    undefined,
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

  // A checkpoint round trip across the real Worker.
  //
  // The Node suite drives the same handler in process, where a "transferred"
  // buffer never crosses a thread and a missing transfer list is invisible.
  // This is correctness only - throughput and recovery cost belong to the
  // document stage, which has somewhere to put them.
  const roundTrip = await page.evaluate(async (bodyId) => {
    const { kernel } = window.__webcad;
    const before = await kernel.bodyInfo(bodyId);
    const beforeFaces = await kernel.faceTypeSummary(bodyId);

    const payload = await kernel.serialize([bodyId]);
    const size = payload.bytes.byteLength;
    const restored = await kernel.restore(payload.bytes);

    const after = await kernel.bodyInfo(restored[0]);
    const afterFaces = await kernel.faceTypeSummary(restored[0]);
    await kernel.release(restored[0]);

    return {
      size,
      format: payload.format,
      // Zero once the buffer has moved into the Worker. A clone would leave it
      // readable here, which is the failure this exists to catch.
      remainingBytes: payload.bytes.byteLength,
      before,
      after,
      volumeError: Math.abs(after.volume - before.volume),
      surfacesMatch: JSON.stringify(afterFaces) === JSON.stringify(beforeFaces),
      cylinders: afterFaces.cylinder,
    };
  }, resultInfo.bodyId);

  note(
    `checkpoint round trip: ${roundTrip.size} bytes (${roundTrip.format}), ` +
      `volume error ${roundTrip.volumeError.toExponential(1)}, ` +
      `${roundTrip.cylinders} analytic cylinder preserved`,
  );
  if (roundTrip.remainingBytes !== 0) {
    throw new Error(
      'the restore payload was cloned rather than transferred into the worker',
    );
  }
  if (roundTrip.volumeError > 1e-6) {
    throw new Error('a checkpoint round trip did not preserve the geometry');
  }
  if (!roundTrip.surfacesMatch || roundTrip.cylinders !== 1) {
    throw new Error(
      'a checkpoint round trip did not preserve exact analytic surfaces',
    );
  }
  for (const key of ['faceCount', 'edgeCount', 'vertexCount', 'solidCount', 'isValid', 'isClosed']) {
    if (roundTrip.before[key] !== roundTrip.after[key]) {
      throw new Error(
        `a checkpoint round trip changed ${key}: ` +
          `${roundTrip.before[key]} -> ${roundTrip.after[key]}`,
      );
    }
  }

  // The bounding box legitimately differs, and it is the restored body that is
  // right. BRepBndLib uses a face's triangulation when it has one, so a
  // displayed body reports a box inflated by roughly the mesh deflection; a
  // restored body has no triangulation yet and reports the exact extents. The
  // check is therefore against the block's true size rather than against what
  // the body reported before saving.
  const exact = { min: [-30, -20, 0], max: [30, 20, 25] };
  const boxError = Math.max(
    ...['min', 'max'].flatMap((end) =>
      roundTrip.after.boundingBox[end].map((v, i) => Math.abs(v - exact[end][i])),
    ),
  );
  const inflation = Math.abs(roundTrip.before.boundingBox.max[0] - exact.max[0]);
  note(
    `restored bounds are exact to ${boxError.toExponential(1)}; ` +
      `the tessellated body reported them inflated by ${inflation.toFixed(4)}`,
  );
  if (boxError > 1e-6) {
    throw new Error(
      `restored geometry has the wrong extents, off by ${boxError.toExponential(1)}`,
    );
  }

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
  // The baseline is the probe's own noise floor, not a claim about the kernel,
  // so it is reported and never asserted on - the same call the document
  // measurements below already make. Two unrelated things leave it without
  // samples: an environment that throttles timers, and a main thread that
  // happened to be busy for the whole 150 ms. Neither says anything about where
  // the kernel runs, and on a shared CI runner both happen.
  const baselineSamples =
    boundary.responsiveness.find((probe) => probe.label === 'idle baseline')
      ?.mainThread?.count ?? 0;

  // Whether this machine can run the measurement at all, decided by the
  // baseline before any probe is judged.
  //
  // A blocked main thread and an unschedulable one produce the same empty
  // sample set, and only the baseline can tell them apart: it runs while
  // nothing else does, so if it cannot tick, nothing here can. A 2-vCPU CI
  // runner compositing WebGPU through SwiftShader is such a machine - the
  // baseline collects 1 sample there against tens of thousands on a
  // developer's box, and its own 150 ms sleep takes 400 ms.
  //
  // So an unusable environment is reported as not exercised rather than failed,
  // the way a missing STEP fixture and an unenforced storage quota already are.
  // Failing would say the kernel is on the main thread, which is not what was
  // observed; passing silently would let a real regression through on the one
  // machine that gates merges. Neither is honest, and the assertions below
  // still bite everywhere the probe works.
  const probeCanTick = baselineSamples >= 5;
  if (!probeCanTick) {
    note(
      `responsiveness not exercised: the idle baseline collected only ` +
        `${baselineSamples} sample${baselineSamples === 1 ? '' : 's'} over ${
          boundary.responsiveness.find((probe) => probe.label === 'idle baseline')
            ?.wallMs.toFixed(0) ?? '?'
        } ms, so this machine cannot schedule the main thread often enough to ` +
        'tell a free one from a blocked one. The readings below are recorded ' +
        'but nothing is asserted on them.',
    );
  }

  for (const probe of boundary.responsiveness) {
    const samples = probe.mainThread?.count ?? 0;
    note(
      `${probe.label}: ${probe.wallMs.toFixed(1)} ms wall, ` +
        (probe.mainThread === null
          ? 'no main-thread samples'
          : `worst main-thread stall ${probe.mainThread.maxMs.toFixed(1)} ms ` +
            `(median ${probe.mainThread.medianMs.toFixed(1)} ms over ${samples} samples)`),
    );
    if (probe.label === 'idle baseline') continue;
    if (!probeCanTick) continue;

    if (samples < 5) {
      // Reaching here means the baseline ticked freely and this probe did not,
      // so nothing was wrong with the instrument and the thread really was
      // blocked - which is the failure this whole section exists to catch.
      throw new Error(
        `only ${samples} main-thread samples during ${probe.label} while the ` +
          `idle baseline collected ${baselineSamples} - the main thread was ` +
          'blocked for essentially the whole operation, so the kernel is not ' +
          'off the main thread',
      );
    }

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

  // What persistence costs.
  //
  // The measurement itself lives in `tests/browser/document-measurements.ts`,
  // loaded through the dev server so it runs against the real kernel, the real
  // document layer, and both real stores. This is the harness: it drives that
  // module and turns what it returns into findings and thresholds.
  //
  // It runs before the reload section below, which navigates away and takes the
  // session with it.
  console.log('Measuring serialization, storage, and persistence stalls...');
  const documents = await page.evaluate(async () => {
    const { measureDocumentPersistence } = await import(
      '/tests/browser/document-measurements.ts'
    );
    return measureDocumentPersistence(window.__webcad.kernel);
  });

  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

  for (const sample of documents.serialization) {
    note(
      `${sample.label}: ${sample.bodyCount} ` +
        `${sample.bodyCount === 1 ? 'body' : 'bodies'}, ${sample.faceCount} faces, ` +
        `${kb(sample.bytes)} — serialize ${sample.serialize.medianMs.toFixed(2)} ms ` +
        `(${sample.serializeKbPerMs} kB/ms), restore ` +
        `${sample.restore.medianMs.toFixed(2)} ms (${sample.restoreKbPerMs} kB/ms)`,
    );
  }

  // Throughput "as a function of size" needs the ladder to actually span sizes.
  // Without this the artifact could report five points that are all the same
  // size and the findings would be extrapolating from one.
  const payloadSizes = documents.serialization.map((s) => s.bytes);
  const spread = Math.max(...payloadSizes) / Math.min(...payloadSizes);
  note(
    `payload ladder spans ${kb(Math.min(...payloadSizes))} to ` +
      `${kb(Math.max(...payloadSizes))} (${spread.toFixed(0)}x)`,
  );
  if (spread < 10) {
    throw new Error(
      `the payload ladder only spans ${spread.toFixed(1)}x, which cannot support ` +
        'a claim about throughput as a function of size',
    );
  }

  if (documents.unavailableBackends.length > 0) {
    throw new Error(
      'a storage backend could not be measured, so the default cannot be ' +
        `chosen on evidence: ${documents.unavailableBackends
          .map((b) => `${b.backend} (${b.reason})`)
          .join(', ')}`,
    );
  }

  for (const sample of documents.storage) {
    note(
      `${sample.backend} / ${sample.workload} (${kb(sample.bytes)}): ` +
        `save ${sample.save.medianMs.toFixed(2)} ms, ` +
        `read ${sample.read.medianMs.toFixed(2)} ms, ` +
        `open ${sample.open.medianMs.toFixed(2)} ms, ` +
        `list ${sample.list.medianMs.toFixed(2)} ms, ` +
        `remove ${sample.remove.medianMs.toFixed(2)} ms`,
    );
  }

  // Listing must not scale with checkpoint size: the document list is UI, and a
  // store that reads a checkpoint to show a name would make opening the list
  // cost what opening a document costs.
  for (const backend of ['indexeddb', 'opfs']) {
    const samples = documents.storage.filter((s) => s.backend === backend);
    const worstList = Math.max(...samples.map((s) => s.list.medianMs));
    if (worstList > FRAME_MS) {
      note(
        `finding: listing documents on ${backend} costs ${worstList.toFixed(2)} ms, ` +
          'over a frame',
      );
    }
  }

  // The same question the Worker boundary asked, asked again for this section:
  // these are separate probe runs, so they need their own evidence rather than
  // the boundary's. There is a baseline per backend and none for the
  // kernel-only probe, so the most favourable one decides - if the best window
  // this machine managed could not tick, none of them could.
  const documentBaselineSamples = documents.stalls
    .filter((stall) => stall.label === 'idle baseline')
    .reduce((best, stall) => Math.max(best, stall.samples), 0);
  const documentProbeCanTick = documentBaselineSamples >= 5;
  if (!documentProbeCanTick) {
    note(
      'persistence responsiveness not exercised: the best idle baseline ' +
        `collected only ${documentBaselineSamples} ` +
        `sample${documentBaselineSamples === 1 ? '' : 's'}, so this machine ` +
        'cannot schedule the main thread often enough to tell a free one from ' +
        'a blocked one. The readings below are recorded but nothing is ' +
        'asserted on them.',
    );
  }

  for (const stall of documents.stalls) {
    // A null backend means the probe is not attributable to storage at all -
    // the restore-only one, which answers the Worker spec's responsiveness
    // requirement rather than the storage spec's.
    const who = stall.backend ?? 'kernel';
    note(
      `${who} ${stall.label}${stall.bytes > 0 ? ` (${kb(stall.bytes)})` : ''}: ` +
        `${stall.wallMs.toFixed(1)} ms wall over ${stall.iterations}x, ` +
        `worst main-thread stall ${stall.worstStallMs.toFixed(1)} ms ` +
        `(median ${stall.medianStallMs.toFixed(1)} ms over ${stall.samples} samples)`,
    );
    if (stall.label === 'idle baseline') continue;
    if (!documentProbeCanTick) continue;
    if (stall.samples < 5) {
      // The baseline ticked and this did not, so the instrument was fine and
      // the thread was blocked.
      throw new Error(
        `only ${stall.samples} main-thread samples during ${who} ` +
          `${stall.label} while the idle baseline collected ` +
          `${documentBaselineSamples} - the main thread was blocked for ` +
          'essentially the whole operation',
      );
    }
    // One frame is a finding, three frames is a failure - the same bound the
    // Worker stage set for kernel operations. Persistence must not reintroduce
    // the stall that moving the kernel off the main thread removed.
    if (stall.worstStallMs > 3 * FRAME_MS) {
      throw new Error(
        `${who} ${stall.label} stalled the main thread for ` +
          `${stall.worstStallMs.toFixed(1)} ms on a ${kb(stall.bytes)} document ` +
          `(limit ${(3 * FRAME_MS).toFixed(1)} ms)`,
      );
    }
    if (stall.worstStallMs > FRAME_MS) {
      note(
        `finding: ${who} ${stall.label} stalled the main thread for ` +
          `${stall.worstStallMs.toFixed(1)} ms on a ${kb(stall.bytes)} document, ` +
          'over one frame budget',
      );
    }
  }

  // What a STEP round trip costs and loses.
  //
  // MVP-2's question, and like the persistence measurement it lives next to the
  // code under measurement (`tests/browser/step-measurements.ts`) so it runs
  // against the real kernel through the real Worker. This is the harness: it
  // drives that module, turns what it returns into findings, and decides what
  // counts as a failure.
  //
  // The fixtures are OCCT's own test data under a gitignored path. When they are
  // missing this reports that it could not run rather than reporting success -
  // a measurement that never happened must not read like one that passed.
  console.log('Measuring the STEP round trip...');
  const step = await page.evaluate(async () => {
    const { measureStepRoundTrip } = await import(
      '/tests/browser/step-measurements.ts'
    );
    return measureStepRoundTrip(window.__webcad.kernel);
  });

  for (const missing of step.unavailableFixtures) {
    note(`STEP fixture not exercised: ${missing.fixture} - ${missing.reason}`);
  }
  for (const message of step.notes) note(`STEP: ${message}`);

  const phaseOf = (fixture, name) =>
    fixture.timings.find((timing) => timing.phase === name);

  for (const fixture of step.fixtures) {
    const importPhase = phaseOf(fixture, 'import');
    const exportPhase = phaseOf(fixture, 'export');
    const tessellate = phaseOf(fixture, 'tessellate');

    note(
      `${fixture.fixture}: ${kb(fixture.fileBytes)} in, ` +
        `${fixture.imported.bodyCount} ${fixture.imported.bodyCount === 1 ? 'body' : 'bodies'}, ` +
        `${fixture.imported.faceCount} faces — ` +
        `import ${importPhase ? importPhase.ms.toFixed(1) : '?'} ms, ` +
        `tessellate ${tessellate ? tessellate.ms.toFixed(1) : '?'} ms, ` +
        `export ${exportPhase ? exportPhase.ms.toFixed(1) : '?'} ms ` +
        `(${kb(fixture.exportBytes)} out), ` +
        `checkpoint ${kb(fixture.checkpointBytes)}`,
    );
    note(
      `${fixture.fixture}: declared unit ` +
        `${fixture.importReport.unitWasAssumed ? 'none' : fixture.importReport.declaredUnit}` +
        ` -> ${fixture.importReport.workingUnit}; ` +
        `${fixture.importReport.rootShapeCount} roots, ` +
        `${fixture.importReport.unregisteredShapeCount} unusable, ` +
        `${fixture.importReport.openBodyCount} not closed solids; ` +
        `dropped ${fixture.importReport.namedProductCount} named products, ` +
        `${fixture.importReport.styledItemCount} styles, ` +
        `${fixture.importReport.assemblyNodeCount} assembly nodes`,
    );

    // The healer's contribution, stated as a delta rather than folded into the
    // translation numbers. This is the figure that decides the shipped default.
    if (fixture.healedReport === null) {
      note(`${fixture.fixture}: shape processing could not be measured`);
    } else if (fixture.healingDeltas.length === 0) {
      note(
        `${fixture.fixture}: OCCT shape processing (${fixture.healedReport.shapeProcessing}) ` +
          'changed nothing measurable',
      );
    } else {
      note(
        `${fixture.fixture}: OCCT shape processing changed ` +
          fixture.healingDeltas
            .map((delta) => `${delta.field} ${delta.before} -> ${delta.after}`)
            .join(', '),
      );
    }

    // A native checkpoint is known to be lossless (MVP-1), so it acts as a
    // control on the comparison method itself. If this leg reports a delta, the
    // census is wrong before any conclusion about STEP can be drawn.
    if (fixture.checkpointDeltas.length > 0) {
      throw new Error(
        `${fixture.fixture}: a native checkpoint round trip changed ` +
          fixture.checkpointDeltas
            .map((delta) => `${delta.field} ${delta.before} -> ${delta.after}`)
            .join(', ') +
          ' - the comparison method is suspect, not the translator',
      );
    }

    if (fixture.reimportDeltas.length === 0) {
      note(`${fixture.fixture}: STEP round trip preserved the full census`);
    } else {
      note(
        `finding: ${fixture.fixture} STEP round trip changed ` +
          fixture.reimportDeltas
            .map(
              (delta) =>
                `${delta.field} ${delta.before} -> ${delta.after}` +
                (delta.relative === undefined
                  ? ''
                  : ` (${(delta.relative * 100).toFixed(4)}%)`),
            )
            .join(', '),
      );
    }
  }

  // The edit leg, on geometry authored here so it always runs and its expected
  // volume is arithmetic rather than whatever a fixture happened to hold.
  if (step.edit === null) {
    throw new Error('the STEP edit round trip did not run');
  }
  const edit = step.edit;
  note(
    `edit round trip: ${edit.label}, removed ` +
      `${edit.volumeRemoved.toFixed(1)} mm³, exported ${kb(edit.exportBytes)}, ` +
      `re-imported with ${edit.deltas.length} differences`,
  );

  // Section 5 of the architecture note in one assertion: an edit made in the
  // browser has to be in the exported file. A writer that exported the
  // pre-Boolean geometry would pass every other check here.
  if (edit.afterReimport.volume >= edit.beforeEdit.volume) {
    throw new Error(
      'the exported STEP did not contain the edit: re-imported volume ' +
        `${edit.afterReimport.volume.toFixed(1)} is not less than the ` +
        `pre-edit ${edit.beforeEdit.volume.toFixed(1)}`,
    );
  }
  const volumeDrift = Math.abs(
    (edit.afterReimport.volume - edit.afterEdit.volume) / edit.afterEdit.volume,
  );
  if (volumeDrift > 1e-6) {
    throw new Error(
      `a STEP round trip changed the edited volume by ${(volumeDrift * 100).toFixed(4)}%`,
    );
  }
  // The cylindrical face the drill introduced must still be an exact cylinder.
  // A faceted or spline-approximated export is the failure mode that looks like
  // success everywhere else.
  const cylindersBefore = edit.afterEdit.surfaces.cylinder ?? 0;
  const cylindersAfter = edit.afterReimport.surfaces.cylinder ?? 0;
  if (cylindersBefore === 0 || cylindersAfter !== cylindersBefore) {
    throw new Error(
      `a STEP round trip did not preserve analytic cylinders: ` +
        `${cylindersBefore} -> ${cylindersAfter}`,
    );
  }

  note(
    `peak WASM memory after translation: ${kb(step.peakWasmMemoryBytes)}`,
  );

  // Save, reload, and see the model come back.
  //
  // This is MVP-1's actual question, and it can only be asked of a real browser
  // that has really been restarted: everything up to here proves the pieces
  // work in one page's lifetime, which is exactly what a reload invalidates.
  //
  // It runs last because it navigates away, discarding the session every check
  // above depends on.
  console.log('Saving and reopening after a reload...');

  const beforeReload = await page.evaluate(async () => {
    const { session, kernel } = window.__webcad;

    session.rename('Verification');
    const bodies = session.document.bodies;
    const infos = [];
    for (const { ref, handle } of bodies) {
      const info = await kernel.bodyInfo(handle);
      infos.push({ ref, volume: info.volume, faceCount: info.faceCount });
    }

    const summary = await session.save();
    return { infos, summary, historyLength: session.document.entries.length };
  });

  note(
    `saved “${beforeReload.summary.name}”: ${beforeReload.infos.length} ` +
      `${beforeReload.infos.length === 1 ? 'body' : 'bodies'}, ` +
      `${(beforeReload.summary.byteLength / 1024).toFixed(1)} kB, ` +
      `${beforeReload.historyLength} history entries`,
  );
  if (beforeReload.infos.length === 0) {
    throw new Error('nothing was saved - the session held no bodies');
  }

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__webcad?.kernel?.isReady === true,
    undefined,
    { timeout: 60_000 },
  );
  // Restoration is awaited during startup, so by the time the handle exists the
  // document is either open or the failure has been reported on the page.
  await page.waitForFunction(
    () => (window.__webcad?.session?.document?.bodies.length ?? 0) > 0,
    undefined,
    { timeout: 60_000 },
  );

  const afterReload = await page.evaluate(async () => {
    const { session, kernel, viewport } = window.__webcad;
    const infos = [];
    for (const { ref, handle } of session.document.bodies) {
      const info = await kernel.bodyInfo(handle);
      infos.push({ ref, volume: info.volume, faceCount: info.faceCount });
    }
    return {
      name: session.document.name,
      infos,
      historyLength: session.document.entries.length,
      triangles: viewport.totalTriangles,
      status: document.getElementById('doc-status')?.textContent ?? '',
    };
  });

  note(
    `reopened “${afterReload.name}”: ${afterReload.infos.length} ` +
      `${afterReload.infos.length === 1 ? 'body' : 'bodies'}, ` +
      `${afterReload.triangles} triangles re-tessellated, ` +
      `${afterReload.historyLength} history entries`,
  );

  if (afterReload.name !== beforeReload.summary.name) {
    throw new Error(
      `the reopened document is named "${afterReload.name}", not ` +
        `"${beforeReload.summary.name}"`,
    );
  }
  if (afterReload.infos.length !== beforeReload.infos.length) {
    throw new Error(
      `reopened ${afterReload.infos.length} bodies, saved ${beforeReload.infos.length}`,
    );
  }
  if (afterReload.historyLength !== beforeReload.historyLength) {
    throw new Error('the construction record did not survive the reload');
  }
  if (afterReload.triangles === 0) {
    throw new Error('the restored document rendered nothing');
  }

  for (const [index, after] of afterReload.infos.entries()) {
    const before = beforeReload.infos[index];
    // Identity is the point: a body must come back as the same body, not merely
    // as a body of the same size.
    if (after.ref !== before.ref) {
      throw new Error(
        `body ${index} came back as ${after.ref}, was ${before.ref} - ` +
          'document identity did not survive the restart',
      );
    }
    const error = Math.abs(after.volume - before.volume);
    if (error > 1e-6 || after.faceCount !== before.faceCount) {
      throw new Error(
        `${after.ref} changed across the restart: volume off by ${error.toExponential(1)}, ` +
          `${before.faceCount} faces -> ${after.faceCount}`,
      );
    }
  }
  note(
    `every body returned with its identity and exact geometry (${afterReload.infos
      .map((b) => b.ref)
      .join(', ')})`,
  );

  // Phased recovery.
  //
  // The phase names come from the application rather than being repeated here,
  // so a renamed phase breaks the import instead of silently reporting null.
  // Each phase is measured where it happens - from outside, reading, restoring,
  // and re-tessellating are one await.
  const recovery = await page.evaluate(async () => {
    const { RECOVERY_PHASES } = await import('/src/app/timing.ts');
    const durationOf = (name) => {
      const entries = performance.getEntriesByName(name);
      const last = entries[entries.length - 1];
      return last === undefined ? null : Number(last.duration.toFixed(3));
    };
    return Object.fromEntries(
      Object.entries(RECOVERY_PHASES).map(([phase, name]) => [phase, durationOf(name)]),
    );
  });

  // Frame cadence, so the first-frame phase can be read honestly: a headless
  // browser composites lazily, and a 200 ms "first frame" means the compositor
  // was idle, not that the upload was slow.
  const frameIntervalMs = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const stamps = [];
        const timer = setTimeout(() => {
          resolve(null);
        }, 5_000);
        const tick = (stamp) => {
          stamps.push(stamp);
          if (stamps.length < 20) {
            requestAnimationFrame(tick);
            return;
          }
          clearTimeout(timer);
          const gaps = stamps
            .slice(1)
            .map((value, i) => value - stamps[i])
            .sort((a, b) => a - b);
          resolve(Number(gaps[Math.floor(gaps.length / 2)].toFixed(3)));
        };
        requestAnimationFrame(tick);
      }),
  );

  const documentPhases = ['documentRead', 'geometryRestore', 'tessellate'];
  for (const phase of ['kernelReady', ...documentPhases]) {
    if (recovery[phase] === null) {
      throw new Error(
        `recovery phase "${phase}" was not measured, so the phase breakdown this ` +
          'stage exists to produce is incomplete',
      );
    }
  }

  const documentTotal = documentPhases.reduce(
    (sum, phase) => sum + recovery[phase],
    0,
  );
  note(
    `recovery phases: kernel ready ${recovery.kernelReady.toFixed(0)} ms, ` +
      `read ${recovery.documentRead.toFixed(1)} ms, ` +
      `restore ${recovery.geometryRestore.toFixed(1)} ms, ` +
      `tessellate ${recovery.tessellate.toFixed(1)} ms ` +
      `(document total ${documentTotal.toFixed(1)} ms)`,
  );

  if (recovery.firstFrame === null || recovery.total === null) {
    // Reported rather than treated as zero: an unmeasured phase must not read
    // as an instant one.
    note(
      'NOT MEASURED: no animation frame arrived within the timeout, so the ' +
        'first-frame phase and the load-to-visible total are absent',
    );
  } else {
    const unattributed =
      recovery.total - recovery.kernelReady - documentTotal - recovery.firstFrame;
    note(
      `recovery total ${recovery.total.toFixed(0)} ms to geometry on screen: ` +
        `first frame ${recovery.firstFrame.toFixed(1)} ms, ` +
        `${unattributed.toFixed(0)} ms unattributed (module load, viewport init)` +
        (frameIntervalMs === null
          ? ''
          : `; idle frame interval ${frameIntervalMs.toFixed(1)} ms`),
    );
    if (recovery.total < recovery.kernelReady) {
      throw new Error(
        'the recovery total is shorter than kernel startup, which means the ' +
          'phases are not measuring what they claim to',
      );
    }
  }

  // Opening while a session is live must replace it, not accumulate.
  //
  // Every other persistence check here starts from a fresh page, where there is
  // no outgoing session to release - so "reopening does not leak kernel memory"
  // was the one requirement in the change with no coverage anywhere. Reopening
  // the document that is already open is the cheapest way to ask it: the
  // outgoing bodies are real, live, and on screen.
  const replaced = await page.evaluate(async () => {
    const { session, kernel, viewport } = window.__webcad;
    const before = {
      live: (await kernel.refreshStats()).liveBodyCount,
      triangles: viewport.totalTriangles,
    };
    await session.open(session.document.documentId);
    return {
      before,
      live: (await kernel.refreshStats()).liveBodyCount,
      triangles: viewport.totalTriangles,
      documentBodies: session.document.bodies.length,
      refs: session.document.bodies.map((body) => body.ref),
    };
  });

  note(
    `reopening over a live session: ${replaced.before.live} live bodies before, ` +
      `${replaced.live} after, ${replaced.documentBodies} in the document ` +
      `(${replaced.refs.join(', ')}), ${replaced.triangles} triangles`,
  );
  if (replaced.live !== replaced.documentBodies) {
    throw new Error(
      `the kernel holds ${replaced.live} bodies but the reopened document has ` +
        `${replaced.documentBodies} - the outgoing session was not released`,
    );
  }
  if (replaced.triangles !== replaced.before.triangles) {
    throw new Error(
      `the viewport holds ${replaced.triangles} triangles after reopening, was ` +
        `${replaced.before.triangles} - the outgoing bodies were left on screen`,
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

  // The STEP round trip in its own file, for the same reason the Worker numbers
  // are: it answers a different question, and the censuses are too bulky to read
  // next to the storage comparison. It carries the fixture sizes and the deltas
  // so a findings document can quote them without re-running the browser.
  const stepPath = forceWebgl
    ? 'measurements/step-webgl2.json'
    : 'measurements/step.json';
  writeFileSync(
    stepPath,
    `${JSON.stringify(
      { backend: initial['Backend'], occtVersion: initial['OCCT'], ...step },
      null,
      2,
    )}
`,
  );

  // One artifact for everything about the document layer, so IndexedDB and OPFS
  // can be compared without joining two files, and so the recovery phases sit
  // next to the payload sizes that produced them.
  const documentPath = forceWebgl
    ? 'measurements/document-webgl2.json'
    : 'measurements/document.json';
  writeFileSync(
    documentPath,
    `${JSON.stringify(
      {
        backend: initial['Backend'],
        occtVersion: initial['OCCT'],
        ...documents,
        recovery: {
          ...recovery,
          documentPhasesMs: Number(documentTotal.toFixed(3)),
          idleFrameIntervalMs: frameIntervalMs,
          savedBytes: beforeReload.summary.byteLength,
          bodies: afterReload.infos.length,
          triangles: afterReload.triangles,
        },
        checkpointRoundTrip: {
          bytes: roundTrip.size,
          format: roundTrip.format,
          volumeError: roundTrip.volumeError,
        },
      },
      null,
      2,
    )}\n`,
  );

  console.log('\nBrowser verification PASSED');
  console.log('  screenshots: measurements/viewport-*.png');
  console.log(
    `  measurements: measurements/${forceWebgl ? 'browser-webgl2' : 'browser'}.json, ` +
      `${boundaryPath}, ${documentPath}`,
  );
} catch (error) {
  exitCode = 1;
  console.error(`\nBrowser verification FAILED\n  ${error.message}`);
} finally {
  await browser?.close();
  killTree(server);
}

process.exit(exitCode);
