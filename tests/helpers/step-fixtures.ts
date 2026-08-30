// Locating the STEP files these tests translate.
//
// The fixtures are OCCT's own test data under `third_party/occt/`, which is
// gitignored: it arrives via `npm run fixtures:fetch` (two files) or as part of
// the full source clone `npm run kernel:fetch` does, and is never committed. So
// a suite here cannot assume its inputs exist, and the interesting question is
// what it does when they do not.
//
// It skips, loudly, naming the fixture and how to get it. Not passes: a suite
// that silently reports success without having read a byte is worse than one
// that fails, because "the round trip is fine" and "the round trip was never
// tried" then look identical in the output. Nor fails: a missing gitignored
// fixture is a checkout that has not fetched OCCT, which is not a defect in the
// code under test.
//
// Using a third party's files rather than ones we wrote is the point. Our own
// writer producing something our own reader accepts proves very little about
// interoperability; these were authored by neither.
//
// One fixture here IS ours, and is committed: `assembly.step`, below. It exists
// because no third-party file available to this project contains an assembly or
// a colour, and because a hand-authored file can be asserted against exactly.
// The two kinds do not substitute for each other and are not treated as if they
// did - see the comment on `ASSEMBLY_FIXTURE`.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '../..');

export const STEP_FIXTURE_DIR = 'third_party/occt/data/step';

/**
 * The two fixtures available locally, smallest first.
 *
 * Both are single parts. `linkrods` sounds like an assembly and is 1.79 MB, but
 * it holds one MANIFOLD_SOLID_BREP under one SHAPE_REPRESENTATION with no
 * NEXT_ASSEMBLY_USAGE_OCCURRENCE anywhere; the word "Assembly" in it is the
 * MECHANICAL_CONTEXT discipline string. Neither carries a COLOUR_RGB either.
 * They differ in size and surface mix, not in structure - so nothing here
 * exercises assembly structure, part naming or colour, and OCCT's repository
 * ships no third-party STEP file that would.
 */
export const STEP_FIXTURES = {
  screw: `${STEP_FIXTURE_DIR}/screw.step`,
  linkrods: `${STEP_FIXTURE_DIR}/linkrods.step`,
} as const;

export type StepFixtureName = keyof typeof STEP_FIXTURES;

export function stepFixturePath(name: StepFixtureName): string {
  return path.resolve(repoRoot, STEP_FIXTURES[name]);
}

export function hasStepFixture(name: StepFixtureName): boolean {
  return existsSync(stepFixturePath(name));
}

/** Reason string for node:test's `skip`, or false when the fixture is present. */
export function stepFixtureSkip(name: StepFixtureName): string | false {
  return hasStepFixture(name)
    ? false
    : `missing ${STEP_FIXTURES[name]} - run \`npm run fixtures:fetch\` ` +
        '(OCCT test data is gitignored and not committed)';
}

/**
 * A fixture's bytes, freshly read each time.
 *
 * Fresh rather than cached on purpose: importing transfers the buffer into the
 * kernel and detaches it, so a shared copy would work once and then throw. This
 * is the same trap the kernel API documents for callers, and a helper that
 * papered over it would let tests pass while the real usage failed.
 */
export function readStepFixture(name: StepFixtureName): Uint8Array {
  return new Uint8Array(readFileSync(stepFixturePath(name)));
}

export function stepFixtureBytes(name: StepFixtureName): number {
  return statSync(stepFixturePath(name)).size;
}

// --- The committed assembly fixture ------------------------------------------

export const COMMITTED_FIXTURE_DIR = 'tests/fixtures';

/**
 * A hand-authored AP214 assembly, committed rather than fetched.
 *
 * What it is for: asserting exactly. Every number below is a property this
 * project wrote into the file deliberately, so a test can check the reader
 * against a stated expectation instead of against whatever the reader reports.
 * OCCT's own test data cannot serve here - neither of its STEP files contains
 * assembly structure or a colour.
 *
 * What it is NOT for: interoperability. Our reader reading a file we wrote says
 * nothing about reading a file from another CAD system, and this file was built
 * on top of geometry our own writer produced. That claim needs a third-party
 * assembly, and where none is available it is reported as not exercised.
 *
 * The structure, the placements, and the colours are hand-written entity by
 * entity. The leaf geometry - one 10 mm box - is not: it came from OCCT's writer,
 * because hand-authoring a manifold solid B-rep would risk an invalid closed
 * shell for no gain to what this fixture tests.
 *
 *   carrier                         root, no shape of its own
 *     +-- cradle                    at (0, 0, 5); grouping node, no shape
 *           +-- bracket #1          at (20, 0, 0)
 *           +-- bracket #2          at (-20, 0, 0), rotated about Z
 *
 * Both brackets are occurrences of ONE part: the box geometry appears once in
 * the file and is referenced twice.
 */
