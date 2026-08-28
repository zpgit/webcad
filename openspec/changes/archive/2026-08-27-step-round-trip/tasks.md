## 1. Toolkit linkage and the size question

The design says measure the module before building anything on top of it, because
a `.wasm` that cannot ship changes the shape of the whole stage.

- [x] 1.1 Record the baseline: run `npm run kernel:size` at HEAD and keep the raw and brotli figures for the `.wasm` and the loader, so growth is attributed to this change rather than discovered at the end.
- [x] 1.2 Add the DataExchange toolkits to `native/CMakeLists.txt`, replacing the comment at lines 37-38 that says STEP arrives in MVP-2. `TKDESTEP` needs `TKDE`, `TKXSBase`, `TKShHealing`, `TKXCAF`, `TKCAF`, `TKLCAF`, `TKCDF`, and `TKGeomAlgo` per its `EXTERNLIB.cmake`; link the minimum set that builds and record which ones were actually required.
- [x] 1.2a **Not anticipated:** the pinned OCCT was built with `BUILD_MODULE_DataExchange=OFF` and `BUILD_MODULE_ApplicationFramework=OFF`, so none of those static libraries exist. Changing the facade's link line is not enough — OCCT itself has to be rebuilt. Add the toolkit to `scripts/build-kernel.sh` stage 1 and rebuild it.
- [x] 1.2b **Not anticipated:** linking STEP makes OCCT's shape healing reachable, which exposes an emscripten miscompilation that produces invalid wasm. Diagnose it and fix it in the build rather than working around it per file. See the notes below.
- [x] 1.3 Build with `npm run kernel:build` and re-run `npm run kernel:size`. Report the delta in raw and brotli bytes for the `.wasm` and the loader. Use `--force` if the sources were restored from a copy — the cache decides staleness from mtimes but stamps from hashes, and can silently skip the compile.
- [x] 1.4 If the growth is large enough to question shipping a single module, stop and record the number and the options before continuing — a lazily loaded translation module is a real architectural change and it needs this measurement, not a guess. Continue if it is acceptable.

### Notes from group 1, for the findings document

- **Baseline at HEAD** (`measurements/payload-baseline-mvp1.json`): wasm 7,216,979 raw / 2,035,066 brotli; loader 105,212 / 25,151; total 7,322,191 / 2,060,217. Note the `.wasm` reported by `kernel:size` is 6.88 MB where `dist/` carries 6.9 MB — same artifact, different rounding.
- **STEP is not a link-line change.** The pinned OCCT build had `BUILD_MODULE_DataExchange=OFF` *and* `BUILD_MODULE_ApplicationFramework=OFF`, so `libTKDESTEP.a`, `libTKDE.a`, `libTKXSBase.a`, `libTKXCAF.a`, `libTKCAF.a`, `libTKLCAF.a` and `libTKCDF.a` did not exist at all. Of the eight toolkits `TKDESTEP` declares, only `TKShHealing` was already built — it lives in `ModelingAlgorithms`, which was on. Stage 1 had to be rebuilt, which the task list did not anticipate.
- **The whole module was not needed.** `BUILD_ADDITIONAL_TOOLKITS=TKDESTEP` resolves the dependency closure automatically (`third_party/occt/CMakeLists.txt:443`, `adm/cmake/vardescr.cmake:124-128`), so the modules stay `OFF` and IGES, glTF, OBJ, PLY, VRML and STL are never built. This preserves the narrow selection the script was written around, and is why the OCCT rebuild is a partial one rather than a cold hour.
- **Linking STEP produced invalid wasm, and the cause was neither STEP nor this change.** The link succeeded and then `wasm-opt` died with `parse exception: popping from empty stack`. Binaryen's message is a dead end; V8's is not — `new WebAssembly.Module()` in Node named the function and the defect: `Compiling function #15658:"ShapeUpgrade_ShapeDivide::Perform(bool)" failed: br_table: label arity inconsistent with previous arity 0`. **Validating a suspect artifact with Node is the cheap first move**; relinking with `--profiling-funcs` is what turns a function index into a name, since `-O3` strips the name section.
- **The mechanism.** OCCT's cmake adds `-DOCC_CONVERT_SIGNALS` unconditionally for non-MSVC builds (`adm/cmake/occt_defs_flags.cmake:48`), which expands `OCC_CATCH_SIGNALS` into a `setjmp`. That puts wasm EH and wasm SjLj in one translation unit, and emscripten 6.0.7's SjLj lowering rewrites the CFG with a dispatch switch whose `br_table` has inconsistent label arity. `wasm-ld` emits it without complaint; nothing downstream can parse it.
- **Optimization level is irrelevant** — the same function is invalid at `-O0`, `-O1`, `-O2`, and `-O3`, because the lowering pass runs regardless. `-O2` and `-O3` produce a byte-identical object for this file, which briefly made a swap look like it had no effect when it simply changed nothing.
- **Why MVP-0 and MVP-1 never saw it.** `libTKShHealing.a` was always built and always contained the bad function; nothing referenced it, so it was dead-stripped. STEP's `FixShape` path makes it reachable. The bug was latent in every previous build of this project.
- **Per-file workarounds do not scale here.** 150 OCCT translation units use `OCC_CATCH_SIGNALS`, including 25 in TKShHealing, 9 in TKDESTEP and 8 in TKXSBase. Fixing one moved the failure to the next.
- **The fix is `-UOCC_CONVERT_SIGNALS` in the OCCT build**, and it is correct rather than expedient: the macro exists to convert OS signals such as SIGSEGV into OCCT exceptions, and a wasm sandbox delivers no such signals, so it cannot function here at all. OCCT supports its absence directly (`Standard_ErrorHandler.hxx:89` defines the macro as empty). It goes in `CMAKE_CXX_FLAGS` because cmake places `$FLAGS` after `$DEFINES`, so the `-U` wins — verified by compiling one file both ways and comparing bytes. Cost: a full OCCT rebuild, since the flag is global.
- **A size measurement taken at linkage time would have been meaningless.** The linker dead-strips a toolkit whose symbols nothing references, so the honest number only exists once a real call site does. MVP-1 recorded the mirror image of this — its payload grew because previously stripped code became reachable. The `.wasm` is therefore measured twice: after linkage alone, and again after group 2.

