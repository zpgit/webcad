import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InvalidHandleError, InvalidParameterError } from '../src/kernel/errors.ts';
import { asBodyId } from '../src/kernel/types.ts';
import { boxAndDrill, closeTo, kernelSkip, makeKernel } from './helpers/kernel.ts';

const skip = kernelSkip;

test('subtract removes exactly the intersection volume', { skip }, async () => {
  const kernel = await makeKernel();
  const { box, drill, boxVolume } = await boxAndDrill(kernel);

  const outcome = await kernel.subtract(box, drill);
  assert.equal(outcome.kind, 'body');
  if (outcome.kind !== 'body') return;

  const info = await kernel.bodyInfo(outcome.bodyId);
  // The drill passes clean through, so the removed volume is a full cylinder of
  // the box's height.
  const removed = Math.PI * 10 * 10 * 25;
  assert.ok(
    closeTo(info.volume, boxVolume - removed, 1e-6),
    `volume was ${info.volume}, expected ${boxVolume - removed}`,
  );
  assert.ok(info.isValid);
});

test('subtract introduces the exact cylindrical surface of the tool', { skip }, async () => {
  const kernel = await makeKernel();
  const { box, drill } = await boxAndDrill(kernel);

  const outcome = await kernel.subtract(box, drill);
  assert.equal(outcome.kind, 'body');
  if (outcome.kind !== 'body') return;

  const faces = await kernel.faceTypeSummary(outcome.bodyId);
  // The hole wall is an analytic cylinder, not a tessellated approximation:
  // the Boolean preserved exact geometry.
  assert.equal(faces.cylinder, 1);
  assert.equal(faces.plane, 6);
  assert.equal(faces.bspline, 0);
});

test('union of overlapping solids removes the shared volume', { skip }, async () => {
  const kernel = await makeKernel();
  const a = await kernel.createBox({ width: 20, depth: 20, height: 20 });
  const b = await kernel.createBox({
    width: 20,
    depth: 20,
    height: 20,
    origin: [10, 0, 0],
  });

  const outcome = await kernel.union(a, b);
  assert.equal(outcome.kind, 'body');
  if (outcome.kind !== 'body') return;

  const info = await kernel.bodyInfo(outcome.bodyId);
  assert.equal(info.solidCount, 1);
  // 8000 + 8000 with a 10x20x20 overlap counted once.
  assert.ok(closeTo(info.volume, 8000 + 8000 - 4000), `volume was ${info.volume}`);
  assert.ok(info.volume < 16_000);
});

test('intersect yields the common volume', { skip }, async () => {
  const kernel = await makeKernel();
  const a = await kernel.createBox({ width: 20, depth: 20, height: 20 });
  const b = await kernel.createBox({
    width: 20,
    depth: 20,
    height: 20,
    origin: [15, 0, 0],
  });

  const outcome = await kernel.intersect(a, b);
  assert.equal(outcome.kind, 'body');
  if (outcome.kind !== 'body') return;

  const info = await kernel.bodyInfo(outcome.bodyId);
  assert.ok(closeTo(info.volume, 5 * 20 * 20), `volume was ${info.volume}`);
  assert.ok(info.isValid);
});

test('operands survive the operation and support chaining', { skip }, async () => {
  const kernel = await makeKernel();
  const { box, drill } = await boxAndDrill(kernel);

  const first = await kernel.subtract(box, drill);
  assert.equal(first.kind, 'body');
  if (first.kind !== 'body') return;

  // Both operands are still usable: the operation never implicitly released them.
  const boxInfo = await kernel.bodyInfo(box);
  const drillInfo = await kernel.bodyInfo(drill);
  assert.ok(boxInfo.volume > 0);
  assert.ok(drillInfo.volume > 0);

  const second = await kernel.subtract(first.bodyId, drill);
  assert.equal(second.kind, 'body');
  // The intermediate result also remains valid until explicitly released.
  const intermediate = await kernel.bodyInfo(first.bodyId);
  assert.ok(intermediate.volume > 0);
});

test('a tool enclosing the target reports an empty result, not an error', { skip }, async () => {
  const kernel = await makeKernel();
  const small = await kernel.createBox({ width: 5, depth: 5, height: 5 });
  const big = await kernel.createBox({
    width: 50,
    depth: 50,
    height: 50,
    origin: [-20, -20, -20],
  });

  const outcome = await kernel.subtract(small, big);
  assert.equal(outcome.kind, 'empty', 'removing all material is not a failure');
  // No handle is issued for an empty result.
  assert.equal(kernel.stats().liveBodyCount, 2);
});

test('intersecting disjoint solids reports an empty result', { skip }, async () => {
  const kernel = await makeKernel();
  const a = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const b = await kernel.createBox({
    width: 10,
    depth: 10,
    height: 10,
    origin: [500, 0, 0],
  });

  const outcome = await kernel.intersect(a, b);
  assert.equal(outcome.kind, 'empty');
});

