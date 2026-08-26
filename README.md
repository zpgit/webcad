# Web CAD

A browser-native solid modeler with **exact B-Rep geometry**. Open CASCADE
Technology is compiled to WebAssembly and does the geometry; TypeScript holds
only opaque handles to bodies that live in WASM memory. Triangles exist for
rendering and nothing else — the mesh is never the source of truth.

That constraint is the whole point. A drilled hole here is an analytic cylinder,
not a fine faceting of one, which is what makes the result exportable to STEP
later rather than merely good-looking.

![Two solids created, selected as Boolean target and tool, subtracted into a
drilled block, with a live readout of operation timings and WASM
memory](docs/demo.gif)

A capture of the running app, not a mockup. Watch the operation log flag the
subtract as **over frame budget** — that is the finding MVP-1 acts on, visible
rather than asserted. [Higher-quality MP4](docs/demo.mp4).

## Status: MVP-0

MVP-0 was not built to be a usable modeler. It existed to measure the
OCCT/WASM-to-rendering boundary every later stage depends on, and to produce
numbers instead of opinions. It is complete.

You can create boxes and cylinders, union / subtract / intersect them, and orbit
the result — with a live readout of operation timings, WASM memory, and triangle
counts. There is no persistence, no feature history, and no file import.

The measurements and what they imply are in
[`docs/MVP-0-FINDINGS.md`](docs/MVP-0-FINDINGS.md). The short version: exactness
survives the whole pipeline, the WASM payload is 1.9 MB compressed, and the main
thread is already blocked on trivial geometry — a two-primitive Boolean takes
four frames — so the kernel moves into a Worker at the start of MVP-1.

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

## Verifying

```bash
npm run typecheck
npm test                      # 49 tests; kernel tests skip if unbuilt
npm run verify:browser        # drives the real app in Chrome (WebGPU)
npm run verify:browser:webgl  # same, forcing the WebGL2 fallback
npm run kernel:size           # payload measurements

npm run verify                # typecheck + tests + browser
```

`npm run demo:record` drives the same path and re-records both `docs/demo.mp4`
and the embedded `docs/demo.gif` in place, so the demo stays honest about what
the app currently does.

Browser verification drives your installed system Chrome through
`playwright-core`, downloading no browser binaries. It covers what node tests
cannot reach — the render path, backend selection, GPU upload, and picking — and
writes screenshots and JSON to `measurements/`.

## Layout

| Path | |
| --- | --- |
| `native/src/` | the C++ facade over OCCT — the only code that touches B-Rep |
| `src/kernel/` | TypeScript kernel API: handles, typed errors, instrumentation |
| `src/viewport/` | three.js scene, WebGPU/WebGL2 selection, picking |
| `src/app/` | modeling session tying the kernel to the viewport |
| `openspec/specs/` | what the system is specified to do, by capability |
| `docs/` | build guide and MVP-0 findings |

Requirements live in `openspec/specs/` as five capabilities —
`geometry-kernel`, `solid-primitives`, `boolean-operations`, `tessellation`, and
`viewport`. Each opens with the constraint it exists to hold, which is usually
more useful than the requirements underneath it.

## Roadmap

Each stage exists to validate one bottleneck rather than to add features.

| | | |
| --- | --- | --- |
| **MVP-0** | Primitives, Booleans, viewport | ✅ OCCT/WASM-to-render boundary |
| MVP-1 | Native document + `.brep` checkpoint | restart recovery cost |
| MVP-2 | STEP import, edit, export | round-trip fidelity |
| MVP-3 | Assembly, naming, colour via XCAF | STEP document semantics |
| MVP-4 | Persistent references, incremental recompute | edit stability |

The known hard problem is MVP-4's: stable references to faces and edges across
topology changes. Positional names like `Face_17` are unacceptable, which is why
selection here stops at whole bodies — face-level picking would mint exactly
those references before the system can keep them stable.
