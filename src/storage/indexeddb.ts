// IndexedDB backend.
//
// Atomicity comes free here: every part of a document is written in one
// `readwrite` transaction, which either commits or does not. That is the whole
// reason this backend is simple and the OPFS one is not.
//
// One IndexedDB rule shapes the code more than anything else: a transaction
// auto-commits as soon as the task queue drains without a new request against
// it. Awaiting anything mid-transaction ends it. So `save` issues every put
// synchronously and awaits only the transaction's completion.

import type { DocumentParts, PartName } from '../document/types.ts';
import { PART_NAMES } from '../document/types.ts';
import {
  DocumentNotFoundError,
  StorageQuotaError,
  StorageUnavailableError,
  isQuotaExceeded,
} from './errors.ts';
import type {
  DocumentStore,
  DocumentSummary,
  DocumentSummaryInput,
  StorageBackend,
} from './types.ts';

const DB_NAME = 'webcad';
const DB_VERSION = 1;

const SUMMARIES = 'summaries';
const PARTS = 'parts';
const META = 'meta';

const LAST_OPENED = 'lastOpened';

interface StoredPart {
  readonly documentId: string;
  readonly partName: PartName;
  readonly bytes: Uint8Array;
}

/** Promise wrapper for a request. Never used mid-transaction on the write path. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.onerror = (): void => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new StorageUnavailableError('IndexedDB', 'the API is not present');
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (): void => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SUMMARIES)) {
        db.createObjectStore(SUMMARIES, { keyPath: 'documentId' });
      }
      if (!db.objectStoreNames.contains(PARTS)) {
        // Compound key so one document's parts are a contiguous range, which is
        // what makes reading and deleting them a single ranged operation.
        db.createObjectStore(PARTS, { keyPath: ['documentId', 'partName'] });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META);
      }
    };

    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.onerror = (): void => {
      reject(
        new StorageUnavailableError(
          'IndexedDB',
          'the database could not be opened - private browsing or blocked storage',
          { cause: request.error },
        ),
      );
    };
    // Fires when another tab holds an older version open. Reported rather than
    // left to hang, which is what an unhandled `blocked` looks like to a user.
    request.onblocked = (): void => {
      reject(
        new StorageUnavailableError(
          'IndexedDB',
          'another tab is holding an older version of the database open',
        ),
      );
    };
  });
}

// Every part of one document, as a contiguous compound-key range. The upper
// bound is the highest code unit, so it sorts after any part name.
const documentRange = (documentId: string): IDBKeyRange =>
  IDBKeyRange.bound([documentId, ''], [documentId, '￿']);

export class IndexedDbStore implements DocumentStore {
  readonly backend: StorageBackend = 'indexeddb';

  readonly #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
  }

  static async open(): Promise<IndexedDbStore> {
    return new IndexedDbStore(await openDatabase());
  }

  async save(summary: DocumentSummaryInput, parts: DocumentParts): Promise<void> {
    const transaction = this.#db.transaction([SUMMARIES, PARTS], 'readwrite');
    const done = this.#settled(transaction);

    try {
      const summaries = transaction.objectStore(SUMMARIES);
      const partStore = transaction.objectStore(PARTS);

      let byteLength = 0;
      for (const partName of PART_NAMES) {
        // Read one part at a time, so a source that fails partway through
        // aborts a transaction that has already written something - which is
        // the case atomicity has to survive.
        const bytes = parts[partName];
        byteLength += bytes.byteLength;
        partStore.put({ documentId: summary.documentId, partName, bytes });
      }

      // Written last, mirroring the OPFS backend, where the summary is the
      // commit marker. Here the transaction is what commits and the order is
      // immaterial - but keeping them the same means one failure story.
      summaries.put({ ...summary, byteLength });
    } catch (error) {
      // Explicit: without it the transaction would commit whatever was queued
      // before the failure, leaving a document with some parts from this save
      // and some from the last.
      transaction.abort();
      // The abort rejects `done`, which nobody is awaiting on this path. Left
      // unhandled it would surface as an unhandled rejection unrelated to the
      // error actually being reported.
      void done.catch(() => undefined);
      throw error;
    }

    await done;
  }

  async read(documentId: string): Promise<DocumentParts> {
    const transaction = this.#db.transaction(PARTS, 'readonly');
    const stored = await promisify(
      transaction.objectStore(PARTS).getAll(documentRange(documentId)) as IDBRequest<
        StoredPart[]
      >,
    );

    if (stored.length === 0) throw new DocumentNotFoundError(documentId);

    const parts: Partial<Record<PartName, Uint8Array>> = {};
    for (const part of stored) parts[part.partName] = part.bytes;
    return parts as DocumentParts;
  }

  async list(): Promise<readonly DocumentSummary[]> {
    const transaction = this.#db.transaction(SUMMARIES, 'readonly');
    const summaries = await promisify(
      transaction.objectStore(SUMMARIES).getAll() as IDBRequest<DocumentSummary[]>,
    );
    return summaries;
  }

  async remove(documentId: string): Promise<void> {
    const transaction = this.#db.transaction(
      [SUMMARIES, PARTS, META],
      'readwrite',
    );
    const done = this.#settled(transaction);

    transaction.objectStore(SUMMARIES).delete(documentId);
    transaction.objectStore(PARTS).delete(documentRange(documentId));

    // Clearing the pointer belongs in the same transaction as the deletion:
    // otherwise a crash between the two leaves the next load reaching for a
    // document that no longer exists.
    const meta = transaction.objectStore(META);
    const current = meta.get(LAST_OPENED) as IDBRequest<string | undefined>;
    current.onsuccess = (): void => {
      if (current.result === documentId) meta.delete(LAST_OPENED);
    };

    await done;
  }

  async lastOpened(): Promise<string | null> {
    const transaction = this.#db.transaction(META, 'readonly');
    const value = await promisify(
      transaction.objectStore(META).get(LAST_OPENED) as IDBRequest<string | undefined>,
    );
    return value ?? null;
  }

  async setLastOpened(documentId: string | null): Promise<void> {
    const transaction = this.#db.transaction(META, 'readwrite');
    const done = this.#settled(transaction);
    const meta = transaction.objectStore(META);
    if (documentId === null) meta.delete(LAST_OPENED);
    else meta.put(documentId, LAST_OPENED);
    await done;
  }

  close(): void {
    this.#db.close();
  }

  /** Resolves on commit, rejects on abort or error - with quota mapped. */
  #settled(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = (): void => {
        resolve();
      };
      transaction.onabort = (): void => {
        const error = transaction.error;
        reject(
          isQuotaExceeded(error)
            ? new StorageQuotaError('IndexedDB', { cause: error })
            : (error ?? new Error('the IndexedDB transaction was aborted')),
        );
      };
      transaction.onerror = (): void => {
        const error = transaction.error;
        reject(
          isQuotaExceeded(error)
            ? new StorageQuotaError('IndexedDB', { cause: error })
            : (error ?? new Error('the IndexedDB transaction failed')),
        );
      };
    });
  }
}
