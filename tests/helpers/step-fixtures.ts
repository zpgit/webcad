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
