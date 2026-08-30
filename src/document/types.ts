// The native document: a versioned container of named sections.
//
// The architecture note is explicit that the document format is a container and
// that B-Rep serialization is one payload within it (note section 3-4). That
// distinction is load-bearing here: nothing in this file knows what the
// geometry section contains, and nothing may parse it. The container's job is
// section names, versions, identity, and integrity.
//
// "Section" is deliberate, and "part" is deliberately not used for it: a part
// here means what XCAF, STEP, and every CAD user mean by it - geometry that one
// or more instances reference. The three files a document is made of are
// sections, and the stored names are unchanged by the distinction.
//
// It is also explicitly NOT STEP. Saving does not pass geometry through an
// interchange schema. STEP is an import and export concern, and now that both
// exist the distinction is sharper rather than softer: geometry that arrived
// from a STEP file is checkpointed in the native encoding like any other, and
// the file it came from is recorded as provenance, not as a source to re-read.

import type { BooleanKind, BoxOptions, CylinderOptions } from '../kernel/types.ts';

/**
 * The container format's version.
 *
 * A build refuses any version it has no reader for, rather than parsing a
 * future document on a best-effort basis. Note that this versions the
 * *container*, not the geometry encoding inside it and not the OCCT build that
 * wrote it - those are recorded separately and treated differently.
 */
export const SCHEMA_VERSION = 2;

/**
 * The last version whose documents this build can still read.
 *
 * Version 2 added body provenance and the `importStep` construction entry, both
 * of which are additive: a version 1 document simply has no sources recorded,
 * and every body in it was authored here, which is what its absence means. So
 * older documents open rather than being refused - a schema bump is not a reason
 * to cost someone their geometry.
 */
export const MIN_READABLE_SCHEMA_VERSION = 1;

/**
 * Section names, which double as file names for a store that has files.
 *
 * Taken from the layout the architecture note recommends. `topology.bin` and
 * `preview.glb` appear there too and are deliberately absent: there is no
 * persistent identity mapping to write yet (MVP-4), and a persisted preview
 * mesh would hide re-tessellation from the recovery measurement this stage
 * exists to take.
 */
export const SECTION_NAMES = ['manifest.json', 'features.json', 'geometry.brep'] as const;

export type SectionName = (typeof SECTION_NAMES)[number];

/**
 * A document as bytes: named sections, each readable without parsing the others.
 *
 * Uniformly bytes so that a store can persist them without knowing which are
 * text and which are binary - an IndexedDB record field and an OPFS file are
 * both just bytes - and so a round trip can be asserted byte-identical.
 */
export type DocumentSections = Readonly<Record<SectionName, Uint8Array>>;

declare const bodyRefBrand: unique symbol;

/**
 * A body's identity within a document. Stable across save and open.
 *
 * Kernel `BodyId` handles cannot serve: they are indices into a live registry
 * and mean nothing once the Worker is gone. So a document mints its own,
 * records the order they appear in the checkpoint, and rebinds them to fresh
 * handles on open.
 *
 * This is identity for a BODY. It is not extended to a face, an edge, or a
 * vertex, and it is not a step toward persistent naming - section 7 of the
 * architecture note rules out positional sub-entity references, and MVP-4 still
 * faces that problem whole.
 */
export type BodyRef = string & { readonly [bodyRefBrand]: true };

export function asBodyRef(raw: string): BodyRef {
  return raw as BodyRef;
}

/** Mints `b1`, `b2`, ... - deterministic, so a saved document is diffable. */
export function bodyRefFor(ordinal: number): BodyRef {
  return asBodyRef(`b${ordinal}`);
}

export interface GeometryIntegrity {
  /** Length of the geometry payload, checked before it reaches the kernel. */
  readonly byteLength: number;
  /**
   * CRC-32 of the payload, as eight lowercase hex digits.
   *
   * Corruption detection, not tamper resistance: the failure being guarded
   * against is a torn write or a truncated read, and a document that has been
   * deliberately edited is out of scope for a browser-local store.
   */
  readonly checksum: string;
}

export interface KernelProvenance {
  /** The OCCT build that wrote the geometry payload. */
  readonly occtVersion: string;
  /** The payload's encoding, so a reader never has to sniff it. */
  readonly geometryFormat: string;
}

