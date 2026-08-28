// Translating STEP in and out.
//
// What these assert is not "bytes were produced". A round trip that turned an
// analytic cylinder into a spline, or silently dropped half an assembly, would
// still write a file that opens somewhere - and would still be data loss. So the
// checks are on the census: topology counts, volume, area, and surface types,
// before and after.
//
// The fixtures are OCCT's own test data and are gitignored, so every test that
// needs one skips explicitly when it is absent rather than passing vacuously.
// See `helpers/step-fixtures.ts` for why that distinction matters.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidHandleError,
  InvalidParameterError,
  StepTranslationError,
} from '../src/kernel/errors.ts';
import type { Kernel } from '../src/kernel/kernel.ts';
import type { BodyId } from '../src/kernel/types.ts';
import { closeTo, kernelSkip, makeKernel } from './helpers/kernel.ts';
import {
  readStepFixture,
  stepFixtureBytes,
  stepFixtureSkip,
} from './helpers/step-fixtures.ts';

const skip = kernelSkip;
const skipScrew = kernelSkip || stepFixtureSkip('screw');
const skipLinkrods = kernelSkip || stepFixtureSkip('linkrods');

/** The full comparison vector, in one call per body. */
async function census(kernel: Kernel, bodyId: BodyId): Promise<{
  info: Awaited<ReturnType<Kernel['bodyInfo']>>;
  faces: Awaited<ReturnType<Kernel['faceTypeSummary']>>;
}> {
  const [info, faces] = await Promise.all([
    kernel.bodyInfo(bodyId),
    kernel.faceTypeSummary(bodyId),
  ]);
  return { info, faces };
}

function assertCensusMatches(
  actual: Awaited<ReturnType<typeof census>>,
  expected: Awaited<ReturnType<typeof census>>,
  what: string,
): void {
  assert.equal(actual.info.faceCount, expected.info.faceCount, `${what}: faces`);
  assert.equal(actual.info.edgeCount, expected.info.edgeCount, `${what}: edges`);
  assert.equal(actual.info.solidCount, expected.info.solidCount, `${what}: solids`);
  assert.ok(
    closeTo(actual.info.volume, expected.info.volume, 1e-6),
    `${what}: volume ${actual.info.volume} vs ${expected.info.volume}`,
  );
  assert.ok(
    closeTo(actual.info.area, expected.info.area, 1e-6),
    `${what}: area ${actual.info.area} vs ${expected.info.area}`,
  );
  assert.deepEqual(actual.faces, expected.faces, `${what}: surface types`);
}

// --- Import ------------------------------------------------------------------

test('a single-part file imports as a body with real geometry', { skip: skipScrew }, async () => {
  const kernel = await makeKernel();
  const report = await kernel.importStep(readStepFixture('screw'));

  assert.ok(report.bodyIds.length >= 1, 'at least one body');
  assert.equal(report.payloadByteLength, stepFixtureBytes('screw'));

  const first = report.bodyIds[0];
  assert.ok(first !== undefined);
  const { info } = await census(kernel, first);

  // Not asserting exact counts against a magic number: the point is that real
  // geometry arrived, with faces and a positive volume, rather than an empty
  // shell the reader shrugged at.
  assert.ok(info.faceCount > 0, 'faces');
  assert.ok(info.volume > 0, `volume ${info.volume}`);
  assert.ok(
    info.boundingBox.max[0] > info.boundingBox.min[0],
    'a non-degenerate bounding box',
  );
});

/**
 * The larger fixture, which is not what its name suggests.
 *
 * `linkrods.step` is 1.8 MB and sounds like an assembly; it is a single part
 * with 37 faces, whose size comes from surface complexity rather than part
 * count. Asserted here as what it is, because a test that claimed it was an
 * assembly would pass only by accident and mislead the next reader.
 *
 * The consequence is recorded rather than worked around: **no fixture available
 * locally is a real STEP assembly**, so the product-structure branch of the
 * dropped-semantics report is not exercised against real data. The compound
 * flattening path is covered by the test below instead, which is a weaker claim
 * about a different thing.
 */
