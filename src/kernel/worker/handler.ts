// The only code that touches the WASM module.
//
// Everything WASM-adjacent lives here so it can be hosted wherever the module
// is: inside the kernel Worker in the browser, or in-process for tests and
// tooling. The transport decides which; this file cannot tell the difference,
// which is what keeps the two paths from diverging.

import {
  InvalidParameterError,
  KernelNotReadyError,
  Status,
  WebAssemblyUnsupportedError,
  throwForStatus,
  toFailure,
} from '../errors.ts';
import type {
  BooleanKind,
  BoxOptions,
  CylinderOptions,
  MeshMeta,
  OperationRecord,
  StepTranslationOptions,
  TessellationOptions,
} from '../types.ts';
import type {
  KernelModule,
  KernelModuleFactory,
  RawStepImportResult,
} from '../wasm-module.ts';
import type {
  KernelEnvelope,
  KernelRequest,
  ResponseTail,
  ServedResponse,
} from './protocol.ts';

const BOOLEAN_KIND_CODE: Record<BooleanKind, number> = {
  union: 0,
  subtract: 1,
  intersect: 2,
};

export interface HandlerOutcome {
  readonly value: unknown;
  readonly transfer: readonly Transferable[];
}

export class KernelHandler {
  #module: KernelModule | null = null;
  #pendingRecord: OperationRecord | undefined;

  readonly #loadModule: KernelModuleFactory;

  constructor(loadModule: KernelModuleFactory) {
    this.#loadModule = loadModule;
  }

  async handle(request: KernelRequest): Promise<HandlerOutcome> {
    switch (request.kind) {
      case 'init':
        return this.#init();
      case 'createBox':
        return this.#createBox(request.options);
      case 'createCylinder':
        return this.#createCylinder(request.options);
      case 'boolean':
        return this.#boolean(request.op, request.target, request.tool);
      case 'tessellate':
        return this.#tessellate(request.bodyId, request.options);
      case 'release':
        return this.#release(request.bodyId);
      case 'bodyInfo':
        return this.#bodyInfo(request.bodyId);
      case 'faceTypeSummary':
        return this.#faceTypeSummary(request.bodyId);
      case 'serialize':
        return this.#serialize(request.bodyIds);
      case 'restore':
        return this.#restore(request.payload);
      case 'importStep':
        return this.#importStep(request.payload, request.options);
      case 'exportStep':
        return this.#exportStep(request.bodyIds, request.options);
      case 'stats':
        return { value: this.#require('stats').stats(), transfer: [] };
    }
  }

  /**
   * The scalars appended to the response for the request just handled, and then
   * cleared. Read on both the success and the failure path, because a failed
   * operation is logged too - MVP-0 found that distinction worth keeping.
   */
  takeTail(): ResponseTail {
    const record = this.#pendingRecord;
    this.#pendingRecord = undefined;
    const mod = this.#module;
    return {
      ...(record === undefined ? {} : { record }),
      ...(mod === null ? {} : { stats: mod.stats() }),
    };
  }

  /** Drops the module. The Worker is normally terminated instead. */
  dispose(): void {
    this.#module = null;
  }

  // --- Operations ----------------------------------------------------------

  async #init(): Promise<HandlerOutcome> {
    if (this.#module === null) {
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
    }
    const mod = this.#module;
    return {
      value: {
        occtVersion: mod.occtVersion(),
        defaultLinearDeflection: mod.defaultLinearDeflection,
        defaultAngularDeflection: mod.defaultAngularDeflection,
      },
      transfer: [],
    };
  }

