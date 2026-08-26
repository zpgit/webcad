// Serializing exact B-Rep and getting it back.
//
// The checkpoint is the only path back to a user's geometry, so these assert
// exactness rather than that bytes were produced: a round trip that quietly
// turned an analytic cylinder into a spline would still write a file, still
// restore something shaped roughly right, and still be data loss.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidHandleError,
  InvalidParameterError,
  KernelError,
} from '../src/kernel/errors.ts';
import type { Kernel } from '../src/kernel/kernel.ts';
import type { BodyId } from '../src/kernel/types.ts';
import { boxAndDrill, closeTo, kernelSkip, makeKernel } from './helpers/kernel.ts';

const skip = kernelSkip;

/** Everything a round trip must preserve, gathered in one call. */
async function snapshot(kernel: Kernel, bodyId: BodyId): Promise<unknown> {
  const [info, faces] = await Promise.all([
    kernel.bodyInfo(bodyId),
    kernel.faceTypeSummary(bodyId),
  ]);
  return { info, faces };
}

async function drilledBlock(kernel: Kernel): Promise<BodyId> {
  const { box, drill } = await boxAndDrill(kernel);
  const outcome = await kernel.subtract(box, drill);
  assert.equal(outcome.kind, 'body');
  if (outcome.kind !== 'body') throw new Error('unreachable');
  await kernel.release(box);
  await kernel.release(drill);
  return outcome.bodyId;
}

// --- Round-trip exactness ----------------------------------------------------

test('a drilled block survives a round trip exactly', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await drilledBlock(kernel);
  const before = await snapshot(kernel, body);
  const beforeInfo = await kernel.bodyInfo(body);

  const payload = await kernel.serialize([body]);
  const [restored] = await kernel.restore(payload.bytes);
  assert.ok(restored !== undefined);

  assert.deepEqual(await snapshot(kernel, restored), before);

  // Spelled out as well as deep-equalled, so a failure names what drifted.
  const after = await kernel.bodyInfo(restored);
  assert.ok(closeTo(after.volume, beforeInfo.volume), 'volume must be exact');
  assert.ok(closeTo(after.area, beforeInfo.area), 'area must be exact');
  assert.equal(after.faceCount, beforeInfo.faceCount);
  assert.equal(after.edgeCount, beforeInfo.edgeCount);
  assert.equal(after.vertexCount, beforeInfo.vertexCount);
  assert.equal(after.solidCount, beforeInfo.solidCount);
  assert.equal(after.isValid, beforeInfo.isValid);
  assert.equal(after.isClosed, beforeInfo.isClosed);
});

/**
 * The claim MVP-0 rested on, carried through persistence.
 *
 * A hole wall that came back as a B-spline would still measure the right
 * volume; only the surface type reveals that the geometry stopped being exact.
 */
test('analytic surfaces survive a round trip', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await drilledBlock(kernel);
  const before = await kernel.faceTypeSummary(body);
  assert.equal(before.cylinder, 1, 'the hole wall starts as an exact cylinder');

  const payload = await kernel.serialize([body]);
  const [restored] = await kernel.restore(payload.bytes);
  assert.ok(restored !== undefined);

  const after = await kernel.faceTypeSummary(restored);
  assert.equal(after.cylinder, 1, 'and must still be one');
  assert.equal(after.bspline, 0, 'not approximated into a spline');
  assert.equal(after.other, 0);
  assert.deepEqual(after, before);
});

test('a cylinder survives a round trip exactly', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createCylinder({ radius: 12, height: 30 });
  const before = await snapshot(kernel, body);

  const payload = await kernel.serialize([body]);
  const [restored] = await kernel.restore(payload.bytes);
  assert.ok(restored !== undefined);

  assert.deepEqual(await snapshot(kernel, restored), before);
  const info = await kernel.bodyInfo(restored);
  assert.ok(
    closeTo(info.volume, Math.PI * 12 * 12 * 30),
    'still the exact volume of a cylinder, not of a prism through its vertices',
  );
});

// --- Order and identity ------------------------------------------------------

