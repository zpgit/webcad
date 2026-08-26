## MODIFIED Requirements

### Requirement: Tessellate a body into render buffers

The kernel SHALL convert a canonical B-Rep body into renderable buffers — vertex positions, vertex normals, and triangle indices — and deliver them to the caller as owned buffers whose lifetime is independent of WASM linear memory. Tessellation output is the only geometric data permitted to cross the WASM boundary. Because the kernel runs in a Worker, the caller never receives a view aliasing kernel memory, and MUST be free to retain the delivered buffers indefinitely.

#### Scenario: Body tessellated successfully

- **WHEN** a caller tessellates a valid solid body
- **THEN** the operation resolves with owned typed arrays containing vertex positions, normals, and triangle indices, with index values all within the vertex-count range

#### Scenario: Delivered buffers outlive kernel activity

- **WHEN** a caller retains a tessellation result and then performs further kernel operations, including ones that grow WASM memory or release the tessellated body
- **THEN** the retained buffers remain valid and their contents unchanged

#### Scenario: Curved surfaces produce multiple triangles

- **WHEN** a cylinder body is tessellated
- **THEN** its analytic cylindrical face is approximated by multiple triangles, while the body's own geometry remains the exact analytic surface

#### Scenario: Triangle count reported

- **WHEN** tessellation completes
- **THEN** the result reports its triangle and vertex counts, so the boundary cost of rendering a body can be measured

#### Scenario: Tessellating an invalid handle

- **WHEN** a caller tessellates a `BodyId` that was never issued or has been released
- **THEN** the operation fails with `InvalidHandle` and no buffers are produced

### Requirement: Tessellation cache and invalidation

The system SHALL be permitted to cache tessellation results per body and tolerance, and MUST ensure a cached mesh is never served for geometry it no longer represents. Because bodies are immutable once created and modeling operations produce new handles, cache entries are keyed by handle and tolerance. The cache lives on the kernel side of the Worker boundary, alongside the geometry it derives from; a cache hit still delivers owned buffers to the caller, so serving from cache MUST NOT hand out a buffer the kernel or a previous caller also holds.

#### Scenario: Repeated tessellation is served from cache

- **WHEN** the same body is tessellated twice at the same tolerance with no intervening change
- **THEN** the second call returns an equivalent mesh and does not re-run the meshing algorithm, as observable in the recorded kernel-side operation timings

#### Scenario: Cached mesh is not aliased across callers

- **WHEN** a body is tessellated twice at the same tolerance and both results are retained
- **THEN** each caller holds its own buffers, and mutating one result does not affect the other or the cached entry

#### Scenario: Different tolerance is not served from cache

- **WHEN** a body already tessellated at one tolerance is tessellated at a different tolerance
- **THEN** a new tessellation is computed rather than the existing cached mesh being returned

#### Scenario: Releasing a body evicts its cached mesh

- **WHEN** a caller releases a `BodyId` that has cached tessellation data
- **THEN** the associated cache entry is evicted and its memory released, and the released handle serves no mesh
