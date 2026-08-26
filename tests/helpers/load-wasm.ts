// Loading an Emscripten ES module from a test needs a file:// URL. A bare
// Windows path is parsed as a bare package specifier, and a namespaced path
// (\\?\E:\...) is rejected outright, so both fail with
// ERR_INVALID_MODULE_SPECIFIER.

import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '../..');

export function artifactPath(relative: string): string {
  return path.resolve(repoRoot, relative);
}

export function isBuilt(relative: string): boolean {
  return existsSync(artifactPath(relative));
}

/** Reason string for node:test's `skip`, or false when the artifact exists. */
export function skipUnlessBuilt(relative: string, buildCmd: string): string | false {
  return isBuilt(relative) ? false : `run \`${buildCmd}\` first (missing ${relative})`;
}

/** Instantiates an Emscripten MODULARIZE + EXPORT_ES6 module. */
export async function loadEmscriptenModule<T = unknown>(relative: string): Promise<T> {
  const specifier = pathToFileURL(artifactPath(relative)).href;
  const factory = (await import(specifier)).default as () => Promise<T>;
  return factory();
}
