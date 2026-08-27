# Web CAD

A browser-native solid modeler with **exact B-Rep geometry**. Open CASCADE
Technology is compiled to WebAssembly and runs in a Worker; the main thread holds
only opaque handles to bodies that live in WASM memory. Triangles exist for
rendering and nothing else — the mesh is never the source of truth.

That constraint is the whole point. A drilled hole here is an analytic cylinder,
not a fine faceting of one, which is what makes the result exportable to STEP
later rather than merely good-looking.

![Two solids created, selected as Boolean target and tool, subtracted into a
drilled block, with a live readout of operation timings and WASM
memory](docs/demo.gif)

A capture of the running app, not a mockup. The operation log reports each
operation's kernel time, what the Worker round trip added, and — for anything
past a frame — how much **latency** the user saw. Latency, not dropped frames:
the viewport keeps drawing throughout. [Higher-quality MP4](docs/demo.mp4).

## Status: MVP-1 complete — Worker kernel, and models that survive a restart

MVP-0 measured the OCCT/WASM-to-rendering boundary that every later stage depends
on, and found the main thread already blocked on trivial geometry. MVP-1 acted on
that and then built the document layer on top of the measured boundary. Both
halves are done: the kernel runs in a dedicated Worker, where a 160 ms Boolean
stalls the main thread for 6.5 ms against a 5.5 ms idle baseline — and a model now
survives closing the browser.

You can create boxes and cylinders, union / subtract / intersect them, orbit the
result, and **save it**. Saving writes a native document — a versioned container
holding an exact binary B-Rep checkpoint, a construction record, and a manifest
with provenance and integrity — into browser storage. Reopening restores exact
geometry, not a mesh: a reloaded page comes back with the same bodies under the
same document identities, re-tessellated from the exact surfaces. The document you
had open reopens by itself on load.

There is no feature history you can edit and no file import. The construction
record is written and displayed but never replayed; STEP arrives in MVP-2.

- [`docs/MVP-1-FINDINGS.md`](docs/MVP-1-FINDINGS.md) — what persistence costs.
  Exact B-Rep serializes at 70–112 kB/ms and restores at 46–73 kB/ms; a checkpoint
  is ~860 bytes per face; IndexedDB beat OPFS on every operation by 1.2–54× and is
  the default on that evidence; and recovery after a restart is 565 ms, 87% of
  which is WASM startup — with re-tessellation, not the checkpoint, dominating
  everything the document layer does.
- [`docs/MVP-1-WORKER-FINDINGS.md`](docs/MVP-1-WORKER-FINDINGS.md) — what the
  Worker move cost and bought. Transport is 0.1–0.5 ms per operation, the mesh
  copy it forces is 0.12 ms for 181 kB, and transferables beat structured cloning
  above a few kilobytes while losing below it. Two of MVP-0's numbers turn out to
  need correcting.
- [`docs/MVP-0-FINDINGS.md`](docs/MVP-0-FINDINGS.md) — the boundary measurements
  the design rests on: exactness survives the whole pipeline and the WASM payload
  is 1.9 MB compressed.

## Running it

**The kernel is not in the repository.** `webcad_kernel.wasm` is a build product
and is gitignored, so a fresh clone has to build it before the app will start.
That build is the only non-trivial setup step, and it needs Python 3, CMake
3.20+, and roughly 2.5 GB of disk.

```bash
npm install

bash scripts/install-emsdk.sh   # Emscripten 6.0.7, ~2 GB, once
bash scripts/fetch-occt.sh      # OCCT V8_0_1, ~313 MB, once
npm run kernel:build            # tens of minutes cold, seconds warm
```

Then:

```bash
npm run dev
```

If you skip the kernel build, the app loads and tells you so rather than
failing silently.

[`docs/BUILD.md`](docs/BUILD.md) covers the pinned versions, the two build
stages, the caching, and the environment problems worth knowing about before you
hit them.

### Using it

Click **Box** or **Cylinder** to create bodies, or **Demo scene** for a drilled
block in one step.

Booleans need two bodies selected, and the order decides what the operation
means: **click the target first, then shift-click the tool.** The panel spells
out which is which, because subtracting in the wrong order gives a perfectly
correct result that looks wrong.

Navigation is standard orbit controls — drag to orbit, right-drag to pan, wheel
to zoom toward the cursor. **Fit** frames everything.

Bodies are not garbage collected. WASM memory is invisible to the JavaScript
collector, so **Release selected** is how memory comes back.

