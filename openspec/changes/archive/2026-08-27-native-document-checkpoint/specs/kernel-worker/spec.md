## ADDED Requirements

### Requirement: Binary payloads cross into the Worker as owned transferable buffers

Caller-supplied binary payloads SHALL cross from the main thread into the Worker as transferable `ArrayBuffer`s whose ownership moves to the Worker. Until now the protocol has transferred only outbound; the inbound direction MUST follow the same ownership discipline. After a request carrying a transferred buffer is sent, the sender MUST NOT read or reuse that buffer, and the caller-facing API MUST make that transfer of ownership explicit rather than leaving a detached buffer as a surprise.

#### Scenario: An inbound payload is transferred, not cloned

- **WHEN** the main thread sends a restoration request carrying a serialized payload
- **THEN** the payload's buffer is listed as a transferable, and the main thread's view of it is detached afterwards

#### Scenario: Ownership transfer is visible to the caller

- **WHEN** a caller passes a payload to an operation that transfers it
- **THEN** the API documents and behaves consistently with the buffer becoming unusable to the caller, so a caller that needs to keep the bytes knows it must copy them first

#### Scenario: A failed request does not strand the payload

- **WHEN** a request carrying a transferred payload fails inside the Worker
- **THEN** the caller is rejected with a typed error, the Worker retains no reference to the transferred buffer, and the kernel remains able to serve subsequent requests

### Requirement: Large payloads do not weaken ordering or responsiveness

Requests carrying binary payloads SHALL obey the same serial execution order as every other request, and MUST NOT be reordered, batched, or split by the transport. A payload large enough to make its transfer observable MUST still leave the main thread responsive, since the reason the kernel runs in a Worker is that long operations must not block rendering or input.

#### Scenario: A payload-carrying request keeps its place in the queue

- **WHEN** a restoration request is issued between other kernel requests without awaiting them
- **THEN** it executes in the order issued, and the resulting handle state matches sequential execution

#### Scenario: Main thread stays responsive across a large payload

- **WHEN** a checkpoint large enough to take tens of milliseconds to restore is sent into the Worker
- **THEN** the main thread continues to service rendering and input, and the longest main-thread task attributable to the request stays within one frame budget
