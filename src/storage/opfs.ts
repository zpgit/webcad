// Origin Private File System backend.
//
// Everything hard about this backend is atomicity. IndexedDB gets it from a
// transaction; here a document is several files and there is no way to swap
// them in together. `FileSystemHandle.move()` would help and is neither
// universally available nor defined for directories, so it is not relied on.
//
// The scheme instead is two generations and a commit marker:
//
//   documents/<id>/a/{summary.json, manifest.json, features.json, geometry.brep}
//   documents/<id>/b/{...}
//
// A save writes into whichever generation is NOT current, and writes
// `summary.json` LAST. The summary carries a sequence number, and the readable
// generation is whichever has the highest one. So an interrupted save leaves a
// generation with no summary, or an unparseable one, and the previous
// generation still wins - the document a user had is still the document they
// have.
//
// The cost is storing each document twice. That is real, it is bounded at 2x,
// and it buys atomicity without depending on a rename primitive.

import type { DocumentSections, SectionName } from '../document/types.ts';
import { SECTION_NAMES } from '../document/types.ts';
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

// Minimal shapes for the parts of the File System Access API used here.
// Declared locally rather than relied on from lib.dom, whose coverage of
// `entries()` and `removeEntry` varies by TypeScript version.
interface FsWritable {
  // Deliberately `Uint8Array` rather than `BufferSource`: the latter pins the
  // backing buffer to `ArrayBuffer`, and a `Uint8Array` copied out of WASM
  // memory is typed over `ArrayBufferLike`.
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface FsFileHandle {
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FsWritable>;
}
interface FsDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FsDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, { kind: string }]>;
}

const ROOT_DIR = 'webcad';
const DOCUMENTS_DIR = 'documents';
const LAST_OPENED_FILE = 'last-opened';
const SUMMARY_FILE = 'summary.json';

const GENERATIONS = ['a', 'b'] as const;
type Generation = (typeof GENERATIONS)[number];

/** The stored summary, plus the sequence that decides which generation wins. */
interface StoredSummary extends DocumentSummary {
  readonly sequence: number;
}

const encoder = new TextEncoder();

function notFound(error: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'NotFoundError'
  );
}

/** Rethrows as a typed storage failure; a quota error must not read as a bug. */
function rethrow(error: unknown): never {
  if (isQuotaExceeded(error)) throw new StorageQuotaError('OPFS', { cause: error });
  throw error;
}

export class OpfsStore implements DocumentStore {
  readonly backend: StorageBackend = 'opfs';

  readonly #root: FsDirectoryHandle;

  private constructor(root: FsDirectoryHandle) {
    this.#root = root;
  }

  static async open(): Promise<OpfsStore> {
    const storage = (navigator as Navigator & { storage?: unknown }).storage as
      | { getDirectory?: () => Promise<FsDirectoryHandle> }
      | undefined;

    if (storage?.getDirectory === undefined) {
      throw new StorageUnavailableError('OPFS', 'the API is not present');
    }

    try {
      const origin = await storage.getDirectory();
      return new OpfsStore(await origin.getDirectoryHandle(ROOT_DIR, { create: true }));
    } catch (cause) {
      throw new StorageUnavailableError(
        'OPFS',
        'the origin private file system could not be opened',
        { cause },
      );
    }
  }

  async save(summary: DocumentSummaryInput, sections: DocumentSections): Promise<void> {
    const documents = await this.#documents(true);
    const dir = await documents.getDirectoryHandle(summary.documentId, {
      create: true,
    });

    const current = await this.#readGenerations(dir);
    const target: Generation = current?.generation === 'a' ? 'b' : 'a';
    const sequence = (current?.summary.sequence ?? 0) + 1;

    // A stale generation from an interrupted earlier save would otherwise be
    // written into piecemeal, so it starts empty every time.
    await dir.removeEntry(target, { recursive: true }).catch(() => undefined);
    const generation = await dir.getDirectoryHandle(target, { create: true });

    try {
      let byteLength = 0;
      for (const sectionName of SECTION_NAMES) {
        // One section read at a time, so a source that fails partway leaves this
        // generation without its summary and therefore uncommitted.
        const bytes = sections[sectionName];
        byteLength += bytes.byteLength;
        await writeFile(generation, sectionName, bytes);
      }

      // The commit. Until this file exists and parses, this generation does not
      // count and the previous one is still the document.
      const stored: StoredSummary = { ...summary, byteLength, sequence };
      await writeFile(generation, SUMMARY_FILE, encoder.encode(JSON.stringify(stored)));
    } catch (error) {
      // Leave nothing half-written to be mistaken for a document later. The
      // previous generation is untouched and still wins on sequence anyway;
      // this is tidiness, not correctness.
      await dir.removeEntry(target, { recursive: true }).catch(() => undefined);
      rethrow(error);
    }
  }

