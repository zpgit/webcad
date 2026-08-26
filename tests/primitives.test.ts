import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InvalidParameterError } from '../src/kernel/errors.ts';
import { closeTo, kernelSkip, makeKernel } from './helpers/kernel.ts';

const skip = kernelSkip;

test('a box is a closed solid with the expected topology and volume', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 30, depth: 20, height: 10 });
  const info = await kernel.bodyInfo(box);

  assert.equal(info.faceCount, 6);
  assert.equal(info.edgeCount, 12);
  assert.equal(info.vertexCount, 8);
  assert.equal(info.solidCount, 1);
  assert.ok(info.isValid);
  assert.ok(closeTo(info.volume, 30 * 20 * 10), `volume was ${info.volume}`);
});

test('box placement moves the bounding box but not the dimensions', { skip }, async () => {
  const kernel = await makeKernel();
  const dims = { width: 12, depth: 8, height: 4 } as const;

  const atOrigin = await kernel.bodyInfo(await kernel.createBox({ ...dims }));
  const moved = await kernel.bodyInfo(
    await kernel.createBox({ ...dims, origin: [100, -50, 25] }),
  );

  assert.ok(closeTo(moved.boundingBox.min[0], 100, 1e-6));
  assert.ok(closeTo(moved.boundingBox.min[1], -50, 1e-6));
  assert.ok(closeTo(moved.boundingBox.min[2], 25, 1e-6));

  // Dimensions are unchanged by the transform.
  const extent = (b: typeof moved.boundingBox): number[] => [
    b.max[0] - b.min[0],
    b.max[1] - b.min[1],
    b.max[2] - b.min[2],
  ];
  const expected = extent(atOrigin.boundingBox);
  extent(moved.boundingBox).forEach((value, i) => {
    assert.ok(
      closeTo(value, expected[i] ?? 0, 1e-6),
      `extent[${i}] was ${value}, expected ${expected[i]}`,
    );
  });
  assert.ok(closeTo(moved.volume, atOrigin.volume, 1e-9));
});

test('a rotated box keeps its volume and face count', { skip }, async () => {
  const kernel = await makeKernel();
  const rotated = await kernel.createBox({
    width: 10,
    depth: 10,
    height: 10,
    axis: [0, 0, 1],
    angle: Math.PI / 4,
  });
  const info = await kernel.bodyInfo(rotated);

  assert.equal(info.faceCount, 6);
  assert.ok(closeTo(info.volume, 1000));
  // Rotated 45 degrees about Z, the footprint diagonal spans 10*sqrt(2).
  const width = info.boundingBox.max[0] - info.boundingBox.min[0];
  assert.ok(closeTo(width, 10 * Math.SQRT2, 1e-6), `width was ${width}`);
});

test('a cylinder has three faces and the exact volume', { skip }, async () => {
  const kernel = await makeKernel();
  const cylinder = await kernel.createCylinder({ radius: 5, height: 12 });
  const info = await kernel.bodyInfo(cylinder);

  assert.equal(info.faceCount, 3, 'one lateral face and two planar caps');
  assert.equal(info.solidCount, 1);
  assert.ok(info.isValid);
  assert.ok(closeTo(info.volume, Math.PI * 25 * 12), `volume was ${info.volume}`);
});

test("a cylinder's lateral surface is an exact analytic cylinder", { skip }, async () => {
  const kernel = await makeKernel();
  const cylinder = await kernel.createCylinder({ radius: 7, height: 20 });
  const faces = await kernel.faceTypeSummary(cylinder);

  // The point of the check: the primitive carries exact geometry, not a
  // faceted approximation.
  assert.equal(faces.cylinder, 1);
  assert.equal(faces.plane, 2);
  assert.equal(faces.bspline, 0);
  assert.equal(faces.other, 0);
});

test('a cylinder can be placed along an arbitrary axis', { skip }, async () => {
  const kernel = await makeKernel();
  const cylinder = await kernel.createCylinder({
    radius: 3,
    height: 40,
    origin: [10, 0, 0],
    axis: [1, 0, 0],
  });
  const info = await kernel.bodyInfo(cylinder);

  // Extruded along X, so X spans the height and Y/Z span the diameter.
  assert.ok(closeTo(info.boundingBox.min[0], 10, 1e-6));
  assert.ok(closeTo(info.boundingBox.max[0], 50, 1e-6));
  assert.ok(closeTo(info.boundingBox.max[1] - info.boundingBox.min[1], 6, 1e-6));
  assert.ok(closeTo(info.volume, Math.PI * 9 * 40));
});

test('non-positive box dimensions are rejected by name', { skip }, async () => {
  const kernel = await makeKernel();
  const before = kernel.stats().liveBodyCount;

  const cases: Array<[string, { width: number; depth: number; height: number }]> = [
    ['width', { width: 0, depth: 5, height: 5 }],
    ['depth', { width: 5, depth: -2, height: 5 }],
    ['height', { width: 5, depth: 5, height: 0 }],
  ];

  for (const [name, options] of cases) {
    await assert.rejects(
      () => kernel.createBox(options),
      (error: unknown) => {
        assert.ok(error instanceof InvalidParameterError);
        assert.match(error.message, new RegExp(name));
        return true;
      },
    );
  }

  // No handle was created for any rejected call.
  assert.equal(kernel.stats().liveBodyCount, before);
});

test('non-positive cylinder radius or height is rejected by name', { skip }, async () => {
  const kernel = await makeKernel();
  const before = kernel.stats().liveBodyCount;

  await assert.rejects(
    () => kernel.createCylinder({ radius: 0, height: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidParameterError);
      assert.match(error.message, /radius/);
      return true;
    },
  );
  await assert.rejects(
    () => kernel.createCylinder({ radius: 5, height: -1 }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidParameterError);
      assert.match(error.message, /height/);
      return true;
    },
  );

  assert.equal(kernel.stats().liveBodyCount, before);
});

test('a degenerate axis is rejected', { skip }, async () => {
  const kernel = await makeKernel();
  await assert.rejects(
    () => kernel.createCylinder({ radius: 5, height: 10, axis: [0, 0, 0] }),
    InvalidParameterError,
  );
});

test('a primitive is indistinguishable from any other body downstream', { skip }, async () => {
  const kernel = await makeKernel();
  const primitive = await kernel.createBox({ width: 20, depth: 20, height: 20 });
  const tool = await kernel.createCylinder({
    radius: 4,
    height: 40,
    origin: [10, 10, -10],
  });

  const first = await kernel.subtract(primitive, tool);
  assert.equal(first.kind, 'body');
  if (first.kind !== 'body') return;

  // The result of a Boolean feeds the same operations a primitive does, with no
  // knowledge of how either body originated.
  const second = await kernel.subtract(first.bodyId, tool);
  assert.equal(second.kind, 'body');
  const mesh = await kernel.tessellateToCopy(primitive);
  assert.ok(mesh.meta.triangleCount > 0);
});
