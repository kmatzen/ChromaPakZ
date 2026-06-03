"""depthcodec — RGB + bit-exact 16-bit depth in one WebM, via the native libvpx core.

Reads/writes the exact same .webm files as the browser (WebCodecs) and C++ implementations.
Thin ctypes binding over native/libdepthcodec.{dylib,so}; depth I/O is numpy-native.

    import depthcodec as dc
    data = dc.encode_depth(depth_u16)        # depth_u16: (N, H, W) uint16
    open("clip.webm", "wb").write(data)
    info  = dc.probe(open("clip.webm","rb").read())
    depth = dc.decode_depth(open("clip.webm","rb").read())   # -> (N, H, W) uint16

Float depth/disparity uses inverse-depth quantization (code 0 == invalid):
    codes = dc.quantize_inverse(z_float32, near=0.2, far=10.0)
    z     = dc.dequantize_inverse(codes, near=0.2, far=10.0)
"""
import ctypes
import os
import platform
import numpy as np

_ext = {"Darwin": "dylib", "Windows": "dll"}.get(platform.system(), "so")
_lib_path = os.path.join(os.path.dirname(__file__), "..", "native", f"libdepthcodec.{_ext}")
_lib = ctypes.CDLL(os.path.abspath(_lib_path))

u16p = ctypes.POINTER(ctypes.c_uint16)
u8p = ctypes.POINTER(ctypes.c_uint8)
f32p = ctypes.POINTER(ctypes.c_float)
intp = ctypes.POINTER(ctypes.c_int)
dblp = ctypes.POINTER(ctypes.c_double)

_lib.dc_encode_depth.argtypes = [u16p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                 ctypes.c_double, ctypes.c_double, ctypes.c_int,
                                 ctypes.POINTER(u8p), ctypes.POINTER(ctypes.c_size_t)]
_lib.dc_encode_depth.restype = ctypes.c_int
_lib.dc_probe.argtypes = [u8p, ctypes.c_size_t, intp, intp, intp, intp, dblp, dblp, intp, intp]
_lib.dc_probe.restype = ctypes.c_int
_lib.dc_decode_depth.argtypes = [u8p, ctypes.c_size_t, u16p]
_lib.dc_decode_depth.restype = ctypes.c_int
_lib.dc_encode_rgbd.argtypes = [u8p, u16p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_double, ctypes.c_double, ctypes.c_int,
                                ctypes.POINTER(u8p), ctypes.POINTER(ctypes.c_size_t)]
_lib.dc_encode_rgbd.restype = ctypes.c_int
_lib.dc_decode_rgb.argtypes = [u8p, ctypes.c_size_t, u8p]
_lib.dc_decode_rgb.restype = ctypes.c_int
_lib.dc_quantize_inverse.argtypes = [f32p, ctypes.c_int, ctypes.c_double, ctypes.c_double, ctypes.c_int, u16p]
_lib.dc_dequantize_inverse.argtypes = [u16p, ctypes.c_int, ctypes.c_double, ctypes.c_double, ctypes.c_int, f32p]
_lib.dc_free.argtypes = [u8p]

LEVELS_FULL = 65536  # full 16-bit (default); fewer levels = coarser inverse-depth grid


def encode_depth(depth, fps=30, near=0.2, far=10.0, levels=LEVELS_FULL):
    """Encode a (N, H, W) uint16 depth array to depthcodec WebM bytes."""
    depth = np.ascontiguousarray(depth, dtype=np.uint16)
    if depth.ndim != 3:
        raise ValueError("depth must be (N, H, W)")
    N, H, W = depth.shape
    out = u8p()
    out_len = ctypes.c_size_t()
    rc = _lib.dc_encode_depth(depth.ctypes.data_as(u16p), W, H, N, fps, near, far, levels,
                              ctypes.byref(out), ctypes.byref(out_len))
    if rc != 0:
        raise RuntimeError(f"dc_encode_depth failed ({rc})")
    data = ctypes.string_at(out, out_len.value)
    _lib.dc_free(out)
    return data


