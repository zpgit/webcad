## MODIFIED Requirements

### Requirement: STEP bytes translate into registered bodies

The kernel SHALL accept a caller-supplied STEP payload and translate it into bodies registered in its own handle space, returning handles plus the file's product structure as plain data. Translation MUST be a single explicit transaction: the payload is read, transferred into OCCT topology, inspected, and registered, or it fails as a whole.

What may cross is bounded. Handles, counts, scalar measurements, and **structure and attribute data reduced to plain values** — parent links, transforms, names, colour triples — cross. No STEP entity, no OCAF label, and no reference into the translator's own document SHALL be exposed to JavaScript in any form. The caller learns what arrived through handles and values, exactly as for a body created here; the difference from earlier stages is which values, not which kinds of thing.

A structure-aware read MUST be available and MUST NOT be the only mode: a caller that wants top-level shapes alone SHALL still be able to ask for them, so that a flat import remains a supported operation rather than a degenerate assembly.

#### Scenario: A single-part file imports as one body

- **WHEN** a caller imports a STEP file containing one solid
- **THEN** one `BodyId` is returned, its reported face, edge, and vertex counts and its volume are those of the solid the file describes, and no B-Rep structure is constructed on the JavaScript side

#### Scenario: An assembly imports as parts and instances

- **WHEN** a caller imports a STEP file whose root is an assembly of several parts
- **THEN** one `BodyId` is returned per distinct part, a tree of instances referencing those parts is returned alongside, and geometry shared between occurrences is registered once rather than once per occurrence

#### Scenario: A compound root still imports as several bodies

- **WHEN** a caller imports a STEP file whose root is a compound with no product structure
- **THEN** one `BodyId` is returned per top-level shape, in a stable order, and the result reports no instance tree rather than inventing one

#### Scenario: Translation reports what it produced

- **WHEN** an import completes
- **THEN** the result reports the number of bodies registered, the number of root shapes the file declared, the number of instances and the depth of the tree, the number of named and coloured entities preserved, and the payload's byte length, so a discrepancy between what the file contained and what became a body is visible rather than inferred

#### Scenario: STEP entities do not reach the caller

- **WHEN** the kernel API surface is inspected after structure-aware import is added
- **THEN** no operation returns STEP entity identifiers, attribute records, or OCAF labels, and the imported geometry is reachable only through handles while structure is reachable only as plain values

#### Scenario: A flat import remains available

- **WHEN** a caller imports an assembly asking for top-level shapes only
- **THEN** the parts arrive as bodies with no instance tree, and the result says the structure was not requested rather than that the file had none

### Requirement: Bodies export to STEP bytes carrying their current geometry

The kernel SHALL translate a caller-specified set of live bodies, optionally accompanied by a structure and appearance description, into a STEP payload and return it as opaque bytes. What is written MUST be the current canonical B-Rep of those bodies: if a body was edited after import, the export MUST contain the edited exact geometry, not the geometry as imported. Export MUST NOT tessellate, approximate, or pass geometry through a mesh.

Where a structure is supplied, it MUST be plain data — instances, parents, transforms, names, colours — and the export MUST write one part definition per body and one occurrence per instance rather than duplicating geometry per occurrence. Where no structure is supplied, the export writes the bodies flat and fabricates none.

#### Scenario: An edited body exports with the edit in it

- **WHEN** an imported body has a Boolean cut applied and the result is exported
- **THEN** the exported payload describes the cut geometry, and re-importing it yields a body whose volume matches the cut body rather than the original

#### Scenario: Analytic surfaces survive export

- **WHEN** a body with analytic cylindrical faces is exported and re-imported
- **THEN** the re-imported body's surface-type census still reports those faces as exact cylindrical surfaces rather than as splines or facets

#### Scenario: Export takes handles and plain data, and returns bytes

- **WHEN** a caller exports bodies with a structure description
- **THEN** the operation is invoked with handles and plain values alone — no topology, no labels — returns an opaque payload with its byte length reported, and every input handle remains valid and unchanged afterwards

#### Scenario: Structure is written as occurrences, not copies

- **WHEN** a caller exports one body with twenty instances
- **THEN** the payload contains one part definition and twenty occurrences, and its byte length is far closer to a single part than to twenty

#### Scenario: Exporting an unknown handle

- **WHEN** a caller exports a set that includes a `BodyId` that was never issued or has been released
- **THEN** the operation fails with an `InvalidHandle` error, no payload is produced, and no other body in the set is affected

#### Scenario: A structure naming an unknown body is refused

- **WHEN** a caller exports a structure whose instance references a body not in the exported set
- **THEN** the operation fails naming the unresolved reference, and no partial payload is produced

## REMOVED Requirements

### Requirement: What STEP carries beyond shape is dropped explicitly

**Reason**: The requirement existed to make MVP-2's deliberate scope limit visible — assembly hierarchy, part names, and colours were read only far enough to report that they had been discarded, and an assembly imported flattened. This capability preserves all three, so a requirement mandating their loss now contradicts the system's behaviour. What remains unmodelled is narrower and specific, and is stated by the replacement requirement below rather than by a blanket rule.

**Migration**: Its three concerns are carried forward, none dropped. Assembly hierarchy and names are now required by `assembly-structure`. Colour at part, instance, and face level is now required by `appearance-attributes`, which also keeps the "reported, not discovered" rule for what it still does not model. The scenario forbidding export from fabricating semantics survives as "Export invents no structure" in `assembly-structure` and "Uncoloured geometry exports uncoloured" in `appearance-attributes`. The requirement immediately below keeps the explicit-drop rule for everything else STEP carries.

## ADDED Requirements

### Requirement: What STEP carries that this system does not model is still dropped explicitly

A STEP file carries more than shape, structure, names, and colour. Materials, textures, transparency, layers, presentation styles beyond colour, PMI, GD&T, validation properties, tolerances, and `PRODUCT_DEFINITION` metadata beyond name SHALL NOT be preserved. Their presence MUST be reported specifically — naming what was found — rather than as one undifferentiated loss, and export MUST NOT fabricate any of them.

The report MUST distinguish preserved from dropped, so that a loss is attributable to this system's scope rather than to the file.

#### Scenario: A file's unmodelled semantics are named in the report

- **WHEN** a STEP file carrying PMI annotations and material definitions is imported
- **THEN** the result reports each category found and not preserved, distinctly from the structure, names, and colours it did preserve

#### Scenario: Nothing unmodelled is invented on export

- **WHEN** bodies are exported
- **THEN** the payload contains no material, tolerance, annotation, or layer entities, because the system held none to write

### Requirement: The translator's document exists only within the call that creates it

Structure-aware translation requires a translator-side document. It SHALL be created inside the translation call, read into this system's own plain data, and released before the call returns. No reference to it, or to any label within it, SHALL outlive the call or be reachable from its result. It MUST NOT be used as a persistence format, and the native document remains the only container this system saves.

#### Scenario: No translator document persists between calls

- **WHEN** two imports are performed in one session
- **THEN** neither shares a translator document with the other, and no such document is retained between them

#### Scenario: The translator's format is never a save format

- **WHEN** the persistence paths are inspected
- **THEN** a document is saved only in the native container format, and no translator-side document format is written to storage

#### Scenario: A failed structure-aware translation leaves nothing behind

- **WHEN** a structure-aware import fails partway
- **THEN** the translator document is released, no partially registered body remains reachable by a handle, and the kernel serves subsequent operations normally
