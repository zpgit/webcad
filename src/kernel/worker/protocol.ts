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
  | { readonly kind: 'stats' };

export type RequestKind = KernelRequest['kind'];

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
