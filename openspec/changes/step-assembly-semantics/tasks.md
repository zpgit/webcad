## 1. The two measurements that decide the shape of this stage

Both come first because each can invalidate work built on top of it. The face-order
answer decides whether per-face colour exists as designed; the size baseline is
only meaningful before any XCAF symbol becomes reachable.

- [x] 1.1 Record the size baseline: `npm run kernel:size` at HEAD, raw and brotli for the `.wasm` and the loader, kept so that growth from *using* the already-linked XCAF toolkits is attributed rather than discovered at the end. MVP-2 learned that a linked-but-unreferenced toolkit is dead-stripped, so this number is the last one taken before that stops being true.
- [x] 1.2 Answer the face-order question with a throwaway harness against the raw module, the way `native/build/smoke-serialize.mjs` did for MVP-1: build a shape with distinguishable faces, record the `TopExp_Explorer(TopAbs_FACE)` order with a per-face fingerprint (area, centroid), `BRepTools::Write` it, read it back, and compare the order. Do it for a primitive, a Boolean result, and an imported STEP part, since they are constructed differently.
- [x] 1.3 Write the answer down before building on it. If order is preserved, per-face colour proceeds as designed. If not, choose in this order: a geometric fingerprint key (worse — a positional name in disguise, and it needs its own stability measurement), or per-face colour reported as dropped with structure and shape-level colour still delivered. Record which, and why, for the findings.
- [x] 1.4 If order is preserved, add a permanent regression test for it: the assumption is load-bearing and silent when it breaks.

### Notes from group 1, for the findings document

- **Size baseline** (`measurements/payload.json`, gitignored, so recorded here):
  `.wasm` 12,293,109 raw / 2,957,941 brotli; loader 108,877 / 26,189; total
  12,401,986 / 2,984,130. Close to but not identical with the figures in
  `docs/MVP-2-FINDINGS.md` (12,292,935 raw / 2,959,320 brotli) — the local
  artifact has been rebuilt since that table was written, +174 bytes raw and
  −1,379 brotli. The baseline for this stage is the local artifact, since that is
  what the delta will be measured against.
- **`report-artifact-size.sh` still labels its output "MVP-0 payload".** Cosmetic,
  but it will misattribute this stage's numbers if left. Fix when task 12.5 runs.
- **Face exploration order survives a checkpoint.** The probe
  (`native/build/probe-face-order.mjs`, scratch and gitignored) found the mesh
  byte-identical — positions, normals, indices — after a round trip, for a box
  (6 planar faces), a drilled block (Boolean result, 7 faces), a cylinder with a
  seam (3 faces), `screw.step` (10 faces) and `linkrods.step` (37 faces). Also
  after two successive round trips, and when restored into a freshly instantiated
  module rather than the one that wrote the payload — which is the case that
  matters, since a document is restored by a process that has never seen it.
- **The instrument was the mesher, not a new binding.** It emits each face's
  triangulation nodes in `TopExp_Explorer` order and shares no vertex between
  faces (`native/src/kernel.cpp:449-470`), so the position buffer *is* the face
  order made observable, and a permutation of faces permutes the blocks. This
  avoided adding a temporary per-face binding to answer the question — worth
  remembering, because the same instrument can check the ranges added in task 5.3
  against the order the colour key uses.
- **What the mesh instrument cannot prove.** Byte-identical buffers show the
  sequence of face *geometry* is unchanged. Two coincident, geometrically
  identical faces could swap without changing a byte. No fixture does, and a
  colour landing on either of two identical coincident faces is not observable.
- **The mesher skips a face with no triangulation** (`native/src/kernel.cpp:454-456`,
  a defensive branch after an `IsDone()` check that already fails the operation).
  This invalidated the first draft of `tessellation`'s range requirement, which
  said the range count equals the face count and the ranges tile the buffer:
  counting only faces that emitted geometry would shift every later face's
  position by one. Fixed in the spec — one range per *visited* face, empty where
  nothing was emitted — before any code depended on it.
