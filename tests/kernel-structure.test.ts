// Structure and appearance, against the raw WASM module.
//
// Every other kernel test in this directory drives the TypeScript boundary. This
// one deliberately does not: it loads the Emscripten module and calls
// `importStep` / `exportStep` / `tessellate` directly, because the C++ landed
// before the boundary did and the properties below are the C++'s, not the
// wrapper's. When group 7's boundary exists this file stays as it is - a test
// that goes through two layers cannot say which of them broke.
//
// It replaces a scratch harness. MVP-1 and MVP-2 each verified their C++ with a
// throwaway script under gitignored `native/build/`, which meant neither
// survived its stage and CI never ran either. The properties here are
// load-bearing and silent when they break - a face colour landing one face over,
// a scratch document never closed, a fabricated assembly nobody asked for - so
// they are pinned where they will be run.

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { KERNEL_ARTIFACT, kernelSkip } from './helpers/kernel.ts';
import { loadEmscriptenModule } from './helpers/load-wasm.ts';
import {
  ASSEMBLY_FIXTURE,
  THIRD_PARTY_ASSEMBLY,
  readAssemblyFixture,
  readThirdPartyAssembly,
  thirdPartyAssemblySkip,
} from './helpers/step-fixtures.ts';

const skip = kernelSkip;

// --- The raw module, as loosely as it can be typed --------------------------
//
// Deliberately not the `KernelModule` interface from `src/kernel/wasm-module.ts`:
// that describes the surface the boundary uses, and half of what this file
// exercises is not on it yet. Typed locally so the two can diverge until group 7
// brings them together.

interface RawVec<T> {
  size(): number;
  get(index: number): T;
  push_back(value: T): void;
  delete(): void;
}
interface RawInstance {
  parent: number;
  part: number;
  name: string;
  hasColour: boolean;
  colourR: number;
  colourG: number;
  colourB: number;
}
interface RawPart {
  name: string;
  hasColour: boolean;
  colourR: number;
  colourG: number;
  colourB: number;
  faceCount: number;
  faceColourStart: number;
  colouredFaceCount: number;
}
interface RawFaceColour {
  has: boolean;
  r: number;
  g: number;
  b: number;
}
type RawModule = Record<string, any>;

let cached: RawModule | null = null;

async function rawModule(): Promise<RawModule> {
  cached ??= await loadEmscriptenModule<RawModule>(KERNEL_ARTIFACT);
  return cached;
}

// One module for the whole file, released at the end. A module is a 15 MB code
// image plus its heap and nothing collects it while it is reachable, which is
// what made an earlier suite stop working rather than slow down.
after(() => {
  cached = null;
});

const FLAT = { shapeProcessing: false, structure: false };
const CAF = { shapeProcessing: false, structure: true };

/** A plain-data copy of an import result, with every embind vector freed. */
interface Report {
  status: number;
  message: string;
  firstBodyId: number;
  bodyCount: number;
  structureRequested: boolean;
  structurePresent: boolean;
  treeDepth: number;
  groupingNodeCount: number;
  namedInstanceCount: number;
  namedPartCount: number;
  colouredPartCount: number;
  colouredInstanceCount: number;
  colouredFaceCount: number;
  assemblyNodeCount: number;
  unregisteredShapeCount: number;
  unresolvedInstanceCount: number;
  instances: RawInstance[];
  placements: number[];
  parts: RawPart[];
  faceColours: RawFaceColour[];
}

function drain<T>(vec: RawVec<T>): T[] {
  const out: T[] = [];
  try {
    for (let i = 0; i < vec.size(); i += 1) out.push(vec.get(i));
  } finally {
    vec.delete();
  }
  return out;
}

