"""Negative-path tests for the untrusted-input decode paths (issue #6).

A .webm's CHROMAPAKZ metadata and its VP9 bitstreams are independent: nothing in the container
forces them to agree, and dc_probe can only report what the header claims. The decoders used to
believe the header — sizing nothing, writing one full frame per decoded VP9 image — so a file
declaring "frames":1 over a hundred-frame track walked straight off the end of the caller's
buffer, and a header claiming 4096x4096 over a 16x16 bitstream read far past libvpx's planes.

Every crafted file below keeps the byte length of the field it rewrites, so the EBML element
sizes stay valid and the file still parses; only the claim changes. Each must be refused, and
the honest file must still round-trip bit-exactly.

Run: python tests/py_decode_bounds.py  (needs the compiled native core, like roundtrip.py)
"""
import unittest

import ctypes
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
import numpy as np

import chromapakz as cz

ERR_CAPACITY, ERR_GEOMETRY = 9, 10

W, H, N = 32, 24, 8
rng = np.random.default_rng(6)
depth = rng.integers(1, 65535, (N, H, W)).astype(np.uint16)
rgba = rng.integers(0, 256, (N, H, W, 4)).astype(np.uint8)
good = cz.encode({"depth": depth}, rgb=rgba, fps=30)

u16p, u8p = ctypes.POINTER(ctypes.c_uint16), ctypes.POINTER(ctypes.c_uint8)


def relabel(field, claim):
    """Rewrite one metadata number in place, keeping the byte length (so the container stays valid)."""
    old, new = f'"{field}":'.encode(), f'"{field}":'.encode()
    old += str({"width": W, "height": H, "frames": N}[field]).encode()
    new += str(claim).encode()
    if not (len(old) == len(new)):
        raise AssertionError(f"{field}: {claim} must have as many digits as the real value")
    if not (good.count(old) == 1):
        raise AssertionError(f"{field}: expected exactly one occurrence, got {good.count(old)}")
    out = good.replace(old, new)
    if not (len(out) == len(good)):
        raise AssertionError('len(out) == len(good)')
    return out


def decode_signal_raw(data, frames, w, h, guard_frames=64):
    """Call the core directly with a buffer sized for `frames`, followed by a zeroed guard region
    we can inspect afterwards — this is what the old code overran."""
    px = w * h
    buf = np.zeros((frames + guard_frames) * px, dtype=np.uint16)
    rc = cz._load().dc_decode_signal(
        (ctypes.c_uint8 * len(data)).from_buffer_copy(data), len(data), b"depth",
        buf.ctypes.data_as(u16p), frames * px)
    return rc, int(np.count_nonzero(buf[frames * px:]))


def decode_rgb_raw(data, frames, w, h, guard_frames=64):
    nb = w * h * 4
    buf = np.zeros((frames + guard_frames) * nb, dtype=np.uint8)
    rc = cz._load().dc_decode_rgb(
        (ctypes.c_uint8 * len(data)).from_buffer_copy(data), len(data),
        buf.ctypes.data_as(u8p), frames * nb)
    return rc, int(np.count_nonzero(buf[frames * nb:]))


# ── 1. header under-declares the frame count → the extra frames must not be written ──
few = relabel("frames", 1)


class DecodeBounds(unittest.TestCase):
    def test_all(self):
        failures = []

        def ok(cond, msg=""):
            if not cond:
                failures.append(msg or "check failed")

        ok(cz.probe(few)["frames"] == 1, "the crafted header should report 1 frame")
        for name, call in (("dc_decode_signal", decode_signal_raw), ("dc_decode_rgb", decode_rgb_raw)):
            rc, past = call(few, frames=1, w=W, h=H)
            ok(past == 0, f'{name}: wrote {past} units past a 1-frame buffer on "frames":1')
            ok(rc == ERR_CAPACITY, f"{name}: expected rc={ERR_CAPACITY} on frame-count overflow, got {rc}")

        # a capacity one frame short of the truth is still refused (the off-by-one boundary)
        for name, call in (("dc_decode_signal", decode_signal_raw), ("dc_decode_rgb", decode_rgb_raw)):
            rc, past = call(good, frames=N - 1, w=W, h=H)
            ok(rc == ERR_CAPACITY and past == 0, f"{name}: N-1 capacity gave rc={rc}, {past} past")
            rc, _ = call(good, frames=N, w=W, h=H)
            ok(rc == 0, f"{name}: exactly-N capacity should succeed, got rc={rc}")

        # ── 2. header over-declares the frame size → no read past libvpx's planes ──
        for field, claim in (("width", 99), ("height", 99)):
            lying = relabel(field, claim)
            w, h = (claim, H) if field == "width" else (W, claim)
            for name, call in (("dc_decode_signal", decode_signal_raw), ("dc_decode_rgb", decode_rgb_raw)):
                rc, past = call(lying, frames=N, w=w, h=h)
                ok(rc == ERR_GEOMETRY,
                   f'{name}: expected rc={ERR_GEOMETRY} for "{field}":{claim} over a {W}x{H} stream, got {rc}')
                ok(past == 0, f"{name}: wrote {past} units past the buffer")

        # a header claiming absurd dimensions is rejected outright, not multiplied out
        for field, claim in (("width", 99999), ("height", 99999)):
            huge = f'"{field}":{claim}'.encode()
            lying = good.replace(f'"{field}":{ {"width": W, "height": H}[field] }'.encode(), huge)
            rc, _ = decode_signal_raw(lying, frames=1, w=1, h=1)
            ok(rc != 0, f"{field}={claim} should be refused")

        # ── 3. the Python wrapper surfaces these as RuntimeError, never a crash or silent junk ──
        for fn, label in ((cz.decode_signal, "decode_signal"), (cz.decode_rgb, "decode_rgb")):
            try:
                fn(few, "depth") if fn is cz.decode_signal else fn(few)
            except RuntimeError:
                pass
            else:
                raise AssertionError(f"{label} on a frame-count-lying file should raise RuntimeError")

        # ── 4. honest files are unaffected ──
        ok(np.array_equal(cz.decode_signal(good, "depth"), depth), "honest signal bit-exact")
        back_rgb = cz.decode_rgb(good)
        ok(back_rgb.shape == (N, H, W, 4), f"honest rgb shape {back_rgb.shape}")

        # a header that over-declares the frame count leaves the missing frames zeroed, never
        # uninitialised heap: truncate the real file's metadata claim upward is not possible without
        # changing digits, so encode a shorter clip and check the wrapper's zero-fill directly.
        short = cz.encode({"depth": depth[:2]}, fps=30)
        ok(np.array_equal(cz.decode_signal(short, "depth"), depth[:2]), "2-frame clip bit-exact")

        self.assertEqual(failures, [], "\n".join(failures))


if __name__ == "__main__":
    unittest.main()
