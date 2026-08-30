## Context

MVP-2 left the STEP boundary working and deliberately thin. `importStep` reports
`namedProductCount`, `styledItemCount`, and `assemblyNodeCount`
(`src/kernel/types.ts:145-147`) purely so a caller can see what was thrown away;
the reader is `STEPControl_Reader`, which offers roots and nothing else. This
stage keeps the boundary in the same place and widens what crosses it.

Four facts about the code as it stands shape every decision below.

**The document is flat, and its manifest is the mapping.** `bodies: BodyRef[]` is
ordered by position in the checkpoint, and that array *is* how a restored shape
finds its identity (`src/document/types.ts:158-165`). A count mismatch between
manifest and payload refuses the document. Anything instanced has to preserve
that property: one authority for the mapping, checkable on open.

**The checkpoint is one `.brep` payload holding a `TopoDS_Compound`** of the
bodies in issue order (`native/src/kernel.cpp:650-696`), written without
triangles or normals. Nothing about it is per-body addressable; it is written and
read whole.

**The mesher already emits per-face vertex blocks.** It walks
`TopExp_Explorer(shape, TopAbs_FACE)` and appends each face's triangulation nodes
in turn (`native/src/kernel.cpp:449-500`), so no vertex is shared between two
faces. Per-face attributes are therefore expressible as vertex data at no
geometric cost — and the same loop that would assign them already establishes a
face ordering.

**The XCAF toolkits are linked and unused.** `TKXCAF`, `TKCAF`, `TKLCAF`, and
`TKCDF` are on the link line because `TKDESTEP` requires them
(`native/CMakeLists.txt:50-53`). Present in the link is not present in the
binary — `--gc-sections` has had nothing to keep — so the module-size cost of
this stage is unknown rather than zero, and is measured before it is claimed.

## Goals / Non-Goals

**Goals:**

- An imported assembly arrives as parts and instances, keeps its hierarchy, its
  names, and its colours, and exports back as a file with the same structure.
- The instanced representation is honest end to end: one part shape in the
  checkpoint, one mesh per part, N placements — the copies exist nowhere.
- Colour reaches faces, and the positional key that makes that possible is
  fenced so it can never become a downstream reference (§7).
- Structure and appearance survive the checkpoint, and a document written before
  this stage still opens.
- Every claim above is measured on a file this project did not author, or is
  reported as not exercised.

**Non-Goals:**

- Persistent face and edge references. Nothing here mints a face name a caller
  can hold, and no recompute is driven off a face index.
- Migrating a face-colour map across a topology change. It is dropped, and the
  drop is reported.
- Materials, layers, PMI, GD&T, validation properties, and STEP's
  `PRODUCT_DEFINITION` metadata beyond name — still dropped, now specifically
  rather than wholesale.
- Authoring assemblies in the UI. Structure enters by import in this stage;
  creating a subassembly by hand is a modelling feature, not a semantics one.
- Assembly-level constraints or mates. STEP does not carry them and this system
  has no solver.
- OCAF as a persistence format. `.xbf` and XmlOcaf stay out; see the first
  decision.

## Decisions

### The XCAF document is a per-call vehicle, created and destroyed inside translation

`STEPCAFControl_Reader` needs a `TDocStd_Document`. It is created in the
translation call, read into our own structures, and released before the call
returns. No handle to it, or to any `TDF_Label`, exists outside that scope.

*Alternative considered: keep a long-lived `TDocStd_Document` as the kernel's
model of record* — which is what XDE is designed for, and would make structure
edits and export nearly free. Rejected because it installs a second document with
its own persistence (`.xbf`/XmlOcaf) next to the one §11 specifies and MVP-1
built, and the two would then disagree about what the document is. The native
document stays the container; XCAF stays a translator's data structure. The cost
is that export has to rebuild a document the reader already had, which is the
price of not having two.

### The kernel knows parts; the document knows structure

Handles stay what they are: a part is a body, `BodyId` unchanged. The tree —
nodes, parents, placements, names, colours — lives in the document layer only.
Import *returns* structure as plain data; export *takes* it as plain data.

*Alternative considered: an `AssemblyId` handle with the tree held in WASM.*
Rejected because it creates two authorities on structure — one persisted and
versioned, one session-scoped — and every bug in that class is a silent
divergence. Keeping the kernel stateless about structure also means a structural
edit needs no kernel round trip at all.

This is the payload class the proposal names: strings, transforms, and colour
triples crossing in both directions. It is not topology, and it is not an opaque
byte payload, so `geometry-kernel`'s handle rule gets a third clause rather than
a quiet exception.

### A placement is 12 doubles, row-major, and nothing decomposes it

