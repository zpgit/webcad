// Toolchain smoke test: proves the test runner can load and call into a WASM
// module built by the pinned Emscripten SDK.
//
// Run `npm run kernel:hello` first to produce the artifact. The tests skip
// rather than fail when the artifact is absent, so a checkout without a native
// build does not report a false failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEmscriptenModule, skipUnlessBuilt } from './helpers/load-wasm.ts';

const ARTIFACT = 'native/build/hello/hello.mjs';
const skip = skipUnlessBuilt(ARTIFACT, 'npm run kernel:hello');

interface HelloModule {
  addNumbers(a: number, b: number): number;
  greet(): string;
  catchesExceptions(): string;
}

test('hello WASM module loads and calls into C++', { skip }, async () => {
  const mod = await loadEmscriptenModule<HelloModule>(ARTIFACT);

  assert.equal(mod.addNumbers(2, 3), 5);
  assert.equal(mod.greet(), 'webcad toolchain ok');
});

test('C++ exceptions are caught inside WASM', { skip }, async () => {
  const mod = await loadEmscriptenModule<HelloModule>(ARTIFACT);

  // The kernel's status convention depends on exception support being enabled
  // in the Emscripten build; this fails loudly if that flag is ever dropped.
  assert.equal(mod.catchesExceptions(), 'caught: intentional');
});