export const ASSEMBLY_FIXTURE = {
  path: `${COMMITTED_FIXTURE_DIR}/assembly.step`,

  /** Distinct products: `carrier`, `cradle`, `bracket`. */
  namedProductCount: 3,
  /** `NEXT_ASSEMBLY_USAGE_OCCURRENCE` count: cradle in carrier, bracket twice. */
  assemblyNodeCount: 3,
  /** `STYLED_ITEM` count: the whole part, and one of its faces. */
  styledItemCount: 2,

  /**
   * Every node in the tree, the root included.
   *
   * Two of these numbers were wrong in the first draft of this helper and are
   * corrected against the file rather than against what a reader reports. It
   * holds three PRODUCTs, three NEXT_ASSEMBLY_USAGE_OCCURRENCEs and exactly one
   * MANIFOLD_SOLID_BREP, so: four nodes, two of which place the single part.
   * The draft said two nodes - counting only the occurrences of the part - and
   * one grouping node, having forgotten that `carrier` is one as much as
   * `cradle` is.
   */
  nodeCount: 4,
  /** Nodes that place the part: `bracket-1` and `bracket-2`. */
  placedInstanceCount: 2,
  /** `carrier` and `cradle`: children, no geometry of their own. */
  groupingNodeCount: 2,
  /** carrier -> cradle -> bracket. */
  treeDepth: 3,
  /** One MANIFOLD_SOLID_BREP, so one body however many times it is placed. */
  partCount: 1,

  /** The one part, as authored: a 10 mm box. */
  part: {
    name: 'bracket',
    faceCount: 6,
    solidCount: 1,
    volume: 1000,
  },

  /**
   * Colours in the file, as sRGB in 0..1.
   *
   * sRGB is now stated rather than implied, because the two readings differ and
   * one of them is wrong. OCCT decodes a STEP `COLOUR_RGB` as sRGB and stores
   * it converted to linear, so `Quantity_Color::Red()` hands back 0.0331 where
   * the file said 0.2. These are the file's numbers, and the kernel converts
   * back on the way out to return them.
   *
   * `face` is on the second `ADVANCED_FACE` of the part's closed shell.
   */
  colours: {
    part: [0.2, 0.4, 0.8],
    face: [0.9, 0.6, 0.1],
  },

  /**
   * Where the coloured face lands in exploration order: index 1 of 6.
   *
   * An observation about OCCT's traversal, not a property of the file, and
   * separated from `colours` above for that reason. Recorded rather than left
   * unstated because a per-face colour is keyed positionally, so this index is
   * the one number a face-colour test has to agree with - and because a change
   * in it between OCCT versions is exactly the silent breakage the positional
   * key risks. Task 1.2 established that the order survives a checkpoint; this
   * pins where in that order the colour sits.
   */
  readerFaceColourIndex: 1,

  /**
   * An occurrence-level colour override is still NOT in this file.
   *
   * Task 2.1a deferred it to group 5 "against a reader that can verify it".
   * There is now such a reader, and it still cannot verify one, so authoring
   * the entities would repeat the mistake 2.1a avoided.
   *
   * What was learned trying. AP214 expresses the override as a
   * `CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM`, which OCCT routes into a SHUO
   * rather than onto the component's label. A hand-authored one parses - the
   * entity census counts it - and produces no instance colour, and from outside
   * the library there is no way to tell whether the authoring or the reader is
   * at fault. No file available to this project settles it either: a grep for
   * `OVER_RIDING` across every local STEP fixture, including all four published
   * variants of AS1, finds nothing.
   *
   * So it waits for group 6, where `STEPCAFControl_Writer` can write a document
   * with an instance colour set and re-importing our own export answers the
   * question outright. If OCCT's own writer and reader cannot round-trip one
   * between them, that is worth more than a hand-authoring guess.
   */
  hasOccurrenceColourOverride: false,

  /**
   * Where the two occurrences land in world space, as a bounding box.
   *
   * Exact, not approximate: the rotation uses a 3-4-5 direction (0.6, 0.8, 0) so
   * every coordinate is exact in binary. Composition is included - the cradle
   * lifts both brackets 5 mm in Z - which is what makes these usable as a check
   * on placement composition rather than only on a leaf transform.
   *
   * A structure-blind reader flattens the assembly to these two bodies, already
   * placed, which is why this can be asserted before any structure-aware reader
   * exists.
   */
  occurrenceBounds: [
    { min: [20, 0, 5], max: [30, 10, 15] },
    { min: [-28, 0, 5], max: [-14, 14, 15] },
  ],

  /**
   * The second occurrence's placement as a 3x4 row-major transform, which is
   * how a placement crosses the kernel boundary and how the document stores it.
   * Rotation about Z by cos 0.6 / sin 0.8.
   *
   * PARENT-RELATIVE, and the two forms are given separately because the
   * difference is a rule and not an accident. The kernel returns each
   * occurrence's transform relative to its parent, because composition needs
   * the tree and the kernel does not keep one; the document layer composes.
   * So `local` has no Z lift in it and `world` has the cradle's +5 mm - and a
   * test that checks composition has something to check it against rather than
   * one number that could be either.
   */
  secondOccurrenceLocalPlacement: [
    0.6, -0.8, 0, -20,
    0.8, 0.6, 0, 0,
    0, 0, 1, 0,
  ],
  secondOccurrenceWorldPlacement: [
    0.6, -0.8, 0, -20,
    0.8, 0.6, 0, 0,
    0, 0, 1, 5,
  ],

  /**
   * Names, as they come back rather than as the file spells them.
   *
   * Unlike every other number here this is an observation about OCCT's reader,
   * not a property this project wrote into the file, and it is marked as one.
   * The file names three products; the reader gives each OCCURRENCE a suffixed
   * name of its own - `bracket-1`, `bracket-2` - while the part keeps the bare
   * product name. That matters beyond cosmetics: it is the evidence that the
   * distinction between naming a part and naming one occurrence of it survives
   * translation, which the design assumed and could not confirm until a reader
   * existed to ask.
   */
  readerNames: {
    root: 'carrier',
    occurrences: ['cradle-1', 'bracket-1', 'bracket-2'],
    part: 'bracket',
  },
} as const;

