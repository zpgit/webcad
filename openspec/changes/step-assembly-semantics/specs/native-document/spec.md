## RENAMED Requirements

- FROM: `### Requirement: A document is a versioned container of named parts`
- TO: `### Requirement: A document is a versioned container of named sections`

## MODIFIED Requirements

### Requirement: A document is a versioned container of named sections

A native document SHALL be a container holding independently named sections: a manifest, a construction record, and an exact B-Rep checkpoint. The container SHALL be responsible for section names, versions, and integrity, and MUST NOT interpret the contents of the geometry payload. The section layout MUST NOT assume that documents live only in browser storage, so that packaging a document as a single exportable file later is an addition rather than a format change.

The word **part** is reserved for the assembly sense — geometry referenced by one or more instances — and MUST NOT be used for a section of the container. The rename is terminological: the names of the stored sections themselves are unchanged, so no stored document is affected.

#### Scenario: Sections are separately addressable

- **WHEN** a document is written
- **THEN** its manifest, construction record, and geometry checkpoint are stored as distinct named sections, each readable without parsing the others

#### Scenario: The container does not read the geometry

- **WHEN** the document layer writes or reads a checkpoint
- **THEN** it treats the payload as opaque bytes, deriving only its length and checksum, and no document-layer code decodes B-Rep structure

#### Scenario: The document is not STEP

- **WHEN** a document is saved
- **THEN** it is written in the native container format rather than translated to STEP, so saving does not pass geometry through an interchange schema

#### Scenario: The rename does not change stored bytes

- **WHEN** a document written before the rename is read afterwards
- **THEN** the same stored names resolve to the same sections, and nothing about the persisted layout has changed

## ADDED Requirements

### Requirement: The manifest carries the instance tree and the appearance it holds

The manifest SHALL record the document's instance tree — each instance's identity, parent, referenced body, placement, name, and colour — and a per-body appearance record for colour that belongs to a body rather than to an occurrence. Both SHALL be additive to the existing body list, which keeps its meaning as the ordered mapping from checkpoint position to identity.

Appearance records SHALL be sparse: an entry exists only for a body that has one, and its absence means the body has no colour of its own. A document that records no instance tree SHALL mean a flat document, not an empty one.

#### Scenario: The body list keeps its meaning

- **WHEN** a document containing an assembly is written
- **THEN** the body list is still the ordered mapping from checkpoint position to identity, and the instance tree references those identities rather than replacing them

#### Scenario: Appearance is recorded only where it exists

- **WHEN** a document containing one coloured body and three uncoloured ones is written
- **THEN** the appearance record holds one entry, and the absence of the others is what says they have no colour

#### Scenario: A flat document records no tree

- **WHEN** a session of locally authored bodies is saved
- **THEN** the manifest records no instance tree, and reopening it yields the same flat set of bodies

### Requirement: The schema version bumps so an older build refuses rather than misreads

Adding the instance tree SHALL raise the manifest's schema version. Documents at the previous versions MUST remain readable, because a document without an instance tree is a flat document and that is exactly what they are. A build that predates the tree MUST refuse a document that has one, using the existing unknown-version refusal, because ignoring the field would place every part at the origin and present a structural loss as a geometry defect.

#### Scenario: Earlier documents open without migration

- **WHEN** a document written at either earlier schema version is opened
- **THEN** it opens as a flat document, nothing is rewritten in the process, and the bodies are bound to their recorded identities as before

#### Scenario: A document with a tree is refused by an older reader

- **WHEN** a document at the new version is opened by a reader that supports only the earlier ones
- **THEN** it is refused with a schema-version error naming the version it found, and no geometry is displayed

#### Scenario: Opening then saving an earlier document writes the new version

- **WHEN** an earlier-version document is opened and saved
- **THEN** it is written at the new version, still with no instance tree, and it opens identically afterwards

### Requirement: A structural edit is recorded and remains inert

The construction record SHALL gain entries for the structural operations this stage introduces — importing an assembly, and making an occurrence unique — on the same terms as every other entry: written, readable, displayable, and never replayed. Restoration continues to come from the checkpoint alone.

#### Scenario: An assembly import is recorded as one base feature

- **WHEN** an assembly is imported
- **THEN** the construction record holds one import entry naming the file and the bodies it produced, and no parametric history is invented for the parts

#### Scenario: Making an occurrence unique is recorded

- **WHEN** a user makes one instance of a shared part unique
- **THEN** the construction record holds an entry naming the instance and the new body, and reopening the document restores the result from the checkpoint rather than by replaying it
