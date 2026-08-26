import {
  KernelNotReadyError,
  KernelTerminatedError,
  reviveFailure,
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
  MeshBuffers,
  MeshMeta,
  OperationRecord,
  TessellationOptions,
} from './types.ts';
import { asBodyId } from './types.ts';
import type { KernelModuleFactory } from './wasm-module.ts';
import { defaultLoadModule } from './worker/load-module.ts';
import type {
  BodyResult,
  BooleanResult,
  InitResult,
  KernelRequest,
  MeshResult,
  ResponseTail,
} from './worker/protocol.ts';
import { InProcessTransport, type Transport } from './worker/transport.ts';
import { WorkerTransport } from './worker/worker-transport.ts';

export interface KernelOptions {
  /**
   * Overrides how the WASM module is loaded by the default in-process
   * transport. Tests point this at the build output. Ignored when `transport`
   * is supplied, since the transport then owns the module.
   */
  loadModule?: KernelModuleFactory;
  /** Where the request handler lives. Defaults to in-process. */
  transport?: Transport;
  /** Retained operation-log entries. Older entries are dropped. */
  logLimit?: number;
}

const DEFAULT_LOG_LIMIT = 500;

/**
 * The geometry kernel: a handle-based facade over OCCT running in WASM.
 *
 * Exact B-Rep data stays inside WASM. Callers hold `BodyId` handles and own
 * their lifetime - WASM linear memory is invisible to the JavaScript garbage
 * collector, so an unreleased body leaks until the module is discarded.
 *
 * This class holds no module. It is a proxy over a `Transport`, which reaches
 * the request handler wherever it lives - a Worker in the browser, in-process
 * for tests. MVP-0 measured a two-primitive Boolean at four frames on the main
 * thread, which is why the browser path is the Worker one.
 */
export class Kernel {
  #transport: Transport | null;
  #initPromise: Promise<void> | null = null;
  #ready: InitResult | null = null;
  #log: OperationRecord[] = [];
  #stats: KernelStats | null = null;
  #nextRequestId = 1;

  readonly #logLimit: number;

  constructor(options: KernelOptions = {}) {
    this.#transport =
      options.transport ??
      new InProcessTransport(options.loadModule ?? defaultLoadModule);
    this.#logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
  }

  /** Convenience: construct and initialize in one step. */
  static async create(options: KernelOptions = {}): Promise<Kernel> {
    const kernel = new Kernel(options);
    await kernel.initialize();
    return kernel;
  }

  /**
   * A kernel whose OCCT module runs in a dedicated Worker. What the browser
   * should use: on the main thread a two-primitive Boolean costs four frames.
   */
  static createInWorker(
    options: Omit<KernelOptions, 'transport' | 'loadModule'> = {},
  ): Promise<Kernel> {
    return Kernel.create({ ...options, transport: new WorkerTransport() });
  }

  get isReady(): boolean {
    return this.#ready !== null;
  }

  /**
   * Starts the transport's host and instantiates the WASM module inside it.
   *
   * Idempotent: concurrent and repeated calls share one instantiation and every
   * caller receives the same ready instance. On failure no partially
   * constructed kernel is left behind, and a later call may retry.
   */
  async initialize(): Promise<void> {
    if (this.#ready !== null) return;

    this.#initPromise ??= (async () => {
      const transport = this.#transport;
      if (transport === null) {
        throw new KernelTerminatedError(
          'the kernel has been disposed',
          'initialize',
        );
      }
      transport.onFailure((error) => {
        this.#onTransportFailure(error);
      });
      this.#ready = await this.#dispatch<InitResult>({ kind: 'init' });
    })();

