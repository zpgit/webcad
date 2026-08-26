// The kernel Worker's entry point.
//
// This is the only module the Worker loads directly. Everything it does is in
// `handler.ts`; what lives here is the message loop and the ordering discipline
// around it.

import { KernelHandler, serve } from './handler.ts';
import { defaultLoadModule } from './load-module.ts';
import type { KernelEnvelope } from './protocol.ts';

// This module runs in a Worker, but the project compiles against lib.dom, where
// `self` is a Window and the worker globals are absent. Declaring just the two
// members used here is narrower than pulling in the whole WebWorker lib and
// having it collide with DOM.
interface WorkerScope {
  onmessage: ((event: MessageEvent<KernelEnvelope>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

const handler = new KernelHandler(defaultLoadModule);

// One request at a time, in arrival order. OCCT is single-threaded, and the
// handle table and mesh cache are shared mutable state, so overlapping
// execution would make release-then-tessellate races expressible.
let queue: Promise<unknown> = Promise.resolve();

scope.onmessage = (event: MessageEvent<KernelEnvelope>): void => {
  const envelope = event.data;
  queue = queue
    .then(async () => {
      const { response, transfer } = await serve(handler, envelope);
      // Mesh buffers move rather than clone; the copies here are detached
      // afterwards, which is why nothing retains them.
      scope.postMessage(response, transfer as Transferable[]);
    })
    // `serve` turns failures into responses, so reaching this means postMessage
    // itself failed. Swallowing keeps one bad response from stalling the queue
    // and starving every request behind it.
    .catch((error: unknown) => {
      console.error('[webcad] kernel worker failed to answer a request', error);
    });
};
