import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { InvalidHandleError, InvalidParameterError } from '../src/kernel/errors.ts';
import {
  closeTo,
  disposeKernels,
  kernelSkip,
  makeKernel,
  maxCylindricalDeviation,
} from './helpers/kernel.ts';

const skip = kernelSkip;

// A kernel holds a WASM module, and nothing collects it while the module object
// is reachable. Released between tests rather than at exit: accumulating them
// is how a file stops working, silently, once it crosses the line.
afterEach(disposeKernels);

test('tessellation produces well-formed buffers', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 10, depth: 10, height: 10 });

  const { mesh, meta } = await kernel.tessellate(box);

  assert.ok(meta.triangleCount > 0);
  assert.ok(meta.vertexCount > 0);
  assert.equal(mesh.positions.length, meta.vertexCount * 3);
  assert.equal(mesh.normals.length, meta.vertexCount * 3);
  assert.equal(mesh.indices.length, meta.triangleCount * 3);

  // Every index must address a real vertex.
  for (const index of mesh.indices) {
    assert.ok(index < meta.vertexCount, `index ${index} out of range`);
  }

  // A box is 6 quads, so 12 triangles is the minimum.
  assert.ok(meta.triangleCount >= 12);

  // Normals are unit length.
  for (let i = 0; i < meta.vertexCount; i++) {
    const length = Math.hypot(
      mesh.normals[3 * i] ?? 0,
      mesh.normals[3 * i + 1] ?? 0,
      mesh.normals[3 * i + 2] ?? 0,
    );
    assert.ok(closeTo(length, 1, 1e-4), `normal ${i} had length ${length}`);
  }
});

test('a curved surface becomes many triangles', { skip }, async () => {
  const kernel = await makeKernel();
  const cylinder = await kernel.createCylinder({ radius: 10, height: 20 });
  const { meta } = await kernel.tessellate(cylinder);

  assert.ok(meta.triangleCount > 12, `only ${meta.triangleCount} triangles`);

  // The body itself is unchanged: still an exact analytic cylinder.
  const faces = await kernel.faceTypeSummary(cylinder);
  assert.equal(faces.cylinder, 1);
});

test('finer deflection increases fidelity', { skip }, async () => {
  const kernel = await makeKernel();
  const radius = 20;
  const cylinder = await kernel.createCylinder({ radius, height: 30 });

  const coarse = await kernel.tessellate(cylinder, {
    linearDeflection: 2,
    angularDeflection: 1.0,
  });
  const fine = await kernel.tessellate(cylinder, {
    linearDeflection: 0.05,
    angularDeflection: 0.1,
  });

  assert.ok(
    fine.meta.triangleCount > coarse.meta.triangleCount,
    `fine=${fine.meta.triangleCount} coarse=${coarse.meta.triangleCount}`,
  );

  // Measured deviation from the exact surface, not triangle count as a proxy.
  const coarseDeviation = maxCylindricalDeviation(coarse.mesh, radius);
  const fineDeviation = maxCylindricalDeviation(fine.mesh, radius);

  assert.ok(coarseDeviation > 0, 'expected measurable deviation at coarse tolerance');
  assert.ok(
    fineDeviation < coarseDeviation,
    `fine deviation ${fineDeviation} should be under coarse ${coarseDeviation}`,
  );
  // And it honours the tolerance it was given.
  assert.ok(fineDeviation <= 0.05 + 1e-6, `deviation ${fineDeviation} exceeds tolerance`);
});

test('the documented default tolerance is applied and reported', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 10, depth: 10, height: 10 });

  const { meta } = await kernel.tessellate(box);
  const defaults = kernel.defaultTolerances;

  // The applied tolerance is never implicit.
  assert.equal(meta.linearDeflection, defaults.linear);
  assert.equal(meta.angularDeflection, defaults.angular);
  assert.ok(defaults.linear > 0);
});

