import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // The kernel is single-threaded for MVP-0, but these headers make
    // SharedArrayBuffer available. The design leaves the Worker/shared-memory
    // question open pending MVP-0 measurements; enabling them now means
    // testing that answer later does not require a server change.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'es2022',
    // Keep the .wasm artifact as a separate fetchable asset so it can be
    // streamed and cached independently of the JS bundle.
    assetsInlineLimit: 0,
  },
});
