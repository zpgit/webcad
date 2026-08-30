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

  // Which slice of the index buffer each face contributed: uint32 pairs of
  // (indexOffset, indexCount), one pair per face in TopExp_Explorer order.
  //
  // This is how a per-face attribute reaches the renderer without a face ever
  // being named. The ranges tile the index buffer exactly - no gap, no overlap,
  // verified rather than intended - so a colour list in the same order can be
  // applied by walking the two together. Nothing here is a face identity: an
  // offset into a buffer is meaningless the moment the buffer is regenerated,
  // which is precisely the property that keeps it from becoming a reference.
  uint32_t faceRangesPtr = 0;  // uint32 x 2 x faceRangeCount

  // Faces the mesher VISITED, which is not always the number that emitted
  // geometry: a face whose triangulation is absent still gets a range, with a
  // count of zero. Counting only the productive faces would shift every later
  // face's position by one and silently mis-key every attribute after it.
  uint32_t faceRangeCount = 0;

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

// One occurrence in an imported assembly.
//
// Everything here is an index, a number, or text. There is no label, no STEP
// entity, and nothing that can be resolved back into the translator's scratch
// document - which is what lets the document layer own structure outright
// while the kernel stays stateless about it.
struct StepInstance {
  // Index into the same result's instance list, or -1 for a root. A parent
  // always precedes its children, so the tree can be rebuilt in one pass
  // without a second lookup.
  int32_t parent = -1;

  // Index into the registered bodies: the body is firstBodyId + part. -1 means
  // a grouping node - an assembly that carries no shape of its own, which real
  // files contain and a tree that could not represent one would have to
  // flatten away.
  int32_t part = -1;

  // The colour the file gave THIS occurrence, as sRGB in 0..1.
  //
  // Set only for a genuine component reference. At a root the occurrence and
  // the part are the same label, so reading a colour there would report the
  // part's own colour as an occurrence override and destroy the distinction
  // this field exists to keep.
  bool hasColour = false;
  double colourR = 0.0, colourG = 0.0, colourB = 0.0;

  // The name the file gave THIS occurrence, empty when it gave none.
  //
  // Deliberately not defaulted to the part's name. The two are different facts,
  // the part's own name travels in partNames, and a display that wants to fall
  // back can - but a translation that falls back has destroyed the difference
  // before anyone could see it. Foreign text: any bytes the file contained,
  // carried as UTF-8, never matched against and never used as an identity.
  std::string name;
};

// One face's colour, or the absence of one.
//
// A flag rather than a sentinel because black is a colour a file can mean, and
// every encoding that reserves a value for "none" eventually meets a file that
// uses it.
struct StepFaceColour {
  bool has = false;
  double r = 0.0, g = 0.0, b = 0.0;
};

// One registered body, and what the file said about it.
//
// Parallel to the body list: part i is firstBodyId + i. Holds the name and the
// colour together rather than in two more parallel arrays, which also puts the
// face-colour block's offset next to the count that validates it.
struct StepPart {
  // Empty when the file named nothing. Distinct from an occurrence's name; see
  // StepInstance::name.
  std::string name;

  // The part's own colour, as sRGB in 0..1.
  //
  // sRGB is not incidental. OCCT decodes a STEP COLOUR_RGB as sRGB and stores
  // it internally as linear, so reading Quantity_Color::Red() would hand back
  // 0.033 for a file that said 0.2. These are converted back on the way out,
  // which is both what the file meant and what a renderer treating colours as
  // sRGB expects.
  bool hasColour = false;
  double colourR = 0.0, colourG = 0.0, colourB = 0.0;

  // Faces in TopExp_Explorer(TopAbs_FACE) order - the same order the mesher
  // walks, and the checksum for the face-colour block below.
  //
  // A checksum, not a proof. It catches the ordinary case where an edit
  // changes how many faces a body has, and it cannot catch an edit that
  // rearranges topology while leaving the count alone. The real guarantee is
  // structural: bodies are immutable here, every operation mints a new handle,
  // and a new handle has no map to carry forward. This is the backstop for a
  // caller that tries to carry one across anyway.
  //
  // This is a VISIT count, so it can exceed the number of distinct faces
  // BodyInfo reports where a face is reachable from more than one parent. The
  // mesher counts the same way, which is what makes the two orders the same
  // order.
  uint32_t faceCount = 0;

  // Where this part's dense face-colour block starts in the result's
  // faceColours list, and how many of its entries carry a colour.
  //
  // The block is dense - one entry per face, in exploration order, so the
  // position IS the key - but it exists at all only when colouredFaceCount is
  // positive. Most parts in most files have no face colour, and emitting a
  // thousand empty entries for each of them would cost more than the colours
  // do. When colouredFaceCount is zero there is no block and faceColourStart
  // means nothing.
  uint32_t faceColourStart = 0;
  uint32_t colouredFaceCount = 0;
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

