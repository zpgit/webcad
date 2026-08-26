#!/usr/bin/env bash
# Shared setup for the native build scripts. Sourced, not executed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO_ROOT

# shellcheck source=../native/toolchain.env
set -a
. "$REPO_ROOT/native/toolchain.env"
set +a

EMSDK_DIR="$REPO_ROOT/third_party/emsdk"
OCCT_DIR="$REPO_ROOT/third_party/occt"
BUILD_DIR="$REPO_ROOT/native/build"
WASM_OUT_DIR="$REPO_ROOT/src/kernel/wasm"
export EMSDK_DIR OCCT_DIR BUILD_DIR WASM_OUT_DIR

log()  { printf '\033[36m[%s]\033[0m %s\n' "$(basename "$0")" "$*"; }
warn() { printf '\033[33m[%s] WARN\033[0m %s\n' "$(basename "$0")" "$*" >&2; }
die()  { printf '\033[31m[%s] ERROR\033[0m %s\n' "$(basename "$0")" "$*" >&2; exit 1; }

# Put a usable ninja on PATH.
#
# Provisioned from the ninja-binaries package rather than required from the
# system: the GNU Make 3.81 that ships with Git for Windows is too old to be
# trusted with a build the size of OCCT, and ninja is not otherwise installed
# here. Idempotent.
ensure_ninja() {
  local bin_dir="$REPO_ROOT/tools/bin"
  local exe="ninja"
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) exe="ninja.exe" ;;
  esac

  if [ ! -x "$bin_dir/$exe" ]; then
    local src_dir="$REPO_ROOT/node_modules/ninja-binaries/binaries"
    [ -d "$src_dir" ] || die "ninja-binaries not installed - run npm install"

    local src
    case "$(uname -s)" in
      MINGW* | MSYS* | CYGWIN*) src="$src_dir/ninja-win.exe" ;;
      Darwin)                   src="$src_dir/ninja-mac" ;;
      *)                        src="$src_dir/ninja-linux" ;;
    esac
    [ -f "$src" ] || die "no ninja binary for $(uname -s) at $src"

    mkdir -p "$bin_dir"
    cp "$src" "$bin_dir/$exe"
    chmod +x "$bin_dir/$exe"
    log "provisioned ninja into tools/bin"
  fi

  export PATH="$bin_dir:$PATH"
  command -v ninja >/dev/null 2>&1 || die "ninja still not on PATH"
}

# Activate the pinned Emscripten toolchain in this shell.
activate_emsdk() {
  [ -d "$EMSDK_DIR" ] || die "emsdk not found at $EMSDK_DIR - run scripts/install-emsdk.sh"
  # emsdk_env.sh is noisy on stdout and references unset vars; quiet it down
  # without letting a failure pass silently.
  set +u
  # shellcheck disable=SC1091
  . "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
  set -u
  command -v em++ >/dev/null 2>&1 || die "em++ not on PATH after activating emsdk"
}

# Cache key for the compiled kernel: pinned tool versions plus facade sources.
# Any change to either must invalidate a cached artifact.
kernel_cache_key() {
  {
    echo "emsdk=${WEBCAD_EMSDK_VERSION}"
    echo "occt=${WEBCAD_OCCT_VERSION}"
    find "$REPO_ROOT/native/src" "$REPO_ROOT/native/CMakeLists.txt" \
      -type f 2>/dev/null | LC_ALL=C sort | while read -r f; do
        printf '%s ' "$f"
        # Portable across git-bash (sha256sum) without depending on openssl.
        sha256sum "$f" | cut -d' ' -f1
      done
  } | sha256sum | cut -d' ' -f1
}
