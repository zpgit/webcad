// Writing a document and reading one back.
//
// The order of checks on the way in is deliberate and is the whole safety
// argument: schema version, then section presence, then integrity, and only then
// are bytes handed to the kernel. A truncated payload must be refused before
// OCCT sees it, and a version this build cannot read must be refused before its
// fields are interpreted at all.
//
// Nothing here parses the geometry payload. The container measures it and
// checksums it; what is inside those bytes is the kernel's business.

import type { BodyId, BrepPayload } from '../kernel/types.ts';
import { checksumOf } from './checksum.ts';
import {
  DamagedDocumentError,
  GeometryRestoreError,
  UnsupportedSchemaVersionError,
} from './errors.ts';
import type {
  BodyRef,
  BodySource,
  ConstructionEntry,
  ConstructionRecord,
  DocumentManifest,
  DocumentSections,
  SectionName,
} from './types.ts';
import { MIN_READABLE_SCHEMA_VERSION, SCHEMA_VERSION } from './types.ts';

/**
 * What the document layer needs from the kernel.
 *
 * Narrower than `Kernel` on purpose: the container's dependency is exactly
 * "turn handles into bytes, turn bytes into handles, and let go of a handle",
 * and stating that makes it testable without a WASM module.
 */
export interface DocumentKernel {
  readonly occtVersion: string;
  serialize(bodyIds: readonly BodyId[]): Promise<BrepPayload>;
  restore(payload: Uint8Array): Promise<BodyId[]>;
  release(bodyId: BodyId): Promise<void>;
}

/** A document's live state, as the editing session holds it. */
export interface DocumentContent {
  readonly documentId: string;
  readonly name: string;
  readonly createdAt: string;
  /** Live bodies in the order they will be written to the checkpoint. */
  readonly bodies: readonly { readonly ref: BodyRef; readonly handle: BodyId }[];
  readonly entries: readonly ConstructionEntry[];
  /**
   * Where bodies came from, for the ones that came from somewhere.
   *
   * Absent entries mean `authored`, so a session that has imported nothing
   * passes nothing here.
   */
  readonly sources?: ReadonlyMap<BodyRef, BodySource>;
  readonly nextBodyOrdinal: number;
}

export interface OpenedDocument {
  readonly manifest: DocumentManifest;
  /** Document identity to the handle it was restored as, in checkpoint order. */
  readonly bodies: ReadonlyMap<BodyRef, BodyId>;
  /** Null when the construction record was unreadable; the geometry is not. */
  readonly record: ConstructionRecord | null;
  /** Non-fatal observations: a version difference, an unreadable record. */
  readonly warnings: readonly string[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, null, 2));
}

/**
 * Serializes the session into container sections.
 *
 * `now` is injectable so a test can assert a document's content rather than
 * work around a timestamp.
 */
export async function buildSections(
  kernel: DocumentKernel,
  content: DocumentContent,
  options: { readonly now?: () => string } = {},
): Promise<DocumentSections> {
  const now = options.now ?? ((): string => new Date().toISOString());

  const payload = await kernel.serialize(content.bodies.map((body) => body.handle));

  // An invariant of this layer rather than a user-facing failure: the kernel
  // wrote a different number of bodies than were asked for, which would make
  // the manifest's position-to-identity mapping a lie.
  if (payload.bodyCount !== content.bodies.length) {
    throw new Error(
      `serialized ${payload.bodyCount} bodies for a document holding ` +
        `${content.bodies.length}`,
    );
  }

  // Only for bodies actually in the checkpoint: a source for a body that was
  // released would persist provenance for geometry the document no longer holds.
  const sources: Record<string, BodySource> = {};
  for (const body of content.bodies) {
    const source = content.sources?.get(body.ref);
    if (source !== undefined && source.kind !== 'authored') {
      sources[body.ref] = source;
    }
  }

  const manifest: DocumentManifest = {
    schemaVersion: SCHEMA_VERSION,
    documentId: content.documentId,
    name: content.name,
    units: 'mm',
    createdAt: content.createdAt,
    modifiedAt: now(),
    kernel: {
      occtVersion: payload.occtVersion,
      geometryFormat: payload.format,
    },
    geometry: {
      byteLength: payload.bytes.byteLength,
      checksum: checksumOf(payload.bytes),
    },
    bodies: content.bodies.map((body) => body.ref),
    // Written only for bodies that have something to say. A document of purely
    // authored bodies carries no sources map at all, which keeps a version 2
    // document byte-comparable with a version 1 one apart from the version.
    ...(Object.keys(sources).length === 0 ? {} : { sources }),
    nextBodyOrdinal: content.nextBodyOrdinal,
  };

  const record: ConstructionRecord = { entries: content.entries };

  return {
    'manifest.json': encodeJson(manifest),
    'features.json': encodeJson(record),
    'geometry.brep': payload.bytes,
  };
}

