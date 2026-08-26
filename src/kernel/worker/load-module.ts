import type { KernelModule, KernelModuleFactory } from '../wasm-module.ts';

/**
 * Emscripten's own factory signature, which accepts the configuration object
 * its generated loader reads. Distinct from `KernelModuleFactory`, the
 * zero-argument shape the kernel injects and tests substitute.
 */
type EmscriptenFactory = (options?: {
  locateFile?: (path: string) => string;
}) => Promise<KernelModule>;

/**
 * Loads the Emscripten module from the build output next to the kernel source.
 *
 * Defined once and shared by both hosts: the Worker imports it, and the
 * in-process transport falls back to it. Tests override it to point at the
 * built artifact from a file:// URL.
 */
export const defaultLoadModule: KernelModuleFactory =
  async function defaultLoadModule(): Promise<KernelModule> {
    // Both URLs go through `new URL(..., import.meta.url)` so Vite emits each
    // file as a hashed asset and rewrites the reference. When the kernel has
    // not been built the files are absent, Vite warns and leaves the URLs to
    // resolve at runtime, and the app's "kernel not built" message appears -
    // which is why neither of these may become a static import.
    const loaderUrl = new URL('../wasm/webcad_kernel.mjs', import.meta.url).href;
    const wasmUrl = new URL('../wasm/webcad_kernel.wasm', import.meta.url).href;

    const mod = (await import(/* @vite-ignore */ loaderUrl)) as {
      default: EmscriptenFactory;
    };

    // The loader would otherwise resolve `webcad_kernel.wasm` against its own
    // URL. That works in dev, where both files sit in src/kernel/wasm/, but not
    // in a build: Vite emits each under its own content hash, so the default
    // lookup asks for an unhashed name that was never written and 404s. Telling
    // the loader where the artifact actually landed is the only thing that
    // survives both layouts.
    return mod.default({
      locateFile: (path) =>
        path === 'webcad_kernel.wasm' ? wasmUrl : new URL(path, loaderUrl).href,
    });
  };
