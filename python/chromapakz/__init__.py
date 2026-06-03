"""ChromaPakZ — lossless RGB + bit-exact auxiliary signals in one WebM.

`pip install .` compiles the native libvpx core; this module binds it via ctypes.

    import chromapakz as cz

    # Multi-signal encode (depth + object IDs, etc.)
    data = cz.encode(
        {"depth": depth_u16, "objectId": ids_u16},
        specs={"depth": {"inverse_depth": True, "near": 0.3, "far": 9.0, "levels": 2048}},
        rgb=rgba_NHWc4,
    )
    out = cz.decode(data)
    out["signals"]["depth"]          # (N, H, W) uint16
    out["signals"]["objectId"]

    # Legacy depth-only sugar still works
    data = cz.encode_rgbd(rgb, depth, near=0.2, far=10.0)
    depth = cz.decode_depth(data)
"""
import ctypes
import glob
import json
import os

import numpy as np

__version__ = "0.1.0"
LEVELS_FULL = 65536


def _find_lib():
    """Locate the native core: bundled in the installed package, else a CMake dev build."""
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    pats = ("_core*.so", "_core*.dylib", "_core*.pyd", "libchromapakz*.*")
    for d in (here, os.path.join(repo, "build"), os.path.join(repo, "native")):
        for pat in pats:
            hits = [h for h in sorted(glob.glob(os.path.join(d, pat)))
                    if not h.endswith((".cpp", ".h", ".a"))]
            if hits:
                return hits[0]
    raise OSError("ChromaPakZ native library not found — run `pip install .` or `cmake --build build`.")


_lib = ctypes.CDLL(_find_lib())

u16p, u8p, f32p = (ctypes.POINTER(t) for t in (ctypes.c_uint16, ctypes.c_uint8, ctypes.c_float))
intp, dblp = ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_double)
_I, _D, _Z = ctypes.c_int, ctypes.c_double, ctypes.c_size_t


class _SignalSpec(ctypes.Structure):
    _fields_ = [
        ("id", ctypes.c_char_p),
        ("data", u16p),
        ("inverse_depth", ctypes.c_int),
        ("near_", ctypes.c_double),
        ("far_", ctypes.c_double),
        ("levels", ctypes.c_int),
    ]


_lib.dc_encode_depth.argtypes = [u16p, _I, _I, _I, _I, _D, _D, _I, ctypes.POINTER(u8p), ctypes.POINTER(_Z)]
_lib.dc_encode_rgbd.argtypes = [u8p, u16p, _I, _I, _I, _I, _I, _D, _D, _I, ctypes.POINTER(u8p), ctypes.POINTER(_Z)]
_lib.dc_encode_multi.argtypes = [
    u8p, _I, ctypes.POINTER(_SignalSpec), _I, _I, _I, _I, _I,
    ctypes.POINTER(u8p), ctypes.POINTER(_Z),
]
_lib.dc_probe.argtypes = [u8p, _Z, intp, intp, intp, intp, dblp, dblp, intp, intp]
_lib.dc_decode_depth.argtypes = [u8p, _Z, u16p]
_lib.dc_decode_signal.argtypes = [u8p, _Z, ctypes.c_char_p, u16p]
_lib.dc_decode_rgb.argtypes = [u8p, _Z, u8p]
_lib.dc_get_metadata.argtypes = [u8p, _Z, ctypes.POINTER(ctypes.c_char_p), ctypes.POINTER(_Z)]
_lib.dc_quantize_inverse.argtypes = [f32p, _I, _D, _D, _I, u16p]
_lib.dc_dequantize_inverse.argtypes = [u16p, _I, _D, _D, _I, f32p]
for fn in (
    "dc_encode_depth", "dc_encode_rgbd", "dc_encode_multi", "dc_probe",
    "dc_decode_depth", "dc_decode_signal", "dc_decode_rgb", "dc_get_metadata",
):
    getattr(_lib, fn).restype = ctypes.c_int
_lib.dc_free.argtypes = [u8p]


def _take(out, out_len):
    data = ctypes.string_at(out, out_len.value)
    _lib.dc_free(out)
    return data


def _buf(data):
    return (ctypes.c_uint8 * len(data)).from_buffer_copy(data)


def _default_depth_spec(near, far, levels):
    return {"inverse_depth": True, "near": near, "far": far, "levels": levels}


