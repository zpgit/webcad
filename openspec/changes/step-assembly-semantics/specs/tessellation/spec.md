## ADDED Requirements

### Requirement: A mesh belongs to a body and is reused across its instances

A tessellation SHALL be a product of a body, not of an occurrence. Where a body is referenced by several instances, the mesh MUST be computed once and shared; the render path MUST NOT hold one copy of the vertex data per instance. Reuse is a requirement rather than an optimization, because an instanced representation that materializes its copies downstream is not instanced.

#### Scenario: Twenty instances tessellate once

- **WHEN** a body referenced by twenty instances is displayed
- **THEN** the mesher runs once for that body, and the number of meshes held does not grow with the instance count

#### Scenario: Instance count does not invalidate a mesh

- **WHEN** an instance is added or removed without changing any body's geometry
- **THEN** no re-tessellation occurs and the cached mesh continues to serve

#### Scenario: Editing a body invalidates its mesh once

- **WHEN** a body referenced by several instances is edited
- **THEN** its mesh is invalidated and recomputed once, and every instance shows the new geometry

### Requirement: A mesh carries the face ranges its buffers were built from

A tessellation SHALL report, alongside its buffers, the index range each face contributed, in the same order the mesher visited faces. These ranges exist so that per-face display attributes can be applied and coloured faces counted.

There SHALL be one range per face visited, **including an empty range for a face the mesher produced no triangulation for**. The mesher skips such a face when emitting vertices, so ranges counted only where geometry was emitted would silently shift every later face's position by one — which is precisely the corruption a positionally-keyed attribute cannot survive. One range per visited face keeps position and face in step whether or not the face contributed a triangle.

A range is a span into a buffer and MUST NOT be presented as an identity: it SHALL NOT be returned as a face handle, MUST NOT be persisted as a reference to a face, and MUST NOT be usable to address a face in any operation. It is valid only for the mesh it accompanies, and is invalidated with that mesh.

#### Scenario: Ranges accompany the buffers

- **WHEN** a body is tessellated
- **THEN** the result reports one index range per face, in visitation order, the non-empty ranges tile the index buffer without gap or overlap, and the number of ranges equals the body's reported face count

#### Scenario: A range is not a handle

- **WHEN** the kernel API surface is inspected
- **THEN** no operation accepts a face range or a face index as a way to address geometry, and no range is persisted in a document

#### Scenario: An untriangulated face still occupies its position

- **WHEN** a body contains a face the mesher produces no triangulation for
- **THEN** that face is reported as an empty range in its own position, the following faces keep their positions, and the range count still equals the face count

#### Scenario: Ranges die with their mesh

- **WHEN** a body is edited and re-tessellated
- **THEN** the previous ranges are discarded with the previous buffers, and nothing carries an old range forward onto the new mesh