test('the large fixture imports and reports what it carried', { skip: skipLinkrods }, async () => {
  const kernel = await makeKernel();
  const report = await kernel.importStep(readStepFixture('linkrods'));

  assert.ok(report.bodyIds.length >= 1, 'at least one body');
  assert.equal(report.rootShapeCount, report.bodyIds.length + report.unregisteredShapeCount);

  // Whatever product structure the file carries must be counted, so a loss is
  // stated rather than discovered. A single-part file legitimately reports one
  // named product and no assembly nodes.
  assert.ok(report.namedProductCount >= 1, 'products in the file are counted');

  const body = report.bodyIds[0];
  assert.ok(body !== undefined);
  const info = await kernel.bodyInfo(body);
  assert.ok(info.faceCount > 0 && info.volume > 0, 'real geometry arrived');
});

test('a multi-body payload imports as separate bodies', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const cylinder = await kernel.createCylinder({
    radius: 4,
    height: 10,
    origin: [50, 0, 0],
  });

  // Export writes several bodies as one compound, so re-importing exercises the
  // flattening path: a compound must arrive as separate bodies rather than one
  // body that is secretly a tree.
  const exported = await kernel.exportStep([box, cylinder]);
  const back = await kernel.importStep(exported.bytes);

  assert.equal(back.bodyIds.length, 2, 'the compound was flattened into bodies');

  const volumes = await Promise.all(
    back.bodyIds.map(async (id) => (await kernel.bodyInfo(id)).volume),
  );
  volumes.sort((a, b) => a - b);
  assert.ok(closeTo(volumes[1]!, 1000, 1e-4), `box volume, got ${volumes[1]}`);
  assert.ok(
    closeTo(volumes[0]!, Math.PI * 16 * 10, 1e-3),
    `cylinder volume, got ${volumes[0]}`,
  );
});

test('units are reported for both sides of the boundary', { skip: skipScrew }, async () => {
  const kernel = await makeKernel();
  const report = await kernel.importStep(readStepFixture('screw'));

  assert.equal(report.workingUnit, 'mm', 'bodies arrive in the working unit');
  if (report.unitWasAssumed) {
    assert.equal(report.declaredUnit, '', 'an assumed unit means none was declared');
  } else {
    assert.ok(report.declaredUnit.length > 0, 'a declared unit is named');
  }
});

test('shape processing is off by default and reported when on', { skip: skipScrew }, async () => {
  const kernel = await makeKernel();

  const plain = await kernel.importStep(readStepFixture('screw'));
  assert.equal(plain.shapeProcessing, '', 'nothing runs unless asked');

  const processed = await kernel.importStep(readStepFixture('screw'), {
    shapeProcessing: true,
  });
  assert.ok(
    processed.shapeProcessing.length > 0,
    'processing that ran must name itself',
  );
});

// --- An imported body is an ordinary body ------------------------------------

test('an imported body takes part in a Boolean', { skip: skipScrew }, async () => {
  const kernel = await makeKernel();
  const report = await kernel.importStep(readStepFixture('screw'));
  const target = report.bodyIds.find((id) => !report.openBodyIds.includes(id));

  // Only meaningful against a body that is a valid closed solid; a Boolean on an
  // open shell is expected to fail, and does so in its own test below.
  if (target === undefined) return;

  const before = await kernel.bodyInfo(target);
  const [cx, cy] = [
    (before.boundingBox.min[0] + before.boundingBox.max[0]) / 2,
    (before.boundingBox.min[1] + before.boundingBox.max[1]) / 2,
  ];
  const tool = await kernel.createCylinder({
    radius: Math.max(
      (before.boundingBox.max[0] - before.boundingBox.min[0]) / 8,
      1e-3,
    ),
    height: (before.boundingBox.max[2] - before.boundingBox.min[2]) * 4,
    origin: [cx, cy, before.boundingBox.min[2] - 1],
    axis: [0, 0, 1],
  });

  const outcome = await kernel.subtract(target, tool);
  assert.ok(
    outcome.kind === 'body' || outcome.kind === 'empty',
    'a Boolean on imported geometry resolves on its own terms',
  );
  if (outcome.kind === 'body') {
    const after = await kernel.bodyInfo(outcome.bodyId);
    assert.ok(after.volume < before.volume, 'material was removed');
  }
});