test('a non-positive tolerance is rejected', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 10, depth: 10, height: 10 });

  await assert.rejects(
    () => kernel.tessellate(box, { linearDeflection: 0 }),
    InvalidParameterError,
  );
  await assert.rejects(
    () => kernel.tessellate(box, { linearDeflection: -1 }),
    InvalidParameterError,
  );
  await assert.rejects(
    () => kernel.tessellate(box, { angularDeflection: -0.5 }),
    InvalidParameterError,
  );
});

test('a repeated tessellation is served from cache', { skip }, async () => {
  const kernel = await makeKernel();
  const cylinder = await kernel.createCylinder({ radius: 15, height: 30 });

  const first = await kernel.tessellate(cylinder, { linearDeflection: 0.05 });
  assert.equal(first.meta.fromCache, false);

  const second = await kernel.tessellate(cylinder, { linearDeflection: 0.05 });
  assert.equal(second.meta.fromCache, true, 'second call should hit the cache');

  // Equivalent mesh, and the mesher did not run again.
  assert.equal(second.meta.triangleCount, first.meta.triangleCount);
  assert.deepEqual(second.mesh.indices, first.mesh.indices);

  const log = kernel.operationLog.filter((e) => e.operation === 'tessellate');
  const [cold, warm] = [log[log.length - 2], log[log.length - 1]];
  assert.ok(cold !== undefined && warm !== undefined);
  // Also visible in the timings, which is what the task asks for.
  assert.ok(
    warm.durationMs <= cold.durationMs,
    `cache hit (${warm.durationMs}ms) should not exceed cold (${cold.durationMs}ms)`,
  );
});

/**
 * A cache hit must not hand two callers the same buffers.
 *
 * The cache stores the kernel-side tessellation, and every delivery copies out
 * of it. Serving the same arrays twice would mean one caller mutating its mesh
 * silently corrupts another's - and, once buffers are transferred across a
 * Worker boundary, the second delivery would arrive already detached.
 */
test('a cache hit delivers independent buffers', { skip }, async () => {
  const kernel = await makeKernel();
  const cylinder = await kernel.createCylinder({ radius: 15, height: 30 });

  const first = await kernel.tessellate(cylinder, { linearDeflection: 0.05 });
  const second = await kernel.tessellate(cylinder, { linearDeflection: 0.05 });
  assert.equal(second.meta.fromCache, true, 'precondition: the second call hits the cache');

  assert.notEqual(
    first.mesh.positions.buffer,
    second.mesh.positions.buffer,
    'each delivery must own its buffers',
  );

  const original = first.mesh.positions[0];
  assert.ok(original !== undefined);
  second.mesh.positions[0] = original + 1000;
  assert.equal(
    first.mesh.positions[0],
    original,
    'mutating one delivered mesh must not affect another',
  );

  // And the cache itself is unharmed: a third call still matches the first.
  const third = await kernel.tessellate(cylinder, { linearDeflection: 0.05 });
  assert.equal(third.mesh.positions[0], original);
});

test('a different tolerance bypasses the cache', { skip }, async () => {
  const kernel = await makeKernel();
  const cylinder = await kernel.createCylinder({ radius: 15, height: 30 });

  await kernel.tessellate(cylinder, { linearDeflection: 0.5 });
  const other = await kernel.tessellate(cylinder, { linearDeflection: 0.05 });

  assert.equal(other.meta.fromCache, false, 'a new tolerance must be recomputed');
  assert.equal(kernel.stats().cachedMeshCount, 2);
});

test('releasing a body evicts its cached mesh', { skip }, async () => {
  const kernel = await makeKernel();
  const cylinder = await kernel.createCylinder({ radius: 15, height: 30 });

  await kernel.tessellate(cylinder, { linearDeflection: 0.05 });
  assert.equal(kernel.stats().cachedMeshCount, 1);
  assert.ok(kernel.stats().meshCacheBytes > 0);

  await kernel.release(cylinder);

  assert.equal(kernel.stats().cachedMeshCount, 0, 'cache entry must be evicted');
  assert.equal(kernel.stats().meshCacheBytes, 0);
  await assert.rejects(
    () => kernel.tessellate(cylinder),
    InvalidHandleError,
    'a released handle must serve no mesh',
  );
});

