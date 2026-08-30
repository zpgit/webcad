## Why

MVP-2 reads a `.step` file and keeps the only part of it this system models:
shape. Everything else — the product structure, the part names, the colours — is
read far enough to say it was dropped and then discarded, and an assembly arrives
as a flat pile of bodies (`openspec/specs/step-translation/spec.md`, "What STEP
carries beyond shape is dropped explicitly"). For a file from another CAD system
that is most of the file. A 40-part assembly imports as 40 anonymous grey solids
with no way to tell which is which, and exports back as 40 unrelated parts, so
the round trip MVP-2 measured is faithful about geometry and lossy about
everything that made the geometry navigable.

Now, because the cost is already paid and the question is next in line. MVP-2's
`TKDESTEP` linkage dragged the entire XCAF/OCAF stack onto the link line —
`TKXCAF`, `TKCAF`, `TKLCAF`, `TKCDF`, currently linked and unused
(`native/CMakeLists.txt:50-53`) — so the toolkits this stage needs are in the
`.wasm` already and its module-size bill should be a fraction of MVP-2's. The
note names the approach directly (§11: assembly, if in scope, prefer XCAF/XDE
over a pure `TopoDS_Shape` model), and the roadmap names the bottleneck: **STEP
document semantics** — can structure, naming, and colour survive the same
import, checkpoint, restore, edit, export cycle that geometry now survives?

## What Changes

- **Translate through XCAF, in a scratch document.** Import moves from
  `STEPControl_Reader` to `STEPCAFControl_Reader`, export from
  `STEPControl_Writer` to `STEPCAFControl_Writer`, both against a
  `TDocStd_Document` created inside the translation call and discarded before it
  returns. The OCAF document is a translation vehicle, never the document of
  record: §11 makes the native document the container and translation a boundary
  concern, and MVP-1 settled the checkpoint. What crosses the boundary stays
  handles, counts, scalars, and now strings — never OCAF labels.
- **The document gains instances, and its body list becomes its part list.** The
  manifest's `bodies: BodyRef[]` keeps exactly the meaning it has had since MVP-1
  — identities ordered by position in the checkpoint (`src/document/types.ts:158`)
  — and in an assembly those bodies *are* the parts: one shape per part, stored
  once. Added alongside is an instance tree, each node carrying a parent, a
  placement, an optional body, a name, and a colour. A 20-instance assembly is one
  part shape and 20 nodes, not 20 copies. A document with no instance tree is a
  flat document, which is what every MVP-1 and MVP-2 document already is, so they
  keep opening unchanged. **BREAKING in one direction only:** the schema version
  bumps so that an older build refuses a document with instances rather than
  drawing every part at the origin.
- **Instancing is real, so its semantics are stated rather than discovered.**
  Editing a part edits every instance of it; that is what sharing means. An edit
  intended for one occurrence needs the occurrence made unique first, and the
  system must say which it is doing rather than let a Boolean silently change 19
  other places.
- **The container's "parts" become "sections", so the word can mean one thing.**
  `PART_NAMES`, `PartName`, and `DocumentParts` currently name the three files a
  document is made of — `manifest.json`, `features.json`, `geometry.brep`
  (`src/document/types.ts:47`) — while this stage needs "part" for the assembly
  sense that XCAF, STEP, and every user already give it. A mechanical rename
  frees it, and "section" describes three files in a container better than "part"
  did.
- **Names are preserved and are not identities.** A part or instance carries the
  name its file gave it, and `BodyRef` remains the identity. Names may repeat, may
  be absent, and may be any bytes a foreign file contains; nothing resolves a name
  to a thing.
- **Colour at part, instance, and face level.** Shape-level colours come from
  `XCAFDoc_ColorTool` and apply per node. Per-face colours are also read — they
  are common in real files, and dropping them would make a coloured assembly
  arrive half-coloured — and this is the one place this stage takes on risk
  deliberately. A per-face colour is keyed **positionally**, by the face's
  position in a part shape's exploration order, which is exactly the kind of
  reference §7 rejects for downstream use. It is therefore scoped as import-time
  attribute data with a stated lifetime, not a reference: it must survive a
  `.brep` checkpoint round trip (**verified, not assumed** — whether OCCT's
  serializer preserves exploration order is a measurement this stage owes), it is
  invalidated by any topology change, and an invalidated mapping is **reported and
  dropped rather than reapplied to whatever face now sits at that index**. No API
  hands a face index to a caller, and nothing recomputes from one.
- **One mesh per part, drawn once per instance.** Tessellation becomes a per-part
  product with colour carried per face group; the viewport shares the buffer
  across instances and applies each placement. A mesh count that no longer tracks
  the instance count is the measurable point of the whole representation choice.
- **The UI gains structure.** An assembly tree showing hierarchy, names, and
  colours, with selection still at instance and body level. Face-level selection
  stays out — it mints the persistent reference MVP-4 exists to make possible
  (§7), and reading a colour off a face is not the same as letting a user name it.
- **Export writes instances, not copies.** A round trip of an assembly produces a
  file with the structure it came in with: one part definition per part, one
  occurrence per node, names and colours attached. Export therefore takes a
  structure description rather than a set of handles — plain data, no topology.
- **Fixtures this stage has to acquire.** OCCT's repository ships no STEP file
  with an assembly or a colour in it: `screw.step` and `linkrods.step` are both
  single parts with no `NEXT_ASSEMBLY_USAGE_OCCURRENCE` and no `COLOUR_RGB`
  (`tests/helpers/step-fixtures.ts:29`). So two arrive: a **hand-authored minimal
  AP214 file**, committed, small enough to assert against exactly; and a
  **third-party assembly with colours pinned by URL and sha256** through
  `scripts/fetch-step-fixtures.sh`. Only the second can say anything about
  interoperability, and only the first can say anything precisely.
- **Measure it and publish `docs/MVP-3-FINDINGS.md`:** checkpoint size and mesh
  count instanced versus flattened, structure and colour fidelity across import →
  checkpoint → restore → edit → export → re-import, the cost of the CAF reader
  against the plain reader on the same file, per-face colour survival across a
  checkpoint, and the `.wasm` delta from actually using toolkits already linked.

**What this stage will not claim.** Per-face colour after a topology-changing
edit — the mapping is dropped and said to be dropped, not migrated; migrating it
is MVP-4's problem wearing a different hat. Persistent face and edge references
of any kind (§7). Materials beyond colour, layers, PMI, GD&T, and validation
properties, which STEP carries and this stage still drops explicitly. The note's
10/100/500 MB question (§12), still open after MVP-2 and not answered by adding
structure to a 1.8 MB file. And whatever the pinned third-party fixture turns out
not to contain, which will be named in the findings rather than glossed.

## Capabilities

### New Capabilities
- `assembly-structure`: what an assembly is in this system — parts, instances,
  placements, parent links, and names; the invariants (acyclic, one shape per
  unique part, placements compose down the tree, a name is never an identity); the
  consequences of sharing for editing; and how structure survives a checkpoint and
  returns to STEP as instances rather than copies.
- `appearance-attributes`: colour at part, instance, and face level — where it
  comes from, how far down it applies, how a positionally-keyed face colour is
  scoped so it never becomes a downstream reference, when it is invalidated, and
  what is reported when it is.

### Modified Capabilities
- `step-translation`: its "What STEP carries beyond shape is dropped explicitly"
  requirement is largely reversed — structure, names, and colours are now
  preserved, an assembly no longer imports flattened, and the requirement must
  state precisely what remains dropped (materials, layers, PMI) instead of
  covering all of it. The reader and writer become the CAF variants, and the
  scratch OCAF document's lifetime becomes a stated rule.
- `native-document`: an instance tree joins the body list, names and colours
  become persisted document data, instances acquire their own document-scoped
  identity next to `BodyRef`, and a schema-version bump has to leave MVP-1 and
  MVP-2 documents readable as what they are — flat documents of authored and
  imported bodies. Its "named parts" also become named sections, per the rename.
- `tessellation`: a mesh belongs to a part, not to an occurrence, and carries
  colour per face group. Reuse across placements is a requirement, not an
  optimization, because the instanced representation is only honest if the render
  path never materializes the copies.
- `viewport`: shared geometry drawn per placement, per-face colour, and selection
  that resolves to an instance — a pick now has to answer "which occurrence" and
  not just "which body".
- `geometry-kernel`: its handle rule admits a third payload class. Structure and
  attributes cross as plain data in both directions (strings, transforms, colour
  triples), which is neither topology nor an opaque byte payload, and the rule
  should say so rather than have it smuggled in.
- `file-exchange`: import reports what structure arrived — instance count, depth,
  named parts, coloured faces — and export takes a structure rather than a
  selection of bodies.
- `document-storage`: the byte-level contract is unchanged, but the three named
  things a store persists are sections rather than parts, and the spec text says
  so rather than leaving two meanings of the word one paragraph apart.

## Impact

- `native/src/kernel.cpp`, `native/src/bindings.cpp` — the CAF reader and writer,
  the scratch `TDocStd_Document`, part-shape registration shared across instances,
  colour extraction per shape and per face, and structure marshalling over the
  existing staging buffer.
- `native/CMakeLists.txt` — the XCAF toolkits stop being linked-and-unused; the
  size consequence of that is measured, not assumed to be zero.
- `src/kernel/` — assembly and appearance types, protocol messages carrying
  structure both ways, instrumentation for the CAF path.
- `src/document/` — parts, nodes, placements, names, colours; manifest schema
  bump; checkpoint layout change; construction record entries for structural
  edits, still inert.
- `src/document/types.ts`, `src/storage/` — the parts-to-sections rename, 45
  usages across eight files, byte-level contract untouched.
- `src/kernel/types.ts`, `src/viewport/` — tessellation output per part rather
  than per body, per-instance transforms, per-face colour, instance-aware picking.
- `src/app/`, `src/ui/` — the assembly tree, name and colour display, and the
  make-unique step that instancing forces.
- `tests/`, `tests/browser/` — a committed hand-authored fixture, a pinned
  third-party one, structure and colour conformance, and the instanced-versus-
  flattened measurements.
- `scripts/fetch-step-fixtures.sh` — a second pinned source alongside OCCT's.
- `docs/MVP-3-FINDINGS.md`, `README.md`, `docs/BUILD.md` — the findings, the
  roadmap row, and the fixture instructions.
