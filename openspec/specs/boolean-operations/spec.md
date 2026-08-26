# boolean-operations Specification

## Purpose

Defines union, subtract, and intersect over canonical bodies, and the outcome
vocabulary they answer with.

Booleans are where exactness is most easily lost. The requirement that analytic
surfaces contributed by the operands remain analytic in the result is the real
test: a drilled hole whose wall is still an exact cylinder proves the operation
worked on B-Rep rather than on an approximation.

The central distinction here is between an operation that *failed* and one that
legitimately produced *no geometry*. A tool that fully encloses its target, or
an intersect of disjoint solids, is a correct direct-modeling outcome with an
empty result — modelling those as errors would make correct behaviour look like
a defect. Disjoint union is the mirror case: a successful multi-solid result
rather than a rejection.

Operand lifetime is caller-owned and operations never implicitly release their
inputs, which is what makes chaining safe and keeps the ownership rules
consistent with `geometry-kernel`.

## Requirements
### Requirement: Boolean union, subtract, and intersect

The kernel SHALL provide union, subtract, and intersect operations over canonical bodies. Each operation accepts a target `BodyId` and a tool `BodyId` and returns a new `BodyId` referencing the exact B-Rep result. Results MUST be exact geometry, never a mesh approximation.

#### Scenario: Union of two overlapping solids

- **WHEN** a caller unions two overlapping solids
- **THEN** a new `BodyId` is returned referencing a single valid closed solid whose volume is less than the sum of the operand volumes, reflecting the removed overlap

#### Scenario: Subtract producing a modified solid

- **WHEN** a caller subtracts a cylinder that partially overlaps a box, as in drilling a hole
- **THEN** a new `BodyId` is returned whose volume equals the box volume minus the intersection volume within kernel tolerance, and whose faces include the exact cylindrical surface introduced by the tool

#### Scenario: Intersect of two overlapping solids

- **WHEN** a caller intersects two overlapping solids
- **THEN** a new `BodyId` is returned referencing the common volume as a valid solid

#### Scenario: Result is exact, not tessellated

- **WHEN** any Boolean result is inspected for the surface types of its faces
- **THEN** analytic surfaces contributed by the operands remain analytic in the result, confirming the operation preserved exact geometry

### Requirement: Boolean operand validation

Boolean operations SHALL validate their operands before executing. Invalid handles, non-solid operands, and self-referencing operations MUST be rejected with typed errors, and MUST NOT mutate kernel state.

#### Scenario: Invalid operand handle

- **WHEN** a Boolean operation is invoked with a `BodyId` that was never issued or has been released
- **THEN** the operation fails with `InvalidHandle` and no result body is created

#### Scenario: Target and tool are the same body

- **WHEN** a Boolean operation is invoked with the same `BodyId` as both target and tool
- **THEN** the operation fails with an `InvalidParameter` error rather than producing a degenerate or empty result

### Requirement: Degenerate and empty Boolean results

The kernel SHALL distinguish an operation that failed from an operation that legitimately produced no geometry. When operands do not interact in a way that yields a solid, the caller MUST be able to tell that outcome apart from a kernel error.

#### Scenario: Subtract that removes all material

- **WHEN** a caller subtracts a tool that fully encloses the target
- **THEN** the operation reports an empty result explicitly, and does not return a handle to an empty or invalid body

#### Scenario: Intersect of disjoint solids

- **WHEN** a caller intersects two solids that do not overlap
- **THEN** the operation reports an empty result explicitly rather than failing with a kernel error

#### Scenario: Union of disjoint solids

- **WHEN** a caller unions two solids that do not touch
- **THEN** the operation succeeds and returns a body containing both disjoint volumes, reported as a multi-solid result rather than being rejected

#### Scenario: Boolean failure surfaced as a typed error

- **WHEN** the underlying OCCT Boolean algorithm reports failure for operands it cannot process
- **THEN** the operation rejects with a typed error carrying the kernel's failure reason, the operand handles remain valid, and the kernel remains usable

### Requirement: Operand lifetime is caller-owned

A Boolean operation SHALL NOT implicitly release its operand bodies. The operand handles MUST remain valid after the operation so callers can retain, reuse, or explicitly release them.

#### Scenario: Operands survive the operation

- **WHEN** a Boolean operation completes successfully
- **THEN** both operand `BodyId` values remain valid and usable in subsequent operations, alongside the newly returned result handle

#### Scenario: Chained Booleans

- **WHEN** the result of one Boolean operation is used as the target of a second Boolean operation
- **THEN** the second operation succeeds, and the intermediate result handle remains valid until the caller releases it

