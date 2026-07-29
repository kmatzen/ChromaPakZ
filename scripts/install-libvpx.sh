#!/usr/bin/env bash
# Provision libvpx for the wheel build (run as cibuildwheel `before-all`), on Linux and macOS.
# Both platforms want a *static* PIC libvpx: the wheel links it into the native core and hides its
# symbols, so the core carries no undefined vpx_* symbols for the dynamic loader to resolve against
# some other extension's libvpx (see the CHROMAPAKZ_STATIC_VPX block in CMakeLists.txt). A bundled
# shared libvpx would not be enough — auditwheel renames the SONAME but not the symbols, and ELF
# still resolves them through the global scope.
#
# On macOS it also fixes the deployment target. Homebrew's bottle is compiled for the runner's own
# macOS, which forced every wheel to MACOSX_DEPLOYMENT_TARGET=15.0 (delocate refuses to bundle a
# dylib built for a newer target than the wheel claims). Building it here honours 13.0, and with a
# static archive there is no dylib for delocate to bundle at all.
#
# A system libvpx is only accepted if it ships a static archive *and* is new enough to expose the
# VP9 encoder controls we use (VP9E_SET_COLOR_RANGE etc., added in libvpx 1.6). EPEL on older
# manylinux images ships a libvpx that satisfies `pkg-config --exists vpx` but predates those
# symbols, which is why we version-gate and otherwise build from source.
set -euo pipefail

MIN_MAJOR=1 MIN_MINOR=10   # require >= 1.10 to be safe
VER=1.14.1
OS=$(uname -s)

if [ "$OS" = "Darwin" ]; then
  # Never reuse a system/Homebrew libvpx here: it is a dylib built for the runner's macOS, which is
  # exactly the deployment-target trap we are avoiding. Always build a static one for our target.
  brew install --quiet nasm pkg-config ninja >/dev/null || true   # already-installed is not an error
  PREFIX=/usr/local
  export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
  echo "building static libvpx ${VER} for macOS ${MACOSX_DEPLOYMENT_TARGET} ($(uname -m))"
  curl -fsSL "https://github.com/webmproject/libvpx/archive/refs/tags/v${VER}.tar.gz" -o /tmp/vpx.tgz
  rm -rf /tmp/vpx && mkdir -p /tmp/vpx && tar xzf /tmp/vpx.tgz -C /tmp/vpx --strip-components=1
  cd /tmp/vpx
  ./configure --prefix="$PREFIX" --enable-pic --enable-static --disable-shared \
    --disable-examples --disable-tools --disable-docs --disable-unit-tests
  make -j"$(sysctl -n hw.ncpu)"
  sudo make install
  echo "libvpx $(PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" pkg-config --modversion vpx) installed to $PREFIX (static)"
  exit 0
fi

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
  LIBDIR=$(pkg-config --variable=libdir vpx)
  if [ "${MAJ:-0}" -gt "$MIN_MAJOR" ] || { [ "${MAJ:-0}" -eq "$MIN_MAJOR" ] && [ "${MIN:-0}" -ge "$MIN_MINOR" ]; }; then
    if [ -f "${LIBDIR}/libvpx.a" ]; then
      echo "libvpx from system package: $V (>= ${MIN_MAJOR}.${MIN_MINOR}, static archive present, ok)"; exit 0
    fi
    echo "system libvpx $V has no ${LIBDIR}/libvpx.a — building a static one from source"
  else
    echo "system libvpx $V is too old (< ${MIN_MAJOR}.${MIN_MINOR}) — building from source"
  fi
fi

echo "building libvpx from source"
if [ -n "$PM" ]; then
  for p in make gcc gcc-c++ curl tar nasm yasm; do $PM install -y "$p" >/dev/null 2>&1 || true; done
fi
# aarch64 libvpx needs no x86 assembler; only gate on one when the target actually requires it.
case "$(uname -m)" in
  x86_64|i?86)
    command -v nasm >/dev/null 2>&1 || command -v yasm >/dev/null 2>&1 || {
      echo "ERROR: no assembler (nasm/yasm) available to build libvpx" >&2; exit 1; } ;;
esac

curl -fsSL "https://github.com/webmproject/libvpx/archive/refs/tags/v${VER}.tar.gz" -o /tmp/vpx.tgz
mkdir -p /tmp/vpx && tar xzf /tmp/vpx.tgz -C /tmp/vpx --strip-components=1
cd /tmp/vpx
# Static + PIC: static so _core.so has no vpx_* to resolve dynamically, PIC because those objects
# get linked into a shared library.
./configure --enable-pic --enable-static --disable-shared \
  --disable-examples --disable-tools --disable-docs --disable-unit-tests
make -j"$(nproc)"
make install
ldconfig 2>/dev/null || true
echo "libvpx ${VER} installed from source (static, PIC)"
