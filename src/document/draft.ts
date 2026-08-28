// A document being edited.
//
// Owns the two things a live session cannot keep in kernel handles: which body
// is which, stably, and how each one came to exist. Handles are session-scoped
// and meaningless once the Worker is gone, so every body on screen is paired
// here with an identity the document mints and keeps.
//
// This lives in the document layer rather than in the app because identity and
// history are document semantics. The session drives it; it does not know the
// session exists.

import type { BodyId, BooleanKind, BoxOptions, CylinderOptions } from '../kernel/types.ts';
import type { DocumentContent, OpenedDocument } from './document.ts';
import type { BodyRef, BodySource, ConstructionEntry } from './types.ts';
import { bodyRefFor } from './types.ts';

/**
 * A document identifier, unique within a store.
 *
 * Built from `crypto.getRandomValues` rather than `crypto.randomUUID`, which is
 * secure-context only: a save that fails because the page was served over plain
 * http would be an absurd way to lose someone's work.
 */
export function newDocumentId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface DraftOptions {
  readonly documentId?: string;
  readonly createdAt?: string;
}

export class DocumentDraft {
  #bodies: { ref: BodyRef; handle: BodyId }[] = [];
  #entries: ConstructionEntry[] = [];
  #sources = new Map<BodyRef, BodySource>();
  #nextOrdinal = 1;
  #name: string;

  readonly documentId: string;
  readonly createdAt: string;

  private constructor(name: string, options: DraftOptions) {
    this.#name = name;
    this.documentId = options.documentId ?? newDocumentId();
    this.createdAt = options.createdAt ?? new Date().toISOString();
  }

  static create(name: string, options: DraftOptions = {}): DocumentDraft {
    return new DocumentDraft(name, options);
  }

  /**
   * Continues editing a document that was just opened.
   *
   * Identities and the ordinal counter come from the manifest, not from the
   * bodies present: a document that had `b1` deleted before saving must not
   * mint `b1` again for the next body.
   */
  static fromOpened(opened: OpenedDocument): DocumentDraft {
    const { manifest } = opened;
    const draft = new DocumentDraft(manifest.name, {
      documentId: manifest.documentId,
      createdAt: manifest.createdAt,
    });

    for (const ref of manifest.bodies) {
      const handle = opened.bodies.get(ref);
      if (handle !== undefined) draft.#bodies.push({ ref, handle });
    }
    draft.#entries = [...(opened.record?.entries ?? [])];
    // A body with no recorded source was authored here, which is exactly what a
    // version 1 document means by having no sources at all. So there is nothing
    // to migrate: the absence is already the right answer.
    for (const [ref, source] of Object.entries(manifest.sources ?? {})) {
      draft.#sources.set(ref as BodyRef, source);
    }
    draft.#nextOrdinal = manifest.nextBodyOrdinal;
    return draft;
  }

  get name(): string {
    return this.#name;
  }

  rename(name: string): void {
    this.#name = name;
  }

  /** Live bodies in the order they will be written. */
  get bodies(): readonly { readonly ref: BodyRef; readonly handle: BodyId }[] {
    return this.#bodies;
  }

  get entries(): readonly ConstructionEntry[] {
    return this.#entries;
  }

  /**
   * Where a body came from. Authored unless it was recorded otherwise.
   *
   * The default is not a guess: bodies are authored here unless an import says
   * otherwise, so absence carries the same meaning as an explicit entry would.
   */
  sourceOf(ref: BodyRef): BodySource {
    return this.#sources.get(ref) ?? { kind: 'authored' };
  }

  refFor(handle: BodyId): BodyRef | undefined {
    return this.#bodies.find((body) => body.handle === handle)?.ref;
  }

  handleFor(ref: BodyRef): BodyId | undefined {
    return this.#bodies.find((body) => body.ref === ref)?.handle;
  }

  // --- Recording -------------------------------------------------------------

  recordBox(handle: BodyId, params: BoxOptions): BodyRef {
    const ref = this.#mint(handle);
    this.#entries.push({ op: 'createBox', produces: ref, params });
    return ref;
  }

  recordCylinder(handle: BodyId, params: CylinderOptions): BodyRef {
    const ref = this.#mint(handle);
    this.#entries.push({ op: 'createCylinder', produces: ref, params });
    return ref;
  }

  /**
   * Records a Boolean by the identities of its operands.
   *
   * By identity rather than by handle, because the record outlives the handles.
   * The operands are not removed here: whether a Boolean's inputs stay on
   * screen is the session's decision, and it says so with `recordRelease`.
   */
  recordBoolean(
    kind: BooleanKind,
    target: BodyRef,
    tool: BodyRef,
    handle: BodyId,
  ): BodyRef {
    const ref = this.#mint(handle);
    this.#entries.push({ op: 'boolean', kind, target, tool, produces: ref });
    return ref;
  }

  /**
   * Records geometry that arrived from a STEP file, as a base feature.
   *
   * One entry for the whole import, naming every identity it produced, because
   * that is what happened: a file yielded a set of bodies at once. Recording one
   * entry per body would imply the file could be re-read a body at a time, and
   * nothing here ever re-reads it.
   *
   * The file name and declared unit are provenance. `fileName` is deliberately
   * not a path and not a handle - a document that reopens must not go looking
   * for it, because the geometry is in the checkpoint and the file may be gone.
   */
  recordImport(
    handles: readonly BodyId[],
    file: { readonly fileName: string; readonly declaredUnit: string },
  ): readonly BodyRef[] {
    const refs = handles.map((handle) => this.#mint(handle));
    for (const ref of refs) {
      this.#sources.set(ref, {
        kind: 'imported',
        format: 'step',
        fileName: file.fileName,
        declaredUnit: file.declaredUnit,
      });
    }
    this.#entries.push({
      op: 'importStep',
      fileName: file.fileName,
      declaredUnit: file.declaredUnit,
      produces: refs,
    });
    return refs;
  }

  /** Drops a body from the document. Its identity is retired, never reissued. */
  recordRelease(ref: BodyRef): void {
    const index = this.#bodies.findIndex((body) => body.ref === ref);
    if (index === -1) return;
    this.#bodies.splice(index, 1);
    // The provenance goes with the body. Keeping it would leave the document
    // asserting where geometry came from that it no longer holds.
    this.#sources.delete(ref);
    this.#entries.push({ op: 'release', body: ref });
  }

  /**
   * Rebinds every identity to a fresh handle, after the document is reopened or
   * its bodies are otherwise re-created.
   */
  rebind(bodies: ReadonlyMap<BodyRef, BodyId>): void {
    this.#bodies = this.#bodies.map(({ ref, handle }) => ({
      ref,
      handle: bodies.get(ref) ?? handle,
    }));
  }

  /** A snapshot for `buildParts`. */
  content(): DocumentContent {
    return {
      documentId: this.documentId,
      name: this.#name,
      createdAt: this.createdAt,
      bodies: [...this.#bodies],
      entries: [...this.#entries],
      sources: new Map(this.#sources),
      nextBodyOrdinal: this.#nextOrdinal,
    };
  }

  #mint(handle: BodyId): BodyRef {
    const ref = bodyRefFor(this.#nextOrdinal++);
    this.#bodies.push({ ref, handle });
    return ref;
  }
}
