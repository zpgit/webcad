import {
  InvalidParameterError,
  KernelNotReadyError,
  Status,
  WebAssemblyUnsupportedError,
  throwForStatus,
} from './errors.ts';
import type {
  BodyId,
  BodyInfo,
  BooleanKind,
  BooleanOutcome,
  BoxOptions,
  CylinderOptions,
  FaceTypeSummary,
  KernelStats,
  MeshMeta,
  MeshViews,
  OperationRecord,
  TessellationOptions,
} from './types.ts';
import { asBodyId } from './types.ts';
import type { KernelModule, KernelModuleFactory } from './wasm-module.ts';

const BOOLEAN_KIND_CODE: Record<BooleanKind, number> = {
  union: 0,
  subtract: 1,
  intersect: 2,
};

export interface KernelOptions {
  /**
   * Overrides how the WASM module is loaded. Tests point this at the build
   * output; the browser uses the default, which resolves relative to this file.
   */
  loadModule?: KernelModuleFactory;
  /** Retained operation-log entries. Older entries are dropped. */
  logLimit?: number;
}

const DEFAULT_LOG_LIMIT = 500;

async function defaultLoadModule(): Promise<KernelModule> {
  const url = new URL('./wasm/webcad_kernel.mjs', import.meta.url).href;
  // @vite-ignore: the artifact is a build product, absent from a fresh
  // checkout. A static import would make `vite build` fail before the kernel
  // has ever been compiled.
  const mod = (await import(/* @vite-ignore */ url)) as {
    default: KernelModuleFactory;
  };
  return mod.default();
}

/**
 * The geometry kernel: a handle-based facade over OCCT running in WASM.
 *
 * Exact B-Rep data stays inside WASM. Callers hold `BodyId` handles and own
 * their lifetime - WASM linear memory is invisible to the JavaScript garbage
 * collector, so an unreleased body leaks until the module is discarded.
 *
 * Every operation is async even though MVP-0 runs the kernel on the main thread.
 * The architecture note leaves the Worker question open and expects MVP-0's
 * measurements to answer it; an async surface means acting on that answer
 * changes the transport, not every call site.
 */
export class Kernel {
  #module: KernelModule | null = null;
  #initPromise: Promise<void> | null = null;
  #log: OperationRecord[] = [];

  readonly #loadModule: KernelModuleFactory;
  readonly #logLimit: number;

  constructor(options: KernelOptions = {}) {
    this.#loadModule = options.loadModule ?? defaultLoadModule;
    this.#logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
  }

  /** Convenience: construct and initialize in one step. */
  static async create(options: KernelOptions = {}): Promise<Kernel> {
    const kernel = new Kernel(options);
    await kernel.initialize();
    return kernel;
  }

  get isReady(): boolean {
    return this.#module !== null;
  }

  /**
   * Loads and instantiates the WASM module.
   *
   * Idempotent: concurrent and repeated calls share one instantiation and every
   * caller receives the same ready instance. On failure no partially
   * constructed kernel is left behind, and a later call may retry.
   */
  async initialize(): Promise<void> {
    if (this.#module !== null) return;

    this.#initPromise ??= (async () => {
      if (typeof WebAssembly === 'undefined') {
        throw new WebAssemblyUnsupportedError(
          'WebAssembly is not available in this environment',
        );
      }
      try {
        this.#module = await this.#loadModule();
      } catch (cause) {
        throw new WebAssemblyUnsupportedError(
          'the geometry kernel module failed to instantiate',
          { cause },
        );
      }
    })();