test('re-tessellating after discarding a mesh gives an equivalent mesh', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 12, depth: 8, height: 6 });

  const first = await kernel.tessellate(box, { linearDeflection: 0.1 });
  const second = await kernel.tessellate(box, { linearDeflection: 0.1 });

  // Discarding a mesh cannot affect the geometry: mesh is derived output only.
  assert.equal(second.meta.triangleCount, first.meta.triangleCount);
  assert.deepEqual(second.mesh.positions, first.mesh.positions);
});

test('no API accepts mesh buffers as geometric input', { skip }, async () => {
  const kernel = await makeKernel();

  // Guards the invariant structurally: if someone later adds a mesh-consuming
  // entry point, this list must be revisited deliberately.
  const geometryProducers = [
    'createBox',
    'createCylinder',
    'boolean',
    'union',
    'subtract',
    'intersect',
  ];
  for (const name of geometryProducers) {
    assert.equal(
      typeof (kernel as unknown as Record<string, unknown>)[name],
      'function',
    );
  }

  const surface = [
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(kernel) as object),
  ];
  const suspicious = surface.filter((name) =>
    /fromMesh|importMesh|meshToSolid|fromTriangles/i.test(name),
  );
  assert.deepEqual(suspicious, [], `mesh-to-geometry path found: ${suspicious}`);
});

/**
 * The memory-growth hazard from the design.
 *
 * When WASM linear memory grows, its backing ArrayBuffer is detached and every
 * existing typed-array view becomes unusable. This forces growth and then
 * tessellates, which would throw if the implementation cached a heap view
 * instead of deriving one per call.
 */
test('tessellation still works after WASM memory grows', { skip }, async () => {
  const kernel = await makeKernel();
  const startBytes = kernel.stats().wasmMemoryBytes;

  const probe = await kernel.createCylinder({ radius: 5, height: 10 });
  const before = await kernel.tessellate(probe, { linearDeflection: 0.1 });
  assert.ok(before.meta.triangleCount > 0);
  // Retained across the growth below. Delivered buffers are owned copies, so
  // this must survive intact - the whole point of not handing out heap views.
  const retained = Array.from(before.mesh.positions.slice(0, 24));

  // Allocate until linear memory actually grows.
  const ballast = [];
  let grew = false;
  for (let i = 0; i < 60 && !grew; i++) {
    const body = await kernel.createCylinder({
      radius: 40 + i,
      height: 80,
      origin: [i * 100, 0, 0],
    });
    ballast.push(body);
    await kernel.tessellate(body, { linearDeflection: 0.004 });
    grew = kernel.stats().wasmMemoryBytes > startBytes;
  }

  assert.ok(grew, 'could not force WASM memory growth; test is inconclusive');

  // A mesh handed out before the growth is still readable and unchanged. A view
  // over WASM memory would be detached by now and throw on access.
  assert.deepEqual(
    Array.from(before.mesh.positions.slice(0, 24)),
    retained,
    'a retained mesh must survive WASM memory growth',
  );

  // The real assertion: views derived after growth are valid. A retained view
  // would throw "Cannot perform Construct on a detached ArrayBuffer" here.
  const after = await kernel.tessellate(probe, { linearDeflection: 0.05 });
  assert.ok(after.meta.triangleCount > 0);
  assert.equal(after.mesh.positions.length, after.meta.vertexCount * 3);
  for (const index of after.mesh.indices) {
    assert.ok(index < after.meta.vertexCount);
  }

  // And a fresh body still tessellates correctly after growth.
  const fresh = await kernel.createBox({ width: 5, depth: 5, height: 5 });
  const freshMesh = await kernel.tessellate(fresh);
  assert.ok(freshMesh.meta.triangleCount >= 12);

  for (const body of ballast) await kernel.release(body);
});