function importBytes(mod: RawModule, bytes: Uint8Array, options = CAF): Report {
  const staged = mod.reserveStaging(bytes.length);
  assert.equal(staged.status, 0, staged.message);
  // The view is taken AFTER the call: reserving can grow the heap, which
  // detaches every view over it.
  new Uint8Array(mod.HEAPU8.buffer, staged.dataPtr, bytes.length).set(bytes);
  const r = mod.importStep(options);
  const report: Report = {
    status: r.status,
    message: r.message,
    firstBodyId: r.firstBodyId,
    bodyCount: r.bodyCount,
    structureRequested: r.structureRequested,
    structurePresent: r.structurePresent,
    treeDepth: r.treeDepth,
    groupingNodeCount: r.groupingNodeCount,
    namedInstanceCount: r.namedInstanceCount,
    namedPartCount: r.namedPartCount,
    colouredPartCount: r.colouredPartCount,
    colouredInstanceCount: r.colouredInstanceCount,
    colouredFaceCount: r.colouredFaceCount,
    assemblyNodeCount: r.assemblyNodeCount,
    unregisteredShapeCount: r.unregisteredShapeCount,
    unresolvedInstanceCount: r.unresolvedInstanceCount,
    instances: drain<RawInstance>(r.instances).map((n) => ({
      parent: n.parent,
      part: n.part,
      name: n.name,
      hasColour: n.hasColour,
      colourR: n.colourR,
      colourG: n.colourG,
      colourB: n.colourB,
    })),
    placements: drain<number>(r.placements),
    parts: drain<RawPart>(r.parts).map((q) => ({
      name: q.name,
      hasColour: q.hasColour,
      colourR: q.colourR,
      colourG: q.colourG,
      colourB: q.colourB,
      faceCount: q.faceCount,
      faceColourStart: q.faceColourStart,
      colouredFaceCount: q.colouredFaceCount,
    })),
    faceColours: drain<RawFaceColour>(r.faceColours).map((c) => ({
      has: c.has,
      r: c.r,
      g: c.g,
      b: c.b,
    })),
  };
  drain<number>(r.openBodyIds);
  mod.discardStaging();
  return report;
}

/** Exports a report's bodies and structure, returning a fresh byte copy. */
function exportReport(
  mod: RawModule,
  report: Report,
  edit: (nodes: RawInstance[]) => RawInstance[] = (n) => n,
): { bytes: Uint8Array; result: Record<string, any> } {
  const ids = new mod.BodyIdList() as RawVec<number>;
  for (let i = 0; i < report.bodyCount; i += 1) ids.push_back(report.firstBodyId + i);
  const instances = new mod.StepInstanceList() as RawVec<RawInstance>;
  for (const n of edit(report.instances)) instances.push_back(n);
  const placements = new mod.PlacementList() as RawVec<number>;
  for (const v of report.placements) placements.push_back(v);
  const parts = new mod.StepPartList() as RawVec<RawPart>;
  for (const q of report.parts) parts.push_back(q);
  const faceColours = new mod.StepFaceColourList() as RawVec<RawFaceColour>;
  for (const c of report.faceColours) faceColours.push_back(c);

  let result: Record<string, any>;
  try {
    result = mod.exportStep(
      ids,
      { instances, placements, parts, faceColours },
      { shapeProcessing: false, structure: false },
    );
  } finally {
    ids.delete();
    instances.delete();
    placements.delete();
    parts.delete();
    faceColours.delete();
  }
  assert.equal(result.status, 0, result.message);
  // Copied out before the next staging call moves it.
  const bytes = new Uint8Array(
    new Uint8Array(mod.HEAPU8.buffer, result.dataPtr, result.byteLength),
  );
  const copy = { ...result };
  mod.discardStaging();
  return { bytes, result: copy };
}

function release(mod: RawModule, report: Report): void {
  for (let i = 0; i < report.bodyCount; i += 1) mod.releaseBody(report.firstBodyId + i);
}

const near = (a: number, b: number, tol = 1e-4): boolean => Math.abs(a - b) <= tol;

// --- Structure ---------------------------------------------------------------

test('a flat import is still exactly what it was', { skip }, async () => {
  const mod = await rawModule();
  const flat = importBytes(mod, readAssemblyFixture(), FLAT);

  assert.equal(flat.bodyCount, ASSEMBLY_FIXTURE.placedInstanceCount);
  assert.equal(flat.instances.length, 0, 'no tree');
  // The pair says "you did not ask", which is a different answer from "the file
  // had none" and has to stay distinguishable.
  assert.equal(flat.structureRequested, false);
  assert.equal(flat.structurePresent, false);

  release(mod, flat);
});

