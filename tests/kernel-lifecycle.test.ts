import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel } from '../src/kernel/kernel.ts';
import {
  InvalidHandleError,
  KernelNotReadyError,
  WebAssemblyUnsupportedError,
} from '../src/kernel/errors.ts';
import { asBodyId } from '../src/kernel/types.ts';
import { KERNEL_ARTIFACT, disposeKernels, kernelSkip, makeKernel } from './helpers/kernel.ts';
import { loadEmscriptenModule } from './helpers/load-wasm.ts';

const skip = kernelSkip;

// A kernel holds a WASM module, and nothing collects it while the module object
// is reachable. Released between tests rather than at exit: accumulating them
// is how a file stops working, silently, once it crosses the line.
afterEach(disposeKernels);

test('initialization reports the OCCT version', { skip }, async () => {
  const kernel = await makeKernel();
  assert.ok(kernel.isReady);
  assert.match(kernel.occtVersion, /^\d+\.\d+/);
});

test('operations before initialization fail with KernelNotReady', { skip }, async () => {
  const kernel = new Kernel({
    loadModule: () => loadEmscriptenModule(KERNEL_ARTIFACT),
  });

  assert.equal(kernel.isReady, false);
  await assert.rejects(
    () => kernel.createBox({ width: 1, depth: 1, height: 1 }),
    KernelNotReadyError,
  );

  // Still usable once initialized: the failed call created no state.
  await kernel.initialize();
  const body = await kernel.createBox({ width: 1, depth: 1, height: 1 });
  assert.equal(kernel.stats().liveBodyCount, 1);
  await kernel.release(body);
});

test('repeated and concurrent initialization instantiates once', { skip }, async () => {
  const kernel = new Kernel({
    loadModule: () => loadEmscriptenModule(KERNEL_ARTIFACT),
  });

  await Promise.all([
    kernel.initialize(),
    kernel.initialize(),
    kernel.initialize(),
  ]);
  await kernel.initialize();

  assert.ok(kernel.isReady);
  // A second instantiation would reset the counter, so a fresh module here
  // proves only one was created.
  const a = await kernel.createBox({ width: 1, depth: 1, height: 1 });
  const b = await kernel.createBox({ width: 1, depth: 1, height: 1 });
  assert.equal(b - a, 1);
});

test('a module that fails to load leaves no partial kernel', { skip }, async () => {
  const kernel = new Kernel({
    loadModule: () => Promise.reject(new Error('simulated instantiation failure')),
  });

  await assert.rejects(() => kernel.initialize(), WebAssemblyUnsupportedError);
  assert.equal(kernel.isReady, false);
  await assert.rejects(
    () => kernel.createBox({ width: 1, depth: 1, height: 1 }),
    KernelNotReadyError,
  );
});

test('handles are unique and never reissued after release', { skip }, async () => {
  const kernel = await makeKernel();
  const seen = new Set<number>();

  for (let i = 0; i < 8; i++) {
    const body = await kernel.createBox({ width: 5, depth: 5, height: 5 });
    assert.equal(seen.has(body), false, 'handle was reissued');
    seen.add(body);
    // Released immediately, so a naive allocator would be free to hand the same
    // identifier to the next body.
    await kernel.release(body);
  }

  assert.equal(seen.size, 8);
  assert.equal(kernel.stats().liveBodyCount, 0);
});

test('use after release fails with InvalidHandle', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  await kernel.release(body);

  await assert.rejects(() => kernel.bodyInfo(body), InvalidHandleError);
  await assert.rejects(
    () => kernel.tessellate(body),
    InvalidHandleError,
  );
});

test('double release fails without corrupting state', { skip }, async () => {
  const kernel = await makeKernel();
  const keep = await kernel.createBox({ width: 4, depth: 4, height: 4 });
  const doomed = await kernel.createBox({ width: 6, depth: 6, height: 6 });

  await kernel.release(doomed);
  await assert.rejects(() => kernel.release(doomed), InvalidHandleError);

  // The unrelated body must be untouched by the failed release.
  const info = await kernel.bodyInfo(keep);
  assert.ok(Math.abs(info.volume - 64) < 1e-6);
  assert.equal(kernel.stats().liveBodyCount, 1);
});

test('an unknown handle is rejected', { skip }, async () => {
  const kernel = await makeKernel();
  await assert.rejects(
    () => kernel.bodyInfo(asBodyId(99_999)),
    InvalidHandleError,
  );
});

test('a completed workflow leaves no live handles', { skip }, async () => {
  const kernel = await makeKernel();
  assert.equal(kernel.stats().liveBodyCount, 0);

  const box = await kernel.createBox({
    width: 40,
    depth: 30,
    height: 20,
    origin: [-20, -15, 0],
  });
  const drill = await kernel.createCylinder({
    radius: 6,
    height: 40,
    origin: [0, 0, -10],
  });

  const outcome = await kernel.subtract(box, drill);
  assert.equal(outcome.kind, 'body');
  assert.equal(kernel.stats().liveBodyCount, 3);

  await kernel.release(box);
  await kernel.release(drill);
  if (outcome.kind === 'body') await kernel.release(outcome.bodyId);

  // The leak assertion the specs ask for: nothing is reclaimed implicitly,
  // because the JS garbage collector cannot see WASM linear memory.
  assert.equal(kernel.stats().liveBodyCount, 0);
});

test('the operation log records successes and failures', { skip }, async () => {
  const kernel = await makeKernel();
  kernel.clearOperationLog();

  await kernel.createBox({ width: 10, depth: 10, height: 10 });
  await assert.rejects(() => kernel.createBox({ width: -1, depth: 1, height: 1 }));

  const log = kernel.operationLog;
  assert.equal(log.length, 2);
  assert.equal(log[0]?.status, 0);
  assert.notEqual(log[1]?.status, 0, 'the failed operation must be logged too');
  for (const entry of log) {
    assert.equal(entry.operation, 'createBox');
    assert.ok(entry.durationMs >= 0);
    assert.ok(entry.wasmMemoryBytes > 0);
  }
});

test('memory statistics are reported and the peak never shrinks', { skip }, async () => {
  const kernel = await makeKernel();
  const before = kernel.stats();
  assert.ok(before.wasmMemoryBytes > 0);
  assert.ok(before.wasmPeakMemoryBytes >= before.wasmMemoryBytes);

  const bodies = [];
  for (let i = 0; i < 5; i++) {
    bodies.push(await kernel.createCylinder({ radius: 10, height: 20 }));
  }
  for (const body of bodies) await kernel.release(body);

  const after = kernel.stats();
  assert.ok(after.wasmPeakMemoryBytes >= before.wasmPeakMemoryBytes);
  assert.equal(after.totalBodiesCreated, 5);
});
