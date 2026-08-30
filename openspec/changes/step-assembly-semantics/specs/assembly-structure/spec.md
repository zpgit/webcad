## ADDED Requirements

### Requirement: An assembly is parts and instances, and a part is a body

An assembly SHALL be represented as a set of **parts** — bodies, in the sense the document and the kernel already use — and a tree of **instances**, each instance referencing at most one part and carrying a placement. A part's geometry SHALL be stored exactly once no matter how many instances reference it.

An instance SHALL carry: its own document-scoped identity, a parent (absent at the root), an optional part, a placement, an optional name, and an optional colour. An instance with no part SHALL be a valid grouping node, because STEP assemblies contain them and a representation that could not express one would have to invent geometry to hold the group.

The instance tree MUST be acyclic, every parent reference MUST resolve within the same document, and placements SHALL compose from the root down so that an instance's world placement is the product of its ancestors' and its own.

#### Scenario: Repeated geometry is stored once

- **WHEN** a STEP file containing twenty occurrences of one part is imported
- **THEN** the document holds one part and twenty instances, and the checkpoint contains one shape for that part rather than twenty

#### Scenario: A grouping node carries no geometry

- **WHEN** an imported assembly contains a subassembly node that has children but no shape of its own
- **THEN** that node is represented as an instance with no part, its children hang beneath it, and no shape is fabricated to stand in for it

#### Scenario: Placements compose down the tree

- **WHEN** an instance sits beneath a subassembly that is itself placed away from the origin
- **THEN** the geometry is positioned by the composition of both placements, and the leaf's stored placement remains the one its file declared rather than a pre-multiplied world transform

#### Scenario: A cyclic or dangling tree is refused

- **WHEN** an instance tree is loaded in which a parent reference does not resolve, or in which following parents revisits a node
- **THEN** the document is refused with a reason naming the defect, and no partial tree is presented to the session

### Requirement: A placement is a transform, carried without decomposition

A placement SHALL be carried and stored as a 3×4 affine transform — twelve numbers, row-major — matching what the kernel's own transform type holds. It MUST NOT be decomposed into translation, rotation, and scale for storage or for transport, because a decomposition cannot represent every transform a foreign file may contain and a silently dropped reflection is a fidelity loss that presents as a rendering bug.

#### Scenario: A mirrored placement survives

- **WHEN** an assembly containing a mirrored occurrence is imported, checkpointed, reopened, and exported
- **THEN** the occurrence is still mirrored at every stage, and its handedness is not silently corrected

#### Scenario: No decomposition is exposed

- **WHEN** the document format and the kernel boundary types are inspected
- **THEN** a placement appears as twelve numbers, and no API requires or returns a quaternion, Euler angles, or a separated scale factor

### Requirement: Instances have document-scoped identity, distinct from bodies

A document SHALL mint its own identity for each instance. Instance identities MUST be stable across save and open, MUST be unique within the document, and MUST NOT be reused after an instance is removed. An instance identity SHALL NOT be a body identity: two instances of one part are two identities referencing one `BodyRef`.

As with `BodyRef`, this identity SHALL NOT be extended to a face, an edge, or a vertex, and it constitutes no persistent naming scheme for sub-entities.

#### Scenario: Two instances of one part are distinguishable

- **WHEN** a part is instanced twice and the document is saved and reopened
- **THEN** the two instances are addressable by their own stable identities, and both resolve to the same part identity

#### Scenario: Instance identity is not reused

- **WHEN** an instance is removed and another is added
- **THEN** the new instance receives an identity that has never been issued in this document

### Requirement: A name is a label and never an identity

A part or instance SHALL carry the name its source file gave it, preserved as text. Names MAY repeat, MAY be absent, and MAY contain any characters a foreign file contains. Nothing in the system SHALL resolve a name to a part, an instance, or a body; identity remains the document-minted reference.

Names MUST be rendered as text, never interpreted as markup, and any truncation SHALL be a display choice that does not alter the stored value.

#### Scenario: Duplicate names are kept as they are

- **WHEN** an imported assembly contains two parts with the same name
- **THEN** both keep that name, both remain separately addressable by identity, and neither is renamed or suffixed to make it unique

#### Scenario: A name is not a lookup key

- **WHEN** the document and session APIs are inspected
- **THEN** no operation accepts a name as the way to address a part or instance

#### Scenario: Hostile text in a name cannot escape

- **WHEN** an imported name contains markup or control characters
- **THEN** it is displayed as literal text and no markup is interpreted

### Requirement: An instance tree survives the checkpoint

Saving a document SHALL persist its instance tree, names, and colours alongside the checkpoint, and opening it SHALL restore the same structure bound to freshly issued handles. The count of parts recorded MUST be checked against the checkpoint as the body count already is, and a disagreement MUST refuse the document rather than present a partial assembly.

