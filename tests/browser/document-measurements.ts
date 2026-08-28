// What persistence costs, measured in a real browser.
//
// This is the module `scripts/verify-browser.mjs` loads to answer the three
// questions MVP-1 exists to answer with numbers: how fast exact B-Rep
// serializes and restores as a function of payload size, what IndexedDB and
// OPFS each cost for the same save and the same open, and whether any of it
// blocks the main thread.
//
// It lives here rather than inside the harness for the same reason the storage
// conformance suite does: it needs the real `Kernel`, the real document layer,
// and the real stores, it is typechecked with them, and a measurement that
// drove a stand-in would be measuring the stand-in. The harness supplies a
// browser and writes the artifact; everything that has to run next to the code
// under measurement runs here.
//
// Every body and every document this module creates is released and deleted
// before it returns. It runs in the middle of a verification session that has
// its own document, and must leave that session exactly as it found it.

import { buildParts, readDocument } from '../../src/document/document.ts';
import type { DocumentContent } from '../../src/document/document.ts';
import { bodyRefFor } from '../../src/document/types.ts';
import type { DocumentParts } from '../../src/document/types.ts';
import type { Kernel } from '../../src/kernel/kernel.ts';
import type { BodyId } from '../../src/kernel/types.ts';
import { openStore } from '../../src/storage/index.ts';
import type { DocumentStore, StorageBackend } from '../../src/storage/types.ts';

// --- Reported shapes ---------------------------------------------------------

export interface Timing {
  readonly iterations: number;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

export interface SerializationSample {
  readonly label: string;
  readonly bodyCount: number;
  readonly faceCount: number;
  readonly bytes: number;
  readonly format: string;
  readonly serialize: Timing;
  readonly restore: Timing;
  /** Payload bytes per millisecond, at the median. */
  readonly serializeKbPerMs: number;
  readonly restoreKbPerMs: number;
  /**
   * Kernel-side time from the operation log, as a median over the same
   * iterations. A median rather than one sample, so that subtracting it from the
   * round trip above gives the transport cost rather than the difference between
   * a median and whichever iteration happened to be last.
   */
  readonly kernelSerializeMs: number | null;
  readonly kernelRestoreMs: number | null;
}

export interface BackendSample {
  readonly backend: StorageBackend;
  readonly workload: string;
  readonly bytes: number;
  /** Writing every part of the document, atomically. */
  readonly save: Timing;
  /** Reading every part back out, without interpreting any of them. */
  readonly read: Timing;
  /** Read plus validate plus restore into the kernel: what opening costs. */
  readonly open: Timing;
  /** Listing documents, which must not scale with checkpoint size. */
  readonly list: Timing;
  readonly remove: Timing;
}

export interface StallSample {
  readonly label: string;
  readonly backend: StorageBackend | null;
  readonly bytes: number;
  /** How many times the operation ran inside the probe window. */
  readonly iterations: number;
  readonly wallMs: number;
  readonly worstStallMs: number;
  readonly medianStallMs: number;
  readonly samples: number;
}

export interface DocumentMeasurements {
  readonly occtVersion: string;
  readonly serialization: readonly SerializationSample[];
  readonly storage: readonly BackendSample[];
  readonly unavailableBackends: readonly { backend: StorageBackend; reason: string }[];
  readonly stalls: readonly StallSample[];
  readonly notes: readonly string[];
}

// --- Timing ------------------------------------------------------------------

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const round = (value: number, places = 3): number =>
  Number(value.toFixed(places));

/**
 * Runs `body` `iterations` times and reports the spread.
 *
 * The median rather than the mean, and the minimum alongside it: a browser
 * verification shares a machine with whatever else is running, and one
 * descheduled iteration should not become the reported cost. The maximum is kept
 * because a large gap between it and the median is itself worth seeing.
 */
async function repeat(
  iterations: number,
  body: (index: number) => Promise<void>,
): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    await body(i);
    samples.push(performance.now() - started);
  }
  return {
    iterations,
    medianMs: round(median(samples)),
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
  };
}