export function assemblyFixturePath(): string {
  return path.resolve(repoRoot, ASSEMBLY_FIXTURE.path);
}

/** Fresh bytes each time, for the same reason `readStepFixture` is fresh. */
export function readAssemblyFixture(): Uint8Array {
  return new Uint8Array(readFileSync(assemblyFixturePath()));
}

// --- The pinned third-party assembly -----------------------------------------

export const PINNED_FIXTURE_DIR = 'third_party/step-fixtures';

/**
 * A real assembly, written by a system that is not ours.
 *
 * This is the only fixture available to this project that is both a genuine
 * assembly and genuinely foreign, and it is the only one any interoperability
 * claim can rest on. `assembly.step` above can be asserted more precisely but we
 * wrote it; OCCT's two files are foreign but are single parts with no colour.
 *
 * Provenance: the AS1 assembly from STEP Tools Inc's published AP214 sample set,
 * as written by MicroStation/J through ST-DEVELOPER in 1999. The variant is not
 * incidental - the same assembly is published as written by several CAD systems,
 * and the `-oc-` variant was written by OpenCascade, which is our own writer and
 * would prove nothing. Fetched by URL and sha256 (`scripts/fetch-step-fixtures.sh`),
 * never committed, never redistributed.
 *
 * Pinned as an **optional** fixture: it lives on someone else's host, so its
 * absence skips loudly rather than failing a build. Which means every claim that
 * depends on it has to survive being reported as not exercised.
 *
 * The counts below are asserted rather than discovered - the hash pins the bytes,
 * so a change in what our reader reports for this file is a change in our reader.
 */
export const THIRD_PARTY_ASSEMBLY = {
  path: `${PINNED_FIXTURE_DIR}/as1-md-214.stp`,
  bytes: 72_759,
  authoredBy: 'MicroStation/J via ST-DEVELOPER 1.6',

  /** `NEXT_ASSEMBLY_USAGE_OCCURRENCE` count. */
  assemblyNodeCount: 13,
  /** Distinct named products, root and subassemblies included. */
  namedProductCount: 9,
  /** `STYLED_ITEM` count; five of them carry an RGB colour. */
  styledItemCount: 5,

  /** What a structure-blind reader produces: every occurrence, flattened. */
  flattenedBodyCount: 18,

  /**
   * Distinct part geometries, counted as MANIFOLD_SOLID_BREP in the file.
   *
   * LBRACKET, BOLT, NUT, ROD, PLATE. The file stores each once and places them
   * eighteen times, so this against `flattenedBodyCount` is the whole case for
   * instancing stated by the file itself rather than by our reader: 5 bodies or
   * 18, for the same assembly.
   */
  distinctPartCount: 5,

  /**
   * Nodes in the tree once shared SUBASSEMBLIES are expanded.
   *
   * Larger than the 13 NEXT_ASSEMBLY_USAGE_OCCURRENCEs above, and the gap is
   * the point. The file stores structure as a DAG - `NBA` is one definition
   * used three times under each of two `LBA`s - while a tree has to give each
   * use its own node. So structure sharing is expanded and GEOMETRY sharing is
   * not: 28 nodes, still only 5 bodies. A representation that collapsed the
   * nodes too would have to make a node's identity depend on the path taken to
   * reach it, which is the positional-reference problem in another costume.
   */
  expandedNodeCount: 28,
  /** carrier -> LBA -> NBA -> BOLT. */
  treeDepth: 4,
  /** AS1, two LBAs, six NBAs, one RODAS. */
  groupingNodeCount: 10,

  /** Overall extent of the assembly as placed, in mm. */
  bounds: { min: [-100, -75, -7], max: [100, 75, 80] },
} as const;

export function thirdPartyAssemblyPath(): string {
  return path.resolve(repoRoot, THIRD_PARTY_ASSEMBLY.path);
}

/** Reason string for node:test's `skip`, or false when the fixture is present. */
export function thirdPartyAssemblySkip(): string | false {
  return existsSync(thirdPartyAssemblyPath())
    ? false
    : `missing ${THIRD_PARTY_ASSEMBLY.path} - run \`npm run fixtures:fetch\` ` +
        '(pinned third-party fixture, not committed; its host may be unreachable)';
}

export function readThirdPartyAssembly(): Uint8Array {
  return new Uint8Array(readFileSync(thirdPartyAssemblyPath()));
}
