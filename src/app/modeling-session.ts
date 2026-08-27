import { buildParts, readDocument } from '../document/document.ts';
import type { OpenedDocument } from '../document/document.ts';
import { DocumentDraft } from '../document/draft.ts';
import type { BodyRef } from '../document/types.ts';
import type { Kernel } from '../kernel/kernel.ts';
import type {
  BodyId,
  BooleanKind,
  BoxOptions,
  CylinderOptions,
  TessellationOptions,
} from '../kernel/types.ts';
import type { DocumentStore, DocumentSummary } from '../storage/types.ts';
import type { Viewport } from '../viewport/viewport.ts';
import { RECOVERY_PHASES, timePhase } from './timing.ts';

export type SessionEvent =
  | { kind: 'created'; bodyId: BodyId }
  | { kind: 'boolean'; op: BooleanKind; bodyId: BodyId; solidCount: number }
  | { kind: 'empty'; op: BooleanKind; message: string }
  | { kind: 'released'; bodyId: BodyId }
  | { kind: 'saved'; name: string; byteLength: number }
  | { kind: 'opened'; name: string; bodyCount: number; warnings: readonly string[] }
  | { kind: 'document'; name: string }
  | { kind: 'error'; message: string };

export interface SessionOptions {
  readonly tessellation?: TessellationOptions;
  /**
   * Where documents are persisted, or null when storage is unavailable.
   *
   * Nullable on purpose: a browser that refuses storage should still be able to
   * model. Losing persistence is worth reporting, not worth refusing to start
   * over.
   */
  readonly store?: DocumentStore | null;
}

/**
 * Coordinates the kernel, the viewport, and the document.
 *
 * Owns handle lifetime for everything on screen, and pairs each live body with
 * the identity its document knows it by - handles are session-scoped and mean
 * nothing after a reload, so the document mints its own and this layer keeps
 * the two in step.
 */
export class ModelingSession {
  #listeners: Array<(event: SessionEvent) => void> = [];
  #draft = DocumentDraft.create('Untitled');

  readonly #kernel: Kernel;
  readonly #viewport: Viewport;
  readonly #tessellation: TessellationOptions;
  readonly #store: DocumentStore | null;

  constructor(kernel: Kernel, viewport: Viewport, options: SessionOptions = {}) {
    this.#kernel = kernel;
    this.#viewport = viewport;
    this.#tessellation = options.tessellation ?? {};
    this.#store = options.store ?? null;
  }

  onEvent(listener: (event: SessionEvent) => void): void {
    this.#listeners.push(listener);
  }

  /** The document being edited: its identity, name, and construction record. */
  get document(): DocumentDraft {
    return this.#draft;
  }

  get canPersist(): boolean {
    return this.#store !== null;
  }

  // --- Modeling --------------------------------------------------------------

  async createBox(options: BoxOptions): Promise<BodyId> {
    const bodyId = await this.#kernel.createBox(options);
    this.#draft.recordBox(bodyId, options);
    await this.#render(bodyId);
    this.#emit({ kind: 'created', bodyId });
    return bodyId;
  }

  async createCylinder(options: CylinderOptions): Promise<BodyId> {
    const bodyId = await this.#kernel.createCylinder(options);
    this.#draft.recordCylinder(bodyId, options);
    await this.#render(bodyId);
    this.#emit({ kind: 'created', bodyId });
    return bodyId;
  }

  /**
   * Applies a Boolean to the current two-body selection.
   *
   * The kernel leaves both operands valid; this layer then releases them
   * explicitly, because on screen they have been replaced by the result. That
   * release is a UI ownership decision, not something the operation did - and
   * the document records it as one.
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

    // Captured before the operation: afterwards the operands are released, and
    // the record refers to bodies by identity rather than by handle.
    const targetRef = this.#draft.refFor(target);
    const toolRef = this.#draft.refFor(tool);

    const outcome = await this.#kernel.boolean(op, target, tool);

    if (outcome.kind === 'empty') {
      // A legitimate outcome, not a failure: the operands are left untouched so
      // the user can see what happened and try something else.
      this.#emit({ kind: 'empty', op, message: outcome.message });
      return;
    }

    if (targetRef !== undefined && toolRef !== undefined) {
      this.#draft.recordBoolean(op, targetRef, toolRef, outcome.bodyId);
    }

    await this.#render(outcome.bodyId);

    for (const operand of [target, tool]) {
      await this.#discard(operand);
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
      await this.#discard(bodyId);
      this.#emit({ kind: 'released', bodyId });
    }
  }

  // --- Document --------------------------------------------------------------

  rename(name: string): void {
    this.#draft.rename(name);
    this.#emit({ kind: 'document', name });
  }

  /** Discards the current session and starts an empty document. */
  async newDocument(name = 'Untitled'): Promise<void> {
    await this.#clear();
    this.#draft = DocumentDraft.create(name);
    this.#emit({ kind: 'document', name });
  }

