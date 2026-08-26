import { KernelTerminatedError, toFailure } from '../errors.ts';
import type { KernelEnvelope, KernelResponse } from './protocol.ts';
import type { Transport } from './transport.ts';

/**
 * Starts the real kernel Worker.
 *
 * The `new URL(..., import.meta.url)` form is what the bundler recognizes, so
 * the Worker becomes its own chunk. Note that the Emscripten module is then
 * resolved relative to that chunk rather than to this file.
 */
function spawnKernelWorker(): Worker {
  return new Worker(new URL('./kernel-worker.ts', import.meta.url), {
    type: 'module',
  });
}

/**
 * Talks to the kernel Worker.
 *
 * The Worker is spawned lazily and respawned after a reset, so a failed
 * initialization leaves nothing running and a retry is still possible on the
 * same kernel instance.
 */
export class WorkerTransport implements Transport {
  #worker: Worker | null = null;
  #disposed = false;
  #failureListener: ((error: Error) => void) | undefined;

  /**
   * How a Worker is started. Injectable because Node has no DOM `Worker`, and
   * the routing rules below - correlation, unknown-id discard, death handling -
   * are worth testing without one.
   */
  readonly #spawn: () => Worker;

  /**
   * Callers awaiting a response, by request id.
   *
   * Only `resolve` is stored: `send` never rejects, so a dead Worker settles
   * these with failure responses rather than leaving anyone hanging.
   */
  readonly #pending = new Map<number, (response: KernelResponse) => void>();

  constructor(spawn: () => Worker = spawnKernelWorker) {
    this.#spawn = spawn;
  }

  send(envelope: KernelEnvelope): Promise<KernelResponse> {
    if (this.#disposed) {
      return Promise.resolve(this.#terminatedResponse(envelope, 'the kernel has been disposed'));
    }

    let worker: Worker;
    try {
      worker = this.#ensureWorker();
    } catch (cause) {
      return Promise.resolve({
        id: envelope.id,
        ok: false,
        error: toFailure(cause, envelope.request.kind),
        tail: {},
      });
    }

    return new Promise<KernelResponse>((resolve) => {
      this.#pending.set(envelope.id, resolve);
      worker.postMessage(envelope);
    });
  }

  onFailure(listener: (error: Error) => void): void {
    this.#failureListener = listener;
  }

  /** Discards the Worker so the next send starts a fresh one. */
  reset(): void {
    this.#teardown('the kernel worker was restarted');
  }

  dispose(): void {
    this.#disposed = true;
    this.#teardown('the kernel has been disposed');
  }

  // --- Internals -----------------------------------------------------------

  #ensureWorker(): Worker {
    if (this.#worker !== null) return this.#worker;

    const worker = this.#spawn();

    worker.onmessage = (event: MessageEvent<KernelResponse>): void => {
      const response = event.data;
      const resolve = this.#pending.get(response.id);
      // A response matching nothing pending is dropped. Settling an unrelated
      // call on an id we do not recognize would be worse than losing a message.
      if (resolve === undefined) return;
      this.#pending.delete(response.id);
      resolve(response);
    };

    // An uncaught Worker error means the geometry it held is gone, so every
    // handle the caller holds is worthless - not merely momentarily unusable.
    worker.onerror = (event: ErrorEvent): void => {
      const error = new KernelTerminatedError(
        event.message === '' ? 'the kernel worker stopped' : event.message,
        'worker',
      );
      this.#teardown(error.detail);
      this.#failureListener?.(error);
    };

    worker.onmessageerror = (): void => {
      const error = new KernelTerminatedError(
        'the kernel worker sent a message that could not be deserialized',
        'worker',
      );
      this.#teardown(error.detail);
      this.#failureListener?.(error);
    };

    this.#worker = worker;
    return worker;
  }

  #teardown(reason: string): void {
    this.#worker?.terminate();
    this.#worker = null;

    const waiting = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [id, resolve] of waiting) {
      resolve({
        id,
        ok: false,
        error: toFailure(new KernelTerminatedError(reason, 'worker'), 'worker'),
        tail: {},
      });
    }
  }

  #terminatedResponse(envelope: KernelEnvelope, reason: string): KernelResponse {
    return {
      id: envelope.id,
      ok: false,
      error: toFailure(
        new KernelTerminatedError(reason, envelope.request.kind),
        envelope.request.kind,
      ),
      tail: {},
    };
  }
}
