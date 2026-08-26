# Building the geometry kernel

The kernel is a narrow C++ facade over OCCT, compiled to WebAssembly. Building it
is the only non-trivial setup step in this project; everything else is ordinary
TypeScript tooling.

## Pinned versions

All versions live in [`native/toolchain.env`](../native/toolchain.env) and nowhere
else. Every script and the CI workflow read them from there.

| Tool | Pinned |
| --- | --- |
| Emscripten SDK | 6.0.7 |
| Open CASCADE Technology | V8_0_1 |

The names in that file carry a `WEBCAD_` prefix on purpose: `emsdk_env.sh` unsets
its own `EMSDK_VERSION` when it activates a toolchain, which silently emptied the
value before the prefix was added.

`V8_0_1` was chosen to pair a current OCCT with a current Emscripten rather than
mixing a new compiler with an older kernel. `WEBCAD_OCCT_FALLBACK_VERSION`
records `V7_9_3` as the documented fallback if the 8.x line ever proves
troublesome — the 7.x line has more community WASM build precedent.

## Prerequisites

- Node.js 20, 22, or 24+ (see the note on Node 23 below)
- Python 3 (the Emscripten SDK installer is a Python script)
- Git
- CMake 3.20+
- Roughly **2.5 GB** of disk for the toolchain and sources, plus ~120 MB for the
  OCCT install tree

`ninja` is vendored into `tools/bin` by the build rather than required from the
system: the GNU Make 3.81 that ships with Git for Windows is too old to be
trusted with a build this size.

## One-time setup

```bash
npm install

# ~2 GB download on first run, idempotent afterwards.
bash scripts/install-emsdk.sh

# Shallow single-tag clone of OCCT, ~313 MB.
bash scripts/fetch-occt.sh
```

Before touching OCCT, confirm the toolchain itself works:

```bash
npm run kernel:hello   # builds native/src/hello.cpp, no OCCT involved
npm test               # loads it and calls into C++
```

This separation is deliberate. If `kernel:hello` succeeds and `kernel:build`
fails, the fault is in the OCCT build rather than in Emscripten or the loader.

## Building

```bash
npm run kernel:build
```

Two stages:

1. **OCCT static libraries** — slow (tens of minutes), built once per pinned OCCT
   version. Only `FoundationClasses`, `ModelingData`, and `ModelingAlgorithms`
   are enabled; `DataExchange` (STEP), `Visualization`, `Draw`, and
   `ApplicationFramework` are all off. STEP arrives in MVP-2.
2. **The facade module** — seconds. Rebuilt whenever `native/src` changes.

Useful flags:

```bash
bash scripts/build-kernel.sh --occt-only     # stage 1 only
bash scripts/build-kernel.sh --facade-only   # stage 2 only, the common case
bash scripts/build-kernel.sh --force         # ignore the cache
```

The artifact is cached under a key of the pinned tool versions plus a hash of the
facade sources, so an unchanged build is a no-op instead of an hour of waiting.
The key is written to `native/build/.kernel-cache-key`.

Output lands in `src/kernel/wasm/`:

```
webcad_kernel.mjs    Emscripten ES module loader
webcad_kernel.wasm   the kernel itself
```

Both are build products and are gitignored.

## Exception model

Both OCCT and the facade are compiled with `-fwasm-exceptions`. This matters:
OCCT throws `Standard_Failure`, and the facade's status convention depends on
catching it. Mixing exception models between the static libraries and the module
would leave those throws uncatchable, and an uncaught C++ exception at the WASM
boundary can leave the whole module unusable.

`native/src/hello.cpp` includes an explicit catch test so a dropped flag fails
loudly at the smoke-test stage rather than mysteriously later.

## Verifying

```bash
npm run typecheck
npm test                      # 49 tests; kernel tests skip if unbuilt
npm run verify:browser        # drives the real app in Chrome (WebGPU)
npm run verify:browser:webgl  # same, forcing the WebGL2 fallback
npm run kernel:size           # payload measurements
```

`npm run verify` chains typecheck, tests, and the browser run.

Browser verification uses `playwright-core` against the **installed system
Chrome**, so no browser binaries are downloaded. It exercises the parts node
tests cannot reach: the render path, the WebGPU/WebGL2 choice, GPU upload, and
picking. It writes screenshots and JSON to `measurements/`.

## Known environment issues

These are specific to the machine this was first built on, recorded so the next
person does not rediscover them.

- **`registry.npmjs.org` is unreachable** on the Autodesk corporate network. A
  project-local `.npmrc` points at the Artifactory mirror. Remove it if you are
  building elsewhere.
- **Node 23 is not supported by vitest**, whose engine range excludes odd Node
  releases. The project uses Node's built-in test runner instead, which also
  removes a dependency. Tests run with `--experimental-strip-types`.
- **Node's type stripping rejects TypeScript parameter properties**
  (`constructor(private readonly x)`). The codebase uses explicit field
  declarations instead; keep it that way or tests will fail to parse.
- **`find_package(OpenCASCADE)` needs `NO_CMAKE_FIND_ROOT_PATH`.** The Emscripten
  toolchain sets `CMAKE_FIND_ROOT_PATH_MODE_PACKAGE` to `ONLY`, which otherwise
  confines the search to the emscripten sysroot and hides the OCCT install.
- **OCCT 8.x deprecations**: `Standard_Failure::GetMessageString()`,
  `Standard_True`, and `Standard_False` are all deprecated. Use `what()`, `true`,
  and `false`.
