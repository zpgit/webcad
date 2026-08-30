import { Kernel } from '../../src/kernel/kernel.ts';
import type { BodyId, MeshBuffers } from '../../src/kernel/types.ts';
import { InProcessTransport } from '../../src/kernel/worker/transport.ts';
import { loadEmscriptenModule, skipUnlessBuilt } from './load-wasm.ts';

export const KERNEL_ARTIFACT = 'src/kernel/wasm/webcad_kernel.mjs';

/** node:test `skip` reason when the kernel has not been built yet. */
export const kernelSkip = skipUnlessBuilt(KERNEL_ARTIFACT, 'npm run kernel:build');

const liveKernels: Kernel[] = [];

/**
 * A freshly initialized kernel backed by the built artifact.
 *
 * Each call instantiates a new WASM module, so handle numbering and statistics
 * start clean and tests cannot leak state into each other.
 *
 * Explicitly in-process rather than relying on the default: Node has no DOM
 * `Worker`, and the point is to exercise the same request handler the Worker
 * runs. What this path cannot catch is a serialization bug, which is why
 * `npm run verify:browser` is the authority on the boundary itself.
 *
 * Every kernel handed out here is tracked so a file can release them between
 * tests - see `disposeKernels`. A file that creates many and releases none will
 * eventually stop working, not gradually get slower.
 */
export async function makeKernel(): Promise<Kernel> {
  const kernel = await Kernel.create({
    transport: new InProcessTransport(() => loadEmscriptenModule(KERNEL_ARTIFACT)),
  });
  liveKernels.push(kernel);
  return kernel;
}

/**
 * Releases every kernel `makeKernel` has handed out. Register as `afterEach`.
 *
 * Necessary rather than tidy. A kernel holds a WASM module - a 12 MB code image
 * plus its heap - and nothing collects it while the module object is reachable,
 * so a file with twenty tests accumulates twenty modules for the life of the
 * process. That is what this suite did until a file crossed the line and simply
 * stopped: no error, no crash, just a test that never returned while the
 * process thrashed. Disposing drops the module reference
 * (`src/kernel/worker/handler.ts:105`) and lets the memory go.
 *
 * Idempotent, and safe for a test that disposed its own kernel.
 */
export function disposeKernels(): void {
  while (liveKernels.length > 0) liveKernels.pop()?.dispose();
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
export function maxCylindricalDeviation(mesh: MeshBuffers, radius: number): number {
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

/**
 * The axis-aligned bounds of a tessellated mesh.
 *
 * Where a body's placement is the thing under test, this is the observable: the
 * kernel reports volume and counts but no bounding box, and a mesh's extent is a
 * direct consequence of the transform that placed it. Tolerant by argument
 * rather than by default, because a placement authored from exact values should
 * be asserted exactly.
 */
export function meshBounds(mesh: MeshBuffers): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    for (let axis = 0; axis < 3; axis++) {
      const c = mesh.positions[3 * v + axis] ?? 0;
      if (c < (min[axis] ?? Infinity)) min[axis] = c;
      if (c > (max[axis] ?? -Infinity)) max[axis] = c;
    }
  }
  return { min, max };
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
