## Context

The repository is empty apart from the architecture exploration note. There is no existing code, build system, or dependency to accommodate, so every decision here sets a precedent rather than fitting into one.

The note's central claim is that a browser CAD system should keep exact B-Rep inside a WASM-resident kernel and let JavaScript hold only handles, document semantics, and render buffers. MVP-0 is the first test of that claim. Its deliverable is twofold: a working create-operate-render loop, and measurements of what that loop costs at the boundary.

Two constraints shape the design more than anything else. First, exact geometry must never be materialized in the JS heap, which rules out API shapes that feel natural in JavaScript and pushes all real work behind a narrow call surface. Second, MVP-0's API decisions are inherited by every later stage — the same surface will later carry `.brep` checkpointing, STEP translation, and XCAF product structure — so the boundary must be shaped for those futures even though none of them are built here.

The note explicitly leaves open whether the kernel should run in a Worker, possibly with shared memory. That question cannot be answered without the measurements MVP-0 produces, so this design must not presuppose either answer.

## Goals / Non-Goals

**Goals:**

- Prove the OCCT-to-WASM-to-rendering path works end to end in a browser: create a Box and a Cylinder, subtract one from the other, see the result shaded on screen.
- Establish a handle-based kernel API that keeps `TopoDS_Shape` inside WASM and is shaped to survive later stages without redesign.
- Produce the measurements the note asks for: operation wall-clock time, WASM memory and its peak, tessellation triangle counts, and WASM payload size.
- Keep the kernel's execution location — main thread or Worker — a deployment detail rather than an API contract.
- Make the OCCT build reproducible and cacheable, so a second developer or a CI run does not rediscover the toolchain from scratch.

**Non-Goals:**

- Any file format, in either direction: no STEP, no `.brep` persistence, no GLB or STL export. MVP-0 state is intentionally lost on reload.
- Feature graph, parametric history, recompute, or persistent naming. Bodies here are immutable results, not replayable features.
- Face-level or edge-level selection. These depend on stable topology identity, which is MVP-4's problem, and offering them now would create references the system cannot yet keep stable.
- Assemblies, product structure, names, colors, units handling beyond a single documented working unit.
- A broad modeling command set, sketches, extrude, or fillet.
- Production concerns: authentication, multi-document management, undo/redo, visual polish.

## Decisions

### Build a narrow C++ facade over OCCT rather than exposing OCCT to JavaScript

A prebuilt general-purpose binding such as `opencascade.js` would get a demo running faster, but it exposes most of OCCT's class surface directly to JavaScript. That invites exactly the pattern the note warns against: walking topology, constructing shape objects, and copying geometry across the boundary because the API makes it easy. The boundary would erode by default rather than by mistake.

Instead, the kernel is a hand-written C++ facade exposing only the operations MVP-0 needs — create box, create cylinder, three Booleans, tessellate, release, plus statistics — compiled to WASM with Emscripten and bound via embind. OCCT is linked narrowly (roughly `TKernel`, `TKMath`, `TKG2d`, `TKG3d`, `TKGeomBase`, `TKGeomAlgo`, `TKBRep`, `TKTopAlgo`, `TKPrim`, `TKBO`, `TKMesh`) rather than wholesale.

The cost is real: a native toolchain, a slower first milestone, and a facade that must be extended for every new capability. That extension cost is accepted deliberately — it is what keeps the boundary narrow, and each later stage's additions to the facade are a reviewable event rather than an ambient possibility.

If the OCCT build proves an unexpected schedule risk, a prebuilt binding is an acceptable *temporary* spike vehicle to validate geometry behavior, but it must not become the shipped boundary.

### Handles are opaque integer IDs into a kernel-side registry, not pointers

The facade owns a registry mapping a monotonically increasing `uint32` to a `TopoDS_Shape`. JavaScript receives only that integer, branded as `BodyId` in TypeScript.

Exposing raw WASM pointers was rejected on three grounds: a stale pointer is indistinguishable from a valid one, so use-after-release becomes memory corruption instead of a typed error; pointer values can be recycled by the allocator, which makes the spec's "never reissue an identifier" guarantee unenforceable; and a pointer invites JavaScript to reach into WASM memory directly.

