// Where recovery time goes, recorded so it can be read back.
//
// `performance.measure` rather than a bespoke timing object, for three reasons:
// the entries survive in the browser's own buffer and can be read after a
// reload by anything holding `performance`, they show up in a DevTools profile
// next to the frames they explain, and they cost nothing when nobody looks.
//
// None of this is dev-only. A phase breakdown of "why did reopening this
// document take two seconds" is as useful in production as it is in a
// verification run, and the alternative - instrumenting only the harness - would
// measure a code path the user never runs.

const PREFIX = 'webcad:';

/**
 * The phases recovery is reported in.
 *
 * Kernel readiness is separate from everything else on purpose: it is
 * WebAssembly startup, which the Worker stage already paid for, and folding it
 * into a document total would make the document layer look expensive.
 */
export const RECOVERY_PHASES = {
  /** Time origin to a ready kernel: WASM load and OCCT init, not document work. */
  kernelReady: `${PREFIX}kernel-ready`,
  /** Reading the document's parts out of storage. */
  documentRead: `${PREFIX}doc-read`,
  /** Validating the container and restoring the checkpoint into the kernel. */
  geometryRestore: `${PREFIX}doc-restore`,
  /** Re-tessellating the restored bodies and handing the meshes to the GPU. */
  tessellate: `${PREFIX}doc-tessellate`,
  /** Upload to the animation frame that draws it. */
  firstFrame: `${PREFIX}first-frame`,
  /** Time origin to geometry on screen. */
  total: `${PREFIX}recovered`,
} as const;

/**
 * Records a measure spanning `startMs` to now.
 *
 * `startMs` is a `performance.now()` reading, so 0 means the time origin - which
 * is how the phases that start at page load are recorded.
 */
export function measureSince(name: string, startMs: number): void {
  try {
    performance.measure(name, { start: startMs, end: performance.now() });
  } catch {
    // Telemetry must never be able to fail the operation it is describing. An
    // exhausted entry buffer or a `performance` without `measure` costs a
    // number, not a document.
  }
}

/** Times an async phase, leaving a measure behind even if it throws. */
export async function timePhase<T>(name: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    measureSince(name, start);
  }
}

/**
 * Waits for the next animation frame, or gives up.
 *
 * Returns whether a frame actually arrived. The caller has to be able to tell:
 * a headless browser composites lazily and can go a long time without one, and
 * reporting an unmeasured phase as zero - or blocking startup forever waiting
 * for it - would both be worse than saying so.
 */
export function nextAnimationFrame(timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (drew: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(drew);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      finish(true);
    });
  });
}
