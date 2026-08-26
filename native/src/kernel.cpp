#include "kernel.hpp"

#include <algorithm>
#include <cmath>
#include <exception>
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
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <Poly_Triangulation.hxx>
#include <Standard_Failure.hxx>
#include <Standard_Version.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
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