- **The regression test is deliberately indirect, and says so.**
  `tests/serialization.test.ts` now compares meshes across a round trip and
  distinguishes the two failure modes: same values in a different order means face
  order moved, different values mean the triangulation changed and the test can
  say nothing about order. Both branches were checked against synthetic permuted
  and mutated buffers, so the assertion is not vacuous.
- **Cost of this group: no C++ was written and nothing was rebuilt.** The two
  questions that could have reshaped the stage were both answerable from the
  existing artifact.

## 2. Fixtures, before the code that needs them

- [x] 2.1 Hand-author `tests/fixtures/assembly.step` — AP214, committed, minimal and asserted against exactly: two instances of one part with different placements (one of them mirrored, to exercise the no-decomposition rule), one grouping node with no shape of its own, a part-level `COLOUR_RGB`, an instance-level colour override, and one face colour. Keep it small enough to read in full.
- [x] 2.2 Write down what the file contains, in the fixture helper next to it, as counts a test can assert: parts, instances, depth, named entities, coloured faces. A hand-authored fixture whose contents are described only by the file itself is a test that asserts what it happens to parse.
- [x] 2.3 Verify the hand-authored file is actually valid STEP that a foreign reader accepts, not just one ours does — otherwise it proves nothing about the reader either. If no third-party reader is available, say so here and treat the file as an assertion vehicle only.
- [x] 2.1a **Not anticipated, twice over.** (a) The instance-level colour override is *not* in the hand-authored file. It is expressible — AP214 has `OVER_RIDING_STYLED_ITEM` — but nothing in this repository can read a colour back yet, so authoring one now would commit entities no test can check. Added in group 5 against a reader that can verify it. (b) A mirrored occurrence turned out not to be expressible at all through product structure: a `NEXT_ASSEMBLY_USAGE_OCCURRENCE` places its child through an `ITEM_DEFINED_TRANSFORMATION` between two `AXIS2_PLACEMENT_3D`, both right-handed by construction. The fixture uses an exact 3-4-5 rotation instead, and the placement requirement's rationale was corrected to name where a reflection actually comes from.
- [x] 2.4 Find a third-party STEP assembly with colours, permissively licensed, small enough to fetch in CI. Record the licence and the source alongside the pin. If none can be found, stop and record that: the interoperability claim is then reported as not exercised, and `assembly-structure`'s measurement requirement already says so.
- [x] 2.5 Extend `scripts/fetch-step-fixtures.sh` to a second pinned source: it currently derives one raw base from `WEBCAD_OCCT_REPO` and the pinned tag, so generalize the fixture table to carry a URL per entry rather than a shared base, keeping the sha256 check and the hard failure on mismatch.
- [x] 2.6 Teach `tests/helpers/step-fixtures.ts` about both new fixtures — the committed one always present, the pinned one skipping loudly when absent — and correct the comment block that now describes only OCCT's two single-part files.
- [x] 2.7 Add the new fixture to `tests/browser/step-measurements.ts`'s fixture list and to the CI fetch step's expectations, so the browser measurement covers an assembly rather than two single parts.

### Notes from group 2, for the findings document

- **The hand-authored fixture is `tests/fixtures/assembly.step`**, committed, 542
  lines: carrier -> cradle -> bracket x2, one part instanced twice, a grouping
  node with no shape, a part colour and a face colour. Its assembly layer is
  hand-written entity by entity; its leaf geometry is one 10 mm box from OCCT's
  own writer, because hand-authoring a manifold solid B-rep risks an invalid
  closed shell for no gain to what the fixture tests. The deviation from "hand
  author the whole file" is deliberate and recorded in the helper.
