#include "kernel.hpp"

#include <algorithm>
#include <cmath>
#include <exception>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <BinTools.hxx>
#include <BinTools_FormatVersion.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_InterfaceModel.hxx>
#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_Printer.hxx>
#include <NCollection_Sequence.hxx>
#include <Poly_Triangulation.hxx>
#include <STEPControl_Reader.hxx>
#include <STEPControl_StepModelType.hxx>
#include <STEPControl_Writer.hxx>
#include <ShapeProcess.hxx>
#include <Standard_Failure.hxx>
#include <Standard_Type.hxx>
#include <Standard_Version.hxx>
#include <StepBasic_Product.hxx>
#include <StepData_StepModel.hxx>
#include <StepRepr_NextAssemblyUsageOccurrence.hxx>
#include <StepVisual_StyledItem.hxx>
#include <TCollection_AsciiString.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include <emscripten/heap.h>

#include "registry.hpp"

namespace webcad {
namespace {

// Peak WASM linear memory observed this session. Sampled after each operation
// rather than continuously - enough to report a session peak without
// instrumenting the allocator.
double g_peakMemoryBytes = 0.0;

// The single staging buffer for byte payloads crossing the boundary, in either
// direction. One at a time is deliberate: a document is checkpointed as a
// whole, so there is never a second payload in flight, and a single buffer
// makes "who owns these bytes" answerable at a glance.
std::string g_staging;

double currentMemoryBytes() {
  return static_cast<double>(emscripten_get_heap_size());
}

void sampleMemory() {
  g_peakMemoryBytes = std::max(g_peakMemoryBytes, currentMemoryBytes());
}

// Wraps an operation so no exception escapes into the WASM trap handler.
// An uncaught C++ exception at the boundary can leave the module unusable,
// which would break the guarantee that the kernel survives a failed operation.
template <typename R, typename F>
R guarded(F&& fn) {
  try {
    R out = fn();
    sampleMemory();
    return out;
  } catch (const Standard_Failure& e) {
    // Standard_Failure derives from std::runtime_error in OCCT 8.x; what() is
    // the supported accessor (GetMessageString is deprecated).
    R out;
    const char* msg = e.what();
    out.status = static_cast<int32_t>(Status::KernelOperationFailed);
    out.message = std::string("OCCT: ") + (msg && *msg ? msg : "unspecified failure");
    sampleMemory();
    return out;
  } catch (const std::exception& e) {
    R out;
    out.status = static_cast<int32_t>(Status::KernelOperationFailed);
    out.message = std::string("std::exception: ") + e.what();
    sampleMemory();
    return out;
  } catch (...) {
    R out;
    out.status = static_cast<int32_t>(Status::KernelOperationFailed);
    out.message = "unknown native exception";
    sampleMemory();
    return out;
  }
}

template <typename R>
R fail(Status s, std::string message) {
  R out;
  out.status = static_cast<int32_t>(s);
  out.message = std::move(message);
  return out;
}

// Counts DISTINCT sub-shapes.
//
// TopExp_Explorer would visit a shared entity once per parent - a box reports 24
// edges and 48 vertices that way, because each edge is walked from both adjacent
// faces. Mapping into an indexed map deduplicates, giving the 12 edges and 8
// vertices a box actually has.
uint32_t countSubShapes(const TopoDS_Shape& shape, TopAbs_ShapeEnum type) {
  TopTools_IndexedMapOfShape unique;
  TopExp::MapShapes(shape, type, unique);
  return static_cast<uint32_t>(unique.Extent());
}

// A primitive or Boolean result must be a valid closed solid before a handle is
// issued, so a malformed shape never becomes reachable by a handle.
bool isValidSolid(const TopoDS_Shape& shape) {
  if (shape.IsNull()) return false;
  if (countSubShapes(shape, TopAbs_SOLID) == 0) return false;
  return BRepCheck_Analyzer(shape).IsValid() ;
}

OpResult registerSolid(const TopoDS_Shape& shape, const char* what) {
  if (shape.IsNull()) {
    return fail<OpResult>(Status::KernelOperationFailed,
                          std::string(what) + " produced a null shape");
  }
  const uint32_t solids = countSubShapes(shape, TopAbs_SOLID);
  if (solids == 0) {
    // No solid is a legitimate outcome for a Boolean, reported as EmptyResult
    // by the caller. For a primitive it is a failure. Distinguishing the two is
    // the caller's job; here we only refuse to issue a handle.
    return fail<OpResult>(Status::EmptyResult,
                          std::string(what) + " produced no solid");
  }
  if (!BRepCheck_Analyzer(shape).IsValid()) {
    return fail<OpResult>(Status::KernelOperationFailed,
                          std::string(what) + " produced an invalid solid");
  }

  OpResult out;
  out.bodyId = registry().add(shape);
  out.solidCount = solids;
  return out;
}

// Validates a rotation/extrusion axis is not degenerate.
bool axisIsUsable(double x, double y, double z) {
  return std::sqrt(x * x + y * y + z * z) > 1e-12;
}

// --- STEP translation helpers ----------------------------------------------

// Registers a shape that came from outside this system.
//
// Deliberately weaker than registerSolid, which stays the strict gate for
// primitives and Boolean results: those are geometry this kernel just built, and
// a malformed one is a bug worth refusing. An imported shape is different -
// real STEP data contains open shells and solids that fail BRepCheck, and
// refusing them would reject usable files wholesale and report nothing about
// them. So the shape is registered and its validity is reported honestly,
// leaving an operation that needs a solid to fail on its own terms.
//
// The one thing still refused is a shape with no face at all: a stray curve or
// point carries nothing this system can treat as a body, and counting it as
// unregistered says more than issuing a handle to it would.
bool importedShapeIsUsable(const TopoDS_Shape& shape) {
  if (shape.IsNull()) return false;
  return countSubShapes(shape, TopAbs_FACE) > 0;
}

// Flattens compounds down to their non-compound leaves.
//
// A STEP assembly transfers as nested compounds. This stage has nowhere to put
// an assembly hierarchy - that needs XCAF and is MVP-3's - so the parts arrive
// as a flat set of bodies rather than one body that is secretly a tree. The
// recursion is what makes "flattened" true for a nested assembly and not just
// for a single level of it.
void collectLeafShapes(const TopoDS_Shape& shape,
                       std::vector<TopoDS_Shape>& out) {
  if (shape.IsNull()) return;
  if (shape.ShapeType() != TopAbs_COMPOUND) {
    out.push_back(shape);
    return;
  }
  for (TopoDS_Iterator it(shape); it.More(); it.Next()) {
    collectLeafShapes(it.Value(), out);
  }
}

// Names a length unit from its millimetre factor, for reporting.
//
// OCCT carries units as a factor rather than a name once a model is loaded, and
// a factor in a report is harder to read than a name. Anything unrecognized is
// reported as its factor rather than forced into the nearest name.
std::string lengthUnitName(double millimetresPerUnit) {
  struct Known {
    double factor;
    const char* name;
  };
  static const Known kKnown[] = {
      {1.0, "mm"}, {10.0, "cm"}, {1000.0, "m"},
      {25.4, "in"}, {304.8, "ft"}, {0.001, "um"},
  };
  for (const Known& k : kKnown) {
    if (std::fabs(millimetresPerUnit - k.factor) < 1e-9 * k.factor) {
      return k.name;
    }
  }
  std::ostringstream os;
  os << millimetresPerUnit << "mm";
  return os.str();
}

// What OCCT's shape processing does when it is left enabled.
//
// Hardcoded rather than queried: the accessors that would enumerate the flags
// at run time (GetDefaultShapeProcessFlags) are protected, so the facade cannot
// read them. These are OCCT 8.0.1's defaults, verified in its source -
// STEPControl_Reader.cxx:864-867 for the reader, STEPControl_Controller.cxx:
// 348-353 for the writer. If a later OCCT changes them this string goes stale,
// which is why it names its source.
constexpr const char* kReaderDefaultProcessing = "FixShape";
constexpr const char* kWriterDefaultProcessing = "SplitCommonVertex,DirectFaces";

// Stops OCCT's translators narrating to the console.
//
// The STEP reader and writer send per-transfer statistics through OCCT's default
// messenger at Info gravity, unconditionally - banner lines, transfer modes, one
// block per shape. In a browser that is console noise from a library the
// application is meant to be hiding, and in a test run it buries the output.
//
// Info is dropped and Warning upwards is kept: a translator that has something
// real to report must still be able to say so. Applied once, lazily, because
// there is no facade initialization hook and the messenger is global.
void quietOcctChatter() {
  static bool done = false;
  if (done) return;
  done = true;

  const occ::handle<Message_Messenger>& messenger = Message::DefaultMessenger();
  if (messenger.IsNull()) return;
  for (const occ::handle<Message_Printer>& printer : messenger->Printers()) {
    if (!printer.IsNull()) printer->SetTraceLevel(Message_Warning);
  }
}

}  // namespace

OpResult createBox(const BoxParams& p) {
  if (!(p.width > 0.0)) {
    return fail<OpResult>(Status::InvalidParameter, "width must be positive");
  }
  if (!(p.depth > 0.0)) {
    return fail<OpResult>(Status::InvalidParameter, "depth must be positive");
  }
  if (!(p.height > 0.0)) {
    return fail<OpResult>(Status::InvalidParameter, "height must be positive");
  }
  if (p.angle != 0.0 && !axisIsUsable(p.axisX, p.axisY, p.axisZ)) {
    return fail<OpResult>(Status::InvalidParameter,
                          "rotation axis must not be zero-length");
  }

  return guarded<OpResult>([&] {
    // Built at the origin, then placed, so rotation is about the box's own
    // minimum corner rather than the world origin.
    TopoDS_Shape shape =
        BRepPrimAPI_MakeBox(p.width, p.depth, p.height).Shape();

    gp_Trsf rotation;
    if (p.angle != 0.0) {
      rotation.SetRotation(
          gp_Ax1(gp_Pnt(0.0, 0.0, 0.0), gp_Dir(p.axisX, p.axisY, p.axisZ)),
          p.angle);
    }
    gp_Trsf translation;
    translation.SetTranslation(gp_Vec(p.originX, p.originY, p.originZ));

    shape = BRepBuilderAPI_Transform(shape, translation * rotation, true).Shape();
    return registerSolid(shape, "box");
  });
}

OpResult createCylinder(const CylinderParams& p) {
  if (!(p.radius > 0.0)) {
    return fail<OpResult>(Status::InvalidParameter, "radius must be positive");
  }
  if (!(p.height > 0.0)) {
    return fail<OpResult>(Status::InvalidParameter, "height must be positive");
  }
  if (!axisIsUsable(p.axisX, p.axisY, p.axisZ)) {
    return fail<OpResult>(Status::InvalidParameter,
                          "axis must not be zero-length");
  }

  return guarded<OpResult>([&] {
    const gp_Ax2 axis(gp_Pnt(p.originX, p.originY, p.originZ),
                      gp_Dir(p.axisX, p.axisY, p.axisZ));
    const TopoDS_Shape shape =
        BRepPrimAPI_MakeCylinder(axis, p.radius, p.height).Shape();
    return registerSolid(shape, "cylinder");
  });
}

OpResult booleanOp(uint32_t targetId, uint32_t toolId, int32_t kind) {
  if (kind < 0 || kind > 2) {
    return fail<OpResult>(Status::InvalidParameter, "unknown boolean kind");
  }
  // Rejected before any geometry work: the same body as both operands is a
  // caller mistake, not a degenerate-geometry case to be computed.
  if (targetId == toolId) {
    return fail<OpResult>(Status::InvalidParameter,
                          "target and tool must be different bodies");
  }

  const TopoDS_Shape* target = registry().find(targetId);
  if (target == nullptr) {
    return fail<OpResult>(Status::InvalidHandle, "unknown target body");
  }
  const TopoDS_Shape* tool = registry().find(toolId);
  if (tool == nullptr) {
    return fail<OpResult>(Status::InvalidHandle, "unknown tool body");
  }

  // Copied out of the registry before the operation: BRepAlgoAPI may modify its
  // inputs' internal state, and the operands must stay usable afterwards.
  const TopoDS_Shape a = *target;
  const TopoDS_Shape b = *tool;

  return guarded<OpResult>([&] {
    TopoDS_Shape result;
    const char* what = "boolean";

    switch (static_cast<BooleanKind>(kind)) {
      case BooleanKind::Union: {
        BRepAlgoAPI_Fuse op(a, b);
        if (!op.IsDone()) {
          return fail<OpResult>(Status::KernelOperationFailed, "union failed");
        }
        result = op.Shape();
        what = "union";
        break;
      }
      case BooleanKind::Subtract: {
        BRepAlgoAPI_Cut op(a, b);
        if (!op.IsDone()) {
          return fail<OpResult>(Status::KernelOperationFailed, "subtract failed");
        }
        result = op.Shape();
        what = "subtract";
        break;
      }
      case BooleanKind::Intersect: {
        BRepAlgoAPI_Common op(a, b);
        if (!op.IsDone()) {
          return fail<OpResult>(Status::KernelOperationFailed, "intersect failed");
        }
        result = op.Shape();
        what = "intersect";
        break;
      }
    }

    // An operation that removes all material, or intersects disjoint solids,
    // yields no solid. That is a legitimate outcome and is reported as
    // EmptyResult, distinct from a failure, and with no handle issued.
    if (result.IsNull() || countSubShapes(result, TopAbs_SOLID) == 0) {
      OpResult empty;
      empty.status = static_cast<int32_t>(Status::EmptyResult);
      empty.message = std::string(what) + " produced no solid";
      return empty;
    }

    // A disjoint union legitimately yields several solids. registerSolid
    // reports solidCount so the caller sees a multi-solid success rather than
    // having the result rejected.
    return registerSolid(result, what);
  });
}

MeshResult tessellate(uint32_t bodyId, const TessellationParams& p) {
  const double linear =
      p.linearDeflection > 0.0 ? p.linearDeflection : kDefaultLinearDeflection;
  const double angular =
      p.angularDeflection > 0.0 ? p.angularDeflection : kDefaultAngularDeflection;

  const TopoDS_Shape* found = registry().find(bodyId);
  if (found == nullptr) {
    return fail<MeshResult>(Status::InvalidHandle, "unknown body");
  }

  // A cache hit is reported explicitly rather than left to be inferred from
  // timing, so tests can assert it deterministically.
  if (const CachedMesh* hit = registry().findMesh(bodyId, linear, angular)) {
    MeshResult out;
    out.vertexCount = hit->vertexCount;
    out.triangleCount = hit->triangleCount;
    out.positionsPtr = reinterpret_cast<uint32_t>(hit->positions.data());
    out.normalsPtr = reinterpret_cast<uint32_t>(hit->normals.data());
    out.indicesPtr = reinterpret_cast<uint32_t>(hit->indices.data());
    out.linearDeflection = linear;
    out.angularDeflection = angular;
    out.fromCache = true;
    return out;
  }

  const TopoDS_Shape shape = *found;

  return guarded<MeshResult>([&] {
    BRepMesh_IncrementalMesh mesher(shape, linear, false, angular,
                                    true);
    if (!mesher.IsDone()) {
      return fail<MeshResult>(Status::KernelOperationFailed,
                              "tessellation did not complete");
    }

    CachedMesh mesh;
    mesh.linearDeflection = linear;
    mesh.angularDeflection = angular;

    for (TopExp_Explorer exp(shape, TopAbs_FACE); exp.More(); exp.Next()) {
      const TopoDS_Face face = TopoDS::Face(exp.Current());

      TopLoc_Location loc;
      const Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
      if (tri.IsNull()) {
        continue;
      }

      const gp_Trsf trsf = loc.Transformation();
      const bool reversed = face.Orientation() == TopAbs_REVERSED;
      const int nbNodes = tri->NbNodes();
      const int nbTris = tri->NbTriangles();

      // Vertices are emitted per face rather than shared across faces, so a
      // sharp edge between two faces keeps distinct normals on each side.
      const uint32_t base = mesh.vertexCount;

      for (int i = 1; i <= nbNodes; ++i) {
        gp_Pnt pt = tri->Node(i);
        pt.Transform(trsf);
        mesh.positions.push_back(static_cast<float>(pt.X()));
        mesh.positions.push_back(static_cast<float>(pt.Y()));
        mesh.positions.push_back(static_cast<float>(pt.Z()));
        // Accumulated from adjacent triangles below.
        mesh.normals.insert(mesh.normals.end(), {0.0f, 0.0f, 0.0f});
      }
      mesh.vertexCount += static_cast<uint32_t>(nbNodes);

      for (int t = 1; t <= nbTris; ++t) {
        int a = 0, b = 0, c = 0;
        tri->Triangle(t).Get(a, b, c);
        if (reversed) {
          std::swap(b, c);
        }

        const uint32_t ia = base + static_cast<uint32_t>(a - 1);
        const uint32_t ib = base + static_cast<uint32_t>(b - 1);
        const uint32_t ic = base + static_cast<uint32_t>(c - 1);
        mesh.indices.push_back(ia);
        mesh.indices.push_back(ib);
        mesh.indices.push_back(ic);

        // Area-weighted face normal accumulated onto each corner. Within a
        // single face this smooths a curved surface such as a cylinder's
        // lateral face; across faces nothing is shared, so planes stay flat.
        const gp_Vec va(mesh.positions[3 * ia], mesh.positions[3 * ia + 1],
                        mesh.positions[3 * ia + 2]);
        const gp_Vec vb(mesh.positions[3 * ib], mesh.positions[3 * ib + 1],
                        mesh.positions[3 * ib + 2]);
        const gp_Vec vc(mesh.positions[3 * ic], mesh.positions[3 * ic + 1],
                        mesh.positions[3 * ic + 2]);
        const gp_Vec n = (vb - va).Crossed(vc - va);

        for (uint32_t idx : {ia, ib, ic}) {
          mesh.normals[3 * idx] += static_cast<float>(n.X());
          mesh.normals[3 * idx + 1] += static_cast<float>(n.Y());
          mesh.normals[3 * idx + 2] += static_cast<float>(n.Z());
        }
      }
      mesh.triangleCount += static_cast<uint32_t>(nbTris);
    }

    if (mesh.vertexCount == 0 || mesh.triangleCount == 0) {
      return fail<MeshResult>(Status::KernelOperationFailed,
                              "tessellation produced no triangles");
    }

    for (size_t i = 0; i + 2 < mesh.normals.size(); i += 3) {
      const float x = mesh.normals[i];
      const float y = mesh.normals[i + 1];
      const float z = mesh.normals[i + 2];
      const float len = std::sqrt(x * x + y * y + z * z);
      if (len > 0.0f) {
        mesh.normals[i] = x / len;
        mesh.normals[i + 1] = y / len;
        mesh.normals[i + 2] = z / len;
      } else {
        mesh.normals[i + 2] = 1.0f;
      }
    }

    MeshResult out;
    out.vertexCount = mesh.vertexCount;
    out.triangleCount = mesh.triangleCount;
    out.linearDeflection = linear;
    out.angularDeflection = angular;
    out.fromCache = false;

    // Pointers must address the stored copy, not the local, so they stay valid
    // after this function returns.
    const CachedMesh* stored = registry().storeMesh(bodyId, std::move(mesh));
    out.positionsPtr = reinterpret_cast<uint32_t>(stored->positions.data());
    out.normalsPtr = reinterpret_cast<uint32_t>(stored->normals.data());
    out.indicesPtr = reinterpret_cast<uint32_t>(stored->indices.data());
    return out;
  });
}

OpResult releaseBody(uint32_t bodyId) {
  // Covers both the unknown-handle and double-release cases: neither corrupts
  // kernel state nor frees unrelated geometry.
  if (!registry().release(bodyId)) {
    return fail<OpResult>(Status::InvalidHandle,
                          "unknown or already-released body");
  }
  sampleMemory();
  return OpResult{};
}

BodyInfo bodyInfo(uint32_t bodyId) {
  const TopoDS_Shape* found = registry().find(bodyId);
  if (found == nullptr) {
    return fail<BodyInfo>(Status::InvalidHandle, "unknown body");
  }
  const TopoDS_Shape shape = *found;

  return guarded<BodyInfo>([&] {
    BodyInfo out;
    out.faceCount = countSubShapes(shape, TopAbs_FACE);
    out.edgeCount = countSubShapes(shape, TopAbs_EDGE);
    out.vertexCount = countSubShapes(shape, TopAbs_VERTEX);
    out.solidCount = countSubShapes(shape, TopAbs_SOLID);

    GProp_GProps volumeProps;
    BRepGProp::VolumeProperties(shape, volumeProps);
    out.volume = volumeProps.Mass();

    GProp_GProps surfaceProps;
    BRepGProp::SurfaceProperties(shape, surfaceProps);
    out.area = surfaceProps.Mass();

    Bnd_Box box;
    BRepBndLib::Add(shape, box);
    if (!box.IsVoid()) {
      box.Get(out.bboxMinX, out.bboxMinY, out.bboxMinZ,
              out.bboxMaxX, out.bboxMaxY, out.bboxMaxZ);
    }

    out.isValid = isValidSolid(shape);
    out.isClosed = shape.Closed() ;
    return out;
  });
}

FaceTypeSummary faceTypeSummary(uint32_t bodyId) {
  const TopoDS_Shape* found = registry().find(bodyId);
  if (found == nullptr) {
    return fail<FaceTypeSummary>(Status::InvalidHandle, "unknown body");
  }
  const TopoDS_Shape shape = *found;

  return guarded<FaceTypeSummary>([&] {
    FaceTypeSummary out;
    for (TopExp_Explorer exp(shape, TopAbs_FACE); exp.More(); exp.Next()) {
      BRepAdaptor_Surface surface(TopoDS::Face(exp.Current()));
      switch (surface.GetType()) {
        case GeomAbs_Plane:            ++out.plane; break;
        case GeomAbs_Cylinder:         ++out.cylinder; break;
        case GeomAbs_Cone:             ++out.cone; break;
        case GeomAbs_Sphere:           ++out.sphere; break;
        case GeomAbs_Torus:            ++out.torus; break;
        case GeomAbs_BezierSurface:    ++out.bezier; break;
        case GeomAbs_BSplineSurface:   ++out.bspline; break;
        case GeomAbs_SurfaceOfRevolution: ++out.revolution; break;
        case GeomAbs_SurfaceOfExtrusion:  ++out.extrusion; break;
        default:                       ++out.other; break;
      }
    }
    return out;
  });
}

std::string geometryFormat() {
  return "occt-bin-brep-v" +
         std::to_string(static_cast<int>(BinTools_FormatVersion_CURRENT));
}

void discardStaging() {
  // swap-with-empty rather than clear(): clear() keeps the capacity, and the
  // point of discarding is to stop holding a checkpoint-sized allocation.
  std::string().swap(g_staging);
}

StagingResult reserveStaging(uint32_t byteLength) {
  if (byteLength == 0) {
    return fail<StagingResult>(Status::InvalidParameter,
                               "payload length must be positive");
  }

  return guarded<StagingResult>([&] {
    discardStaging();
    g_staging.resize(byteLength);

    StagingResult out;
    out.dataPtr = reinterpret_cast<uint32_t>(g_staging.data());
    out.byteLength = byteLength;
    return out;
  });
}

SerializeResult serializeBodies(const std::vector<uint32_t>& bodyIds) {
  // Resolved up front, before a single byte is written: a set containing an
  // unknown handle must fail having produced nothing, not a partial payload
  // that a caller might store.
  std::vector<TopoDS_Shape> shapes;
  shapes.reserve(bodyIds.size());
  for (const uint32_t id : bodyIds) {
    const TopoDS_Shape* found = registry().find(id);
    if (found == nullptr) {
      return fail<SerializeResult>(
          Status::InvalidHandle,
          "unknown or already-released body " + std::to_string(id));
    }
    shapes.push_back(*found);
  }

  return guarded<SerializeResult>([&] {
    BRep_Builder builder;
    TopoDS_Compound compound;
    builder.MakeCompound(compound);
    for (const TopoDS_Shape& shape : shapes) {
      builder.Add(compound, shape);
    }

    // withTriangles and withNormals are false: a checkpoint stores exact
    // geometry, and any mesh in it would be derived data at one tolerance.
    // An empty compound is written normally, so serializing no bodies yields a
    // valid payload that restores to no bodies rather than an unreadable one.
    std::ostringstream stream(std::ios::out | std::ios::binary);
    BinTools::Write(compound, stream, false, false,
                    BinTools_FormatVersion_CURRENT);

    // One copy out of the stream's own buffer, move-assigned so it is not two.
    // Measured rather than assumed away: the payload's byte length rides back
    // on the result, so its cost is attributable against the recorded duration.
    g_staging = stream.str();

    SerializeResult out;
    out.dataPtr = reinterpret_cast<uint32_t>(g_staging.data());
    out.byteLength = static_cast<uint32_t>(g_staging.size());
    out.bodyCount = static_cast<uint32_t>(shapes.size());
    out.format = geometryFormat();
    out.occtVersion = OCC_VERSION_COMPLETE;
    return out;
  });
}

RestoreResult restoreBodies() {
  if (g_staging.empty()) {
    return fail<RestoreResult>(Status::InvalidParameter,
                               "no payload has been staged");
  }

  return guarded<RestoreResult>([&] {
    // A second copy of the payload, for the same reason as the one in
    // serializeBodies: a standard string stream owns its buffer. Both are
    // visible in the recorded byte count, so neither is hidden.
    std::istringstream stream(g_staging, std::ios::in | std::ios::binary);

    TopoDS_Shape root;
    BinTools::Read(root, stream);

    if (root.IsNull()) {
      return fail<RestoreResult>(Status::KernelOperationFailed,
                                 "payload contained no shape");
    }
    // Every payload this kernel writes has a compound at its root. Anything
    // else parsed successfully but was not written here, and restoring it
    // would mean guessing at a body layout.
    if (root.ShapeType() != TopAbs_COMPOUND) {
      return fail<RestoreResult>(Status::KernelOperationFailed,
                                 "payload is not a webcad checkpoint");
    }

    // Collected and checked before anything is registered, so the all-or-
    // nothing guarantee does not depend on unwinding a partial registration.
    std::vector<TopoDS_Shape> bodies;
    for (TopoDS_Iterator it(root); it.More(); it.Next()) {
      const TopoDS_Shape& child = it.Value();
      if (child.IsNull() || countSubShapes(child, TopAbs_SOLID) == 0) {
        return fail<RestoreResult>(
            Status::KernelOperationFailed,
            "payload contains a body with no solid at position " +
                std::to_string(bodies.size()));
      }
      bodies.push_back(child);
    }

    // Note what is NOT done here: BRepCheck_Analyzer is not run on each body.
    // Creation already validated this geometry, and a full validity analysis
    // over every body is proportional to model size at exactly the moment the
    // user is waiting for their document to open. Stream integrity is BinTools'
    // job and payload integrity is the document manifest's; re-deciding
    // validity is neither. A caller that wants it can ask bodyInfo.
    RestoreResult out;
    out.bodyCount = static_cast<uint32_t>(bodies.size());
    if (bodies.empty()) {
      return out;
    }

    std::vector<uint32_t> issued;
    issued.reserve(bodies.size());
    try {
      for (const TopoDS_Shape& body : bodies) {
        issued.push_back(registry().add(body));
      }
    } catch (...) {
      for (const uint32_t id : issued) registry().release(id);
      throw;
    }

    // The registry issues handles consecutively and never reuses one, which is
    // what lets a caller address the i-th body as firstBodyId + i instead of
    // receiving a list. Verified rather than assumed, so a future change to
    // handle allocation fails loudly here instead of silently misaddressing
    // every body in a restored document.
    for (size_t i = 0; i < issued.size(); ++i) {
      if (issued[i] != issued[0] + static_cast<uint32_t>(i)) {
        for (const uint32_t id : issued) registry().release(id);
        return fail<RestoreResult>(Status::KernelOperationFailed,
                                   "registry issued non-consecutive handles");
      }
    }

    out.firstBodyId = issued[0];
    return out;
  });
}

StepImportResult importStep(const StepTranslationOptions& options) {
  if (g_staging.empty()) {
    return fail<StepImportResult>(Status::InvalidParameter,
                                  "no payload has been staged");
  }

  quietOcctChatter();

  return guarded<StepImportResult>([&] {
    StepImportResult out;
    out.payloadByteLength = static_cast<uint32_t>(g_staging.size());

    STEPControl_Reader reader;
    if (!options.shapeProcessing) {
      // An empty flag set is what disables the pass; OCCT's own default enables
      // FixShape. Suppressed by default here so a difference between the file
      // and the body is attributable to translation rather than to repair.
      reader.SetShapeProcessFlags(ShapeProcess::OperationsFlags{});
    } else {
      out.shapeProcessing = kReaderDefaultProcessing;
    }

    // The bytes are read from a stream over the staging buffer rather than
    // through a virtual filesystem: no MEMFS, no second copy of the payload at
    // exactly the size where memory is the constraint, and no path namespace to
    // clean up on failure.
    std::istringstream stream(g_staging, std::ios::in | std::ios::binary);
    const IFSelect_ReturnStatus readStatus = reader.ReadStream("staged", stream);
    if (readStatus != IFSelect_RetDone) {
      // Covers bytes that are not STEP and a payload cut short partway: OCCT
      // reports both as a failed load, and neither may register the entities it
      // managed to parse, or a partial import could be mistaken for a whole one.
      return fail<StepImportResult>(
          Status::TranslationFailed,
          "payload could not be read as STEP (status " +
              std::to_string(static_cast<int>(readStatus)) + ")");
    }

    // Units, read before the transfer that converts them. FileUnits reports the
    // unit names the file declared per shape representation; the transfer then
    // expresses the result in the system unit. Both are reported, and the
    // conversion between them happens here and nowhere else downstream.
    NCollection_Sequence<TCollection_AsciiString> unitLengths;
    NCollection_Sequence<TCollection_AsciiString> unitAngles;
    NCollection_Sequence<TCollection_AsciiString> unitSolidAngles;
    reader.FileUnits(unitLengths, unitAngles, unitSolidAngles);
    for (int i = 1; i <= unitLengths.Length(); ++i) {
      const std::string name(unitLengths.Value(i).ToCString());
      if (name.empty()) continue;
      if (out.declaredUnit.empty()) {
        out.declaredUnit = name;
      } else if (out.declaredUnit.find(name) == std::string::npos) {
        // A file whose representations disagree about units is a real thing.
        // Reported rather than resolved to the first one seen.
        out.declaredUnit += "," + name;
      }
    }
    out.workingUnit = lengthUnitName(reader.SystemLengthUnit());
    out.unitWasAssumed = out.declaredUnit.empty();

    // What the file carries beyond shape, counted before the transfer discards
    // it. These are counts of entity kinds - no entity crosses the boundary -
    // and they exist so the loss is stated rather than discovered.
    const Handle(Interface_InterfaceModel) model = reader.Model();
    if (!model.IsNull()) {
      for (int i = 1; i <= model->NbEntities(); ++i) {
        const Handle(Standard_Transient) entity = model->Value(i);
        if (entity.IsNull()) continue;
        if (entity->IsKind(STANDARD_TYPE(StepVisual_StyledItem))) {
          ++out.styledItemCount;
        }
        if (entity->IsKind(STANDARD_TYPE(StepRepr_NextAssemblyUsageOccurrence))) {
          ++out.assemblyNodeCount;
        }
        if (entity->IsKind(STANDARD_TYPE(StepBasic_Product))) {
          ++out.namedProductCount;
        }
      }
    }

    out.rootShapeCount = static_cast<uint32_t>(reader.NbRootsForTransfer());
    reader.TransferRoots();

    // Every transferred shape, flattened through compounds, gathered and
    // checked before anything is registered - so the all-or-nothing guarantee
    // does not depend on unwinding a partial registration.
    std::vector<TopoDS_Shape> leaves;
    for (int i = 1; i <= reader.NbShapes(); ++i) {
      collectLeafShapes(reader.Shape(i), leaves);
    }

    std::vector<TopoDS_Shape> usable;
    usable.reserve(leaves.size());
    for (const TopoDS_Shape& leaf : leaves) {
      if (importedShapeIsUsable(leaf)) {
        usable.push_back(leaf);
      } else {
        ++out.unregisteredShapeCount;
      }
    }

    if (usable.empty()) {
      // A syntactically valid file that yielded nothing this system can hold.
      // Reported as an empty result, distinct from the parse failure above,
      // because the two mean different things to a caller.
      //
      // Set on `out` rather than returned through fail<>, which would hand back
      // a fresh struct and throw away the unit and dropped-semantics fields
      // already gathered. Those are exactly what makes this outcome diagnosable
      // - how many roots the file offered, and how many were skipped - so
      // losing them here would make the report useless in the one case a caller
      // most needs to understand.
      out.status = static_cast<int32_t>(Status::EmptyResult);
      out.message = "STEP payload contained no transferable shape";
      return out;
    }

    std::vector<uint32_t> issued;
    issued.reserve(usable.size());
    try {
      for (const TopoDS_Shape& shape : usable) {
        issued.push_back(registry().add(shape));
      }
    } catch (...) {
      for (const uint32_t id : issued) registry().release(id);
      throw;
    }

    // As in restoreBodies: consecutive issuance is what lets a caller address
    // the i-th body as firstBodyId + i, and it is verified rather than trusted.
    for (size_t i = 0; i < issued.size(); ++i) {
      if (issued[i] != issued[0] + static_cast<uint32_t>(i)) {
        for (const uint32_t id : issued) registry().release(id);
        return fail<StepImportResult>(Status::KernelOperationFailed,
                                      "registry issued non-consecutive handles");
      }
    }

    // Validity is reported, not enforced. BRepCheck_Analyzer runs here - unlike
    // in restoreBodies, where the geometry had already been validated on the way
    // in - because for imported geometry its answer is the finding.
    for (size_t i = 0; i < usable.size(); ++i) {
      const TopoDS_Shape& shape = usable[i];
      const bool closedSolid = countSubShapes(shape, TopAbs_SOLID) > 0 &&
                               BRepCheck_Analyzer(shape).IsValid();
      if (!closedSolid) out.openBodyIds.push_back(issued[i]);
    }

    out.firstBodyId = issued[0];
    out.bodyCount = static_cast<uint32_t>(issued.size());
    return out;
  });
}

StepExportResult exportStep(const std::vector<uint32_t>& bodyIds,
                            const StepTranslationOptions& options) {
  if (bodyIds.empty()) {
    // Writing an interchange file describing nothing is not a useful outcome to
    // hand a caller, and the application refuses an empty export above this.
    return fail<StepExportResult>(Status::InvalidParameter,
                                  "no bodies to export");
  }

  // Resolved before a byte is written, as in serializeBodies: a set containing
  // an unknown handle must fail having produced nothing.
  std::vector<TopoDS_Shape> shapes;
  shapes.reserve(bodyIds.size());
  for (const uint32_t id : bodyIds) {
    const TopoDS_Shape* found = registry().find(id);
    if (found == nullptr) {
      return fail<StepExportResult>(
          Status::InvalidHandle,
          "unknown or already-released body " + std::to_string(id));
    }
    shapes.push_back(*found);
  }

  quietOcctChatter();

  return guarded<StepExportResult>([&] {
    StepExportResult out;

    BRep_Builder builder;
    TopoDS_Compound compound;
    builder.MakeCompound(compound);
    for (const TopoDS_Shape& shape : shapes) {
      builder.Add(compound, shape);
    }

    STEPControl_Writer writer;
    if (!options.shapeProcessing) {
      writer.SetShapeProcessFlags(ShapeProcess::OperationsFlags{});
    } else {
      out.shapeProcessing = kWriterDefaultProcessing;
    }

    // AsIs writes each shape as the STEP entity that matches what it already is,
    // rather than forcing everything to a faceted or shell-based form. Anything
    // else would discard exact geometry on the way out, which is the one thing
    // an export here must not do.
    const IFSelect_ReturnStatus transferStatus =
        writer.Transfer(compound, STEPControl_AsIs);
    if (transferStatus != IFSelect_RetDone) {
      return fail<StepExportResult>(
          Status::TranslationFailed,
          "bodies could not be transferred to STEP (status " +
              std::to_string(static_cast<int>(transferStatus)) + ")");
    }

    std::ostringstream stream(std::ios::out | std::ios::binary);
    const IFSelect_ReturnStatus writeStatus = writer.WriteStream(stream);
    if (writeStatus != IFSelect_RetDone) {
      return fail<StepExportResult>(
          Status::TranslationFailed,
          "STEP payload could not be written (status " +
              std::to_string(static_cast<int>(writeStatus)) + ")");
    }

    g_staging = stream.str();

    const Handle(StepData_StepModel) stepModel = writer.Model();
    out.unitWritten = stepModel.IsNull()
                          ? std::string()
                          : lengthUnitName(stepModel->WriteLengthUnit());
    out.dataPtr = reinterpret_cast<uint32_t>(g_staging.data());
    out.byteLength = static_cast<uint32_t>(g_staging.size());
    out.bodyCount = static_cast<uint32_t>(shapes.size());
    return out;
  });
}

KernelStats stats() {
  sampleMemory();
  KernelStats out;
  out.liveBodyCount = registry().liveBodyCount();
  out.totalBodiesCreated = registry().totalBodiesCreated();
  out.cachedMeshCount = registry().cachedMeshCount();
  out.wasmMemoryBytes = currentMemoryBytes();
  out.wasmPeakMemoryBytes = g_peakMemoryBytes;
  out.meshCacheBytes = static_cast<double>(registry().meshCacheBytes());
  return out;
}

std::string occtVersion() { return OCC_VERSION_COMPLETE; }

}  // namespace webcad
