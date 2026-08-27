## Why

Reloading the page destroys every body on screen. That is MVP-0's accepted
limitation, stated in the code that owns the handles
(`src/app/modeling-session.ts:20-23`), and removing it is what MVP-1 exists for:
*save a native document plus a `.brep` checkpoint, and find out what recovery
after a browser restart actually costs*. Nothing is persisted today — not the
geometry, not the operations that produced it, not even which document was open.

The Worker half of MVP-1 is done and measured
(`docs/MVP-1-WORKER-FINDINGS.md`), which is what MVP-0 said had to happen
first so the document layer would be designed against a measured boundary
rather than an unmeasured one (`docs/MVP-0-FINDINGS.md:186-190`). This change is
the other half.

Two open questions from the architecture note are in scope because this stage is
the first that can answer them with numbers rather than opinion: serialize and
deserialize throughput for exact B-Rep in the browser, and whether IndexedDB or
OPFS is the better home for checkpoints (note §12). A third — untying documents
from a specific OCCT build — is not solved here, but the manifest starts
recording what a future migration would need, as MVP-0 recommended
(`docs/MVP-0-FINDINGS.md:191-193`).

## What Changes

- Add **kernel-side B-Rep serialization**: a body becomes OCCT-native bytes, and
  those bytes become a body again. Handles go in and out; exact geometry never
  materializes in JavaScript. Byte payloads cross the Worker boundary as owned
  transferable buffers in *both* directions — the protocol has only ever
  transferred outbound.
- Introduce the **`.webcad` container**: a versioned set of named parts —
  `manifest.json` (schemaVersion, units, kernel and schema provenance),
  `features.json` (the operation log), `geometry.brep` (the exact checkpoint) —
  matching the structure the note recommends (§4). The container is a container:
  it knows part names, versions, and integrity, not what OCCT put in the
  geometry payload.
- Give documents their **own body identity**, minted by the document and stable
  across save and open, mapped to freshly issued `BodyId`s on restore. Worker
  handles are session-scoped integers and cannot be persisted as-is. This is
  body-level identity only — it mints no reference to a face or an edge, which
  section 7 of the note rules out and MVP-4 owns.
- Record the **operation log** that produced each body — `createBox`,
  `createCylinder`, and Boolean operations with their parameters and operands —
  as inert document metadata. It is written, read back, and shown; it is
  **never replayed**. Restore comes from the checkpoint. This fills the
  container's feature slot without inventing recompute, which is MVP-4's
  problem and depends on persistent naming this stage does not have.
- Persist documents in the browser behind **one storage interface with two
  backends, IndexedDB and OPFS**, both implemented and both measured. The note
  asks which suits large checkpoints (§12); implementing one and asserting the
  other would answer it with an opinion. One is chosen as the default on the
  evidence, and the loser stays in the tree only as long as it is being measured.
- Add **save, open, and restore-on-load** to the app: an explicit save, a list
  of stored documents, and the last-opened document reopened automatically when
  the page loads, so a browser restart returns to work rather than an empty
  viewport.
- **Refuse to open what cannot be trusted.** An unreadable or truncated
  container, or a `schemaVersion` this build does not understand, fails with a
  clear reason and leaves the current session intact. A *kernel* version
  difference is reported, not refused — `.brep` is readable across OCCT builds
  and pretending otherwise would strand documents on the build that wrote them.
- **Measure what this stage exists to measure**: serialize and deserialize
  throughput against checkpoint size, save and open latency on both storage
  backends, and end-to-end recovery — page load to geometry on screen — after a
  real browser restart. Results land in `measurements/` and a
  `docs/MVP-1-FINDINGS.md`, matching how MVP-0 and the Worker move reported.

Non-goals, each deliberately deferred: **recompute** of any kind, including
edit-a-parameter-and-rebuild (MVP-4); **persistent face and edge references**
(MVP-4); **STEP**, import or export (MVP-2); packaging the container as a single
downloadable file, though the part layout must not assume it stays in the browser;
**autosave**, undo/redo, and document history; assemblies and XCAF (MVP-3);
`preview.glb` and any persisted tessellation cache — the mesh is not the source
of truth and re-tessellating on restore is part of what recovery costs; and
concurrent editing of one document in two tabs. No geometry behavior changes.