def encode_rgbd(rgb, depth, fps=30, near=0.2, far=10.0, rgb_kbps=2000, levels=LEVELS_FULL):
    """Encode a full RGBD clip to WebM bytes.

    rgb:   (N, H, W, 4) uint8 RGBA (or None for depth-only)
    depth: (N, H, W) uint16 (or None for RGB-only)
    The RGB track is track 1 (what legacy players show); depth is bit-exact.
    """
    if rgb is None and depth is None:
        raise ValueError("need rgb and/or depth")
    rgb_p = u8p()
    if rgb is not None:
        rgb = np.ascontiguousarray(rgb, dtype=np.uint8)
        if rgb.ndim != 4 or rgb.shape[3] != 4:
            raise ValueError("rgb must be (N, H, W, 4) RGBA")
        N, H, W = rgb.shape[:3]
        rgb_p = rgb.ctypes.data_as(u8p)
    depth_p = u16p()
    if depth is not None:
        depth = np.ascontiguousarray(depth, dtype=np.uint16)
        if depth.ndim != 3:
            raise ValueError("depth must be (N, H, W)")
        N, H, W = depth.shape
        depth_p = depth.ctypes.data_as(u16p)
    if rgb is not None and depth is not None and rgb.shape[:3] != depth.shape:
        raise ValueError("rgb and depth dimensions differ")
    out = u8p()
    out_len = ctypes.c_size_t()
    rc = _lib.dc_encode_rgbd(rgb_p, depth_p, W, H, N, fps, rgb_kbps, near, far, levels,
                             ctypes.byref(out), ctypes.byref(out_len))
    if rc != 0:
        raise RuntimeError(f"dc_encode_rgbd failed ({rc})")
    data = ctypes.string_at(out, out_len.value)
    _lib.dc_free(out)
    return data


def decode_rgb(data):
    """Decode the RGB track to a (N, H, W, 4) uint8 RGBA array (raises if no RGB track)."""
    info = probe(data)
    if not info["has_rgb"]:
        raise RuntimeError("file has no RGB track")
    N, H, W = info["frames"], info["height"], info["width"]
    out = np.empty((N, H, W, 4), dtype=np.uint8)
    buf = (ctypes.c_uint8 * len(data)).from_buffer_copy(data)
    rc = _lib.dc_decode_rgb(buf, len(data), out.ctypes.data_as(u8p))
    if rc != 0:
        raise RuntimeError(f"dc_decode_rgb failed ({rc})")
    return out


def probe(data):
    """Return dict(width, height, frames, fps, near, far, has_rgb) for a depthcodec WebM."""
    buf = (ctypes.c_uint8 * len(data)).from_buffer_copy(data)
    W, H, N, fps = (ctypes.c_int() for _ in range(4))
    near, far = ctypes.c_double(), ctypes.c_double()
    levels, rgb = ctypes.c_int(), ctypes.c_int()
    rc = _lib.dc_probe(buf, len(data), *(ctypes.byref(x) for x in (W, H, N, fps, near, far, levels, rgb)))
    if rc != 0:
        raise RuntimeError(f"dc_probe failed ({rc}) — not a depthcodec file?")
    return dict(width=W.value, height=H.value, frames=N.value, fps=fps.value,
                near=near.value, far=far.value, levels=levels.value, has_rgb=bool(rgb.value))


def decode_depth(data):
    """Decode the depth track of a depthcodec WebM to a (N, H, W) uint16 array."""
    info = probe(data)
    N, H, W = info["frames"], info["height"], info["width"]
    out = np.empty((N, H, W), dtype=np.uint16)
    buf = (ctypes.c_uint8 * len(data)).from_buffer_copy(data)
    rc = _lib.dc_decode_depth(buf, len(data), out.ctypes.data_as(u16p))
    if rc != 0:
        raise RuntimeError(f"dc_decode_depth failed ({rc})")
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
