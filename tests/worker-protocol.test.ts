// The transport layer, tested without a browser.
//
// These cover the machinery the Worker boundary adds rather than any geometry:
// correlation, ordering, error revival, and what happens when the host dies.
// The geometry suites drive the same handler through `InProcessTransport`.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidHandleError,
  InvalidParameterError,
  KernelError,
  KernelNotReadyError,
  KernelOperationFailedError,
  KernelTerminatedError,
  WebAssemblyUnsupportedError,
  reviveFailure,
  toFailure,
} from '../src/kernel/errors.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import type { KernelEnvelope, KernelResponse } from '../src/kernel/worker/protocol.ts';
import { WorkerTransport } from '../src/kernel/worker/worker-transport.ts';
import { kernelSkip, makeKernel } from './helpers/kernel.ts';

const skip = kernelSkip;

/**
 * A stand-in for the browser's Worker.
 *
 * Node has no DOM `Worker`, and the routing rules are worth testing without
 * one: they decide which caller a response reaches, which is the one thing a
 * correlated protocol can get catastrophically wrong.
 */
class FakeWorker {
  onmessage: ((event: { data: KernelResponse }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  readonly received: KernelEnvelope[] = [];
  readonly transferred: (readonly Transferable[])[] = [];
  terminated = false;

  postMessage(envelope: KernelEnvelope, transfer: readonly Transferable[] = []): void {
    this.received.push(envelope);
    this.transferred.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answers a request, as the real Worker would. */
  reply(id: number, value: unknown): void {
    this.onmessage?.({ data: { id, ok: true, value, tail: {} } });
  }

  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

function transportWith(worker: FakeWorker): WorkerTransport {
  return new WorkerTransport(() => worker.asWorker());
}

const envelope = (id: number): KernelEnvelope => ({
  id,
  request: { kind: 'stats' },
});

// --- Correlation ------------------------------------------------------------

test('each caller receives the result of its own request', async () => {
  const worker = new FakeWorker();
  const transport = transportWith(worker);

  const first = transport.send(envelope(1));
  const second = transport.send(envelope(2));
  const third = transport.send(envelope(3));

  // Answered out of order, which is exactly what correlation has to survive.
  worker.reply(2, 'second');
  worker.reply(3, 'third');
  worker.reply(1, 'first');

  assert.deepEqual(
    (await Promise.all([first, second, third])).map((r) =>
      r.ok ? r.value : r.error.code,
    ),
    ['first', 'second', 'third'],
  );
});

test('a response matching no pending request is discarded', async () => {
  const worker = new FakeWorker();
  const transport = transportWith(worker);

  const pending = transport.send(envelope(7));

  // An id nobody is waiting on must not settle the call that is waiting.
  worker.reply(999, 'stray');
  worker.reply(7, 'mine');
  const response = await pending;
  assert.equal(response.ok && response.value, 'mine');

  // A duplicate answer for an already-settled id is equally harmless.
  worker.reply(7, 'again');
});

test('settled requests are not retained', async () => {
  const worker = new FakeWorker();
  const transport = transportWith(worker);

  for (let id = 1; id <= 20; id++) {
    const pending = transport.send(envelope(id));
    worker.reply(id, id);
    await pending;
  }

  // Nothing is left to leak: a dead transport has no one to notify.
  transport.dispose();
  assert.equal(worker.terminated, true);
});

// --- Inbound transfer ---------------------------------------------------------

/**
 * A payload sent into the Worker moves rather than clones.
 *
 * Mesh has always been transferred coming back; this is the first request that
 * carries bytes the other way. Asserted at the transport rather than end to
 * end, because a missing transfer list is invisible from the outside - the
 * request still works, it just quietly copies a checkpoint on every restore.
 */
test('a restore request lists its payload as transferable', async () => {
  const worker = new FakeWorker();
  const transport = transportWith(worker);

  const payload = new Uint8Array([1, 2, 3, 4]);
  const pending = transport.send({ id: 1, request: { kind: 'restore', payload } });
  worker.reply(1, { bodyIds: [] });
  await pending;

  assert.deepEqual(worker.transferred[0], [payload.buffer]);
});

test('requests without a payload transfer nothing', async () => {
  const worker = new FakeWorker();
  const transport = transportWith(worker);

  const pending = transport.send(envelope(1));
  worker.reply(1, null);
  await pending;

  assert.deepEqual(worker.transferred[0], []);
});

// --- Host death -------------------------------------------------------------

test('a worker that dies settles every request in flight', async () => {
  const worker = new FakeWorker();
  const transport = transportWith(worker);

  const inFlight = [transport.send(envelope(1)), transport.send(envelope(2))];
  worker.onerror?.({ message: 'worker exploded' });

  for (const response of await Promise.all(inFlight)) {
    assert.equal(response.ok, false);
    if (response.ok) continue;
    assert.equal(response.error.code, 'KernelTerminated');
  }
  assert.equal(worker.terminated, true, 'the dead worker must be torn down');
});

test('a dead worker leaves the kernel not ready, and pending calls reject', async () => {
  const worker = new FakeWorker();
  const kernel = new Kernel({ transport: transportWith(worker) });

  const initializing = kernel.initialize();
  worker.onerror?.({ message: 'worker exploded' });

  await assert.rejects(() => initializing, KernelTerminatedError);
  assert.equal(kernel.isReady, false);
  // And a later call fails as not-ready rather than hanging forever.
  await assert.rejects(() => kernel.bodyInfo(1 as never), KernelNotReadyError);
});

test('a disposed kernel refuses further work', { skip }, async () => {
  const kernel = await makeKernel();
  const body = await kernel.createBox({ width: 4, depth: 4, height: 4 });
  assert.ok(body >= 0);

  kernel.dispose();

  assert.equal(kernel.isReady, false);
  await assert.rejects(() => kernel.bodyInfo(body), KernelNotReadyError);
  assert.throws(() => kernel.stats(), KernelNotReadyError);
});

// --- Error revival ----------------------------------------------------------

/**
 * Every error type must survive the boundary as itself.
 *
 * Structured cloning flattens an Error subclass to a plain Error, so callers
 * that discriminate by type - which the specs require, rather than matching
 * message text - would silently start catching the wrong thing.
 */
test('every kernel error type survives a round trip', () => {
  const cases: KernelError[] = [
    new KernelNotReadyError('createBox'),
    new WebAssemblyUnsupportedError('no WebAssembly here'),
    new InvalidHandleError('no such body', 'release'),
    new InvalidParameterError('width must be positive', 'createBox'),
    new KernelOperationFailedError('BRepAlgoAPI reported failure', 'subtract'),
    new KernelTerminatedError('the kernel worker stopped', 'worker'),
  ];

  for (const original of cases) {
    const revived = reviveFailure(toFailure(original, original.operation));

    assert.equal(
      revived.constructor,
      original.constructor,
      `${original.name} must revive as itself`,
    );
    assert.equal(revived.code, original.code);
    assert.equal(revived.operation, original.operation);
    // Not merely "contains": re-framing a framed message would double the
    // prefix, which is why the raw detail crosses separately.
    assert.equal(revived.message, original.message);
  }
});

test('an unrecognized failure code still produces a typed error', () => {
  const revived = reviveFailure({
    code: 'SomethingFromTheFuture',
    message: 'a newer kernel said something we do not know',
    operation: 'union',
  });

  assert.ok(revived instanceof KernelOperationFailedError);
  assert.equal(revived.operation, 'union');
  assert.match(revived.message, /SomethingFromTheFuture/);
});

test('a non-kernel exception crosses as a typed kernel error', () => {
  const revived = reviveFailure(toFailure(new TypeError('undefined is not a thing'), 'tessellate'));

  assert.ok(revived instanceof KernelOperationFailedError);
  assert.equal(revived.operation, 'tessellate');
  assert.match(revived.message, /undefined is not a thing/);
});

test('the worker-side stack is preserved as a cause', () => {
  const revived = reviveFailure(
    toFailure(new InvalidHandleError('no such body', 'release'), 'release'),
  );

  assert.ok(revived.cause instanceof Error);
  assert.match((revived.cause as Error).message, /kernel-side stack/);
});

// --- Ordering ---------------------------------------------------------------

/**
 * Requests execute in the order issued, even unawaited.
 *
 * OCCT is single-threaded and the handle table is shared mutable state, so
 * interleaving would make release-then-use races expressible from callers that
 * cannot express them today.
 */
test('unawaited requests execute in order', { skip }, async () => {
  const kernel = await makeKernel();
  kernel.clearOperationLog();

  const pending = [
    kernel.createBox({ width: 10, depth: 10, height: 10 }),
    kernel.createCylinder({ radius: 5, height: 10 }),
    kernel.createBox({ width: 20, depth: 20, height: 20 }),
  ];
  const [box, cylinder, bigBox] = await Promise.all(pending);

  assert.deepEqual(
    kernel.operationLog.map((entry) => entry.operation),
    ['createBox', 'createCylinder', 'createBox'],
  );
  // Handles are issued in the same order, so the results are not shuffled.
  assert.ok(box !== undefined && cylinder !== undefined && bigBox !== undefined);
  assert.ok(box < cylinder && cylinder < bigBox);
});

test('a failing request does not stall the ones behind it', { skip }, async () => {
  const kernel = await makeKernel();

  const results = await Promise.allSettled([
    kernel.createBox({ width: 10, depth: 10, height: 10 }),
    // Invalid: rejected inside the handler, mid-queue.
    kernel.createBox({ width: -1, depth: 10, height: 10 }),
    kernel.createBox({ width: 20, depth: 20, height: 20 }),
  ]);

  assert.equal(results[0]?.status, 'fulfilled');
  assert.equal(results[1]?.status, 'rejected');
  assert.equal(results[2]?.status, 'fulfilled', 'the queue must keep running');
});

// --- Instrumentation --------------------------------------------------------

test('each log entry carries kernel time and round trip separately', { skip }, async () => {
  const kernel = await makeKernel();
  kernel.clearOperationLog();

  await kernel.createBox({ width: 10, depth: 10, height: 10 });
  const [entry] = kernel.operationLog;

  assert.ok(entry !== undefined);
  assert.ok(entry.durationMs >= 0, 'kernel-side duration is recorded');
  assert.ok(entry.roundTripMs !== undefined, 'the caller-observed round trip is recorded');
  assert.ok(
    (entry.roundTripMs ?? 0) >= entry.durationMs,
    'a round trip cannot be shorter than the work it contains',
  );
});

test('a tessellation records what it moved across the boundary', { skip }, async () => {
  const kernel = await makeKernel();
  const box = await kernel.createBox({ width: 10, depth: 10, height: 10 });
  kernel.clearOperationLog();

  const { mesh } = await kernel.tessellate(box);
  const [entry] = kernel.operationLog;

  assert.ok(entry !== undefined);
  assert.equal(
    entry.transferBytes,
    mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength,
  );
  assert.ok(entry.copyMs !== undefined, 'the copy out of WASM memory is timed');
});

// --- Snapshots --------------------------------------------------------------

test('build constants come from the handshake, not a round trip', { skip }, async () => {
  const kernel = await makeKernel();
  kernel.clearOperationLog();

  assert.match(kernel.occtVersion, /^\d+\.\d+/);
  assert.ok(kernel.defaultTolerances.linear > 0);
  assert.ok(kernel.defaultTolerances.angular > 0);
  // Reading them cost nothing: they were captured when the kernel came up.
  assert.equal(kernel.operationLog.length, 0);
});

test('stats are a snapshot, refreshable on demand', { skip }, async () => {
  const kernel = await makeKernel();
  const before = kernel.stats().liveBodyCount;

  await kernel.createBox({ width: 10, depth: 10, height: 10 });
  assert.equal(
    kernel.stats().liveBodyCount,
    before + 1,
    'the snapshot rode back with the operation',
  );

  const refreshed = await kernel.refreshStats();
  assert.equal(refreshed.liveBodyCount, before + 1);
});