  /**
   * Writes the document and records it as the one to reopen.
   *
   * Leaves the session exactly as it was: every body stays live, every handle
   * stays valid, and the viewport is untouched. A failure propagates - a save
   * that did not happen must never be reported as one that did.
   */
  async save(): Promise<DocumentSummary> {
    const store = this.#requireStore('save');

    // One timestamp for both the manifest and the listing, so the two cannot
    // disagree about when this document was written.
    const modifiedAt = new Date().toISOString();
    const parts = await buildParts(this.#kernel, this.#draft.content(), {
      now: () => modifiedAt,
    });

    await store.save(
      { documentId: this.#draft.documentId, name: this.#draft.name, modifiedAt },
      parts,
    );
    await store.setLastOpened(this.#draft.documentId);

    const byteLength = Object.values(parts).reduce(
      (sum, part) => sum + part.byteLength,
      0,
    );
    this.#emit({ kind: 'saved', name: this.#draft.name, byteLength });
    return { documentId: this.#draft.documentId, name: this.#draft.name, modifiedAt, byteLength };
  }

  /**
   * Opens a stored document, replacing whatever is on screen.
   *
   * Note the order: the document is read and its geometry restored BEFORE the
   * outgoing session is torn down. A refusal therefore leaves the current
   * session exactly as it was, which is the whole point - a user who tries to
   * open a damaged file must not lose the model they already had. The cost is
   * that both documents' geometry is resident for a moment.
   *
   * The three phases are timed where they happen, because that is the only
   * place they can be told apart: from outside, reading, restoring, and
   * re-tessellating are one await.
   */
  async open(documentId: string): Promise<OpenedDocument> {
    const store = this.#requireStore('open');

    const parts = await timePhase(RECOVERY_PHASES.documentRead, () =>
      store.read(documentId),
    );
    const opened = await timePhase(RECOVERY_PHASES.geometryRestore, () =>
      readDocument(parts, this.#kernel),
    );

    await this.#clear();

    this.#draft = DocumentDraft.fromOpened(opened);
    await timePhase(RECOVERY_PHASES.tessellate, async () => {
      for (const bodyId of opened.bodies.values()) {
        await this.#render(bodyId);
      }
    });
    await store.setLastOpened(documentId);

    this.#emit({
      kind: 'opened',
      name: opened.manifest.name,
      bodyCount: opened.bodies.size,
      warnings: opened.warnings,
    });
    return opened;
  }

  /**
   * Reopens whatever was open last, if anything.
   *
   * Returns null when there is nothing to reopen. A failure to open it is
   * thrown, because the caller has to decide whether an empty session plus an
   * explanation is acceptable - here it always is, but that is the application's
   * call rather than this layer's.
   */
  async restoreLastOpened(): Promise<OpenedDocument | null> {
    if (this.#store === null) return null;
    const documentId = await this.#store.lastOpened();
    if (documentId === null) return null;
    return this.open(documentId);
  }

  async listDocuments(): Promise<readonly DocumentSummary[]> {
    return this.#store === null ? [] : this.#store.list();
  }

  async removeDocument(documentId: string): Promise<void> {
    await this.#requireStore('delete').remove(documentId);
  }

  // --- Internals ---------------------------------------------------------------

  #requireStore(action: string): DocumentStore {
    if (this.#store === null) {
      throw new Error(`Cannot ${action}: browser storage is unavailable.`);
    }
    return this.#store;
  }

  /** Removes a body from screen, the document, and the kernel, in that order. */
  async #discard(bodyId: BodyId): Promise<void> {
    const ref: BodyRef | undefined = this.#draft.refFor(bodyId);
    this.#viewport.removeBody(bodyId);
    if (ref !== undefined) this.#draft.recordRelease(ref);
    await this.#kernel.release(bodyId);
  }

  /** Empties the session: nothing on screen, nothing left in the kernel. */
  async #clear(): Promise<void> {
    for (const { handle } of this.#draft.bodies) {
      this.#viewport.removeBody(handle);
      await this.#kernel.release(handle);
    }
    this.#viewport.clearSelection();
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
