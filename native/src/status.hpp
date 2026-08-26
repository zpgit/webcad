#pragma once

#include <string>
#include <cstdint>

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