test('an assembly imports as one part and a tree of occurrences', { skip }, async () => {
  const mod = await rawModule();
  const r = importBytes(mod, readAssemblyFixture());

  assert.equal(r.bodyCount, ASSEMBLY_FIXTURE.partCount, 'the shared part is registered once');
  assert.equal(r.instances.length, ASSEMBLY_FIXTURE.nodeCount);
  assert.equal(r.treeDepth, ASSEMBLY_FIXTURE.treeDepth);
  assert.equal(r.groupingNodeCount, ASSEMBLY_FIXTURE.groupingNodeCount);
  assert.equal(r.structurePresent, true);
  assert.equal(
    r.instances.filter((n) => n.part >= 0).length,
    ASSEMBLY_FIXTURE.placedInstanceCount,
  );

  // Parents before children, which is what lets a consumer build the tree in one
  // pass and is also what makes a cycle unrepresentable.
  r.instances.forEach((n, i) => {
    assert.ok(n.parent < i, `instance ${i} has parent ${n.parent}`);
  });

  assert.equal(r.placements.length, r.instances.length * 12);

  const names = r.instances.map((n) => n.name);
  assert.deepEqual(names, [
    ASSEMBLY_FIXTURE.readerNames.root,
    ...ASSEMBLY_FIXTURE.readerNames.occurrences,
  ]);
  assert.equal(r.parts[0]?.name, ASSEMBLY_FIXTURE.readerNames.part);

  release(mod, r);
});

test('a placement is parent-relative, and composes to the fixture', { skip }, async () => {
  const mod = await rawModule();
  const r = importBytes(mod, readAssemblyFixture());

  // The last node is the rotated bracket. Its own placement carries no Z lift;
  // the lift lives on its parent, and composing the two gives what the fixture
  // predicts in world space. Asserting only the leaf would pass for a reader
  // that had lost the tree entirely.
  const local = r.placements.slice((r.instances.length - 1) * 12);
  ASSEMBLY_FIXTURE.secondOccurrenceLocalPlacement.forEach((expected, i) => {
    assert.ok(near(local[i] ?? NaN, expected, 1e-12), `local[${i}] = ${local[i]}`);
  });

  const parentIndex = r.instances[r.instances.length - 1]?.parent ?? -1;
  assert.ok(parentIndex >= 0);
  const parentZ = r.placements[parentIndex * 12 + 11] ?? 0;
  const worldZ = (local[11] ?? 0) + parentZ;
  assert.ok(
    near(worldZ, ASSEMBLY_FIXTURE.secondOccurrenceWorldPlacement[11] ?? 0, 1e-12),
    `composed Z ${worldZ}`,
  );

  release(mod, r);
});

test('a file with no product structure invents no tree', { skip }, async () => {
  const mod = await rawModule();
  // A single-part export of our own, which is the shortest route to a STEP file
  // with no assembly in it that does not depend on a fetched fixture.
  const box = mod.createBox({
    width: 10, depth: 10, height: 10,
    originX: 0, originY: 0, originZ: 0,
    axisX: 0, axisY: 0, axisZ: 1, angle: 0,
  });
  assert.equal(box.status, 0, box.message);

  const ids = new mod.BodyIdList() as RawVec<number>;
  ids.push_back(box.bodyId);
  const empty = {
    instances: new mod.StepInstanceList() as RawVec<RawInstance>,
    placements: new mod.PlacementList() as RawVec<number>,
    parts: new mod.StepPartList() as RawVec<RawPart>,
    faceColours: new mod.StepFaceColourList() as RawVec<RawFaceColour>,
  };
  let bytes: Uint8Array;
  try {
    const out = mod.exportStep(ids, empty, FLAT);
    assert.equal(out.status, 0, out.message);
    assert.equal(out.assemblyMode, 'off', 'the flat path states its mode');
    assert.equal(out.wroteStructure, false);
    bytes = new Uint8Array(new Uint8Array(mod.HEAPU8.buffer, out.dataPtr, out.byteLength));
  } finally {
    ids.delete();
    empty.instances.delete();
    empty.placements.delete();
    empty.parts.delete();
    empty.faceColours.delete();
  }
  mod.discardStaging();
  mod.releaseBody(box.bodyId);

  const r = importBytes(mod, bytes);
  assert.equal(r.structureRequested, true, 'structure WAS asked for');
  assert.equal(r.structurePresent, false, 'and the file had none');
  assert.equal(r.instances.length, 0);
  assert.equal(r.bodyCount, 1);
  release(mod, r);
});

// --- Appearance ---------------------------------------------------------------