#### Scenario: Structure round-trips through a restart

- **WHEN** an imported assembly is saved, the page is reloaded, and the document is reopened
- **THEN** the hierarchy, the placements, the names, and the colours are the same as before the reload, and each part's geometry is the exact restored B-Rep

#### Scenario: A tree disagreeing with the checkpoint is refused

- **WHEN** a document's instance tree references a part position that the checkpoint does not contain
- **THEN** the document is refused with a reason naming the mismatch, and the session is left as it was

### Requirement: A document with no instance tree is a flat document

A document that records no instance tree SHALL be read as one in which every body is its own root instance with an identity placement, no name, and no colour. This MUST require no migration pass and no rewriting: documents written before this capability existed are flat documents, and that is what their absent tree means.

#### Scenario: An older document opens unchanged

- **WHEN** a document written before this capability is opened
- **THEN** its bodies appear as before, each as a root instance at its stored geometry, and nothing is rewritten on open

#### Scenario: A newer document is refused by an older build rather than misread

- **WHEN** a document containing an instance tree is opened by a build that predates this capability
- **THEN** it is refused with a schema-version error rather than rendered with every part at the origin

### Requirement: Structure crosses the kernel boundary as plain data

Import SHALL return the structure it read — instances, parents, placements, names — as plain data alongside the handles, and export SHALL accept the same shape of data. This data MUST NOT include topology, OCAF labels, STEP entity identifiers, or any handle into the translator's own document. The translator's document SHALL exist only for the duration of the call that creates it.

#### Scenario: Import yields handles plus structure

- **WHEN** an assembly is imported
- **THEN** the result carries one handle per part plus a tree of plain records describing parents, placements, and names, and no translator-internal reference is reachable from it

#### Scenario: The translator's document does not outlive the call

- **WHEN** the kernel API surface is inspected after this capability is added
- **THEN** no operation returns or accepts a reference to the translator's document or its labels, and no such document persists between calls

### Requirement: Editing a shared part is never done by guess

An operation that modifies a part referenced by more than one instance SHALL either apply to the part — and therefore to every instance of it — or be refused pending an explicit choice. It MUST NOT silently modify one occurrence's geometry in a way that changes others, and it MUST NOT silently make an occurrence unique without saying so.

Making an occurrence unique SHALL be an explicit operation that produces a new part referenced by that instance alone, leaving the other instances on the original part.

#### Scenario: An edit aimed at one occurrence is refused with a choice

- **WHEN** a user applies a Boolean to an instance whose part has twenty instances
- **THEN** the action reports that the part is shared, offers editing the part or making this occurrence unique, and performs neither until told which

#### Scenario: Making an occurrence unique detaches only that occurrence

- **WHEN** a user makes one of twenty instances unique and then edits it
- **THEN** that instance references a new part carrying the edit, and the other nineteen are unchanged

#### Scenario: An edit to a part reaches every instance of it

- **WHEN** a user chooses to edit a shared part
- **THEN** every instance of that part shows the edited geometry, and the instance count is reported alongside the confirmation

### Requirement: An assembly exports as instances, not as copies

Exporting an assembly SHALL write one part definition per part and one occurrence per instance, carrying placements and names. It MUST NOT write a part's geometry once per instance. What the export writes MUST be the current geometry of each part, as for any export.

#### Scenario: A round trip preserves the instance count

- **WHEN** an assembly of twenty instances of one part is imported, exported, and re-imported
- **THEN** the re-import reports one part and twenty instances, not twenty parts

#### Scenario: Export invents no structure

- **WHEN** a flat session with no instance tree is exported
- **THEN** the payload describes its bodies without fabricating a hierarchy, and no grouping nodes or occurrence names appear that the session did not hold

### Requirement: The cost of the instanced representation is measured

The stage SHALL measure and publish, for at least one third-party assembly: checkpoint bytes and mesh count with instancing against the same file flattened, the import cost of the structure-aware reader against the plain reader on the same file, the instance count and tree depth read, and the module-size change from using the XCAF toolkits. Where a measurement cannot be taken — no suitable fixture, or an environment that cannot support it — the stage MUST report it as not exercised rather than estimate it.

#### Scenario: Instanced and flattened are compared, not asserted

- **WHEN** the measurement run completes for an assembly fixture
- **THEN** the findings state checkpoint size and mesh count both ways, as a ratio, so the representation's benefit is attributable to the measurement rather than to the design intent

#### Scenario: An unavailable fixture is reported, not approximated

- **WHEN** no third-party assembly fixture is available in the environment
- **THEN** the findings say the interoperability claim was not exercised, and no number is carried over from the hand-authored fixture in its place