## 2. Kernel-side translation (C++)

- [x] 2.1 Add `importStep(bytes, options) -> handles` to `native/src/kernel.{hpp,cpp}`: wrap the staging buffer in an `std::istringstream`, call `XSControl_Reader::ReadStream`, check the `IFSelect_ReturnStatus`, `TransferRoots`, and register each resulting root shape as a body in a stable order. All-or-nothing on failure — destroy anything already constructed rather than leaving orphaned handles, matching how `restoreBodies` behaves.
- [x] 2.2 Register imported shapes that are not valid closed solids instead of refusing them: give `registerSolid` a path that accepts a shape while reporting `isValid` and `isClosed` truthfully, and keep the strict gate for primitives and Boolean results, which must not loosen.
- [x] 2.3 Report what the translation produced: bodies registered, root shapes the file declared, shapes that could not be registered, and a per-body flag for not-a-closed-solid. Return counts and scalars only — no STEP entity may reach the boundary.
- [x] 2.4 Read the file's declared length unit through the reader's unit inspection, and report it alongside the working unit the bodies are expressed in. Report an undeterminable unit as unknown together with the unit assumed in its place. Do not set the model's local length unit away from the working unit.
- [x] 2.5 Scan the loaded `Interface_InterfaceModel` for the entity types that carry names, colours, and assembly structure, and report their counts as dropped. Counts cross the boundary; entities do not.
- [x] 2.6 Make shape processing an explicit option in both directions, defaulting to disabled: call `SetShapeProcessFlags` with empty flags to suppress the reader's `FixShape` and the writer's `SplitCommonVertex`/`DirectFaces`, and report which operations actually ran on each translation.
- [x] 2.7 Add `exportStep(handles) -> bytes` to the same files: build a compound of the requested bodies, `Transfer` and `WriteStream` into an `std::ostringstream`, copy into staging, and return offset, length, and the unit written. Reject an unknown handle with `InvalidHandle` before writing anything, and leave every input handle valid and unchanged.
- [x] 2.8 Handle every failure path without escaping the boundary: bytes that are not STEP, a truncated payload, a valid file containing no transferable shape (reported distinctly from a parse failure), and an export of an empty set. Route all of it through the existing `guarded`/`fail` machinery so the module is never aborted.
- [x] 2.9 Extend `native/src/bindings.cpp` for both operations in the same offset/length style as `serializeBodies`/`restoreBodies`, reusing `reserveStaging` and `discardStaging` rather than adding a second staging buffer.
- [x] 2.10 Verify against the raw module before the TypeScript layer exists, the way `native/build/smoke-serialize.mjs` did for MVP-1: import both fixtures, census them, export, re-import, and confirm no handle leaks and no module abort on any failure path.

## 3. Kernel boundary and protocol (TypeScript)

