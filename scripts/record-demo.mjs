// Records a demo video of the real app.
//
// Drives the same build a user would run - no mockups, no sped-up fakery. The
// pauses are deliberate: an operation that blocks the main thread should look
// like it blocks, because that is MVP-0's most consequential finding.
//
// Playwright writes WebM. ffmpeg, if present, also produces an MP4 that plays
// in more places.
//
// Usage: node scripts/record-demo.mjs [--port 5200] [--webgl] [--keep-webm]

import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  devOrigin,
  killTree,
  shiftClick,
  startDevServer,
} from './_browser.mjs';

const args = process.argv.slice(2);
const forceWebgl = args.includes('--webgl');
const keepWebm = args.includes('--keep-webm');
const portIndex = args.indexOf('--port');
// A different default port from verify-browser.mjs so a recording and a
// verification run do not collide over --strictPort.
const port = portIndex === -1 ? 5200 : Number(args[portIndex + 1]);
const origin = devOrigin(port);

// The demo is a published asset rather than a per-run measurement, so it lives
// in docs/ and is committed. Re-running this updates it in place, which is what
// keeps it from drifting away from what the app actually does.
const OUT_DIR = 'docs';
const RAW_DIR = join('measurements', '.demo-raw');
const WIDTH = 1280;
const HEIGHT = 800;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drags across the canvas in small steps.
 *
 * OrbitControls reads pointer deltas, so a single jump from A to B rotates in
 * one frame and looks like a cut. Stepping it produces motion the damping can
 * smooth. Anything past a 4px total delta is treated as a drag rather than a
 * click, so this never disturbs the selection.
 */
async function orbit(page, box, { dx, dy, steps = 60, holdMs = 8 }) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    // Ease in and out so the motion starts and stops gently.
    const t = i / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    await page.mouse.move(cx + dx * eased, cy + dy * eased);
    await wait(holdMs);
  }
  await page.mouse.up();
  await wait(300);
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
let context;
let exitCode = 0;

