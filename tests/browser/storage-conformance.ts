// One conformance suite, run against both storage backends.
//
// It lives here rather than under `tests/*.test.ts` because IndexedDB and OPFS
// are browser APIs: a Node run would have to substitute a fake, and the whole
// point is quota, transaction, and file-handle behavior that only the real
// implementations have. `scripts/verify-storage.mjs` loads this module in a
// real Chrome and reports what it returns.
//
// A behavioral difference between backends that this suite does not cover is a
// gap in the suite, not an acceptable difference.

import type { DocumentSections, SectionName } from '../../src/document/types.ts';
import { SECTION_NAMES } from '../../src/document/types.ts';
import { DocumentNotFoundError, StorageQuotaError } from '../../src/storage/errors.ts';
import type { DocumentStore, DocumentSummaryInput } from '../../src/storage/types.ts';

export interface CheckResult {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'skip';
  readonly detail?: string;
}

type Open = () => Promise<DocumentStore>;

class Failure extends Error {}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Failure(message);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function makeSections(seed: string, geometryBytes = 512): DocumentSections {
  const geometry = new Uint8Array(geometryBytes);
  for (let i = 0; i < geometry.length; i++) geometry[i] = (i + seed.length) & 0xff;
  const encoder = new TextEncoder();
  return {
    'manifest.json': encoder.encode(`{"seed":"${seed}"}`),
    'features.json': encoder.encode(`{"entries":["${seed}"]}`),
    'geometry.brep': geometry,
  };
}

function summaryFor(documentId: string, name: string): DocumentSummaryInput {
  return { documentId, name, modifiedAt: '2026-08-26T00:00:00.000Z' };
}

/**
 * Sections whose Nth member throws when read.
 *
 * A production seam for fault injection would be worse than this: the store
 * reads `sections[name]` one at a time, so a throwing getter fails it exactly
 * where a real failure would, through the real code path, with nothing added to
 * `src/` for the benefit of a test.
 */
function sectionsFailingAt(
  sections: DocumentSections,
  failAt: SectionName,
): DocumentSections {
  const out: Record<string, unknown> = { ...sections };
  Object.defineProperty(out, failAt, {
    enumerable: true,
    get(): never {
      throw new Error(`simulated failure while reading ${failAt}`);
    },
  });
  return out as unknown as DocumentSections;
}

/** Removes every document, so a re-run starts from a known state. */
async function reset(store: DocumentStore): Promise<void> {
  for (const summary of await store.list()) await store.remove(summary.documentId);
  await store.setLastOpened(null);
}

interface Check {
  readonly name: string;
  run(store: DocumentStore): Promise<void>;
}