A monotonic counter makes use-after-release detectable and cheap to report, and gives the live-handle count that leak detection depends on.

### Bodies are immutable; every operation returns a new handle

No operation mutates a body in place. A Boolean produces a new body and leaves both operands valid and owned by the caller.

This costs memory — intermediate results accumulate until explicitly released — but it buys three things that matter more. Tessellation caching becomes sound, because a handle's geometry never changes and a cache entry can never go stale. It matches the feature-graph model of later stages, where each feature's output is a distinct checkpoint. And it makes operand lifetime explicit rather than leaving callers guessing whether an operation consumed its inputs.

The consequence is that callers must release handles. Since WASM linear memory is invisible to the JavaScript garbage collector, there is no way to make this automatic without `FinalizationRegistry`, whose timing guarantees are too weak for geometry of this size. The live-handle count is exposed specifically so tests can assert a workflow leaks nothing.

### The kernel API is asynchronous from the first line, even while running on the main thread

Every kernel operation returns a `Promise`, and no API accepts or returns a value that cannot cross a `postMessage` boundary — handles are integers, parameters are plain objects, mesh output is transferable buffers.

MVP-0 runs the kernel on the main thread, because that is simpler to build and debug and because blocking is acceptable at this scale. But the note leaves the Worker question open, and the measurements MVP-0 produces are what will answer it. If the API were synchronous, answering "yes, move to a Worker" would mean rewriting every call site. Making it async now means that migration changes only the transport.

The honest cost is API friction with no immediate benefit: `await` on operations that resolve instantly. That is accepted as insurance against a rewrite the note tells us to expect.

### Mesh data is uploaded to the GPU immediately and never retained in the JS heap

Tessellation writes into WASM memory. JavaScript creates typed-array views over that region and uploads them straight into GPU buffers.

This carries a specific hazard worth stating plainly: when WASM linear memory grows, its backing `ArrayBuffer` is detached and every existing view becomes unusable. Any view held across an operation that might allocate is a latent crash. The rule is therefore that views are created and consumed within the same synchronous block, are never stored, and are re-derived from the current memory buffer on each use. When the kernel later moves to a Worker, that same data must be copied into a transferable buffer instead — which is a real cost that the Worker decision has to account for.

### Rendering uses three.js over both WebGPU and WebGL2

The viewport is not where the architectural risk lives, and writing camera control, lighting, and raycast picking by hand would spend effort on the least uncertain part of the system. three.js provides both a WebGPU and a WebGL2 renderer behind one scene API, which satisfies the requirement to prefer WebGPU and fall back cleanly.

The trade-off is a dependency with its own opinions about scene structure, and a WebGPU renderer that is less mature than its WebGL counterpart. Both are acceptable because the viewport is replaceable: bodies reach it as plain mesh buffers, so swapping the renderer touches only the render layer.

Body-level picking uses three.js raycasting against the tessellated mesh, with each rendered object tagged with its `BodyId`. Note that picking therefore resolves against the *mesh*, not the exact geometry — adequate for choosing whole bodies, and another reason face-level selection is deferred rather than approximated.

### OCCT failures are caught in C++ and returned as status values

Emscripten is configured with native WASM exceptions, and every facade entry point wraps its OCCT call to catch `Standard_Failure` and any other exception, returning a status code plus message rather than letting it escape into the WASM trap handler. An uncaught C++ exception at the boundary can leave the module unusable, which would violate the requirement that the kernel remain usable after a failed operation.

The TypeScript layer converts those status values into typed errors (`KernelNotReady`, `InvalidHandle`, `InvalidParameter`, `KernelOperationFailed`). Boolean operations that legitimately produce nothing return an explicit empty-result status rather than an error, because the specs require callers to distinguish "no geometry" from "operation failed" — conflating them would later make a valid direct-modeling result look like a bug.

### Pin the toolchain and treat the WASM artifact as a cached build product

