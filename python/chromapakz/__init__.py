"""ChromaPakZ — viewable RGB + bit-exact auxiliary signals in one WebM.

    import chromapakz as cz

    data = cz.encode(
        {"depth": depth_u16, "objectId": ids_u16},
        specs={"depth": {"inverse_depth": True, "near": 0.3, "far": 9.0}},
        rgb=rgba,
    )
    out = cz.decode(data)
    out["signals"]["depth"]

The RGB track is the lossy, playable half; the signals are bit-exact. A file may carry several
synchronized RGB streams (stereo / multi-camera) via `rgbs={"cam0": a, "cam1": b}`, and the
display track may be HDR10/HLG via `hdr={"transfer": "pq", ...}` — 10-bit codes in, 10-bit codes
back out of `decode_rgb`. See docs/FORMAT.md and docs/API.md.

Live recording, one frame at a time, is `create_encoder()`:

    with open("take.webm", "wb") as f:
        enc = cz.create_encoder(W, H, signals=[{"id": "depth", "near": 0.4, "far": 12}],
                                has_rgb=True, on_chunk=f.write)
        for rgba, z in frames:
            enc.add_frame(rgb=rgba, signals={"depth": {"float": z}})
        enc.finish()
"""
import ctypes
import glob
import json
import os

import numpy as np

# Single source of truth for the version: pyproject.toml reads it from here (scikit-build-core's
# regex metadata provider) and tests/version_consistency.mjs asserts package.json matches.
__version__ = "0.8.0"
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
_P = ctypes.c_void_p   # opaque dc_stream_encoder_t*


class _SignalSpec(ctypes.Structure):
    _fields_ = [
        ("id", ctypes.c_char_p),
        ("data", u16p),
        ("inverse_depth", ctypes.c_int),
        ("near_", ctypes.c_double),
        ("far_", ctypes.c_double),
        ("levels", ctypes.c_int),
    ]


class _SignalSpec2(ctypes.Structure):
    """dc_signal_spec2_t — _SignalSpec plus the optional `view` hint."""
    _fields_ = _SignalSpec._fields_ + [("view", ctypes.c_char_p)]


class _RgbSpec(ctypes.Structure):
    """dc_rgb_spec_t — one RGB stream of a multi-camera (v3) file."""
    _fields_ = [("id", ctypes.c_char_p), ("kbps", ctypes.c_int)]


class _HdrMeta(ctypes.Structure):
    """dc_hdr_meta_t — HDR10/HLG description of the display track(s)."""
    _fields_ = [
        ("transfer", ctypes.c_int), ("max_cll", ctypes.c_int), ("max_fall", ctypes.c_int),
        ("has_mastering", ctypes.c_int),
        ("rx", ctypes.c_double), ("ry", ctypes.c_double), ("gx", ctypes.c_double),
        ("gy", ctypes.c_double), ("bx", ctypes.c_double), ("by", ctypes.c_double),
        ("wx", ctypes.c_double), ("wy", ctypes.c_double),
        ("luminance_max", ctypes.c_double), ("luminance_min", ctypes.c_double),
    ]


_HDR_TRANSFERS = {"pq": 16, "hlg": 18}
_MASTERING_KEYS = ("rx", "ry", "gx", "gy", "bx", "by", "wx", "wy", "max_lum", "min_lum")


def _normalize_hdr(hdr):
    """`hdr` dict → _HdrMeta. {'transfer': 'pq'|'hlg', 'max_cll'?, 'max_fall'?, 'mastering'?}
    where mastering carries rx..wy chromaticities plus max_lum/min_lum nits (all required)."""
    hdr = dict(hdr)
    transfer = hdr.pop("transfer", "pq")
    code = _HDR_TRANSFERS.get(transfer, transfer)
    if code not in (16, 18):
        raise ValueError(f"hdr transfer must be 'pq' or 'hlg' (got {transfer!r})")
    m = _HdrMeta(transfer=code, max_cll=int(hdr.pop("max_cll", 0)),
                 max_fall=int(hdr.pop("max_fall", 0)), has_mastering=0)
    mastering = hdr.pop("mastering", None)
    if mastering is not None:
        missing = [k for k in _MASTERING_KEYS if k not in mastering]
        if missing:
            raise ValueError(f"hdr mastering is missing {missing} — ST 2086 needs all of "
                             f"{list(_MASTERING_KEYS)}")
        m.has_mastering = 1
        for k in _MASTERING_KEYS[:8]:
            setattr(m, k, float(mastering[k]))
        m.luminance_max = float(mastering["max_lum"])
        m.luminance_min = float(mastering["min_lum"])
    if hdr:
        raise ValueError(f"unknown hdr key(s) {sorted(hdr)}")
    return m


def _as_u10(arr, what):
    """Contiguous uint16 view of 10-bit display codes — values above 1023 are a caller bug."""
    a = np.asarray(arr)
    if not np.issubdtype(a.dtype, np.integer):
        raise ValueError(f"{what} must hold integer 10-bit codes 0..1023 (got dtype {a.dtype}) — "
                         "apply your PQ/HLG transfer and quantize to 10 bits first")
    if a.size and not (0 <= int(a.min()) and int(a.max()) <= 1023):
        raise ValueError(f"{what} values must be 10-bit codes in [0, 1023] "
                         f"(got [{a.min()}, {a.max()}])")
    return np.ascontiguousarray(a, dtype=np.uint16)


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


