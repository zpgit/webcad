// Why persistence failed.
//
// A save that did not happen must never be reported as a save that did, so
// these are typed rather than left as whatever the browser threw. The
// distinctions that matter to a caller are: the store cannot be used here at
// all, the write did not fit, or there is nothing by that name.
//
// Fields are assigned in the constructor body rather than declared as parameter
// properties: Node's type stripping is strip-only and rejects the shorthand.

export abstract class StorageError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The backend cannot be initialized in this environment.
 *
 * Reported rather than thrown at module load, so the application can still be
 * used for modelling without persistence instead of failing to start.
 */
export class StorageUnavailableError extends StorageError {
  readonly code = 'StorageUnavailable';

  readonly backend: string;

  constructor(backend: string, detail: string, options?: { cause?: unknown }) {
    super(`${backend} storage is not available: ${detail}.`, options);
    this.backend = backend;
  }
}

/** The origin's storage quota is exhausted. The live session is untouched. */
export class StorageQuotaError extends StorageError {
  readonly code = 'StorageQuota';

  readonly backend: string;

  constructor(backend: string, options?: { cause?: unknown }) {
    super(
      `There is not enough browser storage left to save this document ` +
        `(${backend}). Nothing was saved, and your model is still open.`,
      options,
    );
    this.backend = backend;
  }
}

export class DocumentNotFoundError extends StorageError {
  readonly code = 'DocumentNotFound';

  readonly documentId: string;

  constructor(documentId: string) {
    super(`No stored document with id ${documentId}.`);
    this.documentId = documentId;
  }
}

/**
 * True for the browser's way of saying "out of space".
 *
 * Both backends surface it as a `DOMException`, and the name is the only
 * reliable discriminator - the message is not specified.
 */
export function isQuotaExceeded(error: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' ||
      // Firefox's older spelling, kept because it costs one comparison.
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}