## Capabilities

### New Capabilities

- `brep-serialization`: kernel-side conversion between a live body handle and
  OCCT-native B-Rep bytes — the serialize and deserialize operations, the
  encoding actually written, ownership and transfer of byte payloads across the
  kernel boundary in both directions, what happens to a handle when
  deserialization fails, and the requirement that a round trip preserves exact
  geometry rather than an approximation of it.
- `native-document`: the `.webcad` container — its parts, its manifest and
  version fields, document-scoped body identity and its mapping to session
  handles, the operation log as inert metadata, the save and open lifecycle, and
  the rules for refusing an incompatible or damaged document versus reporting a
  benign version difference.
- `document-storage`: where containers live in the browser — the backend-neutral
  store interface, the IndexedDB and OPFS implementations, atomicity of a save
  against a save that is interrupted, listing and deleting documents, tracking
  which document was last open, behavior when a storage quota is exhausted or
  the origin's storage is unavailable, and the requirement that both backends be
  measured on the same workload.

### Modified Capabilities

- `geometry-kernel`: the handle-based facade gains operations that turn a body
  into bytes and bytes into a body, so the capability's "handles in, handles
  out, geometry never crosses" contract must be restated to cover a payload that
  *is* geometry — opaque, kernel-owned bytes that JavaScript may store and hand
  back but never interpret. Operation-log and failure-typing requirements extend
  to the new operations.
- `kernel-worker`: the protocol must carry caller-supplied binary payloads *into*
  the Worker, which today only sends them out; transfer, ownership, and
  request-ordering requirements are restated for the inbound direction.

## Impact

- **Native**: `native/src/kernel.{hpp,cpp}` gains serialize/deserialize over
  OCCT's own shape serialization; `native/src/bindings.cpp` gains the embind
  surface for byte payloads. No new OCCT toolkit is expected — the shape
  serializers live in `TKBRep`, already linked (`native/CMakeLists.txt:39-50`) —
  which makes this the first stage where payload size should *not* grow;
  `measurements/payload.json` should confirm that rather than have it assumed.
- **Kernel/TS**: new request kinds and result shapes in
  `src/kernel/worker/protocol.ts` and `handler.ts`; `src/kernel/kernel.ts` gains
  the two operations and must transfer an inbound buffer.
- **New code**: `src/document/` (container, manifest, operation log, save/open)
  and `src/storage/` (the store interface, IndexedDB and OPFS backends).
- **App**: `src/app/modeling-session.ts` becomes the recorder of the operation
  log and the thing a document is built from and restored into — it currently
  owns handle lifetime and nothing else; `src/main.ts` and `index.html` gain
  save/open/list controls and the restore-on-load path.
- **Tests**: document round-trip, manifest version handling, damaged-container
  refusal, identity mapping across restore, and storage-backend conformance —
  both backends against one suite. IndexedDB and OPFS are browser APIs, so the
  storage suite needs a browser rather than the Node runner that covers the
  kernel today.
- **Measurement**: `scripts/verify-browser.mjs` gains serialize/deserialize,
  per-backend save/open, and a genuine reload-and-recover run;
  `measurements/` gains its output; `docs/MVP-1-FINDINGS.md` reports it.
- **Not affected**: the OCCT build pipeline, tessellation, the viewport's
  rendering and picking, the Worker's responsiveness guarantee, and every
  existing geometric behavior. `BodyId` semantics and the
  empty-result-versus-failure distinction are unchanged.
- **Risk**: the checkpoint is the only path back to a user's geometry, so a
  serialization bug is data loss rather than a wrong pixel. The round-trip test
  asserts exactness — volume, topology counts, and analytic surface types
  preserved — rather than that a file was produced. Second risk: an interrupted
  save must not leave a half-written document that opens to broken geometry,
  which is why atomicity is a requirement on the store rather than a property of
  whichever backend wins.
