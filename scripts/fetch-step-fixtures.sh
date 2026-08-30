#!/usr/bin/env bash
# Fetch the third-party STEP fixtures the translation suites read.
#
# These two files are OCCT's own test data, and `fetch-occt.sh` already brings
# them in as part of the source clone. That is not enough: the clone is skipped
# whenever the built install tree is cached, which in CI is the common case, so
# the fast runs were exactly the ones with no fixtures on disk. The suites then
# skipped themselves - loudly, but a skip is not coverage - and CI stayed green
# on the self-authored edit leg alone, which proves nothing about reading a file
# we did not write. Fetching them on their own costs two requests and ~1.9 MB.
#
# Downloaded rather than committed because `third_party/` is gitignored on
# purpose, and hashed because a fixture that changed underneath us would
# silently reshape every number in docs/MVP-2-FINDINGS.md. The hashes are of the
# blobs at the pinned OCCT tag; a mismatch is a hard failure, not a refetch loop.

. "$(dirname "$0")/_common.sh"

FIXTURE_DIR="$OCCT_DIR/data/step"

# Derived from the same pin the kernel is built from, so fixtures and kernel can
# never disagree about which OCCT they came from.
RAW_BASE="${WEBCAD_OCCT_REPO%.git}"
RAW_BASE="${RAW_BASE/github.com/raw.githubusercontent.com}/${WEBCAD_OCCT_VERSION}/data/step"

# name  sha256-at-${WEBCAD_OCCT_VERSION}
FIXTURES="
screw.step    4b3649a4f5c4f05c7a06a402a91fe2fd7e3cba1615520fbd8c62a62610ad3e69
linkrods.step 3674e4b01ee0e983c81ed170f0574cda201ad08e0f7b46e05e4f4613400fd5f7
"

command -v curl >/dev/null 2>&1 || die "curl not found - needed to fetch the STEP fixtures"

mkdir -p "$FIXTURE_DIR"

present=0
fetched=0

while read -r name want; do
  [ -n "$name" ] || continue
  dest="$FIXTURE_DIR/$name"

  if [ -f "$dest" ]; then
    have="$(sha256sum "$dest" | cut -d' ' -f1)"
    if [ "$have" = "$want" ]; then
      present=$((present + 1))
      continue
    fi
    warn "$name does not match the pinned hash (have $have) - refetching"
    rm -f "$dest"
  fi

  log "fetching $name from $RAW_BASE"
  curl -fsSL --retry 3 -o "$dest.part" "$RAW_BASE/$name" \
    || die "could not download $RAW_BASE/$name"

  have="$(sha256sum "$dest.part" | cut -d' ' -f1)"
  if [ "$have" != "$want" ]; then
    rm -f "$dest.part"
    die "$name downloaded but hashed $have, expected $want at ${WEBCAD_OCCT_VERSION}"
  fi

  mv "$dest.part" "$dest"
  fetched=$((fetched + 1))
done <<EOF
$FIXTURES
EOF

log "STEP fixtures in $FIXTURE_DIR: $fetched fetched, $present already present"