test('colour arrives as the sRGB the file declared', { skip }, async () => {
  const mod = await rawModule();
  const r = importBytes(mod, readAssemblyFixture());
  const part = r.parts[0];
  assert.ok(part !== undefined);

  // Linear would be about [0.0331, 0.1329, 0.6038]. The tolerance is far tighter
  // than that gap, so this fails loudly if the conversion is ever dropped.
  assert.ok(part.hasColour);
  const [pr, pg, pb] = ASSEMBLY_FIXTURE.colours.part;
  assert.ok(near(part.colourR, pr ?? 0), `red ${part.colourR}`);
  assert.ok(near(part.colourG, pg ?? 0), `green ${part.colourG}`);
  assert.ok(near(part.colourB, pb ?? 0), `blue ${part.colourB}`);

  assert.equal(r.colouredFaceCount, 1);
  assert.equal(r.faceColours.length, part.faceCount, 'the block is dense over the faces');
  const index = r.faceColours.findIndex((c) => c.has);
  assert.equal(index, ASSEMBLY_FIXTURE.readerFaceColourIndex);
  const face = r.faceColours[index];
  assert.ok(face !== undefined);
  const [fr, fg, fb] = ASSEMBLY_FIXTURE.colours.face;
  assert.ok(near(face.r, fr ?? 0) && near(face.g, fg ?? 0) && near(face.b, fb ?? 0));

  // The failure this guards against is the resolving accessor: asked the wrong
  // way, every occurrence of a coloured part reports an override it never had.
  assert.equal(
    r.colouredInstanceCount,
    0,
    'no occurrence may claim a colour the file did not give it',
  );

  release(mod, r);
});

test('face ranges tile the index buffer, and survive the mesh cache', { skip }, async () => {
  const mod = await rawModule();
  const r = importBytes(mod, readAssemblyFixture());
  const bodyId = r.firstBodyId;

  const mesh = mod.tessellate(bodyId, { linearDeflection: 0.1, angularDeflection: 0.35 });
  assert.equal(mesh.status, 0, mesh.message);
  assert.equal(mesh.faceRangeCount, r.parts[0]?.faceCount, 'one range per face');
  assert.equal(mesh.faceRangeCount, mod.bodyInfo(bodyId).faceCount);

  const ranges = Array.from(
    new Uint32Array(mod.HEAPU32.buffer, mesh.faceRangesPtr, mesh.faceRangeCount * 2),
  );
  let covered = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    assert.equal(ranges[i], covered, `range ${i / 2} starts in the wrong place`);
    covered += ranges[i + 1] ?? 0;
  }
  assert.equal(covered, mesh.triangleCount * 3, 'the ranges cover every index');

  const again = mod.tessellate(bodyId, { linearDeflection: 0.1, angularDeflection: 0.35 });
  assert.equal(again.fromCache, true);
  assert.equal(again.faceRangeCount, mesh.faceRangeCount, 'a cache hit serves them too');

  release(mod, r);
});

test('an edit produces a new body whose face count is its own', { skip }, async () => {
  const mod = await rawModule();
  const r = importBytes(mod, readAssemblyFixture());
  const part = r.parts[0];
  assert.ok(part !== undefined);

  // Through the middle of the part in ITS OWN coordinates: a part shape is
  // unplaced, and reaching for where the occurrence appears drills thin air.
  const cutter = mod.createCylinder({
    radius: 2, height: 40,
    originX: 5, originY: 5, originZ: -10,
    axisX: 0, axisY: 0, axisZ: 1,
  });
  assert.equal(cutter.status, 0, cutter.message);
  const cut = mod.booleanOp(r.firstBodyId, cutter.bodyId, 1);
  assert.equal(cut.status, 0, cut.message);

  // The whole of the face-colour invalidation argument: there is no point where
  // a new shape replaces an old one, so there is no map to carry forward. The
  // face count is the backstop for a caller that tries anyway.
  assert.notEqual(cut.bodyId, r.firstBodyId);
  assert.notEqual(mod.bodyInfo(cut.bodyId).faceCount, part.faceCount);

  mod.releaseBody(cutter.bodyId);
  mod.releaseBody(cut.bodyId);
  release(mod, r);
});

// --- Export --------------------------------------------------------------------