# The multi-RGB entry points (0.7.0) are bound separately and lazily, same reasoning as the
# streaming ones below: an older core keeps every single-stream call working.
_multi_rgb_bound = False


def _load_multi_rgb():
    """Load the core and bind the multi-RGB entry points. OSError if this core predates them."""
    global _multi_rgb_bound
    lib = _load()
    if _multi_rgb_bound:
        return lib
    try:
        enc2, dec_id = lib.dc_encode_multi2, lib.dc_decode_rgb_id
        create2, add2 = lib.dc_stream_create2, lib.dc_stream_add_frame2
    except AttributeError as e:
        raise OSError(
            f"this ChromaPakZ native core has no multi-RGB support ({e}) — it was built before "
            "0.7.0; rebuild it with `pip install .` or `cmake --build build`."
        ) from e
    enc2.argtypes = [
        ctypes.POINTER(u8p), ctypes.POINTER(_RgbSpec), _I,
        ctypes.POINTER(_SignalSpec2), _I, _I, _I, _I, _I,
        ctypes.POINTER(u8p), ctypes.POINTER(_Z),
    ]
    dec_id.argtypes = [u8p, _Z, ctypes.c_char_p, u8p, _Z]
    create2.argtypes = [_I, _I, _I, ctypes.POINTER(_RgbSpec), _I, _I,
                        ctypes.POINTER(_SignalSpec2), _I, ctypes.c_char_p, ctypes.POINTER(_P)]
    add2.argtypes = [_P, ctypes.POINTER(u8p), ctypes.POINTER(u16p),
                     ctypes.POINTER(u8p), ctypes.POINTER(_Z)]
    for fn in (enc2, dec_id, create2, add2):
        fn.restype = ctypes.c_int
    _multi_rgb_bound = True
    return lib


# The HDR entry points (0.8.0), gated exactly like the multi-RGB ones above.
_hdr_bound = False


def _load_hdr():
    """Load the core and bind the HDR entry points. OSError if this core predates them."""
    global _hdr_bound
    lib = _load()
    if _hdr_bound:
        return lib
    try:
        enc, create, add, dec = (lib.dc_encode_multi_hdr, lib.dc_stream_create_hdr,
                                 lib.dc_stream_add_frame16, lib.dc_decode_rgb16)
    except AttributeError as e:
        raise OSError(
            f"this ChromaPakZ native core has no HDR support ({e}) — it was built before "
            "0.8.0; rebuild it with `pip install .` or `cmake --build build`."
        ) from e
    enc.argtypes = [
        ctypes.POINTER(u16p), ctypes.POINTER(_RgbSpec), _I, ctypes.POINTER(_HdrMeta),
        ctypes.POINTER(_SignalSpec2), _I, _I, _I, _I, _I,
        ctypes.POINTER(u8p), ctypes.POINTER(_Z),
    ]
    create.argtypes = [_I, _I, _I, ctypes.POINTER(_RgbSpec), _I, ctypes.POINTER(_HdrMeta), _I,
                       ctypes.POINTER(_SignalSpec2), _I, ctypes.c_char_p, ctypes.POINTER(_P)]
    add.argtypes = [_P, ctypes.POINTER(u16p), ctypes.POINTER(u16p),
                    ctypes.POINTER(u8p), ctypes.POINTER(_Z)]
    dec.argtypes = [u8p, _Z, ctypes.c_char_p, u16p, _Z]
    for fn in (enc, create, add, dec):
        fn.restype = ctypes.c_int
    _hdr_bound = True
    return lib


def _normalize_rgb_streams(rgbs, rgb_kbps):
    """`rgbs` (list of ids / (id, kbps) pairs, or {id: kbps}) → [(id, kbps)], order preserved.

    `rgb_kbps` fills in any stream without its own bitrate."""
    if isinstance(rgbs, dict):
        items = [(sid, kbps) for sid, kbps in rgbs.items()]
    else:
        items = []
        for raw in rgbs:
            if isinstance(raw, str):
                items.append((raw, None))
            else:
                sid, kbps = raw
                items.append((sid, kbps))
    seen = set()
    out = []
    for sid, kbps in items:
        if not isinstance(sid, str) or not sid:
            raise ValueError(f"each rgb stream needs a non-empty string id (got {sid!r})")
        if sid in seen:
            raise ValueError(f"duplicate rgb stream id {sid!r}")
        seen.add(sid)
        out.append((sid, int(kbps if kbps is not None else rgb_kbps)))
    return out


# The streaming entry points are bound separately, and only when a stream is actually opened: a
# core built before they existed still loads, and every batch call keeps working, rather than
# every use of the package failing at bind time on one missing symbol.
_stream_bound = False