/**
 * Samples main-thread availability while an operation runs.
 *
 * A self-rescheduling `MessageChannel`, not `requestAnimationFrame` and not a
 * timer. A frame probe is out because a headless browser composites lazily and
 * fires almost no frames, so it cannot tell a free main thread from a blocked
 * one. A timer measured the right thing but is not portable: on the GitHub
 * runner it collected zero samples across a 417 ms window, because a page the
 * browser considers backgrounded has its timers aligned to about one a second.
 * A postMessage task is not a timer, so nothing clamps or aligns it. It ticks
 * as fast as the queue drains, which keeps the main thread busy - affordable
 * here, and paid equally by every probe including the idle baseline.
 *
 * The floor is sub-millisecond rather than the timer's 4-6 ms, so anything at
 * frame scale stands out further than it did.
 *
 * This is the same probe the Worker stage used on kernel operations, pointed at
 * persistence instead - the design note asks specifically whether saving
 * reintroduces the main-thread stall the Worker removed.
 *
 * `iterations` exists because a save is faster than the probe's own period: a
 * single 7 ms save yields no samples at all, which is not a passing
 * responsiveness result but an absent one. Running a burst inside one window
 * gives the probe something to sample without changing what it reports - the
 * worst gap is still the worst single stall, and a save that blocked the main
 * thread would block it once per iteration.
 */
async function during<T>(
  label: string,
  backend: StorageBackend | null,
  bytes: number,
  iterations: number,
  run: () => Promise<T>,
): Promise<{ sample: StallSample; value: T }> {
  const gaps: number[] = [];
  let last = performance.now();
  let running = true;

  const channel = new MessageChannel();
  channel.port1.onmessage = (): void => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (running) channel.port2.postMessage(0);
  };
  channel.port2.postMessage(0);

  const started = performance.now();
  const value = await run();
  const wallMs = performance.now() - started;
  running = false;
  channel.port1.close();
  channel.port2.close();

  // The first sample spans probe setup rather than the operation.
  const measured = gaps.slice(1);
  return {
    sample: {
      label,
      backend,
      bytes,
      iterations,
      wallMs: round(wallMs),
      // A reduce rather than `Math.max(0, ...measured)`: the probe now collects
      // samples by the hundred thousand, and spreading that many arguments
      // overflows the call stack.
      worstStallMs: round(
        measured.reduce((worst, gap) => (gap > worst ? gap : worst), 0),
      ),
      medianStallMs: round(median(measured)),
      samples: measured.length,
    },
    value,
  };
}

// --- Workloads ---------------------------------------------------------------

interface Workload {
  readonly label: string;
  readonly bodies: readonly BodyId[];
  readonly faceCount: number;
}

async function faceTotal(
  kernel: Kernel,
  bodies: readonly BodyId[],
): Promise<number> {
  let total = 0;
  for (const bodyId of bodies) total += (await kernel.bodyInfo(bodyId)).faceCount;
  return total;
}

async function releaseAll(kernel: Kernel, bodies: readonly BodyId[]): Promise<void> {
  for (const bodyId of bodies) {
    try {
      await kernel.release(bodyId);
    } catch {
      // Already consumed by an operation that took ownership; not the subject.
    }
  }
}

/** A box with `holes` cylinders drilled through it: faces without a curve fit. */
async function drilledPlate(kernel: Kernel, holes: number): Promise<BodyId> {
  const width = 40 + holes * 14;
  let plate = await kernel.createBox({ width, depth: 40, height: 10 });

  for (let i = 0; i < holes; i++) {
    const drill = await kernel.createCylinder({
      radius: 4,
      height: 30,
      origin: [-width / 2 + 20 + i * 14, 0, -10],
    });
    const outcome = await kernel.boolean('subtract', plate, drill);
    if (outcome.kind === 'empty') {
      throw new Error(`drilling hole ${i} removed the whole plate`);
    }
    await kernel.release(plate);
    await kernel.release(drill);
    plate = outcome.bodyId;
  }
  return plate;
}

/**
 * `count` independent copies of a body, made by restoring its checkpoint.
 *
 * Cheaper than re-modeling each one and exact by construction, which is what a
 * size ladder needs: the point is a bigger payload with more topology in it, not
 * a different shape.
 */
async function copiesOf(
  kernel: Kernel,
  source: BodyId,
  count: number,
): Promise<BodyId[]> {
  const master = (await kernel.serialize([source])).bytes;
  const bodies: BodyId[] = [];
  for (let i = 0; i < count; i++) {
    bodies.push(...(await kernel.restore(master.slice())));
  }
  return bodies;
}

interface Rung {
  readonly label: string;
  /** Capture this rung's container parts for the storage comparison. */
  readonly capture?: 'small' | 'large';
  /** Keep the bodies alive after measuring: the stall probe re-saves them. */
  readonly keepAlive?: boolean;
  readonly iterations: number;
  build(kernel: Kernel): Promise<readonly BodyId[]>;
}