**Save** writes the current document to browser storage and lists it, with the
size it actually occupies. **Open** replaces what is on screen; a document that
cannot be read is refused with a reason and leaves your current model untouched.
The document you had open last reopens automatically the next time the app loads,
so closing the browser is not how you lose work. If storage is unavailable, the
app says so and stays usable with saving disabled — persistence is a feature, not
a precondition.

The panel also shows the construction record: how each body came to exist, by
document identity. It is a record, not a recipe — nothing replays it, and
restoration comes from the exact checkpoint alone.

## Verifying

```bash
npm run typecheck
npm test                      # 114 tests; kernel tests skip if unbuilt
npm run verify:browser        # drives the real app in Chrome (WebGPU)
npm run verify:browser:webgl  # same, forcing the WebGL2 fallback
npm run verify:storage        # storage conformance against real IndexedDB and OPFS
npm run verify:dist           # drives the production build, served statically
npm run kernel:size           # payload measurements

npm run verify                # typecheck + tests + browser + dist
```

`npm run demo:record` drives the same path and re-records both `docs/demo.mp4`
and the embedded `docs/demo.gif` in place, so the demo stays honest about what
the app currently does.

Browser verification drives your installed system Chrome through
`playwright-core`, downloading no browser binaries. It covers what node tests
cannot reach — the render path, backend selection, GPU upload, and picking — and
writes screenshots and JSON to `measurements/`.

It also measures the Worker boundary and fails if the main thread stalls for
more than three frames while the kernel works, so "the kernel is off the main
thread" is a checked claim rather than a described one. Those numbers land in
`measurements/worker.json`.

The same run measures persistence — serialize and restore against five payload
sizes, save and open latency on both storage backends, and recovery in phases
across a genuine page reload — into `measurements/document.json`. It holds
persistence to the same three-frame bound as the kernel, and it asserts that each
body comes back under **the same document identity**, not merely that a body of
the same size came back.

`npm run verify:storage` runs one conformance suite against real IndexedDB and
real OPFS, because a fake would only reproduce what this codebase believes about
transactions, quota, and file handles. It reports what it could not exercise
rather than passing quietly.

`npm run verify:dist` exists because everything above runs against the dev
server, which resolves assets from their source paths while a build rewrites
them to hashed names under `assets/`. That difference once shipped a `dist/`
that could not load the kernel at all. It builds, serves the output as a static
host would, asserts the kernel reaches ready and the `.wasm` was really fetched,
and then saves a document, reloads the browser, and checks the model comes back —
in the build, where the dev-only verification handle does not exist.

## Layout

| Path | |
| --- | --- |
| `native/src/` | the C++ facade over OCCT — the only code that touches B-Rep |
| `src/kernel/` | TypeScript kernel API: handles, typed errors, instrumentation |
| `src/kernel/worker/` | the Worker the kernel runs in, and the protocol reaching it |
| `src/viewport/` | three.js scene, WebGPU/WebGL2 selection, picking |
| `src/document/` | the document container: parts, manifest, identity, integrity |
| `src/storage/` | where documents live — IndexedDB and OPFS behind one interface |
| `src/app/` | modeling session tying the kernel, the viewport, and the document |
| `tests/browser/` | suites that need a real browser: storage conformance, measurements |
| `openspec/specs/` | what the system is specified to do, by capability |
| `docs/` | build guide and stage findings |

Requirements live in `openspec/specs/` as six capabilities — `geometry-kernel`,
`kernel-worker`, `solid-primitives`, `boolean-operations`, `tessellation`, and
`viewport`. Each opens with the constraint it exists to hold, which is usually
more useful than the requirements underneath it. Three more —
`brep-serialization`, `native-document`, and `document-storage` — live in
`openspec/changes/native-document-checkpoint/specs/` until that change is
archived.

## Roadmap

Each stage exists to validate one bottleneck rather than to add features.

| | | |
| --- | --- | --- |
| **MVP-0** | Primitives, Booleans, viewport | ✅ OCCT/WASM-to-render boundary |
| **MVP-1a** | Kernel in a Worker | ✅ cost of the thread boundary |
| **MVP-1b** | Native document + `.brep` checkpoint | ✅ restart recovery cost |
| MVP-2 | STEP import, edit, export | round-trip fidelity |
| MVP-3 | Assembly, naming, colour via XCAF | STEP document semantics |
| MVP-4 | Persistent references, incremental recompute | edit stability |

The known hard problem is MVP-4's: stable references to faces and edges across
topology changes. Positional names like `Face_17` are unacceptable, which is why
selection here stops at whole bodies — face-level picking would mint exactly
those references before the system can keep them stable.