test('bodies come back in the order they were written', { skip }, async () => {
  const kernel = await makeKernel();
  const bodies = [
    await kernel.createBox({ width: 10, depth: 10, height: 10 }),
    await kernel.createCylinder({ radius: 7, height: 20 }),
    await kernel.createBox({ width: 30, depth: 30, height: 30 }),
  ];
  const before = await Promise.all(bodies.map((b) => kernel.bodyInfo(b)));

  const payload = await kernel.serialize(bodies);
  assert.equal(payload.bodyCount, 3);

  const restored = await kernel.restore(payload.bytes);
  assert.equal(restored.length, 3);

  // Volumes are 1000, ~3078, 27000: distinct enough that a shuffle cannot pass.
  const after = await Promise.all(restored.map((b) => kernel.bodyInfo(b)));
  for (let i = 0; i < 3; i++) {
    assert.ok(
      closeTo(after[i]?.volume ?? 0, before[i]?.volume ?? -1),
      `body ${i} came back out of order`,
    );
  }
});

test('restored handles are new, and the originals are untouched', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createBox({ width: 10, depth: 10, height: 10 });

  const payload = await kernel.serialize([body]);
  const [restored] = await kernel.restore(payload.bytes);

  assert.ok(restored !== undefined);
  assert.notEqual(restored, body, 'a fresh handle, not a revived identifier');
  // Serializing did not consume the original.
  const original = await kernel.bodyInfo(body);
  assert.ok(closeTo(original.volume, 1000));
});

test('a restored body is an ordinary body', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 40, depth: 40, height: 40 });
  const cylinder = await kernel.createCylinder({
    radius: 10,
    height: 60,
    origin: [20, 20, -10],
  });

  const payload = await kernel.serialize([box, cylinder]);
  await kernel.release(box);
  await kernel.release(cylinder);

  const [rBox, rCylinder] = await kernel.restore(payload.bytes);
  assert.ok(rBox !== undefined && rCylinder !== undefined);

  // Editable, not merely viewable: the point of restoring exact geometry.
  const outcome = await kernel.subtract(rBox, rCylinder);
  assert.equal(outcome.kind, 'body');
  if (outcome.kind !== 'body') return;

  const cut = await kernel.bodyInfo(outcome.bodyId);
  assert.ok(closeTo(cut.volume, 40 * 40 * 40 - Math.PI * 100 * 40, 1e-3));
  const faces = await kernel.faceTypeSummary(outcome.bodyId);
  assert.equal(faces.cylinder, 1, 'the Boolean on restored geometry stayed exact');

  const { meta } = await kernel.tessellate(outcome.bodyId);
  assert.ok(meta.triangleCount > 0, 'and it renders');
});

// --- Payload metadata --------------------------------------------------------

test('the payload reports what wrote it', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const payload = await kernel.serialize([body]);

  assert.match(payload.format, /^occt-bin-brep-v\d+$/);
  assert.equal(payload.occtVersion, kernel.occtVersion);
  assert.equal(payload.bodyCount, 1);
  assert.ok(payload.bytes.byteLength > 0);
});

/**
 * A checkpoint stores exact geometry, never triangulation.
 *
 * Otherwise a document's size would depend on whether its bodies had happened
 * to be displayed, and at what tolerance.
 */
test('displaying a body does not change what it serializes to', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createCylinder({ radius: 20, height: 40 });

  const before = await kernel.serialize([body]);
  await kernel.tessellate(body, { linearDeflection: 0.005 });
  const after = await kernel.serialize([body]);

  assert.equal(after.bytes.byteLength, before.bytes.byteLength);
});

// --- Empty ------------------------------------------------------------------

test('serializing nothing produces a payload that restores to nothing', { skip }, async () => {
  const kernel = await makeKernel();

  const payload = await kernel.serialize([]);
  assert.equal(payload.bodyCount, 0);
  assert.ok(payload.bytes.byteLength > 0, 'an empty document is still a document');

  const restored = await kernel.restore(payload.bytes);
  assert.deepEqual(restored, []);
});

// --- Ownership ---------------------------------------------------------------

/**
 * Restoring transfers the payload rather than copying it.
 *
 * Worth asserting rather than documenting: a caller that saves and restores the
 * same bytes would otherwise find its second use silently operating on a
 * detached array, and the failure would surface far from here.
 */
test('restoring detaches the caller\'s buffer', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const payload = await kernel.serialize([body]);

  const bytes = payload.bytes;
  assert.ok(bytes.byteLength > 0);

  await kernel.restore(bytes);
  assert.equal(bytes.byteLength, 0, 'the buffer moved into the kernel');
});