/**
 * The size ladder.
 *
 * Chosen so throughput can be read as a function of payload size rather than
 * asserted from one point: a single primitive, the demo scene's drilled block, a
 * plate with real Boolean topology, and then that plate multiplied until the
 * checkpoint is a few hundred kilobytes. MVP-1 has no large models to offer -
 * that is stated in the findings as a limit rather than papered over with a
 * synthetic payload the kernel would never write.
 */
const RUNGS: readonly Rung[] = [
  {
    label: 'one box',
    iterations: 9,
    async build(kernel) {
      return [await kernel.createBox({ width: 60, depth: 40, height: 25 })];
    },
  },
  {
    label: 'drilled block',
    iterations: 9,
    capture: 'small',
    async build(kernel) {
      const block = await kernel.createBox({ width: 60, depth: 40, height: 25 });
      const drill = await kernel.createCylinder({
        radius: 12,
        height: 40,
        origin: [0, 0, -8],
      });
      const outcome = await kernel.boolean('subtract', block, drill);
      if (outcome.kind === 'empty') throw new Error('the demo drill removed everything');
      await kernel.release(block);
      await kernel.release(drill);
      return [outcome.bodyId];
    },
  },
  {
    label: '12-hole plate',
    iterations: 7,
    async build(kernel) {
      return [await drilledPlate(kernel, 12)];
    },
  },
  {
    label: '8 plates',
    iterations: 5,
    async build(kernel) {
      const plate = await drilledPlate(kernel, 12);
      const bodies = await copiesOf(kernel, plate, 8);
      await kernel.release(plate);
      return bodies;
    },
  },
  {
    label: '32 plates',
    iterations: 5,
    capture: 'large',
    keepAlive: true,
    async build(kernel) {
      const plate = await drilledPlate(kernel, 12);
      const bodies = await copiesOf(kernel, plate, 32);
      await kernel.release(plate);
      return bodies;
    },
  },
];

// --- Serialization throughput ------------------------------------------------

/** Kernel-side duration of the most recent `operation`, from the log. */
function lastKernelMs(kernel: Kernel, operation: string): number | null {
  for (let i = kernel.operationLog.length - 1; i >= 0; i--) {
    const entry = kernel.operationLog[i];
    if (entry?.operation === operation) return round(entry.durationMs);
  }
  return null;
}

/** Collects a per-iteration sample, for a median alongside the round trip's. */
function kernelSampler(
  kernel: Kernel,
  operation: string,
): { record(): void; median(): number | null } {
  const samples: number[] = [];
  return {
    record(): void {
      const ms = lastKernelMs(kernel, operation);
      if (ms !== null) samples.push(ms);
    },
    median(): number | null {
      return samples.length === 0 ? null : round(median(samples));
    },
  };
}

async function measureSerialization(
  kernel: Kernel,
  workload: Workload,
  iterations: number,
): Promise<SerializationSample> {
  const first = await kernel.serialize(workload.bodies);
  const bytes = first.bytes.byteLength;
  const format = first.format;
  // Kept as the source for restore's inputs: a restore transfers its payload
  // away, so every iteration needs its own copy, made outside the timed region.
  const master = first.bytes.slice();

  const serializeKernel = kernelSampler(kernel, 'serialize');
  const serialize = await repeat(iterations, async () => {
    await kernel.serialize(workload.bodies);
    serializeKernel.record();
  });

  const payloads = Array.from({ length: iterations }, () => master.slice());
  const restored: BodyId[][] = [];
  const restoreKernel = kernelSampler(kernel, 'restore');
  const restore = await repeat(iterations, async (index) => {
    const payload = payloads[index];
    if (payload === undefined) throw new Error('missing payload copy');
    restored.push(await kernel.restore(payload));
    restoreKernel.record();
  });

  for (const handles of restored) await releaseAll(kernel, handles);

  const kbPerMs = (ms: number): number =>
    ms === 0 ? 0 : round(bytes / 1024 / ms, 2);

  return {
    label: workload.label,
    bodyCount: workload.bodies.length,
    faceCount: workload.faceCount,
    bytes,
    format,
    serialize,
    restore,
    serializeKbPerMs: kbPerMs(serialize.medianMs),
    restoreKbPerMs: kbPerMs(restore.medianMs),
    kernelSerializeMs: serializeKernel.median(),
    kernelRestoreMs: restoreKernel.median(),
  };
}

// --- Storage -----------------------------------------------------------------

const DOC_PREFIX = 'measurement-';
const STORE_ITERATIONS = 5;