    try {
      await this.#initPromise;
    } catch (error) {
      // Allow a retry rather than wedging the instance on a transient failure.
      this.#initPromise = null;
      this.#module = null;
      throw error;
    }
  }

  get occtVersion(): string {
    return this.#require('occtVersion').occtVersion();
  }

  get defaultTolerances(): { linear: number; angular: number } {
    const mod = this.#require('defaultTolerances');
    return {
      linear: mod.defaultLinearDeflection,
      angular: mod.defaultAngularDeflection,
    };
  }

  /** Operation log: duration and status for every operation, failures included. */
  get operationLog(): readonly OperationRecord[] {
    return this.#log;
  }

  clearOperationLog(): void {
    this.#log = [];
  }

  // --- Primitives ----------------------------------------------------------

  async createBox(options: BoxOptions): Promise<BodyId> {
    const mod = this.#require('createBox');
    const [ox, oy, oz] = options.origin ?? [0, 0, 0];
    const [ax, ay, az] = options.axis ?? [0, 0, 1];

    const result = this.#timed('createBox', () =>
      mod.createBox({
        width: options.width,
        depth: options.depth,
        height: options.height,
        originX: ox,
        originY: oy,
        originZ: oz,
        axisX: ax,
        axisY: ay,
        axisZ: az,
        angle: options.angle ?? 0,
      }),
    );

    if (result.status !== Status.Ok) {
      throwForStatus(result.status, result.message, 'createBox');
    }
    return asBodyId(result.bodyId);
  }

  async createCylinder(options: CylinderOptions): Promise<BodyId> {
    const mod = this.#require('createCylinder');
    const [ox, oy, oz] = options.origin ?? [0, 0, 0];
    const [ax, ay, az] = options.axis ?? [0, 0, 1];

    const result = this.#timed('createCylinder', () =>
      mod.createCylinder({
        radius: options.radius,
        height: options.height,
        originX: ox,
        originY: oy,
        originZ: oz,
        axisX: ax,
        axisY: ay,
        axisZ: az,
      }),
    );

    if (result.status !== Status.Ok) {
      throwForStatus(result.status, result.message, 'createCylinder');
    }
    return asBodyId(result.bodyId);
  }

  // --- Booleans ------------------------------------------------------------

  /**
   * Runs a Boolean operation. Both operands remain valid afterwards: the
   * operation never implicitly releases its inputs, so callers can retain,
   * reuse, or release them.
   */
  async boolean(
    kind: BooleanKind,
    target: BodyId,
    tool: BodyId,
  ): Promise<BooleanOutcome> {
    const mod = this.#require(kind);
    const result = this.#timed(kind, () =>
      mod.booleanOp(target, tool, BOOLEAN_KIND_CODE[kind]),
    );

    // Not an error: a subtract that removes all material, or an intersect of
    // disjoint solids, legitimately produces nothing.
    if (result.status === Status.EmptyResult) {
      return { kind: 'empty', message: result.message };
    }
    if (result.status !== Status.Ok) {
      throwForStatus(result.status, result.message, kind);
    }
    return {
      kind: 'body',
      bodyId: asBodyId(result.bodyId),
      solidCount: result.solidCount,
    };
  }

  union(target: BodyId, tool: BodyId): Promise<BooleanOutcome> {
    return this.boolean('union', target, tool);
  }

  subtract(target: BodyId, tool: BodyId): Promise<BooleanOutcome> {
    return this.boolean('subtract', target, tool);
  }

  intersect(target: BodyId, tool: BodyId): Promise<BooleanOutcome> {
    return this.boolean('intersect', target, tool);
  }

  // --- Tessellation --------------------------------------------------------

  /**
   * Tessellates a body and hands typed-array views over WASM memory to
   * `consume`.
   *
   * The views are valid ONLY inside the callback. Growing WASM memory detaches
   * its backing ArrayBuffer and invalidates every existing view, so a stored
   * view is a latent crash rather than merely stale data. Taking a callback
   * makes that rule structural: there is no way to obtain a view that outlives
   * the synchronous block it was created in. Upload to the GPU, or copy, inside.
   */
  async withTessellation<T>(
    bodyId: BodyId,
    options: TessellationOptions,
    consume: (views: MeshViews, meta: MeshMeta) => T,
  ): Promise<T> {
    const mod = this.#require('tessellate');

    // Rejected here rather than in C++ so a caller cannot express an unbounded
    // tessellation; the native side treats non-positive as "use the default".
    if (options.linearDeflection !== undefined && !(options.linearDeflection > 0)) {
      throw new InvalidParameterError(
        'linearDeflection must be positive',
        'tessellate',
      );
    }
    if (options.angularDeflection !== undefined && !(options.angularDeflection > 0)) {
      throw new InvalidParameterError(
        'angularDeflection must be positive',
        'tessellate',
      );
    }

    const result = this.#timed('tessellate', () =>
      mod.tessellate(bodyId, {
        linearDeflection: options.linearDeflection ?? 0,
        angularDeflection: options.angularDeflection ?? 0,
      }),
    );

    if (result.status !== Status.Ok) {
      throwForStatus(result.status, result.message, 'tessellate');
    }

    const meta: MeshMeta = {
      vertexCount: result.vertexCount,
      triangleCount: result.triangleCount,
      linearDeflection: result.linearDeflection,
      angularDeflection: result.angularDeflection,
      fromCache: result.fromCache,
    };
    this.#annotateLastLog(result.triangleCount);

    // Views are derived from the module's CURRENT heap views and handed straight
    // to the callback. Nothing here retains them.
    const floats = result.vertexCount * 3;
    const ints = result.triangleCount * 3;
    const views: MeshViews = {
      positions: mod.HEAPF32.subarray(
        result.positionsPtr / 4,
        result.positionsPtr / 4 + floats,
      ),
      normals: mod.HEAPF32.subarray(
        result.normalsPtr / 4,
        result.normalsPtr / 4 + floats,
      ),
      indices: mod.HEAPU32.subarray(
        result.indicesPtr / 4,
        result.indicesPtr / 4 + ints,
      ),
    };

    return consume(views, meta);
  }

  /** Tessellates and copies the mesh out, for callers that must retain it. */
  async tessellateToCopy(
    bodyId: BodyId,
    options: TessellationOptions = {},
  ): Promise<{ mesh: MeshViews; meta: MeshMeta }> {
    return this.withTessellation(bodyId, options, (views, meta) => ({
      // Copies, so these outlive the callback and survive memory growth.
      mesh: {
        positions: new Float32Array(views.positions),
        normals: new Float32Array(views.normals),
        indices: new Uint32Array(views.indices),
      },
      meta,
    }));
  }

  // --- Lifetime and inspection --------------------------------------------

  /**
   * Destroys a body and evicts its cached meshes. Reports InvalidHandle for an
   * unknown or already-released handle.
   *
   * Callers own handle lifetime: the JavaScript garbage collector cannot see
   * WASM linear memory, so nothing reclaims a body implicitly.
   */
  async release(bodyId: BodyId): Promise<void> {
    const mod = this.#require('release');
    const result = this.#timed('release', () => mod.releaseBody(bodyId));
    if (result.status !== Status.Ok) {
      throwForStatus(result.status, result.message, 'release');
    }
  }

  async bodyInfo(bodyId: BodyId): Promise<BodyInfo> {
    const mod = this.#require('bodyInfo');
    const raw = this.#timed('bodyInfo', () => mod.bodyInfo(bodyId));
    if (raw.status !== Status.Ok) {
      throwForStatus(raw.status, raw.message, 'bodyInfo');
    }
    return {
      faceCount: raw.faceCount,
      edgeCount: raw.edgeCount,
      vertexCount: raw.vertexCount,
      solidCount: raw.solidCount,
      volume: raw.volume,
      area: raw.area,
      boundingBox: {
        min: [raw.bboxMinX, raw.bboxMinY, raw.bboxMinZ],
        max: [raw.bboxMaxX, raw.bboxMaxY, raw.bboxMaxZ],
      },
      isValid: raw.isValid,
      isClosed: raw.isClosed,
    };
  }

  async faceTypeSummary(bodyId: BodyId): Promise<FaceTypeSummary> {
    const mod = this.#require('faceTypeSummary');
    const raw = this.#timed('faceTypeSummary', () => mod.faceTypeSummary(bodyId));
    if (raw.status !== Status.Ok) {
      throwForStatus(raw.status, raw.message, 'faceTypeSummary');
    }
    const { status: _s, message: _m, ...counts } = raw;
    return counts;
  }

  /** Live handle count and WASM memory, for leak detection and measurement. */
  stats(): KernelStats {
    const mod = this.#require('stats');
    return mod.stats();
  }

  // --- Internals -----------------------------------------------------------

  #require(operation: string): KernelModule {
    if (this.#module === null) {
      throw new KernelNotReadyError(operation);
    }
    return this.#module;
  }

  /**
   * Times an operation and records it. MVP-0 exists to measure this boundary,
   * so the log is a deliverable rather than a debugging aid - which is why
   * failures are recorded too.
   */
  #timed<T extends { status: number }>(operation: string, run: () => T): T {
    const started = performance.now();
    let status = Status.KernelOperationFailed as number;
    try {
      const result = run();
      status = result.status;
      return result;
    } finally {
      const mod = this.#module;
      this.#record({
        operation,
        durationMs: performance.now() - started,
        status,
        wasmMemoryBytes: mod ? mod.HEAPU8.byteLength : 0,
      });
    }
  }

  #record(entry: OperationRecord): void {
    this.#log.push(entry);
    if (this.#log.length > this.#logLimit) {
      this.#log.splice(0, this.#log.length - this.#logLimit);
    }
  }

  #annotateLastLog(triangleCount: number): void {
    const last = this.#log[this.#log.length - 1];
    if (last !== undefined) {
      this.#log[this.#log.length - 1] = { ...last, triangleCount };
    }
  }
}