- **The placements were verified against a prediction, not just parsed.** A
  structure-blind reader flattens the file into two placed bodies, and their
  bounding boxes match the hand-computed expectation exactly on all six values,
  including the cradle's +5 mm Z lift - so placement *composition* is confirmed,
  not only the leaf transform. The rotation uses a 3-4-5 direction (0.6, 0.8, 0)
  so every expected coordinate is exact in binary.
- **A mirrored occurrence is not expressible through product structure at all.**
  `NEXT_ASSEMBLY_USAGE_OCCURRENCE` places its child through
  `ITEM_DEFINED_TRANSFORMATION` between two `AXIS2_PLACEMENT_3D`, both
  right-handed by construction. Reflections reach a reader by another route - a
  mapped item carrying a `CARTESIAN_TRANSFORMATION_OPERATOR_3D` - which is not an
  occurrence. The placement decision still stands (a `gp_Trsf` can be mirrored or
  scaled) but its stated rationale was wrong about where that comes from, and was
  corrected in the design and the spec.
- **Our exporter has been fabricating assemblies all along.** Exporting one body
  writes a flat product; exporting two writes a root product plus one child per
  body with invented names ("Open CASCADE STEP translator 8.0 2.1"), because
  OCCT's writer turns any compound into an assembly by default. That contradicts
  a scenario MVP-2 shipped, and no test caught it because the round-trip tests
  asserted geometry rather than the entity census. Pinned by a test now; task
  6.5a sets the assembly mode explicitly.
- **The third-party fixture is `as1-md-214.stp`**: the AS1 assembly as written by
  MicroStation/J through ST-DEVELOPER in 1999, 73 kB, 13 occurrences, 9 named
  products, 5 RGB colours, 18 bodies when flattened. **The variant matters** - the
  same assembly is published as written by several systems, and `as1-oc-214.stp`
  was written by OpenCascade, which is our own writer and would have proved
  nothing about interoperability. Its licence is not stated; the set is published
  by STEP Tools for testing STEP implementations, and the file is fetched at test
  time and never redistributed here. Recorded rather than asserted.
- **Pins are now required or optional.** OCCT's two are required, because they
  come over the same transport as the source clone. The third-party one is
  optional: it lives on someone else's host, and turning their outage into a red
  build buys nothing, so a failed download warns and the suites skip and report
  the claim as not exercised. A wrong hash stays fatal either way - unavailable
  and wrong are different problems. Both paths were exercised.
- **`npm test` now passes `--no-wasm-async-compilation`, and finding out why cost
  most of this group.** Adding five tests to the STEP file made it hang - not
  fail - in 5 of 6 runs. Two plausible diagnoses were both wrong: memory (the box
  has 225 GB, 40 held-open modules cost 240 MB) and Emscripten's synchronous
  12 MB `readFileSync` (300 reads at a p99 of 3.3 ms). The real cause is V8's
  *asynchronous* WASM compilation: the stall is inside Emscripten's `factory()`,
  the promise never resolves, and the event loop blocks so completely that an
  unref'd timer never fires while the process burns no CPU. Synchronous
  compilation: 6 of 6 clean, then 4 more full-suite runs clean, and the suite got
  *faster* (5.3 s against 7.3 s).
- **Kernel disposal in tests was added during that investigation and is kept, but
  it was not the fix.** `makeKernel` now tracks what it hands out and every
  kernel-using file releases them in an `afterEach`. It is correct hygiene - a
  kernel holds a 12 MB module plus its heap, and nothing collected them before -
  and it is not what stopped the hangs. Worth stating plainly so the next reader
  does not credit it with something it did not do.
- **Orphaned test processes contaminated the measurements halfway through.**
  `timeout` kills the runner but not the worker it spawned, so eleven stuck node
  processes had accumulated and the flake rate appeared to climb. Kill the
  children, or let node's own `--test-timeout` end the run, before trusting any
  rate measured here.

## 3. The parts-to-sections rename, on its own

Mechanical, byte-contract-neutral, and landed before the schema work so its diff
stays reviewable and the word "part" means one thing for the rest of the stage.

