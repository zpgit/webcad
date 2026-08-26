// The parts of the storage layer that do not need a browser.
//
// Everything else lives in the conformance suite, which runs against real
// IndexedDB and real OPFS. This file exists for one reason: Chrome does not
// enforce an overridden quota for IndexedDB, so the browser run cannot provoke
// exhaustion on that backend and reports it as not exercised. The mapping from
// the browser's exception to a typed failure is still worth covering, and it
// can be covered here without one.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DocumentNotFoundError,
  StorageError,
  StorageQuotaError,
  StorageUnavailableError,
  isQuotaExceeded,
} from '../src/storage/errors.ts';

test('the browser\'s out-of-space exception is recognized', () => {
  assert.equal(
    isQuotaExceeded(new DOMException('too big', 'QuotaExceededError')),
    true,
  );
  assert.equal(
    isQuotaExceeded(new DOMException('too big', 'NS_ERROR_DOM_QUOTA_REACHED')),
    true,
  );
});

/**
 * The name is the only reliable discriminator - the message is unspecified and
 * differs between engines - so a message-based check would quietly stop working.
 */
test('other failures are not mistaken for a full disk', () => {
  for (const other of [
    new DOMException('gone', 'NotFoundError'),
    new DOMException('nope', 'InvalidStateError'),
    new Error('QuotaExceededError'),
    'QuotaExceededError',
    null,
  ]) {
    assert.equal(isQuotaExceeded(other), false, `${String(other)} is not a quota error`);
  }
});

test('storage failures are typed and name their backend', () => {
  const quota = new StorageQuotaError('IndexedDB');
  assert.ok(quota instanceof StorageError);
  assert.equal(quota.code, 'StorageQuota');
  assert.equal(quota.backend, 'IndexedDB');
  // The user needs to know their work is not lost, not just that a write failed.
  assert.match(quota.message, /Nothing was saved/);

  const unavailable = new StorageUnavailableError('OPFS', 'the API is not present');
  assert.equal(unavailable.code, 'StorageUnavailable');
  assert.equal(unavailable.backend, 'OPFS');

  const missing = new DocumentNotFoundError('doc-9');
  assert.equal(missing.code, 'DocumentNotFound');
  assert.equal(missing.documentId, 'doc-9');
});

test('every storage error keeps its own name after construction', () => {
  assert.equal(new StorageQuotaError('OPFS').name, 'StorageQuotaError');
  assert.equal(new DocumentNotFoundError('x').name, 'DocumentNotFoundError');
});
