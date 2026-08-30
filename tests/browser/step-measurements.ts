// What a STEP round trip costs, and what it loses, measured in a real browser.
//
// This is the module `scripts/verify-browser.mjs` loads to answer MVP-2's
// question: import a file, translate it, tessellate it, checkpoint it, restore
// it, edit it, export it, and read it back - capturing wall-clock time, peak
// WASM memory, byte sizes, and a geometry census at every point where geometry
// changes hands.
//
// Two things about the method are worth stating, because they are what make the
// numbers mean anything.
//
// **The census is the measurement, not the timing.** A round trip that took two
// milliseconds and quietly turned an analytic cylinder into a spline would look
// excellent here and be data loss. So each phase is compared against the last on
// topology counts, volume, area, bounding box, and surface types, and a
// difference is reported rather than averaged into a pass.
//
// **Shape processing is measured both ways.** OCCT's reader runs `FixShape` by
// default and its writer reorients faces and splits vertices; all three change
// the geometry that crosses the boundary. With processing on, a difference
// between the file and the body has two possible causes and no way to tell them
// apart - so the same fixture is imported twice, once each way, and the delta
// between those two imports is the healer's contribution rather than
// translation's.
//
// The fixtures are OCCT's own test data under a gitignored path. When they are
// absent this module reports that it could not run rather than reporting success,
// for the reason spelled out in `tests/helpers/step-fixtures.ts`: "the round trip
// is fine" and "the round trip was never tried" must not look the same.
//
// Every body this module creates is released before it returns. It runs inside a
// verification session that has its own document and must leave it untouched.

import type { Kernel } from '../../src/kernel/kernel.ts';
import type { BodyId, StepImportReport } from '../../src/kernel/types.ts';

// --- Reported shapes ---------------------------------------------------------

/** Everything a translation must preserve, gathered per body. */
export interface Census {
  readonly faceCount: number;
  readonly edgeCount: number;
  readonly vertexCount: number;
  readonly solidCount: number;
  readonly volume: number;
  readonly area: number;
  readonly bbox: readonly [number, number, number, number, number, number];
  readonly isValid: boolean;
  readonly isClosed: boolean;
  readonly surfaces: Readonly<Record<string, number>>;
}

/** A census summed over a set of bodies, which is how a file is compared. */
export interface AggregateCensus extends Census {
  readonly bodyCount: number;
}

export interface CensusDelta {
  readonly field: string;
  readonly before: number | string;
  readonly after: number | string;
  /** Relative difference for numeric fields, absent for the rest. */
  readonly relative?: number;
}

export interface PhaseTiming {
  readonly phase: string;
  readonly ms: number;
  /** Bytes moved, for the phases that move any. */
  readonly bytes?: number;
  /** WASM linear memory in use once the phase completed. */
  readonly wasmMemoryBytes: number;
}

export interface FixtureRoundTrip {
  readonly fixture: string;
  readonly fileBytes: number;

  /** Imported with OCCT's shape processing suppressed - this stage's default. */
  readonly imported: AggregateCensus;
  readonly importReport: ImportSummary;

  /** The same file with OCCT's default processing enabled, for comparison. */
  readonly importedHealed: AggregateCensus | null;
  readonly healedReport: ImportSummary | null;
  /** What the healer changed. Empty means it changed nothing measurable. */
  readonly healingDeltas: readonly CensusDelta[];

  /** After a native checkpoint and restore, which must change nothing. */
  readonly afterCheckpoint: AggregateCensus | null;
  readonly checkpointDeltas: readonly CensusDelta[];
  readonly checkpointBytes: number;

  /** After exporting to STEP and reading it back. */
  readonly afterReimport: AggregateCensus | null;
  readonly reimportDeltas: readonly CensusDelta[];
  readonly exportBytes: number;

  readonly timings: readonly PhaseTiming[];
  readonly notes: readonly string[];
}

