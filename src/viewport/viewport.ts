import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { BodyId, MeshBuffers, MeshMeta } from '../kernel/types.ts';

export type RenderBackend = 'webgpu' | 'webgl2';

export class NoRendererError extends Error {
  constructor(cause?: unknown) {
    super(
      'Neither WebGPU nor WebGL2 could be initialized, so the viewport cannot ' +
        'render. A GPU-capable browser is required.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'NoRendererError';
  }
}

interface RenderedBody {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  triangleCount: number;
}

const SURFACE_COLOR = 0xb4bcc4;
const SELECTED_COLOR = 0x5aa9e6;
const SECOND_SELECTED_COLOR = 0xe6a15a;

/**
 * Renders tessellated bodies and resolves picks back to `BodyId` handles.
 *
 * The viewport deliberately knows nothing about the kernel: bodies arrive as
 * plain mesh buffers, which is what makes the renderer replaceable and keeps the
 * exact-geometry boundary intact.
 */
export class Viewport {
  #renderer!: THREE.WebGLRenderer | { render: unknown; [k: string]: unknown };
  #backend!: RenderBackend;
  #scene = new THREE.Scene();
  #camera: THREE.PerspectiveCamera;
  #controls!: OrbitControls;
  #raycaster = new THREE.Raycaster();
  #bodies = new Map<BodyId, RenderedBody>();

  /** Selection order matters: the first pick is the Boolean target. */
  #selection: BodyId[] = [];
  #onSelectionChange?: (selection: readonly BodyId[]) => void;

  readonly #canvas: HTMLCanvasElement;

  private constructor(
    canvas: HTMLCanvasElement,
    camera: THREE.PerspectiveCamera,
  ) {
    this.#canvas = canvas;
    this.#camera = camera;
  }

  static async create(canvas: HTMLCanvasElement): Promise<Viewport> {
    const camera = new THREE.PerspectiveCamera(
      50,
      canvas.clientWidth / Math.max(canvas.clientHeight, 1),
      0.1,
      10_000,
    );

    const viewport = new Viewport(canvas, camera);
    await viewport.#initRenderer();
    viewport.#initScene();
    viewport.#initControls();
    viewport.#initPicking();
    viewport.#startLoop();
    return viewport;
  }

  get backend(): RenderBackend {
    return this.#backend;
  }

  get selection(): readonly BodyId[] {
    return this.#selection;
  }

  get totalTriangles(): number {
    let n = 0;
    for (const body of this.#bodies.values()) n += body.triangleCount;
    return n;
  }

  onSelectionChange(handler: (selection: readonly BodyId[]) => void): void {
    this.#onSelectionChange = handler;
  }

  /**
   * Uploads a tessellation into GPU buffers.
   *
   * The arrays are adopted, not copied. They arrive already owned by this
   * thread - the kernel copied them out of WASM memory and transferred them -
   * so copying again would put back the copy the transfer removed. The caller
   * hands over ownership by calling this; it must not keep writing to them.
   */
  upsertBody(bodyId: BodyId, buffers: MeshBuffers, meta: MeshMeta): void {
    this.removeBody(bodyId);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
    geometry.computeBoundingSphere();

    const material = new THREE.MeshStandardMaterial({
      color: SURFACE_COLOR,
      metalness: 0.1,
      roughness: 0.6,
      flatShading: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    // Tagged so a raycast hit resolves straight back to a kernel handle.
    mesh.userData.bodyId = bodyId;
    this.#scene.add(mesh);

    this.#bodies.set(bodyId, {
      mesh,
      geometry,
      triangleCount: meta.triangleCount,
    });
    this.#applySelectionColors();
  }

  /** Removes a body and destroys its GPU resources. */
  removeBody(bodyId: BodyId): void {
    const existing = this.#bodies.get(bodyId);
    if (existing === undefined) return;

    this.#scene.remove(existing.mesh);
    existing.geometry.dispose();
    const material = existing.mesh.material;
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose());
    } else {
      material.dispose();
    }
    this.#bodies.delete(bodyId);

    this.#selection = this.#selection.filter((id) => id !== bodyId);
    this.#notifySelection();
  }

  hasBody(bodyId: BodyId): boolean {
    return this.#bodies.has(bodyId);
  }

  clearSelection(): void {
    if (this.#selection.length === 0) return;
    this.#selection = [];
    this.#applySelectionColors();
    this.#notifySelection();
  }

  /** Frames all visible bodies, or returns to the default view when empty. */
  fitToView(): void {
    if (this.#bodies.size === 0) {
      this.#resetCamera();
      return;
    }

    const box = new THREE.Box3();
    for (const body of this.#bodies.values()) {
      box.expandByObject(body.mesh);
    }
    if (box.isEmpty()) {
      this.#resetCamera();
      return;
    }

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-3);
    const fov = (this.#camera.fov * Math.PI) / 180;
    const distance = (radius / Math.sin(fov / 2)) * 1.25;

    const direction = new THREE.Vector3(1, -1, 0.8).normalize();
    this.#camera.position.copy(center).addScaledVector(direction, distance);
    this.#camera.near = Math.max(distance / 1000, 0.01);
    this.#camera.far = distance * 100;
    this.#camera.updateProjectionMatrix();
    this.#controls.target.copy(center);
    this.#controls.update();
  }

  // --- Setup ---------------------------------------------------------------

  async #initRenderer(): Promise<void> {
    // WebGPU preferred, WebGL2 as the correctness reference. The active backend
    // is reported so measurements can be attributed to it.
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      try {
        const { WebGPURenderer } = await import('three/webgpu');
        const renderer = new WebGPURenderer({
          canvas: this.#canvas,
          antialias: true,
        });
        await renderer.init();
        renderer.setClearColor(0x1a1d21);
        this.#renderer = renderer as unknown as THREE.WebGLRenderer;
        this.#backend = 'webgpu';
        this.#applySize();
        return;
      } catch {
        // Fall through to WebGL2 rather than failing: the WebGPU renderer is
        // less mature, and a backend-specific failure should not be fatal.
      }
    }

