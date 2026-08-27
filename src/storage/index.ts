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
 * IndexedDB, now on the measurements rather than provisionally
 * (`measurements/document.json`, and `docs/MVP-1-FINDINGS.md` for the argument).
 * On the same 459 kB document it beat OPFS on every operation - save 1.5 ms
 * against 12.1, read 1.1 against 7.2, open 9.6 against 17.1, and listing 0.41
 * against 10.8 - while also storing the document once rather than twice, staying
 * inside a frame of main-thread stall in every run where OPFS did not, and
 * getting its atomicity from a transaction rather than from the two-generation
 * scheme the OPFS backend had to invent.
 *
 * What would change it: checkpoints large enough that holding one as a single
 * IndexedDB value is the problem, or moving persistence into the Worker, where
 * OPFS gains `createSyncAccessHandle` and can stream instead of copying. Both
 * are MVP-2 questions, and `OpfsStore` stays in the tree to be re-measured
 * against them.
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
