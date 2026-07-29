"""ChromaPakZ — lossless RGB + bit-exact auxiliary signals in one WebM.

    import chromapakz as cz

    data = cz.encode(
        {"depth": depth_u16, "objectId": ids_u16},
        specs={"depth": {"inverse_depth": True, "near": 0.3, "far": 9.0}},
        rgb=rgba,
    )
    out = cz.decode(data)
    out["signals"]["depth"]
"""
import ctypes
import glob
import json
import os

import numpy as np

# Single source of truth for the version: pyproject.toml reads it from here (scikit-build-core's
# regex metadata provider) and tests/version_consistency.mjs asserts package.json matches.
__version__ = "0.2.0"
LEVELS_FULL = 65536

# dc_decode_* return codes worth naming: both mean the file's bitstream contradicts its own
# metadata, which is either corruption or a deliberately crafted file. The core refuses the
# decode rather than writing past the buffer we sized from the header.
_DECODE_ERRORS = {
    9: "the file holds more frames than its header declares",
    10: "a decoded frame is not the size the header declares",
}


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


def _find_lib():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    pats = ("_core*.so", "_core*.dylib", "_core*.pyd")
    for d in (here, os.path.join(repo, "build"), os.path.join(repo, "native")):
        for pat in pats:
            hits = [h for h in sorted(glob.glob(os.path.join(d, pat)))
                    if not h.endswith((".cpp", ".h", ".a"))]
            if hits:
                return hits[0]
    raise OSError("ChromaPakZ native library not found — run `pip install .` or `cmake --build build`.")


# Loaded on first use, not at import: the pure-Python helpers (validation, specs, the EBML
# inspector) then stay importable — and unit-testable — without a compiled `_core`.
_lib = None


def _load():
    """Load and bind the native core (idempotent). Raises OSError if it isn't built."""
    global _lib
    if _lib is not None:
        return _lib
    lib = ctypes.CDLL(_find_lib())
    lib.dc_encode_multi.argtypes = [
        u8p, _I, ctypes.POINTER(_SignalSpec), _I, _I, _I, _I, _I,
        ctypes.POINTER(u8p), ctypes.POINTER(_Z),
    ]
    lib.dc_probe.argtypes = [u8p, _Z, intp, intp, intp, intp, dblp, dblp, intp, intp]
    lib.dc_decode_signal.argtypes = [u8p, _Z, ctypes.c_char_p, u16p, _Z]
    lib.dc_decode_rgb.argtypes = [u8p, _Z, u8p, _Z]
    lib.dc_get_metadata.argtypes = [u8p, _Z, ctypes.POINTER(ctypes.c_char_p), ctypes.POINTER(_Z)]
    lib.dc_quantize_inverse.argtypes = [f32p, _I, _D, _D, _I, u16p]
    lib.dc_dequantize_inverse.argtypes = [u16p, _I, _D, _D, _I, f32p]
    for fn in ("dc_encode_multi", "dc_probe", "dc_decode_signal", "dc_decode_rgb", "dc_get_metadata"):
        getattr(lib, fn).restype = ctypes.c_int
    lib.dc_free.argtypes = [u8p]
    _lib = lib
    return _lib


def _take(out, out_len):
    data = ctypes.string_at(out, out_len.value)
    _load().dc_free(out)
    return data


def _buf(data):
    return (ctypes.c_uint8 * len(data)).from_buffer_copy(data)


def _check_inverse_depth(near, far, levels):
    """Validate an inverse-depth range (matches the JS planSignals guard) — fail loud, not NaN."""
    if not (near > 0 and far > near):
        raise ValueError(f"inverse-depth needs 0 < near < far (got near={near}, far={far})")
    if not isinstance(levels, (int, np.integer)):
        raise ValueError(f"levels must be an int (got {levels!r})")
    if levels < 3:
        raise ValueError(f"inverse-depth needs levels >= 3 (got {levels})")
    # codes live in a uint16 buffer — more levels than that would silently wrap mod 65536
    if levels > LEVELS_FULL:
        raise ValueError(f"inverse-depth needs levels <= {LEVELS_FULL} (got {levels})")