`gp_Trsf` is exactly a 3×4 affine with a scale factor folded in, so 12 doubles
carry it losslessly in both directions. The document stores them; three.js gets a
`Matrix4` built from them.

*Alternative considered: translation + quaternion (+ scale).* Rejected: it is
lossy for a `gp_Trsf` that is not a pure rigid motion, and every conversion is a
chance to lose handedness.

Worth being precise about where a non-rigid transform actually comes from,
because the first draft of this decision was vague about it. An occurrence placed
through product structure cannot be one: the format places a child through a
transformation between two axis placements, both right-handed by construction, so
no assembly occurrence can express a reflection. Reflections and scales arrive by
the other route — a mapped item carrying a general Cartesian transformation
operator — and `gp_Trsf` represents those, mirror forms included. So the loss the
twelve numbers prevent is real, just not where it was first claimed to be.

### "Part" means the assembly sense; the container's parts become sections

`PART_NAMES`, `PartName`, and `DocumentParts` (`src/document/types.ts:47-58`)
currently name the three files a document is made of. XCAF, STEP, and every CAD
user mean something else by the word, and this stage needs their meaning. So the
container's three files become **sections** — `SECTION_NAMES`, `SectionName`,
`DocumentSections` — across `src/document` and `src/storage`, and "part" is left
to mean shared geometry referenced by instances.

*Alternatives considered: call the assembly definition a "component"* — rejected
because XCAF's `XCAFDoc_ShapeTool` uses *component* for the occurrence that
references a part, so adopting it inverts the vocabulary of the library the
facade reads two files away. *Or keep both meanings, distinguished by type name*
— rejected because these specs are prose read by humans, and "a container of
named parts" one page from "an assembly is parts and instances" costs every
reader the same double-take.

The rename is mechanical, byte-contract-neutral (the file names in the store do
not change), and lands as its own step before the schema work so its diff stays
reviewable.

### The instance tree is added beside the body list, not in place of it

`bodies: BodyRef[]` keeps its exact meaning — identities ordered by position in
the checkpoint compound, and the authority for that mapping. A part *is* a body;
in an assembly document, the bodies are the parts. Nothing about the requirement
"Bodies have document-scoped identity" changes.

What is added is `instances`, each entry carrying its own `InstanceRef`, a
`parent` (null at the root), an optional `body`, a `placement`, an optional
`name`, and an optional `colour`. An instance with no body is a pure grouping
node — STEP assemblies have them, and a tree that could not represent one would
have to invent a shape to hold the group.

Per-part appearance that is not per-instance — a part's own colour, and its
face-colour map — goes in a sparse `appearance` map keyed by `BodyRef`, following
the pattern MVP-1 set with `sources`: an entry exists only for a body that needs
one.

*Alternative considered: replace `bodies` with a parts array and make instances
the only way to reach geometry.* Rejected because it rewrites the one invariant
the document has always had for no gain — the parts array would be the same array
under a new name — and because it would make every flat document a special case
instead of the default.

### An absent instance tree means a flat document, and that is the whole migration

A document with no `instances` is flat: every body is its own root instance with
an identity placement, no name, no colour. That is a true statement about every
MVP-1 and MVP-2 document, so they open with no migration path, no rewriting, and
no special case — the same reasoning MVP-1 used for its sparse `sources` map,
where a missing entry means `authored`.

The schema version still bumps to 3, in one direction: an older build must
**refuse** a document that has instances rather than ignore the field, because
ignoring it would draw every part at the origin and look like a geometry bug. An
unknown-version refusal is the existing behaviour, so this costs nothing new.

### Per-face colour is keyed by exploration order, with the count as its checksum

The mesher's face loop already fixes an order. A part's face-colour map is an
array indexed by that order, stored with the face count it was built against. On
restore, a face count that does not match refuses the map — the same shape of
check the manifest already makes against the payload.

Three fences keep this from becoming a face reference:

1. No API returns a face index to a caller. The kernel emits colour as vertex
   data and face ranges into a mesh; neither is addressable as an identity.
2. Any operation that changes a part's topology drops that part's map and reports
   the drop. It is never reapplied to whatever face now occupies index 17.
3. Nothing recomputes from the map. It is display data with a stated lifetime.

This rested on an assumption that had to be measured before anything was built
on it: that `BRepTools::Write`/`Read` preserves face exploration order.
**Measured, and it holds** (task 1.2). A checkpoint round trip left the mesh
byte-identical — positions, normals, and indices — for a box, a Boolean result,
a cylinder with a seam, and both imported STEP parts; across two successive round
trips; and when restored into a freshly instantiated module rather than the one
that wrote the payload. Because the mesher emits per-face vertex blocks in
exploration order and shares no vertex between faces, a permutation of faces
would have permuted those blocks. The fallbacks stay documented but unused: a
quantized centroid-and-area fingerprint (a positional name wearing a disguise),
and below that, shape-level colour only with per-face colour reported as dropped.

