## Context

MVP-0 deliberately ran the kernel on the main thread and instrumented it, so the
Worker question would be answered by numbers. It was: `subtract` on two primitives
costs 66–73 ms and a fine tessellation 168–187 ms against a 16.7 ms frame
(`docs/MVP-0-FINDINGS.md:38-65`). The findings recommend the move happen before
the native document format exists, so the document layer is designed against a
Worker-hosted kernel rather than retrofitted onto one.

The migration cost was pre-paid. Every operation on `Kernel` is already `async`,
and `src/kernel/types.ts` was written so that every argument and return value is
postMessage-compatible — handles are integers, parameters are plain objects, mesh
data is typed arrays. What remains is genuinely transport work, with three places
where the current design assumes shared memory and cannot simply be relayed:

1. **`withTessellation`** hands the caller typed-array views over WASM memory and
   confines them to a synchronous callback (`src/kernel/kernel.ts:245-317`). Views
   cannot cross a Worker boundary at all.
2. **Synchronous accessors** — `occtVersion`, `defaultTolerances`, `stats()`,
   `operationLog` — are read straight out of the module and consumed synchronously
   by the UI readout (`src/main.ts:74-77`). Nothing synchronous can read Worker
   state.
3. **Typed errors** (`src/kernel/errors.ts`) are class instances. Structured
   cloning flattens them to plain `Error`, losing the type discrimination the specs
   require.

## Goals / Non-Goals

**Goals:**

- No geometry work on the main thread; long operations never block rendering or
  input.
- Call sites change as little as possible. `ModelingSession` and the test suites
  should read almost the same afterwards.
- Measure what the boundary costs — mesh copy, round trip, transferable versus
  clone — rather than assuming it is free, per `docs/MVP-0-FINDINGS.md:67-72`.
- Keep the Node test suites running without a Worker, against the same request
  handling code the Worker uses.
- Preserve every existing behavioral guarantee: handle lifetime ownership, typed
  errors, the empty-result-versus-failure distinction, cache semantics.

**Non-Goals:**

- The native document, `.brep` checkpoints, persistence. Next change.
- `SharedArrayBuffer`. `docs/MVP-0-FINDINGS.md:74-75` is explicit that shared
  memory stays closed until plain message passing is measured and found wanting.
  This change produces the measurement that would justify reopening it.
- Parallelism of any kind: one Worker, one operation at a time.
- Cancelling in-flight operations. Worth having eventually; not needed to answer
  the question this change exists to answer.

## Decisions

### A dedicated module Worker, with plain message passing

One `new Worker(url, { type: 'module' })` owned by the `Kernel` instance.

Alternatives considered. *Time-slicing on the main thread* is not available: an
OCCT Boolean is one atomic C++ call with no yield points, so the 66 ms is
indivisible. *`SharedArrayBuffer` plus `Atomics`* would avoid the mesh copy but is
ruled out above, and would also make the kernel's memory-growth behavior — which
MVP-0 deliberately made routine (`docs/MVP-0-FINDINGS.md:90-96`) — considerably
harder to reason about, since growth detaches buffers other threads may be
reading. *A shared Worker* buys cross-tab reuse nobody has asked for and
complicates lifetime.

The COOP/COEP headers already in `vite.config.ts` were added to keep the
shared-memory option open. They stay, unused by this change; removing them would
be undoing preparation for a question that is still open.

### A transport abstraction with two implementations

`Kernel` talks to a `Transport` — `send(request, transferables) → Promise<response>`
— rather than to a `Worker` directly. Two implementations: `WorkerTransport` in the
browser, and `InProcessTransport` which invokes the same request handler in the
current realm.

The point is that the *request handler* — the code that owns the WASM module, the
handle table, and the mesh cache — is written once and is the only thing that ever
touches the module. The in-process path is not a mock or a second code path; it is
the same handler minus a `postMessage`. Node tests keep working (Node has
`worker_threads`, but not one that speaks the DOM `Worker` interface, and spinning
one up per test would slow the suite and complicate the `--experimental-strip-types`
loading of the Emscripten artifact).

The honest cost: the in-process transport does not serialize, so it cannot expose a
serialization bug. That is why the browser verification run, not the Node suite, is
the measurement and correctness authority for the boundary itself.

### Correlated requests, FIFO execution

Each request carries a monotonically increasing integer id; the main thread keeps a
`Map<id, {resolve, reject}>` and settles on the matching response. The Worker
executes requests strictly in arrival order through a single promise chain.

Serial execution is not a simplification to revisit later — it is required.
OCCT is single-threaded, and the handle table and mesh cache are mutable state
shared across operations. Interleaving would make `release`-then-`tessellate`
races expressible from callers that today cannot express them.

### Mesh crosses as transferred buffers; `withTessellation` goes away

Inside the Worker, tessellation copies from the WASM heap views into fresh
`Float32Array`/`Uint32Array`s and posts them as transferables. The main thread
receives owned buffers.

This deletes `withTessellation`'s callback, and that is the right outcome rather
than a loss. The callback existed to make one rule structural: a view over WASM
memory must not outlive the synchronous block, because growth detaches it
(`src/kernel/kernel.ts:245-253`). Once the module is in another thread there is no
view on the main thread to protect, so the rule is not being relaxed — its subject
no longer exists. Keeping a callback that no longer guards anything would be
cargo. `tessellateToCopy` collapses into the single remaining `tessellate`.

Net copy accounting, which is the number this change exists to produce:

| | today | after |
| --- | --- | --- |
| WASM heap → JS | view, no copy | one copy, in the Worker |
| postMessage | — | transfer, no copy |
| JS → `BufferAttribute` | one copy (`src/viewport/viewport.ts:107-117`) | none, buffer adopted |

