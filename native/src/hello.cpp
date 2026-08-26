// Toolchain smoke test. Deliberately does not reference OCCT.
//
// The design calls for getting a trivial WASM module loading before wiring any
// OCCT geometry, so that Emscripten toolchain problems surface separately from
// geometry problems. If this builds and loads but the kernel does not, the
// fault is in the OCCT build, not in Emscripten or the loader.

#include <string>

#include <emscripten/bind.h>

namespace {

int addNumbers(int a, int b) { return a + b; }

std::string greet() { return "webcad toolchain ok"; }

// Exercises the exception path the real facade depends on: Emscripten must be
// built with exception support for the kernel's status convention to work.
std::string catchesExceptions() {
  try {
    throw std::runtime_error("intentional");
  } catch (const std::exception& e) {
    return std::string("caught: ") + e.what();
  }
}

}  // namespace

EMSCRIPTEN_BINDINGS(webcad_hello) {
  emscripten::function("addNumbers", &addNumbers);
  emscripten::function("greet", &greet);
  emscripten::function("catchesExceptions", &catchesExceptions);
}
