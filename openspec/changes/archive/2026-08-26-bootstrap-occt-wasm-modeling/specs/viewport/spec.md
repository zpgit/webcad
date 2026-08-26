## ADDED Requirements

### Requirement: Render tessellated bodies

The viewport SHALL render the tessellated representation of every visible body using WebGPU where available and WebGL2 otherwise, with shaded surfaces lit well enough to make solid form legible.

#### Scenario: Body appears after creation

- **WHEN** a body is created and tessellated
- **THEN** its shaded mesh appears in the viewport within the current camera view

#### Scenario: Renderer backend selection

- **WHEN** the viewport initializes in a browser supporting WebGPU
- **THEN** the WebGPU backend is used, and the active backend is reported so measurements can be attributed to it

#### Scenario: WebGL2 fallback

- **WHEN** the viewport initializes in a browser without WebGPU support
- **THEN** the WebGL2 backend is used and rendering behavior is equivalent

#### Scenario: No renderer available

- **WHEN** neither WebGPU nor WebGL2 can be initialized
- **THEN** the application reports an explicit unsupported-environment message instead of failing silently or rendering a blank canvas

### Requirement: Mesh buffers transfer into GPU resources without redundant copies

The path from tessellation output to GPU buffers SHALL avoid duplicating mesh data in the JavaScript heap beyond what the graphics API requires for upload. The architecture note's constraint against repeated copies between WASM memory and the JS heap applies to render data as well as geometry.

#### Scenario: Mesh uploaded to GPU buffers

- **WHEN** a tessellation result is handed to the viewport
- **THEN** its vertex, normal, and index data are uploaded into GPU buffers, and no additional long-lived JavaScript-side copy of the mesh is retained after upload

#### Scenario: GPU resources released with the body

- **WHEN** a body is removed from the scene or its handle is released
- **THEN** the GPU buffers allocated for its mesh are destroyed

### Requirement: Camera navigation

The viewport SHALL provide orbit, pan, and zoom navigation via pointer input, and a fit-to-view action that frames all visible bodies.

#### Scenario: Orbit

- **WHEN** the user drags with the primary orbit gesture
- **THEN** the camera rotates around the current target while the model remains stationary in world space

#### Scenario: Pan

- **WHEN** the user drags with the pan gesture
- **THEN** the camera translates in its view plane

#### Scenario: Zoom

- **WHEN** the user scrolls the wheel or uses a pinch gesture
- **THEN** the camera zooms toward or away from the cursor position without inverting through the target

#### Scenario: Fit to view

- **WHEN** the user triggers fit-to-view with at least one visible body
- **THEN** the camera is repositioned so all visible bodies fall within the frame

#### Scenario: Fit to view with an empty scene

- **WHEN** the user triggers fit-to-view with no visible bodies
- **THEN** the camera returns to a documented default position without error

### Requirement: Body-level selection

The viewport SHALL let the user select a whole body by clicking it, and SHALL support selecting two bodies so they can serve as the target and tool of a Boolean operation. Selection granularity is the body; face-level and edge-level selection are out of scope for this stage because they depend on topology identity that is not yet established.

#### Scenario: Select a body

- **WHEN** the user clicks on a rendered body
- **THEN** that body becomes selected and is visually distinguished from unselected bodies

#### Scenario: Select a second body

- **WHEN** the user adds a second body to the selection using the multi-select gesture
- **THEN** both bodies are selected in a defined order, so one can act as Boolean target and the other as tool

#### Scenario: Clicking empty space clears selection

- **WHEN** the user clicks where no body is rendered
- **THEN** the selection is cleared

#### Scenario: Selection resolves to a kernel handle

- **WHEN** a body is selected in the viewport
- **THEN** the selection resolves to the `BodyId` of the underlying canonical body, so a kernel operation can be invoked directly from the selection

### Requirement: Boundary measurements are surfaced in the UI

The application SHALL display the instrumentation MVP-0 exists to gather: per-operation wall-clock time, tessellation triangle counts, WASM memory in use and its peak, and the active render backend.

#### Scenario: Operation timing displayed

- **WHEN** a primitive creation, Boolean, or tessellation operation completes
- **THEN** its duration is displayed in the application's measurement readout

#### Scenario: Memory and mesh statistics displayed

- **WHEN** the user views the measurement readout
- **THEN** it shows current and peak WASM memory, the live body-handle count, and the total triangle count currently rendered
