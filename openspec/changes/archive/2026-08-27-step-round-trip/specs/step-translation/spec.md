## ADDED Requirements

### Requirement: STEP bytes translate into registered bodies

The kernel SHALL accept a caller-supplied STEP payload and translate it into bodies registered in its own handle space, returning handles alone. Translation MUST be a single explicit transaction: the payload is read, transferred into OCCT topology, inspected, and registered, or it fails as a whole. No STEP entity, assembly node, or attribute SHALL be exposed to JavaScript in any form — the caller learns what arrived through counts and scalar measurements, exactly as for a body created here.

#### Scenario: A single-part file imports as one body

- **WHEN** a caller imports a STEP file containing one solid
- **THEN** one `BodyId` is returned, its reported face, edge, and vertex counts and its volume are those of the solid the file describes, and no B-Rep structure is constructed on the JavaScript side

#### Scenario: A multi-part file imports as several bodies

- **WHEN** a caller imports a STEP file whose root is a compound or an assembly of several parts
- **THEN** one `BodyId` is returned per top-level shape, in a stable order, and the count of bodies is reported so the caller can address each one

#### Scenario: Translation reports what it produced

- **WHEN** an import completes
- **THEN** the result reports the number of bodies registered, the number of root shapes the file declared, and the payload's byte length, so a discrepancy between what the file contained and what became a body is visible rather than inferred

#### Scenario: STEP entities do not reach the caller

- **WHEN** the kernel API surface is inspected after import is added
- **THEN** no operation returns STEP entity identifiers, attribute records, or product-structure nodes, and the imported geometry is reachable only through handles

### Requirement: Units are normalized once, at the boundary, and both are reported

Length units SHALL be resolved during translation and nowhere else. Import MUST read the length unit the STEP file declares, convert coordinates into the application's working unit as part of the transfer, and report both — the unit the file declared, and the unit the resulting bodies are expressed in. Conversion happening exactly once, at the boundary, is what keeps units from leaking into modeling operations, the document, or the viewport, all of which MUST be able to assume a single working unit.

A file whose unit cannot be determined MUST be reported as undeclared, and the assumption applied in its place MUST be reported alongside it rather than left implicit. Export MUST write in a declared unit and report which one.

#### Scenario: A millimetre file reports both units

- **WHEN** a STEP file declaring millimetres is imported
- **THEN** the result reports millimetres as the file's declared unit and millimetres as the working unit, and the body's bounding box matches the file's coordinate values

#### Scenario: A non-millimetre file is converted once and says so

- **WHEN** a STEP file declaring a length unit other than millimetres is imported
- **THEN** the result reports that declared unit and the working unit separately, the body's bounding box reflects the converted values, and the conversion is attributable to translation rather than appearing as a fidelity loss

#### Scenario: An undeclared unit is reported with the assumption made

- **WHEN** a STEP file carries no determinable length unit
- **THEN** the result reports the declared unit as unknown and names the unit assumed in its place, so the document records an honest absence rather than a silent default

#### Scenario: No operation downstream of translation converts units

- **WHEN** an imported body is used in a Boolean, tessellated, checkpointed, or exported
- **THEN** no further unit conversion is applied at any of those points, and the numbers those operations report are in the single working unit

### Requirement: Shape processing is explicit, controllable, and reported

The kernel's STEP reader and writer run a shape-processing pass by default — on import a shape-fixing operation, and on export operations that split common vertices and reorient faces — and those passes change the topology and geometry that cross the boundary. This stage MUST NOT leave that behaviour implicit. Translation SHALL expose whether processing runs as a caller-controlled setting, MUST report which operations ran on each translation, and MUST default to the same setting in the application and in the fidelity comparison so the two are describing the same thing.

Because a processing pass is indistinguishable from a fidelity loss in the result, the fidelity comparison SHALL be performed **both with processing enabled and with it disabled**, and the difference attributed. The application's default MUST then be chosen on that evidence and the choice recorded, rather than inherited from the library because it was the default.

#### Scenario: Processing can be disabled and the effect is visible

- **WHEN** the same STEP file is imported once with shape processing enabled and once with it disabled
- **THEN** both imports succeed, each result reports which processing operations ran, and any difference in topology census, volume, or area between them is reported rather than averaged away

#### Scenario: Every translation reports what ran

- **WHEN** an import or export completes
- **THEN** its result names the shape-processing operations that were applied, so a later measurement can be attributed to translation, to processing, or to both

#### Scenario: The application's default is a recorded decision

- **WHEN** the shipped application imports a file
- **THEN** the processing setting it uses is the one the fidelity comparison recommended, and the reason is recorded alongside the measurement rather than left as a library default

### Requirement: An imported shape that is not a valid closed solid still arrives

Real STEP data contains shells, open solids, and shapes that fail a validity check. Import SHALL register such shapes as bodies and report their validity and closedness truthfully, rather than discarding them or refusing the whole file. A body whose validity or closedness is false MUST be flagged in the import result, so the caller knows before it attempts an operation that requires a solid. Import MUST NOT silently drop a root shape: a shape that cannot be registered at all MUST be counted and reported.

#### Scenario: An open shell imports and reports itself open

- **WHEN** a STEP file containing an unclosed shell is imported
- **THEN** a body is registered for it, its reported closedness is false, and the import result flags it as not a closed solid

#### Scenario: A dropped root shape is counted

- **WHEN** a root shape in the file cannot be registered as a body
- **THEN** the import result reports the count of shapes it could not register, and the bodies it did register remain usable

#### Scenario: An operation requiring a solid fails on its own terms

- **WHEN** a Boolean is attempted using an imported body that is not a valid closed solid
- **THEN** the operation fails with the kernel's typed error for that failure and the kernel remains usable, rather than the invalidity having been hidden at import time

