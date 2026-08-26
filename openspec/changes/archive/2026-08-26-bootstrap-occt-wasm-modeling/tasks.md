## 1. Toolchain and project skeleton

- [x] 1.1 Create the TypeScript web application skeleton (package manager, bundler, dev server, strict `tsconfig`) and confirm a blank page serves locally
- [x] 1.2 Pin the Emscripten SDK version and document the exact install/activate steps in a build README
- [x] 1.3 Pin the OCCT source version and script fetching it reproducibly
- [x] 1.4 Compile a trivial "hello" C++ module to WASM with embind and load it from the app, proving the toolchain works before any OCCT code is involved
- [x] 1.5 Set up a test runner and confirm it can execute a test that loads the trivial WASM module

## 2. OCCT WASM build

- [x] 2.1 Write the CMake/Emscripten build for OCCT linking only the required modules (`TKernel`, `TKMath`, `TKG2d`, `TKG3d`, `TKGeomBase`, `TKGeomAlgo`, `TKBRep`, `TKTopAlgo`, `TKPrim`, `TKBO`, `TKMesh`)
- [x] 2.2 Enable native WASM exceptions and allowed memory growth in the build configuration
- [x] 2.3 Produce a first OCCT-linked artifact that constructs a `TopoDS_Shape` in C++ and returns only its volume to JavaScript, proving OCCT geometry runs in the browser
- [x] 2.4 Record the compressed and uncompressed WASM artifact sizes, and configure Brotli plus streaming instantiation for serving
- [x] 2.5 Make the kernel build cacheable, keyed on the OCCT version, Emscripten version, and facade sources, and wire it into CI

## 3. Kernel facade: lifecycle and handles

- [x] 3.1 Implement the C++ shape registry mapping monotonically increasing `uint32` handles to `TopoDS_Shape`, with no identifier reuse after release
- [x] 3.2 Implement `release` to destroy a shape and free its kernel memory, and report `InvalidHandle` for unknown or already-released handles
- [x] 3.3 Implement the status-and-message return convention in C++, wrapping every entry point to catch `Standard_Failure` and any other exception so no exception escapes the boundary
- [x] 3.4 Implement the TypeScript initialization entry point: instantiate once for repeated calls, report the OCCT version, reject with an explicit error where WebAssembly is unavailable, and fail operations with `KernelNotReady` before readiness
- [x] 3.5 Define the branded `BodyId` type and the typed error hierarchy (`KernelNotReady`, `InvalidHandle`, `InvalidParameter`, `KernelOperationFailed`), mapping C++ status values onto them
- [x] 3.6 Make every kernel operation return a `Promise` and accept only `postMessage`-compatible arguments, so the Worker question stays open
- [x] 3.7 Expose the live-handle count and current/peak WASM memory statistics
- [x] 3.8 Implement the per-operation performance log recording operation type and wall-clock duration for both successful and failed operations
- [x] 3.9 Write tests for handle uniqueness, use-after-release, double-release, and a workflow that asserts zero live handles at completion

## 4. Solid primitives

- [x] 4.1 Implement box creation from width/depth/height plus placement, validating the result is a closed solid before issuing a handle
- [x] 4.2 Implement cylinder creation from radius/height/placement with the same validity check
- [x] 4.3 Reject non-positive dimensions with `InvalidParameter` naming the offending parameter, creating no handle
- [x] 4.4 Expose the minimal topology-count and scalar-measurement queries the specs require (face/edge/vertex counts, volume, bounding box, face surface type) without serializing any topology into JavaScript
- [x] 4.5 Write tests asserting box face/edge/vertex counts and volume, cylinder volume, that the cylinder's lateral face reports an exact cylindrical surface, and that placement changes the bounding box but not the dimensions

## 5. Boolean operations

- [x] 5.1 Implement union, subtract, and intersect over two body handles, returning a new handle and leaving both operands valid
- [x] 5.2 Validate operands: reject invalid handles with `InvalidHandle` and reject identical target and tool with `InvalidParameter`, mutating no state
- [x] 5.3 Return an explicit empty-result status — distinct from an error — when an operation legitimately yields no geometry
- [x] 5.4 Handle the disjoint-union case as a successful multi-solid result rather than a rejection
- [x] 5.5 Surface underlying OCCT Boolean failures as `KernelOperationFailed` while keeping operand handles valid and the kernel usable
- [x] 5.6 Write tests for box-minus-cylinder volume arithmetic, preserved analytic surfaces in the result, chained Booleans, disjoint operands for all three operations, and a tool fully enclosing the target
- [x] 5.7 Add at least one deliberately awkward case (coincident faces and a tangent cylinder) and record the outcome as a finding rather than adjusting inputs until it passes

## 6. Tessellation

- [x] 6.1 Implement tessellation of a body into vertex position, normal, and triangle index buffers in WASM memory
- [x] 6.2 Accept a linear deflection tolerance and optional angular tolerance, apply a documented default when omitted, report the tolerance actually used, and reject non-positive tolerances with `InvalidParameter`
- [x] 6.3 Report triangle and vertex counts with each tessellation result
- [x] 6.4 Implement the tessellation cache keyed on handle plus tolerance, and evict a body's entry when its handle is released
- [x] 6.5 Confirm no API accepts mesh buffers as geometric input, keeping mesh strictly derived output
- [x] 6.6 Write tests for index-range validity, finer deflection yielding more triangles and smaller deviation from the exact surface, cache hits observable in the operation timings, a different tolerance bypassing the cache, and tessellating a released handle failing with `InvalidHandle`

## 7. Viewport

- [x] 7.1 Set up the three.js scene with backend selection preferring WebGPU, falling back to WebGL2, reporting the active backend, and showing an explicit unsupported-environment message when neither initializes
- [x] 7.2 Implement the mesh upload path: derive typed-array views over WASM memory and upload to GPU buffers within one synchronous block, retaining no long-lived JavaScript copy
- [x] 7.3 Enforce and document the never-store-a-view rule, and add a test that tessellates and renders a body after forcing WASM memory growth
- [x] 7.4 Destroy a body's GPU buffers when it leaves the scene or its handle is released
- [x] 7.5 Implement orbit, pan, and cursor-directed zoom navigation
- [x] 7.6 Implement fit-to-view, including the documented default camera position for an empty scene
- [x] 7.7 Implement body-level picking by raycasting against tessellated meshes tagged with their `BodyId`, with ordered two-body multi-select and click-empty-space to clear
- [x] 7.8 Build the measurement readout showing per-operation duration, current and peak WASM memory, live handle count, total rendered triangles, active render backend, and kernel version

## 8. End-to-end validation and findings

- [x] 8.1 Add minimal UI controls to create a box and a cylinder, and to apply each Boolean to the current selection
- [x] 8.2 Provide a scripted scene-setup path for testing so repeated manual verification does not create pressure to add informal persistence
- [x] 8.3 Write the end-to-end test: create box, create cylinder, subtract, tessellate, render, verify the result is visible and the operand handles are still valid
- [x] 8.4 Verify an operation exceeding a frame budget is visible in the readout, so main-thread blocking is observable rather than assumed absent
- [x] 8.5 Record the MVP-0 findings — WASM payload size, per-operation timings, peak memory, triangle counts, Boolean robustness results, and pinned OCCT/Emscripten versions — as the stage's deliverable
- [x] 8.6 Write up the recommendation on the Worker question and any other open questions the measurements now inform, as input to MVP-1
