## Context

MVP-0 established the kernel boundary; the Worker move took the kernel off the
main thread and measured what that boundary costs
(`docs/MVP-1-WORKER-FINDINGS.md`). Neither produced a byte that outlives a page
load. `ModelingSession` owns handle lifetime and says so plainly: reloading
discards all modeling state (`src/app/modeling-session.ts:20-23`).

What exists to build on:

- A handle-based kernel facade where geometry never crosses into JavaScript
  (`native/src/bindings.cpp:1-7`). Bodies are `uint32` handles minted by a
  Worker-side registry.
- A correlated request/response protocol over `postMessage`, with mesh crossing
  as transferred `ArrayBuffer`s — outbound only
  (`src/kernel/worker/protocol.ts:66-76`).
- A measurement culture the earlier stages set: the architecture note's open
  questions get answered with numbers, and options stay open until measurement
  closes them.

Constraints that shape everything below. The container is a container: the note
is explicit that the document format holds a B-Rep serialization as one payload
among several, and must not become a wrapper around one kernel's file format
(note §3–4). Handles are session-scoped: a `BodyId` is an index into a live
registry and means nothing after the Worker dies. And section 7 stands — no
positional face or edge references, which rules out any identity scheme finer
than a body at this stage.

## Goals / Non-Goals

**Goals:**

- Save a document and reopen it after a browser restart, with exact geometry
  restored — the same solid, not a mesh of it.
- Produce the numbers MVP-1 exists for: serialize/deserialize throughput,
  save/open latency per storage backend, and end-to-end recovery time with
  kernel startup separated out from document work.
- Answer the note's IndexedDB-versus-OPFS question (§12) with a measurement and
  a decision, not a preference.
- Lay a container that MVP-2 can add a STEP-derived body to and MVP-4 can add
  real features to, without redefining the format.

**Non-Goals:**

- Any recompute. The construction record is written and read; it is never
  executed. Replay needs stable references to faces and edges, which is MVP-4's
  entire subject.
- A downloadable single-file `.webcad`. The part layout must not *prevent* it,
  and nothing here implements it.
- Autosave, undo/redo, versions, or two tabs editing one document.
- Persisting the tessellation cache. Mesh is not the source of truth, and
  re-tessellating on open is a real part of what recovery costs — hiding it
  behind a cached mesh would flatter the measurement this stage exists to take.

## Decisions

### One compound per document, not one stream per body

The checkpoint is a single `TopoDS_Compound` holding every live body as a direct
child, serialized once. Restore iterates the compound's direct children with
`TopoDS_Iterator` — which preserves insertion order — and registers each as a
new body.

*Why:* shared underlying geometry is written once rather than per body, and
there is one stream to version, checksum, and measure instead of N. It also
matches how a future STEP or XCAF payload will arrive: as one document-shaped
thing.

*Alternative — a `.brep` part per body:* the index-to-identity mapping becomes
trivial and a single corrupt body does not condemn the document. Rejected
because it multiplies per-stream overhead across exactly the case MVP-2 cares
about (many bodies from one import) and gives the container N geometry parts to
version instead of one.

*Consequence:* the mapping from compound child position to document body identity
is load-bearing, so it is written down explicitly in the manifest rather than
left implicit in iteration order. If the two disagree on open, the document is
refused.

### Binary OCCT serialization, with the encoding named in the manifest

`BinTools` (binary) rather than `BRepTools` (ASCII), with the manifest recording
`geometryFormat` so a reader never has to sniff. Both live in OCCT's shape
serialization and, as far as the current link list shows, in `TKBRep` — already
linked (`native/CMakeLists.txt:39-50`). **This must be verified at build time,
not assumed**: if the toolkit split in OCCT 8.0 puts them elsewhere, the link
list gains an entry and the payload grows, which `measurements/payload.json`
will show.

*Why binary:* smaller and faster to parse, and the size of the checkpoint is one
of the numbers this stage reports. ASCII's advantage is diffability, which
matters to a developer reading a file and not to a browser reading an
IndexedDB record.

