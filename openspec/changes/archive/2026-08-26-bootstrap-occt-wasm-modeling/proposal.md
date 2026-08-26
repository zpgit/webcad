## Why

The architecture note commits to a bet that has not yet been tested: that an exact B-Rep kernel (OCCT) can run in the browser via WebAssembly, with geometry staying resident in WASM memory while JavaScript holds only handles. Every later stage — native documents, STEP round-trip, assemblies, persistent naming — is built on top of that boundary, so if its ergonomics or performance are wrong, they are wrong everywhere and expensive to correct later.

This change implements MVP-0, the smallest slice that exercises the boundary end to end: create exact solids, operate on them, and get pixels on screen. Its purpose is to validate and measure the OCCT/WASM-to-rendering boundary, not to deliver a usable modeler.

## What Changes

- Establish the project skeleton: a TypeScript/web application with an OCCT-to-WASM build pipeline producing a loadable kernel module.
- Introduce a **handle-based kernel API**. JS/TS receives opaque `BodyId` values; `TopoDS_Shape` and all topology/surface structures stay inside WASM. No B-Rep representation is ever copied into the JS heap.
- Support creating exact solid primitives: **Box** and **Cylinder**, parameterized and positioned.
- Support **Boolean** operations — union, subtract, intersect — consuming and producing canonical B-Rep bodies.
- Tessellate canonical B-Rep into vertex/index buffers with caller-controlled deflection. Meshes are render output only, never geometry truth.
- Render tessellated bodies in a **WebGL/WebGPU viewport** with orbit/pan/zoom and body-level selection sufficient to pick Boolean operands.
- Instrument the boundary: report operation wall-clock time, WASM peak memory, and triangle counts, so MVP-0 produces the measurements it exists to produce.

Non-goals for this change, each deferred to its own stage: STEP or any other import/export (MVP-2), native document persistence and `.brep` checkpoints (MVP-1), assemblies, names, colors, or XCAF (MVP-3), persistent naming, a feature graph, and parametric recompute (MVP-4). Sketches, extrude, and fillet are also out of scope; the note's broader capability loop is deliberately not attempted here.

Because no document persistence exists yet, **all modeling state is lost on page reload**. This is an accepted MVP-0 limitation, not a defect, and it is precisely what MVP-1 addresses.

## Capabilities

### New Capabilities

- `geometry-kernel`: OCCT/WASM module lifecycle (build, load, initialize), the handle-based API boundary, body handle allocation and explicit release, memory ownership rules, and error propagation from kernel failures into JS.
- `solid-primitives`: Creation of exact Box and Cylinder solids from parameters and a placement, validation of degenerate inputs, and registration of the results as canonical bodies.
- `boolean-operations`: Union, subtract, and intersect over canonical bodies, including operand validation, handling of null/disjoint results, and lifetime of operand bodies after the operation.
- `tessellation`: Conversion of canonical B-Rep into renderable vertex/index/normal buffers under a caller-supplied deflection tolerance, cache invalidation when a body changes, and the guarantee that mesh data never feeds back into geometry.
- `viewport`: WebGL/WebGPU rendering of tessellated bodies, camera navigation, body-level selection, and the transfer path for mesh buffers from WASM into GPU resources.

### Modified Capabilities

None. This is the first change in a greenfield repository; `openspec/specs/` is empty.

## Impact

- **New dependencies**: OCCT (built to WASM via Emscripten), a TypeScript toolchain and bundler, and a rendering path targeting WebGL2 with WebGPU where available. The OCCT build is the largest new piece of infrastructure and the most likely source of setup friction.
- **Build system**: introduces a non-trivial native-to-WASM build step, which affects CI time, artifact size, and developer onboarding. The kernel build should be cacheable and reproducible.
- **Delivery footprint**: an OCCT WASM binary is large. Payload size, streaming/instantiation strategy, and whether the kernel runs on the main thread or in a Worker all surface here. The note leaves the Worker question open; MVP-0 should be structured so that answer can change without an API rewrite.
- **Architectural precedent**: the handle-based API shape defined here becomes the contract that every later stage codes against, so its design carries weight beyond this change.
- **Not affected**: no existing code, APIs, or specs — the repository currently contains only the architecture note.