/** The import report, minus the handles, which mean nothing outside the run. */
export interface ImportSummary {
  readonly bodyCount: number;
  readonly rootShapeCount: number;
  readonly unregisteredShapeCount: number;
  readonly openBodyCount: number;
  readonly declaredUnit: string;
  readonly workingUnit: string;
  readonly unitWasAssumed: boolean;
  readonly namedProductCount: number;
  readonly styledItemCount: number;
  readonly assemblyNodeCount: number;
  readonly shapeProcessing: string;
  readonly payloadByteLength: number;
}

export interface EditRoundTrip {
  readonly label: string;
  readonly beforeEdit: AggregateCensus;
  readonly afterEdit: AggregateCensus;
  readonly afterReimport: AggregateCensus;
  readonly deltas: readonly CensusDelta[];
  readonly exportBytes: number;
  readonly volumeRemoved: number;
}

export interface StepMeasurements {
  readonly fixtures: readonly FixtureRoundTrip[];
  /** Fixtures that could not be read, and why. Never silently omitted. */
  readonly unavailableFixtures: readonly { fixture: string; reason: string }[];
  /** The edit round trip, on geometry authored here so it always runs. */
  readonly edit: EditRoundTrip | null;
  readonly peakWasmMemoryBytes: number;
  readonly notes: readonly string[];
}

// --- Fixtures ----------------------------------------------------------------

const FIXTURES: readonly { name: string; url: string }[] = [
  { name: 'screw.step', url: '/third_party/occt/data/step/screw.step' },
  { name: 'linkrods.step', url: '/third_party/occt/data/step/linkrods.step' },
  // An assembly, which the two above are not: both are single parts. The first
  // is committed and hand-authored, so it is always available; the second is a
  // real assembly from another CAD system, pinned but hosted elsewhere, so it
  // may be absent and is reported as such rather than quietly omitted.
  { name: 'assembly.step', url: '/tests/fixtures/assembly.step' },
  { name: 'as1-md-214.stp', url: '/third_party/step-fixtures/as1-md-214.stp' },
];

/**
 * Fetches a fixture through the dev server.
 *
 * A failed fetch is a missing fixture, not a broken measurement: the path is
 * gitignored, so a checkout that has not run `npm run fixtures:fetch` simply does
 * not have it. Returning null lets the caller report that rather than throw.
 */
