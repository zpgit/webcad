import { Kernel } from '../../src/kernel/kernel.ts';
import type { BodyId, MeshViews } from '../../src/kernel/types.ts';
import { loadEmscriptenModule, skipUnlessBuilt } from './load-wasm.ts';

export const KERNEL_ARTIFACT = 'src/kernel/wasm/webcad_kernel.mjs';

/** node:test `skip` reason when the kernel has not been built yet. */
export const kernelSkip = skipUnlessBuilt(KERNEL_ARTIFACT, 'npm run kernel:build');

/**
 * A freshly initialized kernel backed by the built artifact.
 *
 * Each call instantiates a new WASM module, so handle numbering and statistics
 * start clean and tests cannot leak state into each other.
 */
export async function makeKernel(): Promise<Kernel> {
  return Kernel.create({
    loadModule: () => loadEmscriptenModule(KERNEL_ARTIFACT),
  });
}

/** Relative tolerance comparison for geometric quantities. */
export function closeTo(actual: number, expected: number, relative = 1e-6): boolean {
  const scale = Math.max(Math.abs(expected), 1e-9);
  return Math.abs(actual - expected) / scale <= relative;
}

/**
 * Maximum chord deviation of a tessellated cylindrical surface from the exact
 * cylinder of radius `radius` about the Z axis.
 *
 * Vertices generated on the lateral face lie exactly on the surface, so the
 * error lives between them: the midpoint of a chord spanning an angle d falls
 * short by radius * (1 - cos(d/2)). Measuring the worst such sagitta gives a
 * real deviation figure rather than a triangle count as a proxy for fidelity.
 */
export function maxCylindricalDeviation(mesh: MeshViews, radius: number): number {
  const radial = (i: number): number => {
    const x = mesh.positions[3 * i] ?? 0;
    const y = mesh.positions[3 * i + 1] ?? 0;
    return Math.hypot(x, y);
  };

  // Restricted to vertices whose normal is radial. The rim vertices of the end
  // caps also sit at radius r, and a cap is triangulated with chords running
  // clear across the circle - those would report a sagitta near r and swamp the
  // real lateral-surface error. Vertices are emitted per face, so the rim exists
  // twice: once with a radial normal (lateral face) and once with an axial one
  // (cap). Testing the normal keeps only the former.
  const isLateral = (i: number): boolean => {
    const nz = mesh.normals[3 * i + 2] ?? 0;
    return Math.abs(nz) < 0.1 && closeTo(radial(i), radius, 1e-4);
  };
  const onSurface = isLateral;

  let worst = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = [
      mesh.indices[t] ?? 0,
      mesh.indices[t + 1] ?? 0,
      mesh.indices[t + 2] ?? 0,
    ];
    for (let e = 0; e < 3; e++) {
      const a = tri[e] ?? 0;
      const b = tri[(e + 1) % 3] ?? 0;
      if (!onSurface(a) || !onSurface(b)) continue;

      const midX = ((mesh.positions[3 * a] ?? 0) + (mesh.positions[3 * b] ?? 0)) / 2;
      const midY =
        ((mesh.positions[3 * a + 1] ?? 0) + (mesh.positions[3 * b + 1] ?? 0)) / 2;
      const deviation = radius - Math.hypot(midX, midY);
      if (deviation > worst) worst = deviation;
    }
  }
  return worst;
}

/** Creates a box and a cylinder positioned to drill cleanly through it. */
export async function boxAndDrill(
  kernel: Kernel,
): Promise<{ box: BodyId; drill: BodyId; boxVolume: number }> {
  const box = await kernel.createBox({
    width: 60,
    depth: 40,
    height: 25,
    origin: [-30, -20, 0],
  });
  const drill = await kernel.createCylinder({
    radius: 10,
    height: 60,
    origin: [0, 0, -15],
    axis: [0, 0, 1],
  });
  return { box, drill, boxVolume: 60 * 40 * 25 };
}