One limitation, stated rather than papered over: identical mesh bytes prove the
sequence of face *geometry* is unchanged, which is what the colour key needs. Two
geometrically identical coincident faces could in principle swap without changing
a byte. No fixture exhibits that, and no colour would land visibly wrong if it
happened.

**The mesher skips a face it cannot triangulate** (`native/src/kernel.cpp:454`).
So face ranges are emitted one per *visited* face, empty where nothing was
emitted, rather than one per contributing face — otherwise a single untriangulated
face would shift every later face's position by one, which is exactly the
corruption a positional key cannot survive.

### Colour resolves face → node → part → default

A face colour wins over the node's colour, which wins over the part's, which
loses to nothing but the viewport default. Node over part is what makes an
occurrence recolourable without touching its siblings, and it is the way XCAF's
own occurrence styling behaves.

### One mesh per part, one three.js `Mesh` per node, vertex colours for faces

The mesh cache is already keyed per body and parts are bodies, so tessellation
reuse comes for free. The viewport creates one `BufferGeometry` per part and one
`Mesh` per node sharing it, each with its own matrix and material.

*Alternative considered: `InstancedMesh`.* Rejected for now: it complicates
per-node colour and per-node picking (`instanceId` rather than an object), and N
`Mesh` objects sharing a geometry already avoid the thing that matters — a second
copy of the vertex data. If the findings show draw-call submission dominating, it
is a contained change, and the measurement to justify it will be in the document.

*Alternative considered: geometry groups plus one material per colour.* Rejected:
it multiplies draw calls by colours per instance. Vertex colours cost 3 bytes a
vertex (`Uint8Array`, normalized) and no draw calls, and the mesher's per-face
vertex blocks mean no vertex has to belong to two colours.

The kernel additionally emits **face ranges** — `(indexOffset, indexCount)` per
face, in the same order — because the viewport needs them to paint colours and
the measurement needs them to count coloured faces. A range is not a name.

### The writer's assembly mode is set explicitly, never inherited

Measured, not assumed (task 2.3): OCCT's STEP writer turns **any** multi-body
export into an assembly. One body writes a single flat product; two bodies write
a root product plus one child per body, with names it invents
("Open CASCADE STEP translator 8.0 2.1"). Re-importing our own two-body export
reports two occurrences that nothing in this system asked for.

So "a flat session exports flat" is not a property this code has today, and it
cannot be obtained by leaving the writer alone — the fabrication *is* the library
default. The assembly mode is therefore a parameter this stage sets on every
export: off when there is no structure to write, on when there is.

This also corrects a scenario MVP-2 shipped, which asserted that export writes
"no fabricated part names, colours, or assembly structure"
(`openspec/specs/step-translation/spec.md:162`). It was untrue for any export of
more than one body, and no test caught it because the round-trip tests asserted
geometry fidelity rather than the entity census. The replacement requirement in
`assembly-structure` names the mechanism instead of restating the wish.

### A pick resolves to a node, and an edit on a shared part says so

Picking returns the node, because "which occurrence" is now a real question. An
edit targeting a node whose part has more than one instance is **refused with a
choice**: edit the part (all occurrences) or make this occurrence unique first.
Silently editing 20 places because the user clicked one is the failure mode
instancing invites, and a modeller that guesses here is worse than one that asks.

`makeUnique` is a document operation: copy the part reference to a new part
backed by the same shape, repoint the node. Whether the kernel copies the shape
or shares it until the first edit is an implementation detail behind `BodyId`.

### Names are foreign text, and never identities

XCAF names are UTF-16 `TCollection_ExtendedString`; they cross as UTF-8 strings.
They are not validated, not deduplicated, not truncated in the data, and not used
as keys — `BodyRef` and the node reference remain the only identities. The UI
renders them as text (never as markup) and truncates for display only.

### Two fixtures, because they answer different questions

A hand-authored minimal AP214 file, committed, with a known-by-construction
structure — two instances of one part, one grouping node, a shape colour and a
face colour — is what the conformance tests assert against exactly. A third-party
assembly pinned by URL and sha256 through `scripts/fetch-step-fixtures.sh` is
what the interoperability claim rests on. Neither substitutes for the other, and
if no suitably licensed third-party file can be found, the interop claim is
reported as not exercised rather than transferred to the file we wrote.

## Risks / Trade-offs

**`BRepTools` does not preserve face order across a checkpoint** → **Retired.**
Measured first, as its own task, before any colour plumbing depended on it, and
the order holds under every case tried including a fresh module and repeated
round trips. A permanent regression test now guards it, because the assumption is
load-bearing and silent when it breaks. The fallbacks remain written down in case
a future OCCT changes the answer.

