## MODIFIED Requirements

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
