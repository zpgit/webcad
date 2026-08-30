// Shape of the raw embind module. Mirrors native/src/bindings.cpp.
//
// Nothing in this file is part of the public kernel API - callers use Kernel in
// kernel.ts. These types exist so the wrapper is checked against the real
// binding surface rather than `any`.

export interface RawOpResult {
  status: number;
  message: string;
  bodyId: number;
  solidCount: number;
}

export interface RawBodyInfo {
  status: number;
  message: string;
  faceCount: number;
  edgeCount: number;
  vertexCount: number;
  solidCount: number;
  volume: number;
  area: number;
  bboxMinX: number;
  bboxMinY: number;
  bboxMinZ: number;
  bboxMaxX: number;
  bboxMaxY: number;
  bboxMaxZ: number;
  isValid: boolean;
  isClosed: boolean;
}

export interface RawFaceTypeSummary {
  status: number;
  message: string;
  plane: number;
  cylinder: number;
  cone: number;
  sphere: number;
  torus: number;
  bezier: number;
  bspline: number;
  revolution: number;
  extrusion: number;
  other: number;
}

export interface RawMeshResult {
  status: number;
  message: string;
  vertexCount: number;
  triangleCount: number;
  positionsPtr: number;
  normalsPtr: number;
  indicesPtr: number;
  linearDeflection: number;
  angularDeflection: number;
  fromCache: boolean;
}

export interface RawStagingResult {
  status: number;
  message: string;
  dataPtr: number;
  byteLength: number;
}

export interface RawSerializeResult {
  status: number;
  message: string;
  dataPtr: number;
  byteLength: number;
  bodyCount: number;
  format: string;
  occtVersion: string;
}

export interface RawRestoreResult {
  status: number;
  message: string;
  firstBodyId: number;
  bodyCount: number;
}

/**
 * An embind `std::vector<uint32_t>`.
 *
 * Owned by the caller on the JavaScript side: embind allocates it in WASM
 * memory and nothing frees it implicitly, so `delete()` is not optional.
 */
export interface RawBodyIdList {
  push_back(value: number): void;
  size(): number;
  delete(): void;
}

export interface RawKernelStats {
  liveBodyCount: number;
  totalBodiesCreated: number;
  cachedMeshCount: number;
  wasmMemoryBytes: number;
  wasmPeakMemoryBytes: number;
  meshCacheBytes: number;
}

export interface RawBoxParams {
  width: number;
  depth: number;
  height: number;
  originX: number;
  originY: number;
  originZ: number;
  axisX: number;
  axisY: number;
  axisZ: number;
  angle: number;
}

export interface RawCylinderParams {
  radius: number;
  height: number;
  originX: number;
  originY: number;
  originZ: number;
  axisX: number;
  axisY: number;
  axisZ: number;
}

export interface RawTessellationParams {
  linearDeflection: number;
  angularDeflection: number;
}

export interface RawStepTranslationOptions {
  shapeProcessing: boolean;
  structure: boolean;
}

/**
 * `openBodyIds` arrives as an embind vector, not a JavaScript array: it is
 * backed by WASM memory and has to be read and freed like `BodyIdList`.
 */
export interface RawStepImportResult {
  status: number;
  message: string;
  firstBodyId: number;
  bodyCount: number;
  rootShapeCount: number;
  unregisteredShapeCount: number;
  openBodyIds: RawBodyIdList & { get(index: number): number | undefined };
  declaredUnit: string;
  workingUnit: string;
  unitWasAssumed: boolean;
  namedProductCount: number;
  styledItemCount: number;
  assemblyNodeCount: number;
  shapeProcessing: string;
  payloadByteLength: number;
}

export interface RawStepExportResult {
  status: number;
  message: string;
  dataPtr: number;
  byteLength: number;
  bodyCount: number;
  unitWritten: string;
  shapeProcessing: string;
}

export interface KernelModule {
  createBox(params: RawBoxParams): RawOpResult;
  createCylinder(params: RawCylinderParams): RawOpResult;
  booleanOp(targetId: number, toolId: number, kind: number): RawOpResult;
  tessellate(bodyId: number, params: RawTessellationParams): RawMeshResult;
  releaseBody(bodyId: number): RawOpResult;
  bodyInfo(bodyId: number): RawBodyInfo;
  faceTypeSummary(bodyId: number): RawFaceTypeSummary;
  stats(): RawKernelStats;
  occtVersion(): string;

  // Serialization. The payload is staged in WASM memory and addressed by byte
  // offset, exactly as mesh data is, and the same rule applies: read it in one
  // synchronous block and never retain the view.
  readonly BodyIdList: new () => RawBodyIdList;
  serializeBodies(bodyIds: RawBodyIdList): RawSerializeResult;
  reserveStaging(byteLength: number): RawStagingResult;
  restoreBodies(): RawRestoreResult;
  discardStaging(): void;
  geometryFormat(): string;

  // STEP translation reuses the staging buffer above rather than adding a
  // second: import reads what the caller staged, export leaves its payload
  // there to be copied out. The bytes going in are foreign - they came off a
  // user's disk - so nothing about them is assumed here.
  importStep(options: RawStepTranslationOptions): RawStepImportResult;
  exportStep(
    bodyIds: RawBodyIdList,
    options: RawStepTranslationOptions,
  ): RawStepExportResult;

  // IMPORTANT: Emscripten replaces these views whenever linear memory grows.
  // They must be read fresh at every use and never cached - a retained view
  // points into a detached ArrayBuffer and throws on access.
  readonly HEAPF32: Float32Array;
  readonly HEAPU32: Uint32Array;
  readonly HEAPU8: Uint8Array;

  readonly defaultLinearDeflection: number;
  readonly defaultAngularDeflection: number;
}

export type KernelModuleFactory = () => Promise<KernelModule>;
