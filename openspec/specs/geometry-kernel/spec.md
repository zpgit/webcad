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

The system SHALL provide an initialization entry point that loads and instantiates the OCCT WebAssembly module before any geometry operation is attempted. Geometry APIs invoked before initialization completes MUST fail with a distinguishable error rather than producing undefined behavior.

#### Scenario: Successful initialization

- **WHEN** the application calls the kernel initialization entry point in a browser supporting WebAssembly
- **THEN** the OCCT WASM module is instantiated and the returned kernel instance reports itself ready, exposing the OCCT version it was built from

#### Scenario: Operation attempted before initialization

- **WHEN** a caller invokes a geometry operation on a kernel instance that has not finished initializing
- **THEN** the call fails with a `KernelNotReady` error and no geometry state is created or mutated

#### Scenario: WebAssembly unavailable

- **WHEN** initialization is attempted in an environment where WebAssembly instantiation fails
- **THEN** initialization rejects with an error identifying the unsupported environment, and the failure is reported without leaving a partially constructed kernel instance

#### Scenario: Repeated initialization

- **WHEN** the initialization entry point is called more than once on the same kernel instance
- **THEN** the module is instantiated at most once and every caller receives the same ready instance

### Requirement: Exact geometry remains resident in WASM memory

Canonical B-Rep data SHALL remain in WASM linear memory or the OCCT kernel heap. The JavaScript/TypeScript layer MUST NOT receive materialized topology, curve, or surface structures. The only geometric data permitted to cross the boundary into JavaScript is tessellation output and scalar measurements such as volume, area, or bounding-box extents.

#### Scenario: Body creation returns a handle, not geometry

- **WHEN** a caller creates a body through any kernel operation
- **THEN** the return value is an opaque `BodyId` carrying no topology, curve, or surface data, and the underlying `TopoDS_Shape` remains inside WASM memory

#### Scenario: Topology inspection is not exposed as JS structures

- **WHEN** a caller requests information about a body's topology
- **THEN** the kernel API surface provides only counts, scalar measurements, and opaque sub-entity handles, and provides no API that serializes faces, edges, curves, or surfaces into JavaScript objects

### Requirement: Handle-based operation API

The kernel SHALL expose modeling operations as functions that accept and return handles, in the shape `kernel.<operation>({ ...handles, ...parameters })`. Operations MUST NOT require the caller to pass or receive B-Rep representations.

#### Scenario: Operation invoked by handle

- **WHEN** a caller invokes a Boolean operation passing two `BodyId` handles and no geometric payload
- **THEN** the operation executes inside WASM against the referenced shapes and returns a `BodyId` for the result

#### Scenario: Unknown handle rejected

- **WHEN** a caller passes a `BodyId` that was never issued by this kernel instance, or that has already been released
- **THEN** the operation fails with an `InvalidHandle` error and no geometry state is mutated

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

OCCT operations that fail internally — including C++ exceptions and failed algorithm status codes — SHALL be caught at the WASM boundary and surfaced to JavaScript as typed errors. A kernel failure MUST NOT abort the WASM module, corrupt kernel state, or leave partially constructed geometry reachable by a handle.

#### Scenario: Failing operation reported as typed error

- **WHEN** an OCCT algorithm reports failure during an operation
- **THEN** the operation rejects with a typed error carrying an operation identifier and the kernel's failure reason, and no handle is issued for the failed result

#### Scenario: Kernel remains usable after a failure

- **WHEN** an operation has failed with a kernel error
- **THEN** the kernel instance remains initialized and subsequent valid operations succeed normally

### Requirement: Boundary instrumentation

The kernel SHALL record, for each operation, its wall-clock duration and the WASM memory in use after completion, and SHALL expose these measurements for reporting. MVP-0 exists to measure the OCCT/WASM-to-rendering boundary, so these measurements are a deliverable rather than a debugging aid.

#### Scenario: Operation timing captured

- **WHEN** any kernel operation completes, whether successfully or with a failure
- **THEN** its wall-clock duration and operation type are recorded in a retrievable performance log

#### Scenario: Peak WASM memory retrievable

- **WHEN** a caller queries kernel memory statistics
- **THEN** the kernel reports current WASM linear-memory size and the peak value observed during the session

