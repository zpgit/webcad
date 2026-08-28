## ADDED Requirements

### Requirement: A body records where it came from

Every body in a document SHALL record its origin: authored in this application, or imported from a named external file. For an imported body the document MUST record the source filename, the interchange format, and the length unit the file declared, and MUST carry that record across save and open. An imported body is a **base feature**: the document MUST NOT fabricate a parametric history for it, and MUST NOT record any operation as having produced it beyond the import itself.

The source record is metadata about provenance. It MUST NOT be consulted to reconstruct geometry, and it MUST NOT restrict what operations a body accepts — an imported body is an ordinary body.

#### Scenario: Provenance survives a round trip

- **WHEN** a document containing an imported body is saved and reopened
- **THEN** that body still reports itself as imported, with the same source filename, format, and declared unit as when it was imported

#### Scenario: No parametric history is invented for an import

- **WHEN** a body is imported
- **THEN** the construction record contains a single import entry for it, and no primitive-creation or Boolean entry claims to have produced it

#### Scenario: An authored body is distinguishable from an imported one

- **WHEN** a document contains both a locally created primitive and an imported body
- **THEN** each reports its own origin, and the two are distinguishable without inspecting geometry

#### Scenario: Provenance does not restrict operations

- **WHEN** an imported body is used as a Boolean operand
- **THEN** the operation is accepted on the same terms as for an authored body, and the result is recorded as authored here with the imported body as an operand

## MODIFIED Requirements

### Requirement: The manifest records provenance, units, and integrity

Every document SHALL carry a manifest recording at minimum: an integer `schemaVersion` for the container format, the unit the document's numbers are expressed in, the encoding of the geometry payload, the OCCT version that wrote it, the byte length and a checksum of the geometry payload, and the mapping from checkpoint position to document body identity.

The document layer MUST NOT convert units. The manifest's unit is the single working unit every body in the document is expressed in, and it stays so regardless of how those bodies entered: unit conversion belongs to translation, at the boundary, and a document containing imported geometry MUST NOT acquire a second unit as a result. A source file's own declared unit is **provenance**, recorded on the import that brought the geometry in, and MUST NOT displace the document's working unit.

#### Scenario: Manifest is written on save

- **WHEN** a document is saved
- **THEN** its manifest records the schema version, units, geometry encoding, writing OCCT version, geometry byte length, geometry checksum, and the ordered body-identity mapping

#### Scenario: Imported geometry does not change the document's unit

- **WHEN** a document containing bodies imported from a file declaring a length unit other than the working unit is saved
- **THEN** the manifest still records the working unit, and the document layer performs no conversion of its own

#### Scenario: The source file's unit is kept as provenance

- **WHEN** a document containing imported geometry is saved and reopened
- **THEN** the unit the source file declared is readable from the import's provenance record, distinct from and without contradicting the manifest's working unit

#### Scenario: An undeclared source unit is recorded as unknown

- **WHEN** a document contains geometry imported from a file that declared no determinable unit
- **THEN** the provenance records the declared unit as unknown together with the unit that was assumed in its place, and the manifest's working unit is unaffected

#### Scenario: Integrity is checked on open

- **WHEN** a document is opened and the geometry payload's length or checksum does not match the manifest
- **THEN** the document is refused before any bytes are handed to the kernel, and the reason names the mismatch

#### Scenario: The identity mapping must agree with the checkpoint

- **WHEN** the number of bodies restored from the checkpoint differs from the number of identities the manifest declares
- **THEN** the document is refused rather than opened with a guessed mapping, and the restored bodies are released

### Requirement: The construction record is inert metadata

The document SHALL record, in order, the operations that produced its bodies — primitive creation with its parameters, Boolean operations with their operand identities and the identity they produced, and **the import of external geometry with its source filename, format, declared unit, and the identities it produced**. This record MUST round-trip intact. It MUST NOT be executed, replayed, or consulted to reconstruct geometry: restoration comes from the checkpoint alone.

An import entry is inert in the strongest sense — it MUST NOT be treated as a reference to a file that will be read again. Reopening a document MUST NOT attempt to locate, re-read, or re-translate the source file, because the geometry is in the checkpoint and the file may no longer exist.

#### Scenario: The record survives a round trip

- **WHEN** a document produced by creating two primitives and subtracting one from the other is saved and reopened
- **THEN** the construction record reads back with the same operations, parameters, operand identities, and ordering as when written

#### Scenario: An import entry survives a round trip

- **WHEN** a document produced by importing a file and cutting a cylinder from the imported body is saved and reopened
- **THEN** the record reads back with the import entry and the Boolean entry in order, the import naming its source file, format, and declared unit

#### Scenario: Opening does not re-read the source file

- **WHEN** a document containing imported geometry is opened
- **THEN** no attempt is made to locate or re-translate the source file, and the document opens fully even though that file is not available to the browser

#### Scenario: Opening does not re-execute anything

- **WHEN** a document is opened
- **THEN** no primitive is created and no Boolean is run; the bodies present come from the checkpoint, and the kernel's operation log for the open shows restoration rather than modeling operations

#### Scenario: A document with a damaged construction record still restores geometry

- **WHEN** the construction record cannot be parsed but the manifest and checkpoint are intact
- **THEN** the geometry is restored and the document reports the record as unavailable, because inert metadata MUST NOT be able to cost a user their geometry
