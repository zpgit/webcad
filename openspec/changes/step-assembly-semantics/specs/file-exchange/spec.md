## MODIFIED Requirements

### Requirement: A file chosen by the user becomes bodies in the session

The application SHALL let a user choose a `.step` or `.stp` file from their machine and import it into the current session. The bytes MUST travel to the kernel Worker for translation; the main thread MUST NOT parse, inspect, or transform the file's contents. The imported bodies MUST appear in the viewport and in the document on the same terms as bodies created here.

Where the file carries product structure, the session SHALL receive it: the parts appear at their placements, the hierarchy and names are shown, and the colours are applied. What the import preserved and what it dropped MUST both be reported — instance count, tree depth, named and coloured entities preserved, and the categories that were not — so that a loss is attributable rather than discovered later.

#### Scenario: Import puts geometry on screen

- **WHEN** a user chooses a STEP file to import
- **THEN** its bodies are translated, tessellated, and rendered in the current camera view, and the document lists them

#### Scenario: An assembly arrives positioned and named

- **WHEN** a user imports an assembly
- **THEN** its parts appear at their placements rather than stacked at the origin, and the structure is presented with the names and colours the file carried

#### Scenario: The report distinguishes preserved from dropped

- **WHEN** an import of a file carrying structure, colours, and materials completes
- **THEN** the session reports the structure and colours it preserved and names the categories it dropped, rather than reporting a single undifferentiated loss

#### Scenario: The main thread does not read the file

- **WHEN** a file is imported
- **THEN** the main thread reads it only as bytes to hand to the Worker, and no STEP text is parsed outside the kernel

#### Scenario: Import adds to the session rather than replacing it

- **WHEN** a user imports a file while bodies already exist in the session
- **THEN** the imported bodies are added alongside them, no existing body is removed or released, and an imported assembly's structure is added without reparenting anything that was already there

### Requirement: An export is delivered as a downloadable file

The application SHALL let a user export the current model and receive it as a file with a `.step` extension and a name derived from the document. The bytes returned by the kernel MUST be written to the download unmodified. Export MUST be possible for a session whose bodies were created here, imported, or both.

Where the session holds an instance tree, the export SHALL carry it, along with names and colours, so that a file imported with structure exports with structure. A session with no tree exports flat, and no hierarchy is fabricated for it.

#### Scenario: Export downloads the kernel's bytes

- **WHEN** a user exports the current model
- **THEN** a download is offered whose contents are byte-identical to the payload the kernel produced, named after the document with a `.step` extension

#### Scenario: An imported assembly exports as an assembly

- **WHEN** a user imports an assembly, edits nothing, and exports
- **THEN** the downloaded file carries the same instance count, hierarchy, names, and colours, and re-importing it reports the same structure

#### Scenario: A locally authored model exports

- **WHEN** a session containing only locally created primitives and Boolean results is exported
- **THEN** the export succeeds, so STEP export is not conditional on having imported anything

#### Scenario: A flat session exports flat

- **WHEN** a session with no instance tree is exported
- **THEN** the payload describes its bodies without a fabricated hierarchy or invented occurrence names

#### Scenario: Exporting an empty session is refused clearly

- **WHEN** a user exports a session containing no bodies
- **THEN** the action reports that there is nothing to export and produces no empty download