function contentFor(workload: Workload, documentId: string): DocumentContent {
  return {
    documentId,
    name: workload.label,
    createdAt: '2026-08-27T00:00:00.000Z',
    bodies: workload.bodies.map((handle, index) => ({
      ref: bodyRefFor(index + 1),
      handle,
    })),
    entries: [],
    nextBodyOrdinal: workload.bodies.length + 1,
  };
}

const partsBytes = (parts: DocumentParts): number =>
  Object.values(parts).reduce((sum, part) => sum + part.byteLength, 0);

/** Deletes anything a previous run left behind, so a re-run starts clean. */
async function purge(store: DocumentStore): Promise<void> {
  for (const summary of await store.list()) {
    if (summary.documentId.startsWith(DOC_PREFIX)) {
      await store.remove(summary.documentId);
    }
  }
}

async function measureBackend(
  kernel: Kernel,
  store: DocumentStore,
  workload: string,
  parts: DocumentParts,
): Promise<BackendSample> {
  const bytes = partsBytes(parts);
  const ids = Array.from(
    { length: STORE_ITERATIONS },
    (_, i) => `${DOC_PREFIX}${store.backend}-${workload}-${i}`,
  );

  // Distinct documents rather than one overwritten: a first save is the
  // expensive case for OPFS, which allocates a generation directory, and
  // measuring only overwrites would report the cheaper half.
  const save = await repeat(STORE_ITERATIONS, async (index) => {
    const documentId = ids[index];
    if (documentId === undefined) throw new Error('missing document id');
    await store.save(
      { documentId, name: workload, modifiedAt: new Date().toISOString() },
      parts,
    );
  });

  const subject = ids[0];
  if (subject === undefined) throw new Error('no document to read back');

  const read = await repeat(STORE_ITERATIONS, async () => {
    await store.read(subject);
  });

  // What opening actually costs: storage, then integrity, then the kernel. The
  // restored bodies are released outside the timed region.
  const opened: BodyId[][] = [];
  const open = await repeat(STORE_ITERATIONS, async () => {
    const stored = await store.read(subject);
    const doc = await readDocument(stored, kernel);
    opened.push([...doc.bodies.values()]);
  });
  for (const handles of opened) await releaseAll(kernel, handles);

  const list = await repeat(STORE_ITERATIONS, async () => {
    await store.list();
  });

  const remove = await repeat(STORE_ITERATIONS, async (index) => {
    const documentId = ids[index];
    if (documentId === undefined) throw new Error('missing document id');
    await store.remove(documentId);
  });

  return { backend: store.backend, workload, bytes, save, read, open, list, remove };
}

// --- Main-thread behavior during persistence ---------------------------------

/**
 * A save and an open shaped the way the application does them, with the
 * responsiveness probe running.
 *
 * Not `store.save` alone: the interesting main-thread work is the container's -
 * the CRC-32 over the payload and the JSON encoding both run here, while the
 * serialization itself is in the Worker. If persistence stalls the viewport,
 * that is where it will happen.
 */
const SAVE_BURST = 12;
const OPEN_BURST = 4;
const RESTORE_BURST = 8;

/**
 * Stall attributable to a restoration request alone.
 *
 * The save and open probes below bundle the kernel with storage and
 * tessellation, which is what a user waits through but not what the Worker
 * spec's responsiveness requirement is about: that one is specifically about a
 * request carrying a large payload into the Worker. So this probes restore with
 * nothing else in the window - no store, no mesher - and the payload copies are
 * made before the window opens, since a restore detaches its input.
 */
async function measureRestoreStall(
  kernel: Kernel,
  workload: Workload,
): Promise<StallSample> {
  const payload = await kernel.serialize(workload.bodies);
  const bytes = payload.bytes.byteLength;
  const master = payload.bytes.slice();
  const copies = Array.from({ length: RESTORE_BURST }, () => master.slice());

  const probe = await during(
    'restore (checkpoint only)',
    null,
    bytes,
    RESTORE_BURST,
    async () => {
      const handles: BodyId[] = [];
      for (const copy of copies) handles.push(...(await kernel.restore(copy)));
      return handles;
    },
  );

  await releaseAll(kernel, probe.value);
  return probe.sample;
}