/**
 * Validates a document and restores its geometry.
 *
 * **Consumes the geometry section.** Restoring transfers the payload into the
 * kernel, so `sections['geometry.brep']` is detached when this returns. The
 * checksum is taken before that happens, and a caller that needs the bytes
 * afterwards must copy them first.
 *
 * On refusal nothing is left behind: no handles are issued, or any that were
 * are released before the error is reported. The caller's existing session is
 * untouched, because this function never touches it.
 */
export async function readDocument(
  sections: Partial<DocumentSections>,
  kernel: DocumentKernel,
): Promise<OpenedDocument> {
  const warnings: string[] = [];

  const manifest = parseManifest(requireSection(sections, 'manifest.json'));
  const geometry = requireSection(sections, 'geometry.brep');

  // Integrity before the kernel, always. Handing OCCT a truncated stream is
  // how a damaged document becomes a crash instead of a message.
  if (geometry.byteLength !== manifest.geometry.byteLength) {
    throw new DamagedDocumentError(
      'geometry.brep',
      `is ${geometry.byteLength} bytes but the manifest records ` +
        `${manifest.geometry.byteLength}`,
    );
  }
  const checksum = checksumOf(geometry);
  if (checksum !== manifest.geometry.checksum) {
    throw new DamagedDocumentError(
      'geometry.brep',
      `failed its checksum (expected ${manifest.geometry.checksum}, got ${checksum})`,
    );
  }

  // Inert metadata must never be able to cost a user their geometry, so this is
  // the one section whose failure is a warning rather than a refusal.
  const record = readRecord(sections['features.json'], warnings);

  if (manifest.kernel.occtVersion !== kernel.occtVersion) {
    warnings.push(
      `Written by OCCT ${manifest.kernel.occtVersion}; this build runs ` +
        `${kernel.occtVersion}.`,
    );
  }

  let handles: BodyId[];
  try {
    handles = await kernel.restore(geometry);
  } catch (cause) {
    throw new GeometryRestoreError(
      manifest.kernel.occtVersion,
      kernel.occtVersion,
      { cause },
    );
  }

  // The manifest's mapping and the payload must agree. Opening with a guessed
  // correspondence would bind identities to the wrong bodies, which is worse
  // than not opening: every later edit would be recorded against the wrong one.
  if (handles.length !== manifest.bodies.length) {
    await Promise.all(handles.map((handle) => kernel.release(handle)));
    throw new DamagedDocumentError(
      'geometry.brep',
      `holds ${handles.length} bodies but the manifest declares ` +
        `${manifest.bodies.length}`,
    );
  }

  const bodies = new Map<BodyRef, BodyId>();
  manifest.bodies.forEach((ref, index) => {
    const handle = handles[index];
    if (handle !== undefined) bodies.set(ref, handle);
  });

  return { manifest, bodies, record, warnings };
}

// --- Parsing -----------------------------------------------------------------

function requireSection(
  sections: Partial<DocumentSections>,
  name: SectionName,
): Uint8Array {
  const section = sections[name];
  if (section === undefined) {
    throw new DamagedDocumentError(name, 'is missing');
  }
  return section;
}

function parseJson(section: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(decoder.decode(section));
  } catch (cause) {
    throw new DamagedDocumentError(name, 'could not be parsed', { cause });
  }
}