def _as_u16(arr, what):
    """Contiguous uint16 view of ``arr`` — reject lossy casts instead of wrapping mod 65536."""
    a = np.asarray(arr)
    if a.dtype != np.uint16:
        if not np.issubdtype(a.dtype, np.integer):
            raise ValueError(f"{what} must hold integer uint16 codes (got dtype {a.dtype}) — "
                             "quantize float depth with quantize_inverse() first")
        if a.size and not (0 <= int(a.min()) and int(a.max()) <= 65535):
            raise ValueError(f"{what} values must be in [0, 65535] (got [{a.min()}, {a.max()}])")
    return np.ascontiguousarray(a, dtype=np.uint16)


def _as_u8(arr, what):
    """Contiguous uint8 view of ``arr`` — reject lossy casts instead of wrapping mod 256."""
    a = np.asarray(arr)
    if a.dtype != np.uint8:
        if not np.issubdtype(a.dtype, np.integer):
            raise ValueError(f"{what} must hold integer 0-255 samples (got dtype {a.dtype}) — "
                             "scale float colour to uint8 first")
        if a.size and not (0 <= int(a.min()) and int(a.max()) <= 255):
            raise ValueError(f"{what} values must be in [0, 255] (got [{a.min()}, {a.max()}])")
    return np.ascontiguousarray(a, dtype=np.uint8)


def inverse_depth_spec(near, far, levels=LEVELS_FULL):
    """Spec dict for a depth signal with inverse-depth quant."""
    _check_inverse_depth(near, far, levels)
    return {"inverse_depth": True, "near": near, "far": far, "levels": levels}


def encode(signals=None, specs=None, rgb=None, fps=30, rgb_kbps=2000):
    """Encode lossless uint16 signals (+ optional RGB) to WebM bytes.

    Signals must be integer codes in [0, 65535] and rgb uint8 RGBA — a lossy cast
    (float depth, out-of-range ints) is an error, not a silent wraparound.
    """
    signals = dict(signals or {})
    if not signals and rgb is None:
        raise ValueError("need at least one signal or rgb")
    specs = dict(specs or {})
    ids = list(signals.keys())
    arrays = []
    dims = None
    N = H = W = None
    if ids:
        for sid in ids:
            arr = _as_u16(signals[sid], f"signal {sid!r}")
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
        rgb = _as_u8(rgb, "rgb")
        if rgb.ndim != 4 or rgb.shape[3] != 4:
            raise ValueError("rgb must be (N, H, W, 4) RGBA")
        if ids and rgb.shape[:3] != (N, H, W):
            raise ValueError(f"rgb {rgb.shape[:3]} vs signals {(N, H, W)}")
        rgb_p = rgb.ctypes.data_as(u8p)
        if not ids:
            N, H, W = rgb.shape[:3]

    c_specs = (_SignalSpec * len(ids))()
    for i, sid in enumerate(ids):
        sp = specs.get(sid, {})
        inv = bool(sp.get("inverse_depth", False))
        if inv and ("near" not in sp or "far" not in sp):
            raise ValueError(f"signal {sid!r}: inverse_depth requires near and far in specs")
        if inv:
            _check_inverse_depth(sp["near"], sp["far"], sp.get("levels", LEVELS_FULL))
        c_specs[i].id = sid.encode("utf-8")
        c_specs[i].data = arrays[i].ctypes.data_as(u16p)
        c_specs[i].inverse_depth = 1 if inv else 0
        c_specs[i].near_ = sp.get("near", 0.0)
        c_specs[i].far_ = sp.get("far", 0.0)
        c_specs[i].levels = sp.get("levels", LEVELS_FULL)
    out, out_len = u8p(), _Z()
    rc = _load().dc_encode_multi(
        rgb_p, rgb_kbps, c_specs if ids else None, len(ids), W, H, N, fps,
        ctypes.byref(out), ctypes.byref(out_len),
    )
    if rc:
        raise RuntimeError(f"encode failed ({rc})")
    return _take(out, out_len)