/**
 * Where a body came from.
 *
 * `authored` means it was built here, out of primitives and Booleans. `imported`
 * means it was translated from an external file, and carries what that file
 * said about itself: its name, its format, and the length unit it declared.
 *
 * This is provenance and nothing more. It does not restrict what a body can be
 * used for - an imported body is an ordinary body - and it is never consulted to
 * reconstruct geometry. In particular `fileName` is a record of where the
 * geometry came from, NOT a reference to be resolved: opening a document must
 * never try to find that file again, because the geometry is in the checkpoint
 * and the file may be long gone.
 */
export type BodySource =
  | { readonly kind: 'authored' }
  | {
      readonly kind: 'imported';
      readonly format: 'step';
      readonly fileName: string;
      /**
       * The unit the source file declared, or `unknown` when it declared none.
       *
       * Kept separate from the manifest's `units` on purpose. Conversion happens
       * once, during translation, at the boundary; by the time geometry reaches
       * the document it is already in the working unit. So this field records
       * what the file said, and never contradicts what the document is in.
       */
      readonly declaredUnit: string;
    };

export interface DocumentManifest {
  readonly schemaVersion: number;
  readonly documentId: string;
  readonly name: string;
  /**
   * The unit the document's numbers are expressed in.
   *
   * Declared and never converted *by this layer*. The kernel is unitless - its
   * numbers are bare doubles - so this exists to stop a document being silently
   * unit-ambiguous.
   *
   * MVP-1 added this field expecting STEP import to give it something to
   * disagree with. It does not, and that turned out to be the right answer:
   * OCCT's reader converts a file's declared unit into the working unit as part
   * of the transfer, so the conversion happens once, at the boundary, and a
   * document containing imported geometry has one working unit like any other.
   * What the file declared is recorded per body in `BodySource` instead, where
   * it is provenance rather than a competing truth.
   */
  readonly units: 'mm';
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly kernel: KernelProvenance;
  readonly geometry: GeometryIntegrity;
  /**
   * Body identities, ordered by their position in the checkpoint.
   *
   * This array IS the mapping from checkpoint position to identity. It is
   * written down rather than left implicit in iteration order, because a
   * disagreement between it and the payload must be detectable: the count is
   * checked on open and a mismatch refuses the document.
   */
  readonly bodies: readonly BodyRef[];
  /**
   * Where each body came from, keyed by identity.
   *
   * Sparse by design: an entry is written only for a body that needs one, and a
   * body with no entry is `authored`. That is what lets a version 1 document -
   * which has no sources at all - be read as what it is, a document of bodies
   * built here, without a migration step.
   */
  readonly sources?: Readonly<Record<string, BodySource>>;
  /**
   * The next ordinal to mint.
   *
   * Persisted rather than derived from `bodies.length`, because identities are
   * never reused: deleting `b1` from a two-body document and adding another
   * would otherwise mint `b2` a second time.
   */
  readonly nextBodyOrdinal: number;
}

/**
 * One step in how the document's bodies came to exist.
 *
 * Inert. Written, read back, and displayable; never executed. Restoration comes
 * from the checkpoint alone. Replay would need stable references to faces and
 * edges across topology changes, which is MVP-4's entire subject and the note's
 * known hard problem - so this records history without claiming to reproduce
 * it.
 *
 * Not to be confused with the kernel's `OperationRecord`, which is per-operation
 * timing for the measurement readout and is session-scoped telemetry.
 */
export type ConstructionEntry =
  | { readonly op: 'createBox'; readonly produces: BodyRef; readonly params: BoxOptions }
  | {
      readonly op: 'createCylinder';
      readonly produces: BodyRef;
      readonly params: CylinderOptions;
    }
  | {
      readonly op: 'boolean';
      readonly kind: BooleanKind;
      readonly target: BodyRef;
      readonly tool: BodyRef;
      readonly produces: BodyRef;
    }
  | {
      /**
       * Geometry entered the document from an external file.
       *
       * A base feature, in the note's terms (section 6): the imported bodies are
       * where history starts, and no parametric history is invented behind them.
       * Later operations are recorded on top of it in the ordinary way.
       *
       * Inert in the strongest sense of the word. Every other entry here is
       * inert because replaying it would need persistent references this system
       * does not have; this one is inert because there is nothing to replay at
       * all. The file is not a dependency, and opening a document must not go
       * looking for it.
       */
      readonly op: 'importStep';
      readonly fileName: string;
      readonly declaredUnit: string;
      /** Bodies this import produced, in the order the translation issued them. */
      readonly produces: readonly BodyRef[];
    }
  | { readonly op: 'release'; readonly body: BodyRef };

export interface ConstructionRecord {
  readonly entries: readonly ConstructionEntry[];
}
