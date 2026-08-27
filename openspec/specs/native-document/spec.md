# native-document Specification

## Purpose

Defines what a saved model is: a versioned container of named parts, one of
which happens to be an exact B-Rep checkpoint.

The container is deliberately not STEP. Saving must not pass geometry through an
interchange schema, because a translation on the save path would make every
reopened document a lossy copy of the one that was written. STEP is an export
concern and arrives in MVP-2.

Two requirements here exist because handles cannot be persisted. Kernel
`BodyId`s are indices into a live registry and mean nothing after a reload, so a
document mints its own identities and writes down the mapping from checkpoint
position to identity — that mapping is the only thing tying a persisted body
back to its own history, which is why a disagreement between it and the
checkpoint is a refusal rather than a guess. And identities are never reused,
because a document that reissued a deleted body's name would silently alias two
different bodies in its own record.

The construction record is inert on purpose. Replaying it would need stable
references to faces and edges across topology changes, which is MVP-4's whole
subject and the architecture note's known hard problem; recording history
without claiming to reproduce it is what this stage can honestly offer.
Restoration comes from the checkpoint alone, which is also why a damaged record
costs a warning rather than a user's geometry.

The order of checks on the way in is the safety argument rather than an
implementation detail: schema version, then part presence, then integrity, and
only then does the kernel see a byte. A truncated payload must be refused before
OCCT reads it, and a refusal must leave the session that attempted it exactly as
it was — a user who tries to open a damaged file must not lose the model they
already had.

## Requirements
### Requirement: A document is a versioned container of named parts

A native document SHALL be a container holding independently named parts: a manifest, a construction record, and an exact B-Rep checkpoint. The container SHALL be responsible for part names, versions, and integrity, and MUST NOT interpret the contents of the geometry payload. The part layout MUST NOT assume that documents live only in browser storage, so that packaging a document as a single exportable file later is an addition rather than a format change.

#### Scenario: Parts are separately addressable

- **WHEN** a document is written
- **THEN** its manifest, construction record, and geometry checkpoint are stored as distinct named parts, each readable without parsing the others

#### Scenario: The container does not read the geometry

- **WHEN** the document layer writes or reads a checkpoint
- **THEN** it treats the payload as opaque bytes, deriving only its length and checksum, and no document-layer code decodes B-Rep structure

#### Scenario: The document is not STEP

- **WHEN** a document is saved
- **THEN** it is written in the native container format rather than translated to STEP, so saving does not pass geometry through an interchange schema

### Requirement: The manifest records provenance, units, and integrity

Every document SHALL carry a manifest recording at minimum: an integer `schemaVersion` for the container format, the unit the document's numbers are expressed in, the encoding of the geometry payload, the OCCT version that wrote it, the byte length and a checksum of the geometry payload, and the mapping from checkpoint position to document body identity. Units MUST be declared and MUST NOT be converted by this stage.

#### Scenario: Manifest is written on save

- **WHEN** a document is saved
- **THEN** its manifest records the schema version, units, geometry encoding, writing OCCT version, geometry byte length, geometry checksum, and the ordered body-identity mapping

#### Scenario: Integrity is checked on open

- **WHEN** a document is opened and the geometry payload's length or checksum does not match the manifest
- **THEN** the document is refused before any bytes are handed to the kernel, and the reason names the mismatch

#### Scenario: The identity mapping must agree with the checkpoint

- **WHEN** the number of bodies restored from the checkpoint differs from the number of identities the manifest declares
- **THEN** the document is refused rather than opened with a guessed mapping, and the restored bodies are released

### Requirement: Bodies have document-scoped identity

A document SHALL mint its own identity for each body it contains. Identities MUST be stable across save and open, MUST be unique within the document, and MUST NOT be reused after a body is removed. Kernel `BodyId` handles are session-scoped and MUST NOT be persisted as identity. On open, each restored body MUST be bound to the identity the manifest assigns to its position.

This identity is for a **body** only. It SHALL NOT be extended to a face, an edge, or a vertex, and it constitutes no persistent naming scheme for sub-entities.

#### Scenario: Identity survives a restart

- **WHEN** a document containing several bodies is saved, the page is reloaded, and the document is reopened
- **THEN** each body is addressable by the same document identity it had before, even though the kernel has issued entirely different handles

#### Scenario: Handles are rebound, not restored

- **WHEN** a document is opened
- **THEN** the session binds each freshly issued `BodyId` to the identity recorded for that position, and no persisted handle value is reused

#### Scenario: No sub-entity references are minted

- **WHEN** a document is saved
- **THEN** it records no reference to any individual face, edge, or vertex, positional or otherwise

### Requirement: The construction record is inert metadata

The document SHALL record, in order, the operations that produced its bodies — primitive creation with its parameters, and Boolean operations with their operand identities and the identity they produced. This record MUST round-trip intact. It MUST NOT be executed, replayed, or consulted to reconstruct geometry: restoration comes from the checkpoint alone.

#### Scenario: The record survives a round trip

- **WHEN** a document produced by creating two primitives and subtracting one from the other is saved and reopened
- **THEN** the construction record reads back with the same operations, parameters, operand identities, and ordering as when written

#### Scenario: Opening does not re-execute anything