def _load_stream():
    """Load the core and bind dc_stream_*. Raises OSError if this core predates them."""
    global _stream_bound
    lib = _load()
    if _stream_bound:
        return lib
    try:
        create, header, add, fin, destroy = (
            lib.dc_stream_create, lib.dc_stream_header, lib.dc_stream_add_frame,
            lib.dc_stream_finish, lib.dc_stream_destroy)
    except AttributeError as e:
        raise OSError(
            f"this ChromaPakZ native core has no streaming encoder ({e}) — it was built before "
            "create_encoder() existed; rebuild it with `pip install .` or `cmake --build build`."
        ) from e
    # Additive in 0.5.0: an older core still streams, just without a metadata track.
    create_ex = getattr(lib, "dc_stream_create_ex", None)
    add_text = getattr(lib, "dc_stream_add_text", None)
    if create_ex is not None and add_text is not None:
        create_ex.argtypes = [_I, _I, _I, _I, _I, _I, ctypes.POINTER(_SignalSpec), _I,
                              ctypes.c_char_p, ctypes.POINTER(_P)]
        create_ex.restype = ctypes.c_int
        add_text.argtypes = [_P, _I, _I, u8p, _Z, ctypes.POINTER(u8p), ctypes.POINTER(_Z)]
        add_text.restype = ctypes.c_int

    create.argtypes = [_I, _I, _I, _I, _I, _I, ctypes.POINTER(_SignalSpec), _I, ctypes.POINTER(_P)]
    header.argtypes = [_P, ctypes.POINTER(u8p), ctypes.POINTER(_Z)]
    add.argtypes = [_P, u8p, ctypes.POINTER(u16p), ctypes.POINTER(u8p), ctypes.POINTER(_Z)]
    fin.argtypes = [_P, ctypes.POINTER(u8p), ctypes.POINTER(_Z)]
    destroy.argtypes = [_P]
    destroy.restype = None
    for fn in (create, header, add, fin):
        fn.restype = ctypes.c_int
    _stream_bound = True
    return lib


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


def encode(signals=None, specs=None, rgb=None, rgbs=None, fps=30, rgb_kbps=2000, hdr=None):
    """Encode lossless uint16 signals (+ optional RGB) to WebM bytes.

    Signals must be integer codes in [0, 65535] and rgb uint8 RGBA — a lossy cast
    (float depth, out-of-range ints) is an error, not a silent wraparound.

    ``rgbs`` stores multiple synchronized RGB streams (stereo / multi-camera): a ``{id: array}``
    dict (or ``[(id, array)]`` pairs), each ``(N, H, W, 4)``, order fixing the track numbering.
    The first stream is the primary — the one legacy readers and plain players see. Mutually
    exclusive with ``rgb``. ``rgb_kbps`` may then be a ``{id: kbps}`` dict for per-stream rates.
    A spec may also carry ``view``: the id of the RGB stream whose camera frame that signal
    lives in — recorded in the metadata verbatim, never interpreted.

    ``hdr`` makes every RGB stream an HDR display track (VP9 profile 2, 10-bit, BT.2020,
    with the WebM Colour element written): ``{'transfer': 'pq'|'hlg', 'max_cll'?, 'max_fall'?,
    'mastering'?: {rx, ry, gx, gy, bx, by, wx, wy, max_lum, min_lum}}``. RGB arrays are then
    uint16 planes of 10-bit display codes (0..1023). Signals are unaffected either way.
    """
    signals = dict(signals or {})
    if rgb is not None and rgbs is not None:
        raise ValueError("pass rgb or rgbs, not both")
    if not signals and rgb is None and rgbs is None:
        raise ValueError("need at least one signal or rgb")
    c_hdr = _normalize_hdr(hdr) if hdr is not None else None
    if c_hdr is not None:
        if rgb is None and rgbs is None:
            raise ValueError("hdr describes the display track — pass rgb or rgbs with it")
        if rgb is not None:      # single default stream, as elsewhere
            rgbs, rgb = {"rgb": rgb}, None
    # fps drives the encoder timebase and the block timestamps; the native side rejects fps <= 0,
    # but raise here so the caller gets the offending value rather than a bare error code.
    if not isinstance(fps, (int, np.integer)) or fps <= 0:
        raise ValueError(f"fps must be a positive integer (got {fps!r})")
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

    rgb_items = None   # [(id, array)] when the multi-stream form is in play
    if rgbs is not None:
        pairs = list(rgbs.items()) if isinstance(rgbs, dict) else list(rgbs)
        rgb_items = []
        for sid, arr in pairs:
            a = (_as_u10 if c_hdr is not None else _as_u8)(arr, f"rgb stream {sid!r}")
            if a.ndim != 4 or a.shape[3] != 4:
                raise ValueError(f"rgb stream {sid!r} must be (N, H, W, 4) RGBA")
            if dims is None:
                dims = a.shape[:3]
                N, H, W = dims
            elif a.shape[:3] != (N, H, W):
                raise ValueError(f"rgb stream {sid!r} {a.shape[:3]} != {(N, H, W)}")
            rgb_items.append((sid, a))
        if not rgb_items and not ids:
            raise ValueError("need at least one signal or rgb")

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

    def fill_spec(c, i, sid, with_view):
        sp = specs.get(sid, {})
        inv = bool(sp.get("inverse_depth", False))
        if inv and ("near" not in sp or "far" not in sp):
            raise ValueError(f"signal {sid!r}: inverse_depth requires near and far in specs")
        if inv:
            _check_inverse_depth(sp["near"], sp["far"], sp.get("levels", LEVELS_FULL))
        c[i].id = sid.encode("utf-8")
        c[i].data = arrays[i].ctypes.data_as(u16p)
        c[i].inverse_depth = 1 if inv else 0
        c[i].near_ = sp.get("near", 0.0)
        c[i].far_ = sp.get("far", 0.0)
        c[i].levels = sp.get("levels", LEVELS_FULL)
        if with_view:
            view = sp.get("view")
            c[i].view = view.encode("utf-8") if view else None

    out, out_len = u8p(), _Z()
    has_view = any("view" in (specs.get(sid) or {}) for sid in ids)
    if c_hdr is not None or rgb_items is not None or has_view:
        lib = _load_hdr() if c_hdr is not None else _load_multi_rgb()
        kbps_by_id = rgb_kbps if isinstance(rgb_kbps, dict) else {}
        default_kbps = 2000 if isinstance(rgb_kbps, dict) else rgb_kbps
        streams = _normalize_rgb_streams(
            [(sid, kbps_by_id.get(sid)) for sid, _ in (rgb_items or [])], default_kbps)
        c_rgbs = (_RgbSpec * len(streams))()
        for i, (sid, kbps) in enumerate(streams):
            c_rgbs[i].id = sid.encode("utf-8")
            c_rgbs[i].kbps = kbps
        c_specs2 = (_SignalSpec2 * len(ids))()
        for i, sid in enumerate(ids):
            fill_spec(c_specs2, i, sid, with_view=True)
        if c_hdr is not None:
            rgba16_ptrs = (u16p * len(streams))(*(a.ctypes.data_as(u16p) for _, a in rgb_items))
            rc = lib.dc_encode_multi_hdr(
                rgba16_ptrs, c_rgbs, len(streams), ctypes.byref(c_hdr),
                c_specs2 if ids else None, len(ids), W, H, N, fps,
                ctypes.byref(out), ctypes.byref(out_len),
            )
        else:
            rgba_ptrs = (u8p * len(streams))(*(a.ctypes.data_as(u8p) for _, a in (rgb_items or [])))
            rc = lib.dc_encode_multi2(
                rgba_ptrs if streams else None, c_rgbs if streams else None, len(streams),
                c_specs2 if ids else None, len(ids), W, H, N, fps,
                ctypes.byref(out), ctypes.byref(out_len),
            )
    else:
        c_specs = (_SignalSpec * len(ids))()
        for i, sid in enumerate(ids):
            fill_spec(c_specs, i, sid, with_view=False)
        rc = _load().dc_encode_multi(
            rgb_p, rgb_kbps, c_specs if ids else None, len(ids), W, H, N, fps,
            ctypes.byref(out), ctypes.byref(out_len),
        )
    if rc:
        raise RuntimeError(f"encode failed ({rc})")
    return _take(out, out_len)