function parseManifest(section: Uint8Array): DocumentManifest {
  const raw = parseJson(section, 'manifest.json');
  if (!isRecord(raw)) {
    throw new DamagedDocumentError('manifest.json', 'is not an object');
  }

  // Version first, before any other field is interpreted. A future document may
  // mean something different by the same field name, so "unreadable version" is
  // a distinct answer from "malformed", and the user gets the actionable one.
  const schemaVersion = raw['schemaVersion'];
  if (typeof schemaVersion !== 'number') {
    throw new DamagedDocumentError('manifest.json', 'declares no schema version');
  }
  // A future version is refused; an older one within the readable range is not.
  // Version 2's additions - body provenance and the import entry - are purely
  // additive, and their absence in a version 1 document is not a gap to be
  // filled but a fact: nothing in it was imported. Refusing it would cost a user
  // their geometry over a field they never needed.
  if (
    schemaVersion > SCHEMA_VERSION ||
    schemaVersion < MIN_READABLE_SCHEMA_VERSION
  ) {
    throw new UnsupportedSchemaVersionError(schemaVersion, SCHEMA_VERSION);
  }

  const kernel = raw['kernel'];
  const geometry = raw['geometry'];
  if (!isRecord(kernel) || !isRecord(geometry)) {
    throw new DamagedDocumentError('manifest.json', 'is missing kernel or geometry provenance');
  }

  const bodies = raw['bodies'];
  if (!Array.isArray(bodies) || bodies.some((ref) => typeof ref !== 'string')) {
    throw new DamagedDocumentError('manifest.json', 'has no readable body list');
  }

  const sources = readSources(raw['sources']);

  return {
    schemaVersion,
    documentId: requireString(raw, 'documentId'),
    name: requireString(raw, 'name'),
    units: 'mm',
    createdAt: requireString(raw, 'createdAt'),
    modifiedAt: requireString(raw, 'modifiedAt'),
    kernel: {
      occtVersion: requireString(kernel, 'occtVersion'),
      geometryFormat: requireString(kernel, 'geometryFormat'),
    },
    geometry: {
      byteLength: requireNumber(geometry, 'byteLength'),
      checksum: requireString(geometry, 'checksum'),
    },
    bodies: bodies as readonly BodyRef[],
    ...(sources === undefined ? {} : { sources }),
    nextBodyOrdinal: requireNumber(raw, 'nextBodyOrdinal'),
  };
}

/**
 * Reads the body-provenance map, if there is one.
 *
 * Absent is normal, not damaged: a version 1 document has no such field, and a
 * version 2 document that imported nothing does not write one. An entry that is
 * present but unreadable is dropped rather than refused - provenance is
 * metadata, and the rule this layer already applies to the construction record
 * applies here too. What it must never do is invent provenance, so a dropped
 * entry reads as `authored`, which is the same thing its absence means.
 */
function readSources(
  raw: unknown,
): Readonly<Record<string, BodySource>> | undefined {
  if (!isRecord(raw)) return undefined;

  const sources: Record<string, BodySource> = {};
  for (const [ref, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    if (value['kind'] !== 'imported' || value['format'] !== 'step') continue;
    const fileName = value['fileName'];
    const declaredUnit = value['declaredUnit'];
    if (typeof fileName !== 'string' || typeof declaredUnit !== 'string') continue;
    sources[ref] = { kind: 'imported', format: 'step', fileName, declaredUnit };
  }
  return Object.keys(sources).length === 0 ? undefined : sources;
}

/**
 * Reads the construction record, downgrading any failure to a warning.
 *
 * The record has no consumer that reconstructs geometry, so a document with an
 * unreadable one is still a document. Refusing it would trade a user's bodies
 * for metadata nothing reads.
 */
function readRecord(
  section: Uint8Array | undefined,
  warnings: string[],
): ConstructionRecord | null {
  if (section === undefined) {
    warnings.push('This document has no construction record.');
    return null;
  }
  try {
    const raw = JSON.parse(decoder.decode(section)) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw['entries'])) {
      throw new Error('no entry list');
    }
    return { entries: raw['entries'] as readonly ConstructionEntry[] };
  } catch {
    warnings.push(
      "This document's construction record could not be read; its geometry is unaffected.",
    );
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw new DamagedDocumentError('manifest.json', `has no "${key}"`);
  }
  return value;
}

function requireNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number') {
    throw new DamagedDocumentError('manifest.json', `has no "${key}"`);
  }
  return value;
}
