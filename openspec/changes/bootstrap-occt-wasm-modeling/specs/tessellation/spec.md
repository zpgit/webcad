## ADDED Requirements

### Requirement: Tessellate a body into render buffers

The kernel SHALL convert a canonical B-Rep body into renderable buffers — vertex positions, vertex normals, and triangle indices — and expose them to JavaScript. Tessellation output is the only geometric data permitted to cross the WASM boundary into JavaScript.

#### Scenario: Body tessellated successfully

- **WHEN** a caller tessellates a valid solid body
- **THEN** the operation returns typed-array views or copies containing vertex positions, normals, and triangle indices, with index values all within the vertex-count range

#### Scenario: Curved surfaces produce multiple triangles

- **WHEN** a cylinder body is tessellated
- **THEN** its analytic cylindrical face is approximated by multiple triangles, while the body's own geometry remains the exact analytic surface

#### Scenario: Triangle count reported

- **WHEN** tessellation completes
- **THEN** the result reports its triangle and vertex counts, so the boundary cost of rendering a body can be measured

#### Scenario: Tessellating an invalid handle

- **WHEN** a caller tessellates a `BodyId` that was never issued or has been released
- **THEN** the operation fails with `InvalidHandle` and no buffers are produced

### Requirement: Caller-controlled deflection tolerance

Tessellation SHALL accept a linear deflection tolerance, and MAY accept an angular tolerance, controlling how finely curved surfaces are approximated. A smaller linear deflection MUST produce a mesh that approximates the exact surface at least as closely as a larger one.

#### Scenario: Finer deflection increases fidelity

- **WHEN** the same cylinder body is tessellated at a coarse linear deflection and then at a finer one
- **THEN** the finer tessellation produces more triangles and a smaller maximum deviation from the exact cylindrical surface

#### Scenario: Default tolerance applied

- **WHEN** a caller tessellates a body without specifying a deflection tolerance
- **THEN** a documented default is applied, and the tolerance actually used is reported in the result

#### Scenario: Invalid tolerance rejected

- **WHEN** a caller supplies a linear deflection that is zero or negative
- **THEN** the operation fails with an `InvalidParameter` error rather than attempting an unbounded tessellation

### Requirement: Mesh is never the geometric source of truth

Tessellation output SHALL be treated as a derived, disposable render artifact. The system MUST NOT provide any path by which mesh data is converted back into canonical geometry, and MUST NOT use mesh data as input to any modeling operation.

#### Scenario: No mesh-to-geometry path exists

- **WHEN** the kernel API surface is reviewed for operations accepting mesh buffers as geometric input
- **THEN** no such operation exists; modeling operations accept only handles and parameters

#### Scenario: Discarding a mesh does not affect geometry

- **WHEN** a caller discards a tessellation result and then re-tessellates the same body
- **THEN** the body is unchanged and the newly produced mesh is equivalent to the discarded one for the same tolerance

### Requirement: Tessellation cache and invalidation

The system SHALL be permitted to cache tessellation results per body and tolerance, and MUST ensure a cached mesh is never served for geometry it no longer represents. Because bodies are immutable once created and modeling operations produce new handles, cache entries are keyed by handle and tolerance.

#### Scenario: Repeated tessellation is served from cache

- **WHEN** the same body is tessellated twice at the same tolerance with no intervening change
- **THEN** the second call returns an equivalent mesh and does not re-run the meshing algorithm, as observable in the recorded operation timings

#### Scenario: Different tolerance is not served from cache

- **WHEN** a body already tessellated at one tolerance is tessellated at a different tolerance
- **THEN** a new tessellation is computed rather than the existing cached mesh being returned

#### Scenario: Releasing a body evicts its cached mesh

- **WHEN** a caller releases a `BodyId` that has cached tessellation data
- **THEN** the associated cache entry is evicted and its memory released, and the released handle serves no mesh