  // The file's own census, counted off the parsed STEP model before any
  // transfer. These say what the file DECLARED, and they are the denominator
  // for what arrived: an assembly node count of 13 against 13 instances is a
  // structure fully carried, and against 4 it is not. Counted the same way in
  // both reader modes, so the two are comparable.
  uint32_t namedProductCount = 0;
  uint32_t styledItemCount = 0;
  uint32_t assemblyNodeCount = 0;

  // STEP semantics this stage still drops, each named rather than summed.
  //
  // MVP-2 reported one number for everything beyond shape, which said "you
  // lost something" without saying what. These are counted individually so a
  // file whose value is in its tolerances is distinguishable from one whose
  // value is in its layers - and so the next stage to pick one of them up has
  // a baseline. Counted off the entity census, not read into the document:
  // the CAF reader's layer, property, tolerance and material modes are all
  // turned off, because paying to build attributes this stage discards would
  // show up in the reader-cost measurement as a cost of structure.
  uint32_t droppedLayerCount = 0;
  uint32_t droppedMaterialCount = 0;
  uint32_t droppedGeometricToleranceCount = 0;
  uint32_t droppedDimensionCount = 0;

  // --- Structure -----------------------------------------------------------

  // Whether the caller asked for structure at all.
  //
  // Reported so that "no tree" never has to be guessed at. A flat import and an
  // assembly-free file both return no instances, and they mean entirely
  // different things: one is what the caller asked for, the other is what the
  // file contained.
  bool structureRequested = false;

  // Whether the file actually had product structure. False with
  // structureRequested true means the file was flat, and the bodies are its
  // top-level shapes.
  bool structurePresent = false;

  // The occurrences, parents before children. Empty unless structure was
  // requested and the file had some.
  std::vector<StepInstance> instances;

  // Placements, 12 doubles per instance, row-major 3x4, at 12 * the instance's
  // own index - so the list is exactly 12x the instance list and a consumer
  // needs no offset field.
  //
  // Held beside the instances rather than inside them because embind would
  // otherwise make each instance's placement its own heap-backed vector object
  // for a caller to free one at a time. Two allocations to release instead of
  // one per occurrence is not a micro-optimization; it is the difference
  // between a leak that is hard and easy to avoid.
  //
  // Each placement is the occurrence's transform relative to its PARENT, not
  // to the world. Composition down the tree is the document layer's, which is
  // the only layer that knows the tree after this call returns.
  std::vector<double> placements;

  // One per registered body, in body order.
  std::vector<StepPart> parts;

  // Every part's face-colour block, concatenated. A part addresses its own
  // block through faceColourStart and faceCount; nothing else indexes this.
  std::vector<StepFaceColour> faceColours;

  // Deepest path in the tree, roots counting as 1. Zero when there is no tree.
  uint32_t treeDepth = 0;

  // Occurrences carrying no shape of their own. Real assemblies have them, and
  // a count of zero against a positive instance count says every node is a
  // placed part.
  uint32_t groupingNodeCount = 0;

  // Names that survived, against namedProductCount above.
  uint32_t namedInstanceCount = 0;
  uint32_t namedPartCount = 0;

  // Colours that survived, against styledItemCount above. Kept as three
  // numbers rather than one because part, occurrence, and face colour come
  // from three different places in a STEP file and are lost independently -
  // a file whose per-face colours all arrived and whose overrides all
  // vanished is a specific finding, not a general one.
  uint32_t colouredPartCount = 0;
  uint32_t colouredInstanceCount = 0;
  uint32_t colouredFaceCount = 0;

  // Components whose referred label could not be resolved to anything.
  //
  // Skipped with their subtree rather than failing the import, on the same
  // reasoning that admits open shells: a defect in one branch of a foreign
  // file should cost that branch, not the file. Counted so it is never silent.
  uint32_t unresolvedInstanceCount = 0;

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

  // XCAF documents the translator currently holds open.
  //
  // Always zero outside a translation call, and that is the point of reporting
  // it. The scratch document a structured import builds is the one thing in
  // this kernel that leaks silently and expensively - it retains every shape it
  // transferred, and nothing about a later operation would look wrong - so the
  // invariant is made observable rather than argued for. The instrument this
  // replaced was peak heap across repeated imports, which turned out not to
  // move at all: a leaked document simply fits inside a heap that has already
  // grown, so the check passed whether or not the close happened.
  uint32_t openTranslationDocuments = 0;
};

}  // namespace webcad