- [x] 3.1 Rename `PART_NAMES` → `SECTION_NAMES`, `PartName` → `SectionName`, `DocumentParts` → `DocumentSections` in `src/document/types.ts`, and follow the compiler through `src/document/document.ts`, `src/storage/{types,indexeddb,opfs}.ts`, and the three test files that use them. The stored names — `manifest.json`, `features.json`, `geometry.brep` — do not change.
- [x] 3.2 Update the prose that used the old word: the doc comment at `src/document/types.ts:38-46`, and any comment in `src/storage/` that calls a section a part.
- [x] 3.3 Prove the rename changed no bytes: the storage conformance round trip already asserts byte-identical sections, so run `npm run verify:storage` and confirm a document written before the rename still opens.

### Notes from group 3, for the findings document

- **The rename went wider than the three identifiers.** `buildParts` →
  `buildSections`, `requirePart` → `requireSection`, `DamagedDocumentError.part`
  → `.section`, and every local `parts`/`partName` in `src/document` and
  `src/storage`. Leaving those would have kept the word ambiguous in exactly the
  files this stage is about to add a *part* to, which is the whole point of doing
  it. Three uses of "part" survive on purpose: plain English at
  `src/document/types.ts:155` ("as part of the transfer") and
  `src/storage/opfs.ts:38` ("the parts of the File System Access API"), and the
  assembly sense already present at `src/app/modeling-session.ts:111,412`.
- **Two strings could not move, and they are IndexedDB's.** The object store is
  named `'parts'` and the compound key path is `['documentId', 'partName']`
  (`src/storage/indexeddb.ts`). Both are on-disk contract, and changing either
  needs a `DB_VERSION` bump and a migration pass to buy nothing but a tidier
  key. The TypeScript around them says section; the two literals stay, and say
  why.
- **A `SECTION_NAME_KEY` constant was added and then removed, because it was a
  decoy.** It looked like a single source of truth for the key-path field but is
  only read by `createObjectStore`, which runs on `onupgradeneeded` alone. A
  database created by an older build keeps the key path it was created with no
  matter what the constant later says, and the `put` and the read reference the
  field by name anyway. Three places have to agree and no constant can make them;
  the literal is inlined and the comment states the constraint instead.
- **"No bytes changed" was measured twice, both against a worktree of the
  pre-rename commit rather than against a description of it.** (a) The same draft
  through the old `buildParts` and the new `buildSections`, same fixed clock,
  same fake kernel: `manifest.json` 383 bytes, `features.json` 545,
  `geometry.brep` 6, all three byte-identical. (b) In one browser page, the old
  store writes a document and the new store reads it back — byte-identical
  sections, correct listing, and the last-opened pointer intact — on IndexedDB and
  on OPFS. Both probes were scratch and are deleted.
- **The layout probe was checked for vacuity and half of it failed the check.**
  Renaming `SECTIONS_STORE` from `'parts'` made it fail loudly, as it should. But
  renaming the key-path constant did *not*, and that is what exposed the decoy
  above: the new code never runs `createObjectStore` against a database the old
  code already created. Worth stating because it is the general shape of the trap
  — an IndexedDB schema constant is unreachable on precisely the upgrade path a
  compatibility test exercises.
- **Cost: 11 files, no behaviour change, and the suite is where it was** — 146
  tests passing, storage conformance passing on both backends with the same
  single pre-existing skip (Chrome does not enforce the IndexedDB quota
  override).

## 4. Structure-aware import (C++)

