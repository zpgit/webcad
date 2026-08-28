## MODIFIED Requirements

### Requirement: Handle-based operation API

The kernel SHALL expose modeling operations as functions that accept and return handles, in the shape `kernel.<operation>({ ...handles, ...parameters })`. Operations MUST NOT require the caller to pass or receive materialized B-Rep representations.

There are exactly two bounded exceptions to what may be passed, and both are byte payloads rather than representations:

1. An **opaque serialized payload**, as defined above. The caller cannot construct one, inspect one, or derive one from anything but a prior kernel serialization.
2. A **foreign interchange payload** — the bytes of a file in a published exchange format, which the caller *can* construct because they come from outside this system. It is admitted only to a translation operation, never to a modeling one, and admitting it MUST NOT weaken the outbound rule: a translation MAY consume foreign bytes, but every operation that returns geometry still returns handles, and no operation exposes the entities, attributes, or product structure a foreign payload contains.

No modeling operation SHALL accept geometry in any other non-handle form.

#### Scenario: Operation invoked by handle

- **WHEN** a caller invokes a Boolean operation passing two `BodyId` handles and no geometric payload
- **THEN** the operation executes inside WASM against the referenced shapes and returns a `BodyId` for the result

#### Scenario: Unknown handle rejected

- **WHEN** a caller passes a `BodyId` that was never issued by this kernel instance, or that has already been released
- **THEN** the operation fails with an `InvalidHandle` error and no geometry state is mutated

#### Scenario: Serialization takes handles and returns bytes

- **WHEN** a caller serializes bodies
- **THEN** the operation is invoked with handles alone and returns an opaque payload, and restoring that payload returns handles alone

#### Scenario: Translation is the only consumer of foreign bytes

- **WHEN** the kernel API surface is inspected
- **THEN** the only operations accepting a caller-constructed interchange payload are translation operations, and no primitive, Boolean, tessellation, or inspection operation accepts one

#### Scenario: Translating foreign bytes still returns handles

- **WHEN** a caller hands the kernel a foreign interchange payload to translate
- **THEN** the geometry is constructed inside WASM and reported as handles, and the payload's internal entities are never surfaced as JavaScript structures

#### Scenario: Modeling operations still refuse non-handle geometry

- **WHEN** the kernel API surface is inspected
- **THEN** no primitive, Boolean, tessellation, or inspection operation accepts geometry as anything but a handle
