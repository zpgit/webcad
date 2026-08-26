import type { Kernel } from '../kernel/kernel.ts';
import type {
  BodyId,
  BooleanKind,
  BoxOptions,
  CylinderOptions,
  TessellationOptions,
} from '../kernel/types.ts';
import type { Viewport } from '../viewport/viewport.ts';

export type SessionEvent =
  | { kind: 'created'; bodyId: BodyId }
  | { kind: 'boolean'; op: BooleanKind; bodyId: BodyId; solidCount: number }
  | { kind: 'empty'; op: BooleanKind; message: string }
  | { kind: 'released'; bodyId: BodyId }
  | { kind: 'error'; message: string };

/**
 * Coordinates the kernel and the viewport.
 *
 * Owns handle lifetime for everything on screen. There is no persistence at this
 * stage - reloading the page discards all modeling state, which is MVP-0's
 * accepted limitation and precisely what MVP-1 addresses.
 */
export class ModelingSession {
  #listeners: Array<(event: SessionEvent) => void> = [];

  readonly #kernel: Kernel;
  readonly #viewport: Viewport;
  readonly #tessellation: TessellationOptions;

  constructor(
    kernel: Kernel,
    viewport: Viewport,
    tessellation: TessellationOptions = {},
  ) {
    this.#kernel = kernel;
    this.#viewport = viewport;
    this.#tessellation = tessellation;
  }

  onEvent(listener: (event: SessionEvent) => void): void {
    this.#listeners.push(listener);
  }

  async createBox(options: BoxOptions): Promise<BodyId> {
    const bodyId = await this.#kernel.createBox(options);
    await this.#render(bodyId);
    this.#emit({ kind: 'created', bodyId });
    return bodyId;
  }

  async createCylinder(options: CylinderOptions): Promise<BodyId> {
    const bodyId = await this.#kernel.createCylinder(options);
    await this.#render(bodyId);
    this.#emit({ kind: 'created', bodyId });
    return bodyId;
  }

  /**
   * Applies a Boolean to the current two-body selection.
   *
   * The kernel leaves both operands valid; this layer then releases them
   * explicitly, because on screen they have been replaced by the result. That
   * release is a UI ownership decision, not something the operation did.
   */
  async applyBooleanToSelection(op: BooleanKind): Promise<void> {
    const [target, tool] = this.#viewport.selection;
    if (target === undefined || tool === undefined) {
      this.#emit({
        kind: 'error',
        message: 'Select exactly two bodies before applying a Boolean.',
      });
      return;
    }

    const outcome = await this.#kernel.boolean(op, target, tool);

    if (outcome.kind === 'empty') {
      // A legitimate outcome, not a failure: the operands are left untouched so
      // the user can see what happened and try something else.
      this.#emit({ kind: 'empty', op, message: outcome.message });
      return;
    }

    await this.#render(outcome.bodyId);

    for (const operand of [target, tool]) {
      this.#viewport.removeBody(operand);
      await this.#kernel.release(operand);
    }

    this.#emit({
      kind: 'boolean',
      op,
      bodyId: outcome.bodyId,
      solidCount: outcome.solidCount,
    });
  }

  async releaseSelection(): Promise<void> {
    const selected = [...this.#viewport.selection];
    for (const bodyId of selected) {
      this.#viewport.removeBody(bodyId);
      await this.#kernel.release(bodyId);
      this.#emit({ kind: 'released', bodyId });
    }
  }

  /**
   * Tessellates and hands the mesh to the viewport, which adopts it.
   *
   * Ownership passes straight through: the kernel copied the mesh out of WASM
   * memory once, and nothing between there and the GPU copies it again.
   */
  async #render(bodyId: BodyId): Promise<void> {
    const { mesh, meta } = await this.#kernel.tessellate(bodyId, this.#tessellation);
    this.#viewport.upsertBody(bodyId, mesh, meta);
  }

  #emit(event: SessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