  async read(documentId: string): Promise<DocumentSections> {
    const documents = await this.#documents(false);
    if (documents === null) throw new DocumentNotFoundError(documentId);

    let dir: FsDirectoryHandle;
    try {
      dir = await documents.getDirectoryHandle(documentId);
    } catch (error) {
      if (notFound(error)) throw new DocumentNotFoundError(documentId);
      throw error;
    }

    const current = await this.#readGenerations(dir);
    if (current === null) throw new DocumentNotFoundError(documentId);

    const generation = await dir.getDirectoryHandle(current.generation);
    const sections: Partial<Record<SectionName, Uint8Array>> = {};
    for (const sectionName of SECTION_NAMES) {
      const bytes = await readFile(generation, sectionName);
      if (bytes !== null) sections[sectionName] = bytes;
    }
    return sections as DocumentSections;
  }

  async list(): Promise<readonly DocumentSummary[]> {
    const documents = await this.#documents(false);
    if (documents === null) return [];

    const summaries: DocumentSummary[] = [];
    for await (const [name, handle] of documents.entries()) {
      if (handle.kind !== 'directory') continue;
      const dir = await documents.getDirectoryHandle(name);
      // Only the summary file is read. A listing that opened a checkpoint would
      // cost more the larger the user's models got.
      const current = await this.#readGenerations(dir);
      if (current !== null) summaries.push(strip(current.summary));
    }
    return summaries;
  }

  async remove(documentId: string): Promise<void> {
    const documents = await this.#documents(false);
    if (documents !== null) {
      await documents.removeEntry(documentId, { recursive: true }).catch(() => undefined);
    }
    if ((await this.lastOpened()) === documentId) {
      await this.setLastOpened(null);
    }
  }

  async lastOpened(): Promise<string | null> {
    const bytes = await readFile(this.#root, LAST_OPENED_FILE);
    if (bytes === null || bytes.byteLength === 0) return null;
    return new TextDecoder().decode(bytes);
  }

  async setLastOpened(documentId: string | null): Promise<void> {
    if (documentId === null) {
      await this.#root.removeEntry(LAST_OPENED_FILE).catch(() => undefined);
      return;
    }
    await writeFile(this.#root, LAST_OPENED_FILE, encoder.encode(documentId));
  }

  close(): void {
    // Nothing to release: OPFS handles are not connections.
  }

  // --- Internals ---------------------------------------------------------------

  async #documents(create: true): Promise<FsDirectoryHandle>;
  async #documents(create: false): Promise<FsDirectoryHandle | null>;
  async #documents(create: boolean): Promise<FsDirectoryHandle | null> {
    try {
      return await this.#root.getDirectoryHandle(DOCUMENTS_DIR, { create });
    } catch (error) {
      if (!create && notFound(error)) return null;
      throw error;
    }
  }

  /**
   * The generation that counts: the highest sequence with a readable summary.
   *
   * An unparseable or absent summary means that generation was never committed,
   * so it is skipped rather than repaired. That is the whole atomicity
   * mechanism, and it is why the summary is written last.
   */
  async #readGenerations(
    dir: FsDirectoryHandle,
  ): Promise<{ generation: Generation; summary: StoredSummary } | null> {
    let best: { generation: Generation; summary: StoredSummary } | null = null;

    for (const generation of GENERATIONS) {
      let handle: FsDirectoryHandle;
      try {
        handle = await dir.getDirectoryHandle(generation);
      } catch {
        continue;
      }

      const bytes = await readFile(handle, SUMMARY_FILE);
      if (bytes === null) continue;

      let summary: StoredSummary;
      try {
        summary = JSON.parse(new TextDecoder().decode(bytes)) as StoredSummary;
        if (typeof summary.sequence !== 'number') continue;
      } catch {
        continue;
      }

      if (best === null || summary.sequence > best.summary.sequence) {
        best = { generation, summary };
      }
    }
    return best;
  }
}

function strip(summary: StoredSummary): DocumentSummary {
  const { documentId, name, modifiedAt, byteLength } = summary;
  return { documentId, name, modifiedAt, byteLength };
}

async function writeFile(
  dir: FsDirectoryHandle,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    // Closing is what publishes the new contents, so a failed write must abort
    // rather than close - otherwise a partial file becomes the file.
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

async function readFile(
  dir: FsDirectoryHandle,
  name: string,
): Promise<Uint8Array | null> {
  try {
    const handle = await dir.getFileHandle(name);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}
