# solid-primitives Specification

## Purpose

Defines how exact B-Rep solids enter the system: the box and cylinder
primitives, and the guarantee that a primitive is validated as a closed solid
before a handle is issued.

The cylinder carries the load here. Its lateral face must report as an analytic
cylindrical surface, not a fine faceting, which is the observable difference
between an exact kernel and a mesh modeler and the reason primitives are
specified separately from `tessellation`.

Primitives are also specified as indistinguishable from bodies produced any
other way. Downstream operations must not be able to tell how a body
originated — that is what lets `boolean-operations` chain over its own results
without a special case, and what will let imported geometry join the same pool
later without reopening this spec.

## Requirements
### Requirement: Create a box solid

The kernel SHALL create an exact B-Rep box solid from three positive dimensions and a placement, returning a `BodyId`. The resulting body MUST be a closed, valid solid with six planar faces.

#### Scenario: Box created from dimensions

- **WHEN** a caller requests a box with width, depth, and height all positive
- **THEN** a `BodyId` is returned referencing a closed solid with 6 faces, 12 edges, and 8 vertices, whose volume equals width × depth × height within kernel tolerance

#### Scenario: Box created at a placement

- **WHEN** a caller requests a box with an origin and orientation
- **THEN** the resulting solid's bounding box reflects that placement, and its dimensions are unchanged by the transform

#### Scenario: Non-positive dimension rejected

- **WHEN** a caller requests a box where any of width, depth, or height is zero or negative
- **THEN** the call fails with an `InvalidParameter` error naming the offending dimension, and no body handle is created

### Requirement: Create a cylinder solid

The kernel SHALL create an exact B-Rep cylinder solid from a positive radius, a positive height, and a placement, returning a `BodyId`. The resulting body MUST be a closed, valid solid whose lateral surface is an exact analytic cylindrical surface rather than a faceted approximation.

#### Scenario: Cylinder created from radius and height

- **WHEN** a caller requests a cylinder with positive radius and height
- **THEN** a `BodyId` is returned referencing a closed solid with 3 faces — one cylindrical and two planar caps — whose volume equals π × radius² × height within kernel tolerance

#### Scenario: Lateral surface is analytic

- **WHEN** a cylinder body is created and its lateral face's surface type is queried
- **THEN** the surface is reported as an exact cylindrical surface, confirming that the primitive carries exact geometry and not tessellated geometry

#### Scenario: Cylinder created at a placement

- **WHEN** a caller requests a cylinder with an origin and axis direction
- **THEN** the resulting solid is positioned and oriented accordingly, and its radius and height are unchanged by the transform

#### Scenario: Non-positive radius or height rejected

- **WHEN** a caller requests a cylinder with a radius or height that is zero or negative
- **THEN** the call fails with an `InvalidParameter` error naming the offending parameter, and no body handle is created

### Requirement: Primitives are registered as canonical bodies

Every primitive the kernel creates SHALL be registered as a canonical body indistinguishable, to downstream operations, from a body produced by any other means. Downstream operations MUST NOT need to know how a body originated.

#### Scenario: Primitive consumed by a downstream operation

- **WHEN** a Boolean or tessellation operation is invoked on a `BodyId` produced by a primitive
- **THEN** the operation accepts the handle and behaves identically to how it behaves for a body produced by a prior Boolean operation

#### Scenario: Primitive validity is verified on creation

- **WHEN** a primitive is created
- **THEN** the kernel verifies the result is a valid closed solid before issuing a handle, and fails the creation with a typed error if validation does not pass

