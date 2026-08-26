#!/usr/bin/env bash
# Install and activate the pinned Emscripten SDK.
#
# This downloads roughly a gigabyte of toolchain on first run. It is idempotent:
# re-running with the pinned version already active is a no-op.

. "$(dirname "$0")/_common.sh"

if [ ! -d "$EMSDK_DIR" ]; then
  log "cloning emsdk into $EMSDK_DIR"
  git clone --depth 1 "${WEBCAD_EMSDK_REPO}" "$EMSDK_DIR"
fi

cd "$EMSDK_DIR"

if [ -f ".emsdk_version_installed" ] \
   && [ "$(cat .emsdk_version_installed)" = "${WEBCAD_EMSDK_VERSION}" ]; then
  log "emsdk ${WEBCAD_EMSDK_VERSION} already installed"
else
  log "installing emsdk ${WEBCAD_EMSDK_VERSION} (large download on first run)"
  python emsdk.py install "${WEBCAD_EMSDK_VERSION}"
  python emsdk.py activate "${WEBCAD_EMSDK_VERSION}"
  echo "${WEBCAD_EMSDK_VERSION}" > .emsdk_version_installed
fi

activate_emsdk
log "em++ $(em++ --version | head -1)"
log "ready"
