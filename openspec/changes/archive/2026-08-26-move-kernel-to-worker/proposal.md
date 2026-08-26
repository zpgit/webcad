## Why

MVP-0 measured the OCCT/WASM-to-render boundary and found the main thread already
blocked on trivial geometry: `subtract` on two primitives takes 66–73 ms and a fine
tessellation 168–187 ms, against a 16.7 ms frame budget
(`docs/MVP-0-FINDINGS.md:38-65`). Three of the ten operations in a basic
create-create-subtract session exceed the budget, and real models are orders of
magnitude heavier. The findings recommend moving the kernel into a Worker
**before** the native document format is designed, because a document layer built
against a main-thread kernel would have to be revisited
(`docs/MVP-0-FINDINGS.md:186-190`).

This change does the Worker move alone, ahead of the rest of MVP-1. The migration
cost was deliberately pre-paid — every kernel operation is already `async` and
every argument and return value is already postMessage-compatible
(`src/kernel/types.ts:1-7`, `src/kernel/kernel.ts:61-64`) — so this changes the
transport, not the call sites. Doing it as its own change means the document
container is designed against a measured Worker boundary rather than alongside an
unmeasured one.

## What Changes

- Run the OCCT WASM module inside a **dedicated Worker**. The main thread keeps no
  reference to the module and never calls into WASM.
- Introduce a **request/response protocol** over `postMessage`: each operation is a
  correlated request carrying handles and plain parameters, answered by a result or
  a typed failure. `BodyId` remains an opaque integer minted inside the Worker.
- **BREAKING (internal API):** `withTessellation(bodyId, options, consume)` is
  replaced by a call returning **owned, transferred buffers**. The callback existed
  to make "a view over WASM memory must not outlive the synchronous block" a
  structural rule (`src/kernel/kernel.ts:245-253`); across a Worker boundary there
  is no view to protect, and the rule becomes unnecessary rather than merely
  unenforced. `tessellateToCopy` collapses into the single remaining form. Call
  sites are `ModelingSession.#render` and the tests.
- Transfer mesh buffers as **transferables**, and have the viewport adopt the
  received `ArrayBuffer`s directly instead of re-copying them into
  `BufferAttribute`s (`src/viewport/viewport.ts:103-118`), so the Worker hop adds a
  copy inside the Worker but removes one on the main thread.
- Reconstruct **typed errors on the main thread**. Error subclasses do not survive
  structured cloning, so failures cross as a discriminated payload and are rethrown
  as the same error types callers catch today (`src/kernel/errors.ts`).
- Split each **operation log** entry into kernel time and transport time, so the
  two costs are never conflated. The log itself lives on the main thread, fed by
  the scalars riding back on each response: only that side can see the round trip,
  so a Worker-side copy would be strictly poorer.
- **Measure the boundary the change introduces**: mesh-copy and postMessage
  round-trip cost, transferable versus structured-clone copy, and main-thread
  responsiveness during a Boolean. Results land in `measurements/` and a findings
  section, matching how MVP-0 reported.
- Keep the kernel usable **outside a browser**: node tests drive the same protocol
  over an in-process transport, so the existing 49 tests do not need a Worker.

Non-goals, each deliberately deferred: the native document container, `.brep`
checkpoints, and any persistence (the next MVP-1 change); `SharedArrayBuffer` and
shared memory, which `docs/MVP-0-FINDINGS.md:74-75` says must stay closed until
plain message passing is measured and found wanting; multiple Workers or parallel
kernel operations; cancellation of in-flight operations; and any new modeling
capability. No geometry behavior changes.

## Capabilities

### New Capabilities

- `kernel-worker`: Worker-hosted execution of the geometry kernel — Worker
  lifecycle and startup, the correlated request/response protocol, operation
  ordering, transfer of mesh payloads, propagation of typed failures across the
  boundary, the main-thread responsiveness guarantee, and the pluggable transport
  that lets non-browser callers run the same protocol in-process.

### Modified Capabilities

- `geometry-kernel`: initialization now covers Worker startup as well as module
  instantiation, and adds behavior for a Worker that fails to start or dies
  mid-session; error propagation must survive structured cloning rather than
  merely crossing the WASM boundary; boundary instrumentation must attribute
  duration to kernel work versus transport instead of reporting one number.
- `tessellation`: the "typed-array views valid only inside the callback"
  contract is replaced by "the caller receives owned buffers"; the mesh cache and
  its invalidation now live on the Worker side of the boundary.
- `viewport`: the no-redundant-copy requirement for the mesh-to-GPU path is
  restated for a transferred buffer, which the viewport adopts rather than copies.

## Impact

- **Code**: new `src/kernel/worker/` (Worker entry, protocol, transports);
  `src/kernel/kernel.ts` becomes a proxy over a transport rather than a direct WASM
  facade; `src/kernel/wasm-module.ts` is imported only by Worker-side code;
  `src/app/modeling-session.ts` and `src/viewport/viewport.ts` adapt to owned
  buffers; `src/main.ts` constructs the Worker-backed kernel.
- **Tests**: `tests/helpers/kernel.ts` switches to the in-process transport so the
  existing suites are unchanged in substance; new tests cover protocol correlation,
  Worker failure, and error-type reconstruction.
- **Build**: Vite must emit the Worker as its own chunk with the `.wasm` artifact
  still a separately fetchable asset (`vite.config.ts`). The COOP/COEP headers
  already present stay as they are — they were added for a shared-memory option
  this change does not take.
- **Measurement**: `scripts/verify-browser.mjs` gains main-thread-responsiveness
  and transport-cost measurements; `measurements/` gains their output.
- **Not affected**: the C++ facade in `native/src/`, the OCCT build pipeline, the
  kernel payload size, and all geometric behavior. `BodyId` semantics, handle
  lifetime ownership, and the empty-result-versus-failure distinction are
  unchanged.
- **Risk**: the change is transport-only by design, but it touches every kernel
  call path at once. The existing test suite plus the browser verification run are
  the guard, and both must pass unchanged apart from the tessellation signature.
