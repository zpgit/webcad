#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "status.hpp"

namespace webcad {

// Documented tessellation defaults, applied when a caller omits a tolerance.
// Reported back in MeshResult so the applied value is never implicit.
constexpr double kDefaultLinearDeflection = 0.1;
constexpr double kDefaultAngularDeflection = 0.35;  // radians, ~20 degrees

struct BoxParams {
  double width = 0.0;
  double depth = 0.0;
  double height = 0.0;

  // Placement: the box's minimum corner, then a rotation of `angle` radians
  // about the axis (axisX, axisY, axisZ) through that corner.
  double originX = 0.0, originY = 0.0, originZ = 0.0;
  double axisX = 0.0, axisY = 0.0, axisZ = 1.0;
  double angle = 0.0;
};

struct CylinderParams {
  double radius = 0.0;
  double height = 0.0;

  // Placement: base-circle centre and the direction the axis extrudes along.
  double originX = 0.0, originY = 0.0, originZ = 0.0;
  double axisX = 0.0, axisY = 0.0, axisZ = 1.0;
};

struct TessellationParams {
  // Non-positive means "use the documented default". A caller cannot express
  // an unbounded tessellation: an explicitly non-positive value is rejected by
  // the wrapper before reaching here.
  double linearDeflection = 0.0;
  double angularDeflection = 0.0;
};

enum class BooleanKind : int32_t {
  Union = 0,
  Subtract = 1,
  Intersect = 2,
};

// --- Operations ------------------------------------------------------------
// Every entry point catches all exceptions and reports a status. None throws.

OpResult createBox(const BoxParams& p);
OpResult createCylinder(const CylinderParams& p);

// target and tool remain valid after the call. The operation never implicitly
// releases its operands, so callers can retain, reuse, or release them.
OpResult booleanOp(uint32_t targetId, uint32_t toolId, int32_t kind);

MeshResult tessellate(uint32_t bodyId, const TessellationParams& p);

// Frees the body and evicts its cached meshes. Reports InvalidHandle for an
// unknown or already-released handle.
OpResult releaseBody(uint32_t bodyId);

BodyInfo bodyInfo(uint32_t bodyId);
FaceTypeSummary faceTypeSummary(uint32_t bodyId);

// --- Serialization ---------------------------------------------------------

// Writes the given bodies, in the order given, into one payload staged in WASM
// memory.
//
// The order is the caller's: the registry stores shapes in an unordered map, so
// there is no kernel-side ordering worth persisting, and a document must be
// able to pin the mapping between its own body identities and positions in the
// payload.
//
// All bodies go into a single TopoDS_Compound as direct children, written once.
// Shared underlying geometry is therefore written once rather than per body,
// and there is one stream to version and checksum instead of N.
//
// Triangulation is deliberately excluded. Mesh is not the geometric source of
// truth, so persisting it would inflate a checkpoint with data that is derived,
// tolerance-specific, and cheap to regenerate - and would make checkpoint size
// depend on whether a body happened to have been displayed.
//
// Every handle is resolved before anything is written, so a set containing an
// unknown handle fails with InvalidHandle having produced no partial payload.
// Serialization does not release, mutate, or otherwise disturb its inputs.
SerializeResult serializeBodies(const std::vector<uint32_t>& bodyIds);

// Reserves the staging buffer so a caller can write a payload into WASM memory
// before restoring it. Returns the offset to write at.
//
// This call can grow the heap, so any JavaScript view over WASM memory must be
// taken after it returns, never before.
StagingResult reserveStaging(uint32_t byteLength);

// Restores the bodies in the staged payload, issuing a handle for each.
//
// All-or-nothing: if any part of the payload cannot be read, or any body in it
// is unusable, nothing is registered and no handle is issued. The kernel stays
// usable and the live-handle count is unchanged.
RestoreResult restoreBodies();

// Frees the staging buffer. Callers should discard once they have copied a
// serialization out or finished a restoration, so a large checkpoint is not
// held for the rest of the session.
void discardStaging();

// The encoding serializeBodies writes, as recorded in a document manifest.
std::string geometryFormat();

// --- STEP translation ------------------------------------------------------

struct StepTranslationOptions {
  // OCCT does not translate STEP untouched. Its reader runs ShapeFix and its
  // writer runs SplitCommonVertex and DirectFaces by default, and both change
  // the topology and geometry that cross the boundary.
  //
  // Defaulted OFF here, which is not OCCT's default and is deliberate: a repair
  // pass is indistinguishable in the result from a translation loss, so leaving
  // it on would make this stage's primary measurement unattributable. Whichever
  // setting the fidelity comparison recommends becomes the application's, and
  // the result reports which operations actually ran either way.
  bool shapeProcessing = false;

  // Read product structure through XCAF rather than shapes alone.
  //
  // Off is MVP-2's behaviour exactly: STEPControl_Reader, top-level shapes,
  // compounds flattened, no tree. It stays reachable because a caller that
  // wants the geometry of an assembly and nothing else should not have to pay
  // for a document it will discard, and because a flat import is a supported
  // operation rather than a degenerate assembly.
  //
  // Defaulted off so that adding this field changed no existing behaviour. The
  // application's default is the TypeScript layer's to choose and is not this
  // one - embind requires every field of a value object to be supplied anyway,
  // so a JavaScript caller never inherits this.
  bool structure = false;
};

// Translates the staged payload into bodies, issuing a handle for each.
//
// The payload is staged exactly as a checkpoint is - reserveStaging, write,
// then this call - reusing the single staging buffer rather than adding a
// second. Unlike a checkpoint these bytes are foreign: the caller obtained them
// from outside this system, so nothing about them may be trusted, and the
// difference is in what is validated, not in how they arrive.
//
// All-or-nothing: if the payload cannot be read, or produces no usable shape,
// nothing is registered and no handle is issued. Bodies that existed before the
// call are untouched in every outcome.
//
// A shape that is not a valid closed solid is still registered - real STEP data
// contains open shells - and is reported in openBodyIds. Refusing them would
// turn a fidelity finding into an import failure, which reports nothing.
StepImportResult importStep(const StepTranslationOptions& options);

// Writes the given bodies' current geometry into a STEP payload staged in WASM
// memory.
//
// What is written is the canonical B-Rep as it stands now, so a body edited
// after it was imported exports with the edit in it. Nothing is tessellated or
// approximated on the way out: an export is exact geometry in an interchange
// format, not a mesh.
//
// As with serializeBodies, every handle is resolved before anything is written,
// so a set containing an unknown handle fails having produced no payload, and
// the inputs are neither released nor mutated.
//
// The structure is plain data and is optional: an empty instance list writes
// the bodies flat, and no structure is invented for them. A structure that does
// not resolve - an instance naming a body outside the set, a parent that does
// not precede its child, a placement that is not 12 finite numbers - is refused
// before a byte is written, naming the defect.
StepExportResult exportStep(const std::vector<uint32_t>& bodyIds,
                            const StepStructure& structure,
                            const StepTranslationOptions& options);

KernelStats stats();
std::string occtVersion();

}  // namespace webcad
