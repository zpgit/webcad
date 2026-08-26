#!/usr/bin/env bash
# Build the toolchain smoke-test module (no OCCT).
#
# Keeps Emscripten problems separable from OCCT problems: if this succeeds and
# the kernel build fails, the fault is in the OCCT build.

. "$(dirname "$0")/_common.sh"

activate_emsdk

OUT_DIR="$BUILD_DIR/hello"
mkdir -p "$OUT_DIR"

log "building hello module with em++ $(em++ --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"

em++ "$REPO_ROOT/native/src/hello.cpp" \
  -o "$OUT_DIR/hello.mjs" \
  -std=c++17 \
  -O2 \
  -fwasm-exceptions \
  -lembind \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,node \
  -sALLOW_MEMORY_GROWTH=1

log "built:"
ls -la "$OUT_DIR" | awk 'NR>1 {printf "  %-16s %s\n", $9, $5}'
