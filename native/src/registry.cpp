#include "registry.hpp"

namespace webcad {

uint32_t ShapeRegistry::add(const TopoDS_Shape& shape) {
  const uint32_t id = nextId_++;
  shapes_.emplace(id, shape);
  return id;
}

const TopoDS_Shape* ShapeRegistry::find(uint32_t id) const {
  const auto it = shapes_.find(id);
  return it == shapes_.end() ? nullptr : &it->second;
}

bool ShapeRegistry::release(uint32_t id) {
  const auto it = shapes_.find(id);
  if (it == shapes_.end()) {
    return false;
  }
  shapes_.erase(it);
  // Releasing a body evicts its cached meshes; nothing may serve a mesh for a
  // released handle, and the cache memory must come back.
  meshes_.erase(id);
  return true;
}

const CachedMesh* ShapeRegistry::findMesh(uint32_t id, double linear,
                                          double angular) const {
  const auto bodyIt = meshes_.find(id);
  if (bodyIt == meshes_.end()) {
    return nullptr;
  }
  const auto meshIt = bodyIt->second.find(MeshKey{linear, angular});
  return meshIt == bodyIt->second.end() ? nullptr : &meshIt->second;
}

const CachedMesh* ShapeRegistry::storeMesh(uint32_t id, CachedMesh mesh) {
  const MeshKey key{mesh.linearDeflection, mesh.angularDeflection};
  auto& perBody = meshes_[id];
  auto [it, _] = perBody.insert_or_assign(key, std::move(mesh));
  return &it->second;
}

uint32_t ShapeRegistry::cachedMeshCount() const {
  uint32_t n = 0;
  for (const auto& [_, perBody] : meshes_) {
    n += static_cast<uint32_t>(perBody.size());
  }
  return n;
}

size_t ShapeRegistry::meshCacheBytes() const {
  size_t bytes = 0;
  for (const auto& [_, perBody] : meshes_) {
    for (const auto& [__, mesh] : perBody) {
      bytes += mesh.byteSize();
    }
  }
  return bytes;
}

ShapeRegistry& registry() {
  static ShapeRegistry instance;
  return instance;
}

}  // namespace webcad
