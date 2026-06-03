"""ChromaPakZ — lossless RGBD video encoder (RGB + bit-exact 16-bit depth in one WebM).

A proper, pip-installable package. `pip install .` compiles the native libvpx core and bundles it;
this module binds it via ctypes and exposes a numpy-native API. Reads/writes the same .webm files
as the browser (WebCodecs) and C++ implementations.

    import chromapakz as cz
    data  = cz.encode_rgbd(rgb_NHWc4_uint8, depth_NHW_uint16, near=0.2, far=10.0)  # -> webm bytes
    info  = cz.probe(data)                       # {'width','height','frames','fps','near','far','levels','has_rgb'}
    depth = cz.decode_depth(data)                # (N, H, W) uint16
    rgb   = cz.decode_rgb(data)                  # (N, H, W, 4) uint8
    codes = cz.quantize_inverse(z_float32, near=0.2, far=10.0, levels=2048)   # float -> uint16 codes
    z     = cz.dequantize_inverse(codes, near=0.2, far=10.0, levels=2048)     # codes -> float (NaN=invalid)
"""
import ctypes
import glob
import os

import numpy as np

__version__ = "0.1.0"
LEVELS_FULL = 65536  # full 16-bit (default); fewer levels = coarser inverse-depth grid


def _find_lib():
    """Locate the native core: bundled in the installed package, else a CMake dev build."""
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))           # python/chromapakz -> python -> repo
    pats = ("_core*.so", "_core*.dylib", "_core*.pyd", "libchromapakz*.*", "libchromapakz*.*")
    for d in (here, os.path.join(repo, "build"), os.path.join(repo, "native")):
        for pat in pats:
            hits = [h for h in sorted(glob.glob(os.path.join(d, pat)))
                    if not h.endswith((".cpp", ".h", ".a"))]
            if hits:
                return hits[0]
    raise OSError("ChromaPakZ native library not found — run `pip install .` (builds via CMake) "
                  "or `native/build.sh` for a dev build.")


_lib = ctypes.CDLL(_find_lib())

u16p, u8p, f32p = (ctypes.POINTER(t) for t in (ctypes.c_uint16, ctypes.c_uint8, ctypes.c_float))
intp, dblp = ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_double)
_I, _D, _Z = ctypes.c_int, ctypes.c_double, ctypes.c_size_t

_lib.dc_encode_depth.argtypes = [u16p, _I, _I, _I, _I, _D, _D, _I, ctypes.POINTER(u8p), ctypes.POINTER(_Z)]
_lib.dc_encode_rgbd.argtypes = [u8p, u16p, _I, _I, _I, _I, _I, _D, _D, _I, ctypes.POINTER(u8p), ctypes.POINTER(_Z)]
_lib.dc_probe.argtypes = [u8p, _Z, intp, intp, intp, intp, dblp, dblp, intp, intp]
_lib.dc_decode_depth.argtypes = [u8p, _Z, u16p]
_lib.dc_decode_rgb.argtypes = [u8p, _Z, u8p]
_lib.dc_quantize_inverse.argtypes = [f32p, _I, _D, _D, _I, u16p]
_lib.dc_dequantize_inverse.argtypes = [u16p, _I, _D, _D, _I, f32p]
for fn in ("dc_encode_depth", "dc_encode_rgbd", "dc_probe", "dc_decode_depth", "dc_decode_rgb"):
    getattr(_lib, fn).restype = ctypes.c_int
_lib.dc_free.argtypes = [u8p]


def _take(out, out_len):
    data = ctypes.string_at(out, out_len.value)
    _lib.dc_free(out)
    return data


def encode_depth(depth, fps=30, near=0.2, far=10.0, levels=LEVELS_FULL):
    """Encode a (N, H, W) uint16 depth array to ChromaPakZ WebM bytes."""
    depth = np.ascontiguousarray(depth, dtype=np.uint16)
    if depth.ndim != 3:
        raise ValueError("depth must be (N, H, W)")
    N, H, W = depth.shape
    out, out_len = u8p(), _Z()
    rc = _lib.dc_encode_depth(depth.ctypes.data_as(u16p), W, H, N, fps, near, far, levels,
                              ctypes.byref(out), ctypes.byref(out_len))
    if rc:
        raise RuntimeError(f"encode_depth failed ({rc})")
    return _take(out, out_len)


