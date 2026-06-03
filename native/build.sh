#!/usr/bin/env bash
# Canonical native build via CMake. Produces build/_core.{so,dylib} and build/dccli,
# and copies them into native/ for the dev ctypes loader + CLI convenience.
# Requires CMake + libvpx (pkg-config vpx). For the Python package use `pip install .` instead.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cmake -S "$root" -B "$root/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$root/build" -j
cp "$root"/build/_core.* "$root/native/" 2>/dev/null || true
cp "$root"/build/dccli "$root/native/" 2>/dev/null || true
echo "built: build/_core.* + build/dccli  (copied into native/ for dev use)"
