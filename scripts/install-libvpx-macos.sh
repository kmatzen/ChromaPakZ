#!/usr/bin/env bash
# Provision libvpx for the macOS cibuildwheel build (run as cibuildwheel `before-all`).
#
# We build libvpx from source rather than `brew install libvpx`, because the Homebrew bottle is
# compiled for the runner's current macOS (e.g. 15.0) and delocate then refuses to bundle it into a
# wheel whose deployment target is lower. Building from source with an explicit, lower
# -mmacosx-version-min keeps the bundled dylib compatible with the wheel's target (see
# MACOSX_DEPLOYMENT_TARGET in pyproject.toml [tool.cibuildwheel.macos]).
set -euo pipefail

: "${MACOSX_DEPLOYMENT_TARGET:=13.0}"
export MACOSX_DEPLOYMENT_TARGET
PREFIX="$HOME/.vpxbuild"

brew install pkg-config ninja nasm >/dev/null

VER=1.14.1
curl -fsSL "https://github.com/webmproject/libvpx/archive/refs/tags/v${VER}.tar.gz" -o /tmp/vpx.tgz
mkdir -p /tmp/vpx && tar xzf /tmp/vpx.tgz -C /tmp/vpx --strip-components=1
cd /tmp/vpx
./configure --prefix="$PREFIX" --enable-pic --enable-shared --disable-static \
  --disable-examples --disable-tools --disable-docs --disable-unit-tests \
  --extra-cflags="-mmacosx-version-min=${MACOSX_DEPLOYMENT_TARGET}" \
  --extra-cxxflags="-mmacosx-version-min=${MACOSX_DEPLOYMENT_TARGET}"
make -j"$(sysctl -n hw.ncpu)"
make install
echo "libvpx ${VER} from source -> ${PREFIX} (target ${MACOSX_DEPLOYMENT_TARGET})"
