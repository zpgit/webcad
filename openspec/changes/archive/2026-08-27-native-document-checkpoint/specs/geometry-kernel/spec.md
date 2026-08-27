## MODIFIED Requirements

### Requirement: Exact geometry remains resident in WASM memory

Canonical B-Rep data SHALL remain in WASM linear memory or the OCCT kernel heap. The JavaScript/TypeScript layer MUST NOT receive materialized topology, curve, or surface structures. The only geometric data permitted to cross the boundary into JavaScript is tessellation output, scalar measurements such as volume, area, or bounding-box extents, and **opaque serialized payloads**.

An opaque serialized payload is a byte sequence produced by the kernel's own B-Rep serialization. It is permitted to cross because it is not a materialized representation: JavaScript may store it, measure it, hash it, and hand it back to the kernel, but MUST NOT parse, edit, split, or merge it, and the kernel MUST NOT expose any API that decodes it into JavaScript structures. The rule is unchanged in substance — no second geometry representation may exist outside the kernel — and is stated in these terms because a payload of bytes is the one form in which exact geometry may leave WASM without becoming such a representation.

#### Scenario: Body creation returns a handle, not geometry

- **WHEN** a caller creates a body through any kernel operation
- **THEN** the return value is an opaque `BodyId` carrying no topology, curve, or surface data, and the underlying `TopoDS_Shape` remains inside WASM memory

#### Scenario: Topology inspection is not exposed as JS structures

- **WHEN** a caller requests information about a body's topology
- **THEN** the kernel API surface provides only counts, scalar measurements, and opaque sub-entity handles, and provides no API that serializes faces, edges, curves, or surfaces into JavaScript objects

#### Scenario: A serialized payload is opaque, not a representation

- **WHEN** a caller obtains a serialized B-Rep payload from the kernel
- **THEN** it receives bytes it can store and return unmodified, and the kernel offers no operation that reveals the topology, curves, or surfaces those bytes encode

#### Scenario: Restoring geometry does not import a representation

- **WHEN** a caller hands a payload back to the kernel to restore
- **THEN** the resulting geometry is constructed inside WASM and reported as handles, and no B-Rep structure is ever constructed on the JavaScript side

### Requirement: Handle-based operation API

The kernel SHALL expose modeling operations as functions that accept and return handles, in the shape `kernel.<operation>({ ...handles, ...parameters })`. Operations MUST NOT require the caller to pass or receive materialized B-Rep representations.

Serialization is the single deliberate exception to what may be passed, and it is bounded: an operation MAY accept or return an **opaque serialized payload** as defined above. Such a payload is a parameter, not a representation — the caller cannot construct one, inspect one, or derive one from anything but a prior kernel serialization. No modeling operation SHALL accept geometry in any other non-handle form.

#### Scenario: Operation invoked by handle

- **WHEN** a caller invokes a Boolean operation passing two `BodyId` handles and no geometric payload
- **THEN** the operation executes inside WASM against the referenced shapes and returns a `BodyId` for the result

#### Scenario: Unknown handle rejected

- **WHEN** a caller passes a `BodyId` that was never issued by this kernel instance, or that has already been released
- **THEN** the operation fails with an `InvalidHandle` error and no geometry state is mutated

#### Scenario: Serialization takes handles and returns bytes

- **WHEN** a caller serializes bodies
- **THEN** the operation is invoked with handles alone and returns an opaque payload, and restoring that payload returns handles alone

#### Scenario: Modeling operations still refuse non-handle geometry

- **WHEN** the kernel API surface is inspected
- **THEN** no primitive, Boolean, tessellation, or inspection operation accepts geometry as anything but a handle

### Requirement: Boundary instrumentation

The kernel SHALL record, for each operation, its wall-clock duration and the WASM memory in use after completion, and SHALL expose these measurements for reporting. Duration MUST be attributed separately to kernel execution inside the Worker and to transport — request dispatch, response delivery, and any copying the boundary requires — so the cost of hosting the kernel off the main thread is measured rather than folded into the geometry cost. For every operation that moves a binary payload across the boundary, in either direction, the bytes moved MUST be recorded. Measuring this boundary is a deliverable rather than a debugging aid.

#### Scenario: Operation timing captured

- **WHEN** any kernel operation completes, whether successfully or with a failure
- **THEN** its wall-clock duration and operation type are recorded in a retrievable performance log

#### Scenario: Kernel time and transport time reported separately

- **WHEN** a caller inspects a completed operation's log entry
- **THEN** it reports the time spent executing inside the Worker and the round-trip time observed by the caller, so transport overhead is attributable rather than inferred

#### Scenario: Mesh transfer cost is measured

- **WHEN** a tessellation crosses the Worker boundary
- **THEN** the bytes transferred and the cost of preparing the transferable buffers are recorded, so the copy the boundary introduces is a measured figure rather than an assumed-free one

#### Scenario: Serialized payload size is measured in both directions

- **WHEN** a serialization sends bytes out of the Worker, or a restoration sends bytes into it
- **THEN** the payload's byte count is recorded on the operation's log entry, so checkpoint size can be related to the time spent producing or consuming it

#### Scenario: Peak WASM memory retrievable

- **WHEN** a caller queries kernel memory statistics
- **THEN** the kernel reports current WASM linear-memory size and the peak value observed during the session, gathered from inside the Worker where the module lives
