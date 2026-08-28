## Why

Every body in this system is born here. There is no way to open a `.step` file
from another CAD system, and no way to hand one back — which makes the tool a
closed world, and leaves the note's first-priority interchange format (§11)
entirely unexercised. MVP-1 answered what restart recovery costs; the question
this stage exists to answer is the one the note names as the next experiment
worth running (§14): **what does a STEP round trip cost, and what does it lose?**

Now, because the pieces it needs are all in place and measured — a kernel in a
Worker with a byte-payload path in both directions, a document that survives a
restart, and Booleans that produce exact geometry. A round trip is the first
workflow that puts all three under one operation, and the first that can be
checked against geometry this project did not author.

## What Changes

- Add **STEP import** to the kernel facade: caller-supplied `.step` bytes become
  registered bodies inside WASM. This is an explicit translation transaction
  (§5) — read, transfer, unit handling, validation — and it ends at handles.
  Nothing about STEP entities reaches JavaScript.
- Add **STEP export**: the current canonical B-Rep of a selected set of bodies is
  written to STEP bytes and returned. What is exported is the *current* geometry,
  so a body edited in the browser exports with the edit in it (§5).
- Link OCCT's **DataExchange toolkits**, which MVP-0 deliberately left out.
  `TKDESTEP` declares `TKXCAF`, `TKCAF`, `TKLCAF`, `TKCDF`, `TKShHealing`,
  `TKXSBase`, and `TKDE` among its dependencies, so STEP brings the whole
  XCAF/OCAF stack in whether this stage uses it or not — MVP-3's toolkits arrive
  early as a side effect. The `.wasm` is 6.9 MB today; what that becomes is a
  shipping cost this stage has to report, not discover later.
- Represent an imported body as an **`ImportedBody` base feature** in the
  document, carrying the source filename and the units the file declared. No
  parametric history is invented for it (§6, §11). The construction record gains
  one inert import entry, consistent with how MVP-1 records operations it never
  replays.
- **Resolve units at the boundary and record both.** OCCT's reader converts a
  file's declared unit into the working unit as part of the transfer, so the
  conversion happens once, where translation already lives, and the document keeps
  a single working unit. The file's own declared unit becomes provenance on the
  import. The manifest's `units` field has existed since MVP-1 so an import would
  have something to disagree with (`src/document/types.ts:101`); the answer turns
  out to be that it should not disagree, and why is worth writing down.
- **Make shape processing explicit, and measure it.** OCCT 8.0 does not translate
  STEP untouched: the reader runs `FixShape` and the writer runs
  `SplitCommonVertex` and `DirectFaces` by default. A repair pass is
  indistinguishable in the result from a fidelity loss, so the comparison runs
  **both with processing and without**, the difference is attributed, and the
  application's default is chosen on that evidence instead of inherited.
- Allow **Boolean edits on imported bodies** with no new kernel operation: an
  imported body is an ordinary body, usable as either Boolean operand, and the
  result exports. Fillet is *not* added — selecting an edge to fillet mints
  exactly the positional edge reference the roadmap defers to MVP-4 (§7).
- Add the **browser file path**: choose a `.step` file to import, and receive an
  export as a download. Translation of a multi-megabyte file must not freeze the
  viewport, which means the bytes go to the Worker and the reporting comes back.
- **Refuse what cannot be translated, without losing the session.** A file that
  is not STEP, is truncated, or yields no usable shape fails with a reason and
  leaves the open document intact — matching how MVP-1 refuses a document it
  cannot trust.
- Measure the round trip end to end and publish `docs/MVP-2-FINDINGS.md`: import,
  tessellate, checkpoint, restore, one Boolean, export — with wall-clock time,
  peak WASM memory, byte sizes at each stage, and a **fidelity comparison**
  (topology census, volume, area, bounding box, surface types) across import,
  restore, and re-import of our own export.

**What this stage will not claim.** Fidelity is measured against OCCT's own test
data — `screw.step` at 87 kB and `linkrods.step` at 1.8 MB — which is what is
available locally, and both live under a gitignored `third_party/occt/`. The
note's open question about 10 MB, 100 MB, and 500 MB models (§12) is therefore
**reported unanswered rather than extrapolated**, the way MVP-1 bounded its own
458 kB-to-10,000-face extrapolation. Assembly structure, part names, and colours
are read only far enough to say what was dropped; preserving them is MVP-3's
capability via XCAF, and a compound imports as flattened bodies until then.

## Capabilities

### New Capabilities
- `step-translation`: the STEP boundary inside the kernel — bytes to bodies and
  bodies to bytes, unit handling, validation of what arrives, which STEP
  semantics are dropped rather than silently mangled, failure modes that keep the
  kernel usable, and the guarantee that an imported body is an ordinary body.
- `file-exchange`: the browser end of that boundary — selecting a file to import,
  delivering an export as a download, and reporting size, progress, and failure
  without blocking the main thread or the viewport.

### Modified Capabilities
- `geometry-kernel`: its handle-API requirement names serialization as **the
  single deliberate exception** to non-handle payloads, and defends it on the
  grounds that "the caller cannot construct one." STEP bytes are a second
  payload class and the caller *can* construct them — they come from a user's
  disk. The requirement must admit a **foreign** payload explicitly, with the
  opacity rule intact in the outbound direction, rather than be quietly violated.
- `kernel-worker`: the protocol has carried caller-supplied bytes inbound only
  for restoring a payload the kernel itself wrote. It must now carry untrusted
  foreign bytes in and translated bytes out, under the existing single-staging-
  buffer invariant (`native/src/kernel.cpp:59-63`), which assumed one payload in
  flight because a document is checkpointed as a whole.
- `native-document`: bodies acquire a **source** — authored here or imported from
  a named file — and units become a property read from an import rather than a
  constant. Saving a document containing imported bodies, and reopening it, must
  preserve both.

## Impact

- `native/CMakeLists.txt` — DataExchange toolkit linkage, and the module-size
  consequence measured against today's 6.9 MB `.wasm`.
- `native/src/kernel.cpp`, `native/src/bindings.cpp` — `importStep` and
  `exportStep` over the existing staging buffer; imported shapes exercise
  `registerSolid`'s validity gate with geometry it has never seen, since real
  STEP yields shells and compounds as well as closed solids.
- `src/kernel/` — kernel API, typed errors for translation failure, protocol
  messages, and instrumentation entries for two new payload directions.
- `src/document/` — body source and units in the manifest and construction
  record, and a schema-version bump for both.
- `src/app/`, `src/main.ts`, `src/ui/` — import and export in the session and UI.
- `tests/`, `tests/browser/` — translation conformance and the fidelity
  comparison, against fixtures under a gitignored `third_party/occt/data/step/`,
  which the test setup has to locate or skip explicitly rather than fail on.
- `docs/MVP-2-FINDINGS.md`, `README.md` — the findings, and the roadmap row.
