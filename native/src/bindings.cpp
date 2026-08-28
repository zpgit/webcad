// embind surface for the kernel facade.
//
// Note what is absent: nothing here accepts or returns a shape, a face, a
// curve, or a surface. Bodies cross the boundary as uint32 handles, geometry
// facts cross as scalars and counts, and mesh data crosses as byte offsets into
// WASM linear memory. There is deliberately no operation that takes mesh
// buffers as geometric input - mesh is derived output only.
//
// Byte payloads are the only place exact geometry crosses, and they cross as
// opaque bytes: a payload JavaScript may store, measure, and hand back, but
// which nothing outside the kernel parses. There is deliberately no operation
// that decodes a payload into anything a caller can inspect, so the bytes
// cannot become a second geometry representation.
//
// There are two such payloads and the difference between them matters. A
// checkpoint is ours: the caller cannot construct one, only return one we
// wrote. A STEP payload is foreign - it comes off a user's disk, so nothing
// about it may be assumed - and it is admitted to translation only, never to a
// modeling operation. What holds for both is the outbound rule: translation
// consumes foreign bytes and still returns nothing but handles.

#include <vector>

#include <emscripten/bind.h>

#include "kernel.hpp"
#include "status.hpp"

using namespace emscripten;
using namespace webcad;

EMSCRIPTEN_BINDINGS(webcad_kernel) {
  // --- Results -------------------------------------------------------------

  value_object<OpResult>("OpResult")
      .field("status", &OpResult::status)
      .field("message", &OpResult::message)
      .field("bodyId", &OpResult::bodyId)
      .field("solidCount", &OpResult::solidCount);

  value_object<BodyInfo>("BodyInfo")
      .field("status", &BodyInfo::status)
      .field("message", &BodyInfo::message)
      .field("faceCount", &BodyInfo::faceCount)
      .field("edgeCount", &BodyInfo::edgeCount)
      .field("vertexCount", &BodyInfo::vertexCount)
      .field("solidCount", &BodyInfo::solidCount)
      .field("volume", &BodyInfo::volume)
      .field("area", &BodyInfo::area)
      .field("bboxMinX", &BodyInfo::bboxMinX)
      .field("bboxMinY", &BodyInfo::bboxMinY)
      .field("bboxMinZ", &BodyInfo::bboxMinZ)
      .field("bboxMaxX", &BodyInfo::bboxMaxX)
      .field("bboxMaxY", &BodyInfo::bboxMaxY)
      .field("bboxMaxZ", &BodyInfo::bboxMaxZ)
      .field("isValid", &BodyInfo::isValid)
      .field("isClosed", &BodyInfo::isClosed);

  value_object<FaceTypeSummary>("FaceTypeSummary")
      .field("status", &FaceTypeSummary::status)
      .field("message", &FaceTypeSummary::message)
      .field("plane", &FaceTypeSummary::plane)
      .field("cylinder", &FaceTypeSummary::cylinder)
      .field("cone", &FaceTypeSummary::cone)
      .field("sphere", &FaceTypeSummary::sphere)
      .field("torus", &FaceTypeSummary::torus)
      .field("bezier", &FaceTypeSummary::bezier)
      .field("bspline", &FaceTypeSummary::bspline)
      .field("revolution", &FaceTypeSummary::revolution)
      .field("extrusion", &FaceTypeSummary::extrusion)
      .field("other", &FaceTypeSummary::other);

  value_object<MeshResult>("MeshResult")
      .field("status", &MeshResult::status)
      .field("message", &MeshResult::message)
      .field("vertexCount", &MeshResult::vertexCount)
      .field("triangleCount", &MeshResult::triangleCount)
      .field("positionsPtr", &MeshResult::positionsPtr)
      .field("normalsPtr", &MeshResult::normalsPtr)
      .field("indicesPtr", &MeshResult::indicesPtr)
      .field("linearDeflection", &MeshResult::linearDeflection)
      .field("angularDeflection", &MeshResult::angularDeflection)
      .field("fromCache", &MeshResult::fromCache);

  value_object<StagingResult>("StagingResult")
      .field("status", &StagingResult::status)
      .field("message", &StagingResult::message)
      .field("dataPtr", &StagingResult::dataPtr)
      .field("byteLength", &StagingResult::byteLength);

  value_object<SerializeResult>("SerializeResult")
      .field("status", &SerializeResult::status)
      .field("message", &SerializeResult::message)
      .field("dataPtr", &SerializeResult::dataPtr)
      .field("byteLength", &SerializeResult::byteLength)
      .field("bodyCount", &SerializeResult::bodyCount)
      .field("format", &SerializeResult::format)
      .field("occtVersion", &SerializeResult::occtVersion);

  value_object<RestoreResult>("RestoreResult")
      .field("status", &RestoreResult::status)
      .field("message", &RestoreResult::message)
      .field("firstBodyId", &RestoreResult::firstBodyId)
      .field("bodyCount", &RestoreResult::bodyCount);

  value_object<StepImportResult>("StepImportResult")
      .field("status", &StepImportResult::status)
      .field("message", &StepImportResult::message)
      .field("firstBodyId", &StepImportResult::firstBodyId)
      .field("bodyCount", &StepImportResult::bodyCount)
      .field("rootShapeCount", &StepImportResult::rootShapeCount)
      .field("unregisteredShapeCount", &StepImportResult::unregisteredShapeCount)
      .field("openBodyIds", &StepImportResult::openBodyIds)
      .field("declaredUnit", &StepImportResult::declaredUnit)
      .field("workingUnit", &StepImportResult::workingUnit)
      .field("unitWasAssumed", &StepImportResult::unitWasAssumed)
      .field("namedProductCount", &StepImportResult::namedProductCount)
      .field("styledItemCount", &StepImportResult::styledItemCount)
      .field("assemblyNodeCount", &StepImportResult::assemblyNodeCount)
      .field("shapeProcessing", &StepImportResult::shapeProcessing)
      .field("payloadByteLength", &StepImportResult::payloadByteLength);

  value_object<StepExportResult>("StepExportResult")
      .field("status", &StepExportResult::status)
      .field("message", &StepExportResult::message)
      .field("dataPtr", &StepExportResult::dataPtr)
      .field("byteLength", &StepExportResult::byteLength)
      .field("bodyCount", &StepExportResult::bodyCount)
      .field("unitWritten", &StepExportResult::unitWritten)
      .field("shapeProcessing", &StepExportResult::shapeProcessing);

  value_object<KernelStats>("KernelStats")
      .field("liveBodyCount", &KernelStats::liveBodyCount)
      .field("totalBodiesCreated", &KernelStats::totalBodiesCreated)
      .field("cachedMeshCount", &KernelStats::cachedMeshCount)
      .field("wasmMemoryBytes", &KernelStats::wasmMemoryBytes)
      .field("wasmPeakMemoryBytes", &KernelStats::wasmPeakMemoryBytes)
      .field("meshCacheBytes", &KernelStats::meshCacheBytes);

  // --- Parameters ----------------------------------------------------------

  value_object<BoxParams>("BoxParams")
      .field("width", &BoxParams::width)
      .field("depth", &BoxParams::depth)
      .field("height", &BoxParams::height)
      .field("originX", &BoxParams::originX)
      .field("originY", &BoxParams::originY)
      .field("originZ", &BoxParams::originZ)
      .field("axisX", &BoxParams::axisX)
      .field("axisY", &BoxParams::axisY)
      .field("axisZ", &BoxParams::axisZ)
      .field("angle", &BoxParams::angle);

  value_object<CylinderParams>("CylinderParams")
      .field("radius", &CylinderParams::radius)
      .field("height", &CylinderParams::height)
      .field("originX", &CylinderParams::originX)
      .field("originY", &CylinderParams::originY)
      .field("originZ", &CylinderParams::originZ)
      .field("axisX", &CylinderParams::axisX)
      .field("axisY", &CylinderParams::axisY)
      .field("axisZ", &CylinderParams::axisZ);

  value_object<TessellationParams>("TessellationParams")
      .field("linearDeflection", &TessellationParams::linearDeflection)
      .field("angularDeflection", &TessellationParams::angularDeflection);

  // Shape processing is a caller-visible option rather than a library default,
  // because OCCT's default alters geometry in both directions and this stage
  // has to be able to measure with it off.
  value_object<StepTranslationOptions>("StepTranslationOptions")
      .field("shapeProcessing", &StepTranslationOptions::shapeProcessing);

  // The order of this list is the order bodies are written into a checkpoint,
  // and it is the caller's to decide: the registry stores shapes unordered, so
  // there is no kernel-side ordering a document could pin its identities to.
  register_vector<uint32_t>("BodyIdList");

  // --- Operations ----------------------------------------------------------

  function("createBox", &createBox);
  function("createCylinder", &createCylinder);
  function("booleanOp", &booleanOp);
  function("tessellate", &tessellate);
  function("releaseBody", &releaseBody);
  function("bodyInfo", &bodyInfo);
  function("faceTypeSummary", &faceTypeSummary);
  function("serializeBodies", &serializeBodies);
  function("reserveStaging", &reserveStaging);
  function("restoreBodies", &restoreBodies);
  function("discardStaging", &discardStaging);
  function("geometryFormat", &geometryFormat);
  // Both translation directions reuse the one staging buffer above: import
  // reads what the caller staged, export leaves its payload there to be copied
  // out. There is deliberately no second buffer for foreign bytes.
  function("importStep", &importStep);
  function("exportStep", &exportStep);
  function("stats", &stats);
  function("occtVersion", &occtVersion);

  // Exposed so the TypeScript layer's default matches the C++ default rather
  // than duplicating the constant.
  constant("defaultLinearDeflection", kDefaultLinearDeflection);
  constant("defaultAngularDeflection", kDefaultAngularDeflection);
}
