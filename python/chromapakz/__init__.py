"""ChromaPakZ — lossless RGB + bit-exact auxiliary signals in one WebM.

    import chromapakz as cz

    data = cz.encode(
        {"depth": depth_u16, "objectId": ids_u16},
        specs={"depth": {"inverse_depth": True, "near": 0.3, "far": 9.0}},
        rgb=rgba,
    )
    out = cz.decode(data)
    out["signals"]["depth"]

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
__version__ = "0.4.0"
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


def encode(signals=None, specs=None, rgb=None, fps=30, rgb_kbps=2000):
    """Encode lossless uint16 signals (+ optional RGB) to WebM bytes.

    Signals must be integer codes in [0, 65535] and rgb uint8 RGBA — a lossy cast
    (float depth, out-of-range ints) is an error, not a silent wraparound.
    """
    signals = dict(signals or {})
    if not signals and rgb is None:
        raise ValueError("need at least one signal or rgb")
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
                 on_chunk=None, cues=True):
        # First, so __del__ finds them however early construction fails.
        self._h = self._destroy = None
        self._finished = False
        if not isinstance(fps, (int, np.integer)) or fps <= 0:
            raise ValueError(f"fps must be a positive integer (got {fps!r})")
        for name, v in (("width", width), ("height", height)):
            if not isinstance(v, (int, np.integer)) or v <= 0:
                raise ValueError(f"{name} must be a positive integer (got {v!r})")
        if on_chunk is not None and not callable(on_chunk):
            raise ValueError("on_chunk must be callable (e.g. a file object's .write)")
        self._specs = _normalize_stream_signals(signals)
        # RGB-only takes (video + wrapper metadata, no aux planes) are valid — the native
        # ABI already accepts num_signals == 0 with has_rgb. A stream with no tracks at
        # all is not. Mirrors the batch encoder's "need at least one signal or rgb".
        if not self._specs and not has_rgb:
            raise ValueError("create_encoder: need rgb or at least one signal")
        self.width, self.height, self.fps = int(width), int(height), int(fps)
        self.has_rgb = bool(has_rgb)
        self._on_chunk = on_chunk
        self._cues = bool(cues)
        self._n = 0

        lib = self._lib = _load_stream()
        c_specs = (_SignalSpec * len(self._specs))()
        for i, (sid, sp) in enumerate(self._specs):
            c_specs[i].id = sid.encode("utf-8")
            c_specs[i].data = None
            c_specs[i].inverse_depth = 1 if sp.get("inverse_depth") else 0
            c_specs[i].near_ = sp.get("near", 0.0)
            c_specs[i].far_ = sp.get("far", 0.0)
            c_specs[i].levels = sp.get("levels", LEVELS_FULL)
        h = _P()
        rc = lib.dc_stream_create(self.width, self.height, self.fps, int(rgb_kbps),
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

    def add_frame(self, rgb=None, signals=None):
        """Encode one frame; returns the bytes that just became final (often ``b""``).

        Every stream the encoder declared must be present on every frame: each track carries its
        own frame counter, so one that stops and resumes cannot be realigned.
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
        rgb_p = u8p()
        if self.has_rgb:
            if rgb is None:
                raise ValueError(f"frame {self._n} carries no rgb, but this encoder was created "
                                 "with has_rgb=True")
            rgba = _as_u8(rgb, "rgb")
            if rgba.shape != (self.height, self.width, 4):
                raise ValueError(f"rgb has shape {rgba.shape}, "
                                 f"expected {(self.height, self.width, 4)} RGBA")
            rgb_p = rgba.ctypes.data_as(u8p)
        elif rgb is not None:
            raise ValueError("this encoder was created with has_rgb=False, so it has no rgb "
                             "track to write this frame to")

        c_planes = (u16p * len(planes))(*(p.ctypes.data_as(u16p) for p in planes))
        chunk = self._take_chunk(self._lib.dc_stream_add_frame, "add_frame", rgb_p, c_planes)
        self._n += 1
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
                   on_chunk=None, cues=True):
    """Open a streaming encoder for a live W*H capture.

        enc = cz.create_encoder(W, H, fps=30, has_rgb=True, on_chunk=f.write,
                                signals=[{"id": "depth", "near": 0.4, "far": 12.0}])
        enc.add_frame(rgb=rgba, signals={"depth": {"float": z}})
        enc.finish()

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
                         on_chunk=on_chunk, cues=cues)


def parse_metadata(data):
    """Return the CHROMAPAKZ metadata dict (v2 ``signals[]``)."""
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
