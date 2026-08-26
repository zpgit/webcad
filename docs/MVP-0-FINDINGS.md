# MVP-0 findings

MVP-0's purpose was not to deliver a usable modeler. It was to validate and
measure the OCCT/WASM-to-rendering boundary that every later stage is built on,
and to produce numbers rather than opinions. This is that output.

**Verdict: the bet holds.** An exact B-Rep kernel runs in the browser with
geometry resident in WASM, JavaScript holding only handles, and exact results
rendering correctly. Nothing found here argues for changing the architecture. One
finding does argue for acting on an open question sooner rather than later.

## Build under test

| | |
| --- | --- |
| OCCT | V8_0_1 (reports `8.0.1`) |
| Emscripten | 6.0.7 |
| Renderer | three.js 0.185.1, WebGPU and WebGL2 both verified |
| Host | Windows 11, 18 cores, Chrome (system install) |

## Payload size

The concern was that an OCCT WASM binary might be prohibitively large.

| Artifact | Raw | Brotli |
| --- | --- | --- |
| `webcad_kernel.wasm` | 6.77 MB | 1.92 MB |
| `webcad_kernel.mjs` | 0.08 MB | 0.02 MB |
| **Total** | **6.85 MB** | **1.94 MB** |

**Finding: acceptable, with room that will get used.** Under 2 MB compressed is
comparable to a heavy JS application bundle and entirely viable for a
professional tool. This is also close to a floor, not a typical figure: only
three OCCT modules are linked. MVP-2 adds `DataExchange` for STEP, which is
substantial. The measurement is recorded per build in `measurements/payload.json`
so that growth is tracked rather than discovered late.

## Operation timings

Measured on trivial geometry — a 60×40×25 block and a radius-12 cylinder.

| Operation | Duration |
| --- | --- |
| `createBox` | 25.8 ms |
| `createCylinder` | 3.3–4.4 ms |
| `subtract` (block, drill) | 66–73 ms |
| `tessellate` (result, default tolerance) | 2.9–4.6 ms |
| `tessellate` (r=80 cylinder, 0.002 deflection) | 168–187 ms |
| `release` | 0.1–0.2 ms |

**Finding: the main thread is already blocked, on trivial models.** A frame at
60 Hz is 16.7 ms. A Boolean on two primitives takes four frames; a fine
tessellation takes eleven. Three of the ten operations in a basic
create-create-subtract session exceed the frame budget, and the readout flags
them.

This is the most consequential result of MVP-0, and it is worth being precise
about why. The architecture note left open whether the kernel should run inside a
Worker. Before measuring, a reasonable guess was that MVP-0's geometry would be
too small to tell. It is not: the numbers are already over budget with two
primitives, and real models are orders of magnitude heavier.

**Recommendation: move the kernel into a Worker in MVP-1**, before the native
document format is designed. Deferring it further means the document layer gets
built against a main-thread kernel and then has to be revisited.

The migration cost was deliberately pre-paid. Every kernel operation is already
`async` and every argument and return value is already postMessage-compatible, so
this changes the transport, not the call sites. The one real cost the measurement
exposes: mesh data currently crosses as typed-array views over WASM memory with
no copy, and a Worker boundary forces a copy into a transferable buffer. That
copy needs measuring as part of the migration rather than assumed free.

Shared memory is a separate question and should stay open — it should not be
adopted until a Worker with plain message passing is measured and found wanting.

## Memory

| | |
| --- | --- |
| Initial WASM heap | 16 MB |
| After the demo scene (2 bodies, 152 triangles) | 16 MB, peak 16 MB |
| Mesh cache after the drilled block | < 0.05 MB |
| Growth observed | only under deliberate stress (dozens of finely tessellated large cylinders) |

**Finding: MVP-0 geometry does not stress memory at all**, which means these
numbers say little about the note's real question — peak memory for complex
models. That question needs a real STEP file and belongs to MVP-2.

One decision came out of measuring this. The initial heap was originally 64 MB,
which turned out to mean memory growth never happened in ordinary use. It was
reduced to 16 MB, for two reasons: a smaller first-load footprint, and — more
importantly — growth becomes a path exercised routinely rather than one that only
triggers on huge models. Since growth detaches the backing `ArrayBuffer` and
invalidates every typed-array view, having that path be routine is what keeps the
never-store-a-view rule honest instead of theoretical.

## Geometric correctness

Verified by exact arithmetic, not eyeballing:

- Box: 6 faces, 12 edges, 8 vertices; volume exactly `w·d·h`.
- Cylinder: 3 faces; volume exactly `πr²h`; the lateral face reports as an
  analytic `GeomAbs_Cylinder`, confirming exact geometry rather than a faceted
  approximation.