test('a copy taken beforehand can be restored twice', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const payload = await kernel.serialize([body]);

  const keep = payload.bytes.slice();
  const first = await kernel.restore(payload.bytes);
  const second = await kernel.restore(keep);

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0], second[0], 'two restorations, two distinct bodies');
});

// --- Failure paths -----------------------------------------------------------

test('serializing an unknown handle fails and writes nothing', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const released = await kernel.createBox({ width: 5, depth: 5, height: 5 });
  await kernel.release(released);

  await assert.rejects(() => kernel.serialize([body, released]), InvalidHandleError);
  // The surviving body is unaffected by the attempt.
  assert.ok(closeTo((await kernel.bodyInfo(body)).volume, 1000));
});

test('a truncated payload fails without issuing handles', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const payload = await kernel.serialize([body]);
  const live = (await kernel.refreshStats()).liveBodyCount;

  const half = payload.bytes.slice(0, Math.floor(payload.bytes.byteLength / 2));
  await assert.rejects(() => kernel.restore(half), KernelError);

  assert.equal(
    (await kernel.refreshStats()).liveBodyCount,
    live,
    'a failed restoration is all-or-nothing',
  );
});

test('bytes that were never a checkpoint fail cleanly', { skip }, async () => {
  const kernel = await makeKernel();
  const live = (await kernel.refreshStats()).liveBodyCount;

  await assert.rejects(
    () => kernel.restore(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    KernelError,
  );
  assert.equal((await kernel.refreshStats()).liveBodyCount, live);
});

test('an empty payload is rejected before it reaches the kernel', { skip }, async () => {
  const kernel = await makeKernel();
  await assert.rejects(() => kernel.restore(new Uint8Array(0)), InvalidParameterError);
});

test('the kernel stays usable after a failed restoration', { skip }, async () => {
  const kernel = await makeKernel();
  await assert.rejects(() => kernel.restore(new Uint8Array([9, 9, 9, 9])), KernelError);

  const body = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  assert.ok(closeTo((await kernel.bodyInfo(body)).volume, 1000));
});

// --- Handle lifetime ---------------------------------------------------------

test('a serialize-restore-release cycle leaves no handles behind', { skip }, async () => {
  const kernel = await makeKernel();
  const before = (await kernel.refreshStats()).liveBodyCount;

  const bodies = [
    await kernel.createBox({ width: 10, depth: 10, height: 10 }),
    await kernel.createCylinder({ radius: 5, height: 10 }),
  ];
  const payload = await kernel.serialize(bodies);
  for (const body of bodies) await kernel.release(body);

  const restored = await kernel.restore(payload.bytes);
  assert.equal(restored.length, 2);
  for (const body of restored) await kernel.release(body);

  assert.equal((await kernel.refreshStats()).liveBodyCount, before);
});

// --- Instrumentation ---------------------------------------------------------

test('both directions record the bytes they moved', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createBox({ width: 10, depth: 10, height: 10 });

  kernel.clearOperationLog();
  const payload = await kernel.serialize([body]);
  const size = payload.bytes.byteLength;
  const [wrote] = kernel.operationLog;

  assert.ok(wrote !== undefined);
  assert.equal(wrote.operation, 'serialize');
  assert.equal(wrote.transferBytes, size);
  assert.ok(wrote.copyMs !== undefined, 'the copy out of WASM memory is timed');
  assert.ok(wrote.roundTripMs !== undefined);

  kernel.clearOperationLog();
  await kernel.restore(payload.bytes);
  const [read] = kernel.operationLog;

  assert.ok(read !== undefined);
  assert.equal(read.operation, 'restore');
  assert.equal(read.transferBytes, size, 'the inbound direction is measured too');
  assert.ok(read.copyMs !== undefined, 'the copy into WASM memory is timed');
});

test('a failed serialization is logged like any other operation', { skip }, async () => {
  const kernel = await makeKernel();
  kernel.clearOperationLog();

  await assert.rejects(() => kernel.serialize([9999 as BodyId]), InvalidHandleError);

  const [entry] = kernel.operationLog;
  assert.ok(entry !== undefined);
  assert.equal(entry.operation, 'serialize');
  assert.notEqual(entry.status, 0, 'failures are recorded, not silently dropped');
});
