## MODIFIED Requirements

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

The kernel SHALL record, for each operation, its wall-clock duration and the WASM memory in use after completion, and SHALL expose these measurements for reporting. Duration MUST be attributed separately to kernel execution inside the Worker and to transport — request dispatch, response delivery, and any copying the boundary requires — so the cost of hosting the kernel off the main thread is measured rather than folded into the geometry cost. Measuring this boundary is a deliverable rather than a debugging aid.

#### Scenario: Operation timing captured

- **WHEN** any kernel operation completes, whether successfully or with a failure
- **THEN** its wall-clock duration and operation type are recorded in a retrievable performance log

#### Scenario: Kernel time and transport time reported separately

- **WHEN** a caller inspects a completed operation's log entry
- **THEN** it reports the time spent executing inside the Worker and the round-trip time observed by the caller, so transport overhead is attributable rather than inferred

#### Scenario: Mesh transfer cost is measured

- **WHEN** a tessellation crosses the Worker boundary
- **THEN** the bytes transferred and the cost of preparing the transferable buffers are recorded, so the copy the boundary introduces is a measured figure rather than an assumed-free one

#### Scenario: Peak WASM memory retrievable

- **WHEN** a caller queries kernel memory statistics
- **THEN** the kernel reports current WASM linear-memory size and the peak value observed during the session, gathered from inside the Worker where the module lives
