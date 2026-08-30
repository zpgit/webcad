#!/usr/bin/env bash
# Fetch the pinned OCCT source tree.
#
# Shallow single-tag clone: the full history is large and nothing in this build
# needs it. Idempotent - re-running with the pinned tag checked out is a no-op.

. "$(dirname "$0")/_common.sh"

if [ -d "$OCCT_DIR/.git" ]; then
  current="$(git -C "$OCCT_DIR" describe --tags --exact-match 2>/dev/null || echo unknown)"
  if [ "$current" = "${WEBCAD_OCCT_VERSION}" ]; then
    log "OCCT ${WEBCAD_OCCT_VERSION} already checked out"
    exit 0
  fi
  warn "OCCT checkout is at '$current', expected '${WEBCAD_OCCT_VERSION}' - refetching"
  rm -rf "$OCCT_DIR"
fi

# The directory can exist without being a checkout: fetch-step-fixtures.sh
# writes two files into $OCCT_DIR/data/step so the STEP suites have inputs
# without a 313 MB clone. git clone refuses a non-empty target, so clear it -
# everything the fixture fetch put there arrives again with the clone.
if [ -d "$OCCT_DIR" ]; then
  warn "$OCCT_DIR is not an OCCT checkout - replacing its contents with the clone"
  rm -rf "$OCCT_DIR"
fi

log "cloning OCCT ${WEBCAD_OCCT_VERSION} (shallow) into $OCCT_DIR"
git clone --depth 1 --branch "${WEBCAD_OCCT_VERSION}" "${WEBCAD_OCCT_REPO}" "$OCCT_DIR"

log "OCCT ${WEBCAD_OCCT_VERSION} fetched ($(du -sh "$OCCT_DIR" 2>/dev/null | cut -f1))"