- [x] 4.1 Add the CAF read path to `native/src/kernel.{hpp,cpp}`: `STEPCAFControl_Reader` over the same staging-buffer `std::istringstream` the current reader uses, transferring into a `TDocStd_Document` created inside the call. Keep the existing plain-reader path reachable — `step-translation` now requires that a flat import remains a supported mode, not a degenerate assembly.
- [x] 4.2 Walk the resulting `XCAFDoc_ShapeTool` and produce two things: one registered body per distinct part shape, and a flat list of instance records (parent index, part index or none, 12-double transform, name). Free shapes with no structure yield bodies and no instances.
- [x] 4.3 Register each part exactly once. A part referenced by twenty components must produce one `BodyId` — dedupe on the shape the shape-tool reports for the part label, not on the located instance shape, which differs per occurrence.
- [x] 4.4 Release the `TDocStd_Document` before the call returns, on every path including failure, and assert in the harness that no label or document reference is reachable from the result.
- [x] 4.5 Report structure counts: instances, tree depth, named entities preserved, grouping nodes, and — still — the categories dropped, now named individually rather than as one number.
- [x] 4.6 Handle the failure paths the CAF reader adds without weakening the ones MVP-2 established: a file whose structure is cyclic or whose component references do not resolve, a part label with no shape, and a structure that transfers while the geometry does not. All through the existing `guarded`/`fail` machinery, all leaving the module usable.

### Notes from group 4, for the findings document

- **The size bill for waking the XCAF toolkits: +2,472,649 bytes raw, +479,899
  brotli.** 12,293,109 -> 14,765,758 raw (+20.1%), 2,957,941 -> 3,437,840 brotli
  (+16.2%), loader 108,877 -> 120,284. So "already linked, therefore nearly
  free" was wrong, and by a wide margin: the toolkits were on the link line but
  dead-stripped, exactly as MVP-2 predicted they would be, and referencing them
  brings in the whole OCAF attribute machinery. Measured against the task 1.1
  baseline, which the rebuild reproduced byte-identically before any of this
  landed.
- **Instancing measured, on a file we did not write.** `as1-md-214.stp` gives
  **5 bodies instead of 18** - and the 5 is confirmed against the file itself,
  which contains exactly 5 `MANIFOLD_SOLID_BREP` entities against 9 products
  and 13 `NEXT_ASSEMBLY_USAGE_OCCURRENCE`s. The dedup claim therefore rests on
  the file's own census and not on our reader agreeing with itself. The
  hand-authored fixture likewise has 1 `MANIFOLD_SOLID_BREP` and yields 1 body
  from 2 occurrences.
- **Structure sharing is expanded; geometry sharing is not.** AS1 has 13 NAUOs
  but the walk produces **28 nodes**, because the file stores a DAG - `NBA` is
  one definition used three times under each of two `LBA`s - and a tree has to
  give each use its own node. Still only 5 bodies. Collapsing the nodes too
  would mean a node's identity depending on the path taken to reach it, which
  is the positional-reference problem in another costume, so the expansion is
  the right trade and is now stated in the fixture helper rather than left to
  be rediscovered.
- **Occurrence names and part names are genuinely distinct, and OCCT hands both
  over.** The part is `bracket`; its two occurrences are `bracket-1` and
  `bracket-2`. So the design's assumption that the two levels are separable
  holds for names, and the kernel keeps them apart: `StepInstance::name` is the
  occurrence's, `partNames` is the part's, and nothing falls back from one to
  the other. A display that wants a fallback can have one; a translation that
  performs it has destroyed the difference before anyone could see it.
- **Placements come back parent-relative, and the fixture helper said world.**
  The kernel returns each occurrence's transform relative to its parent,
  because composing needs the tree and the kernel does not keep one. The
  hand-authored fixture predicted `[..., -20, ..., 5]` for the second bracket;
  the kernel returns that with Z 0, and composing the cradle's +5 mm lift gives
  the predicted value exactly. Both forms are now in the helper, named, so a
  test can check composition instead of assuming it.
- **Two of the fixture helper's own counts were wrong** and are corrected
  against the file rather than against the reader: `nodeCount` is 4 (it said 2,
  counting only the occurrences of the part) and `groupingNodeCount` is 2 (it
  said 1, having forgotten that `carrier` is a grouping node as much as
  `cradle` is). Caught because the reader disagreed with the helper and the
  file settled it.