async function measurePersistenceStalls(
  kernel: Kernel,
  store: DocumentStore,
  workload: Workload,
): Promise<StallSample[]> {
  const documentId = `${DOC_PREFIX}${store.backend}-stall`;
  const content = contentFor(workload, documentId);
  const samples: StallSample[] = [];

  const idle = await during('idle baseline', store.backend, 0, 1, () =>
    new Promise<void>((resolve) => setTimeout(resolve, 150)),
  );
  samples.push(idle.sample);

  let bytes = 0;
  const saved = await during(
    'save (build + write)',
    store.backend,
    0,
    SAVE_BURST,
    async () => {
      for (let i = 0; i < SAVE_BURST; i++) {
        const parts = await buildParts(kernel, content);
        bytes = partsBytes(parts);
        await store.save(
          { documentId, name: workload.label, modifiedAt: new Date().toISOString() },
          parts,
        );
      }
    },
  );
  samples.push({ ...saved.sample, bytes });

  // Handles are collected and released after the probe window rather than
  // inside it: releasing is the outgoing session's cost, not the incoming
  // document's, and 32 releases per iteration would be measured as if opening
  // had done them.
  const opened = await during(
    'open (read + restore + tessellate)',
    store.backend,
    bytes,
    OPEN_BURST,
    async () => {
      const handles: BodyId[] = [];
      for (let i = 0; i < OPEN_BURST; i++) {
        const parts = await store.read(documentId);
        const doc = await readDocument(parts, kernel);
        for (const handle of doc.bodies.values()) {
          handles.push(handle);
          await kernel.tessellate(handle, {});
        }
      }
      return handles;
    },
  );
  samples.push(opened.sample);
  await releaseAll(kernel, opened.value);

  await store.remove(documentId);
  return samples;
}

// --- Entry point -------------------------------------------------------------

const BACKENDS: readonly StorageBackend[] = ['indexeddb', 'opfs'];

/**
 * Measures serialization, both storage backends, and main-thread behavior.
 *
 * Takes the live kernel rather than making its own: a second WASM module in the
 * page would double the memory and measure a kernel with a cold cache against
 * an application that never has one.
 */
export async function measureDocumentPersistence(
  kernel: Kernel,
): Promise<DocumentMeasurements> {
  const serialization: SerializationSample[] = [];
  const storage: BackendSample[] = [];
  const unavailableBackends: { backend: StorageBackend; reason: string }[] = [];
  const stalls: StallSample[] = [];
  const notes: string[] = [];

  const captured = new Map<'small' | 'large', { workload: Workload; parts: DocumentParts }>();
  let keptAlive: Workload | null = null;

  try {
    for (const rung of RUNGS) {
      const bodies = await rung.build(kernel);
      const workload: Workload = {
        label: rung.label,
        bodies,
        faceCount: await faceTotal(kernel, bodies),
      };

      serialization.push(
        await measureSerialization(kernel, workload, rung.iterations),
      );

      if (rung.capture !== undefined) {
        captured.set(rung.capture, {
          workload,
          parts: await buildParts(kernel, contentFor(workload, `${DOC_PREFIX}source`)),
        });
      }

      if (rung.keepAlive === true) {
        keptAlive = workload;
      } else {
        await releaseAll(kernel, bodies);
      }
    }

    if (keptAlive !== null) {
      stalls.push(await measureRestoreStall(kernel, keptAlive));
    }

    for (const backend of BACKENDS) {
      let store: DocumentStore;
      try {
        store = await openStore(backend);
      } catch (error) {
        // Reported, not swallowed. A backend comparison missing a backend is a
        // comparison this run did not make.
        unavailableBackends.push({
          backend,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      try {
        await purge(store);
        for (const [size, { parts }] of captured) {
          storage.push(await measureBackend(kernel, store, size, parts));
        }
        if (keptAlive !== null) {
          stalls.push(...(await measurePersistenceStalls(kernel, store, keptAlive)));
        }
        await purge(store);
      } finally {
        store.close();
      }
    }

    if (keptAlive !== null) {
      await releaseAll(kernel, keptAlive.bodies);
      keptAlive = null;
    }

    for (const [size, { parts }] of captured) {
      notes.push(
        `${size} document: ${partsBytes(parts)} bytes across ` +
          `${Object.keys(parts).length} parts`,
      );
    }

    return {
      occtVersion: kernel.occtVersion,
      serialization,
      storage,
      unavailableBackends,
      stalls,
      notes,
    };
  } finally {
    // The verification session continues after this returns, with its own
    // document and its own live bodies. Anything left behind here would show up
    // as a leak in a check this module has nothing to do with.
    if (keptAlive !== null) await releaseAll(kernel, keptAlive.bodies);
  }
}
