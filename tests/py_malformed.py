"""Malformed-container guards for the native EBML/SimpleBlock demuxer (issue #7).

Complements tests/py_decode_bounds.py (issue #6), which crafts *valid* containers whose
metadata lies about frame count or frame size. This file attacks the layer below that: the
container parse itself. Truncated and byte-mutated files must produce a clean error or
correct data — never a crash, and never a read outside the input buffer.

Before the parser was bounds-checked, truncating the file below to 108 bytes was enough to
abort the process: kids() clamped only dEnd to the parent, so dStart could exceed it and the
size_t `dEnd - dStart` wrapped to a huge length inside std::string::assign.

Decode calls pass the real capacity and keep sentinel padding past it, so an overrun is
caught even when it doesn't segfault. Run under ASan for the strongest signal.
Run: python tests/py_malformed.py  (needs the compiled native core, like roundtrip.py)
"""
import ctypes
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
import numpy as np

import chromapakz as cz

u8p = ctypes.POINTER(ctypes.c_uint8)
u16p = ctypes.POINTER(ctypes.c_uint16)

W, H, N = 40, 24, 3
rng = np.random.default_rng(11)
depth = rng.integers(1, 65536, (N, H, W)).astype(np.uint16)
rgb = rng.integers(0, 256, (N, H, W, 4)).astype(np.uint8)
GOOD = cz.encode({"depth": depth}, rgb=rgb)
assert cz.probe(GOOD)["frames"] == N

PAD = 2  # sentinel frames past the capacity the core is told it has


def buf(data):
    return (ctypes.c_uint8 * len(data)).from_buffer_copy(data)


def decode_guarded(data, n, h, w, signal_ids, has_rgb):
    """Decode with a truthful capacity and a poisoned tail; the tail must survive."""
    b, lib = buf(data), cz._load()
    for sid in signal_ids:
        cap = n * h * w
        out = np.full(cap + PAD * h * w, 0xA5A5, dtype=np.uint16)
        rc = lib.dc_decode_signal(b, len(data), sid.encode("utf-8"),
                                  out.ctypes.data_as(u16p), cap)
        assert (out[cap:] == 0xA5A5).all(), \
            f"dc_decode_signal({sid!r}) wrote past its stated capacity of {n} frames (rc={rc})"
    if has_rgb:
        cap = n * h * w * 4
        out = np.full(cap + PAD * h * w * 4, 0x5A, dtype=np.uint8)
        rc = lib.dc_decode_rgb(b, len(data), out.ctypes.data_as(u8p), cap)
        assert (out[cap:] == 0x5A).all(), \
            f"dc_decode_rgb wrote past its stated capacity of {n} frames (rc={rc})"


def try_all(data):
    """Run every read path over `data`. Must return or raise — never crash."""
    try:
        info = cz.probe(data)
    except RuntimeError:
        return
    try:
        cz.parse_metadata(data)
    except RuntimeError:
        pass
    n, h, w = info["frames"], info["height"], info["width"]
    # Nonsense geometry is the core's problem, not this test's: skip the allocation rather
    # than trying to malloc whatever a mutated header happens to claim.
    if not (0 < n <= 4096 and 0 < w <= 4096 and 0 < h <= 4096):
        return
    # signals[] is the file's own JSON, so a mutated entry may be any shape at all.
    ids = [s["id"] for s in info["signals"]
           if isinstance(s, dict) and isinstance(s.get("id"), str)]
    decode_guarded(data, n, h, w, ids, info["has_rgb"])


# ── 1. truncation at every length ──
# Hits a header straddling the end, a size vint that overruns the parent, and SimpleBlocks
# with fewer than the 3 bytes of rel-timecode + flags the reader used to assume were there.
for n in range(len(GOOD) + 1):
    try_all(GOOD[:n])

# ── 2. byte mutations, biased toward vint length descriptors ──
# Those bytes are what drive the length math, so they are where the bounds actually matter.
mrng = np.random.default_rng(1234)
VALUES = np.array([0x00, 0x01, 0x08, 0x0F, 0x7F, 0x80, 0xFE, 0xFF], dtype=np.uint8)
for _ in range(3000):
    b = bytearray(GOOD)
    for off in mrng.integers(0, len(b), mrng.integers(1, 4)):
        b[int(off)] = int(VALUES[mrng.integers(0, len(VALUES))])
    if mrng.integers(0, 4) == 0:
        b = b[: int(mrng.integers(1, len(b) + 1))]
    try_all(bytes(b))

# ── 3. pure garbage that still looks like a Segment ──
for _ in range(2000):
    n = int(mrng.integers(1, 256))
    b = bytearray(mrng.integers(0, 256, n).astype(np.uint8).tobytes())
    if n >= 4:
        b[0:4] = b"\x18\x53\x80\x67"  # Segment id
    try_all(bytes(b))

# ── 4. the happy path still round-trips bit-exact ──
back = cz.decode_signal(GOOD, "depth")
assert back.shape == (N, H, W) and np.array_equal(back, depth), "lossless round-trip broke"

print("all passed")