- **The document-leak check was vacuous, and the replacement is a new stat.**
  The first instrument was peak WASM heap across repeated imports. Removing the
  `Close` deliberately produced the *identical* heap figure - 24,248,320 both
  ways - because a few leaked small documents fit inside a heap that has
  already grown. `KernelStats::openTranslationDocuments` reports
  `TDocStd_Application::NbDocuments()` instead, and the same negative control
  now shows 0 with the close against a climb to 30 across 24 imports. An
  invariant worth having is worth being able to check; this one is checked on
  every failure path too.
- **A cyclic assembly never reaches the cycle guard.** A hand-built file closing
  `carrier -> cradle -> bracket -> carrier` parses - the census counts its 4
  NAUOs - and OCCT then transfers *nothing*: zero roots, zero free shapes, no
  error reported. So the guard in `walkOccurrence` is unexercised and is
  reported as such rather than claimed as tested; it stays because the cost is
  a `std::find` over a stack and the alternative failure is unbounded recursion
  inside a WASM module, which is undiagnosable from outside.
- **That case did expose a misleading message, which is fixed.** Both modes
  reported "STEP payload contained no transferable shape" for a file with a
  visible solid in it. A census that counted assembly occurrences against a
  reader that resolved no root is a distinguishable signature, so the message
  now says that instead - without naming a cause, because a cycle is only one
  of several defects with the same signature and OCCT reports no error for any
  of them.
- **The two modes disagreed about an empty file, and that was worse than
  cosmetic.** Flat returned EmptyResult; CAF returned TranslationFailed,
  because `STEPCAFControl_Reader::Transfer` returns false when handed nothing.
  One is a success reporting zero bodies and the other becomes a thrown error a
  layer up, for identical bytes. The root count now decides, and a file that
  declared roots and still would not transfer keeps saying so.
- **What the CAF reader is told not to read.** Layers, validation properties,
  GD&T, materials, views, metadata and SHUO are all switched off; OCCT defaults
  every one of them on. Left on, the reader would build attributes this stage
  discards and the cost would land in the reader-comparison as a cost of
  *structure*, which it is not. The dropped categories are counted off the
  entity census instead - one pass that is already being made - and are now
  four named counters rather than MVP-2's single "you lost something".
- **Cost: no TypeScript beyond keeping the boundary compilable.** `structure:
  false` had to be passed explicitly at both call sites because embind requires
  every field of a value object; the application default is group 7's to
  choose. 146 tests still pass, unchanged.

## 5. Appearance extraction (C++)

- [ ] 5.1 Read shape-level colour through `XCAFDoc_ColorTool` for each part and each component, keeping them distinct: the instance override is what makes one occurrence recolourable, and a reader that resolves it before we see it would erase the distinction. Confirm which of the two OCCT actually exposes — this is an open question in the design, and the answer belongs in the findings.
- [ ] 5.2 Read per-face colour into an array indexed by the part shape's `TopExp_Explorer(TopAbs_FACE)` order, paired with the face count it was built against. Same order as the mesher's loop at `native/src/kernel.cpp:449` — one order, documented in one place, used by both.
- [ ] 5.3 Emit face ranges from the mesher: `(indexOffset, indexCount)` per face in visitation order, alongside the existing buffers. Assert they tile the index buffer without gap or overlap and that their count equals the reported face count.
- [ ] 5.4 Cross colour to the boundary as plain triples plus ranges. No face index, no face handle, no identity — `appearance-attributes` fences this explicitly, and the fence is only real if the C++ surface has nothing to hand over.
- [ ] 5.5 Drop a part's face-colour map whenever its topology changes, in the kernel, at the point the new shape replaces the old — not by convention in a caller. Report the drop so the layer above can say which part lost what.

## 6. Export with structure (C++)