*Trade-off:* ASCII `.brep` is the more human-inspectable artifact when something
goes wrong. Mitigated by keeping the encoding a manifest field, so writing ASCII
is a one-line change and a reader handles both.

### Bytes cross as opaque, kernel-owned payloads

Serialization returns a `Uint8Array` the caller owns and transfers; deserialize
takes one back. This is the first inbound transfer the protocol has carried.

The rule this stretches — geometry never crosses the boundary — survives with a
sharpened statement: what crosses is *opaque bytes JavaScript may store and hand
back but must never interpret*. The distinction is real and worth holding. A
`TopoDS_Shape` materialized in JavaScript would mean a second geometry
representation to keep in sync; a byte blob is a payload the document layer
routes without understanding. The moment any JavaScript parses those bytes, this
decision has been violated.

*Alternative — have the Worker write straight to storage:* fewer copies, and
OPFS sync access handles are worker-only. Rejected for now: it puts document
semantics inside the kernel Worker, which is the one place that should know only
geometry. See the next decision.

### Storage runs on the main thread, and the probe checks whether that was a mistake

The store is main-thread code. The kernel Worker stays single-purpose.

The obvious objection: MVP-1's first half exists because long main-thread work
freezes the UI, and this puts a potentially multi-megabyte write back on the
main thread. The answer is that storage work is asynchronous I/O rather than a
single atomic C++ call — the structured clone into IndexedDB is the only real
main-thread cost, and its size is measurable. So this is a decision *pending
measurement*, exactly as shared memory was: the responsiveness probe runs during
save and open, and if a save stalls the main thread beyond a frame, moving
storage into a Worker becomes its own change with a number attached.

This also interacts with the backend question. OPFS's fastest path
(`createSyncAccessHandle`) is Worker-only, so if OPFS wins on throughput but only
from a Worker, that is a finding about *both* decisions and should be reported
as one.

### Atomicity is a store requirement; torn documents are also detectable

A save must not be able to leave a document that opens into wrong geometry.
Two mechanisms, deliberately overlapping:

1. **Per-backend atomicity.** IndexedDB gets it for free: all parts of one
   document are written in a single `readwrite` transaction, which either
   commits or does not. OPFS writes the new parts into a temporary directory and
   swaps it in as the final step, so an interrupted save leaves the previous
   document intact.
2. **Detection as a backstop.** The manifest records the geometry payload's byte
   length and a checksum. On open, a mismatch refuses the document rather than
   handing OCCT a truncated stream. This is backend-independent, and it is what
   catches the failure the first mechanism did not anticipate — including a
   storage layer that lies about durability.

*Why both:* the checkpoint is the only path back to a user's geometry. The cost
of the second mechanism is a hash over the payload on save and open, which is
itself a number worth having.

### Document body identity is a document-scoped counter, not a UUID

Bodies get identities like `b1`, `b2`, minted by the document and never reused
within it. The manifest maps compound child index to identity; the construction
record refers to bodies by identity. On open, each restored child is registered
with the kernel and the resulting fresh `BodyId` is bound to its identity.

*Why a counter:* deterministic, so a saved document is byte-stable across runs
and a test can assert its content rather than its shape. `crypto.randomUUID()`
would be necessary if documents were ever merged or bodies moved between them;
neither exists, and inventing global identity now would be speculative.

*Scope, stated so it is not over-read:* this is identity for a **body**. It says
nothing about a face or an edge, mints no reference to one, and is not a step
toward persistent naming. MVP-4 still faces section 7's problem whole.

### The construction record is metadata, and is not the kernel's operation log

`features.json` holds an ordered record of what produced each body:
`createBox` with its parameters, a Boolean with its operand identities and the
identity it produced. It is written, read back, and displayable. It is never
executed, and nothing on open reads geometry from it.

Two things this is not, both worth stating because the names collide. It is not
`Kernel.operationLog` (`src/kernel/types.ts:132-154`), which is per-operation
timing for the measurement readout and is session-scoped telemetry. And it is
not a feature graph: there is no dependency evaluation, no parameter editing,
and no notion of a stale node.

