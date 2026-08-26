// Public kernel types.
//
// Every value here is postMessage-compatible: handles are integers, parameters
// are plain objects, mesh data is transferable buffers. That is deliberate -
// the architecture note leaves the Worker question open, and MVP-0's
// measurements are meant to answer it. Keeping the surface transferable means
// that answer changes only the transport, not every call site.

declare const bodyIdBrand: unique symbol;

/**
 * An opaque handle to a canonical B-Rep body living in WASM memory.
 *
 * Branded so a raw number cannot be passed by accident. It carries no topology,
 * curve, or surface data - exact geometry never crosses into JavaScript.
 */
export type BodyId = number & { readonly [bodyIdBrand]: true };

export function asBodyId(raw: number): BodyId {
  return raw as BodyId;
}

/** Placement shared by the primitives: a position plus an axis. */
export interface Placement {
  origin?: readonly [number, number, number];
  axis?: readonly [number, number, number];
}

export interface BoxOptions extends Placement {
  width: number;
  depth: number;
  height: number;
  /** Rotation about `axis` through `origin`, in radians. */
  angle?: number;
}

export interface CylinderOptions extends Placement {
  radius: number;
  height: number;
}

export interface TessellationOptions {
  /** Maximum linear deviation from the exact surface. Must be positive. */
  linearDeflection?: number;
  /** Maximum angular deviation, in radians. Must be positive. */
  angularDeflection?: number;
}

export type BooleanKind = 'union' | 'subtract' | 'intersect';

/**
 * The outcome of a Boolean operation.
 *
 * `empty` is a success, not a failure: subtracting a tool that fully encloses
 * the target, or intersecting disjoint solids, legitimately produces no
 * geometry. Modelling that as an error would make a valid direct-modeling
 * result look like a bug.
 */
export type BooleanOutcome =
  | { readonly kind: 'body'; readonly bodyId: BodyId; readonly solidCount: number }
  | { readonly kind: 'empty'; readonly message: string };

export interface BodyInfo {
  readonly faceCount: number;
  readonly edgeCount: number;
  readonly vertexCount: number;
  readonly solidCount: number;
  readonly volume: number;
  readonly area: number;
  readonly boundingBox: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly isValid: boolean;
  readonly isClosed: boolean;
}

/**
 * Counts of faces by underlying surface type.
 *
 * Reported as a summary rather than per-face, so inspecting a body never
 * requires a positional face index. Section 7 of the architecture note is
 * explicit that references like `Face_17` are unacceptable, and MVP-0 has no
 * persistent naming to offer instead.
 */
export interface FaceTypeSummary {
  readonly plane: number;
  readonly cylinder: number;
  readonly cone: number;
  readonly sphere: number;
  readonly torus: number;
  readonly bezier: number;
  readonly bspline: number;
  readonly revolution: number;
  readonly extrusion: number;
  readonly other: number;
}

/** Metadata about a tessellation; safe to retain. */
export interface MeshMeta {
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly linearDeflection: number;
  readonly angularDeflection: number;
  /** True when served from the mesh cache without re-running the mesher. */
  readonly fromCache: boolean;
}

/**
 * Mesh data the caller owns.
 *
 * These are copies made kernel-side and handed over, never views into WASM
 * linear memory: the module lives behind the transport, so nothing on this side
 * can alias its heap. They stay valid for as long as the caller keeps them,
 * including across operations that grow WASM memory.
 */
export interface MeshBuffers {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * Exact B-Rep, serialized.
 *
 * The one form in which exact geometry leaves WASM, and it leaves opaque: store
 * these bytes, measure them, hash them, hand them back to `restore` - but do
 * not parse them. Parsing would mean a second geometry representation living
 * outside the kernel, which is the thing the whole boundary exists to prevent.
 *
 * `format` and `occtVersion` describe what wrote the payload. They are reported
 * rather than left to be inferred so a document can record both, and so a
 * failure to read a payload written by a different build is attributable
 * instead of mysterious.
 */
export interface BrepPayload {
  readonly bytes: Uint8Array;
  readonly bodyCount: number;
  readonly format: string;
  readonly occtVersion: string;
}

export interface KernelStats {
  readonly liveBodyCount: number;
  readonly totalBodiesCreated: number;
  readonly cachedMeshCount: number;
  readonly wasmMemoryBytes: number;
  readonly wasmPeakMemoryBytes: number;
  readonly meshCacheBytes: number;
}

/** One entry in the operation log. Recorded for failures as well as successes. */
export interface OperationRecord {
  readonly operation: string;
  /**
   * Kernel-side execution time: the OCCT work itself, measured where the module
   * lives. Deliberately not the caller's round trip - see `roundTripMs`.
   */
  readonly durationMs: number;
  readonly status: number;
  readonly wasmMemoryBytes: number;
  /** Present when the operation produced or consumed a mesh. */
  readonly triangleCount?: number;
  /**
   * Round trip as the caller observed it. `roundTripMs - durationMs` is what
   * hosting the kernel off the main thread costs, which is the figure this
   * stage exists to produce rather than assume.
   */
  readonly roundTripMs?: number;
  /**
   * Bytes moved across the boundary, when the operation moved any: a mesh
   * coming out, or a serialized payload going either way.
   */
  readonly transferBytes?: number;
  /**
   * Cost of the copy between WASM memory and a transferable buffer - out of it
   * for a mesh or a serialization, into it for a restoration.
   */
  readonly copyMs?: number;
}
