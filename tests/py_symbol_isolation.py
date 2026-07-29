"""Guard the native core against libvpx symbol interposition.

decord loads its shared library with `ctypes.CDLL(libdecord.so, ctypes.RTLD_GLOBAL)`, which
publishes its bundled ffmpeg/libvpx into the process-global symbol scope. If our _core.so still
imported vpx_* dynamically, ELF would resolve those against decord's libvpx — a different build
with a different encoder ABI — and `import decord` before `import chromapakz` would break
encoding. We link libvpx statically and hide its symbols so there is nothing to interpose.

Two checks:
  1. _core exports only dc_* and imports no vpx_* (the property that makes us immune).
  2. An end-to-end round-trip still succeeds with a hostile libvpx preloaded RTLD_GLOBAL.

Runs against the *installed* package (like tests/roundtrip.py), so it inspects the artifact that
ships rather than a dev build tree.
"""
import ctypes
import os
import subprocess
import sys
import tempfile

# The vpx entry points the core calls; a stub for each is enough to hijack a dynamically linked
# build. Keep in sync with the vpx_* uses in native/chromapakz.cpp.
VPX_SYMBOLS = [
    "vpx_codec_control_", "vpx_codec_dec_init_ver", "vpx_codec_decode", "vpx_codec_destroy",
    "vpx_codec_enc_config_default", "vpx_codec_enc_init_ver", "vpx_codec_encode",
    "vpx_codec_get_cx_data", "vpx_codec_get_frame", "vpx_codec_vp9_cx", "vpx_codec_vp9_dx",
    "vpx_img_alloc", "vpx_img_free",
]


def _core_path():
    import chromapakz
    return chromapakz._load()._name       # the native core loads on first use, not at import


def _nm(args):
    try:
        out = subprocess.run(["nm", *args], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout if out.returncode == 0 else None


def check_symbols(lib):
    """_core must import no vpx_* and export nothing but dc_*."""
    if sys.platform == "darwin":
        undef, defined = _nm(["-u", lib]), _nm(["-gU", lib])
        strip = lambda s: s[1:] if s.startswith("_") else s  # noqa: E731  (Mach-O leading underscore)
    else:
        undef = _nm(["-D", "--undefined-only", lib])
        defined = _nm(["-D", "--defined-only", lib])
        strip = lambda s: s  # noqa: E731
    if undef is None or defined is None:
        print("  ! nm unavailable — skipping symbol-table check")
        return

    def names(text):
        out = set()
        for line in text.splitlines():
            parts = line.split()
            if parts:
                out.add(strip(parts[-1]))
        return out

    imported, exported = names(undef), names(defined)

    bad_imports = sorted(n for n in imported if n.startswith("vpx_"))
    assert not bad_imports, (
        "_core imports libvpx dynamically (%s...): another extension that loads its own libvpx "
        "with RTLD_GLOBAL can hijack these. Build with a static libvpx." % bad_imports[:3])

    bad_exports = sorted(n for n in exported if n.startswith("vpx_"))
    assert not bad_exports, (
        "_core re-exports libvpx symbols (%s...) and would itself interpose on other extensions; "
        "the linker should have localised the static archive." % bad_exports[:3])

    assert exported, "no exported symbols found in %s" % lib
    non_dc = sorted(n for n in exported if not n.startswith("dc_"))
    assert not non_dc, "_core exports symbols outside the dc_* ABI: %s" % non_dc[:5]
    print("  exports %d dc_* symbols, imports no vpx_*" % len(exported))


def check_hostile_preload(lib):
    """Round-trip must still be bit-exact with a decoy libvpx published RTLD_GLOBAL first."""
    cc = os.environ.get("CC", "cc")
    src = "\n".join(["void* %s(void){return 0;}" % s for s in VPX_SYMBOLS]) + "\n"
    with tempfile.TemporaryDirectory() as td:
        c_file = os.path.join(td, "decoy_vpx.c")
        so = os.path.join(td, "decoy_vpx" + (".dylib" if sys.platform == "darwin" else ".so"))
        with open(c_file, "w") as f:
            f.write(src)
        flags = ["-dynamiclib"] if sys.platform == "darwin" else ["-shared"]
        try:
            r = subprocess.run([cc, *flags, "-fPIC", "-o", so, c_file],
                               capture_output=True, text=True, timeout=180)
        except (OSError, subprocess.SubprocessError):
            print("  ! no C compiler — skipping hostile-preload check")
            return
        if r.returncode != 0:
            print("  ! decoy libvpx failed to build — skipping hostile-preload check")
            return

        # The decoy has to win the global scope before the core loads, so the round-trip runs in a
        # fresh interpreter that loads it first — mirroring `import decord; import chromapakz`.
        code = (
            "import ctypes;"
            "ctypes.CDLL(%r, mode=ctypes.RTLD_GLOBAL);"
            "import numpy as np, chromapakz as cz;"
            "d=(np.arange(64*48,dtype=np.uint32)*7%%65535).astype(np.uint16).reshape(1,48,64);"
            "b=cz.encode({'depth':d});"
            "out=cz.decode(b);"
            "assert np.array_equal(out['signals']['depth'],d), 'not bit-exact';"
            "print('ok')"
        ) % so
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=600)
        assert r.returncode == 0 and "ok" in r.stdout, (
            "round-trip broke with a decoy libvpx preloaded RTLD_GLOBAL — the core is binding to "
            "the foreign libvpx.\nstdout: %s\nstderr: %s" % (r.stdout, r.stderr))
        print("  round-trip bit-exact with a decoy libvpx in the global scope")


if __name__ == "__main__":
    lib = _core_path()
    print("core: %s" % lib)
    check_symbols(lib)
    check_hostile_preload(lib)
    print("all passed")
