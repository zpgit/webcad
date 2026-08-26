// How the kernel proxy reaches the request handler.
//
// Two implementations exist: `WorkerTransport` (worker-transport.ts) in the
// browser, and `InProcessTransport` here for tests and tooling. The in-process
// one is not a mock - it drives the same `serve` entry point as the Worker,
// minus the postMessage. The one thing it cannot exercise is serialization, so
// the browser verification run, not the Node suite, is the authority on the
// boundary itself.

import { KernelTerminatedError, toFailure } from '../errors.ts';
import type { KernelModuleFactory } from '../wasm-module.ts';
import { KernelHandler, serve } from './handler.ts';
import type { KernelEnvelope, KernelResponse } from './protocol.ts';

export interface Transport {
  /** Sends one request and resolves with its response. Never rejects. */
  send(envelope: KernelEnvelope): Promise<KernelResponse>;
  /**
   * Registers a listener for the transport dying with work in flight. Called at
   * most once; the kernel uses it to fail pending requests rather than let them
   * hang forever.
   */
  onFailure(listener: (error: Error) => void): void;
  /**
   * Discards whatever host the transport started, so a failed initialization
   * leaves nothing running and the next send begins again from scratch.
   */
  reset(): void;
  dispose(): void;
}

export class InProcessTransport implements Transport {
  readonly #handler: KernelHandler;

  // Requests run one at a time, in arrival order, matching the Worker. Not a
  // simplification: OCCT is single-threaded and the handle table and mesh cache
  // are shared mutable state, so interleaving would make release-then-tessellate
  // races expressible from callers that cannot express them today.
  #queue: Promise<unknown> = Promise.resolve();
  #disposed = false;

  constructor(loadModule: KernelModuleFactory) {
    this.#handler = new KernelHandler(loadModule);
  }

  send(envelope: KernelEnvelope): Promise<KernelResponse> {
    if (this.#disposed) {
      return Promise.resolve({
        id: envelope.id,
        ok: false,
        error: toFailure(
          new KernelTerminatedError('the kernel has been disposed', envelope.request.kind),
          envelope.request.kind,
        ),
        tail: {},
      });
    }

    const served = this.#queue.then(() => serve(this.#handler, envelope));
    this.#queue = served.catch(() => undefined);
    return served.then(({ response }) => response);
  }

  onFailure(_listener: (error: Error) => void): void {
    // An in-process handler has no out-of-band death: `serve` turns every
    // failure into a response, so there is nothing to report here.
  }

  reset(): void {
    // Nothing to tear down. A failed instantiation leaves the handler without a
    // module, which is exactly the state a retry needs.
  }

  dispose(): void {
    this.#disposed = true;
    this.#handler.dispose();
  }
}
