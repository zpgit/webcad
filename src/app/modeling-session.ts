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
  StepImportReport,
  StepTranslationOptions,
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
  | {
      kind: 'imported';
      fileName: string;
      bodyCount: number;
      byteLength: number;
      /** What the file carried and this stage did not keep. */
      notes: readonly string[];
    }
  | { kind: 'exported'; fileName: string; bodyCount: number; byteLength: number }
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

  // --- Interchange -----------------------------------------------------------

  /**
   * Imports a STEP file into the current session.
   *
   * Adds to what is there rather than replacing it: an import is not an open.
   * A user who has modelled something and then imports a part expects both, and
   * silently discarding their work would be the worse surprise.
   *
   * **Consumes `bytes`.** The buffer is transferred into the kernel, so the
   * caller's view is detached when this returns.
   *
   * A failure leaves the session exactly as it was. Nothing here mutates the
   * draft or the viewport until the translation has come back with bodies.
   */
  async importStep(
    fileName: string,
    bytes: Uint8Array,
    options: StepTranslationOptions = {},
  ): Promise<readonly BodyId[]> {
    const byteLength = bytes.byteLength;
    const report = await this.#kernel.importStep(bytes, options);

    if (report.bodyIds.length === 0) {
      // A readable file that held nothing this system can model. Not an error
      // from the kernel's point of view, but it is certainly not a success from
      // the user's, so it is reported as a failed import rather than silently
      // adding nothing to the screen.
      this.#emit({
        kind: 'error',
        message:
          `${fileName} contained no solid geometry ` +
          `(${report.rootShapeCount} shapes declared, ` +
          `${report.unregisteredShapeCount} unusable).`,
      });
      return [];
    }

    this.#draft.recordImport(report.bodyIds, {
      fileName,
      declaredUnit: report.unitWasAssumed ? 'unknown' : report.declaredUnit,
    });

    for (const bodyId of report.bodyIds) {
      await this.#render(bodyId);
    }

    this.#emit({
      kind: 'imported',
      fileName,
      bodyCount: report.bodyIds.length,
      byteLength,
      notes: describeImportLosses(report),
    });
    return report.bodyIds;
  }

  /**
   * Exports the session's bodies as STEP bytes.
   *
   * What is exported is the geometry as it stands, which is the point: a body
   * imported and then cut exports with the cut in it. The bytes are the
   * caller's - handing them to a download is the UI's job, not this layer's.
   */
  async exportStep(
    options: StepTranslationOptions = {},
  ): Promise<{ fileName: string; bytes: Uint8Array }> {
    const bodies = this.#draft.bodies.map((body) => body.handle);
    if (bodies.length === 0) {
      throw new Error('There is nothing to export: this document has no bodies.');
    }

    const report = await this.#kernel.exportStep(bodies, options);
    const fileName = `${stepFileNameFor(this.#draft.name)}.step`;

    this.#emit({
      kind: 'exported',
      fileName,
      bodyCount: report.bodyCount,
      byteLength: report.bytes.byteLength,
    });
    return { fileName, bytes: report.bytes };
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

/**
 * What an import could not bring with it, in words a user can act on.
 *
 * Reported rather than hidden because the loss is this stage's, not the file's:
 * assembly structure, names and colours need XCAF and arrive in MVP-3. Saying so
 * where the user can see it is the difference between a known limitation and an
 * apparently broken import.
 */
function describeImportLosses(report: StepImportReport): readonly string[] {
  const notes: string[] = [];
  if (report.assemblyNodeCount > 0) {
    notes.push(
      `Assembly structure was not preserved (${report.assemblyNodeCount} nodes); ` +
        'parts were imported as separate bodies.',
    );
  }
  if (report.namedProductCount > 0 || report.styledItemCount > 0) {
    notes.push(
      `Part names and colours were not preserved ` +
        `(${report.namedProductCount} products, ${report.styledItemCount} styles).`,
    );
  }
  if (report.openBodyIds.length > 0) {
    notes.push(
      `${report.openBodyIds.length} of ${report.bodyIds.length} bodies are not ` +
        'closed solids; operations needing a solid will fail on those.',
    );
  }
  if (report.unregisteredShapeCount > 0) {
    notes.push(
      `${report.unregisteredShapeCount} shapes in the file could not be imported.`,
    );
  }
  if (report.unitWasAssumed) {
    notes.push(
      `The file declared no unit; ${report.workingUnit} was assumed.`,
    );
  } else if (report.declaredUnit !== report.workingUnit) {
    notes.push(
      `Converted from ${report.declaredUnit} to ${report.workingUnit} on import.`,
    );
  }
  return notes;
}

/** A document name reduced to something safe to hand a filesystem. */
function stepFileNameFor(documentName: string): string {
  const cleaned = documentName
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'model' : cleaned;
}
