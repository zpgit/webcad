// Why a document was refused.
//
// Refusal is a first-class outcome here, not a generic throw. A document that
// cannot be read with confidence must fail with a reason a user can act on, and
// must leave the session in progress exactly as it was - so callers need to
// discriminate "this build is too old for that file" from "those bytes are
// damaged" from "the geometry would not load", by type rather than by matching
// message text.

// Fields are assigned in the constructor body rather than declared as
// parameter properties: Node's type stripping is strip-only and rejects the
// shorthand, so the whole test suite would fail to load.
export abstract class DocumentError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The container format is newer, or otherwise unknown, to this build.
 *
 * Deliberately not a best-effort parse: a future document may mean something
 * different by the same field, and guessing risks opening it wrongly rather
 * than not at all.
 */
export class UnsupportedSchemaVersionError extends DocumentError {
  readonly code = 'UnsupportedSchemaVersion';

  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      `This document was written with container schema version ${found}, ` +
        `and this build reads version ${supported}. ` +
        'A newer version of the application is needed to open it.',
    );
    this.found = found;
    this.supported = supported;
  }
}

/** A section is missing, unparseable, or disagrees with the manifest. */
export class DamagedDocumentError extends DocumentError {
  readonly code = 'DamagedDocument';

  readonly section: string;

  constructor(section: string, detail: string, options?: { cause?: unknown }) {
    super(`This document cannot be opened: ${section} ${detail}.`, options);
    this.section = section;
  }
}

/**
 * The checkpoint parsed as a container but the kernel could not restore it.
 *
 * Carries both OCCT versions when they differ. A document is deliberately NOT
 * refused for having been written by a different build - that would tie every
 * document to the build that wrote it - so when restoration does fail, the
 * version difference is the first thing worth knowing and must not be left to
 * be guessed at.
 */
export class GeometryRestoreError extends DocumentError {
  readonly code = 'GeometryRestore';

  readonly writtenBy: string;
  readonly runningOn: string;

  constructor(writtenBy: string, runningOn: string, options?: { cause?: unknown }) {
    super(
      writtenBy === runningOn
        ? `This document's geometry could not be restored (OCCT ${runningOn}).`
        : `This document's geometry could not be restored. It was written by ` +
          `OCCT ${writtenBy} and this build runs OCCT ${runningOn}, which may be why.`,
      options,
    );
    this.writtenBy = writtenBy;
    this.runningOn = runningOn;
  }
}