test('an assembly survives export and re-import intact', { skip }, async () => {
  const mod = await rawModule();
  const before = importBytes(mod, readAssemblyFixture());
  const { bytes, result } = exportReport(mod, before);

  assert.equal(result.assemblyMode, 'document');
  assert.equal(result.wroteStructure, true);
  assert.equal(result.fabricatedNodeCount, 0, 'the export invents no node');

  const after = importBytes(mod, bytes);

  assert.equal(after.bodyCount, before.bodyCount);
  assert.equal(after.instances.length, before.instances.length);
  assert.equal(after.treeDepth, before.treeDepth);
  assert.equal(after.groupingNodeCount, before.groupingNodeCount);

  // By value, not by count. A count said four names out and four back while the
  // root's had silently become one OCCT generated.
  assert.deepEqual(
    after.instances.map((n) => n.name),
    before.instances.map((n) => n.name),
  );
  assert.deepEqual(
    after.parts.map((q) => q.name),
    before.parts.map((q) => q.name),
  );

  assert.equal(after.colouredPartCount, before.colouredPartCount);
  assert.equal(after.colouredFaceCount, before.colouredFaceCount);
  assert.equal(
    after.faceColours.findIndex((c) => c.has),
    before.faceColours.findIndex((c) => c.has),
    'the face colour lands on the same face position',
  );

  before.placements.forEach((v, i) => {
    assert.ok(near(after.placements[i] ?? NaN, v, 1e-9), `placement ${i}`);
  });

  release(mod, before);
  release(mod, after);
});

test('an occurrence colour round trips onto that occurrence alone', { skip }, async () => {
  const mod = await rawModule();
  const before = importBytes(mod, readAssemblyFixture());
  const target = ASSEMBLY_FIXTURE.readerNames.occurrences.at(-1);

  const { bytes, result } = exportReport(mod, before, (nodes) =>
    nodes.map((n) =>
      n.name === target
        ? { ...n, hasColour: true, colourR: 0.85, colourG: 0.1, colourB: 0.1 }
        : n,
    ),
  );
  assert.equal(result.colouredInstanceCount, 1);

  const after = importBytes(mod, bytes);
  const overridden = after.instances.filter((n) => n.hasColour);
  assert.equal(overridden.length, 1, 'exactly one, not one per occurrence of the part');
  assert.equal(overridden[0]?.name, target);
  assert.ok(near(overridden[0]?.colourR ?? 0, 0.85, 1e-3));
  assert.ok(near(overridden[0]?.colourG ?? 0, 0.1, 1e-3));
  assert.ok(near(overridden[0]?.colourB ?? 0, 0.1, 1e-3));

  // And the part's own colour is untouched by an occurrence carrying one.
  assert.equal(after.colouredPartCount, before.colouredPartCount);

  release(mod, before);
  release(mod, after);
});

test('a structure that does not resolve is refused, naming the defect', { skip }, async () => {
  const mod = await rawModule();
  const box = mod.createBox({
    width: 10, depth: 10, height: 10,
    originX: 0, originY: 0, originZ: 0,
    axisX: 0, axisY: 0, axisZ: 1, angle: 0,
  });
  assert.equal(box.status, 0, box.message);

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const node = (over: Partial<RawInstance> = {}): RawInstance => ({
    parent: -1, part: 0, name: 'n',
    hasColour: false, colourR: 0, colourG: 0, colourB: 0,
    ...over,
  });
  const part = (over: Partial<RawPart> = {}): RawPart => ({
    name: 'p', hasColour: false, colourR: 0, colourG: 0, colourB: 0,
    faceCount: 6, faceColourStart: 0, colouredFaceCount: 0,
    ...over,
  });

  const cases: [string, RawInstance[], number[], RawPart[], RegExp][] = [
    ['a body outside the set', [node({ part: 7 })], identity, [part()], /not in the exported set/],
    [
      'a parent that does not precede its child',
      [node({ parent: 1 }), node({ parent: -1 })],
      [...identity, ...identity],
      [part()],
      /does not precede it/,
    ],
    ['a node that is its own parent', [node({ parent: 0 })], identity, [part()], /does not precede it/],
    ['a placement that is not 12 numbers', [node()], [1, 0, 0], [part()], /placement values/],
    [
      'a placement that is not finite',
      [node()],
      [Number.NaN, ...identity.slice(1)],
      [part()],
      /not a finite number/,
    ],
    ['more parts than bodies', [node()], identity, [part(), part()], /parts for 1 bodies/],
    [
      'a face-colour block past the end',
      [node()],
      identity,
      [part({ colouredFaceCount: 1, faceColourStart: 5 })],
      /past the end/,
    ],
  ];

  for (const [what, nodes, places, parts, expected] of cases) {
    const ids = new mod.BodyIdList() as RawVec<number>;
    ids.push_back(box.bodyId);
    const iv = new mod.StepInstanceList() as RawVec<RawInstance>;
    for (const n of nodes) iv.push_back(n);
    const pv = new mod.PlacementList() as RawVec<number>;
    for (const v of places) pv.push_back(v);
    const qv = new mod.StepPartList() as RawVec<RawPart>;
    for (const q of parts) qv.push_back(q);
    const fv = new mod.StepFaceColourList() as RawVec<RawFaceColour>;

    try {
      const res = mod.exportStep(
        ids,
        { instances: iv, placements: pv, parts: qv, faceColours: fv },
        FLAT,
      );
      // InvalidParameter, not a translation failure: the caller built this.
      assert.equal(res.status, 2, `${what}: status ${res.status} (${res.message})`);
      assert.match(res.message, expected, what);
      assert.equal(res.byteLength, 0, `${what}: produced a payload anyway`);
    } finally {
      ids.delete();
      iv.delete();
      pv.delete();
      qv.delete();
      fv.delete();
    }
  }

  mod.releaseBody(box.bodyId);
});