- [x] 3.1 Add `importStep` and `exportStep` request kinds and result shapes to `src/kernel/worker/protocol.ts`, and extend `requestTransferables` so the inbound file bytes are transferred by derivation rather than by the caller remembering to list them.
- [x] 3.2 Implement both in `src/kernel/worker/handler.ts`: copy inbound bytes into WASM memory before translating, copy the export payload out into an owned buffer for transfer, and never retain a view over WASM memory across either call.
- [x] 3.3 Enforce the one-payload-in-flight invariant rather than assuming it: a request that would put a second payload in flight is queued behind the first or rejected with a typed error, and can never overwrite a payload the kernel is still using. Add the test that proves it.
- [x] 3.4 Add `importStep(bytes, options)` and `exportStep(bodyIds)` to `src/kernel/kernel.ts`, transferring the inbound buffer and documenting that the caller loses ownership. Assign fields in constructor bodies, not as TypeScript parameter properties — Node's type stripping rejects those and fails the whole test file at load.
- [x] 3.5 Add typed errors for translation failure in `src/kernel/errors.ts`, keeping the code enum in step with the C++ side; `tests/worker-protocol.test.ts` asserts they match.
- [x] 3.6 Record payload byte counts and the operation type for both directions on the operation log (`src/kernel/types.ts`), so translation cost can be related to file size, and keep translation and tessellation as separate log entries.
- [x] 3.7 Tests (`tests/step-translation.test.ts`, Node, in-process transport): import of a small fixture producing the expected census; an imported body used as a Boolean operand and checkpointed; export returning bytes whose re-import matches; unknown handle, non-STEP bytes, truncated payload, and shape-free file all failing typed with the live-handle count unchanged; and no handle leak across an import/edit/export/release cycle.

## 4. Document provenance

- [x] 4.1 Add a body source to `src/document/types.ts` — authored here, or imported with source filename, format, and the file's declared unit — and increment `schemaVersion`. Update the comment at lines 9-10 and 101, which currently promise this stage will make the units field disagree; it does not, and the reason belongs there.
- [x] 4.2 Add an import entry to the construction record with its source filename, format, declared unit, and the identities it produced, as inert metadata that is never replayed and never used to re-read the source file.
- [x] 4.3 Keep the manifest's working unit unchanged by an import, and record the source file's declared unit as provenance rather than letting it displace the document's unit.
- [x] 4.4 Read MVP-1 documents that have no source records: a body with no recorded source reads as authored here. Add the test — a document written by the previous schema must still open.
- [x] 4.5 Tests (`tests/document.test.ts` or a sibling): provenance survives save and reopen; an import entry round-trips with its fields intact; opening a document with imported bodies makes no attempt to locate the source file and succeeds without it; a damaged construction record still restores geometry.

## 5. Application integration

- [x] 5.1 Add import to the modeling session (`src/app/modeling-session.ts`): read the chosen file as bytes on the main thread without parsing it, translate in the Worker, register the bodies with document identity and provenance, tessellate, and add them to the viewport along— not instead of — what is already there.
- [x] 5.2 Add export to the session: gather the current bodies, call the kernel, and hand the bytes to a download named after the document with a `.step` extension, byte-identical to what the kernel produced.
- [x] 5.3 Add the UI in `src/main.ts` and `src/ui/`: a file picker accepting `.step` and `.stp`, an export action, an in-progress indication that prevents a concurrent second translation, and the reported sizes, body counts, and durations for both directions.
- [x] 5.4 Report failures without damaging the session: a non-STEP file, a translation failure, and an export of an empty session each report their reason, leave every existing body present, and let the user immediately try again.
- [x] 5.5 Report what was dropped where the user can see it — assembly structure, names, and colours — so the gap is attributable to this stage rather than to their file.

## 6. Fidelity measurement and verification

- [x] 6.1 Add fixture resolution that works with a gitignored `third_party/occt/data/step/`: locate `screw.step` and `linkrods.step` at run time, and when they are absent report skipped-for-missing-fixture rather than passing silently or failing.
- [x] 6.2 Add the fidelity comparison to `tests/browser/`: census each fixture with `bodyInfo` and `faceTypeSummary` at four points — after import, after checkpoint restore, after a Boolean, and after re-importing our own export — and report the differences. No new kernel inspection operation is needed; confirm that and record it.
- [x] 6.3 Run the comparison with shape processing disabled and enabled, and attribute the difference between them to processing rather than to translation.
- [x] 6.4 Measure the end-to-end round trip the note asks for (§14): import, tessellate, checkpoint, close, restore, one Boolean, export. Capture wall-clock per phase, peak WASM memory, and byte sizes at each stage, separating translation from tessellation.
- [x] 6.5 Extend the browser verification (`npm run verify:browser`) to cover an import, an edit, a save, a reload, and an export, so the round trip is exercised in a real browser and not only in Node.
- [x] 6.6 Run `npm run verify:dist` for the built output — the dev server resolves assets from source paths while a build rewrites them, and that difference has shipped a broken kernel before. Confirm the larger `.wasm` still loads from `dist/`.
- [x] 6.7 Run the full gate: `npm run typecheck`, `npm test`, `npm run verify:browser`, `npm run verify:browser:webgl`, `npm run verify:storage`, `npm run verify:dist`.