- Drilled block: volume `60·40·25 − π·12²·25 = 48690.3`, matched to 1e-3 in the
  browser, 7 faces, 1 solid, valid. The hole wall is still an analytic cylinder —
  **the Boolean preserved exact geometry**.
- Union of overlapping boxes: shared volume counted once.
- Tessellation fidelity: measured as the worst chord sagitta against the exact
  cylinder. A 0.05 deflection request yields deviation within 0.05.

**Finding: exactness survives the whole pipeline**, which is the core claim the
architecture rests on.

An early bug worth recording, because it would have been easy to ship: sub-shape
counts were computed with `TopExp_Explorer`, which visits a shared entity once per
parent and so reported a box as having 24 edges and 48 vertices. Counting
distinct sub-shapes via an indexed map fixed it. Anything that reasons about
topology counts must deduplicate.

## Boolean robustness on awkward geometry

Deliberately hostile cases, recorded as outcomes rather than tuned until they
passed:

| Case | Outcome |
| --- | --- |
| Coincident-face union (two boxes sharing a face exactly) | valid solid, volume 2000.0 |
| Coincident-face intersect | empty result (correct — they share only a face) |
| Tangent-cylinder union | valid solid, volume 10356.2 |
| Tangent-cylinder subtract | valid solid, volume 8000.0 (unchanged, correct) |
| Tool fully enclosing target | empty result, no handle issued |
| Intersect of disjoint solids | empty result |
| Union of disjoint solids | success, reported as 2 solids |

**Finding: OCCT 8.0.1 handled every awkward case tested without failing**, and
the kernel remained usable throughout. This is better than expected — the design
anticipated fragility here. It is not a clean bill of health: these are simple
analytic primitives, and the note's warning about Boolean robustness concerns
real imported geometry, which MVP-2 will supply.

The distinction between *empty result* and *failure* proved its worth
immediately. Three of the seven cases legitimately produce no geometry; modelling
those as errors would have made correct direct-modeling outcomes look like bugs.

## Rendering

- **WebGPU** is selected when available and works.
- **WebGL2** fallback verified by removing `navigator.gpu`, producing identical
  geometry and rendering.
- GPU upload happens inside the tessellation callback, with no long-lived JS copy
  of mesh data.
- Body-level picking resolves a pixel to a `BodyId` through the same raycast the
  click handler uses; ordered two-body multi-select and click-to-clear verified.

**Finding: the viewport was not where the risk was**, as expected. Using three.js
rather than hand-rolling was the right call — no time was spent on camera,
lighting, or picking mechanics.

Two things worth flagging:

1. Picking raycasts the *mesh*, not the exact geometry. Fine for whole bodies.
   It is another reason face-level selection was deferred: it would mint exactly
   the positional references section 7 of the note rules out, before the system
   can keep them stable.
2. **Boolean operand order is not discoverable in the UI.** The first pick is the
   target and the second is the tool — colour-coded, but nothing says which is
   which. This surfaced when automated verification picked the cylinder first and
   got cylinder-minus-block: a perfectly correct result that looked wrong. Worth
   a label before anyone else is confused by it.

## What MVP-0 does not tell us

Stated plainly, because the temptation is to over-read a green result:

- Nothing about complex models. Every number here comes from two primitives.
  Serialization throughput, peak memory, and translation limits for 10/100/500 MB
  models remain open and need MVP-2.
- Nothing about persistent naming or recompute stability. MVP-0 has no feature
  graph and immutable bodies, so the hard problem of section 7 was avoided rather
  than addressed.
- Nothing about IndexedDB versus OPFS. No persistence exists yet.
- Nothing about document migration across OCCT builds. There are no documents.

## Recommendations for MVP-1

1. **Move the kernel into a Worker first**, before designing the document
   container. The timings justify it and the async API already accommodates it.
   Measure the mesh-copy cost the boundary introduces.
2. Record `kernelVersion` in the document manifest from the outset. The
   measurement output already stamps OCCT and Emscripten versions; the note's
   question about untying documents from a specific OCCT build starts here.
3. Keep the empty-result-versus-failure distinction as document operations are
   added. It has already paid off.
4. Add a small label for Boolean target versus tool.
5. Expect the payload to grow when `DataExchange` is linked in MVP-2, and keep
   `measurements/payload.json` under review rather than measuring once.

## Reproducing

```bash
npm run kernel:build          # ~tens of minutes cold, seconds warm
npm test                      # 49 tests
npm run verify:browser        # WebGPU
npm run verify:browser:webgl   # WebGL2 fallback
npm run kernel:size           # payload table
```

Artifacts land in `measurements/`: `payload.json`, `browser.json`,
`browser-webgl2.json`, and viewport screenshots.
