#!/usr/bin/env bash
# Report WASM artifact size, uncompressed and Brotli-compressed.
#
# The design makes payload size an MVP-0 deliverable rather than an
# afterthought: an OCCT WASM binary is large, and if the number is unacceptable
# that finding should be recorded before adding capabilities that only make the
# binary bigger.

. "$(dirname "$0")/_common.sh"

WASM="$WASM_OUT_DIR/webcad_kernel.wasm"
JS="$WASM_OUT_DIR/webcad_kernel.mjs"
[ -f "$WASM" ] || die "no artifact at $WASM - run scripts/build-kernel.sh"

human() { awk -v b="$1" 'BEGIN{printf "%.2f MB", b/1048576}'; }

# Node ships zlib with Brotli, so no extra tool is needed to measure what the
# server will actually send.
brotli_size() {
  node -e "
    const {brotliCompressSync}=require('node:zlib');
    const {readFileSync}=require('node:fs');
    const q=require('node:zlib').constants;
    const out=brotliCompressSync(readFileSync(process.argv[1]),{
      params:{[q.BROTLI_PARAM_QUALITY]:11}});
    process.stdout.write(String(out.length));
  " "$1"
}

wasm_raw=$(stat -c %s "$WASM" 2>/dev/null || stat -f %z "$WASM")
js_raw=$(stat -c %s "$JS" 2>/dev/null || stat -f %z "$JS")
wasm_br=$(brotli_size "$WASM")
js_br=$(brotli_size "$JS")
total_raw=$((wasm_raw + js_raw))
total_br=$((wasm_br + js_br))

printf '\n  MVP-0 payload  (OCCT %s / Emscripten %s)\n' "${WEBCAD_OCCT_VERSION}" "${WEBCAD_EMSDK_VERSION}"
printf '  %-22s %12s  %12s\n' '' 'raw' 'brotli'
printf '  %-22s %12s  %12s\n' 'webcad_kernel.wasm' "$(human "$wasm_raw")" "$(human "$wasm_br")"
printf '  %-22s %12s  %12s\n' 'webcad_kernel.mjs'  "$(human "$js_raw")"   "$(human "$js_br")"
printf '  %-22s %12s  %12s\n' 'total'              "$(human "$total_raw")" "$(human "$total_br")"
printf '\n'

mkdir -p "$REPO_ROOT/measurements"
cat > "$REPO_ROOT/measurements/payload.json" <<EOF
{
  "occtVersion": "${WEBCAD_OCCT_VERSION}",
  "emsdkVersion": "${WEBCAD_EMSDK_VERSION}",
  "wasmBytes": $wasm_raw,
  "wasmBrotliBytes": $wasm_br,
  "jsBytes": $js_raw,
  "jsBrotliBytes": $js_br,
  "totalBytes": $total_raw,
  "totalBrotliBytes": $total_br
}
EOF
log "recorded measurements/payload.json"