# ── streaming (live-recording) encode ──
# encode() needs the whole take in memory before it writes a byte. This path writes the file as it
# is captured: the header goes out before the first frame, whole Cluster elements follow as they
# close, and what is on disk is a valid, decodable WebM at every point — so a crashed capture
# loses the tail rather than the take.

_STREAM_ERRORS = {
    1: "invalid argument",
    2: "the RGB encoder failed",
    3: "a signal encoder failed",
    5: "allocation failed",
    6: "the stream is already finished",
}


def _stream_error(op, rc):
    return RuntimeError(f"{op} failed ({_STREAM_ERRORS.get(rc, rc)})")


def _normalize_stream_signals(signals):
    """[{'id': 'depth', 'near':…, 'far':…}, …] (or {id: spec}) → [(id, spec)] in track order."""
    if isinstance(signals, dict):
        items = [(sid, dict(sp or {})) for sid, sp in signals.items()]
    else:
        items = []
        for raw in signals or []:
            sp = dict(raw)
            sid = sp.pop("id", None)
            if not isinstance(sid, str) or not sid:
                raise ValueError(f"each signal needs a string 'id' (got {raw!r})")
            items.append((sid, sp))
    seen = set()
    for sid, sp in items:
        if sid in seen:
            raise ValueError(f"duplicate signal id {sid!r}")
        seen.add(sid)
        # Matching planSignals() in the JS encoder: a spec carrying `near` is inverse-depth,
        # whether or not it says so.
        if sp.get("inverse_depth") or "near" in sp:
            if "near" not in sp or "far" not in sp:
                raise ValueError(f"signal {sid!r}: inverse_depth requires near and far")
            _check_inverse_depth(sp["near"], sp["far"], sp.get("levels", LEVELS_FULL))
            sp["inverse_depth"] = True
    return items


