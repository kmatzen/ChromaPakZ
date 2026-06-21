#!/usr/bin/env bash
# Provision libvpx inside the cibuildwheel manylinux container (run as cibuildwheel `before-all`).
# cibuildwheel's auditwheel step then bundles the resulting shared library into the wheel, so the
# published wheel is self-contained.
#
# A system libvpx is only accepted if it's new enough to expose the VP9 encoder controls we use
# (VP9E_SET_COLOR_RANGE etc., added in libvpx 1.6). EPEL on older manylinux images ships a libvpx
# that satisfies `pkg-config --exists vpx` but predates those symbols, which is why we version-gate
# and otherwise build from source.
set -euo pipefail

MIN_MAJOR=1 MIN_MINOR=10   # require >= 1.10 to be safe

PM=""
command -v dnf >/dev/null 2>&1 && PM=dnf
[ -z "$PM" ] && command -v yum >/dev/null 2>&1 && PM=yum
# EPEL provides yasm on EL; install deps individually so a single missing package doesn't abort the
# whole transaction (and leave us with no assembler — libvpx needs nasm or yasm).
if [ -n "$PM" ]; then
  for p in pkgconfig epel-release; do $PM install -y "$p" >/dev/null 2>&1 || true; done
fi

if pkg-config --exists vpx; then
  V=$(pkg-config --modversion vpx); MAJ=${V%%.*}; REST=${V#*.}; MIN=${REST%%.*}
  if [ "${MAJ:-0}" -gt "$MIN_MAJOR" ] || { [ "${MAJ:-0}" -eq "$MIN_MAJOR" ] && [ "${MIN:-0}" -ge "$MIN_MINOR" ]; }; then
    echo "libvpx from system package: $V (>= ${MIN_MAJOR}.${MIN_MINOR}, ok)"; exit 0
  fi
  echo "system libvpx $V is too old (< ${MIN_MAJOR}.${MIN_MINOR}) — building from source"
fi

echo "building libvpx from source"
if [ -n "$PM" ]; then
  for p in make gcc gcc-c++ curl tar nasm yasm; do $PM install -y "$p" >/dev/null 2>&1 || true; done
fi
command -v nasm >/dev/null 2>&1 || command -v yasm >/dev/null 2>&1 || {
  echo "ERROR: no assembler (nasm/yasm) available to build libvpx" >&2; exit 1; }

VER=1.14.1
curl -fsSL "https://github.com/webmproject/libvpx/archive/refs/tags/v${VER}.tar.gz" -o /tmp/vpx.tgz
mkdir -p /tmp/vpx && tar xzf /tmp/vpx.tgz -C /tmp/vpx --strip-components=1
cd /tmp/vpx
./configure --enable-pic --enable-shared --disable-static \
  --disable-examples --disable-tools --disable-docs --disable-unit-tests
make -j"$(nproc)"
make install
ldconfig 2>/dev/null || true
echo "libvpx ${VER} installed from source"