- [ ] 6.1 Add the CAF write path: build a fresh `TDocStd_Document` from the supplied structure — one shape label per body, one component per instance with its transform, names and colours set — and `STEPCAFControl_Writer` it into the existing `std::ostringstream`/staging path.
- [ ] 6.2 Refuse a structure that does not resolve: an instance naming a body outside the exported set, a cyclic parent chain, a transform that is not 12 numbers. Fail before writing a byte, naming the defect.
- [ ] 6.3 Write colours at the levels they were held, and nothing else: no resolved display colour, no fabricated colour for an uncoloured part.
- [ ] 6.4 Confirm what the writer actually emits — one part definition and N occurrences, or N duplicated parts. This is the design's second open question; measure it by re-importing our own export and counting, and by comparing the entity census against the source file.
- [ ] 6.5 Keep the flat export path exactly as it is for a session with no structure, including its byte output, so a locally authored model exports as it did before.
- [ ] 6.5a **Not anticipated (found in task 2.3).** Set the writer's assembly mode explicitly on every export. OCCT fabricates an assembly for *any* multi-body export — a root product plus one child per body with invented names — so "a flat session exports flat" is not something the current code does, and cannot be had by leaving the writer alone. A test pins the current fabrication (`tests/step-translation.test.ts`, "survives our own round trip") and will fail when this lands, which is the point.
- [ ] 6.6 Verify all of section 4-6 against the raw module before any TypeScript exists, extending the MVP-1/MVP-2 smoke harness: import the hand-authored fixture, census structure and colour, export, re-import, compare, and exercise every failure path for handle leaks and module aborts.

## 7. Kernel boundary and protocol (TypeScript)

- [ ] 7.1 Add the boundary types to `src/kernel/types.ts`: an instance record, a placement as 12 numbers, a colour triple, a per-body appearance record, face ranges on the mesh result, and the extended import report. Nothing in them references a label, an entity, or a face identity.
- [ ] 7.2 Extend `importStep`/`exportStep` in `src/kernel/kernel.ts` and the Worker protocol in `src/kernel/worker/`: structure out on import, structure in on export, as plain cloneable data. Confirm no new transferable is needed and that the single-staging-buffer invariant still holds — structure is not a byte payload.
- [ ] 7.3 Update the doc comment at `src/kernel/kernel.ts:305` that says names and colours need XCAF and are not this stage's. It is about to be wrong.
- [ ] 7.4 Add typed errors for the new refusals: unresolved instance reference, cyclic structure, malformed placement, face-colour map that does not fit its shape.
- [ ] 7.5 Instrument both directions the way MVP-2 instrumented its payloads: structure size, instance count, and CAF-versus-plain reader cost, so section 12 has numbers to publish rather than a stopwatch.
- [ ] 7.6 Test the boundary rules as rules, not just behaviours: a test that inspects the exported API surface for any face index, face handle, or label-shaped value, mirroring how `geometry-kernel`'s scenarios are written.

## 8. Document: instances, appearance, schema v3

- [ ] 8.1 Add `InstanceRef`, the instance entry, and the sparse per-body appearance map to `src/document/types.ts`, alongside `bodies` rather than replacing it. Mint instance identities the way `nextBodyOrdinal` mints body ones — persisted, never reused.
- [ ] 8.2 Bump the manifest schema version to 3 and set the read range so versions 1 and 2 still open. An absent instance tree means a flat document; write no migration pass.
- [ ] 8.3 Validate the tree on open: parents resolve, no cycles, part references within the body list, placements are 12 finite numbers, and the appearance map's face counts match the restored parts. Refuse with a reason naming the defect, and leave the session untouched — the existing refusal behaviour is the model.
- [ ] 8.4 Persist and restore names and colours, and confirm a name is never used as a key anywhere in the document layer.
- [ ] 8.5 Add the construction-record entries for an assembly import and for making an occurrence unique. Inert, like every other entry.
- [ ] 8.6 Implement `makeUnique(instance)`: a new body from the same shape, referenced by that instance alone, with the part's appearance copied and its face-colour map carried only if the shape is untouched.
- [ ] 8.7 Test the compatibility claim against documents written by the previous stages' code rather than hand-built manifests: open a v1 and a v2 document, confirm they read as flat, save, and confirm they come back as v3 with no tree.