class StreamEncoder:
    """Incremental encoder — see :func:`create_encoder`. Not thread-safe."""

    def __init__(self, width, height, signals, fps=30, has_rgb=False, rgb_kbps=2000,
                 on_chunk=None, cues=True, text_track=None, rgbs=None, hdr=None):
        # First, so __del__ finds them however early construction fails.
        self._h = self._destroy = None
        self._finished = False
        self._hdr = _normalize_hdr(hdr) if hdr is not None else None
        if self._hdr is not None and rgbs is None and not has_rgb:
            raise ValueError("hdr describes the display track — pass rgbs or has_rgb with it")
        if not isinstance(fps, (int, np.integer)) or fps <= 0:
            raise ValueError(f"fps must be a positive integer (got {fps!r})")
        for name, v in (("width", width), ("height", height)):
            if not isinstance(v, (int, np.integer)) or v <= 0:
                raise ValueError(f"{name} must be a positive integer (got {v!r})")
        if on_chunk is not None and not callable(on_chunk):
            raise ValueError("on_chunk must be callable (e.g. a file object's .write)")
        if rgbs is not None and has_rgb:
            raise ValueError("pass rgbs or has_rgb, not both")
        self._specs = _normalize_stream_signals(signals)
        default_kbps = 2000 if isinstance(rgb_kbps, dict) else int(rgb_kbps)
        kbps_by_id = rgb_kbps if isinstance(rgb_kbps, dict) else {}
        if rgbs is not None:
            items = list(rgbs.items()) if isinstance(rgbs, dict) else [
                (r, None) if isinstance(r, str) else tuple(r) for r in rgbs]
            self._rgb_streams = _normalize_rgb_streams(
                [(sid, kbps if kbps is not None else kbps_by_id.get(sid)) for sid, kbps in items],
                default_kbps)
        else:
            self._rgb_streams = [("rgb", default_kbps)] if has_rgb else []
        # RGB-only takes (video + wrapper metadata, no aux planes) are valid — the native
        # ABI already accepts num_signals == 0 with RGB streams. A stream with no tracks at
        # all is not. Mirrors the batch encoder's "need at least one signal or rgb".
        if not self._specs and not self._rgb_streams:
            raise ValueError("create_encoder: need rgb or at least one signal")
        self.width, self.height, self.fps = int(width), int(height), int(fps)
        self.has_rgb = bool(self._rgb_streams)
        self.rgb_ids = [sid for sid, _ in self._rgb_streams]
        self._on_chunk = on_chunk
        self._cues = bool(cues)
        self._n = 0
        # The single-stream, no-view, SDR path keeps using the pre-0.7.0 entry points, so this
        # wrapper still drives an older native core for everything it could already do.
        self._multi = (rgbs is not None or self._hdr is not None
                       or any("view" in sp for _, sp in self._specs))

        lib = self._lib = _load_stream()
        h = _P()
        self._text_track = text_track
        if self._multi:
            _load_hdr() if self._hdr is not None else _load_multi_rgb()
            c_rgbs = (_RgbSpec * len(self._rgb_streams))()
            for i, (sid, kbps) in enumerate(self._rgb_streams):
                c_rgbs[i].id = sid.encode("utf-8")
                c_rgbs[i].kbps = kbps
            c_specs = (_SignalSpec2 * len(self._specs))()
            for i, (sid, sp) in enumerate(self._specs):
                c_specs[i].id = sid.encode("utf-8")
                c_specs[i].data = None
                c_specs[i].inverse_depth = 1 if sp.get("inverse_depth") else 0
                c_specs[i].near_ = sp.get("near", 0.0)
                c_specs[i].far_ = sp.get("far", 0.0)
                c_specs[i].levels = sp.get("levels", LEVELS_FULL)
                view = sp.get("view")
                c_specs[i].view = view.encode("utf-8") if view else None
            text_c = str(text_track).encode("utf-8") if text_track else None
            if self._hdr is not None:
                rc = lib.dc_stream_create_hdr(
                    self.width, self.height, self.fps,
                    c_rgbs, len(self._rgb_streams), ctypes.byref(self._hdr),
                    1 if self._cues else 0, c_specs, len(c_specs), text_c, ctypes.byref(h))
            else:
                rc = lib.dc_stream_create2(
                    self.width, self.height, self.fps,
                    c_rgbs if self._rgb_streams else None, len(self._rgb_streams),
                    1 if self._cues else 0, c_specs, len(c_specs), text_c, ctypes.byref(h))
        else:
            c_specs = (_SignalSpec * len(self._specs))()
            for i, (sid, sp) in enumerate(self._specs):
                c_specs[i].id = sid.encode("utf-8")
                c_specs[i].data = None
                c_specs[i].inverse_depth = 1 if sp.get("inverse_depth") else 0
                c_specs[i].near_ = sp.get("near", 0.0)
                c_specs[i].far_ = sp.get("far", 0.0)
                c_specs[i].levels = sp.get("levels", LEVELS_FULL)
            if text_track:
                if not hasattr(lib, "dc_stream_create_ex"):
                    raise OSError(
                        "this ChromaPakZ native core has no metadata track (added in 0.5.0) — "
                        "rebuild it with `pip install .` or drop text_track=")
                rc = lib.dc_stream_create_ex(self.width, self.height, self.fps, default_kbps,
                                             1 if self.has_rgb else 0, 1 if self._cues else 0,
                                             c_specs, len(c_specs),
                                             str(text_track).encode("utf-8"), ctypes.byref(h))
            else:
                rc = lib.dc_stream_create(self.width, self.height, self.fps, default_kbps,
                                          1 if self.has_rgb else 0, 1 if self._cues else 0,
                                          c_specs, len(c_specs), ctypes.byref(h))
        if rc:
            raise _stream_error("create_encoder", rc)
        self._h = h
        # Bound to the instance so close() needs nothing from module state, which may already be
        # torn down when __del__ runs at interpreter exit.
        self._destroy, self._free = lib.dc_stream_destroy, lib.dc_free
        self.header = self._emit(self._take_chunk(lib.dc_stream_header, "header"))

    # ── plumbing ──
    def _take_chunk(self, fn, op, *args):
        out, out_len = u8p(), _Z()
        rc = fn(self._h, *args, ctypes.byref(out), ctypes.byref(out_len))
        if rc:
            raise _stream_error(op, rc)
        if not out_len.value:
            return b""     # the usual case: this frame only extended the open cluster
        try:
            return ctypes.string_at(out, out_len.value)
        finally:
            self._free(out)

    def _emit(self, chunk):
        if chunk and self._on_chunk is not None:
            self._on_chunk(chunk)
        return chunk

    def _plane(self, sid, spec, payload):
        """One signal's frame payload → contiguous (H, W) uint16 codes."""
        if isinstance(payload, dict):
            if "u16" in payload:
                arr = _as_u16(payload["u16"], f"signal {sid!r}")
            elif "float" in payload:
                if not spec.get("inverse_depth"):
                    raise ValueError(f"signal {sid!r}: {{'float': …}} needs an inverse-depth "
                                     "range — declare near/far for it in create_encoder()")
                arr = quantize_inverse(payload["float"], spec["near"], spec["far"],
                                       spec.get("levels", LEVELS_FULL))
            else:
                raise ValueError(f"signal {sid!r}: pass an array, {{'u16': …}} or {{'float': …}}")
        else:
            arr = _as_u16(payload, f"signal {sid!r}")
        if arr.shape != (self.height, self.width):
            raise ValueError(f"signal {sid!r} has shape {arr.shape}, "
                             f"expected {(self.height, self.width)}")
        return arr

    # ── the API ──
    @property
    def frame_count(self):
        """Frames accepted so far. A rejected frame is not counted."""
        return self._n

    def add_frame(self, rgb=None, signals=None, rgbs=None):
        """Encode one frame; returns the bytes that just became final (often ``b""``).

        Every stream the encoder declared must be present on every frame: each track carries its
        own frame counter, so one that stops and resumes cannot be realigned. A multi-stream
        encoder takes ``rgbs={id: array}`` with every declared id; ``rgb=`` remains sugar for
        the sole stream of a single-stream encoder.
        """
        if self._h is None:
            raise RuntimeError("encoder is closed")
        if self._finished:
            raise RuntimeError("add_frame after finish()")
        signals = dict(signals or {})
        extra = set(signals) - {sid for sid, _ in self._specs}
        if extra:
            raise ValueError(f"unknown signal(s) {sorted(extra)} — this encoder declared "
                             f"{[sid for sid, _ in self._specs]}")
        # Validate and quantize everything before the native call: a rejected frame must leave the
        # stateful VP9 encoders untouched, so the caller can fix it and carry on.
        planes = []
        for sid, spec in self._specs:
            if sid not in signals or signals[sid] is None:
                raise ValueError(f"frame {self._n} is missing signal {sid!r}; every declared "
                                 "signal must be written on every frame")
            planes.append(self._plane(sid, spec, signals[sid]))

        if rgb is not None and rgbs is not None:
            raise ValueError("pass rgb or rgbs, not both")
        if rgb is not None:
            if len(self.rgb_ids) > 1:
                raise ValueError(f"this encoder declared rgb streams {self.rgb_ids}; "
                                 "pass rgbs={id: array} with every declared stream")
            if not self.rgb_ids:
                raise ValueError("this encoder was created with has_rgb=False, so it has no rgb "
                                 "track to write this frame to")
            rgbs = {self.rgb_ids[0]: rgb}
        rgbs = dict(rgbs or {})
        extra_rgb = set(rgbs) - set(self.rgb_ids)
        if extra_rgb:
            raise ValueError(f"unknown rgb stream(s) {sorted(extra_rgb)} — this encoder "
                             f"declared {self.rgb_ids}")
        rgb_planes = []
        as_rgb = _as_u10 if self._hdr is not None else _as_u8
        for sid in self.rgb_ids:
            if sid not in rgbs or rgbs[sid] is None:
                raise ValueError(f"frame {self._n} is missing rgb stream {sid!r}; every declared "
                                 "stream must be written on every frame")
            rgba = as_rgb(rgbs[sid], f"rgb stream {sid!r}")
            if rgba.shape != (self.height, self.width, 4):
                raise ValueError(f"rgb stream {sid!r} has shape {rgba.shape}, "
                                 f"expected {(self.height, self.width, 4)} RGBA")
            rgb_planes.append(rgba)

        c_planes = (u16p * len(planes))(*(p.ctypes.data_as(u16p) for p in planes))
        if self._hdr is not None:
            c_rgbas = (u16p * len(rgb_planes))(*(a.ctypes.data_as(u16p) for a in rgb_planes))
            chunk = self._take_chunk(self._lib.dc_stream_add_frame16, "add_frame",
                                     c_rgbas if rgb_planes else None, c_planes)
        elif self._multi:
            c_rgbas = (u8p * len(rgb_planes))(*(a.ctypes.data_as(u8p) for a in rgb_planes))
            chunk = self._take_chunk(self._lib.dc_stream_add_frame2, "add_frame",
                                     c_rgbas if rgb_planes else None, c_planes)
        else:
            rgb_p = rgb_planes[0].ctypes.data_as(u8p) if rgb_planes else u8p()
            chunk = self._take_chunk(self._lib.dc_stream_add_frame, "add_frame", rgb_p, c_planes)
        self._n += 1
        return self._emit(chunk)

    def add_text(self, text, timestamp, duration=None):
        """Append one timed-text cue to the metadata track.

        ``timestamp`` and ``duration`` are seconds. Cues ride inside the cluster the
        surrounding frames are already filling, so this usually returns ``b""``.
        Requires ``text_track=`` at construction.
        """
        if not self._text_track:
            raise RuntimeError("no metadata track: pass text_track= to create_encoder()")
        if self._h is None:
            raise RuntimeError("encoder is closed")
        if self._finished:
            raise RuntimeError("encoder is finished")
        payload = text.encode("utf-8") if isinstance(text, str) else bytes(text)
        buf = (ctypes.c_ubyte * len(payload)).from_buffer_copy(payload)
        dur_ms = int(round((duration if duration is not None else 1.0 / self.fps) * 1000))
        chunk = self._take_chunk(self._lib.dc_stream_add_text, "add_text",
                                 _I(int(round(timestamp * 1000))), _I(max(0, dur_ms)),
                                 buf, _Z(len(payload)))
        return self._emit(chunk)

    def finish(self):
        """Flush the codecs and close the file; returns the tail bytes (last cluster + Cues).

        ``header`` + every ``add_frame()`` chunk + this is the complete WebM.
        """
        if self._h is None:
            raise RuntimeError("encoder is closed")
        if self._finished:
            raise RuntimeError("finish() called twice")
        tail = self._take_chunk(self._lib.dc_stream_finish, "finish")
        self._finished = True
        return self._emit(tail)

    def close(self):
        """Release the native encoder state. Idempotent; does *not* write the tail."""
        if self._h is not None:
            self._destroy(self._h)
            self._h = None

    __del__ = close

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        # A take abandoned by an exception keeps whatever chunks already went out — that is the
        # point of streaming — but writing a tail for it would claim a clean ending it never had.
        try:
            if exc_type is None and not self._finished:
                self.finish()
        finally:
            self.close()
        return False