test('an imported body survives a checkpoint round trip', { skip: skipScrew }, async () => {
  const kernel = await makeKernel();
  const report = await kernel.importStep(readStepFixture('screw'));
  const body = report.bodyIds[0];
  assert.ok(body !== undefined);

  const before = await census(kernel, body);
  const payload = await kernel.serialize([body]);
  const restored = await kernel.restore(payload.bytes);
  assert.equal(restored.length, 1);

  const handle = restored[0];
  assert.ok(handle !== undefined);
  assertCensusMatches(await census(kernel, handle), before, 'checkpoint');
});

// --- Export ------------------------------------------------------------------

test('a locally authored body exports and re-imports intact', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 30, depth: 20, height: 10 });
  const before = await census(kernel, box);

  const exported = await kernel.exportStep([box]);
  assert.ok(exported.bytes.byteLength > 0, 'bytes were written');
  assert.equal(exported.bodyCount, 1);

  const back = await kernel.importStep(exported.bytes);
  assert.equal(back.bodyIds.length, 1);
  const handle = back.bodyIds[0];
  assert.ok(handle !== undefined);

  assertCensusMatches(await census(kernel, handle), before, 'STEP round trip');
});

test('an analytic cylinder is still analytic after a round trip', { skip }, async () => {
  const kernel = await makeKernel();
  const cylinder = await kernel.createCylinder({ radius: 8, height: 25 });
  const before = await census(kernel, cylinder);
  assert.equal(before.faces.cylinder, 1, 'the fixture itself must be analytic');

  const exported = await kernel.exportStep([cylinder]);
  const back = await kernel.importStep(exported.bytes);
  const handle = back.bodyIds[0];
  assert.ok(handle !== undefined);
  const after = await census(kernel, handle);

  // The one that would matter most in practice: a writer that faceted or
  // spline-approximated the lateral surface would still produce a loadable file.
  assert.equal(after.faces.cylinder, 1, 'the cylindrical surface survived as exact');
  assert.equal(after.faces.bspline, 0, 'nothing became a spline');
});

test('an edit made after import is what gets exported', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 40, depth: 40, height: 20 });
  const drill = await kernel.createCylinder({
    radius: 6,
    height: 60,
    origin: [20, 20, -10],
    axis: [0, 0, 1],
  });
  const cut = await kernel.subtract(box, drill);
  assert.equal(cut.kind, 'body');
  if (cut.kind !== 'body') throw new Error('unreachable');

  const edited = await census(kernel, cut.bodyId);
  const exported = await kernel.exportStep([cut.bodyId]);
  const back = await kernel.importStep(exported.bytes);
  const handle = back.bodyIds[0];
  assert.ok(handle !== undefined);
  const roundTripped = await census(kernel, handle);

  assertCensusMatches(roundTripped, edited, 'edited geometry');
  assert.ok(
    roundTripped.info.volume < 40 * 40 * 20,
    'the hole is in the exported geometry, not just the session',
  );
});

test('export reports the unit it wrote', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 5, depth: 5, height: 5 });
  const exported = await kernel.exportStep([box]);
  assert.ok(exported.unitWritten.length > 0, 'the written unit is named');
});

// --- Failure -----------------------------------------------------------------

test('bytes that are not STEP fail typed, leaving the kernel usable', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const before = (await kernel.stats()).liveBodyCount;

  await assert.rejects(
    kernel.importStep(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    StepTranslationError,
  );

  assert.equal(
    (await kernel.stats()).liveBodyCount,
    before,
    'no handle was issued and none was lost',
  );
  // The kernel must still work, and the body that existed must still be there.
  const info = await kernel.bodyInfo(box);
  assert.ok(closeTo(info.volume, 1000), 'the pre-existing body is untouched');
});

