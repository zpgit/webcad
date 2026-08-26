## 1. Extract the request handler (behavior-preserving)

- [x] 1.1 Define the protocol types in `src/kernel/worker/protocol.ts`: a request union (one variant per kernel operation plus `init`), a response union (`ok` payload / `error` payload / `empty` outcome), the correlation id, and the scalar tail carrying the operation log record and stats snapshot.
- [x] 1.2 Move every WASM-touching call out of `Kernel` into `src/kernel/worker/handler.ts` — module instantiation, the `#timed` instrumentation, the status checks, the handle and mesh-cache access. The handler owns the module; nothing else may reference it.
- [x] 1.3 Add `Transport` in `src/kernel/worker/transport.ts` and an `InProcessTransport` that invokes the handler in the current realm.
- [x] 1.4 Rewrite `Kernel` as a proxy over a `Transport`, keeping the current public method signatures. Default it to `InProcessTransport` for now so nothing else has to change yet.
- [x] 1.5 Point `tests/helpers/kernel.ts` at the in-process transport and confirm the existing 49 tests pass unchanged. This step must be behavior-preserving — any test that needs editing here is a signal something moved that should not have.

## 2. Owned mesh buffers

- [x] 2.1 Replace `withTessellation` and `tessellateToCopy` with a single `tessellate(bodyId, options)` resolving to `{ mesh, meta }` with owned typed arrays. Delete the callback form and the WASM-view escape rule it existed to enforce.
- [x] 2.2 In the handler, copy the mesh out of the heap views and record the copy's duration and byte count as part of the tessellation's log entry.
- [x] 2.3 Update `ModelingSession.#render` to await the mesh and hand it to the viewport.
- [x] 2.4 Change `Viewport.upsertBody` to adopt the received arrays directly into `THREE.BufferAttribute` instead of re-copying them (`src/viewport/viewport.ts:107-117`).
- [x] 2.5 Update `tests/tessellation.test.ts` and `tests/e2e-pipeline.test.ts` for the new signature; assert a retained mesh survives later operations that grow WASM memory, and that two tessellations of the same body at the same tolerance return independent buffers rather than aliases of a cached one.

## 3. The Worker transport

- [x] 3.1 Add `src/kernel/worker/kernel-worker.ts`: the Worker entry point that instantiates the handler, executes requests strictly in arrival order through a single promise chain, and posts responses with mesh buffers listed as transferables.
- [x] 3.2 Verify the Emscripten `.mjs` dynamic import still resolves from inside the Worker chunk — `import.meta.url` now resolves against the Worker bundle, not the original module. Check both `npm run dev` and `npm run build && npm run preview`.
- [x] 3.3 Add `WorkerTransport`: monotonic request ids, a pending-request map, response routing, and discard of responses whose id matches nothing pending.
- [x] 3.4 Wire Worker startup into `Kernel.initialize()` — ready only after the Worker confirms the module is instantiated; on failure, terminate any Worker that started and leave the instance retryable.
- [x] 3.5 Switch `src/main.ts` to the Worker-backed kernel and confirm the "kernel not built" message still appears rather than a silent hang when the artifact is missing.
- [x] 3.6 Add `Kernel.dispose()`: terminate the Worker, reject pending requests, and fail subsequent operations with `KernelNotReady`.

## 4. Errors, state, and failure handling

- [x] 4.1 Add error marshalling: the handler emits `{ code, message, operation, stack }`; the main thread revives the matching `KernelError` subclass and attaches the Worker-side stack as `cause`. Keep it beside `throwForStatus` so the two mappings stay in step.
- [x] 4.2 Ensure `EmptyResult` still crosses as a successful `BooleanOutcome`, not a failure.
- [x] 4.3 Capture `occtVersion` and `defaultTolerances` in the init handshake and serve them from the main-thread cache.
- [x] 4.4 Mirror the operation log and stats on the main thread from the tail on each response, so the measurement readout stays synchronous. Add async `refreshStats()` for callers needing an exact-now figure.
- [x] 4.5 Split each log record into kernel-side duration and caller-observed round trip, and surface both in the readout (`src/ui/measurements.ts`).
- [x] 4.6 Handle unexpected Worker termination: reject all pending requests with a typed error and report the kernel not ready.
- [x] 4.7 Add tests for protocol correlation under concurrent unawaited calls, request ordering, error-type round-tripping for every `KernelError` subclass, and Worker-death rejection.

## 5. Measure the boundary

- [x] 5.1 Extend `scripts/verify-browser.mjs` to measure main-thread responsiveness during a Boolean and a fine tessellation — longest main-thread task while the operation is in flight — and assert it stays within a frame.
- [x] 5.2 Measure transport cost per operation: round trip minus kernel-side duration, across the demo-scene sequence.
- [x] 5.3 Measure mesh transfer: bytes moved, Worker-side copy time, and an A/B of transferables against plain structured cloning at both demo-scene and fine-tessellation mesh sizes.
- [x] 5.4 Write the results to `measurements/worker.json` alongside the existing artifacts.
- [x] 5.5 Record the findings in `docs/` — including whether the predicted one-copy steady state held, and whether transferables measurably beat cloning at these sizes. State it honestly if they did not.

## 6. Verify and document

- [x] 6.1 `npm run verify` passes: typecheck, tests, and browser verification. Run `npm run verify:browser:webgl` as well.
- [x] 6.2 Re-record the demo with `npm run demo:record` so the operation log in `docs/demo.gif` reflects a non-blocking kernel — the README calls out the over-budget flag as the finding MVP-1 acts on, and that line needs to become true.
- [x] 6.3 Update the README: status, the Worker in the architecture description, and the `src/kernel/worker/` entry in the layout table.
- [x] 6.4 Update `openspec/specs/` via the change's delta specs, and confirm `openspec validate` passes.
