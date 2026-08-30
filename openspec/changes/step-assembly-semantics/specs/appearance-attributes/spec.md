## ADDED Requirements

### Requirement: Colour is read at part, instance, and face level

Import SHALL read colour from the source file wherever the format carries it: on a part, on an occurrence of that part, and on individual faces. Colour SHALL be carried as an RGB triple in a stated colour space, as plain data. No styling entity, attribute record, or label from the source file SHALL be exposed.

#### Scenario: A part's colour arrives with it

- **WHEN** a file assigning a colour to a part is imported
- **THEN** the part carries that colour, and the viewport renders it instead of the default surface colour

#### Scenario: An occurrence's own colour arrives with it

- **WHEN** a file colours one occurrence of a part differently from the part itself
- **THEN** that instance carries its own colour and its siblings do not

#### Scenario: Face colours arrive with the part that owns them

- **WHEN** a file colours individual faces of a part
- **THEN** those faces render in their own colours, and the count of coloured faces is reported

#### Scenario: No styling entity reaches the caller

- **WHEN** the kernel and document APIs are inspected after this capability is added
- **THEN** colour appears only as numeric triples attached to a part, an instance, or a face position, and no source-file styling entity is reachable

### Requirement: An effective colour resolves face, then instance, then part, then default

The colour used to render a face SHALL be the first of: that face's colour, the colour of the instance being drawn, the colour of the part, the viewport's default surface colour. Instance over part is what allows one occurrence to be recoloured without affecting its siblings.

Resolution MUST be a display-time computation. The resolved value SHALL NOT be written back onto the part, the instance, or the face.

#### Scenario: An instance colour overrides its part's

- **WHEN** a part is blue and one of its instances is red
- **THEN** that instance renders red, other instances render blue, and the part's stored colour is still blue

#### Scenario: A face colour overrides both

- **WHEN** a part is blue, its instance is red, and one of its faces is green
- **THEN** that face renders green in every instance and the remaining faces follow the instance rule

#### Scenario: An uncoloured part falls through to the default

- **WHEN** a part, its instances, and its faces carry no colour
- **THEN** it renders in the viewport's default surface colour, indistinguishable from geometry created here

#### Scenario: Resolution does not mutate stored appearance

- **WHEN** a document with resolved colours is saved and reopened
- **THEN** the stored colours are the ones that were read, and no resolved value has been written down as if the file had declared it

### Requirement: A face-colour map is positional, checksummed, and never a reference

A part's face colours SHALL be stored as an ordered map keyed by the face's position in a single, documented exploration order of that part's shape, together with the face count the map was built against. On restore, a face count that disagrees with the map MUST refuse the map — reporting the loss — rather than apply it to a shape it does not describe.

This positional key SHALL be fenced from becoming a downstream reference:

1. No API SHALL return a face index, a face identity, or a face handle to a caller. Colour reaches the renderer as vertex data and as index ranges into a mesh, neither of which is addressable as an identity.
2. Nothing SHALL recompute geometry, resolve a selection, or drive an operation from a face position.
3. The map SHALL be display data with a stated lifetime, and the lifetime SHALL be stated wherever it is stored.

The exploration order's stability across a checkpoint round trip MUST be established by measurement before per-face colour depends on it. If it is not stable, per-face colour SHALL be reported as dropped rather than reapplied on an assumption.

#### Scenario: A face-colour map survives a checkpoint

- **WHEN** a part with coloured faces is saved and reopened
- **THEN** the same faces carry the same colours, and the recorded face count matches the restored shape

#### Scenario: A map that no longer fits is refused, not stretched

- **WHEN** a stored face-colour map records a different face count than the restored part has
- **THEN** the map is discarded, the loss is reported naming the part, and no colour is applied to a face by position

#### Scenario: No face identity escapes

- **WHEN** the kernel, document, and viewport APIs are inspected
- **THEN** none of them returns a face index or face identity, and face colour is reachable only as mesh vertex data and index ranges

#### Scenario: Order stability is measured, not assumed

- **WHEN** the stage's findings are published
- **THEN** they state whether the checkpoint preserves face exploration order, on what evidence, and what per-face colour does if it does not

### Requirement: A topology change drops the face-colour map and says so

Any operation that changes a part's topology SHALL discard that part's face-colour map and report the discard. The map MUST NOT be migrated, re-derived, or reapplied to the new shape's faces by position. A part's own colour and its instances' colours are unaffected, because neither is keyed to a face.

#### Scenario: A Boolean drops the face colours of the part it edits

- **WHEN** a Boolean is applied to a part carrying face colours
- **THEN** the result has no face colours, the drop is reported naming the part, and the part's shape-level colour still applies

#### Scenario: Untouched parts keep their face colours

- **WHEN** one part in an assembly is edited
- **THEN** every other part's face colours are unchanged

#### Scenario: A dropped map is not silently re-indexed

- **WHEN** an edited part happens to have the same face count as before
- **THEN** the old map is still discarded rather than reapplied, because an equal count is not evidence of the same faces

### Requirement: Colour reaches the renderer without multiplying draw work

Per-face colour SHALL be delivered to the render path as vertex attributes accompanied by per-face index ranges, so that a part with many colours is still one mesh and one draw per instance. Colour MUST NOT require a separate draw call, material, or geometry per colour.

#### Scenario: A multi-coloured part draws once per instance

- **WHEN** a part with a dozen face colours is rendered in five instances
- **THEN** the renderer issues one draw per instance, and the mesh data exists once

#### Scenario: Colour is allocated only where it exists

- **WHEN** a part carries no face colours
- **THEN** no per-vertex colour buffer is allocated for it, and its byte cost is what it was before this capability

### Requirement: Export writes the appearance it holds and invents none

Export SHALL write the colours the document holds — part, instance, and face — into the payload where the format carries them. It MUST NOT fabricate a colour for something that has none, and MUST NOT write a display-time resolved colour as though the model declared it.

#### Scenario: Colours round-trip

- **WHEN** an assembly with part, instance, and face colours is exported and re-imported
- **THEN** the same colours arrive at the same levels, and the counts are reported so a loss at any level is visible

#### Scenario: Uncoloured geometry exports uncoloured

- **WHEN** a session of locally authored bodies with no colour is exported
- **THEN** the payload carries no colour entities, and the viewport's default is not written into the file as a declared colour

### Requirement: Appearance data this capability does not model is dropped explicitly

Materials, textures, transparency, reflectance, layers, and presentation styles beyond colour SHALL NOT be preserved, and their presence in an imported file MUST be reported as dropped rather than left to be discovered. Export MUST NOT fabricate any of them.

#### Scenario: A file's materials are reported as dropped

- **WHEN** a file carrying material or transparency definitions is imported
- **THEN** the result reports that such data was present and not preserved, naming what it was, so the gap is attributable to this stage rather than to the file

#### Scenario: The drop list is specific, not wholesale

- **WHEN** an import report is read
- **THEN** it distinguishes what was preserved (structure, names, colour) from what was dropped (materials, textures, transparency, layers, and the rest), rather than reporting a single undifferentiated loss