So the expected steady state is one copy either way, moved from the main thread
into the Worker. That is a prediction, and the change is required to verify it
rather than assert it — including an A/B of transferables against plain structured
cloning, so the transfer's benefit is a measured figure.

### Failures cross as a payload and are revived

The Worker sends `{ ok: false, code, message, operation }`; the main thread maps
`code` back to the matching class from `src/kernel/errors.ts` before rejecting.
The status-to-error mapping already exists in `throwForStatus`; this adds a
code-to-error revival beside it, and the two must stay in step — a test asserts
every `KernelError` subclass survives a round trip as its own type.

Note the ordering change this forces: today `throwForStatus` runs on the calling
thread. After the change the *decision* to fail is made in the Worker and the
*throwing* on the main thread. `EmptyResult` keeps its special status of crossing
as a successful value, not a failure.

### Synchronous accessors become snapshots piggybacked on responses

`occtVersion` and `defaultTolerances` are captured once in the initialization
handshake and cached on the main thread — they are constants of the build.

The operation log lives on the main thread rather than in the Worker. Each
response carries the record for the operation it answers, and this side stamps
the round trip onto it — something the Worker cannot see. A Worker-side copy
would therefore be strictly poorer than the mirror, so there is only the mirror.

`stats()` and `operationLog` are live, and the UI readout reads them synchronously
every frame (`src/main.ts:74-77`). Rather than make the readout async or poll on a
timer, every response carries a small scalar tail: the operation's log record and
the current stats snapshot. The main thread mirrors both. The readout stays
synchronous and correct as of the last completed operation, at the cost of roughly
a dozen numbers per response — negligible next to a mesh, and it avoids a second
round trip per frame.

The consequence to accept: `stats()` reflects the last completed operation rather
than this instant. For memory-and-leak reporting that is the same thing in
practice, since nothing changes between operations. An explicit async
`refreshStats()` covers the case where a caller needs it exactly now.

### Vite builds the Worker; the WASM artifact stays a separate asset

The Worker is referenced as `new Worker(new URL('./kernel-worker.ts', import.meta.url), { type: 'module' })`,
which Vite bundles as its own chunk. The Emscripten `.mjs` continues to be a
dynamic `@vite-ignore` import — it is a build product absent from a fresh
checkout, and a static import would break `vite build` before the kernel has ever
been compiled (`src/kernel/kernel.ts:43-52`). That loader moves into the Worker
unchanged, but its URL resolution must be re-verified: `import.meta.url` resolves
against the Worker chunk, not the original module.

## Risks / Trade-offs

- **The WASM `.mjs` fails to resolve from inside the Worker chunk** → the most
  likely concrete breakage in the whole change, because the URL base moves. Verify
  in both `vite dev` and `vite build && vite preview` before anything else is
  built on top; the app's existing "kernel not built" message must still appear
  rather than a silent hang.
- **Use-after-transfer** → a transferred buffer is detached in the sender. If the
  Worker keeps a reference — for the mesh cache, most plausibly — it will read a
  detached buffer. Mitigation: the cache stores the WASM-side tessellation, not
  the transferable; each delivery copies fresh. A test asserts two tessellations of
  the same body at the same tolerance yield independent buffers.
- **The viewport keeps its own copy** → if `upsertBody` is not changed to adopt
  the incoming buffer, the change adds a copy instead of relocating one, and the
  measurement will say so. Mitigation: this is exactly what the A/B measurement is
  for; the viewport spec delta makes adoption a requirement rather than an
  optimization.
- **A regression that only appears under real serialization** → the Node suite
  cannot catch it. Mitigation: the browser verification run is the authority, and
  `npm run verify` must pass before the change is considered done.
- **Every kernel call path changes at once** → there is no partial rollout of a
  transport swap. Mitigation: the 49 existing tests should pass with no change
  beyond the tessellation signature; a diff that needs more than that is a signal
  that behavior moved when it should not have.
- **Debuggability gets worse** → stack traces now cross a thread boundary and
  errors are reconstructed, so the original Worker-side stack is lost. Mitigation:
  carry the Worker-side stack in the failure payload and attach it as `cause`.

## Migration Plan

Sequenced so each step is independently verifiable:

1. Extract the WASM-touching code from `Kernel` into a request handler, keeping the
   current main-thread behavior via `InProcessTransport`. The full test suite must
   pass here — this step should be behavior-preserving.
2. Change the tessellation surface to owned buffers, and update
   `ModelingSession`, `Viewport.upsertBody`, and the tests.
3. Add the Worker entry point and `WorkerTransport`; switch `src/main.ts` to it.
   Verify in dev and in a production build.
4. Add error revival, the piggybacked stats/log tail, and Worker-failure handling.
5. Add the measurements — transport cost, mesh transfer cost, transferable-versus-
   clone, main-thread responsiveness — and write up the results.

Rollback is a revert: nothing here changes persisted state, the native facade, or
the build artifacts, because none of those exist to change yet.

## Open Questions

- **Does the transfer actually beat structured cloning at MVP-0 mesh sizes?**
  Answered, and the answer is no: at 720 B cloning is faster by ~0.013 ms, while
  at 181 kB transferring wins. See
  [`docs/MVP-1-WORKER-FINDINGS.md`](../../../docs/MVP-1-WORKER-FINDINGS.md).
- **Should the operation log stay mirrored on the main thread, or be fetched on
  demand?** Mirroring is chosen here for the synchronous readout. Resolved in
  practice: the tail did not show up in the transport measurements at all, so
  fetching on demand was never needed.
- **Does anything in the eventual document layer need synchronous kernel state?**
  If it does, the snapshot approach needs revisiting before that change rather than
  during it.
