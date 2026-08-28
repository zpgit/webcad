## Context

MVP-1 left a system that can model, save, and recover, and that has never read a
byte of geometry it did not author. This stage adds the two translation
directions and measures what they cost and lose. The pieces it builds on are all
in place and instrumented: a facade in `native/src/kernel.cpp` that owns every
`TopoDS_Shape`, a Worker protocol that moves byte payloads in both directions
with transfer semantics, a document that records provenance and survives a
restart, and Booleans that produce exact geometry.

Four constraints shape everything below.

**The kernel facade is the only code that touches B-Rep.** Translation is
therefore C++ inside the Worker, and its result crosses out as handles. Nothing
about STEP — entities, product structure, attribute records — may become a
JavaScript object.

**One binary payload crosses the boundary at a time.** The single staging buffer
(`native/src/kernel.cpp:59-63`) was justified by a document being checkpointed as
a whole. Import and export are also whole-payload operations, so the invariant
survives; what changes is that it now has to be enforced against a second class
of caller rather than assumed from usage.

**OCCT does not translate STEP untouched.** Verified in the 8.0.1 source rather
than assumed: `STEPControl_Reader::GetDefaultShapeProcessFlags` sets
`ShapeProcess::Operation::FixShape`, and `STEPControl_Controller` configures the
write actor with `SplitCommonVertex` and `DirectFaces`
(`STEPControl_Controller.cxx:348-353`). Both directions modify shapes by default.
This is the single most consequential fact for a stage measuring fidelity.

**OCCT normalizes units on transfer.** `STEPControl_ActorRead` sets the model's
local length unit from `UnitsMethods::GetCasCadeLengthUnit()` and transfers
against it (`STEPControl_ActorRead.cxx:376-379`), while
`STEPControl_Reader::findUnits` reads what the file actually declared. So the
declared unit is retrievable and the conversion is unavoidable without fighting
the library.

Fixtures are OCCT's own test data: `third_party/occt/data/step/screw.step`
(87 kB) and `linkrods.step` (1.8 MB). Both sit under a gitignored path, which
constrains how tests may depend on them.

## Goals / Non-Goals

**Goals:**

- STEP bytes become registered bodies, and live bodies become STEP bytes, both
  inside the Worker, both instrumented on the same terms as every other
  operation.
- An imported body is an ordinary body — Boolean operand, tessellatable,
  checkpointable, exportable — with provenance recorded and no invented history.
- A fidelity account of the full round trip that separates what translation
  changes from what shape processing changes, and says which is which.
- The browser path end to end: choose a file, see it, edit it, download it, with
  the main thread responsive throughout.
- An honest statement of what was dropped — assembly structure, names, colours —
  and what was not measured.

**Non-Goals:**

- **XCAF document semantics.** MVP-3's. Assemblies flatten. The toolkits arrive
  early as a linkage side effect, but no `TDocStd_Document` is created.
- **Fillet or any face/edge-selected operation.** Choosing an edge to fillet mints
  the positional sub-entity reference §7 rules out and MVP-4 owns. Boolean is
  the edit.
- **A healing capability.** Shape processing is exposed and measured because OCCT
  runs it anyway; a caller-invoked repair operation is not built.
- **The 10 MB / 100 MB / 500 MB question (§12).** No fixture at that scale is
  available locally. Reported unanswered, not extrapolated.
- **GLB/glTF or STL.** Named in §11 as later interchange; STEP is first priority
  and the only format here.
- **Revisiting mesh persistence.** MVP-1 measured re-tessellation at 171 ms of a
  584 ms recovery and left the trade to be made knowingly. Import makes that cost
  larger, and the honest first move is to measure it at STEP scale in this stage
  and decide afterwards, not to change the design and the measurement together.

## Decisions

### Read and write through streams, not a virtual filesystem

`XSControl_Reader::ReadStream(name, std::istream&)` and
`STEPControl_Writer::WriteStream(std::ostream&)` both exist in 8.0.1. Import
wraps the staging bytes in an `std::istringstream`; export writes into an
`std::ostringstream` and copies into staging.

*Alternative considered:* write the payload into Emscripten's MEMFS and call
`ReadFile`. Rejected — it adds a filesystem dependency to the module, doubles
peak memory for the payload at exactly the size where memory is the constraint,
and introduces a path namespace that has to be cleaned up on failure. The stream
API costs nothing and keeps `-sFORCE_FILESYSTEM` out of the build.

### `STEPControl_Reader`/`Writer`, not the CAF variants

Plain shape translation. `STEPCAFControl_Reader` would give names, colours, and
assembly structure — and an XCAF document to hold them, which is a data model
this stage has nowhere to put and MVP-3 exists to design.

*Consequence to handle:* the specs require reporting that names and colours were
*present* and dropped. That is still answerable without XCAF: after
`ReadStream`, the loaded `Interface_InterfaceModel` can be scanned and its
entity types counted, so the report is "the file carried N styled items and M
named products, none preserved". Counts cross the boundary; entities do not.

### Shape processing off by default, chosen by measurement

Import and export both disable OCCT's default processing via
`SetShapeProcessFlags` with empty flags, and expose it as a caller-controlled
option. The fidelity comparison runs both ways.

*Why off as the starting point:* with `FixShape` on, a difference between the file
and the body has two possible causes and no way to tell them apart, which makes
the stage's primary deliverable unattributable. Off first, then on, then the
difference is the healer's contribution — measured, not argued.

*Why this is a decision and not a conclusion:* real STEP frequently needs those
fixes, and a shipped default of "off" may import files that other CAD tools open
fine. So the application's default is deliberately deferred to the evidence, the
way MVP-1 deferred IndexedDB versus OPFS. If processing turns out to matter for
either fixture, the app ships with it on and the findings say so.