The OCCT version and Emscripten version are pinned explicitly, and the compiled artifact is cached and keyed on those versions plus the facade sources. An OCCT build from scratch is slow enough that an uncached CI step would discourage running it.

This also anticipates a question from the note: how to keep native documents from being tied to a specific OCCT build. MVP-0 has no documents to tie, but recording `kernelVersion` in the measurement output starts the habit that MVP-1's `manifest.json` will depend on.

## Risks / Trade-offs

- **WASM payload size may be prohibitive.** A narrowly linked OCCT build is still likely to be in the multi-megabyte range, which affects first load materially → Measure and report the compressed and uncompressed sizes as an MVP-0 deliverable rather than an afterthought. Serve with Brotli and streaming instantiation. If the number is unacceptable, that finding is itself valuable output, and it should be recorded before adding capabilities that only make the binary larger.

- **WASM memory growth detaches typed-array views, causing sporadic crashes.** This class of bug appears only under specific allocation timing, so it survives casual testing → Enforce the never-store-a-view rule in the render path, and include a test that tessellates a body after forcing memory growth.

- **The main-thread kernel will freeze the UI on heavy operations.** With MVP-0's trivial geometry this may never be observed, which risks a false sense that the Worker question is moot → Report per-operation wall-clock time in the UI so blocking is visible, and treat any operation exceeding a frame budget as evidence the Worker migration is needed.

- **OCCT Boolean operations are fragile on tangent, coincident, or near-degenerate configurations.** A demo built only from clean box-minus-cylinder cases would overstate robustness → Include at least one deliberately awkward case (coincident faces, tangent cylinder) in the test set, and record failures as findings rather than fixing them by tuning inputs until they pass.

- **The narrow facade becomes a bottleneck as capabilities grow.** Every new operation needs C++, a binding, and a TypeScript wrapper → Accepted cost, and partly the point: it makes boundary growth deliberate. Keep the facade organized so later stages extend it by adding files rather than editing a single monolith.

- **The Emscripten toolchain is the most likely source of setup friction**, and toolchain trouble can consume the time budget meant for architecture → Pin versions, script the build end to end, and get a trivial WASM module loading in the browser before wiring any OCCT geometry, so toolchain problems surface separately from geometry problems.

- **No persistence means every test session starts from nothing**, which will make manual verification tedious and may create pressure to add ad-hoc saving → Resist it. Provide a scripted scene-setup path for testing instead; persistence is MVP-1's deliverable and doing it informally here would prejudge its design.

- **three.js WebGPU renderer immaturity** may produce backend-specific rendering differences → Keep WebGL2 as the reference backend for correctness, report which backend is active alongside measurements, and treat WebGPU as the preferred-but-verified path.

## Migration Plan

Not applicable in the usual sense: this is the first change in an empty repository, so there is no existing state, data, or API to migrate and no rollback target. Deployment is a static bundle plus the WASM artifact.

The one forward-looking obligation is that the measurement output records the OCCT and Emscripten versions used, so when MVP-1 introduces a versioned document container it can tie checkpoints to the kernel build that produced them.

## Open Questions

Carried forward from the architecture note, to be informed by MVP-0's measurements rather than settled here:

- Should the kernel run entirely inside a Worker, and if so, does shared memory pay for its complexity? MVP-0's per-operation timings are the input to this decision.
- What are the real peak-memory and throughput characteristics as model complexity grows? MVP-0 establishes a floor with trivial geometry; the interesting numbers come with real models in MVP-2.

New to this change:

- Is a single hand-written facade the right long-term shape, or should the binding layer eventually be generated from a declarative operation description as the operation count grows?
- What working unit and tolerance defaults should the system adopt? MVP-0 needs one documented choice; the general answer belongs with STEP unit handling in MVP-2.
- Should tessellation deflection be chosen adaptively from a body's bounding box rather than passed as an absolute length? An absolute tolerance behaves badly across very different model scales, but adaptive selection needs a scale policy that MVP-0 has no basis to design.
- How should the measurement output be recorded so results are comparable across sessions and machines — in-memory readout only, or an exportable log? This matters for the note's proposed end-to-end benchmark experiment, but that experiment belongs to MVP-2.
