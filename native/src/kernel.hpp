#pragma once

#include <string>

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

KernelStats stats();
std::string occtVersion();

}  // namespace webcad