  #createBox(options: BoxOptions): HandlerOutcome {
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
    return { value: { bodyId: result.bodyId }, transfer: [] };
  }

  #createCylinder(options: CylinderOptions): HandlerOutcome {
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
    return { value: { bodyId: result.bodyId }, transfer: [] };
  }

  #boolean(kind: BooleanKind, target: number, tool: number): HandlerOutcome {
    const mod = this.#require(kind);
    const result = this.#timed(kind, () =>
      mod.booleanOp(target, tool, BOOLEAN_KIND_CODE[kind]),
    );

    // Not an error: a subtract that removes all material, or an intersect of
    // disjoint solids, legitimately produces nothing.
    if (result.status === Status.EmptyResult) {
      return { value: { kind: 'empty', message: result.message }, transfer: [] };
    }
    if (result.status !== Status.Ok) {
      throwForStatus(result.status, result.message, kind);
    }
    return {
      value: {
        kind: 'body',
        bodyId: result.bodyId,
        solidCount: result.solidCount,
      },
      transfer: [],
    };
  }

  /**
   * Tessellates and copies the mesh into buffers the caller will own.
   *
   * The copy out of WASM memory is unavoidable once the module lives on its own
   * thread, so it is timed and its size recorded rather than treated as free -
   * MVP-0's findings called for exactly this figure. Copying also means a cache
   * hit never hands two callers the same buffer.
   */
  #tessellate(bodyId: number, options: TessellationOptions): HandlerOutcome {
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

    // Heap views are read and copied in one synchronous block. Nothing retains
    // them: growing WASM memory detaches the backing buffer, so a view that
    // outlived this block would be a latent crash rather than stale data.
    const copyStarted = performance.now();
    const floats = result.vertexCount * 3;
    const ints = result.triangleCount * 3;
    const positions = mod.HEAPF32.slice(
      result.positionsPtr / 4,
      result.positionsPtr / 4 + floats,
    );
    const normals = mod.HEAPF32.slice(
      result.normalsPtr / 4,
      result.normalsPtr / 4 + floats,
    );
    const indices = mod.HEAPU32.slice(
      result.indicesPtr / 4,
      result.indicesPtr / 4 + ints,
    );
    const copyMs = performance.now() - copyStarted;

    this.#annotateRecord({
      triangleCount: result.triangleCount,
      copyMs,
      transferBytes:
        positions.byteLength + normals.byteLength + indices.byteLength,
    });

    return {
      value: { mesh: { positions, normals, indices }, meta },
      transfer: [
        positions.buffer as ArrayBuffer,
        normals.buffer as ArrayBuffer,
        indices.buffer as ArrayBuffer,
      ],
    };
  }

  #release(bodyId: number): HandlerOutcome {
    const mod = this.#require('release');
    const result = this.#timed('release', () => mod.releaseBody(bodyId));
    if (result.status !== Status.Ok) {
      throwForStatus(result.status, result.message, 'release');
    }
    return { value: null, transfer: [] };
  }

  #bodyInfo(bodyId: number): HandlerOutcome {
    const mod = this.#require('bodyInfo');
    const raw = this.#timed('bodyInfo', () => mod.bodyInfo(bodyId));
    if (raw.status !== Status.Ok) {
      throwForStatus(raw.status, raw.message, 'bodyInfo');
    }
    return {
      value: {
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
      },
      transfer: [],
    };
  }

  #faceTypeSummary(bodyId: number): HandlerOutcome {
    const mod = this.#require('faceTypeSummary');
    const raw = this.#timed('faceTypeSummary', () => mod.faceTypeSummary(bodyId));
    if (raw.status !== Status.Ok) {
      throwForStatus(raw.status, raw.message, 'faceTypeSummary');
    }
    const { status: _s, message: _m, ...counts } = raw;
    return { value: counts, transfer: [] };
  }

  /**
   * Serializes bodies and copies the payload into a buffer the caller will own.
   *
   * Same discipline as tessellation: the copy out of WASM memory happens in one
   * synchronous block, is timed, and its size is recorded. What differs is what
   * is being copied - these bytes are exact geometry rather than a rendering of
   * it, so they are handed over opaque and nothing on this side parses them.
   */
  #serialize(bodyIds: readonly number[]): HandlerOutcome {
    const mod = this.#require('serialize');

    // embind allocates the vector in WASM memory and frees nothing implicitly,
    // so it is released on every path out of here, failures included.
    const list = new mod.BodyIdList();
    let result;
    try {
      for (const id of bodyIds) list.push_back(id);
      result = this.#timed('serialize', () => mod.serializeBodies(list));
    } finally {
      list.delete();
    }

    if (result.status !== Status.Ok) {
      throwForStatus(result.status, result.message, 'serialize');
    }

    const copyStarted = performance.now();
    const bytes = mod.HEAPU8.slice(
      result.dataPtr,
      result.dataPtr + result.byteLength,
    );
    const copyMs = performance.now() - copyStarted;

    // The kernel would otherwise hold a checkpoint-sized allocation for the
    // rest of the session, having already handed the caller its own copy.
    mod.discardStaging();

    this.#annotateRecord({ copyMs, transferBytes: bytes.byteLength });

    return {
      value: {
        bytes,
        bodyCount: result.bodyCount,
        format: result.format,
        occtVersion: result.occtVersion,
      },
      transfer: [bytes.buffer as ArrayBuffer],
    };
  }

  /**
   * Restores bodies from a payload the caller handed over.
   *
   * The first request that carries bytes INTO the kernel. Staging and the write
   * into WASM memory sit inside the timed region because they are part of what
   * restoring costs; the write itself is timed separately so the two are not
   * conflated.
   */
  #restore(payload: Uint8Array): HandlerOutcome {
    const mod = this.#require('restore');

    if (payload.byteLength === 0) {
      throw new InvalidParameterError('payload is empty', 'restore');
    }

    let copyMs = 0;
    const result = this.#timed('restore', () => {
      const staged = mod.reserveStaging(payload.byteLength);
      if (staged.status !== Status.Ok) {
        return {
          status: staged.status,
          message: staged.message,
          firstBodyId: 0,
          bodyCount: 0,
        };
      }

      // The view is taken after reserveStaging, never before: reserving can
      // grow the heap, and growth detaches every existing view.
      const copyStarted = performance.now();
      mod.HEAPU8.set(payload, staged.dataPtr);
      copyMs = performance.now() - copyStarted;

      return mod.restoreBodies();
    });

    mod.discardStaging();

    if (result.status !== Status.Ok) {
      throwForStatus(result.status, result.message, 'restore');
    }

    this.#annotateRecord({ copyMs, transferBytes: payload.byteLength });

    // Consecutive by construction and verified kernel-side, so position i in
    // the payload is firstBodyId + i. Expanded here so the protocol reports
    // handles rather than an encoding of them.
    const bodyIds = Array.from(
      { length: result.bodyCount },
      (_, i) => result.firstBodyId + i,
    );
    return { value: { bodyIds }, transfer: [] };
  }

  /**
   * Translates a STEP payload the caller handed over.
   *
   * Staged and timed exactly as a restoration is, and for the same reasons. The
   * difference is not in the mechanics but in the trust: these bytes came from
   * outside the system, so the kernel validates rather than assumes, and a
   * failure here is an ordinary outcome rather than a sign of a corrupt
   * checkpoint.
   */
  #importStep(
    payload: Uint8Array,
    options: StepTranslationOptions,
  ): HandlerOutcome {
    const mod = this.#require('importStep');

    if (payload.byteLength === 0) {
      throw new InvalidParameterError('payload is empty', 'importStep');
    }

    // Staging and the write into WASM memory sit inside the timed region
    // because they are part of what translating costs. A staging failure is
    // reported out of the callback rather than thrown from inside it, so the
    // operation is still recorded - a failed operation is logged too.
    let copyMs = 0;
    const outcome = this.#timed('importStep', ():
      | {
          readonly status: number;
          readonly staged: false;
          readonly message: string;
        }
      | {
          readonly status: number;
          readonly staged: true;
          readonly result: RawStepImportResult;
        } => {
      const staged = mod.reserveStaging(payload.byteLength);
      if (staged.status !== Status.Ok) {
        return { status: staged.status, staged: false, message: staged.message };
      }

      // After reserveStaging, never before: reserving can grow the heap, and
      // growth detaches every existing view.
      const copyStarted = performance.now();
      mod.HEAPU8.set(payload, staged.dataPtr);
      copyMs = performance.now() - copyStarted;

      const result = mod.importStep({
        shapeProcessing: options.shapeProcessing ?? false,
        // embind requires every field of a value object, so this is supplied
        // rather than left to the C++ default. False keeps this layer where
        // MVP-2 left it while the kernel's structure-aware path lands
        // underneath it; giving a caller a way to ask for structure is the
        // boundary work, and it is not this.
        structure: false,
      });
      // Surfaced so the operation record carries the translation's own status
      // rather than the staging call's.
      return { status: result.status, staged: true, result };
    });

    // Released whatever happened: a multi-megabyte STEP file is the largest
    // thing this kernel ever holds, and holding it after translation would
    // double the peak for the rest of the session.
    mod.discardStaging();

    if (!outcome.staged) {
      throwForStatus(outcome.status, outcome.message, 'importStep');
    }
    const result = outcome.result;

    // A syntactically valid file that yielded nothing this system can hold is a
    // success reporting zero bodies, not a failure - the same convention a
    // Boolean that removes all material follows. It stays distinct from a parse
    // failure, which throws: the caller can tell "your file has no solids in it"
    // from "your file is not STEP", and only one of those is worth the word
    // error. `rootShapeCount` and `unregisteredShapeCount` say which shapes were
    // seen and skipped.
    if (result.status !== Status.Ok && result.status !== Status.EmptyResult) {
      throwForStatus(result.status, result.message, 'importStep');
    }

    this.#annotateRecord({ copyMs, transferBytes: payload.byteLength });

    // The embind vector is backed by WASM memory and frees nothing implicitly.
    const openBodyIds: number[] = [];
    try {
      for (let i = 0; i < result.openBodyIds.size(); i += 1) {
        const id = result.openBodyIds.get(i);
        if (id !== undefined) openBodyIds.push(id);
      }
    } finally {
      result.openBodyIds.delete();
    }

    // Consecutive by construction and verified kernel-side, as for a restore.
    const bodyIds = Array.from(
      { length: result.bodyCount },
      (_, i) => result.firstBodyId + i,
    );

    return {
      value: {
        bodyIds,
        rootShapeCount: result.rootShapeCount,
        unregisteredShapeCount: result.unregisteredShapeCount,
        openBodyIds,
        declaredUnit: result.declaredUnit,
        workingUnit: result.workingUnit,
        unitWasAssumed: result.unitWasAssumed,
        namedProductCount: result.namedProductCount,
        styledItemCount: result.styledItemCount,
        assemblyNodeCount: result.assemblyNodeCount,
        shapeProcessing: result.shapeProcessing,
        payloadByteLength: result.payloadByteLength,
      },
      transfer: [],
    };
  }

  /**
   * Writes bodies to a STEP payload and copies it into a buffer the caller owns.
   *
   * Same shape as `#serialize`, and deliberately so - what differs is the
   * format, not the discipline. The bytes leave opaque either way.
   */
  #exportStep(
    bodyIds: readonly number[],
    options: StepTranslationOptions,
  ): HandlerOutcome {
    const mod = this.#require('exportStep');

    const list = new mod.BodyIdList();
    let result;
    try {
      for (const id of bodyIds) list.push_back(id);
      result = this.#timed('exportStep', () =>
        mod.exportStep(list, {
          shapeProcessing: options.shapeProcessing ?? false,
          // As above: required by embind, and the writer ignores it.
          structure: false,
        }),
      );
    } finally {
      list.delete();
    }

    if (result.status !== Status.Ok) {
      throwForStatus(result.status, result.message, 'exportStep');
    }

    const copyStarted = performance.now();
    const bytes = mod.HEAPU8.slice(
      result.dataPtr,
      result.dataPtr + result.byteLength,
    );
    const copyMs = performance.now() - copyStarted;

    mod.discardStaging();

    this.#annotateRecord({ copyMs, transferBytes: bytes.byteLength });

    return {
      value: {
        bytes,
        bodyCount: result.bodyCount,
        unitWritten: result.unitWritten,
        shapeProcessing: result.shapeProcessing,
      },
      transfer: [bytes.buffer as ArrayBuffer],
    };
  }

  // --- Internals -----------------------------------------------------------

  #require(operation: string): KernelModule {
    if (this.#module === null) {
      throw new KernelNotReadyError(operation);
    }
    return this.#module;
  }

  /**
   * Times an operation and stages its log record. This stage exists to measure
   * the boundary, so the log is a deliverable rather than a debugging aid -
   * which is why failures are recorded too.
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
      this.#pendingRecord = {
        operation,
        durationMs: performance.now() - started,
        status,
        wasmMemoryBytes: mod ? mod.HEAPU8.byteLength : 0,
      };
    }
  }

  #annotateRecord(extra: Partial<OperationRecord>): void {
    if (this.#pendingRecord !== undefined) {
      this.#pendingRecord = { ...this.#pendingRecord, ...extra };
    }
  }
}

/**
 * Runs one request and produces the response for it. Never throws: a failure is
 * a response, because a transport that can reject out-of-band would leave the
 * correlation map holding an entry nobody settles.
 */
export async function serve(
  handler: KernelHandler,
  envelope: KernelEnvelope,
): Promise<ServedResponse> {
  try {
    const outcome = await handler.handle(envelope.request);
    return {
      response: {
        id: envelope.id,
        ok: true,
        value: outcome.value,
        tail: handler.takeTail(),
      },
      transfer: outcome.transfer,
    };
  } catch (error) {
    return {
      response: {
        id: envelope.id,
        ok: false,
        error: toFailure(error, envelope.request.kind),
        tail: handler.takeTail(),
      },
      transfer: [],
    };
  }
}
