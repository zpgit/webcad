// The document container: identity, integrity, versioning, and refusal.
//
// Most of these drive a fake kernel. That is the point of the container being
// defined against a three-method interface: the failure paths that matter -
// a truncated payload, a manifest from the future, a checkpoint that disagrees
// with its manifest - are container behavior, and forcing them through real
// OCCT would make them slower to run and harder to provoke. The last two tests
// use the real kernel, because "the geometry actually came back" is not
// something a fake can attest to.

import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { buildSections, readDocument } from '../src/document/document.ts';
import type { DocumentKernel } from '../src/document/document.ts';
import { DocumentDraft } from '../src/document/draft.ts';
import {
  DamagedDocumentError,
  GeometryRestoreError,
  UnsupportedSchemaVersionError,
} from '../src/document/errors.ts';
import type {
  DocumentManifest,
  DocumentSections,
  SectionName,
} from '../src/document/types.ts';
import { asBodyRef, SCHEMA_VERSION } from '../src/document/types.ts';
import type { BodyId } from '../src/kernel/types.ts';
import { asBodyId } from '../src/kernel/types.ts';
import { boxAndDrill, closeTo, disposeKernels, kernelSkip, makeKernel } from './helpers/kernel.ts';

const skip = kernelSkip;

// A kernel holds a WASM module, and nothing collects it while the module object
// is reachable. Released between tests rather than at exit: accumulating them
// is how a file stops working, silently, once it crosses the line.
afterEach(disposeKernels);
const FIXED_CLOCK = (): string => '2026-08-26T00:00:00.000Z';

/**
 * A kernel that serializes deterministically and restores whatever it is told
 * to. Lets a test produce a checkpoint that disagrees with its manifest, which
 * real OCCT will not do on request.
 */
class FakeKernel implements DocumentKernel {
  occtVersion = '8.0.1';
  restoreCalls = 0;
  readonly released: BodyId[] = [];

  /** Overridden to make the payload disagree with the manifest. */
  restoreCount: number | null = null;
  failRestore = false;

  #nextHandle = 500;

  async serialize(
    bodyIds: readonly BodyId[],
  ): Promise<{ bytes: Uint8Array; bodyCount: number; format: string; occtVersion: string }> {
    return {
      bytes: new TextEncoder().encode(`brep:${bodyIds.join(',')}`),
      bodyCount: bodyIds.length,
      format: 'occt-bin-brep-v4',
      occtVersion: this.occtVersion,
    };
  }