*Alternative considered:* leave OCCT's defaults alone and report fidelity as a
single combined number. Rejected — it is the cheaper implementation and the
useless measurement.

### Units convert at the boundary, exactly once

Import lets OCCT convert into the working unit, reads the file's declared unit
via the reader's unit inspection, and reports both. The document keeps one
working unit; the file's unit becomes provenance on the import entry.

*Alternative considered:* set the model's local length unit to the file's
declared unit so coordinates arrive unscaled, preserving the file's literal
numbers. Rejected — it makes the working unit a per-document variable, which
every downstream operation, the viewport's camera framing, and the export would
then have to know about. That is precisely the leak §11 forbids: translation is a
boundary concern. MVP-1's manifest field was written expecting an import to
disagree with it; the useful finding is that it should not, and the reason.

### Imported non-solids are registered, with the truth attached

`registerSolid` currently refuses anything that is not a valid closed solid, and
that gate has only ever seen primitives and Boolean results. Real STEP yields
shells and solids that fail `BRepCheck`. Import registers them anyway and reports
`isValid` and `isClosed` as they are, flagging them in the result.

*Alternative considered:* refuse a file containing any invalid shape. Rejected —
it would likely reject real files wholesale and turn a fidelity finding into an
import failure, which reports nothing. The existing typed-error path already
handles the downstream case: a Boolean on an invalid body fails on its own terms,
visibly, rather than the invalidity being hidden at import.

### Fidelity is measured as a census, using instrumentation that already exists

`bodyInfo` already reports face, edge, vertex, and solid counts, volume, area,
bounding box, validity, and closedness; `faceTypeSummary` reports surface types.
That is the full comparison vector, so **no new inspection capability is needed** —
a satisfying result, and worth stating because the obvious plan would have added
one. Fidelity is compared at four points: after import, after checkpoint
restore, after the Boolean, and after re-importing our own export.

The re-import comparison is the load-bearing one. It is the only check that
closes the loop, and it is self-referential — it measures our writer against our
reader, not against another CAD system, which is a limit the findings must state
plainly rather than let "round-trip fidelity" imply more than was tested.

### Fixtures are located at run time, and a missing fixture skips loudly

`third_party/occt/` is gitignored, so the fidelity suite cannot assume its
fixtures exist. It resolves them at run time and, when they are absent, reports
skipped-for-missing-fixture rather than failing. A silent pass is not acceptable:
the suite must distinguish "ran and agreed" from "did not run".

*Alternative considered:* vendor a small STEP file into the repo. Attractive for
CI, and worth doing later, but authoring our own fixture with our own writer
would make the interop test self-referential from the start.

## Risks / Trade-offs

**The `.wasm` grows past what a browser should download.** `TKDESTEP` pulls
`TKXCAF`, `TKCAF`, `TKLCAF`, `TKCDF`, `TKShHealing`, `TKXSBase`, and `TKDE`
(verified in its `EXTERNLIB.cmake`), and STEP's generated entity classes are
numerous. From 6.9 MB, a doubling would not be surprising. → Measure it as a
first task, before anything is built on top, so the number informs the stage
rather than surprising it. If it is unacceptable, the fallback is a separately
loaded translation module — but that is a real architectural change and it needs
the number first, not a guess.

**Translation exhausts WASM memory on the 1.8 MB fixture.** STEP's in-memory
entity graph is far larger than its text, and the module's memory grows but never
shrinks. → Peak memory is already retrievable per session and is required in the
findings. If the larger fixture cannot be translated, that is a genuine result for
§12's question and is reported as one.

**Shape processing disabled produces geometry that fails downstream.** An unhealed
import may refuse to Boolean or tessellate. → Expected, and the reason both
settings are measured. The application ships whichever the evidence supports.

**`SplitCommonVertex` and `DirectFaces` on export make a round trip look lossy
even when it is not.** → Both directions' processing is reported per translation,
so the writer's contribution is separable from the reader's.

**The fidelity claim is self-referential.** Our writer is validated by our
reader. A file both accept could still be rejected by another CAD system. → State
it as a limit, and keep the source-file comparison — the `screw.step` and
`linkrods.step` censuses against a third-party file are the part that is not
self-referential.

**A large payload stalls the main thread despite the Worker.** Reading a
multi-megabyte `File` and transferring it is main-thread work. → Transfer rather
than clone, and assert the frame budget in the browser suite the way MVP-1 did
for restore.

**Timings on this box vary by up to ~1.8× between runs** (`docs/BUILD.md` and
prior findings). → Report ratios and orderings; do not re-derive conclusions from
a single quiet run.

## Migration Plan

The container gains a body-source record and an import entry in the construction
record, so `schemaVersion` increments. MVP-1 already specified that an unknown
`schemaVersion` is refused with a clear reason, and that path is what protects a
user's existing documents. Documents written by MVP-1 must still open: the new
fields are absent, and a body with no recorded source reads as authored here.
That backward read is a task, not an assumption.

There is no rollback concern beyond the module size. If the `.wasm` growth turns
out to be unacceptable, the geometry, document, and app layers built here are
unaffected by moving translation into a lazily loaded module later.

## Open Questions

- **What does the application default to for shape processing?** Deliberately
  unanswered until the comparison runs. The stage is not complete until it is
  answered and recorded.
- **Does the 1.8 MB fixture translate inside the module's memory ceiling?** Not
  known. If it does not, that is the stage's most important finding.
- **Should a small STEP fixture be vendored for CI?** Deferred. It trades an
  independent fixture for a repeatable one, and the answer is clearer once the
  gitignored fixtures have actually been measured against.
- **Does re-tessellation at STEP scale change MVP-1's mesh-persistence trade?**
  Measured here, decided later — deliberately not both at once.
