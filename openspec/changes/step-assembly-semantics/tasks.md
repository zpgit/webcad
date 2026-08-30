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

- [ ] 2.1 Hand-author `tests/fixtures/assembly.step` — AP214, committed, minimal and asserted against exactly: two instances of one part with different placements (one of them mirrored, to exercise the no-decomposition rule), one grouping node with no shape of its own, a part-level `COLOUR_RGB`, an instance-level colour override, and one face colour. Keep it small enough to read in full.
- [ ] 2.2 Write down what the file contains, in the fixture helper next to it, as counts a test can assert: parts, instances, depth, named entities, coloured faces. A hand-authored fixture whose contents are described only by the file itself is a test that asserts what it happens to parse.
- [ ] 2.3 Verify the hand-authored file is actually valid STEP that a foreign reader accepts, not just one ours does — otherwise it proves nothing about the reader either. If no third-party reader is available, say so here and treat the file as an assertion vehicle only.
- [ ] 2.4 Find a third-party STEP assembly with colours, permissively licensed, small enough to fetch in CI. Record the licence and the source alongside the pin. If none can be found, stop and record that: the interoperability claim is then reported as not exercised, and `assembly-structure`'s measurement requirement already says so.
- [ ] 2.5 Extend `scripts/fetch-step-fixtures.sh` to a second pinned source: it currently derives one raw base from `WEBCAD_OCCT_REPO` and the pinned tag, so generalize the fixture table to carry a URL per entry rather than a shared base, keeping the sha256 check and the hard failure on mismatch.
- [ ] 2.6 Teach `tests/helpers/step-fixtures.ts` about both new fixtures — the committed one always present, the pinned one skipping loudly when absent — and correct the comment block that now describes only OCCT's two single-part files.
- [ ] 2.7 Add the new fixture to `tests/browser/step-measurements.ts`'s fixture list and to the CI fetch step's expectations, so the browser measurement covers an assembly rather than two single parts.

## 3. The parts-to-sections rename, on its own

Mechanical, byte-contract-neutral, and landed before the schema work so its diff
stays reviewable and the word "part" means one thing for the rest of the stage.

- [ ] 3.1 Rename `PART_NAMES` → `SECTION_NAMES`, `PartName` → `SectionName`, `DocumentParts` → `DocumentSections` in `src/document/types.ts`, and follow the compiler through `src/document/document.ts`, `src/storage/{types,indexeddb,opfs}.ts`, and the three test files that use them. The stored names — `manifest.json`, `features.json`, `geometry.brep` — do not change.
- [ ] 3.2 Update the prose that used the old word: the doc comment at `src/document/types.ts:38-46`, and any comment in `src/storage/` that calls a section a part.
- [ ] 3.3 Prove the rename changed no bytes: the storage conformance round trip already asserts byte-identical sections, so run `npm run verify:storage` and confirm a document written before the rename still opens.

## 4. Structure-aware import (C++)

- [ ] 4.1 Add the CAF read path to `native/src/kernel.{hpp,cpp}`: `STEPCAFControl_Reader` over the same staging-buffer `std::istringstream` the current reader uses, transferring into a `TDocStd_Document` created inside the call. Keep the existing plain-reader path reachable — `step-translation` now requires that a flat import remains a supported mode, not a degenerate assembly.
- [ ] 4.2 Walk the resulting `XCAFDoc_ShapeTool` and produce two things: one registered body per distinct part shape, and a flat list of instance records (parent index, part index or none, 12-double transform, name). Free shapes with no structure yield bodies and no instances.
- [ ] 4.3 Register each part exactly once. A part referenced by twenty components must produce one `BodyId` — dedupe on the shape the shape-tool reports for the part label, not on the located instance shape, which differs per occurrence.
- [ ] 4.4 Release the `TDocStd_Document` before the call returns, on every path including failure, and assert in the harness that no label or document reference is reachable from the result.
- [ ] 4.5 Report structure counts: instances, tree depth, named entities preserved, grouping nodes, and — still — the categories dropped, now named individually rather than as one number.
- [ ] 4.6 Handle the failure paths the CAF reader adds without weakening the ones MVP-2 established: a file whose structure is cyclic or whose component references do not resolve, a part label with no shape, and a structure that transfers while the geometry does not. All through the existing `guarded`/`fail` machinery, all leaving the module usable.

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
