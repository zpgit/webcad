# geometry-kernel Specification

## Purpose

Defines the boundary between the OCCT geometry kernel running in WebAssembly and
the TypeScript application, and the ownership rules that boundary imposes.

The governing constraint is that canonical B-Rep data never leaves WASM memory.
JavaScript holds opaque handles; only tessellation output and scalar
measurements cross into it. This is what keeps geometry exact rather than
degrading into a mesh approximation, and it is the claim every other capability
here depends on.

Two consequences shape the rest of this spec. WASM linear memory is invisible to
the JavaScript garbage collector, so body lifetime is explicitly caller-owned.
And a C++ exception escaping the boundary would abort the module, so every entry
point catches and translates failures into typed JavaScript errors, leaving the
kernel usable afterwards.

Instrumentation is specified here as a deliverable rather than a debugging aid,
because measuring this boundary is why the capability was built first.
## Requirements
### Requirement: Kernel module initialization

The system SHALL provide an initialization entry point that starts the kernel Worker and loads and instantiates the OCCT WebAssembly module inside it, before any geometry operation is attempted. Geometry APIs invoked before initialization completes MUST fail with a distinguishable error rather than producing undefined behavior. Initialization MUST NOT be reported as complete until the Worker has confirmed the module is instantiated and ready to serve requests.

#### Scenario: Successful initialization

- **WHEN** the application calls the kernel initialization entry point in a browser supporting WebAssembly and Workers
- **THEN** the Worker starts, the OCCT WASM module is instantiated inside it, and the returned kernel instance reports itself ready, exposing the OCCT version it was built from

#### Scenario: Operation attempted before initialization

- **WHEN** a caller invokes a geometry operation on a kernel instance that has not finished initializing
- **THEN** the call fails with a `KernelNotReady` error, no request is sent to the Worker, and no geometry state is created or mutated

#### Scenario: WebAssembly unavailable

- **WHEN** initialization is attempted in an environment where the Worker cannot start or WebAssembly instantiation inside it fails
- **THEN** initialization rejects with an error identifying the unsupported environment, the failure is reported without leaving a partially constructed kernel instance, and any Worker that did start is terminated

#### Scenario: Repeated initialization

- **WHEN** the initialization entry point is called more than once on the same kernel instance
- **THEN** at most one Worker is started and one module instantiated, and every caller receives the same ready instance

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

There are exactly two bounded exceptions to what may be passed, and both are byte payloads rather than representations:

1. An **opaque serialized payload**, as defined above. The caller cannot construct one, inspect one, or derive one from anything but a prior kernel serialization.
2. A **foreign interchange payload** — the bytes of a file in a published exchange format, which the caller *can* construct because they come from outside this system. It is admitted only to a translation operation, never to a modeling one, and admitting it MUST NOT weaken the outbound rule: a translation MAY consume foreign bytes, but every operation that returns geometry still returns handles, and no operation exposes the entities, attributes, or product structure a foreign payload contains.

No modeling operation SHALL accept geometry in any other non-handle form.

#### Scenario: Operation invoked by handle

- **WHEN** a caller invokes a Boolean operation passing two `BodyId` handles and no geometric payload
- **THEN** the operation executes inside WASM against the referenced shapes and returns a `BodyId` for the result

#### Scenario: Unknown handle rejected

- **WHEN** a caller passes a `BodyId` that was never issued by this kernel instance, or that has already been released
- **THEN** the operation fails with an `InvalidHandle` error and no geometry state is mutated

#### Scenario: Serialization takes handles and returns bytes

- **WHEN** a caller serializes bodies
- **THEN** the operation is invoked with handles alone and returns an opaque payload, and restoring that payload returns handles alone

#### Scenario: Translation is the only consumer of foreign bytes

- **WHEN** the kernel API surface is inspected
- **THEN** the only operations accepting a caller-constructed interchange payload are translation operations, and no primitive, Boolean, tessellation, or inspection operation accepts one

#### Scenario: Translating foreign bytes still returns handles

- **WHEN** a caller hands the kernel a foreign interchange payload to translate
- **THEN** the geometry is constructed inside WASM and reported as handles, and the payload's internal entities are never surfaced as JavaScript structures

#### Scenario: Modeling operations still refuse non-handle geometry

- **WHEN** the kernel API surface is inspected
- **THEN** no primitive, Boolean, tessellation, or inspection operation accepts geometry as anything but a handle

### Requirement: Handle allocation and explicit release

The kernel SHALL issue unique, non-reused handles for every body it creates and SHALL provide an explicit release operation that frees the underlying WASM-side geometry. Because WASM linear memory is not reclaimed by the JavaScript garbage collector, handle lifetime MUST be owned by the caller.

#### Scenario: Handles are unique

- **WHEN** multiple bodies are created over the lifetime of a kernel instance
- **THEN** every issued `BodyId` is distinct, and an identifier is never reissued for a different body after its original body is released

#### Scenario: Release frees kernel memory

- **WHEN** a caller releases a `BodyId`
- **THEN** the underlying shape is destroyed inside the kernel, reported WASM memory usage for that body is reclaimed, and subsequent operations on that handle fail with `InvalidHandle`

#### Scenario: Releasing an already-released handle

- **WHEN** a caller releases a `BodyId` that has already been released
- **THEN** the call fails with `InvalidHandle` without corrupting kernel state or freeing unrelated geometry

#### Scenario: Live handles are enumerable for leak detection

- **WHEN** a caller queries the kernel for its live-handle count
- **THEN** the kernel reports the number of currently allocated bodies, so tests can assert that a completed workflow leaves no unreleased handles

### Requirement: Kernel failures propagate as typed JavaScript errors

OCCT operations that fail internally — including C++ exceptions and failed algorithm status codes — SHALL be caught at the WASM boundary and surfaced to the calling thread as typed errors. A kernel failure MUST NOT abort the WASM module, terminate the Worker, corrupt kernel state, or leave partially constructed geometry reachable by a handle. Because error objects do not survive the Worker boundary as their original types, failures MUST cross as a payload carrying the discriminating code, message, and operation identifier, and MUST be reconstructed into the corresponding error type before the caller observes them.

#### Scenario: Failing operation reported as typed error

- **WHEN** an OCCT algorithm reports failure during an operation
- **THEN** the operation rejects on the calling thread with a typed error carrying an operation identifier and the kernel's failure reason, and no handle is issued for the failed result

#### Scenario: Error type survives the Worker boundary

- **WHEN** a caller catches a rejection originating from a Worker-side kernel failure
- **THEN** the caught value is an instance of the same error type an in-process kernel would raise, discriminable by type and code rather than by matching message text

#### Scenario: Kernel remains usable after a failure

- **WHEN** an operation has failed with a kernel error
- **THEN** the Worker remains alive, the kernel instance remains initialized, and subsequent valid operations succeed normally

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