  async restore(payload: Uint8Array): Promise<BodyId[]> {
    this.restoreCalls++;
    if (this.failRestore) throw new Error('BinTools said no');
    const declared = new TextDecoder().decode(payload).slice('brep:'.length);
    const count =
      this.restoreCount ?? (declared === '' ? 0 : declared.split(',').length);
    return Array.from({ length: count }, () => asBodyId(this.#nextHandle++));
  }

  async release(bodyId: BodyId): Promise<void> {
    this.released.push(bodyId);
  }
}

/** A two-body draft with a Boolean in its history. */
function draftWithHistory(): DocumentDraft {
  const draft = DocumentDraft.create('Bracket', {
    documentId: 'doc-1',
    createdAt: FIXED_CLOCK(),
  });
  const box = draft.recordBox(asBodyId(1), { width: 60, depth: 40, height: 25 });
  const drill = draft.recordCylinder(asBodyId(2), { radius: 12, height: 25 });
  draft.recordBoolean('subtract', box, drill, asBodyId(3));
  draft.recordRelease(box);
  draft.recordRelease(drill);
  return draft;
}

function manifestOf(sections: Partial<DocumentSections>): DocumentManifest {
  const section = sections['manifest.json'];
  assert.ok(section !== undefined);
  return JSON.parse(new TextDecoder().decode(section)) as DocumentManifest;
}

/** Rewrites the manifest, so a test can corrupt exactly one field. */
function withManifest(
  sections: DocumentSections,
  edit: (manifest: Record<string, unknown>) => void,
): DocumentSections {
  const manifest = manifestOf(sections) as unknown as Record<string, unknown>;
  edit(manifest);
  return {
    ...sections,
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  };
}

function without(
  sections: DocumentSections,
  name: SectionName,
): Partial<DocumentSections> {
  const copy: Partial<DocumentSections> = { ...sections };
  delete copy[name];
  return copy;
}

// --- Round trip ---------------------------------------------------------------

test('a document round trips through its sections', async () => {
  const kernel = new FakeKernel();
  const draft = draftWithHistory();

  const sections = await buildSections(kernel, draft.content(), { now: FIXED_CLOCK });
  const opened = await readDocument(sections, kernel);

  assert.equal(opened.manifest.schemaVersion, SCHEMA_VERSION);
  assert.equal(opened.manifest.name, 'Bracket');
  assert.equal(opened.manifest.documentId, 'doc-1');
  assert.equal(opened.manifest.units, 'mm');
  assert.equal(opened.manifest.kernel.geometryFormat, 'occt-bin-brep-v4');
  assert.deepEqual(opened.warnings, []);

  // One body survives the two releases, and it is the Boolean's result.
  assert.deepEqual([...opened.bodies.keys()], ['b3']);
});

test('the construction record survives intact', async () => {
  const kernel = new FakeKernel();
  const draft = draftWithHistory();

  const sections = await buildSections(kernel, draft.content(), { now: FIXED_CLOCK });
  const opened = await readDocument(sections, kernel);

  assert.deepEqual(opened.record?.entries, [
    { op: 'createBox', produces: 'b1', params: { width: 60, depth: 40, height: 25 } },
    { op: 'createCylinder', produces: 'b2', params: { radius: 12, height: 25 } },
    { op: 'boolean', kind: 'subtract', target: 'b1', tool: 'b2', produces: 'b3' },
    { op: 'release', body: 'b1' },
    { op: 'release', body: 'b2' },
  ]);
});

/**
 * Opening must not re-execute anything.
 *
 * The record names three modelling operations; a reader that replayed it would
 * ask the kernel to build them. Restoration is one call, from the checkpoint.
 */
test('opening restores rather than replays', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content(), {
    now: FIXED_CLOCK,
  });

  kernel.restoreCalls = 0;
  await readDocument(sections, kernel);

  assert.equal(kernel.restoreCalls, 1, 'one restoration, no re-creation');
});

