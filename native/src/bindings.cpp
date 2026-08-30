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

#include <string>
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
      .field("faceRangesPtr", &MeshResult::faceRangesPtr)
      .field("faceRangeCount", &MeshResult::faceRangeCount)
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

  // An occurrence, as three plain values. Note what a caller cannot ask this
  // for: which label it came from, which STEP entity backs it, or any handle
  // to the tree it sits in. It knows its parent's position in a list and which
  // body it places, and the layer above builds a tree from that.
  value_object<StepInstance>("StepInstance")
      .field("parent", &StepInstance::parent)
      .field("part", &StepInstance::part)
      .field("name", &StepInstance::name)
      .field("hasColour", &StepInstance::hasColour)
      .field("colourR", &StepInstance::colourR)
      .field("colourG", &StepInstance::colourG)
      .field("colourB", &StepInstance::colourB);

  // A colour crosses as three numbers and a flag - never as a handle to a
  // colour, a style, or the entity that carried it.
  value_object<StepFaceColour>("StepFaceColour")
      .field("has", &StepFaceColour::has)
      .field("r", &StepFaceColour::r)
      .field("g", &StepFaceColour::g)
      .field("b", &StepFaceColour::b);

  value_object<StepPart>("StepPart")
      .field("name", &StepPart::name)
      .field("hasColour", &StepPart::hasColour)
      .field("colourR", &StepPart::colourR)
      .field("colourG", &StepPart::colourG)
      .field("colourB", &StepPart::colourB)
      .field("faceCount", &StepPart::faceCount)
      .field("faceColourStart", &StepPart::faceColourStart)
      .field("colouredFaceCount", &StepPart::colouredFaceCount);

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
      .field("droppedLayerCount", &StepImportResult::droppedLayerCount)
      .field("droppedMaterialCount", &StepImportResult::droppedMaterialCount)
      .field("droppedGeometricToleranceCount",
             &StepImportResult::droppedGeometricToleranceCount)
      .field("droppedDimensionCount", &StepImportResult::droppedDimensionCount)
      .field("structureRequested", &StepImportResult::structureRequested)
      .field("structurePresent", &StepImportResult::structurePresent)
      .field("instances", &StepImportResult::instances)
      .field("placements", &StepImportResult::placements)
      .field("parts", &StepImportResult::parts)
      .field("faceColours", &StepImportResult::faceColours)
      .field("treeDepth", &StepImportResult::treeDepth)
      .field("groupingNodeCount", &StepImportResult::groupingNodeCount)
      .field("namedInstanceCount", &StepImportResult::namedInstanceCount)
      .field("namedPartCount", &StepImportResult::namedPartCount)
      .field("colouredPartCount", &StepImportResult::colouredPartCount)
      .field("colouredInstanceCount", &StepImportResult::colouredInstanceCount)
      .field("colouredFaceCount", &StepImportResult::colouredFaceCount)
      .field("unresolvedInstanceCount", &StepImportResult::unresolvedInstanceCount)
      .field("shapeProcessing", &StepImportResult::shapeProcessing)
      .field("payloadByteLength", &StepImportResult::payloadByteLength);

  // The same records an import returns, handed back. A structure is plain data
  // in both directions and there is deliberately no second encoding for the way
  // in - two encodings would be two things to keep in step.
  value_object<StepStructure>("StepStructure")
      .field("instances", &StepStructure::instances)
      .field("placements", &StepStructure::placements)
      .field("parts", &StepStructure::parts)
      .field("faceColours", &StepStructure::faceColours);

  value_object<StepExportResult>("StepExportResult")
      .field("status", &StepExportResult::status)
      .field("message", &StepExportResult::message)
      .field("dataPtr", &StepExportResult::dataPtr)
      .field("byteLength", &StepExportResult::byteLength)
      .field("bodyCount", &StepExportResult::bodyCount)
      .field("unitWritten", &StepExportResult::unitWritten)
      .field("shapeProcessing", &StepExportResult::shapeProcessing)
      .field("wroteStructure", &StepExportResult::wroteStructure)
      .field("instanceCount", &StepExportResult::instanceCount)
      .field("groupingNodeCount", &StepExportResult::groupingNodeCount)
      .field("fabricatedNodeCount", &StepExportResult::fabricatedNodeCount)
      .field("namedPartCount", &StepExportResult::namedPartCount)
      .field("namedInstanceCount", &StepExportResult::namedInstanceCount)
      .field("colouredPartCount", &StepExportResult::colouredPartCount)
      .field("colouredInstanceCount", &StepExportResult::colouredInstanceCount)
      .field("colouredFaceCount", &StepExportResult::colouredFaceCount)
      .field("assemblyMode", &StepExportResult::assemblyMode);

  value_object<KernelStats>("KernelStats")
      .field("liveBodyCount", &KernelStats::liveBodyCount)
      .field("totalBodiesCreated", &KernelStats::totalBodiesCreated)
      .field("cachedMeshCount", &KernelStats::cachedMeshCount)
      .field("wasmMemoryBytes", &KernelStats::wasmMemoryBytes)
      .field("wasmPeakMemoryBytes", &KernelStats::wasmPeakMemoryBytes)
      .field("meshCacheBytes", &KernelStats::meshCacheBytes)
      .field("openTranslationDocuments", &KernelStats::openTranslationDocuments);

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
      .field("shapeProcessing", &StepTranslationOptions::shapeProcessing)
      .field("structure", &StepTranslationOptions::structure);

  // The order of this list is the order bodies are written into a checkpoint,
  // and it is the caller's to decide: the registry stores shapes unordered, so
  // there is no kernel-side ordering a document could pin its identities to.
  register_vector<uint32_t>("BodyIdList");

  // Structure crosses as three flat lists rather than as a tree of objects.
  //
  // Every one of these is heap-backed and has to be freed by the caller, which
  // is the argument for there being three of them and not one per occurrence:
  // a placement held inside StepInstance would make each occurrence its own
  // vector to release, turning a leak from something you avoid once into
  // something you avoid N times. The lists are read in lockstep - instance i
  // owns placements[12*i .. 12*i+11] - and nothing in them is a reference to
  // anything the kernel still holds.
  register_vector<StepInstance>("StepInstanceList");
  register_vector<double>("PlacementList");
  register_vector<StepPart>("StepPartList");
  register_vector<StepFaceColour>("StepFaceColourList");

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
