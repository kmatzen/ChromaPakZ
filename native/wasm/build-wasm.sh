#!/usr/bin/env bash
# Build the per-operation WASM fallback codecs from native/wasm/dc_vp9.cpp + libvpx.
#
# Produces two independent ES modules under src/backend/wasm/:
#   vp9-decode.{js,wasm}  — VP9 decoder only (libvpx encoder disabled → small)
#   vp9-encode.{js,wasm}  — VP9 encoder only (libvpx decoder disabled)
# Splitting libvpx per operation is the real size win: a decode-only browser never pulls the
# (much heavier) encoder, and the JS dynamic import()s in src/backend/select.js keep them in
# separate bundler chunks.
#
# Requirements: emsdk activated (emcc on PATH). If EMSDK is unset we try ~/emsdk/emsdk_env.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WASM_SRC="$ROOT/native/wasm"
OUT="$ROOT/src/backend/wasm"
BUILD="$ROOT/build/wasm"
LIBVPX_TAG="${LIBVPX_TAG:-v1.15.0}"

if ! command -v emcc >/dev/null 2>&1; then
  if [ -f "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" ]; then
    # shellcheck disable=SC1091
    source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh"
  fi
fi
command -v emcc >/dev/null 2>&1 || { echo "error: emcc not found (activate emsdk)"; exit 1; }

mkdir -p "$OUT" "$BUILD"

# ── 1. libvpx source (once) ──
LIBVPX_SRC="$BUILD/libvpx"
if [ ! -d "$LIBVPX_SRC/.git" ]; then
  git clone --depth 1 --branch "$LIBVPX_TAG" https://chromium.googlesource.com/webm/libvpx "$LIBVPX_SRC"
fi

# Common configure flags: generic-gnu = portable C (no asm), single-threaded, minimal.
COMMON_CFG=(--target=generic-gnu --disable-vp8 --disable-examples --disable-tools
  --disable-docs --disable-unit-tests --disable-webm-io --disable-libyuv
  --disable-postproc --disable-runtime-cpu-detect --disable-multithread
  --enable-vp9 --enable-static --disable-shared)

# ── 2. build libvpx twice (decoder-only / encoder-only) ──
build_libvpx() {
  local mode="$1"; shift          # "decode" | "encode"
  local dir="$BUILD/libvpx-$mode"
  if [ -f "$dir/libvpx.a" ]; then echo "libvpx ($mode) already built"; return; fi
  mkdir -p "$dir"; ( cd "$dir"
    emconfigure "$LIBVPX_SRC/configure" "${COMMON_CFG[@]}" "$@"
    emmake make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" )
}
build_libvpx decode --disable-vp9-encoder --enable-vp9-decoder
build_libvpx encode --disable-vp9-decoder --enable-vp9-encoder

# ── 3. link dc_vp9.cpp against each → ES6 module ──
EMCC_COMMON=(-O3 -std=c++17 -I"$LIBVPX_SRC"
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 -sMALLOC=emmalloc
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP32"]')

emcc "${EMCC_COMMON[@]}" "$WASM_SRC/dc_vp9.cpp" "$BUILD/libvpx-encode/libvpx.a" \
  -sEXPORTED_FUNCTIONS='["_dcvp9_enc_new","_dcvp9_enc_encode","_dcvp9_enc_flush","_dcvp9_enc_next","_dcvp9_enc_free","_malloc","_free"]' \
  -o "$OUT/vp9-encode.js"

emcc "${EMCC_COMMON[@]}" "$WASM_SRC/dc_vp9.cpp" "$BUILD/libvpx-decode/libvpx.a" \
  -sEXPORTED_FUNCTIONS='["_dcvp9_dec_new","_dcvp9_dec_decode","_dcvp9_dec_flush","_dcvp9_dec_next","_dcvp9_dec_free","_malloc","_free"]' \
  -o "$OUT/vp9-decode.js"

# ── 4. regenerate the decode probe's reference chunk (uses the freshly-built encoder) ──
node "$WASM_SRC/gen-decode-ref.mjs"

echo "built:"
ls -la "$OUT"/vp9-*.wasm
