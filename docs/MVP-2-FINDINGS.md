# The STEP round trip

MVP-2: import a STEP file, edit it in the browser, export STEP again, and find
out what the trip costs and what it loses. This is the experiment the
architecture note calls the next one worth running (§14).

**Verdict: the round trip preserves geometry and loses surface identity in one
measurable case, and it costs an order of magnitude more than the native
checkpoint it replaced.** Both fixtures survive import, checkpoint, edit and
export with their topology, volume and area intact. One of the two comes back
with three toroidal faces re-typed as surfaces of revolution — exact geometry,
different analytic identity. STEP import runs at 2.7–4.4 kB/ms against the
native checkpoint's 49–199 kB/ms, and the `.wasm` grew 70% to carry the
translator.

Four results were not predicted:

- **The first STEP translation in a session costs 253 ms; the next costs 33 ms.**
  About 220 ms is one-time initialization, not payload cost. See
  [Translation cost](#translation-cost).
- **A round trip can change a surface's type without changing its geometry.**
  `screw.step`'s three tori return as surfaces of revolution; `linkrods.step`'s
  nine tori do not. See [What the round trip loses](#what-the-round-trip-loses).
- **OCCT's shape healing changed nothing measurable on either fixture**, which is
  weaker evidence for the default it decided than it first appears. See
  [Shape processing](#shape-processing).
- **Linking STEP produced invalid WebAssembly**, from a latent emscripten bug
  that had been dead-stripped out of every previous build of this project. See
  [The build](#the-build-and-the-latent-miscompilation).

## Build under test

OCCT 8.0.1, Emscripten 6.0.7, headless Chrome via Playwright, WebGL2 and WebGPU
backends both exercised. Numbers below come from `measurements/step*.json`,
`measurements/payload.json`, and the Node suite, on a Windows box running the
user's own desktop Chrome alongside the headless one.

**Read ratios and orderings, not absolute milliseconds.** MVP-1 established that
the same work varies by up to ~1.8× between runs on this machine, and nothing
here changes that. Where a number matters, it is either a ratio or was taken
several times.

## Fixtures, and what they are not

OCCT's own test data, which is what is available locally:

| Fixture | File | Bodies | Faces | Edges | Surfaces |
| --- | --- | --- | --- | --- | --- |
| `screw.step` | 88,552 B | 1 | 10 | 22 | 4 plane, 1 cylinder, 2 cone, 3 torus |
| `linkrods.step` | 1,793,282 B | 1 | 37 | 108 | 6 plane, 4 cylinder, 9 torus, 18 b-spline |

Both are single parts, both authored by neither of our reader and writer, both
declare millimetres, and both live under a gitignored `third_party/occt/`.

**`linkrods.step` is not an assembly**, despite its name and its 1.8 MB. It is
one solid with 37 faces; the size comes from surface complexity — 18 b-spline
faces — rather than from part count. A test asserting it was an assembly passed
only by accident and has been corrected to assert what it is.

The consequence is a real gap and not a small one: **no fixture available here is
a STEP assembly**, so the flattening path and the product-structure half of the
dropped-semantics report are not exercised against real data. Compound
flattening is covered by re-importing our own multi-body export, which is a
weaker claim about a different thing.

## Translation cost

Steady-state, after the one-time cost below is paid:

| | Import | Export | Native checkpoint | Native restore |
| --- | --- | --- | --- | --- |
| `screw.step` | 33 ms (2.7 kB/ms) | 29.8 ms | 0.7 ms (24,579 B) | 0.5 ms |
| `linkrods.step` | 406 ms (4.4 kB/ms) | 64.9 ms | 3.0 ms (577,529 B) | 2.9 ms |

**STEP is 45–77× slower than the native checkpoint on the same geometry.**
`linkrods` restores from 577 kB of `.brep` in 2.9 ms and imports from 1.79 MB of
STEP in 406 ms. That ratio, measured rather than asserted, is the entire
practical argument for the architecture note's §3 position that the native
document must not be STEP: translating on every open would turn a 3 ms
restoration into a 400 ms one.

### The first translation costs 220 ms of nothing

Importing `screw.step` four times in one session, releasing between each:

| Import | 1st | 2nd | 3rd | 4th |
| --- | --- | --- | --- | --- |
| Wall clock | 253.3 ms | 33.6 ms | 35.9 ms | 30.1 ms |

The first call pays a one-time initialization — STEP's schema and static data —
and it is 7.6× the steady-state cost for this file. This matters twice over:
a user's first import feels slow for reasons that have nothing to do with their
file, and **any benchmark that imports one file once is measuring mostly
warmup**. The browser run's 138 ms for `screw.step` is a first-import number and
is reported here as such; `linkrods.step`'s 406 ms was measured warm.

### Memory

Peak WASM linear memory across the whole session, including both fixtures,
tessellation, checkpoints and exports: **29.1 MB**, against a 16.0 MB idle
baseline. Translating a 1.79 MB STEP file therefore cost on the order of 13 MB of
peak memory alongside everything else the session was holding. The module grows
and never shrinks, so this is a high-water mark rather than a per-file cost.

### Sizes

| | STEP in | Native checkpoint | STEP out |
| --- | --- | --- | --- |
| `screw.step` | 88,552 B | 24,579 B | 87,074 B |
| `linkrods.step` | 1,793,282 B | 577,529 B | 1,903,994 B |

**The native checkpoint is 3.1–3.6× smaller than the STEP that produced it**, and
the export is within 6% of the input size. A second supporting number for not
persisting in STEP.

## What the round trip loses

Each fixture was censused at four points — after import, after a native
checkpoint round trip, after a Boolean, and after re-importing our own export —
on topology counts, volume, area, bounding box, validity, and surface types.

**`linkrods.step`: no measurable difference at any point.** 37 faces, 108 edges,
volume 3.8470, area 32.1514, and all 9 tori and 18 b-spline faces intact through
export and re-import.

**`screw.step`: geometry preserved, surface identity not.** Every count and
measurement survives — 10 faces, 22 edges, volume 3788.2706, area 1929.3327 —
but the surface census changes:

```
torus       3 -> 0
revolution  0 -> 3
```

The three toroidal faces come back typed as surfaces of revolution. This is not
a geometric error: a torus *is* a surface of revolution, the area and volume are
unchanged to within 1e-6, and nothing became a spline or a facet. It is a loss of
analytic specificity — a downstream feature that asked "is this face a torus"
would get a different answer after a round trip than before it.

Two things are worth stating precisely, because the obvious generalization is
wrong. **It is not "tori do not survive":** `linkrods.step` round-trips nine tori
without a change. And **it is not our writer alone:** the check is a re-import of
our own export, so the re-typing happened in the writer, the reader, or in the
pairing of the two, and this measurement cannot say which. Isolating it would
need a third-party reader, which is exactly the thing this stage does not have.

### The control that makes the census trustworthy

The native checkpoint leg is included on every fixture precisely because MVP-1
already established it is lossless. It reported zero differences on both, which
is what licenses reading the STEP deltas as the translator's rather than the
comparison method's. The browser harness treats a checkpoint delta as a hard
failure for that reason.

### The edit is in the exported file

A 60×40×25 box with a radius-8 hole drilled through it, exported and re-imported:
5,026.5 mm³ removed, 19,033 B written, **zero census differences**, and the
cylindrical face the drill introduced still reports as an exact cylinder. This is
§5 of the note — "if the user performs Boolean […] the exported STEP should
contain that modified exact geometry" — as a measurement rather than an intention.

## Shape processing

OCCT does not translate STEP untouched. Verified in the 8.0.1 source rather than
assumed: the reader enables `FixShape`
(`STEPControl_Reader.cxx:864-867`) and the writer enables `SplitCommonVertex` and
`DirectFaces` (`STEPControl_Controller.cxx:348-353`), all by default. A repair
pass is indistinguishable in the result from a translation loss, so this stage
disables them and exposes the setting, and every translation reports which
operations ran.

Each fixture was imported both ways and the censuses compared:

| Fixture | Difference with `FixShape` enabled |
| --- | --- |
| `screw.step` | none measurable |
| `linkrods.step` | none measurable |

**The decision: shape processing stays off by default**, with a UI toggle for the
case that needs it. Off preserves attributability — a difference between a file
and a body is the translator's, not a repair's — and it demonstrably costs
nothing in fidelity on these files.

**What that evidence does not cover, and it is the important part.** Healing
exists to repair damaged files. Both fixtures are clean, OCCT-authored geometry,
so "changed nothing measurable" is the expected result and says nothing about the
case the feature exists for. This default is provisional on that gap, not
established by the measurement: a fixture that actually needs healing would be
the test, and none was available. The toggle is in the interface rather than
buried in a config because of exactly this.

## Units

Both fixtures declare `millimetre` and both report a working unit of `mm`.
Conversion happens once, inside the reader, as part of the transfer — OCCT sets
the model's local length unit from the system unit and transfers against it
(`STEPControl_ActorRead.cxx:376-379`) — and nothing downstream converts again.

MVP-1 added a `units` field to the manifest expecting a STEP import to give it
something to disagree with. **It should not, and that is the finding.** Letting a
document carry the source file's unit would make the working unit a per-document
variable that every operation, the viewport's framing, and the export would have
to know about, which is the leak §11 forbids. The file's declared unit is
recorded per body as provenance instead, where it cannot contradict the document.

Not exercised: no fixture declares anything other than millimetres, so the
conversion path itself is covered only by its absence being reported correctly.

## Imported bodies

Both fixtures import as valid solids and neither is flagged as an open shell, so
the "real STEP contains shapes that fail a validity check" path is present in the
code and unexercised by the available data.

One reading that looks like a bug and is not: both fixtures report
`isValid: true` and `isClosed: false`. `TopoDS_Shape::Closed()` is a cached flag
that OCCT does not necessarily set on a shape built by the STEP reader, so it is
unreliable for imported geometry. The facade classifies a body as an open shell
from its solid count and `BRepCheck_Analyzer`, not from that flag, which is why
neither fixture is misreported.

## The build, and the latent miscompilation

STEP cost more than a link line, in two ways worth recording.

**The pinned OCCT had no DataExchange libraries at all.** `BUILD_MODULE_DataExchange`
and `BUILD_MODULE_ApplicationFramework` were both `OFF`, so seven of the eight
toolkits `TKDESTEP` depends on did not exist. `BUILD_ADDITIONAL_TOOLKITS=TKDESTEP`
resolves the closure automatically, which keeps the narrow selection the build
script was written around: IGES, glTF, OBJ, PLY, VRML and STL are still never
built.

**Then the linked module was invalid WebAssembly.** `wasm-opt` failed with
`parse exception: popping from empty stack`, which is a dead end as a diagnostic.
Node's validator named the defect exactly:

```
Compiling function #15658:"ShapeUpgrade_ShapeDivide::Perform(bool)" failed:
br_table: label arity inconsistent with previous arity 0
```

OCCT's cmake adds `-DOCC_CONVERT_SIGNALS` unconditionally for non-MSVC builds
(`adm/cmake/occt_defs_flags.cmake:48`), which expands `OCC_CATCH_SIGNALS` into a
`setjmp`. That puts wasm EH and wasm SjLj in one translation unit, and emscripten
6.0.7's SjLj lowering rewrites the CFG with a dispatch switch whose `br_table` is
invalid. The fix is `-UOCC_CONVERT_SIGNALS`, and it is correct rather than
expedient: the macro converts OS signals such as SIGSEGV into OCCT exceptions,
and a wasm sandbox delivers no such signals, so it cannot function here at all.
OCCT supports its absence directly (`Standard_ErrorHandler.hxx:89`).

Three things about this are worth carrying forward:

- **It was latent in every previous build.** `libTKShHealing.a` always contained
  the bad function; nothing referenced it, so it was dead-stripped. STEP's
  `FixShape` path made it reachable.
- **Optimization level is irrelevant.** The same function is invalid at `-O0`
  through `-O3`, because the lowering pass runs regardless. `-O2` and `-O3`
  produce a byte-identical object for this file.
- **Per-file workarounds do not scale.** 150 OCCT translation units use the
  macro, 25 in TKShHealing alone. Fixing one moved the failure to the next.

### Module size

| | Before | After | Change |
| --- | --- | --- | --- |
| `.wasm` raw | 7,216,979 B | 12,292,935 B | +70.3% |
| `.wasm` brotli | 2,035,066 B | 2,959,320 B | +45.4% |
| Loader raw | 105,212 B | 108,877 B | +3.5% |
| **Total brotli** | **2,060,217 B** | **2,985,509 B** | **+44.9%** |

STEP costs 924 kB compressed, taking the download to just under 3 MB. Accepted
for now: it is under the doubling the design allowed for, and `npm run verify:dist`
confirms the larger module still loads from a production build. `TKDESTEP` drags
in `TKXCAF`, `TKCAF`, `TKLCAF` and `TKCDF`, so **MVP-3's XCAF toolkits are already
linked** — its incremental cost should be much smaller than this one.

If the download becomes unacceptable, the option not taken is a lazily loaded
translation module: nothing in the geometry, document or app layers built here
depends on translation being in the same `.wasm`.

## A verification bug this stage surfaced

`page.waitForFunction` takes its options as the **third** argument. Every wait in
`verify-browser.mjs` passed `{ timeout: 60_000 }` as the second, where Playwright
treats it as the page function's argument and keeps its own 30 s default. The
60 s allowance the script documented was never in effect. It surfaced only
because this stage nearly doubled the `.wasm` and startup crossed 30 s. Fixed
here and in `record-demo.mjs`, and written up in `BUILD.md`.

## What this does not answer

- **§12's 10 MB / 100 MB / 500 MB question.** The largest fixture available is
  1.79 MB. Nothing here extrapolates to those sizes, and the memory figure above
  is a single high-water mark from one session rather than a curve.
- **Whether another CAD system accepts our export.** The re-import check
  validates our writer against our reader. It is self-referential by
  construction, and the only part of this that is not is the census of the two
  third-party fixtures on the way in.
- **Whether shape healing matters**, for the reason given above: no damaged
  fixture was available.
- **Assembly structure, part names and colours.** Dropped by design, counted and
  reported. Preserving them needs XCAF and is MVP-3's.
- **Whether re-tessellation at STEP scale changes MVP-1's mesh-persistence
  trade.** `linkrods.step` tessellates in 62.5 ms against a 406 ms import, so
  meshing is no longer the dominant cost when a file is imported — but it still
  is on reopening a document, which is the case MVP-1 measured. Measured here,
  deliberately not decided here.
- **A fillet or any face-selected edit.** Out of scope: selecting an edge mints
  the positional sub-entity reference §7 rules out and MVP-4 owns.

## Reproducing

```
npm run kernel:build          # needs OCCT rebuilt; see BUILD.md
npm test                      # 140 tests, 26 of them this stage's
npm run verify:browser        # writes measurements/step.json
npm run verify:browser:webgl
npm run verify:dist
```

The STEP fixtures come from `npm run kernel:fetch` and are gitignored. Without
them the translation tests and the browser measurement report themselves as not
run, rather than passing — the numbers above are the only record.
