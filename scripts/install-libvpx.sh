#!/usr/bin/env bash
# Provision libvpx inside the cibuildwheel manylinux container (run as cibuildwheel `before-all`).
# Tries distro packages first, falls back to building libvpx from source. cibuildwheel's auditwheel
# step then bundles the resulting shared library into the wheel, so the published wheel is self-contained.
set -euo pipefail

PM=""
command -v dnf >/dev/null 2>&1 && PM=dnf
[ -z "$PM" ] && command -v yum >/dev/null 2>&1 && PM=yum

if [ -n "$PM" ]; then
  $PM install -y pkgconfig >/dev/null 2>&1 || true
  ( $PM install -y epel-release >/dev/null 2>&1 && $PM install -y libvpx-devel >/dev/null 2>&1 ) || true
fi

if pkg-config --exists vpx; then
  echo "libvpx from system package: $(pkg-config --modversion vpx)"
  exit 0
fi

echo "building libvpx from source"
[ -n "$PM" ] && $PM install -y yasm nasm make gcc gcc-c++ curl tar >/dev/null 2>&1 || true
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