test('saving an unchanged session twice produces equivalent documents', async () => {
  const kernel = new FakeKernel();
  const content = draftWithHistory().content();

  const first = await buildSections(kernel, content);
  const second = await buildSections(kernel, content);

  assert.deepEqual(second['features.json'], first['features.json']);
  assert.deepEqual(second['geometry.brep'], first['geometry.brep']);

  const a = manifestOf(first) as unknown as Record<string, unknown>;
  const b = manifestOf(second) as unknown as Record<string, unknown>;
  const differing = Object.keys(a).filter(
    (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
  );
  // Only when it was saved may differ - not what was saved.
  assert.deepEqual(differing.filter((key) => key !== 'modifiedAt'), []);
});

test('an empty document round trips', async () => {
  const kernel = new FakeKernel();
  const draft = DocumentDraft.create('Empty', { documentId: 'doc-empty' });

  const sections = await buildSections(kernel, draft.content());
  const opened = await readDocument(sections, kernel);

  assert.equal(opened.bodies.size, 0);
  assert.deepEqual(opened.record?.entries, []);
});

// --- Identity -----------------------------------------------------------------

test('identities are stable across save and open', async () => {
  const kernel = new FakeKernel();
  const draft = DocumentDraft.create('Two', { documentId: 'doc-2' });
  draft.recordBox(asBodyId(1), { width: 1, depth: 1, height: 1 });
  draft.recordCylinder(asBodyId(2), { radius: 1, height: 1 });

  const sections = await buildSections(kernel, draft.content());
  const opened = await readDocument(sections, kernel);

  assert.deepEqual([...opened.bodies.keys()], ['b1', 'b2']);
  // Handles are new; the identities are not.
  assert.notDeepEqual([...opened.bodies.values()], [1, 2]);
});

/**
 * A retired identity is never reissued.
 *
 * The counter is persisted for exactly this case: derived from the surviving
 * body count, reopening a document whose `b1` was deleted would mint `b2` a
 * second time and silently alias two different bodies in its history.
 */
test('a deleted identity is not reissued after reopening', async () => {
  const kernel = new FakeKernel();
  const draft = DocumentDraft.create('Retire', { documentId: 'doc-3' });
  const first = draft.recordBox(asBodyId(1), { width: 1, depth: 1, height: 1 });
  draft.recordCylinder(asBodyId(2), { radius: 1, height: 1 });
  draft.recordRelease(first);

  const opened = await readDocument(
    await buildSections(kernel, draft.content()),
    kernel,
  );
  const reopened = DocumentDraft.fromOpened(opened);
  const next = reopened.recordBox(asBodyId(9), { width: 2, depth: 2, height: 2 });

  assert.equal(next, 'b3', 'b1 is retired and b2 is taken');
  assert.deepEqual(reopened.bodies.map((body) => body.ref), ['b2', 'b3']);
});

/**
 * The only randomness in the document layer, and the only thing in it that can
 * fail for reasons unrelated to documents.
 *
 * `crypto.randomUUID` would read better and is secure-context only, so a page
 * served over plain http could not save at all. `getRandomValues` has no such
 * restriction, which is why it is worth confirming it is actually reachable.
 */
test('a fresh draft mints a unique document id', () => {
  const ids = new Set(
    Array.from({ length: 50 }, () => DocumentDraft.create('Untitled').documentId),
  );

  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test('a reopened draft keeps its identity and history', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());
  const reopened = DocumentDraft.fromOpened(await readDocument(sections, kernel));

  assert.equal(reopened.documentId, 'doc-1');
  assert.equal(reopened.name, 'Bracket');
  assert.equal(reopened.createdAt, FIXED_CLOCK());
  assert.equal(reopened.entries.length, 5);
});

// --- Integrity ------------------------------------------------------------------

test('a truncated checkpoint is refused before the kernel sees it', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());
  const damaged: DocumentSections = {
    ...sections,
    'geometry.brep': sections['geometry.brep'].slice(0, 4),
  };

  kernel.restoreCalls = 0;
  await assert.rejects(() => readDocument(damaged, kernel), DamagedDocumentError);
  assert.equal(kernel.restoreCalls, 0, 'OCCT must never see a truncated stream');
});

test('a corrupted checkpoint fails its checksum', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());

  // Same length, one byte different: only the checksum can catch this.
  const bytes = Uint8Array.from(sections['geometry.brep']);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;

  kernel.restoreCalls = 0;
  await assert.rejects(
    () => readDocument({ ...sections, 'geometry.brep': bytes }, kernel),
    (error: unknown) =>
      error instanceof DamagedDocumentError && /checksum/.test(error.message),
  );
  assert.equal(kernel.restoreCalls, 0);
});

test('a checkpoint that disagrees with the manifest is refused, and its bodies released', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());

  // The manifest declares one body; the payload yields three.
  kernel.restoreCount = 3;
  await assert.rejects(() => readDocument(sections, kernel), DamagedDocumentError);

  assert.equal(
    kernel.released.length,
    3,
    'a refusal must not leak the handles it already issued',
  );
});

test('a missing section is refused by name', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());

  for (const name of ['manifest.json', 'geometry.brep'] as const) {
    await assert.rejects(
      () => readDocument(without(sections, name), kernel),
      (error: unknown) =>
        error instanceof DamagedDocumentError && error.message.includes(name),
    );
  }
});

test('a manifest that is not JSON is refused', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());

  await assert.rejects(
    () =>
      readDocument(
        { ...sections, 'manifest.json': new TextEncoder().encode('{ not json') },
        kernel,
      ),
    DamagedDocumentError,
  );
});