try {
  rmSync(RAW_DIR, { recursive: true, force: true });
  mkdirSync(RAW_DIR, { recursive: true });

  console.log('Starting dev server...');
  server = await startDevServer(port);

  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    // SwiftShader keeps WebGL working on headless machines without a real GPU.
    args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'],
  });

  // Load the app once in a throwaway context first.
  //
  // Recording starts when the context is created, so a cold dev server spends
  // the opening seconds of the video showing a blank page while vite transforms
  // every module for the first time. Warming that up front costs nothing and
  // keeps the recorded lead-in short.
  console.log('Warming the dev server...');
  const warmup = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const warmPage = await warmup.newPage();
  await warmPage.goto(origin, { waitUntil: 'load', timeout: 120_000 });
  await warmPage
    .waitForFunction(
      () => {
        const list = document.getElementById('measurements');
        return (list?.textContent ?? '').match(/\d+\.\d+\.\d+/) !== null;
      },
      { timeout: 120_000 },
    )
    .catch(() => {});
  await warmup.close();

  context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: RAW_DIR, size: { width: WIDTH, height: HEIGHT } },
  });

  // Recording is already running, so this is the zero point the trim is
  // measured against.
  const recordingStartedAt = Date.now();
  const page = await context.newPage();

  if (forceWebgl) {
    await page.addInitScript(() => {
      delete Object.getPrototypeOf(navigator).gpu;
    });
  }

  console.log(`Opening ${origin} ...`);
  await page.goto(origin, { waitUntil: 'load' });

  const fatal = page.locator('#fatal:not([hidden])');
  if ((await fatal.count()) > 0) {
    throw new Error(`app reported a fatal error: ${await fatal.innerText()}`);
  }

  await page.waitForFunction(
    () => {
      const list = document.getElementById('measurements');
      return (list?.textContent ?? '').match(/\d+\.\d+\.\d+/) !== null;
    },
    { timeout: 60_000 },
  );

  const initial = await readReadout(page);
  console.log(`  backend ${initial['Backend']}, OCCT ${initial['OCCT']}`);

  // Everything before this is page load, not demo. Keep a moment of the ready
  // app so the video does not open mid-action.
  const leadInSeconds = Math.max(0, (Date.now() - recordingStartedAt) / 1000 - 1.2);

  // Let the empty scene and the panel register before anything happens.
  await wait(1800);

  const canvas = page.locator('#viewport');
  const box = await canvas.boundingBox();

  console.log('Building the demo scene...');
  await page.click('#btn-demo');
  await page.waitForFunction(
    () => {
      const text = document.getElementById('measurements')?.textContent ?? '';
      const match = text.match(/Live bodies(\d+)/);
      return match !== null && Number(match[1]) >= 2;
    },
    { timeout: 60_000 },
  );
  await wait(1200);

  // Show that the drill really passes through the block, rather than asking the
  // viewer to take the later hole on faith.
  await orbit(page, box, { dx: 260, dy: -90 });
  await wait(600);

  console.log('Selecting the block, then the drill...');
  // Find two pixels that hit different bodies using the same raycast the click
  // handler uses, instead of hoping guessed coordinates land well.
  const hits = await page.evaluate(
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
    { rect: box },
  );

  if (hits === null) {
    throw new Error('the dev verification handle (window.__webcad) is missing');
  }

  const distinct = [...new Set(hits.map((h) => h.bodyId))];
  if (distinct.length < 2) {
    throw new Error(`only ${distinct.length} body/bodies pickable; expected 2`);
  }

  // Operand order decides what subtract means, so identify the bodies by face
  // count rather than trusting scan order: the block has 6 faces, the drill 3.
  const identified = await page.evaluate(async (ids) => {
    const { kernel } = window.__webcad;
    const out = [];
    for (const id of ids) {
      const info = await kernel.bodyInfo(id);
      out.push({ bodyId: id, faceCount: info.faceCount });
    }
    return out;
  }, distinct);

  const block = identified.find((b) => b.faceCount === 6);
  const drill = identified.find((b) => b.faceCount === 3);
  if (block === undefined || drill === undefined) {
    throw new Error(`expected a 6-face block and a 3-face drill, got ${JSON.stringify(identified)}`);
  }

  const blockAt = hits.find((h) => h.bodyId === block.bodyId);
  const drillAt = hits.find((h) => h.bodyId === drill.bodyId);

  await page.mouse.click(blockAt.x, blockAt.y);
  await wait(1100);
  await shiftClick(page, drillAt.x, drillAt.y);
  // Hold on the target/tool hint - the one piece of UI that says which body is
  // which, and the thing MVP-0 found was undiscoverable without it.
  await wait(1800);

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
  await wait(1400);

  await page.click('#btn-fit');
  await wait(900);

  // Orbit around the result so the through-hole is unmistakable, then tilt down
  // into it. The hole wall is an exact cylinder, not a faceted approximation -
  // which is the whole point and only visible from a couple of angles.
  await orbit(page, box, { dx: -420, dy: 0, steps: 90 });
  await wait(500);
  await orbit(page, box, { dx: 0, dy: 190, steps: 45 });
  await wait(2200);

  const final = await readReadout(page);
  console.log(
    `  result: ${final['Live bodies']} body, ${final['Triangles']} triangles, ` +
      `slowest ${final['Slowest op']}`,
  );

  // Video is only flushed on context close, before the browser goes away.
  await context.close();
  context = undefined;
  await browser.close();
  browser = undefined;

  const recorded = readdirSync(RAW_DIR).filter((f) => f.endsWith('.webm'));
  if (recorded.length === 0) throw new Error('playwright wrote no video file');

  const webm = join(OUT_DIR, forceWebgl ? 'demo-webgl2.webm' : 'demo.webm');
  rmSync(webm, { force: true });
  renameSync(join(RAW_DIR, recorded[0]), webm);
  rmSync(RAW_DIR, { recursive: true, force: true });
  console.log(`\nWrote ${webm}`);

  // MP4 is not strictly better, but it embeds and previews in more places than
  // WebM does. Optional: a missing ffmpeg is not a failure.
  const mp4 = webm.replace(/\.webm$/, '.mp4');
  console.log(`  trimming ${leadInSeconds.toFixed(1)}s of page load from the front`);
  const ffmpeg = spawnSync(
    'ffmpeg',
    [
      // Input seeking, so the load-time lead-in is skipped rather than encoded.
      '-y', '-ss', leadInSeconds.toFixed(2), '-i', webm,
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '26',
      // Even dimensions and yuv420p are what makes h264 play everywhere.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      mp4,
    ],
    { stdio: 'ignore' },
  );

  if (ffmpeg.error !== undefined || ffmpeg.status !== 0) {
    console.log('  (ffmpeg unavailable or failed; keeping WebM only)');
  } else {
    console.log(`Wrote ${mp4}`);
    if (!keepWebm) {
      rmSync(webm, { force: true });
      console.log(`  removed ${webm} (pass --keep-webm to keep it)`);
    }
  }
} catch (error) {
  exitCode = 1;
  console.error(`\nDemo recording FAILED\n  ${error.message}`);
} finally {
  await context?.close();
  await browser?.close();
  killTree(server);
  if (existsSync(RAW_DIR)) rmSync(RAW_DIR, { recursive: true, force: true });
}

process.exit(exitCode);