## 9. Tessellation and viewport

- [ ] 9.1 Confirm the mesh cache already keys per body and therefore serves instances for free; add a test that twenty instances tessellate once and that adding or removing an instance invalidates nothing.
- [ ] 9.2 Carry face ranges and per-face colour through `src/kernel/types.ts` to the viewport, allocating a colour buffer only for bodies that have face colours.
- [ ] 9.3 Render one `BufferGeometry` per body and one mesh per instance sharing it, each with its composed placement. Assert the shared-buffer property directly — a test that counts geometries, not one that trusts the code path.
- [ ] 9.4 Apply the face → instance → part → default resolution at display time, and confirm nothing writes a resolved colour back.
- [ ] 9.5 Make picking resolve to an instance with the body reachable from it, and follow the compiler through every call site that assumed a pick meant a body.
- [ ] 9.6 Highlight only the clicked instance, and surface the count of instances sharing its body in the selection.

## 10. Session and UI

- [ ] 10.1 Extend `src/app/modeling-session.ts` to hold the instance tree, and replace the message at line 417 that reports names and colours as not preserved with one that reports what *was* preserved and what was dropped, by category.
- [ ] 10.2 Add the assembly tree to `src/ui/`: hierarchy, names, colours, instance counts. Names render as text and never as markup; truncation is display-only.
- [ ] 10.3 Refuse an edit on a shared body with an explicit choice — edit the body for all instances, or make this occurrence unique — and perform neither until told. This is the one interaction instancing forces, and guessing is the failure mode.
- [ ] 10.4 Report the outcome of a structural edit plainly: which bodies changed, how many instances that affected, and what appearance data was dropped as a result.
- [ ] 10.5 Wire export to send the session's structure, and confirm a flat session still exports flat.

## 11. CI and the fixture path

- [ ] 11.1 Add the pinned third-party fixture to the CI fetch step and confirm the run exercises it rather than skipping. MVP-2's fixture hole was exactly this shape: green on a leg that proved nothing.
- [ ] 11.2 Confirm the browser verification covers an assembly on both backends, and that it reports the fixture as not exercised rather than passing when the pin is unavailable.
- [ ] 11.3 Re-run `npm run verify:dist` — a new fixture and a new UI panel both touch the build.

## 12. Measure, then publish

- [ ] 12.1 Instanced versus flattened, as a ratio, on the third-party assembly: checkpoint bytes, mesh count, tessellation time, and peak WASM memory. Flatten deliberately for the comparison rather than estimating it.
- [ ] 12.2 Structure and colour fidelity across the full cycle — import, checkpoint, restore, edit, export, re-import — reported as a census the way MVP-2 reported geometry fidelity, including what each leg lost.
- [ ] 12.3 CAF reader versus plain reader on the same file: time, memory, and what the plain reader does not return.
- [ ] 12.4 Per-face colour survival across a checkpoint, and the face-order finding from task 1.2 written up with its evidence.
- [ ] 12.5 `npm run kernel:size` again: the delta from actually reaching the XCAF toolkits, raw and brotli, against the 1.1 baseline.
- [ ] 12.6 Write `docs/MVP-3-FINDINGS.md`. Name what was not exercised — a missing third-party fixture, the 10/100/500 MB question still open, per-face colour after an edit — rather than extrapolating, and read ratios rather than absolute milliseconds given this box's ~1.8× run-to-run variance.
- [ ] 12.7 Update `README.md`'s roadmap row and the paragraph at lines 45-46 that says structure, names, and colours are not preserved; update `docs/BUILD.md` with the new fixture instructions.
- [ ] 12.8 Sync the delta specs into `openspec/specs/` and archive the change.