test('a manifest missing a required field is refused', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());
  const damaged = withManifest(sections, (manifest) => {
    delete manifest['nextBodyOrdinal'];
  });

  await assert.rejects(() => readDocument(damaged, kernel), DamagedDocumentError);
});

// --- Versioning -------------------------------------------------------------------

test('a document from a newer schema is refused, naming both versions', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());
  const future = withManifest(sections, (manifest) => {
    manifest['schemaVersion'] = SCHEMA_VERSION + 1;
  });

  await assert.rejects(
    () => readDocument(future, kernel),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedSchemaVersionError);
      assert.equal(error.found, SCHEMA_VERSION + 1);
      assert.equal(error.supported, SCHEMA_VERSION);
      return true;
    },
  );
});

/**
 * The version check comes first.
 *
 * A future document may mean something different by the same field names, so
 * it must be refused as unreadable rather than as malformed - the user needs
 * "upgrade the app", not "your file is broken".
 */
test('an unknown schema version wins over a malformed manifest', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());
  const future = withManifest(sections, (manifest) => {
    manifest['schemaVersion'] = 99;
    delete manifest['bodies'];
    delete manifest['geometry'];
  });

  await assert.rejects(() => readDocument(future, kernel), UnsupportedSchemaVersionError);
});

/**
 * A different OCCT build is reported, never refused.
 *
 * Refusing would tie every document to the build that wrote it, which is the
 * outcome the architecture note's migration question exists to avoid.
 */
test('a different OCCT version is a warning, not a refusal', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());

  kernel.occtVersion = '8.1.0';
  const opened = await readDocument(sections, kernel);

  assert.equal(opened.bodies.size, 1, 'the document still opens');
  assert.equal(opened.warnings.length, 1);
  assert.match(opened.warnings[0] ?? '', /8\.0\.1.*8\.1\.0/);
});

test('a restore failure names both OCCT versions', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());

  kernel.occtVersion = '9.0.0';
  kernel.failRestore = true;

  await assert.rejects(
    () => readDocument(sections, kernel),
    (error: unknown) => {
      assert.ok(error instanceof GeometryRestoreError);
      assert.equal(error.writtenBy, '8.0.1');
      assert.equal(error.runningOn, '9.0.0');
      assert.match(error.message, /8\.0\.1.*9\.0\.0/);
      return true;
    },
  );
});

// --- Inert metadata ----------------------------------------------------------------

/**
 * A damaged construction record must not cost a user their geometry.
 *
 * Nothing reads it to reconstruct anything, so refusing the document over it
 * would trade real bodies for metadata that has no consumer until MVP-4.
 */
test('an unreadable construction record costs metadata, not geometry', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());

  const opened = await readDocument(
    { ...sections, 'features.json': new TextEncoder().encode('{{{') },
    kernel,
  );

  assert.equal(opened.bodies.size, 1, 'the geometry is unaffected');
  assert.equal(opened.record, null);
  assert.match(opened.warnings.join(' '), /construction record/);
});

test('a missing construction record is a warning', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content());

  const opened = await readDocument(without(sections, 'features.json'), kernel);

  assert.equal(opened.bodies.size, 1);
  assert.equal(opened.record, null);
  assert.equal(opened.warnings.length, 1);
});

// --- Against the real kernel ---------------------------------------------------------

