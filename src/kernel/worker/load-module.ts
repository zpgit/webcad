import type { KernelModule, KernelModuleFactory } from '../wasm-module.ts';

/**
 * Loads the Emscripten module from the build output next to the kernel source.
 *
 * Defined once and shared by both hosts: the Worker imports it, and the
 * in-process transport falls back to it. Tests override it to point at the
 * built artifact from a file:// URL.
 */
export const defaultLoadModule: KernelModuleFactory =
  async function defaultLoadModule(): Promise<KernelModule> {
    const url = new URL('../wasm/webcad_kernel.mjs', import.meta.url).href;
    // @vite-ignore: the artifact is a build product, absent from a fresh
    // checkout. A static import would make `vite build` fail before the kernel
    // has ever been compiled.
    const mod = (await import(/* @vite-ignore */ url)) as {
      default: KernelModuleFactory;
    };
    return mod.default();
  };
