import type { BodyId } from '../kernel/types.ts';
import type { ModelingSession } from './modeling-session.ts';

/**
 * Scripted scene setup.
 *
 * MVP-0 has no persistence, so every session starts from nothing. That makes
 * manual verification tedious and creates pressure to add ad-hoc saving - which
 * would prejudge MVP-1's document design. A scripted scene relieves the pressure
 * without inventing a file format.
 */
export async function buildDemoScene(
  session: ModelingSession,
): Promise<BodyId[]> {
  const box = await session.createBox({
    width: 60,
    depth: 40,
    height: 25,
    origin: [-30, -20, 0],
  });

  // Positioned to pass clean through the box, so a subtract yields the
  // canonical drilled-hole case.
  const cylinder = await session.createCylinder({
    radius: 12,
    height: 60,
    origin: [0, 0, -15],
    axis: [0, 0, 1],
  });

  return [box, cylinder];
}
