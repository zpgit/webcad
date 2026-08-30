// Where documents live, stated without reference to how.
//
// The store's contract is deliberately narrow: it moves named sections in and out,
// and it does not interpret them. It never parses a manifest - which is why
// listing metadata is supplied at save time rather than read back out of the
// geometry's neighbours. That keeps document semantics above this layer and
// storage mechanics below it, so neither leaks into the other.

import type { DocumentSections } from '../document/types.ts';

export type StorageBackend = 'indexeddb' | 'opfs';

/**
 * Enough to show a document in a list, and nothing more.
 *
 * Held separately from the sections so that listing never touches a checkpoint:
 * the cost of showing the document list must not scale with model size.
 */
export interface DocumentSummary {
  readonly documentId: string;
  readonly name: string;
  readonly modifiedAt: string;
  /** Total bytes across all sections, for display and for measurement. */
  readonly byteLength: number;
}

/**
 * What a caller supplies when saving.
 *
 * `byteLength` is absent deliberately: the store measures what it actually
 * wrote, so a listed size cannot drift from what is on disk, and a caller
 * cannot be wrong about it.
 */
export type DocumentSummaryInput = Omit<DocumentSummary, 'byteLength'>;

export interface DocumentStore {
  readonly backend: StorageBackend;

  /**
   * Writes a document, atomically.
   *
   * Either every section lands or the previously stored document is left exactly
   * as it was. This is a requirement on the interface rather than a property of
   * whichever backend happens to provide it, because the checkpoint is the only
   * path back to a user's geometry.
   */
  save(summary: DocumentSummaryInput, sections: DocumentSections): Promise<void>;

  read(documentId: string): Promise<DocumentSections>;

  /** Every stored document, without reading a single checkpoint. */
  list(): Promise<readonly DocumentSummary[]>;

  /**
   * Deletes a document and all of its sections. Clears the last-opened record if
   * it pointed here, so the next load does not try to open what is gone.
   */
  remove(documentId: string): Promise<void>;

  lastOpened(): Promise<string | null>;
  setLastOpened(documentId: string | null): Promise<void>;

  close(): void;
}
