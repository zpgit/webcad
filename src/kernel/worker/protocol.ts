// The wire format between the main thread and the kernel Worker.
//
// Everything here is structured-clone-compatible. `src/kernel/types.ts` was
// already written to that constraint, so most of this is a thin tagging layer
// over types that already crossed the boundary in shape if not in fact.
//
// Two things do not survive a structured clone and are handled explicitly:
// typed errors, which arrive as `KernelFailure` and are revived on the far side
// (see `reviveFailure` in ../errors.ts), and typed-array views over WASM memory,
// which are copied into owned buffers and transferred.

import type {
  BodyInfo,
  BooleanKind,
  BoxOptions,
  CylinderOptions,
  FaceTypeSummary,
  KernelStats,
  MeshMeta,
  OperationRecord,
  StepExportReport,
  StepImportReport,
  StepTranslationOptions,
  TessellationOptions,
} from '../types.ts';

export type KernelRequest =
  | { readonly kind: 'init' }
  | { readonly kind: 'createBox'; readonly options: BoxOptions }
  | { readonly kind: 'createCylinder'; readonly options: CylinderOptions }
  | {
      readonly kind: 'boolean';
      readonly op: BooleanKind;
      readonly target: number;
      readonly tool: number;
    }
  | {
      readonly kind: 'tessellate';
      readonly bodyId: number;
      readonly options: TessellationOptions;
    }
  | { readonly kind: 'release'; readonly bodyId: number }
  | { readonly kind: 'bodyInfo'; readonly bodyId: number }
  | { readonly kind: 'faceTypeSummary'; readonly bodyId: number }
  | { readonly kind: 'serialize'; readonly bodyIds: readonly number[] }
  | { readonly kind: 'restore'; readonly payload: Uint8Array }
  | {
      readonly kind: 'importStep';
      readonly payload: Uint8Array;
      readonly options: StepTranslationOptions;
    }
  | {
      readonly kind: 'exportStep';
      readonly bodyIds: readonly number[];
      readonly options: StepTranslationOptions;
    }
  | { readonly kind: 'stats' };

/**
 * On the one-payload-in-flight invariant.
 *
 * The kernel owns a single staging buffer in either direction, and four request
 * kinds use it: `serialize`, `restore`, `importStep`, `exportStep`. Nothing here
 * guards it, because nothing needs to - it holds for two structural reasons
 * rather than by convention.
 *
 * First, requests are strictly serialized. Both transports chain every request
 * through one promise queue in arrival order (`transport.ts`,
 * `kernel-worker.ts`), so a second payload request cannot begin while a first
 * is running.
 *
 * Second, and more to the point, staging never spans a request. Each handler
 * reserves, writes, translates or reads, and discards within its own
 * synchronous call - on the failure path too. So there is no window in which a
 * payload is held and a different request could overwrite it.
 *
 * This is worth stating because the obvious reading of "one at a time" is that
 * someone must be counting. Nobody is, and a guard added to look careful would
 * be dead code that implies a race the design does not permit. If either
 * property above ever changes - a streaming translation that holds staging
 * across calls, say - this comment is the warning that the invariant went with
 * it. `tests/step-translation.test.ts` asserts it from the outside.
 */

export type RequestKind = KernelRequest['kind'];

/**
 * Buffers whose ownership moves to the handler with the request.
 *
 * Derived here rather than assembled by callers, so the inbound direction
 * cannot be given a payload and silently forget to transfer it. Every transport
 * asks the same question of the same function, which is what keeps the
 * in-process path honest about ownership rather than merely permissive.
 */
export function requestTransferables(request: KernelRequest): Transferable[] {
  // Both inbound payloads transfer on the same terms. The difference between a
  // checkpoint and a user's STEP file is what gets validated on the far side,
  // not how the bytes travel or who owns them afterwards.
  return request.kind === 'restore' || request.kind === 'importStep'
    ? [request.payload.buffer as ArrayBuffer]
    : [];
}

/** Build constants, read once during the handshake and cached by the caller. */
export interface InitResult {
  readonly occtVersion: string;
  readonly defaultLinearDeflection: number;
  readonly defaultAngularDeflection: number;
}

export interface BodyResult {
  readonly bodyId: number;
}

/**
 * `empty` crosses as a success, not a failure. A subtract that removes all
 * material is a legitimate result, and collapsing it into an error would make a
 * valid direct-modeling outcome look like a bug.
 */
export type BooleanResult =
  | { readonly kind: 'body'; readonly bodyId: number; readonly solidCount: number }
  | { readonly kind: 'empty'; readonly message: string };

/** Owned buffers, transferred to the receiver. Never views over WASM memory. */
export interface MeshPayload {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

export interface MeshResult {
  readonly mesh: MeshPayload;
  readonly meta: MeshMeta;
}

/**
 * An exact B-Rep payload, owned by the receiver and transferred to it.
 *
 * Unlike a mesh, these bytes ARE the geometry - which is why they are opaque.
 * Nothing outside the kernel parses them; the document layer stores them,
 * measures them, and hands them back.
 */
export interface SerializeResult {
  readonly bytes: Uint8Array;
  readonly bodyCount: number;
  readonly format: string;
  readonly occtVersion: string;
}

export interface RestoreResult {
  readonly bodyIds: readonly number[];
}

/**
 * A STEP translation's outcome.
 *
 * The import report carries no bytes - the payload was consumed - while the
 * export report carries an owned buffer that is transferred to the receiver, as
 * a serialization does. Both are opaque in the same sense: storable and
 * measurable, never parsed outside the kernel.
 */
export type StepImportResult = StepImportReport;
export type StepExportResult = StepExportReport;

/** Result type per request kind, so the proxy is checked rather than cast. */
export interface KernelResults {
  init: InitResult;
  createBox: BodyResult;
  createCylinder: BodyResult;
  boolean: BooleanResult;
  tessellate: MeshResult;
  release: null;
  bodyInfo: BodyInfo;
  faceTypeSummary: FaceTypeSummary;
  serialize: SerializeResult;
  restore: RestoreResult;
  importStep: StepImportResult;
  exportStep: StepExportResult;
  stats: KernelStats;
}

export type ResultFor<K extends RequestKind> = KernelResults[K];

/**
 * A failure, flattened for the wire.
 *
 * `code` is the discriminator - the same value carried by every `KernelError`
 * subclass - because an Error subclass structured-clones down to a plain Error
 * and loses its type. `stack` is the Worker-side stack, attached as `cause` on
 * the revived error so a trace is not lost at the thread boundary.
 */
export interface KernelFailure {
  readonly code: string;
  readonly message: string;
  readonly operation: string;
  readonly stack?: string;
}

/**
 * Scalars appended to every response.
 *
 * The measurement readout reads stats and the operation log synchronously, once
 * per frame. Piggybacking them costs about a dozen numbers per response - noise
 * next to a mesh - and avoids either a second round trip per frame or making the
 * readout async.
 */
export interface ResponseTail {
  readonly record?: OperationRecord;
  readonly stats?: KernelStats;
}

export interface KernelEnvelope {
  readonly id: number;
  readonly request: KernelRequest;
}

export type KernelResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly value: unknown;
      readonly tail: ResponseTail;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: KernelFailure;
      readonly tail: ResponseTail;
    };

/** A response plus the buffers whose ownership moves with it. */
export interface ServedResponse {
  readonly response: KernelResponse;
  readonly transfer: readonly Transferable[];
}
