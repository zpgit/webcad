#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <unordered_map>
#include <vector>

#include <TopoDS_Shape.hxx>

#include "status.hpp"

namespace webcad {

// Cached tessellation for one body at one tolerance.
struct CachedMesh {
  std::vector<float> positions;
  std::vector<float> normals;
  std::vector<uint32_t> indices;
  uint32_t vertexCount = 0;
  uint32_t triangleCount = 0;
  double linearDeflection = 0.0;
  double angularDeflection = 0.0;

  size_t byteSize() const {
    return positions.size() * sizeof(float)
         + normals.size() * sizeof(float)
         + indices.size() * sizeof(uint32_t);
  }
};

// Owns every shape the kernel has created and hands out opaque integer handles.
//
// Handles are monotonically increasing uint32 values, never raw pointers and
// never reused. The design rejects pointers on three grounds: a stale pointer
// is indistinguishable from a valid one, so use-after-release becomes memory
// corruption instead of a typed error; allocators recycle addresses, which
// makes the "never reissue an identifier" guarantee unenforceable; and a
// pointer invites JavaScript to reach into WASM memory directly.
class ShapeRegistry {
 public:
  // Registers a shape and returns its new handle. Never returns 0, which is
  // reserved as "no body".
  uint32_t add(const TopoDS_Shape& shape);

  // Returns the shape for a handle, or nullptr if the handle was never issued
  // or has been released.
  const TopoDS_Shape* find(uint32_t id) const;

  // Destroys a shape and evicts its cached meshes. Returns false if the handle
  // was not live, which the caller reports as InvalidHandle - covering both the
  // unknown-handle and double-release cases.
  bool release(uint32_t id);

  // Mesh cache, keyed on handle plus tolerance.
  //
  // Bodies are immutable once created and every operation returns a new handle,
  // so a cache entry can never go stale for the geometry it describes. That
  // immutability is what makes caching sound here.
  const CachedMesh* findMesh(uint32_t id, double linear, double angular) const;
  const CachedMesh* storeMesh(uint32_t id, CachedMesh mesh);

  uint32_t liveBodyCount() const { return static_cast<uint32_t>(shapes_.size()); }
  uint32_t totalBodiesCreated() const { return nextId_ - 1; }
  uint32_t cachedMeshCount() const;
  size_t meshCacheBytes() const;

 private:
  // Tolerances are part of the cache key. Compared exactly: a caller asking for
  // a different tolerance must get a fresh tessellation, and near-equal
  // tolerances are cheap enough to re-mesh that fuzzy matching is not worth the
  // risk of serving a mesh coarser than requested.
  struct MeshKey {
    double linear;
    double angular;
    bool operator<(const MeshKey& o) const {
      if (linear != o.linear) return linear < o.linear;
      return angular < o.angular;
    }
  };

  // Starts at 1 and only ever increases, so a released handle's identifier is
  // never handed to a different body.
  uint32_t nextId_ = 1;

  std::unordered_map<uint32_t, TopoDS_Shape> shapes_;
  std::unordered_map<uint32_t, std::map<MeshKey, CachedMesh>> meshes_;
};

// The process-wide registry. The kernel is a singleton inside one WASM
// instance; a second instance means a second module with its own memory.
ShapeRegistry& registry();

}  // namespace webcad
