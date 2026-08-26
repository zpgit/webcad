# viewport Specification

## Purpose

Defines what the user sees and manipulates: rendering tessellated bodies,
navigating the camera, selecting bodies, and surfacing the boundary
measurements.

The rendering path is specified in terms of copies rather than visual quality.
Mesh data reaches GPU buffers without a long-lived JavaScript copy surviving the
upload, which extends the no-redundant-copies constraint from geometry to render
data. Backend selection prefers WebGPU and falls back to WebGL2, with an
explicit unsupported-environment message rather than a silently blank canvas.

Selection granularity is deliberately the whole body. Face and edge selection
would mint durable references to sub-entities, and stable references across
topology changes is the known hard problem this stage does not attempt — so the
spec forecloses it rather than leaving it to be added casually. Body-level
picking resolves to a `BodyId`, which is what lets a Boolean be invoked straight
from the selection.

The measurement readout is a requirement, not a debug panel. It is how
main-thread blocking becomes observable rather than assumed absent.

## Requirements
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

The path from tessellation output to GPU buffers SHALL avoid duplicating mesh data in the JavaScript heap beyond what the graphics API requires for upload. The architecture note's constraint against repeated copies between WASM memory and the JS heap applies to render data as well as geometry. Because the kernel runs in a Worker and hands the viewport buffers it already owns, the viewport SHALL adopt those buffers directly rather than copying them again: the ownership transfer replaces the copy, it does not add to it.

#### Scenario: Mesh uploaded to GPU buffers

- **WHEN** a tessellation result is handed to the viewport
- **THEN** its vertex, normal, and index data are uploaded into GPU buffers, and no additional long-lived JavaScript-side copy of the mesh is retained after upload

#### Scenario: Transferred buffers are adopted, not re-copied

- **WHEN** the viewport receives mesh buffers that were transferred from the kernel Worker
- **THEN** it builds its render geometry over those buffers directly, without allocating a further copy of the position, normal, or index data

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