test('union of disjoint solids succeeds as a multi-solid result', { skip }, async () => {
  const kernel = await makeKernel();
  const a = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const b = await kernel.createBox({
    width: 10,
    depth: 10,
    height: 10,
    origin: [500, 0, 0],
  });

  const outcome = await kernel.union(a, b);
  assert.equal(outcome.kind, 'body', 'a disjoint union must not be rejected');
  if (outcome.kind !== 'body') return;

  assert.equal(outcome.solidCount, 2, 'reported as multi-solid');
  const info = await kernel.bodyInfo(outcome.bodyId);
  assert.equal(info.solidCount, 2);
  assert.ok(closeTo(info.volume, 2000));
});

test('subtracting a disjoint tool leaves the target unchanged', { skip }, async () => {
  const kernel = await makeKernel();
  const a = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const b = await kernel.createBox({
    width: 10,
    depth: 10,
    height: 10,
    origin: [500, 0, 0],
  });

  const outcome = await kernel.subtract(a, b);
  assert.equal(outcome.kind, 'body');
  if (outcome.kind !== 'body') return;
  const info = await kernel.bodyInfo(outcome.bodyId);
  assert.ok(closeTo(info.volume, 1000));
});

test('an invalid operand handle is rejected without mutating state', { skip }, async () => {
  const kernel = await makeKernel();
  const real = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const bogus = asBodyId(4242);
  const before = kernel.stats().liveBodyCount;

  await assert.rejects(() => kernel.subtract(real, bogus), InvalidHandleError);
  await assert.rejects(() => kernel.subtract(bogus, real), InvalidHandleError);

  assert.equal(kernel.stats().liveBodyCount, before);
  const info = await kernel.bodyInfo(real);
  assert.ok(closeTo(info.volume, 1000));
});

test('a released operand is rejected', { skip }, async () => {
  const kernel = await makeKernel();
  const a = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const b = await kernel.createBox({ width: 6, depth: 6, height: 6 });
  await kernel.release(b);

  await assert.rejects(() => kernel.subtract(a, b), InvalidHandleError);
});

test('the same body as target and tool is rejected', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createBox({ width: 10, depth: 10, height: 10 });

  for (const op of ['union', 'subtract', 'intersect'] as const) {
    await assert.rejects(
      () => kernel.boolean(op, body, body),
      InvalidParameterError,
      `${op} should reject identical operands`,
    );
  }
  // Not computed as a degenerate case, so nothing was created.
  assert.equal(kernel.stats().liveBodyCount, 1);
});

/**
 * Deliberately awkward geometry.
 *
 * Task 5.7 requires recording the outcome as a finding rather than adjusting the
 * inputs until they pass. These cases are exactly where OCCT Booleans are known
 * to be fragile - coincident faces and tangency - so the assertion is only that
 * the kernel produces a defined outcome and stays usable, NOT that the operation
 * succeeds. Whatever happens here is MVP-0 output.
 */
test('awkward geometry: coincident faces and a tangent cylinder', { skip }, async () => {
  const kernel = await makeKernel();
  const findings: string[] = [];

  const describe = async (
    label: string,
    run: () => Promise<Awaited<ReturnType<typeof kernel.union>>>,
  ): Promise<void> => {
    try {
      const outcome = await run();
      if (outcome.kind === 'body') {
        const info = await kernel.bodyInfo(outcome.bodyId);
        findings.push(
          `${label}: body, volume=${info.volume.toFixed(4)}, valid=${info.isValid}`,
        );
        assert.ok(info.isValid, `${label} produced an invalid solid`);
      } else {
        findings.push(`${label}: empty result`);
      }
    } catch (error) {
      findings.push(
        `${label}: FAILED (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  };

  // Two boxes sharing a face exactly - the classic coincident-face case.
  const left = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const right = await kernel.createBox({
    width: 10,
    depth: 10,
    height: 10,
    origin: [10, 0, 0],
  });
  await describe('coincident-face union', () => kernel.union(left, right));
  await describe('coincident-face intersect', () => kernel.intersect(left, right));

  // A cylinder tangent to a box face: touching along a line, not overlapping.
  const block = await kernel.createBox({ width: 20, depth: 20, height: 20 });
  const tangent = await kernel.createCylinder({
    radius: 5,
    height: 30,
    origin: [25, 10, -5],
  });
  await describe('tangent-cylinder union', () => kernel.union(block, tangent));
  await describe('tangent-cylinder subtract', () => kernel.subtract(block, tangent));

  // Recorded for the MVP-0 findings; the kernel must remain usable regardless.
  console.log('  [finding] awkward Boolean outcomes:');
  for (const finding of findings) console.log(`    - ${finding}`);

  const survivor = await kernel.createBox({ width: 3, depth: 3, height: 3 });
  const info = await kernel.bodyInfo(survivor);
  assert.ok(closeTo(info.volume, 27), 'kernel must remain usable afterwards');
});
