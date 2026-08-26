// How the kernel proxy reaches the request handler.
//
// Two implementations exist: `WorkerTransport` (worker-transport.ts) in the
// browser, and `InProcessTransport` here for tests and tooling. The in-process
// one is not a mock - it drives the same `serve` entry point as the Worker,
// minus the postMessage. The one thing it cannot exercise is serialization, so
// the browser verification run, not the Node suite, is the authority on the
// boundary itself.
//
// One exception to that, added when payloads started crossing inbound: a
// request carrying transferable buffers IS structurally cloned here, because
// otherwise the in-process path would hand the handler the caller's own array
// and leave the caller still holding a usable reference to it. That is a laxer
// contract than the Worker's, and a test passing under it would say nothing
// about the path that ships.

import { KernelTerminatedError, toFailure } from '../errors.ts';
import type { KernelModuleFactory } from '../wasm-module.ts';
import { KernelHandler, serve } from './handler.ts';
import type { KernelEnvelope, KernelResponse } from './protocol.ts';
import { requestTransferables } from './protocol.ts';

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

    // Detaches the caller's buffers exactly as postMessage would, and gives the
    // handler its own copy. Applied only when there is something to transfer,
    // so the cost falls on the one request kind that carries a payload.
    const transfer = requestTransferables(envelope.request);
    const delivered =
      transfer.length === 0 ? envelope : structuredClone(envelope, { transfer });

    const served = this.#queue.then(() => serve(this.#handler, delivered));
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
