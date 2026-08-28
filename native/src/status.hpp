#pragma once

#include <string>
#include <cstdint>
#include <vector>

// Status convention for every facade entry point.
//
// The design requires that no C++ exception escape the WASM boundary: an
// uncaught exception can leave the module unusable, which would violate the
// requirement that the kernel remain usable after a failed operation. Every
// entry point therefore returns a status value rather than throwing, and the
// TypeScript layer maps these onto typed errors.
namespace webcad {

enum class Status : int32_t {
  // The operation succeeded.
  Ok = 0,

  // A handle was never issued by this kernel instance, or has been released.
  InvalidHandle = 1,

  // A caller-supplied parameter was rejected before any geometry work began.
  InvalidParameter = 2,

  // The underlying OCCT algorithm failed. The kernel remains usable and any
  // operand handles remain valid.
  KernelOperationFailed = 3,

  // The operation completed and legitimately produced no geometry. This is
  // deliberately NOT an error: the specs require callers to distinguish
  // "no geometry" from "operation failed", because conflating them would make
  // a valid direct-modeling outcome look like a bug.
  EmptyResult = 4,

  // A foreign interchange payload could not be translated: it was not the
  // format it claimed, was truncated, or the writer could not express the
  // geometry it was given.
  //
  // Distinct from KernelOperationFailed, which means a geometry algorithm
  // failed on data this kernel produced. This one is ordinarily the user's
  // file being wrong, which is a different thing to report and a different
  // thing to act on - the application can say "that is not a STEP file"
  // instead of "something went wrong".
  TranslationFailed = 5,
};

// Result of an operation that produces a body.
struct OpResult {
  int32_t status = static_cast<int32_t>(Status::Ok);
  std::string message;

  // Valid only when status == Ok.
  uint32_t bodyId = 0;

  // Number of solids in the result. Exposed directly so the disjoint-union
  // case is observable as a multi-solid success rather than inferred.
  uint32_t solidCount = 0;
};

// Scalar and count information about a body. Deliberately carries no topology,
// curve, or surface structures - those never cross the boundary.
struct BodyInfo {
  int32_t status = static_cast<int32_t>(Status::Ok);
  std::string message;

  uint32_t faceCount = 0;
  uint32_t edgeCount = 0;
  uint32_t vertexCount = 0;
  uint32_t solidCount = 0;

  double volume = 0.0;
  double area = 0.0;

  double bboxMinX = 0.0, bboxMinY = 0.0, bboxMinZ = 0.0;
  double bboxMaxX = 0.0, bboxMaxY = 0.0, bboxMaxZ = 0.0;

  bool isValid = false;
  bool isClosed = false;
};

// Counts of faces by underlying surface type.
//
// Reported as a summary rather than per-face so that inspecting geometry does
// not require positional face indices. Section 7 of the architecture note is
// explicit that positional references like Face_17 are unacceptable, and MVP-0
// has no persistent naming to offer instead - so the facade declines to mint
// them even for inspection. This is sufficient to verify that a cylinder's
// lateral surface is an exact cylinder and that Boolean results preserve
// analytic surfaces.
struct FaceTypeSummary {
  int32_t status = static_cast<int32_t>(Status::Ok);
  std::string message;

  uint32_t plane = 0;
  uint32_t cylinder = 0;
  uint32_t cone = 0;
  uint32_t sphere = 0;
  uint32_t torus = 0;
  uint32_t bezier = 0;
  uint32_t bspline = 0;
  uint32_t revolution = 0;
  uint32_t extrusion = 0;
  uint32_t other = 0;
};

// Tessellation output.
//
// The pointers address buffers owned by the kernel-side mesh cache. JavaScript
// creates typed-array views over WASM memory at these offsets and uploads them
// straight to the GPU. Those views MUST NOT be stored: when WASM linear memory
// grows, its backing ArrayBuffer is detached and every existing view becomes
// unusable.
struct MeshResult {
  int32_t status = static_cast<int32_t>(Status::Ok);
  std::string message;

  uint32_t vertexCount = 0;
  uint32_t triangleCount = 0;

  // Byte offsets into WASM linear memory.
  uint32_t positionsPtr = 0;  // float32 x 3 x vertexCount
  uint32_t normalsPtr = 0;    // float32 x 3 x vertexCount
  uint32_t indicesPtr = 0;    // uint32  x 3 x triangleCount

  // The tolerance actually applied, so a caller that omitted one can see the
  // default that was used.
  double linearDeflection = 0.0;
  double angularDeflection = 0.0;

  // True when served from the mesh cache without re-running the mesher.
  // Reported explicitly rather than inferred from timing.
  bool fromCache = false;
};

// A byte payload staged in WASM memory for crossing the boundary.
//
// The kernel owns exactly one staging buffer at a time, in both directions: a
// serialization writes into it and JavaScript copies out; a restoration has
// JavaScript write into it and the kernel reads. The buffer stays valid until
// the next staging call or an explicit discard.
//
// As with MeshResult, dataPtr is a byte offset into WASM linear memory and any
// JavaScript view over it MUST NOT be stored. Reserving a buffer can itself
// grow the heap, which detaches every existing view, so a caller must take its
// view after the call that hands it the offset - never before.
struct StagingResult {
  int32_t status = static_cast<int32_t>(Status::Ok);
  std::string message;