test('no translation leaves a scratch document open', { skip }, async () => {
  const mod = await rawModule();
  const fixture = readAssemblyFixture();

  // A delta rather than an absolute. The module is shared across this file, so
  // asserting zero here would turn any earlier failure that left a body behind
  // into a second failure pointing at the wrong thing - which is exactly what
  // it did the first time these tests were made to fail on purpose.
  const liveBefore = mod.stats().liveBodyCount;

  // The instrument this replaced was peak heap, which reported the identical
  // figure with the document close removed - a few leaked small documents fit
  // inside a heap that has already grown. The count catches it immediately.
  const bad: Uint8Array[] = [
    new TextEncoder().encode('this is not a STEP file\n'),
    fixture.slice(0, Math.floor(fixture.length / 2)),
  ];
  for (const bytes of bad) {
    const r = importBytes(mod, bytes);
    assert.notEqual(r.status, 0);
    assert.equal(mod.stats().openTranslationDocuments, 0);
  }

  for (let i = 0; i < 6; i += 1) {
    const r = importBytes(mod, readAssemblyFixture());
    const { bytes } = exportReport(mod, r);
    assert.ok(bytes.length > 0);
    release(mod, r);
    assert.equal(mod.stats().openTranslationDocuments, 0, `after round trip ${i}`);
  }
  assert.equal(mod.stats().liveBodyCount, liveBefore, 'a round trip leaked a body');
});

// --- The pinned third-party assembly -------------------------------------------

test(
  'a third-party assembly round trips with its structure and colours',
  { skip: skip || thirdPartyAssemblySkip() },
  async () => {
    const mod = await rawModule();
    const before = importBytes(mod, readThirdPartyAssembly());
    const { bytes, result } = exportReport(mod, before);
    assert.equal(result.fabricatedNodeCount, 0);

    const after = importBytes(mod, bytes);

    assert.equal(after.bodyCount, before.bodyCount);
    assert.equal(after.instances.length, before.instances.length);
    assert.equal(after.treeDepth, before.treeDepth);
    assert.deepEqual(
      after.parts.map((q) => q.name),
      before.parts.map((q) => q.name),
    );
    assert.deepEqual(
      after.instances.map((n) => n.name),
      before.instances.map((n) => n.name),
    );
    assert.equal(after.colouredPartCount, before.colouredPartCount);
    before.placements.forEach((v, i) => {
      assert.ok(near(after.placements[i] ?? NaN, v, 1e-6), `placement ${i}`);
    });

    release(mod, before);
    release(mod, after);
  },
);

test(
  'instancing registers far fewer bodies than flattening',
  { skip: skip || thirdPartyAssemblySkip() },
  async () => {
    const mod = await rawModule();
    const flat = importBytes(mod, readThirdPartyAssembly(), FLAT);
    const tree = importBytes(mod, readThirdPartyAssembly());

    // The file itself settles this: it holds exactly `distinctPartCount`
    // MANIFOLD_SOLID_BREPs and places them `flattenedBodyCount` times, so these
    // are checks against the source rather than against our own reader.
    assert.equal(flat.bodyCount, THIRD_PARTY_ASSEMBLY.flattenedBodyCount);
    assert.equal(tree.bodyCount, THIRD_PARTY_ASSEMBLY.distinctPartCount);
    assert.equal(
      tree.instances.filter((n) => n.part >= 0).length,
      THIRD_PARTY_ASSEMBLY.flattenedBodyCount,
      'one placed node per body a flattening reader would have made',
    );

    release(mod, flat);
    release(mod, tree);
  },
);
