import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FRAME_BUDGET_MS } from '../src/ui/measurements.ts';
import { closeTo, kernelSkip, makeKernel } from './helpers/kernel.ts';

const skip = kernelSkip;

/**
 * The MVP-0 loop, end to end: create, operate, tessellate, and hand mesh data to
 * a renderer.
 *
 * The GPU upload itself needs a browser, so this test drives everything up to
 * and including the buffers a renderer consumes, and asserts they are complete
 * and well-formed. Browser-side rendering is verified separately.
 */
test('create, subtract, tessellate, and hand off render buffers', { skip }, async () => {
  const kernel = await makeKernel();
  kernel.clearOperationLog();

  const box = await kernel.createBox({
    width: 60,
    depth: 40,
    height: 25,
    origin: [-30, -20, 0],
  });
  const drill = await kernel.createCylinder({
    radius: 10,
    height: 60,
    origin: [0, 0, -15],
  });

  const outcome = await kernel.subtract(box, drill);
  assert.equal(outcome.kind, 'body');
  if (outcome.kind !== 'body') return;

  // Stands in for the viewport: consumes the views inside the synchronous
  // window, exactly as the GPU upload path does.
  const uploaded = await kernel.withTessellation(
    outcome.bodyId,
    { linearDeflection: 0.1 },
    (views, meta) => ({
      positions: views.positions.length,
      normals: views.normals.length,
      indices: views.indices.length,
      maxIndex: views.indices.reduce((max, i) => (i > max ? i : max), 0),
      triangleCount: meta.triangleCount,
      vertexCount: meta.vertexCount,
    }),
  );

  assert.ok(uploaded.triangleCount > 0, 'the result must be renderable');
  assert.equal(uploaded.positions, uploaded.vertexCount * 3);
  assert.equal(uploaded.normals, uploaded.vertexCount * 3);
  assert.equal(uploaded.indices, uploaded.triangleCount * 3);
  assert.ok(uploaded.maxIndex < uploaded.vertexCount);

  // The drilled hole is present in exact geometry, not just in the mesh.
  const faces = await kernel.faceTypeSummary(outcome.bodyId);
  assert.equal(faces.cylinder, 1);

  const info = await kernel.bodyInfo(outcome.bodyId);
  assert.ok(closeTo(info.volume, 60 * 40 * 25 - Math.PI * 100 * 25, 1e-6));

  // Both operands are still valid after the whole pipeline.
  assert.ok((await kernel.bodyInfo(box)).volume > 0);
  assert.ok((await kernel.bodyInfo(drill)).volume > 0);

  // The pipeline is fully represented in the measurement log.
  const operations = kernel.operationLog.map((entry) => entry.operation);
  for (const expected of ['createBox', 'createCylinder', 'subtract', 'tessellate']) {
    assert.ok(operations.includes(expected), `missing ${expected} in the log`);
  }
  const tessellation = kernel.operationLog.find((e) => e.operation === 'tessellate');
  assert.equal(tessellation?.triangleCount, uploaded.triangleCount);

  await kernel.release(box);
  await kernel.release(drill);
  await kernel.release(outcome.bodyId);
  assert.equal(kernel.stats().liveBodyCount, 0);
});

/**
 * Task 8.4: main-thread blocking must be observable rather than assumed absent.
 *
 * Rather than asserting a specific duration, this confirms the mechanism works -
 * every operation carries a duration comparable against the frame budget, so an
 * operation that blocks is visible in the readout instead of invisible.
 */
test('operation durations are measured against the frame budget', { skip }, async () => {
  const kernel = await makeKernel();
  kernel.clearOperationLog();

  // Fine tessellation of a large curved body: the most expensive thing MVP-0
  // can ask for, and the likeliest place to exceed a frame.
  const cylinder = await kernel.createCylinder({ radius: 80, height: 160 });
  await kernel.tessellateToCopy(cylinder, {
    linearDeflection: 0.002,
    angularDeflection: 0.01,
  });

  const log = kernel.operationLog;
  assert.ok(log.length >= 2);
  for (const entry of log) {
    assert.equal(typeof entry.durationMs, 'number');
    assert.ok(Number.isFinite(entry.durationMs));
  }

  const slowest = log.reduce((a, b) => (a.durationMs > b.durationMs ? a : b));
  const overBudget = log.filter((e) => e.durationMs > FRAME_BUDGET_MS);
  console.log(
    `  [finding] slowest MVP-0 operation: ${slowest.operation} ` +
      `${slowest.durationMs.toFixed(1)}ms (frame budget ${FRAME_BUDGET_MS.toFixed(1)}ms); ` +
      `${overBudget.length}/${log.length} operations over budget`,
  );

  await kernel.release(cylinder);
});
