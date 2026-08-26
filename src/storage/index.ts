// Choosing a backend.
//
// The architecture note poses IndexedDB versus OPFS as an open question, so
// both exist and both are measured before either is called the default. This
// module is the one place that knows which is which; nothing above it does.

import { IndexedDbStore } from './indexeddb.ts';
import { OpfsStore } from './opfs.ts';
import type { DocumentStore, StorageBackend } from './types.ts';

/**
 * The backend the application uses unless told otherwise.
 *
 * Provisional until the measurements exist. IndexedDB is the starting point
 * because its atomicity is a transaction rather than a scheme this codebase
 * had to invent, which makes it the safer thing to be wrong about.
 */
export const DEFAULT_BACKEND: StorageBackend = 'indexeddb';

export function openStore(
  backend: StorageBackend = DEFAULT_BACKEND,
): Promise<DocumentStore> {
  return backend === 'opfs' ? OpfsStore.open() : IndexedDbStore.open();
}

export { IndexedDbStore } from './indexeddb.ts';
export { OpfsStore } from './opfs.ts';
export type { DocumentStore, DocumentSummary, StorageBackend } from './types.ts';
export {
  DocumentNotFoundError,
  StorageError,
  StorageQuotaError,
  StorageUnavailableError,
} from './errors.ts';