def encode(signals, specs=None, rgb=None, fps=30, rgb_kbps=2000, near=0.2, far=10.0, levels=LEVELS_FULL):
    """Encode lossless uint16 signals (+ optional RGB) to WebM bytes.

    Args:
        signals: dict mapping signal id -> (N, H, W) uint16 array.
        specs: optional per-id dict with ``inverse_depth``, ``near``, ``far``, ``levels``.
            Raw signals omit ``inverse_depth`` (default False).
        rgb: optional (N, H, W, 4) uint8 RGBA view track.
    """
    if not signals:
        raise ValueError("need at least one signal")
    specs = dict(specs or {})
    ids = list(signals.keys())
    arrays = []
    dims = None
    for sid in ids:
        arr = np.ascontiguousarray(signals[sid], dtype=np.uint16)
        if arr.ndim != 3:
            raise ValueError(f"signal {sid!r} must be (N, H, W)")
        if dims is None:
            dims = arr.shape
        elif dims != arr.shape:
            raise ValueError(f"signal {sid!r} shape {arr.shape} != {dims}")
        arrays.append(arr)
    N, H, W = dims

    rgb_p = u8p()
    if rgb is not None:
        rgb = np.ascontiguousarray(rgb, dtype=np.uint8)
        if rgb.ndim != 4 or rgb.shape[3] != 4:
            raise ValueError("rgb must be (N, H, W, 4) RGBA")
        if rgb.shape[:3] != dims:
            raise ValueError(f"rgb {rgb.shape[:3]} vs signals {dims}")
        rgb_p = rgb.ctypes.data_as(u8p)

    c_specs = (_SignalSpec * len(ids))()
    for i, sid in enumerate(ids):
        sp = specs.get(sid, {})
        if sid == "depth" and "inverse_depth" not in sp and not sp:
            sp = _default_depth_spec(near, far, levels)
        inv = bool(sp.get("inverse_depth", False))
        c_specs[i].id = sid.encode("utf-8")
        c_specs[i].data = arrays[i].ctypes.data_as(u16p)
        c_specs[i].inverse_depth = 1 if inv else 0
        c_specs[i].near_ = sp.get("near", near)
        c_specs[i].far_ = sp.get("far", far)
        c_specs[i].levels = sp.get("levels", levels)
    out, out_len = u8p(), _Z()
    rc = _lib.dc_encode_multi(
        rgb_p, rgb_kbps, c_specs, len(ids), W, H, N, fps, ctypes.byref(out), ctypes.byref(out_len),
    )
    if rc:
        raise RuntimeError(f"encode failed ({rc})")
    return _take(out, out_len)


def encode_depth(depth, fps=30, near=0.2, far=10.0, levels=LEVELS_FULL):
    """Encode a (N, H, W) uint16 depth array to ChromaPakZ WebM bytes."""
    return encode({"depth": depth}, specs={"depth": _default_depth_spec(near, far, levels)}, fps=fps)


def encode_rgbd(rgb, depth, fps=30, near=0.2, far=10.0, rgb_kbps=2000, levels=LEVELS_FULL):
    """Encode RGB + depth. rgb/depth may be None (track omitted)."""
    if rgb is None and depth is None:
        raise ValueError("need rgb and/or depth")
    sigs = {}
    specs = {}
    if depth is not None:
        sigs["depth"] = depth
        specs["depth"] = _default_depth_spec(near, far, levels)
    return encode(sigs, specs=specs, rgb=rgb, fps=fps, rgb_kbps=rgb_kbps)


def parse_metadata(data):
    """Return the CHROMAPAKZ metadata dict (v2 ``signals[]`` or legacy ``depth``)."""
    buf = _buf(data)
    json_out, json_len = ctypes.c_char_p(), _Z()
    rc = _lib.dc_get_metadata(buf, len(data), ctypes.byref(json_out), ctypes.byref(json_len))
    if rc:
        raise RuntimeError("parse_metadata failed — not a ChromaPakZ file?")
    try:
        return json.loads(ctypes.string_at(json_out, json_len.value).decode("utf-8"))
    finally:
        _lib.dc_free(ctypes.cast(json_out, u8p))


def probe(data):
    """Return dict(width, height, frames, fps, near, far, levels, has_rgb, signals)."""
    buf = _buf(data)
    W, H, N, fps, levels, rgb = (ctypes.c_int() for _ in range(6))
    near, far = ctypes.c_double(), ctypes.c_double()
    rc = _lib.dc_probe(buf, len(data), *(ctypes.byref(x) for x in (W, H, N, fps, near, far, levels, rgb)))
    if rc:
        raise RuntimeError("probe failed — not a ChromaPakZ file?")
    meta = parse_metadata(data)
    return dict(
        width=W.value, height=H.value, frames=N.value, fps=fps.value,
        near=near.value, far=far.value, levels=levels.value, has_rgb=bool(rgb.value),
        signals=meta.get("signals", []), metadata=meta,
    )


def decode_signal(data, signal_id):
    """Decode one signal by id to (N, H, W) uint16."""
    info = probe(data)
    N, H, W = info["frames"], info["height"], info["width"]
    out = np.empty((N, H, W), dtype=np.uint16)
    buf = _buf(data)
    sid = signal_id.encode("utf-8")
    if _lib.dc_decode_signal(buf, len(data), sid, out.ctypes.data_as(u16p)):
        raise RuntimeError(f"decode_signal({signal_id!r}) failed")
    return out


def decode_depth(data):
    """Decode the depth signal to (N, H, W) uint16."""
    return decode_signal(data, "depth")


def decode_rgb(data):
    """Decode the RGB track to (N, H, W, 4) uint8 RGBA (raises if no RGB track)."""
    info = probe(data)
    if not info["has_rgb"]:
        raise RuntimeError("file has no RGB track")
    N, H, W = info["frames"], info["height"], info["width"]
    out = np.empty((N, H, W, 4), dtype=np.uint8)
    buf = _buf(data)
    if _lib.dc_decode_rgb(buf, len(data), out.ctypes.data_as(u8p)):
        raise RuntimeError("decode_rgb failed")
    return out


def decode(data, signal_ids=None):
    """Decode all (or selected) signals and optional RGB.

    Returns dict with ``metadata``, ``signals`` (id -> ndarray), and ``rgb`` if present.
    """
    info = probe(data)
    ids = signal_ids
    if ids is None:
        ids = [s["id"] for s in info["signals"]]
    out = {"metadata": info["metadata"], "signals": {}, "width": info["width"],
           "height": info["height"], "frames": info["frames"], "fps": info["fps"]}
    for sid in ids:
        out["signals"][sid] = decode_signal(data, sid)
    if info["has_rgb"]:
        out["rgb"] = decode_rgb(data)
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
