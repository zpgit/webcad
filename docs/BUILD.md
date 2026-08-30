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

The clone also brings in the two STEP fixtures the translation suites read, at
`third_party/occt/data/step/`. If you have a built kernel but no source tree —
which happens whenever the install tree came from a cache — fetch just those:

```bash
npm run fixtures:fetch   # two files, ~1.9 MB, hash-checked against the pinned tag
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
   are enabled as modules; `DataExchange`, `Visualization`, `Draw`, and
   `ApplicationFramework` stay off. STEP arrives as a single named toolkit
   instead — `BUILD_ADDITIONAL_TOOLKITS=TKDESTEP`, whose dependency closure OCCT
   resolves itself — so the build gets STEP without also getting IGES, glTF,
   OBJ, PLY, VRML and STL.
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
npm test                      # 140 tests; kernel tests skip if unbuilt,
                              # STEP tests skip without `npm run fixtures:fetch`
npm run verify:browser        # drives the real app in Chrome (WebGPU)
npm run verify:browser:webgl  # same, forcing the WebGL2 fallback
npm run verify:storage        # storage conformance against real IndexedDB and OPFS
npm run verify:dist           # builds, then drives dist/ served statically
npm run kernel:size           # payload measurements
```

`npm run verify` chains typecheck, tests, the browser run, and the dist run.

Browser verification uses `playwright-core` against the **installed system
Chrome**, so no browser binaries are downloaded. It exercises the parts node
tests cannot reach: the render path, the WebGPU/WebGL2 choice, GPU upload,
picking, browser storage, and recovery across a real page reload. It writes
screenshots and JSON to `measurements/`.

Three of those runs need a browser for different reasons, and none substitutes
for another. `verify:browser` is the wide one — geometry, rendering, and the
persistence measurements. `verify:storage` runs one conformance suite against
real IndexedDB and real OPFS, whose transaction, quota, and file-handle behavior
is the whole point and cannot be faked. `verify:dist` is the only one that says
anything about a build.

## Known environment issues

These are specific to the machine this was first built on, recorded so the next
person does not rediscover them.

- **`registry.npmjs.org` is unreachable** on the Autodesk corporate network.
  Point npm at the Artifactory mirror with a project-local `.npmrc`, which is
  gitignored because registry configuration is environment-specific:

  ```
  registry=https://art-bobcat.autodesk.com/artifactory/api/npm/autodesk-npm-virtual/
  ```

  The lockfile records canonical `registry.npmjs.org` URLs and must stay that
  way. npm's default `replace-registry-host=npmjs` rewrites the host of those
  URLs to whatever registry is configured, so a mirror works without the
  lockfile knowing about it. A lockfile carrying mirror URLs installs only on
  that network — which is what broke CI once already.
- **Node 23 is not supported by vitest**, whose engine range excludes odd Node
  releases. The project uses Node's built-in test runner instead, which also
  removes a dependency. Tests run with `--experimental-strip-types`.
- **Tests pass `--no-wasm-async-compilation`, and it is not cosmetic.** Without
  it, a test file that instantiates the kernel around twenty times stalls
  intermittently — 5 of 6 runs, hanging forever rather than failing. The stall is
  inside Emscripten's `factory()`, in V8's *asynchronous* WASM compilation: the
  promise never resolves, the event loop blocks so not even an unref'd timer
  fires, and the process burns no CPU while doing it. Forcing synchronous
  compilation fixed 6 of 6. It is a V8 flag rather than a Node API, so if a
  future Node rejects it the failure is loud. Nothing about the browser is
  affected — there, Emscripten instantiates through `fetch` and a different
  compilation path, and the app creates one kernel per Worker rather than twenty
  per process.

  Symptoms worth recognizing, because two plausible explanations were wrong: it
  is not memory (the box had 207 GB free, and 40 held-open modules cost 240 MB),
  and it is not the 12 MB `readFileSync` Emscripten uses in Node (300 of those
  reads ran at a p99 of 3.3 ms).
- **Node's type stripping rejects TypeScript parameter properties**
  (`constructor(private readonly x)`). The codebase uses explicit field
  declarations instead; keep it that way or tests will fail to parse.
- **`find_package(OpenCASCADE)` needs `NO_CMAKE_FIND_ROOT_PATH`.** The Emscripten
  toolchain sets `CMAKE_FIND_ROOT_PATH_MODE_PACKAGE` to `ONLY`, which otherwise
  confines the search to the emscripten sysroot and hides the OCCT install.
- **OCCT 8.x deprecations**: `Standard_Failure::GetMessageString()`,
  `Standard_True`, and `Standard_False` are all deprecated. Use `what()`, `true`,
  and `false`.
- **`page.waitForFunction` takes its options as the THIRD argument.** The
  signature is `(pageFunction, arg, options)`, so `waitForFunction(fn, { timeout:
  60_000 })` passes the options object as `arg` and silently keeps Playwright's
  30 s default. Every wait in `verify-browser.mjs` was written that way, which
  meant the 60 s allowance below was never actually in effect - it surfaced only
  when MVP-2 nearly doubled the `.wasm` and startup crossed 30 s. Pass `undefined`
  in between.
- **A browser run can time out navigating to the dev server.** The symptom is
  `page.goto: Timeout 30000ms exceeded` with a dev server that is up and serving
  every module in milliseconds when probed by hand. The first request transforms
  the whole module graph and pre-bundles three.js, and on a loaded machine that
  has taken over 30 s; the scripts now allow 60 s. If it persists, delete
  `node_modules/.vite` — a run that had two Vite servers on the same port at once
  recovered only after the optimizer cache was cleared, which is a weaker claim
  than a diagnosis but was reproducible three times.
- **`bash` may not be on `PATH` on Windows.** The `scripts/*.sh` builds need Git
  Bash; prepend its `bin` directory (e.g. `C:\Program Files\Git\bin`) to `PATH`
  before invoking them. The Node-based scripts have no such requirement.
