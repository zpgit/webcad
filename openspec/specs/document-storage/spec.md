# document-storage Specification

## Purpose

Defines where documents live, stated without reference to how.

The store moves named parts in and out and does not interpret them. That line is
what keeps document semantics — manifest fields, identity, versioning,
integrity — above this layer and storage mechanics below it, and it is why
listing metadata is supplied at save time rather than read back out of a
manifest: deriving a document list by parsing checkpoints would put document
knowledge inside the store in order to save a field.

Atomicity is a requirement on the interface rather than a property of whichever
backend happens to provide it. The checkpoint is the only path back to a user's
geometry, so a save that half-happened is the one failure this capability cannot
permit — and IndexedDB gets that from a transaction while OPFS has to be given
it explicitly.

Two backends exist because the architecture note poses IndexedDB versus OPFS as
an open question, and the answer is a measurement rather than a preference. One
conformance suite runs against both in a real browser, because quota,
transaction, and file-handle behavior is precisely what a fake would reproduce
from this codebase's own assumptions rather than test.

Failure is reported, never silent, and never fatal: a browser that refuses
storage should still run the modeller. Persistence is a feature, not a
precondition.

## Requirements
### Requirement: Storage is reached through one backend-neutral interface

Documents SHALL be persisted through a single store interface that accepts and returns named container parts and knows nothing about their contents. Document semantics — manifest fields, identity, versioning, integrity — MUST live above the store, and storage mechanics MUST NOT leak into them. No caller outside the store implementation SHALL depend on which backend is in use.

#### Scenario: The document layer is backend-agnostic

- **WHEN** the document layer saves or opens a document
- **THEN** it issues the same calls regardless of which backend is active, and no branch in document code tests for a backend

#### Scenario: The store does not interpret parts

- **WHEN** the store writes a document
- **THEN** it persists the parts as given, without parsing the manifest, the construction record, or the geometry payload

### Requirement: Both IndexedDB and OPFS backends exist and behave identically

The system SHALL provide an IndexedDB backend and an OPFS backend, and both SHALL satisfy one shared conformance suite covering save, open, list, delete, last-opened tracking, atomicity, and failure reporting. A behavioral difference between backends that the suite does not cover MUST be treated as a gap in the suite. Because these are browser storage APIs, the conformance suite MUST run in a browser rather than being simulated.

#### Scenario: One suite, two backends

- **WHEN** the storage conformance suite runs
- **THEN** it executes in full against both the IndexedDB and the OPFS backend, and both pass with identical observable behavior

#### Scenario: Round trip through either backend

- **WHEN** a document is saved through one backend and read back through that same backend
- **THEN** every part returns byte-identical to what was written

#### Scenario: Conformance runs against real storage

- **WHEN** the suite runs
- **THEN** it exercises the browser's actual IndexedDB and OPFS implementations rather than an in-memory substitute, so quota, transaction, and file-handle behavior are covered

### Requirement: A save is atomic

Writing a document SHALL either fully succeed or leave the previously stored document intact. An interrupted, failed, or aborted save MUST NOT produce a document whose parts disagree with one another. Atomicity MUST be a property of the store interface, satisfied by every backend, rather than a property one backend happens to provide.

#### Scenario: Interrupted save preserves the previous document

- **WHEN** a save over an existing document is aborted partway through
- **THEN** the previously stored document is still readable and opens to the geometry it had before the attempted save

#### Scenario: Interrupted first save leaves nothing half-written

- **WHEN** the first save of a new document is aborted partway through
- **THEN** no partially written document appears in the document list

#### Scenario: A torn document is detected if it ever occurs

- **WHEN** stored parts are inconsistent with the manifest's recorded geometry length or checksum
- **THEN** the open is refused with that reason rather than the payload being handed to the kernel

### Requirement: Documents can be listed, deleted, and tracked as last-opened

The store SHALL enumerate the documents it holds with enough metadata to display them — at minimum identity, name, and last-modified time — without reading their geometry payloads. It SHALL delete a document and all of its parts. It SHALL record and report which document was most recently opened.

#### Scenario: Listing does not read geometry

- **WHEN** the document list is displayed
- **THEN** it is produced without loading any checkpoint payload, so listing cost does not scale with model size

#### Scenario: Deletion removes every part

- **WHEN** a document is deleted
- **THEN** all of its parts are removed, it no longer appears in the list, and the storage it occupied is released

#### Scenario: Deleting the last-opened document

- **WHEN** the document currently recorded as last-opened is deleted
- **THEN** the record is cleared, and the next application load starts with an empty session rather than attempting to open a document that is gone

### Requirement: Storage failures are reported, never silent

Failures to persist — quota exhausted, storage unavailable or blocked by the browser, a backend that cannot be initialized in this environment — SHALL be reported to the caller as typed failures with an actionable reason. A save that did not happen MUST NOT be reported as a save that did. Storage failure MUST NOT terminate the session or discard live geometry.

#### Scenario: Quota exhausted

- **WHEN** a save fails because the origin's storage quota is exhausted
- **THEN** the caller receives a typed quota failure, the user is told the document was not saved, and the live session and its geometry are untouched

#### Scenario: Storage unavailable

- **WHEN** the selected backend cannot be initialized in the current environment
- **THEN** initialization fails with a reason naming the backend, and the application remains usable for modeling without persistence rather than failing to start

#### Scenario: A failed save is not reported as success

- **WHEN** any part of a save fails
- **THEN** the operation reports failure, and no user-visible indication of a successful save is shown

### Requirement: Both backends are measured, and the default is chosen on the evidence

Save and open latency SHALL be measured for both backends on the same workload and payload sizes, and the results recorded as measurement artifacts. The default backend MUST be selected on those measurements. The architecture note poses IndexedDB versus OPFS as an open question, so a preference asserted without numbers does not satisfy this requirement.

#### Scenario: Comparable measurements are produced

- **WHEN** the verification run exercises persistence
- **THEN** it records save and open latency for both backends across at least a small and a large checkpoint, in one artifact that permits direct comparison

#### Scenario: The default is justified

- **WHEN** a default backend is configured
- **THEN** the recorded measurements support the choice, and the findings state what the losing backend cost and under what conditions the choice would change

### Requirement: Persistence must not freeze the user interface

Saving and opening SHALL keep the main thread responsive. The longest main-thread task attributable to a save or an open MUST be measured, and a stall beyond one frame budget MUST be reported as a finding rather than left unobserved. The kernel was moved off the main thread precisely so that long operations cannot freeze the viewport; persistence MUST NOT reintroduce that failure unmeasured.

#### Scenario: Responsiveness is measured during persistence

- **WHEN** a document is saved and reopened during the verification run
- **THEN** main-thread stall is sampled throughout, and the worst stall is recorded against an idle baseline

#### Scenario: A stalling save is a reported finding

- **WHEN** the worst main-thread stall during persistence exceeds one frame budget
- **THEN** the run reports it with the payload size that produced it, rather than passing silently