## 7. Wrap-up

- [x] 7.1 Choose the application's default for shape processing on the evidence from 6.3 and record the reason. The stage is not complete until this is answered rather than inherited from the library.
- [x] 7.2 Write `docs/MVP-2-FINDINGS.md` from the notes accumulated in each group: module size, translation throughput and peak memory per fixture, the fidelity censuses, what processing changed, and the round-trip phase timings. The document must carry its own numbers — nothing under `measurements/` is committed.
- [x] 7.3 State the limits plainly in the findings: the re-import comparison validates our writer against our reader and is self-referential; §12's 10 MB / 100 MB / 500 MB question is unanswered for want of a fixture, not extrapolated; assembly structure, names, and colours were dropped by design; timings on this box vary by up to ~1.8× between runs, so read ratios and orderings.
- [x] 7.4 Update `README.md`: the roadmap row for MVP-2, the layout table if new directories appeared, the capability list, and the sentence at line 39 promising STEP arrives in MVP-2.
- [x] 7.5 Run `openspec validate step-round-trip`, then sync the delta specs into `openspec/specs/` and archive the change.

### Notes from groups 2-7, for the findings document

All numbers are in `docs/MVP-2-FINDINGS.md`, which has to carry them because
nothing under `measurements/` is committed. What belongs here is the reasoning
that would otherwise be lost.

- **`linkrods.step` is not an assembly.** 1.8 MB, one solid, 37 faces, 0 assembly
  nodes; the size is surface complexity (18 b-spline faces), not part count. A
  test asserting it was an assembly failed, correctly, and was rewritten to
  assert what the fixture is. **No fixture available locally is a real STEP
  assembly**, so the flattening path is covered only by re-importing our own
  multi-body export, which is a weaker claim about a different thing.
- **The torus finding is narrower than it looks.** `screw.step` round-trips its 3
  tori as surfaces of revolution; `linkrods.step` round-trips 9 tori unchanged.
  So it is not "tori do not survive". And because the check is a re-import of our
  own export, the measurement cannot say whether the writer, the reader, or the
  pair of them is responsible — isolating it needs a third-party reader.
- **The first translation in a session costs ~220 ms of one-time setup.** Four
  successive imports of the same file: 253, 34, 36, 30 ms. Any benchmark that
  imports one file once is measuring mostly warmup, which is why the findings
  label which numbers are cold.
- **The healing default rests on a gap, and says so.** `FixShape` changed nothing
  measurable on either fixture - but both are clean OCCT-authored files, and
  healing exists for damaged ones. Off by default preserves attributability at no
  measured cost; the UI toggle exists because the evidence does not cover the case
  the feature is for.
- **EmptyResult crosses as a success for import**, matching the convention
  `booleanOp` already set. A valid file containing no solid is reported with zero
  bodies and its root counts intact, distinct from a parse failure, which throws.
  The C++ sets the status on the populated result rather than returning through
  `fail<>()`, which would have discarded the very counts that make the outcome
  diagnosable.
- **No new inspection capability was needed.** `bodyInfo` and `faceTypeSummary`
  already report the whole comparison vector - counts, volume, area, bounding box,
  validity, surface types. The obvious plan would have added one.
- **The one-payload-in-flight invariant needed no guard**, and adding one would
  have been dead code implying a race the design does not permit. It holds because
  requests are serialized by both transports and because staging never spans a
  request. Documented in `protocol.ts` and asserted from the outside in
  `tests/step-translation.test.ts`.
- **OCCT narrates to the console by default.** The STEP reader and writer send
  per-transfer statistics through the default messenger at Info gravity,
  unconditionally. Dropped to Warning once, lazily, in the facade - a kernel
  should not print banner blocks into an application's console on every export.
- **`page.waitForFunction` takes options as its THIRD argument.** Every wait in
  `verify-browser.mjs` passed them second, so Playwright kept its 30 s default and
  the script's documented 60 s allowance was never in effect. It surfaced only
  because this stage nearly doubled the `.wasm`. Fixed here and in
  `record-demo.mjs`; written up in `BUILD.md`. Some startup intermittency remains
  beyond it.