def create_encoder(width, height, signals=None, fps=30, has_rgb=False, rgb_kbps=2000,
                   on_chunk=None, cues=True, text_track=None, rgbs=None, hdr=None):
    """Open a streaming encoder for a live W*H capture.

        enc = cz.create_encoder(W, H, fps=30, has_rgb=True, on_chunk=f.write,
                                signals=[{"id": "depth", "near": 0.4, "far": 12.0}])
        enc.add_frame(rgb=rgba, signals={"depth": {"float": z}})
        enc.finish()

    Multi-camera (stereo) capture declares its RGB streams with `rgbs` instead of `has_rgb` —
    a list of stream ids (or `(id, kbps)` pairs, or a `{id: kbps}` dict), order fixing the
    track numbering; the first stream is the primary one legacy readers decode. Frames then
    pass `rgbs={id: array}` with every declared stream:

        enc = cz.create_encoder(W, H, rgbs=["cam0", "cam1"], signals=[...])
        enc.add_frame(rgbs={"cam0": a, "cam1": b}, signals=...)

    `hdr` makes every RGB stream an HDR display track (VP9 profile 2, 10-bit, BT.2020, WebM
    Colour element): `{'transfer': 'pq'|'hlg', 'max_cll'?, 'max_fall'?, 'mastering'?}` — frames
    then carry uint16 planes of 10-bit display codes (0..1023). See `encode()` for the shape.

    `signals` is a list of specs (each with an `id`, plus `near`/`far`/`levels` for an
    inverse-depth signal), or a `{id: spec}` dict; the order fixes the track numbering. It may
    be empty or None for an RGB-only take (`has_rgb=True`) — video plus wrapper metadata, no
    auxiliary planes. RGB presence is declared here rather than inferred, because the header —
    including the track plan — is written before the first frame arrives.

    Each frame's signal payload is `(H, W)` uint16 codes, `{"u16": codes}`, or `{"float": z}` for
    a signal with an inverse-depth range (quantized for you, as the browser encoder does). Every
    declared signal, and `rgb` when `has_rgb`, must be present on every frame.

    Chunks are element-aligned — `header` is the whole file prefix, each later chunk a whole
    number of Cluster elements — so a wrapper format can interleave its own Matroska elements
    between them. Pass `cues=False` when it does: cue positions are byte offsets into the Segment,
    which injected bytes invalidate.

    `on_chunk` is called with each chunk as it is produced (`header` at construction). It is also
    returned, so a pull-style writer can ignore the callback entirely. Nothing retained here grows
    with the take: the encoder state, the open cluster, and the cue index if one was asked for.
    """
    return StreamEncoder(width, height, signals, fps=fps, has_rgb=has_rgb, rgb_kbps=rgb_kbps,
                         on_chunk=on_chunk, cues=cues, text_track=text_track, rgbs=rgbs, hdr=hdr)


