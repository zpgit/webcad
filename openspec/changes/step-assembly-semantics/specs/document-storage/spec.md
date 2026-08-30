## MODIFIED Requirements

### Requirement: Storage is reached through one backend-neutral interface

Documents SHALL be persisted through a single store interface that accepts and returns named container sections and knows nothing about their contents. Document semantics — manifest fields, identity, versioning, integrity — MUST live above the store, and storage mechanics MUST NOT leak into them. No caller outside the store implementation SHALL depend on which backend is in use.

The interface names these units **sections**, matching the container, so that "part" is left to mean assembly geometry. This is terminology: the stored names, the byte contract, and the atomicity guarantees are unchanged, and no stored document needs rewriting.

#### Scenario: The document layer is backend-agnostic

- **WHEN** the document layer saves or opens a document
- **THEN** it issues the same calls regardless of which backend is active, and no branch in document code tests for a backend

#### Scenario: The store does not interpret sections

- **WHEN** the store writes a document
- **THEN** it persists the sections as given, without parsing the manifest, the construction record, or the geometry payload

#### Scenario: The rename does not touch stored data

- **WHEN** a document written before the rename is opened by a build after it
- **THEN** every section is found under the same stored name and returns byte-identical, and no migration runs
