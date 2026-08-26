## ADDED Requirements

### Requirement: Kernel executes off the main thread

The geometry kernel SHALL execute inside a dedicated Worker. The main thread MUST NOT instantiate, hold a reference to, or call into the OCCT WebAssembly module, so that no geometry operation can block rendering or input handling regardless of how long it runs.

#### Scenario: WASM module is instantiated only in the Worker

- **WHEN** the application initializes the kernel in a browser
- **THEN** the OCCT WebAssembly module is instantiated inside the Worker, and the main-thread kernel object exposes no path to the module, its heap views, or its exported functions

#### Scenario: Main thread stays responsive during a long operation

- **WHEN** an operation that exceeds the frame budget — such as a Boolean between two solids, or a fine tessellation — is in flight
- **THEN** the main thread continues to service rendering and input, and the longest main-thread task attributable to the operation stays within one frame budget

#### Scenario: Camera navigation during a running operation

- **WHEN** the user orbits the viewport while a kernel operation has not yet completed
- **THEN** the camera responds continuously and the already-rendered bodies keep drawing, rather than the viewport freezing until the operation returns

### Requirement: Correlated request/response protocol

Communication with the Worker SHALL use a request/response protocol in which every request carries a unique correlation identifier and is answered by exactly one response bearing that identifier. Responses MUST be routed to the originating caller, and a response for an unknown or already-settled identifier MUST be discarded without settling an unrelated call.

#### Scenario: Concurrent calls each receive their own result

- **WHEN** several kernel operations are invoked without awaiting the previous one
- **THEN** each returned promise settles with the result of the operation it requested, and no result is delivered to the wrong caller

#### Scenario: Response arrives for an unknown request

- **WHEN** the main thread receives a message whose correlation identifier matches no pending request
- **THEN** the message is ignored, no pending call is settled, and the kernel remains usable

#### Scenario: No pending request is left unsettled

- **WHEN** the Worker has answered every request it received
- **THEN** the main thread holds no pending correlation entries, so a long session does not accumulate them

### Requirement: Operations execute in request order

The Worker SHALL execute requests one at a time, in the order it received them. The kernel holds mutable state — the handle table and the mesh cache — behind a single-threaded OCCT instance, so overlapping execution MUST NOT be introduced by the transport.

#### Scenario: Ordering across unawaited calls

- **WHEN** a caller issues create, Boolean, and release requests without awaiting each in turn
- **THEN** the Worker executes them in the order issued, and the resulting handle state matches what sequential execution would have produced

#### Scenario: A failing operation does not stall the queue

- **WHEN** a queued operation fails with a kernel error
- **THEN** its caller is rejected and the following queued operations still execute

### Requirement: Mesh payloads cross the boundary as owned transferable buffers

Tessellation output SHALL cross from the Worker to the main thread as transferable `ArrayBuffer`s whose ownership moves to the receiver. The Worker MUST NOT retain a reference to a transferred buffer after sending it, and the receiver MUST be free to retain the buffer for as long as it needs, without any constraint tied to WASM memory lifetime.

#### Scenario: Mesh buffers are transferred rather than structurally cloned

- **WHEN** a tessellation result is sent from the Worker to the main thread
- **THEN** its position, normal, and index buffers are listed as transferables, and the Worker's copies are detached afterwards

#### Scenario: Received mesh survives subsequent kernel operations

- **WHEN** the main thread retains a received mesh buffer and then runs further kernel operations that grow WASM memory
- **THEN** the retained buffer remains valid and its contents are unchanged, because it no longer aliases WASM linear memory

#### Scenario: A failed tessellation transfers nothing

- **WHEN** a tessellation request fails
- **THEN** the failure response carries no mesh buffers and no partially filled buffer is transferred

### Requirement: Failures cross the boundary as their original error types

Kernel failures SHALL be reported to the caller as the same typed errors an in-process kernel raises. Because error subclasses do not survive structured cloning, the Worker MUST send a failure payload carrying the error's discriminating code, message, and operation identifier, and the main thread MUST reconstruct the corresponding error type before rejecting the caller.

#### Scenario: Invalid handle reported as InvalidHandle

- **WHEN** a caller invokes an operation with a `BodyId` that was never issued or has been released
- **THEN** the returned promise rejects with an `InvalidHandle` error carrying the operation identifier, distinguishable by type rather than by matching message text

#### Scenario: Empty Boolean result is not an error

- **WHEN** a Boolean operation legitimately produces no geometry
- **THEN** the response crosses the boundary as a successful empty outcome rather than a failure, preserving the distinction between "no geometry" and "operation failed"

#### Scenario: An unexpected Worker-side exception is still typed

- **WHEN** code inside the Worker throws an error that is not one of the kernel's own status failures
- **THEN** the caller is rejected with a typed kernel error carrying the originating operation, and the Worker remains able to serve subsequent requests

### Requirement: Worker lifecycle and failure

The kernel SHALL own the Worker's lifecycle: starting it during initialization, reporting a startup failure without leaving a partially constructed kernel, rejecting outstanding work if the Worker terminates unexpectedly, and providing explicit disposal.

#### Scenario: Worker fails to start

- **WHEN** the Worker cannot be created or its module fails to instantiate
- **THEN** initialization rejects with an error identifying the unsupported environment, the kernel does not report itself ready, and a later initialization attempt may retry

#### Scenario: Worker dies mid-session

- **WHEN** the Worker terminates unexpectedly while requests are outstanding
- **THEN** every pending request rejects with a typed error rather than hanging forever, and the kernel reports itself no longer ready

#### Scenario: Explicit disposal

- **WHEN** a caller disposes the kernel
- **THEN** the Worker is terminated, all WASM-side geometry it held goes away with it, pending requests reject, and subsequent operations fail with a not-ready error rather than silently doing nothing

### Requirement: Transport is pluggable for non-browser callers

The kernel SHALL communicate with the Worker through a transport abstraction, and SHALL provide an in-process transport that runs the same protocol without a Worker. Test and tooling environments without Worker support MUST be able to exercise the identical request handling path rather than a divergent code path.

#### Scenario: Same protocol in process

- **WHEN** the kernel is constructed with the in-process transport
- **THEN** requests are handled by the same Worker-side request handler, produce the same responses, and surface the same typed errors as the Worker transport

#### Scenario: Node test suite runs without a Worker

- **WHEN** the geometry test suites run under Node against the built kernel artifact
- **THEN** they exercise the kernel through the in-process transport and assert the same behavior as before this change, apart from receiving owned mesh buffers instead of WASM-memory views