**The `.wasm` grows once XCAF is actually reached.** The toolkits are linked but
their code has never been referenced, so this stage is the first to keep any of
it → Measured against today's artifact and reported as a shipping cost, the way
MVP-2 reported its ~3 MB brotli figure. The translation module already loads
lazily, and nothing in the geometry, document, or app layers assumes translation
lives in the same `.wasm`.

**Instancing surprises the user: one edit changes twenty places** → The edit is
refused with an explicit choice rather than performed, and the UI shows the
instance count next to the node. The cost is an extra click on a shared part,
which is the correct cost.

**The schema bump strands documents** → v1 and v2 open as flat documents by
definition rather than by migration, tested against manifests written by the
previous stages' code rather than by hand. A v3 document with instances is
refused by an older build with the existing unknown-version error, which is
stated in the findings rather than discovered by a user.

**Vertex colours triple per-vertex payload on a large coloured assembly** →
`Uint8` normalized RGB, allocated only for parts that actually carry colour, and
the byte cost measured next to the mesh figures MVP-1 established.

**`STEPCAFControl_Writer` may flatten on export** — writing one part label
referenced N times is what should produce one part definition and N occurrences,
but that is an expectation about OCCT's writer, not a guarantee → The round trip
re-imports our own export and counts instances, so a writer that duplicates
geometry shows up as an instance count of 1 with N parts instead of the reverse.
As in MVP-2, a self-referential check cannot attribute the fault; the pinned
third-party file and a count comparison against the source file are what make it
attributable.

**A pick that must resolve to a node changes selection everywhere it is used** →
Selection becomes a node reference with the part reachable from it, so code that
wants "which body" still gets an answer, and the compiler finds the call sites.

**Timings on this box vary by up to ~1.8× between runs** (`docs/BUILD.md`) →
Report ratios and orderings, not absolute milliseconds; the instanced-versus-
flattened comparison is a ratio by construction.

## Migration Plan

1. Land the face-order measurement first. Its answer decides whether per-face
   colour is built as designed, built on a fingerprint, or dropped and reported.
2. Kernel: CAF reader behind the existing `importStep` entry point, structure out
   as plain data, with the old flat behaviour reachable until the document layer
   can hold a tree.
3. Document: the sections rename, then instances beside bodies, schema v3, and
   an absent instance tree read as a flat document.
4. Tessellation and viewport: per-part meshes, per-node placements, face ranges,
   vertex colours.
5. UI: assembly tree, names, colours, instance counts, make-unique.
6. Export: structure in, CAF writer, round-trip counts.
7. Measure, then publish `docs/MVP-3-FINDINGS.md` and update the roadmap row.

Rollback: the stage is additive to the kernel API and the document schema. A
document saved as v3 is not readable by an MVP-2 build, so a rollback after
saving means the checkpoint is still exact geometry and re-importable but the
structure is lost — worth stating, not worth engineering around at this stage.

## Open Questions

- ~~Does `BRepTools::Write`/`Read` preserve face exploration order?~~ **Answered
  yes** (task 1.2): mesh byte-identical across a round trip for a primitive, a
  Boolean result, a seamed cylinder, and two imported STEP parts, across two
  round trips, and into a fresh module. Per-face colour proceeds as designed.
- Does `STEPCAFControl_Writer` emit `NEXT_ASSEMBLY_USAGE_OCCURRENCE` for a part
  label referenced from several components, or duplicate the geometry?
- AP214 or AP242 for the write schema, and does the choice change whether colour
  and structure survive a round trip through a third-party reader?
- Is there a STEP assembly with colours, under a licence that permits pinning it,
  small enough to fetch in CI? If not, the interop claim is reported unexercised.
- ~~Does XCAF's reader expose the difference between a part's own colour and a
  component's override, or resolve it before we see it?~~ **Answered: both**
  (task 5.1). The two are stored apart - a part's colour on its label, an
  occurrence's in a SHUO - but OCCT's public accessor for the second,
  `GetInstanceColor`, resolves: finding no override it falls back to the
  component label and then to the part's own colour, so it reports every
  occurrence of a coloured part as overridden. Measured, and it erased the
  distinction on the fixture. The kernel reads the SHUO directly instead. What
  remains open is narrower and is tracked as task 5.1a: whether a genuine
  override round-trips at all, which group 6 can settle with OCCT's own writer.
- Does a STEP colour survive as the number the file wrote? **Yes, if it is read
  as sRGB** (task 5.1). OCCT decodes `COLOUR_RGB` as sRGB and stores it linear,
  so the component accessors return a different colour than the file declared.
  Not an open question any more, but it was not a known one either.
