## ADDED Requirements

### Requirement: Bodies serialize to kernel-native B-Rep bytes

The kernel SHALL provide an operation that converts a set of live body handles into a single byte payload in OCCT's native shape serialization. The payload MUST represent exact B-Rep — topology together with its underlying curves and surfaces — and MUST NOT be a tessellated approximation. The operation MUST report which encoding it produced, so a reader never has to infer it. Serialization MUST NOT release, mutate, or otherwise disturb the bodies it serializes.

#### Scenario: Several bodies serialize into one payload

- **WHEN** a caller serializes two or more live bodies in a given order
- **THEN** a single byte payload is returned containing all of them, in that order, and every input handle remains valid and unchanged afterwards

#### Scenario: The encoding is named, not implied

- **WHEN** a serialization completes
- **THEN** the result identifies the encoding it wrote and the OCCT version that wrote it, so a later reader can record and check both

#### Scenario: Serializing an unknown handle

- **WHEN** a caller serializes a set that includes a `BodyId` that was never issued or has been released
- **THEN** the operation fails with an `InvalidHandle` error, no payload is produced, and no other body in the set is affected

#### Scenario: Serializing nothing

- **WHEN** a caller serializes an empty set of bodies
- **THEN** the operation succeeds and produces a payload that deserializes back to zero bodies, rather than failing or producing an unreadable payload

### Requirement: Byte payloads restore into live bodies

The kernel SHALL provide an operation that takes a previously produced byte payload and restores its contents as live bodies, issuing a fresh `BodyId` for each. Restored handles MUST be returned in the same order the bodies were serialized in, so a caller can bind them to identities it recorded. Restored handles MUST be indistinguishable in behavior from handles minted by a modeling operation, including for release, tessellation, inspection, further Booleans, and re-serialization.

#### Scenario: Order is preserved across the round trip

- **WHEN** a caller serializes bodies in a known order and then restores the payload
- **THEN** the returned handles correspond to the original bodies in that same order, and their count matches

#### Scenario: A restored body is an ordinary body

- **WHEN** a caller uses a restored handle as an operand to a Boolean, tessellates it, or releases it
- **THEN** it behaves exactly as a body created in this session would, with no restriction arising from how it entered the kernel

#### Scenario: Restored handles are new

- **WHEN** a payload is restored in the same session that produced it
- **THEN** the kernel issues new handles rather than reviving the original identifiers, and the original bodies, if still live, are unaffected

### Requirement: A serialization round trip preserves exact geometry

Restoring a serialized payload SHALL yield geometry that is exact, not approximate. Volume, surface area, topology counts, validity, closedness, and the analytic type of each surface MUST be preserved. A cylindrical face MUST return as an analytic cylinder rather than as a spline or faceted approximation of one, because a round trip that quietly degrades a surface would break the exactness claim every other capability depends on.

#### Scenario: Measurements survive the round trip

- **WHEN** a body is serialized and restored
- **THEN** the restored body reports the same volume and area within tolerance, the same face, edge, vertex, and solid counts, and the same validity and closedness as the original

#### Scenario: Analytic surfaces survive the round trip

- **WHEN** a body containing analytic surfaces — such as a drilled block whose hole wall is an exact cylinder — is serialized and restored
- **THEN** the restored body's face-type summary matches the original's, with the cylindrical face still reported as an analytic cylinder

#### Scenario: Restored geometry is usable for further exact modeling

- **WHEN** a Boolean is applied to a restored body
- **THEN** it succeeds and produces exact geometry, so a restored document can be edited rather than only viewed

### Requirement: Serialized bytes are opaque to the application

The byte payload SHALL be treated as opaque by every layer outside the kernel. The application layer MAY store the payload, hand it back to the kernel, measure its length, and hash it; it MUST NOT parse, edit, split, merge, or otherwise interpret its contents. No API SHALL be provided that exposes the payload's internal structure to JavaScript.

#### Scenario: The document layer routes bytes it does not understand

- **WHEN** the document layer saves and later reopens a checkpoint
- **THEN** it moves the payload between the kernel and storage without reading its contents, and the only properties it derives from it are its length and its checksum

#### Scenario: No parsing surface exists

- **WHEN** the kernel API surface is inspected
- **THEN** it offers no operation that returns topology, curves, or surfaces decoded from a payload, preserving the rule that exact geometry never materializes in JavaScript

### Requirement: A bad payload fails cleanly

Restoring a payload that is truncated, corrupt, empty, or not a valid B-Rep stream SHALL fail with a typed error. The kernel MUST remain usable, MUST NOT abort the WebAssembly module, and MUST NOT leave partially restored bodies reachable by a handle. Restoration is all-or-nothing: either every body in the payload is restored, or none is.

#### Scenario: Truncated payload

- **WHEN** a caller restores a payload whose bytes have been cut short
- **THEN** the operation fails with a typed error naming the operation, no handles are issued, the live-handle count is unchanged, and subsequent kernel operations succeed normally

#### Scenario: Payload that is not a B-Rep stream at all

- **WHEN** a caller restores arbitrary bytes that were never produced by the kernel
- **THEN** the operation fails with a typed error rather than crashing the module or producing a body with undefined geometry

#### Scenario: Failure partway through a multi-body payload

- **WHEN** restoration fails after some bodies in the payload have already been read
- **THEN** any bodies constructed so far are discarded before the error is reported, leaving no orphaned handles or leaked kernel memory

### Requirement: Serialization cost is measured

Serialization and restoration SHALL be instrumented like every other kernel operation, recording duration, and additionally recording the payload's byte length. The relationship between checkpoint size and the time to write or read it is a deliverable of this stage, so it MUST be retrievable from the operation log rather than inferred from wall-clock timing around the call.

#### Scenario: Payload size is recorded alongside duration

- **WHEN** a serialization or restoration completes
- **THEN** its operation-log entry carries the kernel-side duration, the caller-observed round trip, and the number of bytes in the payload

#### Scenario: Throughput is reportable against model size

- **WHEN** documents of differing complexity are serialized and restored
- **THEN** the recorded entries are sufficient to report throughput as a function of payload size, without additional instrumentation