def parse_metadata(data):
    """Return the CHROMAPAKZ metadata dict (``signals[]``, plus ``rgbs[]`` on a v3 file)."""
    buf = _buf(data)
    json_out, json_len = ctypes.c_char_p(), _Z()
    rc = _load().dc_get_metadata(buf, len(data), ctypes.byref(json_out), ctypes.byref(json_len))
    if rc:
        raise RuntimeError("parse_metadata failed — not a ChromaPakZ file?")
    try:
        raw = ctypes.string_at(json_out, json_len.value)
    finally:
        _load().dc_free(ctypes.cast(json_out, u8p))
    # A truncated file can still carry a well-formed tag whose payload is cut off, so the
    # blob is untrusted even when dc_get_metadata succeeds. Keep the documented contract:
    # malformed input raises RuntimeError, never a JSON/Unicode error from the internals.
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise RuntimeError(f"parse_metadata failed — malformed CHROMAPAKZ metadata ({e})") from e


def probe(data):
    """Return dict(width, height, frames, fps, near, far, levels, has_rgb, rgbs, signals).

    ``has_rgb`` stays a bool; ``rgbs`` lists every RGB stream (``[{id, track, codec}]``,
    primary first — one synthesized default entry for a pre-v3 file with RGB)."""
    buf = _buf(data)
    W, H, N, fps, levels, rgb = (ctypes.c_int() for _ in range(6))
    near, far = ctypes.c_double(), ctypes.c_double()
    rc = _load().dc_probe(buf, len(data), *(ctypes.byref(x) for x in (W, H, N, fps, near, far, levels, rgb)))
    if rc:
        raise RuntimeError("probe failed — not a ChromaPakZ file?")
    meta = parse_metadata(data)
    rgbs = meta.get("rgbs")
    if not rgbs:
        rgbs = [dict(meta["rgb"], id="rgb")] if meta.get("rgb") else []
    return dict(
        width=W.value, height=H.value, frames=N.value, fps=fps.value,
        near=near.value, far=far.value, levels=levels.value, has_rgb=bool(rgb.value),
        rgbs=rgbs, signals=meta.get("signals", []), metadata=meta,
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


def decode_rgb(data, stream=None):
    """Decode one RGB stream to a (N, H, W, 4) RGBA array.

    ``stream`` is the stream id of a multi-camera (v3) file; None means the primary stream —
    the one legacy readers see. An SDR stream comes back uint8; an HDR display track (0.8.0)
    comes back uint16 holding 10-bit PQ/HLG codes (0..1023), per its metadata ``hdr`` entry."""
    info = probe(data)
    if not info["has_rgb"]:
        raise RuntimeError("file has no RGB track")
    N, H, W = info["frames"], info["height"], info["width"]
    entry = (info["rgbs"][0] if stream is None
             else next((r for r in info["rgbs"] if r.get("id") == stream), None))
    buf = _buf(data)
    if entry is not None and entry.get("hdr"):
        out = _out_buffer((N, H, W, 4), np.uint16)
        rc = _load_hdr().dc_decode_rgb16(
            buf, len(data), stream.encode("utf-8") if stream is not None else None,
            out.ctypes.data_as(u16p), out.size)
    else:
        out = _out_buffer((N, H, W, 4), np.uint8)
        if stream is None:
            rc = _load().dc_decode_rgb(buf, len(data), out.ctypes.data_as(u8p), out.nbytes)
        else:
            rc = _load_multi_rgb().dc_decode_rgb_id(buf, len(data), stream.encode("utf-8"),
                                                    out.ctypes.data_as(u8p), out.nbytes)
    if rc == 8:
        raise RuntimeError(f"file has no rgb stream {stream!r} "
                           f"(it carries {[r['id'] for r in info['rgbs']]})")
    if rc:
        raise RuntimeError(f"decode_rgb failed ({_DECODE_ERRORS.get(rc, rc)})")
    return out


def decode(data, signal_ids=None):
    """Decode selected or all signals and RGB.

    ``rgb`` is the primary stream, as always; a multi-camera file additionally yields
    ``rgbs`` — ``{id: (N, H, W, 4) array}`` for every stream, primary included."""
    info = probe(data)
    ids = signal_ids if signal_ids is not None else [s["id"] for s in info["signals"]]
    out = {"metadata": info["metadata"], "signals": {}, "width": info["width"],
           "height": info["height"], "frames": info["frames"], "fps": info["fps"]}
    for sid in ids:
        out["signals"][sid] = decode_signal(data, sid)
    if info["has_rgb"]:
        out["rgb"] = decode_rgb(data)
        out["rgbs"] = {info["rgbs"][0]["id"]: out["rgb"]}
        for r in info["rgbs"][1:]:
            out["rgbs"][r["id"]] = decode_rgb(data, stream=r["id"])
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
