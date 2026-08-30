## MODIFIED Requirements

### Requirement: Render tessellated bodies

The viewport SHALL render the tessellated representation of every visible body using WebGPU where available and WebGL2 otherwise, with shaded surfaces lit well enough to make solid form legible.

Where a body is referenced by instances, the viewport SHALL draw it once per instance, applying each instance's composed placement, and MUST share one copy of the mesh data between them. Per-face colour SHALL be applied as vertex attributes so that a multi-coloured body remains one draw per instance.

#### Scenario: Body appears after creation

- **WHEN** a body is created and tessellated
- **THEN** its shaded mesh appears in the viewport within the current camera view

#### Scenario: Instances appear at their placements

- **WHEN** a body referenced by several instances is displayed
- **THEN** each instance appears at its own composed placement, and the mesh data exists in one copy regardless of how many instances there are

#### Scenario: Renderer backend selection

- **WHEN** the viewport initializes in a browser supporting WebGPU
- **THEN** the WebGPU backend is used, and the active backend is reported so measurements can be attributed to it

#### Scenario: WebGL2 fallback

- **WHEN** the viewport initializes in a browser without WebGPU support
- **THEN** the WebGL2 backend is used and rendering behavior is equivalent

#### Scenario: No renderer available

- **WHEN** neither WebGPU nor WebGL2 can be initialized
- **THEN** the application reports an explicit unsupported-environment message instead of failing silently or rendering a blank canvas

### Requirement: Body-level selection

The viewport SHALL let the user select a whole body by clicking it, and SHALL support selecting two bodies so they can serve as the target and tool of a Boolean operation. Selection granularity is the body; face-level and edge-level selection are out of scope for this stage because they depend on topology identity that is not yet established.

Where a body is instanced, a click SHALL resolve to the **instance** that was drawn, and the body SHALL be reachable from it. Only the clicked instance is highlighted, so that "which occurrence" has a visible answer. An operation invoked from a selection whose body is shared by more than one instance MUST NOT proceed on a guess — see `assembly-structure` — and the viewport SHALL make the instance count visible in the selection.

#### Scenario: Select a body

- **WHEN** the user clicks on a rendered body
- **THEN** that body becomes selected and is visually distinguished from unselected bodies

#### Scenario: Select one occurrence of an instanced body

- **WHEN** the user clicks one of twenty instances of a body
- **THEN** that instance is highlighted, its siblings are not, and the selection reports both the instance and the body it references

#### Scenario: Select a second body

- **WHEN** the user adds a second body to the selection using the multi-select gesture
- **THEN** both bodies are selected in a defined order, so one can act as Boolean target and the other as tool

#### Scenario: Clicking empty space clears selection

- **WHEN** the user clicks where no body is rendered
- **THEN** the selection is cleared

#### Scenario: Selection resolves to a kernel handle

- **WHEN** a body is selected in the viewport
- **THEN** the selection resolves to the `BodyId` of the underlying canonical body, so a kernel operation can be invoked directly from the selection

#### Scenario: A shared selection says it is shared

- **WHEN** the user selects an instance whose body is referenced by more than one instance
- **THEN** the selection reports how many instances share that body, before any operation is attempted