    try {
      const renderer = new THREE.WebGLRenderer({
        canvas: this.#canvas,
        antialias: true,
      });
      renderer.setClearColor(0x1a1d21);
      this.#renderer = renderer;
      this.#backend = 'webgl2';
      this.#applySize();
    } catch (cause) {
      throw new NoRendererError(cause);
    }
  }

  #initScene(): void {
    this.#scene.background = new THREE.Color(0x1a1d21);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x30363c, 1.1);
    this.#scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(60, -80, 100);
    this.#scene.add(key);

    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-70, 50, -40);
    this.#scene.add(fill);

    this.#scene.add(new THREE.AxesHelper(20));
    this.#resetCamera();
  }

  #initControls(): void {
    const controls = new OrbitControls(
      this.#camera,
      this.#renderer.domElement as HTMLElement,
    );
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    // Zoom toward the cursor rather than the orbit target.
    controls.zoomToCursor = true;
    this.#controls = controls;

    const resize = (): void => {
      this.#applySize();
    };
    window.addEventListener('resize', resize);
  }

  #initPicking(): void {
    // Distinguishes a click from a drag, so orbiting does not change selection.
    let downAt: { x: number; y: number } | null = null;

    this.#canvas.addEventListener('pointerdown', (event) => {
      downAt = { x: event.clientX, y: event.clientY };
    });

    this.#canvas.addEventListener('pointerup', (event) => {
      if (downAt === null) return;
      const moved =
        Math.abs(event.clientX - downAt.x) + Math.abs(event.clientY - downAt.y);
      downAt = null;
      if (moved > 4) return;

      const hit = this.pickAt(event.clientX, event.clientY);
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;

      if (hit === null) {
        this.clearSelection();
        return;
      }

      if (additive) {
        if (this.#selection.includes(hit)) {
          this.#selection = this.#selection.filter((id) => id !== hit);
        } else {
          // Two operands are all a Boolean needs; the oldest drops out.
          this.#selection = [...this.#selection, hit].slice(-2);
        }
      } else {
        this.#selection = [hit];
      }

      this.#applySelectionColors();
      this.#notifySelection();
    });
  }

  /**
   * Resolves a viewport-relative pixel to a body, or null for empty space.
   *
   * Public because programmatic picking is genuinely useful to a host - notably
   * for automated verification, which would otherwise have to guess at pixel
   * coordinates and silently test nothing when it guessed wrong.
   *
   * Note this raycasts against the tessellated mesh, not the exact geometry.
   * That is adequate for choosing whole bodies and is another reason face-level
   * selection is deferred: it would depend on topology identity that MVP-0
   * cannot keep stable.
   */
  pickAt(clientX: number, clientY: number): BodyId | null {
    const rect = this.#canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.#raycaster.setFromCamera(ndc, this.#camera);

    const meshes = [...this.#bodies.values()].map((b) => b.mesh);
    const hits = this.#raycaster.intersectObjects(meshes, false);
    const first = hits[0];
    if (first === undefined) return null;
    return (first.object.userData.bodyId as BodyId | undefined) ?? null;
  }

  #applySelectionColors(): void {
    for (const [bodyId, body] of this.#bodies) {
      const index = this.#selection.indexOf(bodyId);
      const material = body.mesh.material as THREE.MeshStandardMaterial;
      material.color.setHex(
        index === 0
          ? SELECTED_COLOR
          : index === 1
            ? SECOND_SELECTED_COLOR
            : SURFACE_COLOR,
      );
      material.emissive.setHex(index >= 0 ? 0x14202a : 0x000000);
    }
  }

  #notifySelection(): void {
    this.#onSelectionChange?.(this.#selection);
  }

  #resetCamera(): void {
    // Documented default view, used on startup and when fitting an empty scene.
    this.#camera.position.set(120, -160, 110);
    this.#camera.near = 0.1;
    this.#camera.far = 10_000;
    this.#camera.updateProjectionMatrix();
    this.#camera.lookAt(0, 0, 0);
    if (this.#controls !== undefined) {
      this.#controls.target.set(0, 0, 0);
      this.#controls.update();
    }
  }

  #applySize(): void {
    const width = this.#canvas.clientWidth || 1;
    const height = this.#canvas.clientHeight || 1;
    const renderer = this.#renderer as THREE.WebGLRenderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
  }

  #startLoop(): void {
    const renderer = this.#renderer as THREE.WebGLRenderer;
    renderer.setAnimationLoop(() => {
      this.#controls.update();
      renderer.render(this.#scene, this.#camera);
    });
  }
}
