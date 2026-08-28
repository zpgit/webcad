// Locating the STEP files these tests translate.
//
// The fixtures are OCCT's own test data under `third_party/occt/`, which is
// gitignored: it arrives via `npm run kernel:fetch` and is never committed. So a
// suite here cannot assume its inputs exist, and the interesting question is
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
 * `screw` is a single part; `linkrods` is an assembly, which is what makes it
 * worth having - it exercises the flattening path and the dropped-structure
 * report, not just a bigger file.
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
    : `missing ${STEP_FIXTURES[name]} - run \`npm run kernel:fetch\` ` +
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