test('a real document round trips with exact geometry', { skip }, async () => {
  const kernel = await makeKernel();
  const { box, drill } = await boxAndDrill(kernel);
  const outcome = await kernel.subtract(box, drill);
  assert.equal(outcome.kind, 'body');
  if (outcome.kind !== 'body') return;

  const draft = DocumentDraft.create('Drilled', { documentId: 'real-1' });
  const boxRef = draft.recordBox(box, { width: 60, depth: 40, height: 25 });
  const drillRef = draft.recordCylinder(drill, { radius: 10, height: 60 });
  draft.recordBoolean('subtract', boxRef, drillRef, outcome.bodyId);
  draft.recordRelease(boxRef);
  draft.recordRelease(drillRef);
  await kernel.release(box);
  await kernel.release(drill);

  const before = await kernel.bodyInfo(outcome.bodyId);
  const beforeFaces = await kernel.faceTypeSummary(outcome.bodyId);

  const sections = await buildSections(kernel, draft.content());
  const opened = await readDocument(sections, kernel);

  // One body survives the releases: the Boolean's result.
  const surviving = draft.bodies;
  assert.equal(surviving.length, 1);
  const ref = surviving[0]?.ref;
  assert.ok(ref !== undefined);

  const restored = opened.bodies.get(ref);
  assert.ok(restored !== undefined, `the document should hold ${ref}`);

  const after = await kernel.bodyInfo(restored);
  assert.ok(closeTo(after.volume, before.volume), 'exact volume survives the container');
  assert.equal(after.faceCount, before.faceCount);
  assert.deepEqual(await kernel.faceTypeSummary(restored), beforeFaces);
  assert.equal(opened.manifest.kernel.occtVersion, kernel.occtVersion);
  assert.match(opened.manifest.geometry.checksum, /^[0-9a-f]{8}$/);
});

/**
 * Reading a document consumes its geometry section.
 *
 * Restoring transfers the payload into the kernel, so the caller's copy is
 * detached afterwards. Asserted rather than merely documented: a store that
 * cached the sections it handed over would find them hollow on the second read,
 * and the failure would surface far from here.
 */
test('reading a document detaches its geometry section', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createBox({ width: 10, depth: 10, height: 10 });

  const draft = DocumentDraft.create('One', { documentId: 'real-2' });
  draft.recordBox(body, { width: 10, depth: 10, height: 10 });

  const sections = await buildSections(kernel, draft.content());
  assert.ok(sections['geometry.brep'].byteLength > 0);

  await readDocument(sections, kernel);
  assert.equal(sections['geometry.brep'].byteLength, 0);
});

// --- Provenance ---------------------------------------------------------------
//
// MVP-2 gave bodies a source and the record an import entry. Both are metadata,
// which is precisely why they need testing: nothing downstream reads them, so a
// silent failure to persist them would go unnoticed until someone asked a
// document where its geometry came from and it had forgotten.

test('an imported body keeps its provenance across a round trip', async () => {
  const kernel = new FakeKernel();
  const draft = DocumentDraft.create('Imported', {
    documentId: 'doc-import',
    createdAt: FIXED_CLOCK(),
  });
  const refs = draft.recordImport([asBodyId(11), asBodyId(12)], {
    fileName: 'bracket.step',
    declaredUnit: 'in',
  });
  assert.equal(refs.length, 2);

  const sections = await buildSections(kernel, draft.content(), { now: FIXED_CLOCK });
  const manifest = manifestOf(sections);

  // The document's own unit is untouched by an import declaring another one:
  // conversion happened at the translation boundary, so by the time geometry
  // reaches the document there is one unit and this is it.
  assert.equal(manifest.units, 'mm');

  const source = manifest.sources?.['b1'];
  assert.ok(source !== undefined, 'a source was written');
  assert.equal(source.kind, 'imported');
  if (source.kind !== 'imported') throw new Error('unreachable');
  assert.equal(source.fileName, 'bracket.step');
  assert.equal(source.declaredUnit, 'in', 'the file\'s own unit is kept as provenance');

  const opened = await readDocument(sections, kernel);
  const reopened = DocumentDraft.fromOpened(opened);
  assert.deepEqual(reopened.sourceOf(refs[0]!), {
    kind: 'imported',
    format: 'step',
    fileName: 'bracket.step',
    declaredUnit: 'in',
  });
});

