#!/usr/bin/env bash
# The WASM fallback codecs are committed *binaries* (src/backend/wasm/vp9-*.{js,wasm}) built from
# native/wasm/dc_vp9.cpp by an emscripten toolchain no push-triggered CI job has. Nothing rebuilds
# them, so editing dc_vp9.cpp does exactly nothing until someone remembers to run
# `npm run build:wasm` and commit the result — and npm ships whatever was last committed. That is
# not hypothetical: the #6 decoder bounds fix sat in the C++ source, unbuilt, for six commits.
#
# This is the cheap half of the guard: no emscripten needed. build-wasm.sh records the hashes of
# its inputs in src/backend/wasm/BUILD_SOURCES.sha256, and we simply re-verify them. Content, not
# git history — an earlier version of this script compared commit ancestry, which a rebase defeats
# by moving a rebuild commit after a source commit whose changes its binaries do not contain.
#
# The expensive half — actually rebuilding with emcc and running the round-trips against the fresh
# output — lives in .github/workflows/wasm.yml.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MANIFEST=src/backend/wasm/BUILD_SOURCES.sha256

if [ ! -f "$MANIFEST" ]; then
  echo "error: $MANIFEST is missing — run 'npm run build:wasm' to generate it" >&2
  exit 2
fi

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

echo "wasm freshness"
if sha256 -c "$MANIFEST" >/dev/null 2>&1; then
  while read -r _ f; do echo "  ok  $f"; done < "$MANIFEST"
  echo "  PASS  committed vp9-*.wasm were built from the current native/wasm/ sources"
  exit 0
fi

{
  echo "  FAIL  the committed WASM binaries are stale"
  echo
  echo "  These sources changed since src/backend/wasm/vp9-*.{js,wasm} were last built, so the"
  echo "  library — and every published npm tarball — is still running the old codec:"
  echo
  sha256 -c "$MANIFEST" 2>&1 | grep -v ': OK$' | sed 's/^/      /'
  echo
  echo "  Rebuild and commit:"
  echo "      npm run build:wasm          # needs emsdk activated (emcc on PATH)"
  echo "      git add src/backend/wasm/ src/backend/decode-ref.js"
} >&2
exit 1
