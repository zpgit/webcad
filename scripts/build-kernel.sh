#!/usr/bin/env bash
# Build the OCCT/WASM geometry kernel.
#
# Two stages:
#   1. OCCT static libraries, emscripten-built, narrow module selection.
#      Slow (tens of minutes) but built once per pinned OCCT version.
#   2. The facade module, linked against those libraries. Fast, rebuilt whenever
#      facade sources change.
#
# The compiled artifact is cached under a key of pinned tool versions plus facade
# sources, so an unchanged build is a no-op rather than an hour of waiting.
#
# Flags: --force  rebuild even if the cache key matches
#        --occt-only / --facade-only  run a single stage

. "$(dirname "$0")/_common.sh"

FORCE=0
STAGE=all
for arg in "$@"; do
  case "$arg" in
    --force)      FORCE=1 ;;
    --occt-only)  STAGE=occt ;;
    --facade-only) STAGE=facade ;;
    *) die "unknown argument: $arg" ;;
  esac
done

[ -d "$OCCT_DIR" ] || die "OCCT source missing - run scripts/fetch-occt.sh"

OCCT_BUILD="$BUILD_DIR/occt-${WEBCAD_OCCT_VERSION}"
OCCT_INSTALL="$BUILD_DIR/occt-${WEBCAD_OCCT_VERSION}-install"
FACADE_BUILD="$BUILD_DIR/facade"
CACHE_STAMP="$BUILD_DIR/.kernel-cache-key"

ensure_ninja

activate_emsdk

JOBS="$(nproc 2>/dev/null || echo 4)"

# --- Stage 1: OCCT static libraries ----------------------------------------

build_occt() {
  if [ -f "$OCCT_INSTALL/lib/libTKernel.a" ] && [ "$FORCE" -eq 0 ]; then
    log "OCCT ${WEBCAD_OCCT_VERSION} already built at $OCCT_INSTALL"
    return 0
  fi

  log "configuring OCCT ${WEBCAD_OCCT_VERSION} for wasm (this takes a while)"
  emcmake cmake \
    -S "$OCCT_DIR" \
    -B "$OCCT_BUILD" \
    -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$OCCT_INSTALL" \
    -DINSTALL_DIR="$OCCT_INSTALL" \
    -DBUILD_LIBRARY_TYPE=Static \
    -DBUILD_CPP_STANDARD=C++17 \
    -DBUILD_USE_PCH=OFF \
    -DBUILD_MODULE_FoundationClasses=ON \
    -DBUILD_MODULE_ModelingData=ON \
    -DBUILD_MODULE_ModelingAlgorithms=ON \
    -DBUILD_MODULE_ApplicationFramework=OFF \
    -DBUILD_MODULE_DataExchange=OFF \
    -DBUILD_MODULE_Draw=OFF \
    -DBUILD_MODULE_Visualization=OFF \
    -DBUILD_DOC_Overview=OFF \
    -DUSE_FREETYPE=OFF \
    -DUSE_TCL=OFF \
    -DUSE_TK=OFF \
    -DUSE_OPENGL=OFF \
    -DUSE_GLES2=OFF \
    -DUSE_RAPIDJSON=OFF \
    -DUSE_DRACO=OFF \
    -DUSE_TBB=OFF \
    -DUSE_VTK=OFF \
    -DUSE_FFMPEG=OFF \
    -DUSE_OPENVR=OFF \
    -DUSE_XLIB=OFF \
    -DCMAKE_CXX_FLAGS="-fwasm-exceptions" \
    || die "OCCT configure failed"

  log "building OCCT with $JOBS jobs"
  cmake --build "$OCCT_BUILD" --parallel "$JOBS" || die "OCCT build failed"

  log "installing OCCT to $OCCT_INSTALL"
  cmake --install "$OCCT_BUILD" || die "OCCT install failed"
}

# --- Stage 2: the facade module --------------------------------------------

build_facade() {
  local key
  key="$(kernel_cache_key)"

  if [ "$FORCE" -eq 0 ] \
     && [ -f "$CACHE_STAMP" ] \
     && [ "$(cat "$CACHE_STAMP")" = "$key" ] \
     && [ -f "$WASM_OUT_DIR/webcad_kernel.wasm" ]; then
    log "kernel artifact is current (cache key $key) - nothing to do"
    return 0
  fi

  log "configuring facade"
  emcmake cmake \
    -S "$REPO_ROOT/native" \
    -B "$FACADE_BUILD" \
    -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DOCCT_INSTALL_DIR="$OCCT_INSTALL" \
    || die "facade configure failed"

  log "linking facade"
  cmake --build "$FACADE_BUILD" --parallel "$JOBS" || die "facade build failed"

  mkdir -p "$WASM_OUT_DIR"
  cp "$FACADE_BUILD/out/webcad_kernel.mjs" "$WASM_OUT_DIR/"
  cp "$FACADE_BUILD/out/webcad_kernel.wasm" "$WASM_OUT_DIR/"

  echo "$key" > "$CACHE_STAMP"
  log "artifact written to $WASM_OUT_DIR (cache key $key)"

  bash "$REPO_ROOT/scripts/report-artifact-size.sh"
}

case "$STAGE" in
  occt)   build_occt ;;
  facade) build_facade ;;
  all)    build_occt; build_facade ;;
esac

log "done"
