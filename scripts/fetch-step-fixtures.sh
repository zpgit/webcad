#!/usr/bin/env bash
# Fetch the third-party STEP fixtures the translation suites read.
#
# None of these are committed: `third_party/` is gitignored on purpose. Each is
# pinned by URL and sha256, because a fixture that changed underneath us would
# silently reshape every number in a findings document. A hash mismatch is a hard
# failure, not a refetch loop, and leaves no partial file behind.
#
# Two classes of pin, and the difference matters:
#
#   required - the fixture must be there for the suites to mean anything, and its
#              absence fails this script. OCCT's own two files qualify: they come
#              from the same pinned tag the kernel is built from, over the same
#              transport as the source clone, so a failure here is a real problem
#              rather than someone else's outage.
#   optional - the fixture is worth having and is not ours to depend on. A file
#              published by a third party on their own host is a liveness
#              dependency, and turning their outage into our red build buys
#              nothing. A failed download warns and continues; the suites then
#              skip loudly and report the claim as not exercised, which is the
#              same thing they already do for a fixture that was never fetched.
#              A wrong hash is still fatal - unavailable and wrong are different.
#
# The OCCT fixtures used to arrive only with the 313 MB source clone, which is
# skipped whenever the install tree is cached - so the fast CI runs were exactly
# the ones with no fixtures on disk, and the suites skipped themselves while the
# job stayed green.

. "$(dirname "$0")/_common.sh"

command -v curl >/dev/null 2>&1 || die "curl not found - needed to fetch the STEP fixtures"

# Derived from the same pin the kernel is built from, so fixtures and kernel can
# never disagree about which OCCT they came from.
OCCT_RAW="${WEBCAD_OCCT_REPO%.git}"
OCCT_RAW="${OCCT_RAW/github.com/raw.githubusercontent.com}/${WEBCAD_OCCT_VERSION}/data/step"

# destination (repo-relative)                     required  sha256                                                            url
#
# `as1-md-214.stp` is the AS1 assembly from STEP Tools' published AP214 sample
# set, as written by MicroStation/J through ST-DEVELOPER in 1999. It is here
# because nothing else available is both a real assembly and foreign: 13
# occurrences, 9 named products, 5 RGB colours, 73 kB. The variant matters - the
# same assembly is published as written by several systems, and the `-oc-` one
# was written by OpenCascade, which is our own writer and would prove nothing
# about interoperability.
#
# Its licence is not stated. The set is published by STEP Tools Inc for testing
# STEP implementations, which is exactly this use, and the file is fetched at
# test time and never redistributed by this repository. Recorded rather than
# asserted: if that provenance is not good enough for some future use of this
# project, this is the line to revisit.
FIXTURES="
third_party/occt/data/step/screw.step          required  4b3649a4f5c4f05c7a06a402a91fe2fd7e3cba1615520fbd8c62a62610ad3e69  ${OCCT_RAW}/screw.step
third_party/occt/data/step/linkrods.step       required  3674e4b01ee0e983c81ed170f0574cda201ad08e0f7b46e05e4f4613400fd5f7  ${OCCT_RAW}/linkrods.step
third_party/step-fixtures/as1-md-214.stp       optional  208e8eb1fd95f564f5a5c0ed60f6539537edda6303ca7c60854bb292e2873bbc  https://www.steptools.com/docs/stpfiles/ap214/as1-md-214.stp
"

present=0
fetched=0
missing=0

while read -r rel requirement want url; do
  [ -n "$rel" ] || continue
  dest="$REPO_ROOT/$rel"
  name="$(basename "$rel")"

  if [ -f "$dest" ]; then
    have="$(sha256sum "$dest" | cut -d' ' -f1)"
    if [ "$have" = "$want" ]; then
      present=$((present + 1))
      continue
    fi
    warn "$name does not match the pinned hash (have $have) - refetching"
    rm -f "$dest"
  fi

  mkdir -p "$(dirname "$dest")"
  log "fetching $name from $url"
  if ! curl -fsSL --retry 3 --max-time 120 -o "$dest.part" "$url"; then
    rm -f "$dest.part"
    if [ "$requirement" = "optional" ]; then
      warn "could not download $name - suites needing it will skip and report it as not exercised"
      missing=$((missing + 1))
      continue
    fi
    die "could not download $url"
  fi

  have="$(sha256sum "$dest.part" | cut -d' ' -f1)"
  if [ "$have" != "$want" ]; then
    rm -f "$dest.part"
    die "$name downloaded but hashed $have, expected $want"
  fi

  mv "$dest.part" "$dest"
  fetched=$((fetched + 1))
done <<EOF
$FIXTURES
EOF

log "STEP fixtures: $fetched fetched, $present already present, $missing unavailable"