### Requirement: Bodies export to STEP bytes carrying their current geometry

The kernel SHALL translate a caller-specified set of live bodies into a STEP payload and return it as opaque bytes. What is written MUST be the current canonical B-Rep of those bodies: if a body was edited after import, the export MUST contain the edited exact geometry, not the geometry as imported. Export MUST NOT tessellate, approximate, or pass geometry through a mesh.

#### Scenario: An edited body exports with the edit in it

- **WHEN** an imported body has a Boolean cut applied and the result is exported
- **THEN** the exported payload describes the cut geometry, and re-importing it yields a body whose volume matches the cut body rather than the original

#### Scenario: Analytic surfaces survive export

- **WHEN** a body with analytic cylindrical faces is exported and re-imported
- **THEN** the re-imported body's surface-type census still reports those faces as exact cylindrical surfaces rather than as splines or facets

#### Scenario: Export takes handles and returns bytes

- **WHEN** a caller exports bodies
- **THEN** the operation is invoked with handles alone, returns an opaque payload with its byte length reported, and every input handle remains valid and unchanged afterwards

#### Scenario: Exporting an unknown handle

- **WHEN** a caller exports a set that includes a `BodyId` that was never issued or has been released
- **THEN** the operation fails with an `InvalidHandle` error, no payload is produced, and no other body in the set is affected

### Requirement: What STEP carries beyond shape is dropped explicitly

This stage translates shape only. Assembly hierarchy, part names, colours, and materials that a STEP file may carry SHALL NOT be preserved, and the import result MUST report what was dropped rather than leaving the loss to be discovered. An assembly MUST import as flattened bodies. Preserving these semantics requires XCAF and is a later capability; the requirement here is that their absence is stated, not hidden.

#### Scenario: An assembly imports flattened, and says so

- **WHEN** a STEP file containing an assembly hierarchy is imported
- **THEN** its parts arrive as a flat set of bodies and the result reports that assembly structure was not preserved

#### Scenario: Names and colours are reported as dropped

- **WHEN** a STEP file carrying part names or colours is imported
- **THEN** the result reports that such data was present and not preserved, so the gap is attributable to this stage rather than to the file

#### Scenario: Export writes shape without inventing semantics

- **WHEN** bodies are exported
- **THEN** the payload describes their shapes, and no fabricated part names, colours, or assembly structure are written

### Requirement: Untranslatable input fails without damaging the kernel

A payload that is not STEP, is truncated, or yields no usable shape SHALL fail with a typed error naming the reason. A translation failure MUST NOT abort the WASM module, leave partially registered geometry reachable by a handle, or invalidate bodies that existed before the attempt. The kernel MUST serve subsequent operations normally.

#### Scenario: Bytes that are not STEP

- **WHEN** a caller imports a payload that is not a STEP file
- **THEN** the operation fails with a typed translation error, no handle is issued, and the kernel remains initialized and usable

#### Scenario: A truncated STEP file

- **WHEN** a caller imports a STEP payload cut short partway through
- **THEN** the operation fails with a typed error rather than registering the shapes it managed to read, so a partial import cannot be mistaken for a complete one

#### Scenario: A valid STEP file containing no shape

- **WHEN** a caller imports a syntactically valid STEP file that contains no transferable shape
- **THEN** the operation reports that outcome explicitly and issues no handle, distinct from a parse failure

#### Scenario: Bodies present before a failed import are unaffected

- **WHEN** an import fails while a document with several bodies is open
- **THEN** every pre-existing handle remains valid, the live-handle count is unchanged from before the attempt, and no memory is leaked to the failed translation

### Requirement: An imported body is an ordinary body

A body that entered the kernel through STEP translation SHALL be indistinguishable in capability from one created here. It MUST be usable as either operand of a Boolean, tessellatable, serializable into a checkpoint, restorable from one, exportable, and releasable, with no restriction arising from how it entered the kernel.

#### Scenario: An imported body is a Boolean operand

- **WHEN** an imported body is used as the target of a Boolean cut with a locally created cylinder
- **THEN** the operation behaves as it does for two locally created solids, and the result is an ordinary body

#### Scenario: An imported body survives a checkpoint

- **WHEN** a document containing imported bodies is checkpointed, and the checkpoint is restored
- **THEN** the restored bodies report the same topology census, volume, and area within tolerance as the imported bodies did, exactly as for locally created geometry

#### Scenario: An imported body releases like any other

- **WHEN** an imported body is released
- **THEN** its kernel memory is reclaimed and subsequent operations on the handle fail with `InvalidHandle`

### Requirement: Translation cost, size, and memory are measured

Both translation directions SHALL be instrumented on the same terms as every other kernel operation: wall-clock duration attributed to kernel execution and to transport, payload bytes moved, and WASM memory after completion. Because translating a multi-megabyte file is expected to be the most memory-intensive operation in the system, peak WASM memory during translation MUST be retrievable, so the module's memory ceiling is a measured limit rather than an assumed one.

#### Scenario: Import and export appear in the operation log

- **WHEN** an import or an export completes, successfully or with a failure
- **THEN** the operation log records its type, duration, and the payload byte count in the direction it moved

#### Scenario: Peak memory during translation is reported

- **WHEN** a multi-megabyte STEP file is imported
- **THEN** the peak WASM linear-memory figure observed during the session reflects the translation, so the memory cost per input megabyte can be related to the file size

#### Scenario: Translation cost is separable from tessellation cost

- **WHEN** an imported file is translated and then tessellated for display
- **THEN** the two costs are recorded as separate operations, so the time to first pixels can be attributed between translation and meshing