- **WHEN** a document is opened
- **THEN** no primitive is created and no Boolean is run; the bodies present come from the checkpoint, and the kernel's operation log for the open shows restoration rather than modeling operations

#### Scenario: A document with a damaged construction record still restores geometry

- **WHEN** the construction record cannot be parsed but the manifest and checkpoint are intact
- **THEN** the geometry is restored and the document reports the record as unavailable, because inert metadata MUST NOT be able to cost a user their geometry

### Requirement: Saving captures the current session

Saving SHALL capture every body currently live in the session, in a deterministic order, together with the construction record accumulated for them. A save MUST NOT alter the session: bodies remain live, handles remain valid, and the viewport is unchanged. Saving the same unchanged session twice MUST produce equivalent documents.

#### Scenario: Save leaves the session untouched

- **WHEN** a user saves a document mid-session
- **THEN** every body remains live and selectable, all handles remain valid, and no geometry is re-created

#### Scenario: Save is deterministic

- **WHEN** an unchanged session is saved twice
- **THEN** the two documents carry the same body identities in the same order and the same construction record

#### Scenario: Saving an empty session

- **WHEN** a save is requested with no bodies in the session
- **THEN** a valid empty document is written, and reopening it produces an empty session rather than an error

### Requirement: Opening restores exact geometry into the session

Opening a document SHALL restore its bodies into the kernel from the checkpoint, bind them to their document identities, tessellate them, and display them. Restored bodies MUST be fully editable — usable as Boolean operands and releasable — rather than a read-only view. Opening a document MUST release the bodies of the session it replaces, so that reopening does not leak kernel memory.

#### Scenario: Geometry returns exactly

- **WHEN** a document containing a drilled block is opened
- **THEN** the restored body reports the same volume, topology counts, and analytic surface types as when it was saved, and renders identically

#### Scenario: A restored session is editable

- **WHEN** a user opens a document and applies a Boolean to two restored bodies
- **THEN** the operation succeeds as it would have in the session that saved them

#### Scenario: Opening replaces the previous session cleanly

- **WHEN** a document is opened while another session's bodies are live
- **THEN** the previous bodies are released and removed from the viewport, and the kernel's live-handle count reflects only the newly opened document

### Requirement: An untrustworthy document is refused without damaging the session

A document that cannot be read with confidence SHALL be refused with a reason that names the problem. Refusal MUST leave the current session exactly as it was — bodies live, handles valid, viewport unchanged — and MUST leave the kernel usable. A document whose `schemaVersion` this build has no reader for MUST be refused rather than parsed on a best-effort basis.

#### Scenario: Unknown schema version

- **WHEN** a document declares a `schemaVersion` this build does not implement
- **THEN** it is refused with a message identifying the version it requires and the version this build supports, and nothing is loaded

#### Scenario: Damaged container

- **WHEN** a document is missing a required part, or a part fails to parse
- **THEN** it is refused with a reason naming the part, and the session in progress is untouched

#### Scenario: Refusal is recoverable

- **WHEN** an attempt to open a document has been refused
- **THEN** the user can continue working, save, and successfully open a different document without reloading the application

### Requirement: A differing kernel version is reported, not refused

A document written by a different OCCT version SHALL still be opened, and the difference SHALL be surfaced. Refusing on a kernel-version difference would tie documents to the build that wrote them, which is the outcome the architecture note's migration question exists to avoid. If restoration then fails, the failure MUST be attributable to the version difference rather than reported as a generic error.

#### Scenario: Older document opens

- **WHEN** a document recording an OCCT version different from the running build is opened and its checkpoint restores successfully
- **THEN** the bodies load normally and the version difference is reported as information rather than as a failure

#### Scenario: Version difference is attributable on failure

- **WHEN** restoring a checkpoint written by a different OCCT version fails
- **THEN** the reported error states both the writing and the running version, so the failure is diagnosable rather than mysterious

### Requirement: The last document reopens on load

The application SHALL record which document was most recently open and SHALL reopen it automatically when the application next loads, so that a browser restart returns the user to their work rather than to an empty viewport. If that document cannot be opened, the application MUST start with an empty session and report why, rather than failing to start.

#### Scenario: Restart returns to the model

- **WHEN** a user saves a document, closes the browser, and reopens the application
- **THEN** the document's bodies are restored and displayed without the user opening anything manually

#### Scenario: The last document is gone

- **WHEN** the recorded document has been deleted or cannot be read
- **THEN** the application starts with an empty session, reports the reason, and remains fully usable

#### Scenario: No previous document

- **WHEN** the application loads for the first time in an origin with no stored documents
- **THEN** it starts with an empty session and no error

### Requirement: Recovery cost is measured in phases

The cost of recovering a document after a restart SHALL be measured and reported as separately attributable phases — at minimum kernel readiness, document read from storage, checkpoint restoration, tessellation, and first rendered frame — as well as a total. Reporting only the total would attribute WebAssembly startup to the document layer; reporting only the document phases would misrepresent what a user actually waits for.

#### Scenario: Phased recovery timings are produced

- **WHEN** the verification run reloads the application against a stored document
- **THEN** it records the duration of each recovery phase and the total elapsed time from load to visible geometry

#### Scenario: Startup cost is not attributed to the document

- **WHEN** recovery timings are reported
- **THEN** kernel initialization is reported as its own phase, distinct from reading, restoring, and tessellating the document
