# file-exchange Specification

## Purpose

Defines the browser end of interchange: how a file on a user's machine becomes
geometry in the session, and how geometry in the session becomes a file they can
hand to another CAD system.

The governing constraint is that the main thread reads bytes and nothing else. No
interchange format is parsed outside the kernel, which is what keeps translating
a multi-megabyte file from freezing the viewport - and is the same rule that put
the kernel in a Worker in the first place.

Two consequences shape the requirements below.

An import **adds to** the session rather than replacing it. Importing is not
opening: a user who has modelled something and then imports a part expects both,
and silently discarding their work would be the worse surprise.

A failure leaves the session exactly as it was. A file that is not what it
claimed to be is an ordinary outcome, not a reason to lose what is on screen, so
nothing is mutated until a translation has come back with geometry.

Sizes and durations are reported for both directions. That is what makes the
round trip's cost visible to the person paying it, and it is a deliverable of
this capability rather than a debugging aid.

## Requirements
### Requirement: A file chosen by the user becomes bodies in the session

The application SHALL let a user choose a `.step` or `.stp` file from their machine and import it into the current session. The bytes MUST travel to the kernel Worker for translation; the main thread MUST NOT parse, inspect, or transform the file's contents. The imported bodies MUST appear in the viewport and in the document on the same terms as bodies created here.

#### Scenario: Import puts geometry on screen

- **WHEN** a user chooses a STEP file to import
- **THEN** its bodies are translated, tessellated, and rendered in the current camera view, and the document lists them

#### Scenario: The main thread does not read the file

- **WHEN** a file is imported
- **THEN** the main thread reads it only as bytes to hand to the Worker, and no STEP text is parsed outside the kernel

#### Scenario: Import adds to the session rather than replacing it

- **WHEN** a user imports a file while bodies already exist in the session
- **THEN** the imported bodies are added alongside them, and no existing body is removed or released

### Requirement: An export is delivered as a downloadable file

The application SHALL let a user export the current model and receive it as a file with a `.step` extension and a name derived from the document. The bytes returned by the kernel MUST be written to the download unmodified. Export MUST be possible for a session whose bodies were created here, imported, or both.

#### Scenario: Export downloads the kernel's bytes

- **WHEN** a user exports the current model
- **THEN** a download is offered whose contents are byte-identical to the payload the kernel produced, named after the document with a `.step` extension

#### Scenario: A locally authored model exports

- **WHEN** a session containing only locally created primitives and Boolean results is exported
- **THEN** the export succeeds, so STEP export is not conditional on having imported anything

#### Scenario: Exporting an empty session is refused clearly

- **WHEN** a user exports a session containing no bodies
- **THEN** the action reports that there is nothing to export and produces no empty download

### Requirement: Translating a large file leaves the interface responsive

Because translation is expected to be the longest operation in the system, the interface SHALL remain interactive throughout it. The camera MUST keep responding and already-rendered bodies MUST keep drawing while a translation is in flight. The longest main-thread task attributable to an import or export MUST stay within one frame budget.

#### Scenario: Camera navigation during a translation

- **WHEN** a user orbits the viewport while a multi-megabyte STEP file is being imported
- **THEN** the camera responds continuously and the existing geometry keeps drawing

#### Scenario: The interface reports that work is in progress

- **WHEN** an import or export has been started and has not yet finished
- **THEN** the interface shows that translation is running and does not present the action as available a second time concurrently

#### Scenario: Main-thread cost stays within a frame

- **WHEN** the largest available fixture is imported
- **THEN** the longest single main-thread task attributable to the import stays within one frame budget

### Requirement: A file that cannot be translated leaves the session intact

A failed import SHALL report the reason in the interface and leave the open document exactly as it was. Nothing MUST be added to the document, no body MUST be released, and the session MUST remain usable for further operations including another import.

#### Scenario: Choosing a file that is not STEP

- **WHEN** a user chooses a file that is not a STEP file
- **THEN** the failure is reported with its reason, the document is unchanged, and the user can immediately choose another file

#### Scenario: A failed import leaves no partial bodies

- **WHEN** an import fails after the bytes reached the kernel
- **THEN** no body from that file appears in the viewport or the document, and the live-handle count returns to what it was before the attempt

#### Scenario: A failed export does not discard the model

- **WHEN** an export fails
- **THEN** the reason is reported, no download is offered, and every body in the session remains present and unmodified

### Requirement: Sizes and durations of an exchange are reported

The application SHALL surface, for each import and export, the payload's byte size and the wall-clock duration of the translation, alongside the existing operation measurements. This is what makes the round trip's cost visible to a user and comparable across files, and it is a deliverable of this stage rather than a debugging aid.

#### Scenario: Import size and duration are shown

- **WHEN** an import completes
- **THEN** the interface reports the file's byte size, the number of bodies produced, and how long translation took

#### Scenario: Export size is shown

- **WHEN** an export completes
- **THEN** the interface reports the byte size of the payload that was written and how long producing it took

#### Scenario: A round trip is comparable end to end

- **WHEN** a file is imported, edited, and exported
- **THEN** the reported sizes and durations for both directions are retrievable together, so the round trip can be summarized without re-running it