    try {
      await this.#initPromise;
    } catch (error) {
      // Allow a retry rather than wedging the instance on a transient failure,
      // and leave nothing half-started behind: the transport discards whatever
      // host it spawned, and the next attempt begins from scratch.
      this.#initPromise = null;
      this.#ready = null;
      this.#transport?.reset();
      throw error;
    }
  }

  get occtVersion(): string {
    return this.#require('occtVersion').occtVersion;
  }

  get defaultTolerances(): { linear: number; angular: number } {
    const ready = this.#require('defaultTolerances');
    return {
      linear: ready.defaultLinearDeflection,
      angular: ready.defaultAngularDeflection,
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
    this.#require('createBox');
    const result = await this.#dispatch<BodyResult>({
      kind: 'createBox',
      options,
    });
    return asBodyId(result.bodyId);
  }

  async createCylinder(options: CylinderOptions): Promise<BodyId> {
    this.#require('createCylinder');
    const result = await this.#dispatch<BodyResult>({
      kind: 'createCylinder',
      options,
    });
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
    this.#require(kind);
    const result = await this.#dispatch<BooleanResult>({
      kind: 'boolean',
      op: kind,
      target,
      tool,
    });

    // Not an error: a subtract that removes all material, or an intersect of
    // disjoint solids, legitimately produces nothing.
    if (result.kind === 'empty') {
      return { kind: 'empty', message: result.message };
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
   * Tessellates a body and returns the mesh as buffers the caller owns.
   *
   * MVP-0 exposed this as a callback taking typed-array views over WASM memory,
   * to make one rule structural: a view must not outlive the synchronous block,
   * because growing the heap detaches it. With the module behind a transport
   * there is no view on this side to protect, so the rule has no subject left
   * and the callback that enforced it is gone. Keep the result as long as you
   * like.
   */
  async tessellate(
    bodyId: BodyId,
    options: TessellationOptions = {},
  ): Promise<{ mesh: MeshBuffers; meta: MeshMeta }> {
    this.#require('tessellate');
    const result = await this.#dispatch<MeshResult>({
      kind: 'tessellate',
      bodyId,
      options,
    });
    return { mesh: result.mesh, meta: result.meta };
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
    this.#require('release');
    await this.#dispatch<null>({ kind: 'release', bodyId });
  }

  async bodyInfo(bodyId: BodyId): Promise<BodyInfo> {
    this.#require('bodyInfo');
    return this.#dispatch<BodyInfo>({ kind: 'bodyInfo', bodyId });
  }

  async faceTypeSummary(bodyId: BodyId): Promise<FaceTypeSummary> {
    this.#require('faceTypeSummary');
    return this.#dispatch<FaceTypeSummary>({ kind: 'faceTypeSummary', bodyId });
  }

  /**
   * Live handle count and WASM memory, for leak detection and measurement.
   *
   * The snapshot from the last completed operation. Kernel state only changes
   * when an operation runs, so this is current except while one is in flight -
   * and keeping it synchronous is what lets the readout render every frame
   * without a round trip. Use `refreshStats` when exactness now matters.
   */
  stats(): KernelStats {
    this.#require('stats');
    if (this.#stats === null) throw new KernelNotReadyError('stats');
    return this.#stats;
  }

  /** Fetches statistics from the kernel rather than reading the snapshot. */
  async refreshStats(): Promise<KernelStats> {
    this.#require('refreshStats');
    return this.#dispatch<KernelStats>({ kind: 'stats' });
  }

  /**
   * Terminates the kernel's host. Every body it held goes away with it, so all
   * outstanding handles become worthless rather than merely stale.
   */
  dispose(): void {
    this.#transport?.dispose();
    this.#transport = null;
    this.#ready = null;
    this.#initPromise = null;
    this.#stats = null;
  }

  // --- Internals -----------------------------------------------------------

  #require(operation: string): InitResult {
    if (this.#ready === null) {
      throw new KernelNotReadyError(operation);
    }
    return this.#ready;
  }

  /**
   * Sends one request, mirrors the scalars that rode back with the response,
   * and either resolves with the value or throws the revived error.
   */
  async #dispatch<T>(request: KernelRequest): Promise<T> {
    const transport = this.#transport;
    if (transport === null) {
      throw new KernelTerminatedError(
        'the kernel has been disposed',
        request.kind,
      );
    }

    const id = this.#nextRequestId++;
    const started = performance.now();
    const response = await transport.send({ id, request });
    this.#absorb(response.tail, performance.now() - started);

    if (!response.ok) throw reviveFailure(response.error);
    return response.value as T;
  }

  /**
   * Mirrors the response tail. The round trip is stamped here rather than in
   * the handler because only this side can see it; the difference between it
   * and the handler's own duration is what the transport cost.
   */
  #absorb(tail: ResponseTail, roundTripMs: number): void {
    if (tail.stats !== undefined) this.#stats = tail.stats;
    if (tail.record === undefined) return;

    this.#log.push({ ...tail.record, roundTripMs });
    if (this.#log.length > this.#logLimit) {
      this.#log.splice(0, this.#log.length - this.#logLimit);
    }
  }

  #onTransportFailure(error: Error): void {
    this.#ready = null;
    this.#initPromise = null;
    console.error('[webcad] the geometry kernel stopped', error);
  }
}