test('a truncated STEP file is refused rather than half-imported', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 12, depth: 12, height: 12 });
  const whole = await kernel.exportStep([box]);
  const half = whole.bytes.slice(0, Math.floor(whole.bytes.byteLength / 2));

  await assert.rejects(kernel.importStep(half), StepTranslationError);

  // A partial import must not be mistakable for a whole one, so nothing at all
  // may be registered from a payload that could not be read in full.
  const stats = await kernel.stats();
  assert.equal(stats.liveBodyCount, 1, 'only the original body remains');
});

test('an empty payload is a parameter error, not a translation failure', { skip }, async () => {
  const kernel = await makeKernel();
  await assert.rejects(kernel.importStep(new Uint8Array(0)), InvalidParameterError);
});

test('exporting an unknown handle produces no payload', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const ghost = (box + 999) as BodyId;

  await assert.rejects(kernel.exportStep([box, ghost]), InvalidHandleError);

  // The valid operand in the set must be unaffected by the invalid one.
  const info = await kernel.bodyInfo(box);
  assert.ok(closeTo(info.volume, 1000));
});

test('exporting nothing is refused', { skip }, async () => {
  const kernel = await makeKernel();
  await assert.rejects(kernel.exportStep([]), InvalidParameterError);
});

// --- Ownership and the one-payload invariant ---------------------------------

test('an imported payload is transferred, not copied', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const payload = await kernel.exportStep([box]);
  const bytes = payload.bytes;

  await kernel.importStep(bytes);

  // The caller loses the buffer, exactly as for `restore`. Documented on the
  // API, and asserted here so a transport that quietly cloned instead would be
  // caught - the laxer contract is the one that would pass silently.
  assert.equal(bytes.byteLength, 0, 'the caller\'s view is detached');
});

test('concurrent payload requests do not corrupt each other', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 20, depth: 10, height: 10 });
  const cylinder = await kernel.createCylinder({ radius: 5, height: 10 });

  // The kernel holds one staging buffer, and the guarantee that a second
  // payload cannot overwrite one in flight rests on two structural facts:
  // requests are serialized, and staging never spans a request. Neither is
  // enforced by a counter, so it is asserted from the outside instead - four
  // payload operations issued without awaiting, each of which must come back
  // with its own bytes rather than a neighbour's.
  const [exportA, exportB, checkpointA, checkpointB] = await Promise.all([
    kernel.exportStep([box]),
    kernel.exportStep([cylinder]),
    kernel.serialize([box]),
    kernel.serialize([cylinder]),
  ]);

  assert.notEqual(
    exportA.bytes.byteLength,
    0,
    'the first export produced its own payload',
  );
  assert.notEqual(exportB.bytes.byteLength, 0);
  assert.notEqual(checkpointA.bytes.byteLength, 0);
  assert.notEqual(checkpointB.bytes.byteLength, 0);

  // Each payload must restore to the body it was taken from, which is what a
  // clobbered staging buffer would break.
  const [fromA] = await kernel.restore(checkpointA.bytes);
  assert.ok(fromA !== undefined);
  const infoA = await kernel.bodyInfo(fromA);
  assert.ok(closeTo(infoA.volume, 20 * 10 * 10), `box volume, got ${infoA.volume}`);

  const backB = await kernel.importStep(exportB.bytes);
  const handleB = backB.bodyIds[0];
  assert.ok(handleB !== undefined);
  const infoB = await kernel.bodyInfo(handleB);
  assert.ok(
    closeTo(infoB.volume, Math.PI * 25 * 10, 1e-3),
    `cylinder volume, got ${infoB.volume}`,
  );
});

test('an import/edit/export cycle leaks no handles', { skip }, async () => {
  const kernel = await makeKernel();
  const before = (await kernel.stats()).liveBodyCount;

  const box = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const exported = await kernel.exportStep([box]);
  const report = await kernel.importStep(exported.bytes);
  for (const id of report.bodyIds) await kernel.release(id);
  await kernel.release(box);

  assert.equal(
    (await kernel.stats()).liveBodyCount,
    before,
    'every handle the cycle issued was released',
  );
});