*Why record it at all, given nothing reads it for geometry:* the container's
shape is the deliverable as much as the geometry is. MVP-2 imports a body and
needs somewhere to say "this came from a STEP file rather than a primitive";
MVP-4 needs somewhere for real features. Establishing the part now — with
honest, inert content — is cheaper than adding a part to a shipped format later.
The risk is that inert data drifts out of correctness because nothing validates
it, which is why the round-trip test asserts the record reads back intact rather
than merely parses.

### Container parts are named, not packed

A document is `{ manifest, features, geometry }` — named parts handed to a store
that decides how to keep them. IndexedDB stores one record with three fields;
OPFS stores a directory with three files.

*Why not pack into one blob now:* packing is a serialization decision that
belongs to the file-export story, and choosing a container format (zip, tar, a
custom TLV) before there is a file to export would be picking for reasons that
do not exist yet. Named parts keep that door open: packing later is a function
from parts to bytes, not a format change.

### Version fields: refuse a schema we cannot read, report a kernel that differs

`schemaVersion` is an integer, `1` for now, and a build refuses any value it has
no reader for — no best-effort parsing of a future document. `occtVersion` and
`geometryFormat` are recorded and *not* used to refuse. OCCT reads its own older
shape streams, and refusing on a version difference would strand every document
on the build that wrote it, which is the opposite of what the note's migration
question wants (§12).

A difference is surfaced rather than swallowed, so that if a future OCCT upgrade
does break a stream, the failure is attributable instead of mysterious. This is
the whole of MVP-0's recommendation to record `kernelVersion` from the outset
(`docs/MVP-0-FINDINGS.md:191-193`); designing the migration itself is not in
scope.

### Units are declared and not converted

The manifest records `units: "mm"`. The kernel is unitless — MVP-0 numbers are
bare doubles — and nothing in this change converts anything. The field exists so
a document is not silently unit-ambiguous, and so STEP import in MVP-2 has a
field to disagree with rather than a convention to discover.

### Recovery is measured with startup separated out

The headline number MVP-1 owes is "how long from opening the tab to seeing your
model". That number is dominated by fetching and instantiating a 6.8 MB WASM
module, which is the previous stage's cost, not this one's. The measurement
therefore reports the phases separately — kernel ready, document read,
deserialize, tessellate, first frame — and the total. Reporting only the total
would make the document layer look expensive; reporting only the document phases
would misrepresent what a user waits for.

## Risks / Trade-offs

- **A serialization bug is data loss, not a wrong pixel.** → Round-trip tests
  assert exactness — volume to tolerance, face/edge/vertex counts, analytic
  surface types preserved (a cylinder must come back a `GeomAbs_Cylinder`, the
  same property MVP-0 used to prove Booleans keep exact geometry) — rather than
  asserting that bytes were produced.
- **An interrupted save could strand a user between two documents.** → Atomicity
  per backend plus checksum detection on open, above. Explicitly tested by
  aborting a save mid-write.
- **Main-thread storage may stall the UI, undoing the Worker move for the save
  path.** → Measured by the same responsiveness probe the Worker change
  introduced, run during save and open. A stall over a frame budget is a
  finding, and moving storage into a Worker is the follow-up.
- **`BinTools` may not be in an already-linked toolkit.** → Discovered at build
  time, costs a CMake entry and some payload. `measurements/payload.json` is the
  guard, and the finding is reported either way since MVP-0 predicted growth
  would come from `DataExchange` in MVP-2 and a surprise here is worth knowing.
- **Two storage backends is real duplicated work for a question that could be
  settled by reading documentation.** → Accepted deliberately. The note poses it
  as an open question, both implementations sit behind one interface and one
  conformance suite, and the losing backend is deleted or demoted once the
  numbers exist. The cost is bounded; an unmeasured guess baked into the
  persistence layer is not.
- **Inert metadata rots.** The construction record has no consumer that would
  notice it being wrong. → The round-trip test asserts it reads back intact, and
  it is surfaced in the UI so a human sees it. Neither is as good as a real
  consumer, which arrives in MVP-4.
- **OPFS `move()` support and quota behavior vary by browser.** → Verification
  runs Chrome, so this change proves Chrome. Any browser-support claim beyond
  that is unmeasured and should not be made in the findings.