async function fetchFixture(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

// --- Census ------------------------------------------------------------------

async function censusOf(kernel: Kernel, bodyId: BodyId): Promise<Census> {
  const [info, faces] = await Promise.all([
    kernel.bodyInfo(bodyId),
    kernel.faceTypeSummary(bodyId),
  ]);
  return {
    faceCount: info.faceCount,
    edgeCount: info.edgeCount,
    vertexCount: info.vertexCount,
    solidCount: info.solidCount,
    volume: info.volume,
    area: info.area,
    bbox: [...info.boundingBox.min, ...info.boundingBox.max] as const as
      readonly [number, number, number, number, number, number],
    isValid: info.isValid,
    isClosed: info.isClosed,
    surfaces: { ...faces },
  };
}

/**
 * Sums a census over a set of bodies.
 *
 * Summed rather than compared body by body, because a translation is free to
 * hand back the same geometry in a different order - and for an assembly it
 * does. What must not change is the total: the same faces, the same volume, the
 * same surfaces. Comparing positionally would report a false loss for a
 * reordering that lost nothing.
 *
 * The bounding box is unioned rather than summed, for the same reason.
 */
async function aggregateCensus(
  kernel: Kernel,
  bodyIds: readonly BodyId[],
): Promise<AggregateCensus> {
  const each = await Promise.all(bodyIds.map((id) => censusOf(kernel, id)));

  const surfaces: Record<string, number> = {};
  let bbox: [number, number, number, number, number, number] = [
    Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity,
  ];
  const totals = { faces: 0, edges: 0, vertices: 0, solids: 0, volume: 0, area: 0 };
  let allValid = true;
  let allClosed = true;

  for (const one of each) {
    totals.faces += one.faceCount;
    totals.edges += one.edgeCount;
    totals.vertices += one.vertexCount;
    totals.solids += one.solidCount;
    totals.volume += one.volume;
    totals.area += one.area;
    allValid = allValid && one.isValid;
    allClosed = allClosed && one.isClosed;
    for (const [type, count] of Object.entries(one.surfaces)) {
      surfaces[type] = (surfaces[type] ?? 0) + count;
    }
    bbox = [
      Math.min(bbox[0], one.bbox[0]),
      Math.min(bbox[1], one.bbox[1]),
      Math.min(bbox[2], one.bbox[2]),
      Math.max(bbox[3], one.bbox[3]),
      Math.max(bbox[4], one.bbox[4]),
      Math.max(bbox[5], one.bbox[5]),
    ];
  }

  return {
    bodyCount: bodyIds.length,
    faceCount: totals.faces,
    edgeCount: totals.edges,
    vertexCount: totals.vertices,
    solidCount: totals.solids,
    volume: totals.volume,
    area: totals.area,
    bbox,
    isValid: allValid,
    isClosed: allClosed,
    surfaces,
  };
}

/** Relative tolerance for a geometric quantity surviving a translation. */
const GEOMETRY_TOLERANCE = 1e-6;

function compare(
  before: AggregateCensus,
  after: AggregateCensus,
): readonly CensusDelta[] {
  const deltas: CensusDelta[] = [];

  const counts: readonly (keyof AggregateCensus)[] = [
    'bodyCount', 'faceCount', 'edgeCount', 'vertexCount', 'solidCount',
  ];
  for (const field of counts) {
    const a = before[field] as number;
    const b = after[field] as number;
    if (a !== b) deltas.push({ field, before: a, after: b });
  }

  for (const field of ['volume', 'area'] as const) {
    const a = before[field];
    const b = after[field];
    const scale = Math.max(Math.abs(a), 1e-9);
    const relative = Math.abs(b - a) / scale;
    if (relative > GEOMETRY_TOLERANCE) {
      deltas.push({ field, before: a, after: b, relative });
    }
  }

  // Surface types are where a lossy writer shows itself: a cylinder that comes
  // back as a b-spline has the same face count and nearly the same volume.
  const types = new Set([
    ...Object.keys(before.surfaces),
    ...Object.keys(after.surfaces),
  ]);
  for (const type of types) {
    const a = before.surfaces[type] ?? 0;
    const b = after.surfaces[type] ?? 0;
    if (a !== b) deltas.push({ field: `surfaces.${type}`, before: a, after: b });
  }

  for (const field of ['isValid', 'isClosed'] as const) {
    if (before[field] !== after[field]) {
      deltas.push({
        field,
        before: String(before[field]),
        after: String(after[field]),
      });
    }
  }

  return deltas;
}

function summarize(report: StepImportReport): ImportSummary {
  return {
    bodyCount: report.bodyIds.length,
    rootShapeCount: report.rootShapeCount,
    unregisteredShapeCount: report.unregisteredShapeCount,
    openBodyCount: report.openBodyIds.length,
    declaredUnit: report.declaredUnit,
    workingUnit: report.workingUnit,
    unitWasAssumed: report.unitWasAssumed,
    namedProductCount: report.namedProductCount,
    styledItemCount: report.styledItemCount,
    assemblyNodeCount: report.assemblyNodeCount,
    shapeProcessing: report.shapeProcessing,
    payloadByteLength: report.payloadByteLength,
  };
}

// --- Timing ------------------------------------------------------------------

async function timed<T>(
  kernel: Kernel,
  phase: string,
  into: PhaseTiming[],
  run: () => Promise<T>,
  bytesOf?: (value: T) => number,
): Promise<T> {
  const started = performance.now();
  const value = await run();
  const ms = performance.now() - started;
  const stats = await kernel.stats();
  into.push({
    phase,
    ms,
    ...(bytesOf === undefined ? {} : { bytes: bytesOf(value) }),
    wasmMemoryBytes: stats.wasmMemoryBytes,
  });
  return value;
}

async function releaseAll(kernel: Kernel, bodyIds: readonly BodyId[]): Promise<void> {
  for (const id of bodyIds) {
    try {
      await kernel.release(id);
    } catch {
      // A body already gone is not a measurement failure; the point of this loop
      // is to leave the session as it was found.
    }
  }
}

// --- One fixture -------------------------------------------------------------

async function measureFixture(
  kernel: Kernel,
  fixture: { name: string; url: string },
  bytes: Uint8Array,
): Promise<FixtureRoundTrip> {
  const timings: PhaseTiming[] = [];
  const notes: string[] = [];
  const fileBytes = bytes.byteLength;

  // Each import consumes its buffer, so every pass gets its own copy. The
  // fixture is fetched once and copied rather than re-fetched, so a slow network
  // cannot show up as translation cost.
  const copy = (): Uint8Array => new Uint8Array(bytes);

  let live: BodyId[] = [];
  let healedBodies: BodyId[] = [];
  let restored: BodyId[] = [];
  let reimported: BodyId[] = [];

  try {
    const report = await timed(
      kernel,
      'import',
      timings,
      () => kernel.importStep(copy()),
      () => fileBytes,
    );
    live = [...report.bodyIds];

    if (live.length === 0) {
      notes.push(
        `${fixture.name} produced no bodies: ${report.rootShapeCount} roots ` +
          `declared, ${report.unregisteredShapeCount} unusable.`,
      );
      return {
        fixture: fixture.name,
        fileBytes,
        imported: await aggregateCensus(kernel, []),
        importReport: summarize(report),
        importedHealed: null,
        healedReport: null,
        healingDeltas: [],
        afterCheckpoint: null,
        checkpointDeltas: [],
        checkpointBytes: 0,
        afterReimport: null,
        reimportDeltas: [],
        exportBytes: 0,
        timings,
        notes,
      };
    }

    const imported = await aggregateCensus(kernel, live);

    // Tessellation is timed separately from translation so the time to first
    // pixels can be attributed between them rather than reported as one number.
    await timed(kernel, 'tessellate', timings, async () => {
      for (const id of live) await kernel.tessellate(id, {});
      return null;
    });

    // The same file with OCCT's defaults on. The delta between this and the
    // import above is the healer's contribution, which is the only way to tell
    // a repair apart from a translation loss.
    let importedHealed: AggregateCensus | null = null;
    let healedReport: ImportSummary | null = null;
    let healingDeltas: readonly CensusDelta[] = [];
    try {
      const healed = await timed(
        kernel,
        'import (healed)',
        timings,
        () => kernel.importStep(copy(), { shapeProcessing: true }),
        () => fileBytes,
      );
      healedBodies = [...healed.bodyIds];
      healedReport = summarize(healed);
      importedHealed = await aggregateCensus(kernel, healedBodies);
      healingDeltas = compare(imported, importedHealed);
    } catch (error) {
      notes.push(
        `Import with shape processing enabled failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // A native checkpoint must be lossless. Included because it is the one leg
    // of the round trip that has already been measured (MVP-1) and so acts as a
    // control: if this shows a delta, the comparison method is suspect, not the
    // translator.
    const checkpoint = await timed(
      kernel,
      'checkpoint',
      timings,
      () => kernel.serialize(live),
      (payload) => payload.bytes.byteLength,
    );
    const checkpointBytes = checkpoint.bytes.byteLength;
    restored = await timed(
      kernel,
      'restore',
      timings,
      () => kernel.restore(checkpoint.bytes),
      () => checkpointBytes,
    );
    const afterCheckpoint = await aggregateCensus(kernel, restored);
    const checkpointDeltas = compare(imported, afterCheckpoint);

    // The loop closed: our writer against our reader. Self-referential, and the
    // findings have to say so - it validates that we do not lose geometry
    // through our own export, not that another CAD system would accept it.
    const exported = await timed(
      kernel,
      'export',
      timings,
      () => kernel.exportStep(live),
      (payload) => payload.bytes.byteLength,
    );
    const exportBytes = exported.bytes.byteLength;
    const back = await timed(
      kernel,
      're-import',
      timings,
      () => kernel.importStep(exported.bytes),
      () => exportBytes,
    );
    reimported = [...back.bodyIds];
    const afterReimport = await aggregateCensus(kernel, reimported);
    const reimportDeltas = compare(imported, afterReimport);

    return {
      fixture: fixture.name,
      fileBytes,
      imported,
      importReport: summarize(report),
      importedHealed,
      healedReport,
      healingDeltas,
      afterCheckpoint,
      checkpointDeltas,
      checkpointBytes,
      afterReimport,
      reimportDeltas,
      exportBytes,
      timings,
      notes,
    };
  } finally {
    await releaseAll(kernel, [...live, ...healedBodies, ...restored, ...reimported]);
  }
}

// --- The edit leg ------------------------------------------------------------

/**
 * Import, edit, export - on geometry authored here.
 *
 * On our own geometry rather than a fixture so this leg always runs, and so the
 * expected volume is known in advance rather than taken from whatever the
 * fixture happens to contain. What it demonstrates is the claim from section 5
 * of the architecture note: an edit made in the browser is in the exported file.
 */
async function measureEdit(kernel: Kernel): Promise<EditRoundTrip> {
  const created: BodyId[] = [];
  try {
    const box = await kernel.createBox({ width: 60, depth: 40, height: 25 });
    created.push(box);
    const beforeEdit = await aggregateCensus(kernel, [box]);

    const drill = await kernel.createCylinder({
      radius: 8,
      height: 60,
      origin: [30, 20, -10],
      axis: [0, 0, 1],
    });
    created.push(drill);

    const outcome = await kernel.boolean('subtract', box, drill);
    if (outcome.kind !== 'body') {
      throw new Error('the edit produced no geometry');
    }
    created.push(outcome.bodyId);
    const afterEdit = await aggregateCensus(kernel, [outcome.bodyId]);

    const exported = await kernel.exportStep([outcome.bodyId]);
    const exportBytes = exported.bytes.byteLength;
    const back = await kernel.importStep(exported.bytes);
    created.push(...back.bodyIds);
    const afterReimport = await aggregateCensus(kernel, back.bodyIds);

    return {
      label: 'box with a drilled hole',
      beforeEdit,
      afterEdit,
      afterReimport,
      deltas: compare(afterEdit, afterReimport),
      exportBytes,
      volumeRemoved: beforeEdit.volume - afterEdit.volume,
    };
  } finally {
    await releaseAll(kernel, created);
  }
}

// --- Entry point -------------------------------------------------------------

/**
 * Measures the STEP round trip against every fixture available.
 *
 * Takes the live kernel rather than making its own, for the same reason the
 * persistence measurement does: a second WASM module in the page would double
 * the memory this is trying to report.
 */
export async function measureStepRoundTrip(
  kernel: Kernel,
): Promise<StepMeasurements> {
  const fixtures: FixtureRoundTrip[] = [];
  const unavailableFixtures: { fixture: string; reason: string }[] = [];
  const notes: string[] = [];

  for (const fixture of FIXTURES) {
    const bytes = await fetchFixture(fixture.url);
    if (bytes === null) {
      unavailableFixtures.push({
        fixture: fixture.name,
        reason:
          `could not be fetched from ${fixture.url} - OCCT test data is ` +
          'gitignored; run `npm run fixtures:fetch`',
      });
      continue;
    }
    try {
      fixtures.push(await measureFixture(kernel, fixture, bytes));
    } catch (error) {
      unavailableFixtures.push({
        fixture: fixture.name,
        reason: `translation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  let edit: EditRoundTrip | null = null;
  try {
    edit = await measureEdit(kernel);
  } catch (error) {
    notes.push(
      `The edit round trip failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (unavailableFixtures.length === FIXTURES.length) {
    notes.push(
      'No third-party fixture was available, so nothing here says anything ' +
        'about interoperability - only about our own writer against our own ' +
        'reader.',
    );
  }

  const stats = await kernel.stats();
  return {
    fixtures,
    unavailableFixtures,
    edit,
    peakWasmMemoryBytes: stats.wasmPeakMemoryBytes,
    notes,
  };
}
