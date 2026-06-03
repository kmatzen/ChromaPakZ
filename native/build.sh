#!/usr/bin/env bash
# Build the depthcodec shared library (for Python ctypes) and the CLI. Requires libvpx (pkg-config vpx).
set -euo pipefail
cd "$(dirname "$0")"
CXX=${CXX:-clang++}
FLAGS="-std=c++17 -O2 -Wall $(pkg-config --cflags vpx)"
LIBS="$(pkg-config --libs vpx)"
EXT=$([[ "$(uname)" == "Darwin" ]] && echo dylib || echo so)

echo "building libdepthcodec.$EXT …"
$CXX $FLAGS -fPIC -shared depthcodec.cpp $LIBS -o "libdepthcodec.$EXT"
echo "building dccli …"
$CXX $FLAGS dccli.cpp depthcodec.cpp $LIBS -o dccli
echo "done: native/libdepthcodec.$EXT, native/dccli"