test('an import entry round trips, naming every body it produced', async () => {
  const kernel = new FakeKernel();
  const draft = DocumentDraft.create('Edited import', {
    documentId: 'doc-edit',
    createdAt: FIXED_CLOCK(),
  });
  const imported = draft.recordImport([asBodyId(21), asBodyId(22)], {
    fileName: 'rods.step',
    declaredUnit: 'mm',
  });
  const tool = draft.recordCylinder(asBodyId(23), { radius: 4, height: 20 });
  draft.recordBoolean('subtract', imported[0]!, tool, asBodyId(24));

  const sections = await buildSections(kernel, draft.content(), { now: FIXED_CLOCK });
  const opened = await readDocument(sections, kernel);
  assert.ok(opened.record !== null);

  const entries = opened.record.entries;
  const importEntry = entries[0];
  assert.ok(importEntry !== undefined);
  assert.equal(importEntry.op, 'importStep');
  if (importEntry.op !== 'importStep') throw new Error('unreachable');
  assert.equal(importEntry.fileName, 'rods.step');
  assert.deepEqual([...importEntry.produces], ['b1', 'b2']);

  // The import is a base feature and the Boolean sits on top of it, in order.
  assert.deepEqual(
    entries.map((entry) => entry.op),
    ['importStep', 'createCylinder', 'boolean'],
  );
});

test('an authored-only document writes no sources at all', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content(), {
    now: FIXED_CLOCK,
  });

  // Absence is the representation of "authored here". Writing an explicit
  // `authored` entry per body would bloat every document to say nothing.
  assert.equal(manifestOf(sections).sources, undefined);
});

test('provenance for a released body is not persisted', async () => {
  const kernel = new FakeKernel();
  const draft = DocumentDraft.create('Dropped', { documentId: 'doc-drop' });
  const refs = draft.recordImport([asBodyId(31)], {
    fileName: 'gone.step',
    declaredUnit: 'mm',
  });
  draft.recordRelease(refs[0]!);

  const sections = await buildSections(kernel, draft.content(), { now: FIXED_CLOCK });
  assert.equal(
    manifestOf(sections).sources,
    undefined,
    'a document must not claim provenance for geometry it no longer holds',
  );
});

/**
 * A document written before provenance existed must still open.
 *
 * The schema bump is additive, so the previous version is still readable. This
 * is the test that keeps that promise honest: a user's MVP-1 documents are on
 * their disk, and a version check that refused them would be a data-loss bug
 * dressed up as caution.
 */
test('a version 1 document opens, its bodies reading as authored', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content(), {
    now: FIXED_CLOCK,
  });

  const legacy = withManifest(sections, (manifest) => {
    manifest['schemaVersion'] = 1;
    delete manifest['sources'];
  });

  const opened = await readDocument(legacy, kernel);
  assert.equal(opened.manifest.schemaVersion, 1);

  const draft = DocumentDraft.fromOpened(opened);
  for (const body of draft.bodies) {
    assert.deepEqual(
      draft.sourceOf(body.ref),
      { kind: 'authored' },
      'no recorded source means authored here, not unknown',
    );
  }
});

test('a document from the future is still refused', async () => {
  const kernel = new FakeKernel();
  const sections = await buildSections(kernel, draftWithHistory().content(), {
    now: FIXED_CLOCK,
  });
  const future = withManifest(sections, (manifest) => {
    manifest['schemaVersion'] = SCHEMA_VERSION + 1;
  });

  await assert.rejects(
    () => readDocument(future, kernel),
    UnsupportedSchemaVersionError,
  );
});

test('an unreadable source entry reads as authored rather than failing', async () => {
  const kernel = new FakeKernel();
  const draft = DocumentDraft.create('Half-written', { documentId: 'doc-junk' });
  draft.recordImport([asBodyId(41)], { fileName: 'x.step', declaredUnit: 'mm' });

  const sections = await buildSections(kernel, draft.content(), { now: FIXED_CLOCK });
  const damaged = withManifest(sections, (manifest) => {
    manifest['sources'] = { b1: { kind: 'imported', format: 'step' } };
  });

  // Provenance is metadata: the rule this layer already applies to the
  // construction record applies here. A malformed entry is dropped, and what it
  // must never do is turn into invented provenance or a refused document.
  const opened = await readDocument(damaged, kernel);
  assert.equal(opened.manifest.sources, undefined);
  assert.deepEqual(
    DocumentDraft.fromOpened(opened).sourceOf(asBodyRef('b1')),
    { kind: 'authored' },
  );
});