def encode_rgbd(rgb, depth, fps=30, near=0.2, far=10.0, rgb_kbps=2000, levels=LEVELS_FULL):
    """Encode a full RGBD clip. rgb: (N,H,W,4) uint8 RGBA (track 1, legacy view) or None;
    depth: (N,H,W) uint16 (bit-exact) or None."""
    if rgb is None and depth is None:
        raise ValueError("need rgb and/or depth")
    rgb_p, depth_p = u8p(), u16p()
    dims = None
    if rgb is not None:
        rgb = np.ascontiguousarray(rgb, dtype=np.uint8)
        if rgb.ndim != 4 or rgb.shape[3] != 4:
            raise ValueError("rgb must be (N, H, W, 4) RGBA")
        dims = rgb.shape[:3]
        rgb_p = rgb.ctypes.data_as(u8p)
    if depth is not None:
        depth = np.ascontiguousarray(depth, dtype=np.uint16)
        if depth.ndim != 3:
            raise ValueError("depth must be (N, H, W)")
        if dims is not None and dims != depth.shape:
            raise ValueError(f"rgb {dims} vs depth {depth.shape} dimension mismatch")
        dims = depth.shape
        depth_p = depth.ctypes.data_as(u16p)
    N, H, W = dims
    out, out_len = u8p(), _Z()
    rc = _lib.dc_encode_rgbd(rgb_p, depth_p, W, H, N, fps, rgb_kbps, near, far, levels,
                             ctypes.byref(out), ctypes.byref(out_len))
    if rc:
        raise RuntimeError(f"encode_rgbd failed ({rc})")
    return _take(out, out_len)


def probe(data):
    """Return dict(width, height, frames, fps, near, far, levels, has_rgb)."""
    buf = (ctypes.c_uint8 * len(data)).from_buffer_copy(data)
    W, H, N, fps, levels, rgb = (ctypes.c_int() for _ in range(6))
    near, far = ctypes.c_double(), ctypes.c_double()
    rc = _lib.dc_probe(buf, len(data), *(ctypes.byref(x) for x in (W, H, N, fps, near, far, levels, rgb)))
    if rc:
        raise RuntimeError(f"probe failed ({rc}) — not a ChromaPakZ file?")
    return dict(width=W.value, height=H.value, frames=N.value, fps=fps.value,
                near=near.value, far=far.value, levels=levels.value, has_rgb=bool(rgb.value))


def decode_depth(data):
    """Decode the depth track to a (N, H, W) uint16 array."""
    info = probe(data)
    N, H, W = info["frames"], info["height"], info["width"]
    out = np.empty((N, H, W), dtype=np.uint16)
    buf = (ctypes.c_uint8 * len(data)).from_buffer_copy(data)
    if _lib.dc_decode_depth(buf, len(data), out.ctypes.data_as(u16p)):
        raise RuntimeError("decode_depth failed")
    return out


def decode_rgb(data):
    """Decode the RGB track to a (N, H, W, 4) uint8 RGBA array (raises if no RGB track)."""
    info = probe(data)
    if not info["has_rgb"]:
        raise RuntimeError("file has no RGB track")
    N, H, W = info["frames"], info["height"], info["width"]
    out = np.empty((N, H, W, 4), dtype=np.uint8)
    buf = (ctypes.c_uint8 * len(data)).from_buffer_copy(data)
    if _lib.dc_decode_rgb(buf, len(data), out.ctypes.data_as(u8p)):
        raise RuntimeError("decode_rgb failed")
    return out


def quantize_inverse(z, near=0.2, far=10.0, levels=LEVELS_FULL):
    """Float depth/disparity -> uint16 inverse-depth codes (code 0 == invalid)."""
    z = np.ascontiguousarray(z, dtype=np.float32)
    out = np.empty(z.shape, dtype=np.uint16)
    _lib.dc_quantize_inverse(z.ctypes.data_as(f32p), z.size, near, far, levels, out.ctypes.data_as(u16p))
    return out


def dequantize_inverse(d, near=0.2, far=10.0, levels=LEVELS_FULL):
    """uint16 inverse-depth codes -> float32 metric depth (invalid -> NaN)."""
    d = np.ascontiguousarray(d, dtype=np.uint16)
    out = np.empty(d.shape, dtype=np.float32)
    _lib.dc_dequantize_inverse(d.ctypes.data_as(u16p), d.size, near, far, levels, out.ctypes.data_as(f32p))
    return out