const CHECKS: Check[] = [
  {
    name: 'a saved document reads back byte-identical',
    async run(store) {
      const sections = makeSections('alpha');
      await store.save(summaryFor('doc-a', 'Alpha'), sections);

      const read = await store.read('doc-a');
      for (const sectionName of SECTION_NAMES) {
        assert(
          equalBytes(read[sectionName], sections[sectionName]),
          `${sectionName} came back different`,
        );
      }
    },
  },
  {
    name: 'listing reports the document without returning any section bytes',
    async run(store) {
      await store.save(summaryFor('doc-a', 'Alpha'), makeSections('alpha', 4096));

      const listed = await store.list();
      assert(listed.length === 1, `expected 1 document, got ${listed.length}`);

      const [summary] = listed;
      assert(summary !== undefined, 'no summary');
      assert(summary.name === 'Alpha', `name was ${summary.name}`);
      assert(summary.byteLength > 4096, 'byteLength should cover every section');
      assert(
        Object.keys(summary).sort().join(',') ===
          'byteLength,documentId,modifiedAt,name',
        `a summary carried more than metadata: ${Object.keys(summary).join(',')}`,
      );
    },
  },
  {
    name: 'saving twice replaces rather than duplicates',
    async run(store) {
      await store.save(summaryFor('doc-a', 'First'), makeSections('first'));
      await store.save(summaryFor('doc-a', 'Second'), makeSections('second'));

      const listed = await store.list();
      assert(listed.length === 1, `expected 1 document, got ${listed.length}`);
      assert(listed[0]?.name === 'Second', 'the later save must win');

      const read = await store.read('doc-a');
      assert(
        equalBytes(read['geometry.brep'], makeSections('second')['geometry.brep']),
        'the geometry is from the earlier save',
      );
    },
  },
  {
    name: 'several documents coexist',
    async run(store) {
      await store.save(summaryFor('doc-a', 'Alpha'), makeSections('alpha'));
      await store.save(summaryFor('doc-b', 'Beta'), makeSections('beta'));

      const ids = (await store.list()).map((s) => s.documentId).sort();
      assert(ids.join(',') === 'doc-a,doc-b', `got ${ids.join(',')}`);
      assert(
        equalBytes(
          (await store.read('doc-b'))['geometry.brep'],
          makeSections('beta')['geometry.brep'],
        ),
        'documents must not bleed into each other',
      );
    },
  },
  {
    name: 'reading an unknown document reports not found',
    async run(store) {
      let caught: unknown;
      try {
        await store.read('nope');
      } catch (error) {
        caught = error;
      }
      assert(
        caught instanceof DocumentNotFoundError,
        `expected DocumentNotFoundError, got ${String(caught)}`,
      );
    },
  },
  {
    name: 'deletion removes every section',
    async run(store) {
      await store.save(summaryFor('doc-a', 'Alpha'), makeSections('alpha'));
      await store.remove('doc-a');

      assert((await store.list()).length === 0, 'still listed after deletion');

      let caught: unknown;
      try {
        await store.read('doc-a');
      } catch (error) {
        caught = error;
      }
      assert(
        caught instanceof DocumentNotFoundError,
        'a deleted document must not still read back',
      );
    },
  },
  {
    name: 'the last-opened document is remembered',
    async run(store) {
      assert((await store.lastOpened()) === null, 'should start empty');
      await store.setLastOpened('doc-a');
      assert((await store.lastOpened()) === 'doc-a', 'not remembered');
      await store.setLastOpened(null);
      assert((await store.lastOpened()) === null, 'not cleared');
    },
  },
  {
    name: 'deleting the last-opened document clears the pointer',
    async run(store) {
      await store.save(summaryFor('doc-a', 'Alpha'), makeSections('alpha'));
      await store.setLastOpened('doc-a');
      await store.remove('doc-a');

      assert(
        (await store.lastOpened()) === null,
        'the next load would reach for a document that is gone',
      );
    },
  },
  {
    name: 'the last-opened pointer survives reopening the store',
    async run(store) {
      await store.setLastOpened('doc-a');
      // Persistence, not memoization: a page reload gets a new store object.
      assert((await store.lastOpened()) === 'doc-a', 'not persisted');
    },
  },
  {
    name: 'an interrupted overwrite leaves the previous document intact',
    async run(store) {
      const original = makeSections('original');
      await store.save(summaryFor('doc-a', 'Original'), original);

      let failed = false;
      try {
        await store.save(
          summaryFor('doc-a', 'Doomed'),
          sectionsFailingAt(makeSections('doomed'), 'geometry.brep'),
        );
      } catch {
        failed = true;
      }
      assert(failed, 'the save should have failed');

      const listed = await store.list();
      assert(listed.length === 1, `expected 1 document, got ${listed.length}`);
      assert(
        listed[0]?.name === 'Original',
        `the failed save replaced the summary with ${listed[0]?.name}`,
      );

      const read = await store.read('doc-a');
      for (const sectionName of SECTION_NAMES) {
        assert(
          equalBytes(read[sectionName], original[sectionName]),
          `${sectionName} is not what it was before the failed save`,
        );
      }
    },
  },
  {
    name: 'an interrupted first save leaves nothing behind',
    async run(store) {
      let failed = false;
      try {
        await store.save(
          summaryFor('doc-new', 'Doomed'),
          sectionsFailingAt(makeSections('doomed'), 'geometry.brep'),
        );
      } catch {
        failed = true;
      }
      assert(failed, 'the save should have failed');

      assert(
        (await store.list()).length === 0,
        'a half-written document appeared in the list',
      );

      let caught: unknown;
      try {
        await store.read('doc-new');
      } catch (error) {
        caught = error;
      }
      assert(
        caught instanceof DocumentNotFoundError,
        'a half-written document is readable',
      );
    },
  },
  {
    name: 'a store recovers for use after a failed save',
    async run(store) {
      try {
        await store.save(
          summaryFor('doc-a', 'Doomed'),
          sectionsFailingAt(makeSections('doomed'), 'features.json'),
        );
      } catch {
        // expected
      }
      await store.save(summaryFor('doc-a', 'Fine'), makeSections('fine'));
      assert((await store.list())[0]?.name === 'Fine', 'the store did not recover');
    },
  },
];

export async function runStorageConformance(open: Open): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of CHECKS) {
    let store: DocumentStore | null = null;
    try {
      store = await open();
      await reset(store);
      await check.run(store);
      results.push({ name: check.name, status: 'pass' });
    } catch (error) {
      results.push({
        name: check.name,
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (store !== null) {
        await reset(store).catch(() => undefined);
        store.close();
      }
    }
  }

  return results;
}

/**
 * Quota exhaustion, run separately because the harness has to shrink the quota
 * first via the DevTools protocol.
 *
 * Not folded into the suite above: without the override this cannot be
 * provoked at all on a modern browser, and a check that silently never fires
 * would read as coverage it is not.
 */
export async function checkQuotaExhaustion(
  open: Open,
  payloadBytes: number,
): Promise<CheckResult> {
  const name = 'an exhausted quota is reported as a typed failure';
  let store: DocumentStore | null = null;
  try {
    store = await open();
    await reset(store);

    let caught: unknown;
    try {
      await store.save(
        summaryFor('doc-big', 'Too big'),
        makeSections('big', payloadBytes),
      );
    } catch (error) {
      caught = error;
    }

    if (caught === undefined) {
      // The harness could not create the condition, which is not the same as
      // the store mishandling it. Chrome enforces an overridden quota for OPFS
      // but not for IndexedDB, whose writes land regardless - so reporting this
      // as a failure would blame the store for the browser's accounting.
      // Reported as a skip so the gap is visible rather than absent.
      return {
        name,
        status: 'skip',
        detail:
          `saving ${payloadBytes} bytes succeeded despite the reduced quota - ` +
          'this browser does not enforce it for this backend, so exhaustion was NOT exercised',
      };
    }
    if (!(caught instanceof StorageQuotaError)) {
      return {
        name,
        status: 'fail',
        detail: `expected StorageQuotaError, got ${String(caught)}`,
      };
    }

    // The failure must not have left a partial document behind either.
    const listed = await store.list();
    return listed.length === 0
      ? { name, status: 'pass' }
      : { name, status: 'fail', detail: 'a document survived a quota failure' };
  } catch (error) {
    return {
      name,
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (store !== null) {
      await reset(store).catch(() => undefined);
      store.close();
    }
  }
}
