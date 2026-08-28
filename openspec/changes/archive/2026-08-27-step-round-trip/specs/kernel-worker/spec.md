## MODIFIED Requirements

### Requirement: Binary payloads cross into the Worker as owned transferable buffers

Caller-supplied binary payloads SHALL cross from the main thread into the Worker as transferable `ArrayBuffer`s whose ownership moves to the Worker. The inbound direction MUST follow the same ownership discipline as the outbound one. After a request carrying a transferred buffer is sent, the sender MUST NOT read or reuse that buffer, and the caller-facing API MUST make that transfer of ownership explicit rather than leaving a detached buffer as a surprise.

This discipline applies identically whether the inbound payload is one the kernel itself wrote — a checkpoint being restored — or a **foreign** payload the caller obtained from outside the system, such as the bytes of a file chosen by a user. A foreign payload MUST NOT be trusted to be well-formed, and the buffer MUST be released on a failed translation exactly as on a successful one.

#### Scenario: An inbound payload is transferred, not cloned

- **WHEN** the main thread sends a restoration request carrying a serialized payload
- **THEN** the payload's buffer is listed as a transferable, and the main thread's view of it is detached afterwards

#### Scenario: A foreign payload is transferred on the same terms

- **WHEN** the main thread sends a translation request carrying the bytes of a user-chosen file
- **THEN** that buffer is transferred rather than cloned, and the main thread's view of it is detached afterwards

#### Scenario: Ownership transfer is visible to the caller

- **WHEN** a caller passes a payload to an operation that transfers it
- **THEN** the API documents and behaves consistently with the buffer becoming unusable to the caller, so a caller that needs to keep the bytes knows it must copy them first

#### Scenario: A failed request does not strand the payload

- **WHEN** a request carrying a transferred payload fails inside the Worker
- **THEN** the caller is rejected with a typed error, the Worker retains no reference to the transferred buffer, and the kernel remains able to serve subsequent requests

#### Scenario: A malformed foreign payload is released, not retained

- **WHEN** a translation of foreign bytes fails because the payload was not well-formed
- **THEN** the bytes are released inside the Worker, the kernel's reported memory returns to its pre-request level, and a subsequent translation of a valid payload succeeds

### Requirement: Large payloads do not weaken ordering or responsiveness

Requests carrying binary payloads SHALL obey the same serial execution order as every other request, and MUST NOT be reordered, batched, or split by the transport. A payload large enough to make its transfer observable MUST still leave the main thread responsive, since the reason the kernel runs in a Worker is that long operations must not block rendering or input.

Only one binary payload SHALL be in flight across the boundary at a time, in either direction. This invariant is what makes payload ownership answerable at a glance, and it MUST be enforced rather than assumed: a request that would put a second payload in flight MUST be queued behind the first, or refused with a typed error, and MUST NOT overwrite a payload the kernel is still using.

#### Scenario: A payload-carrying request keeps its place in the queue

- **WHEN** a restoration request is issued between other kernel requests without awaiting them
- **THEN** it executes in the order issued, and the resulting handle state matches sequential execution

#### Scenario: Main thread stays responsive across a large payload

- **WHEN** a checkpoint large enough to take tens of milliseconds to restore is sent into the Worker
- **THEN** the main thread continues to service rendering and input, and the longest main-thread task attributable to the request stays within one frame budget

#### Scenario: A second payload cannot displace one in flight

- **WHEN** a payload-carrying request is issued while another payload-carrying request has not completed
- **THEN** the second is queued behind the first or rejected with a typed error, and the payload the kernel is working on is neither overwritten nor truncated

#### Scenario: Main thread stays responsive across a multi-megabyte translation

- **WHEN** a multi-megabyte file's bytes are sent into the Worker to be translated
- **THEN** the main thread continues to service rendering and input for the whole translation, and the longest main-thread task attributable to it stays within one frame budget