def parse_metadata(data):
    """Return the CHROMAPAKZ metadata dict (v2 ``signals[]``)."""
    buf = _buf(data)
    json_out, json_len = ctypes.c_char_p(), _Z()
    rc = _load().dc_get_metadata(buf, len(data), ctypes.byref(json_out), ctypes.byref(json_len))
    if rc:
        raise RuntimeError("parse_metadata failed — not a ChromaPakZ file?")
    try:
        return json.loads(ctypes.string_at(json_out, json_len.value).decode("utf-8"))
    finally:
        _load().dc_free(ctypes.cast(json_out, u8p))


def probe(data):
    """Return dict(width, height, frames, fps, near, far, levels, has_rgb, signals)."""
    buf = _buf(data)
    W, H, N, fps, levels, rgb = (ctypes.c_int() for _ in range(6))
    near, far = ctypes.c_double(), ctypes.c_double()
    rc = _load().dc_probe(buf, len(data), *(ctypes.byref(x) for x in (W, H, N, fps, near, far, levels, rgb)))
    if rc:
        raise RuntimeError("probe failed — not a ChromaPakZ file?")
    meta = parse_metadata(data)
    return dict(
        width=W.value, height=H.value, frames=N.value, fps=fps.value,
        near=near.value, far=far.value, levels=levels.value, has_rgb=bool(rgb.value),
        signals=meta.get("signals", []), metadata=meta,
    )


def _out_buffer(shape, dtype):
    """Zeroed, so a file that carries fewer frames than its header claims can never hand back
    uninitialised heap — the core only writes the frames it actually decodes."""
    return np.zeros(shape, dtype=dtype)


def decode_signal(data, signal_id):
    """Decode one signal by id to (N, H, W) uint16."""
    info = probe(data)
    N, H, W = info["frames"], info["height"], info["width"]
    out = _out_buffer((N, H, W), np.uint16)
    buf = _buf(data)
    sid = signal_id.encode("utf-8")
    rc = _load().dc_decode_signal(buf, len(data), sid, out.ctypes.data_as(u16p), out.size)
    if rc:
        raise RuntimeError(f"decode_signal({signal_id!r}) failed ({_DECODE_ERRORS.get(rc, rc)})")
    return out


def decode_rgb(data):
    """Decode the RGB track to (N, H, W, 4) uint8 RGBA."""
    info = probe(data)
    if not info["has_rgb"]:
        raise RuntimeError("file has no RGB track")
    N, H, W = info["frames"], info["height"], info["width"]
    out = _out_buffer((N, H, W, 4), np.uint8)
    buf = _buf(data)
    rc = _load().dc_decode_rgb(buf, len(data), out.ctypes.data_as(u8p), out.nbytes)
    if rc:
        raise RuntimeError(f"decode_rgb failed ({_DECODE_ERRORS.get(rc, rc)})")
    return out


def decode(data, signal_ids=None):
    """Decode selected or all signals and optional RGB."""
    info = probe(data)
    ids = signal_ids if signal_ids is not None else [s["id"] for s in info["signals"]]
    out = {"metadata": info["metadata"], "signals": {}, "width": info["width"],
           "height": info["height"], "frames": info["frames"], "fps": info["fps"]}
    for sid in ids:
        out["signals"][sid] = decode_signal(data, sid)
    if info["has_rgb"]:
        out["rgb"] = decode_rgb(data)
    return out


def quantize_inverse(z, near=0.2, far=10.0, levels=LEVELS_FULL):
    """Float depth/disparity -> uint16 inverse-depth codes (code 0 == invalid)."""
    _check_inverse_depth(near, far, levels)
    z = np.ascontiguousarray(z, dtype=np.float32)
    out = np.empty(z.shape, dtype=np.uint16)
    _load().dc_quantize_inverse(z.ctypes.data_as(f32p), z.size, near, far, levels, out.ctypes.data_as(u16p))
    return out


def dequantize_inverse(d, near=0.2, far=10.0, levels=LEVELS_FULL):
    """uint16 inverse-depth codes -> float32 metric depth (invalid -> NaN)."""
    _check_inverse_depth(near, far, levels)
    d = _as_u16(d, "codes")
    out = np.empty(d.shape, dtype=np.float32)
    _load().dc_dequantize_inverse(d.ctypes.data_as(u16p), d.size, near, far, levels, out.ctypes.data_as(f32p))
    return out