  uint32_t dataPtr = 0;
  uint32_t byteLength = 0;
};

// Result of serializing bodies to an exact B-Rep payload.
//
// The bytes are exact geometry, not a mesh, and they are opaque: JavaScript may
// store, measure, and hand them back, but nothing outside the kernel parses
// them. The encoding and the OCCT version that wrote it are reported rather
// than left to be inferred, so a document can record both and a later reader
// never has to sniff the format.
struct SerializeResult {
  int32_t status = static_cast<int32_t>(Status::Ok);
  std::string message;

  // Valid until the next staging call or discardStaging().
  uint32_t dataPtr = 0;
  uint32_t byteLength = 0;

  uint32_t bodyCount = 0;

  std::string format;
  std::string occtVersion;
};

// Result of translating a STEP payload into bodies.
//
// Everything here is a count, a scalar, or a name. No STEP entity, product
// node, or attribute record crosses the boundary: a caller learns what arrived
// the same way it learns about a body it created, and cannot reach the
// interchange representation behind it.
//
// Handles are reported as a first identifier and a count, as in RestoreResult,
// and for the same verified reason: the registry issues them consecutively.
struct StepImportResult {
  int32_t status = static_cast<int32_t>(Status::Ok);
  std::string message;

  uint32_t firstBodyId = 0;
  uint32_t bodyCount = 0;

  // What the file offered against what became a body. A root the reader
  // declared but that could not be registered is counted rather than dropped
  // silently, so "the file had more in it than this" is always visible.
  uint32_t rootShapeCount = 0;
  uint32_t unregisteredShapeCount = 0;

  // Bodies that were registered but are not valid closed solids - open shells
  // and shapes that fail BRepCheck, which real STEP data contains. They are
  // usable bodies; an operation that needs a solid will fail on its own terms.
  // Flagged here so a caller knows before it tries.
  std::vector<uint32_t> openBodyIds;

  // Units. declaredUnit is what the file said, workingUnit is what the bodies
  // are expressed in, and the conversion between them happened here - once, at
  // the boundary. An empty declaredUnit with unitWasAssumed set means the file
  // declared nothing determinable and workingUnit was assumed in its place.
  std::string declaredUnit;
  std::string workingUnit;
  bool unitWasAssumed = false;

  // STEP semantics this stage does not preserve, counted so the loss is stated
  // rather than discovered. Preserving them needs XCAF and is MVP-3's.
  uint32_t namedProductCount = 0;
  uint32_t styledItemCount = 0;
  uint32_t assemblyNodeCount = 0;

  // Shape-processing operations that actually ran, comma-separated, empty when
  // none did. OCCT runs FixShape on read by default; a measurement cannot
  // attribute a difference to translation unless it knows whether this ran.
  std::string shapeProcessing;

  // The payload's length, so translation cost can be related to input size
  // without the caller having to remember what it staged.
  uint32_t payloadByteLength = 0;
};

// Result of translating bodies into a STEP payload.
//
// As with SerializeResult the bytes are opaque - storable, measurable, and
// returnable, but not parseable outside the kernel. Unlike a checkpoint they
// are a published interchange format, which is exactly why they are an export
// and not the native document.
struct StepExportResult {
  int32_t status = static_cast<int32_t>(Status::Ok);
  std::string message;

  // Valid until the next staging call or discardStaging().
  uint32_t dataPtr = 0;
  uint32_t byteLength = 0;

  uint32_t bodyCount = 0;

  // The unit the payload declares, reported rather than left implicit.
  std::string unitWritten;

  // As StepImportResult::shapeProcessing. OCCT's writer runs SplitCommonVertex
  // and DirectFaces by default, and both change what the file describes.
  std::string shapeProcessing;
};

// Result of restoring bodies from a payload.
//
// Handles are reported as a first identifier and a count rather than a list,
// because the registry issues them consecutively and in the order the payload
// stores them. restoreBodies verifies that rather than trusting it, so the
// caller can rely on bodyId = firstBodyId + i addressing the i-th body.
struct RestoreResult {
  int32_t status = static_cast<int32_t>(Status::Ok);
  std::string message;

  uint32_t firstBodyId = 0;
  uint32_t bodyCount = 0;
};

// Kernel-wide statistics.
struct KernelStats {
  uint32_t liveBodyCount = 0;
  uint32_t totalBodiesCreated = 0;
  uint32_t cachedMeshCount = 0;

  // Bytes of WASM linear memory currently and at its observed peak.
  double wasmMemoryBytes = 0.0;
  double wasmPeakMemoryBytes = 0.0;

  // Bytes held by the mesh cache.
  double meshCacheBytes = 0.0;
};

}  // namespace webcad
