"""C ABI robustness tests — drive the native entry points directly through ctypes.

tests/py_api_validation.py covers the Python wrapper's guards; this file bypasses them and
calls dc_* the way any other C consumer would, asserting the ABI itself is total: NULL and
degenerate arguments come back as error codes instead of segfaults, and no C++ exception is
allowed to unwind through extern "C" (which would abort the interpreter).

Run: python tests/py_c_abi.py  (needs the compiled native core, like roundtrip.py)
"""
import unittest

import ctypes
import math
import os
import subprocess
import tempfile
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
import numpy as np

import chromapakz as cz

lib = cz._load()   # the native handle is loaded lazily; _load() also installs the argtypes
u8p, u16p, f32p = cz.u8p, cz.u16p, cz.f32p
fails = []


def check(cond, msg):
    if cond:
        print(f"  ok   {msg}")
    else:
        fails.append(msg)
        print(f"  FAIL {msg}")


def buf(data):
    return (ctypes.c_uint8 * len(data)).from_buffer_copy(data)


# ── a real file to hand the decoders ──
rng = np.random.default_rng(11)
W, H, N = 32, 16, 3
depth = rng.integers(1, 65536, (N, H, W)).astype(np.uint16)
rgba = rng.integers(0, 256, (N, H, W, 4)).astype(np.uint8)
webm = cz.encode({"depth": depth}, specs={"depth": cz.inverse_depth_spec(0.3, 9.0)},
                 rgb=rgba, fps=30)
wb, wlen = buf(webm), len(webm)

print("NULL / empty arguments are rejected, not dereferenced")
iv = ctypes.c_int()
check(lib.dc_probe(None, 0, *(ctypes.byref(iv) for _ in range(3)),
                   None, None, None, None, None) == 1, "dc_probe(NULL) -> 1")
check(lib.dc_probe(wb, 0, None, None, None, None, None, None, None, None) == 1,
      "dc_probe(len=0) -> 1")
check(lib.dc_probe(wb, wlen, None, None, None, None, None, None, None, None) == 0,
      "dc_probe with all-NULL out-params still succeeds")
check(lib.dc_decode_rgb(None, wlen, None, 0) == 1, "dc_decode_rgb(NULL) -> 1")
check(lib.dc_decode_rgb(wb, wlen, None, 0) == 1, "dc_decode_rgb(NULL out) -> 1")
check(lib.dc_decode_signal(wb, wlen, None, None, 0) == 1, "dc_decode_signal(NULL id) -> 1")
check(lib.dc_decode_signal(None, wlen, b"depth", None, 0) == 1, "dc_decode_signal(NULL webm) -> 1")
check(lib.dc_get_metadata(wb, wlen, None, None) == 1, "dc_get_metadata(NULL out) -> 1")
check(lib.dc_get_metadata(None, wlen, None, None) == 1, "dc_get_metadata(NULL webm) -> 1")

print("dc_encode_multi argument validation")
out, out_len = u8p(), ctypes.c_size_t()
spec = cz._SignalSpec()
spec.id, spec.data = b"depth", depth.ctypes.data_as(u16p)
spec.inverse_depth, spec.near_, spec.far_, spec.levels = 1, 0.3, 9.0, cz.LEVELS_FULL
specs1 = (cz._SignalSpec * 1)(spec)


def enc(w=W, h=H, n=N, fps=30, nsig=1, sigs=specs1, o=True):
    return lib.dc_encode_multi(None, 0, sigs, nsig, w, h, n, fps,
                               ctypes.byref(out) if o else None,
                               ctypes.byref(out_len) if o else None)


# fps == 0 previously reached vpx (g_timebase.den = 0) and 1000.0*i/fps -> inf -> UB int cast.
check(enc(fps=0) == 1, "fps=0 -> 1 (not a division by zero in the encoder)")
check(enc(fps=-5) == 1, "fps<0 -> 1")
check(enc(w=0) == 1, "W=0 -> 1")
check(enc(h=-1) == 1, "H<0 -> 1")
check(enc(n=0) == 1, "N=0 -> 1")
check(enc(nsig=1, sigs=None) == 1, "num_signals>0 with NULL array -> 1")
check(enc(nsig=0, sigs=None) == 1, "no signals and no rgb -> 1")
check(enc(o=False) == 1, "NULL out-params -> 1")

nullspec = (cz._SignalSpec * 1)(cz._SignalSpec())
check(enc(sigs=nullspec) == 1, "spec with NULL id/data -> 1")

# Plane geometry is int arithmetic; W*H that wraps used to corrupt every offset derived from it
# (W=H=65536 wraps px to 0, so the encoder read rows out of a zero-length plane -> SIGSEGV).
for label, w, h in [
    ("65536x65536 (W*H wraps to 0)", 65536, 65536),
    ("46341x46341 (W*H just over INT_MAX)", 46341, 46341),
    ("100000x1 (side over the VP9 limit)", 100000, 1),
    ("16384x16385 (just over the pixel cap)", 16384, 16385),
]:
    check(enc(w=w, h=h) == 1, f"{label} -> 1")

print("dc_stream_* argument validation and lifecycle")
cz._load_stream()   # binds the streaming entry points' argtypes
h = ctypes.c_void_p()
cout, clen = u8p(), ctypes.c_size_t()
stream_spec = (cz._SignalSpec * 1)(cz._SignalSpec())
stream_spec[0].id, stream_spec[0].levels = b"depth", cz.LEVELS_FULL


def screate(w=W, h_=H, fps=30, nsig=1, sigs=stream_spec, rgb=0, cues=1, o=True):
    return lib.dc_stream_create(w, h_, fps, 2000, rgb, cues, sigs, nsig,
                                ctypes.byref(h) if o else None)


check(screate(o=False) == 1, "dc_stream_create(NULL out) -> 1")
check(screate(fps=0) == 1, "dc_stream_create(fps=0) -> 1")
check(screate(w=0) == 1, "dc_stream_create(W=0) -> 1")
check(screate(w=65536, h_=65536) == 1, "dc_stream_create with wrapping W*H -> 1")
check(screate(nsig=1, sigs=None) == 1, "dc_stream_create(num_signals>0, NULL array) -> 1")
check(screate(nsig=0, sigs=None) == 1, "dc_stream_create with no signals and no rgb -> 1")
check(screate(nsig=1, sigs=(cz._SignalSpec * 1)(cz._SignalSpec())) == 1,
      "dc_stream_create with a NULL spec id -> 1")

# NULL handles must be refused, not dereferenced — and dc_stream_destroy(NULL) must be a no-op.
check(lib.dc_stream_header(None, ctypes.byref(cout), ctypes.byref(clen)) == 1,
      "dc_stream_header(NULL handle) -> 1")
check(lib.dc_stream_add_frame(None, None, None, ctypes.byref(cout), ctypes.byref(clen)) == 1,
      "dc_stream_add_frame(NULL handle) -> 1")
check(lib.dc_stream_finish(None, ctypes.byref(cout), ctypes.byref(clen)) == 1,
      "dc_stream_finish(NULL handle) -> 1")
lib.dc_stream_destroy(None)
check(True, "dc_stream_destroy(NULL) is a no-op")

check(screate() == 0, "dc_stream_create with usable arguments -> 0")
plane = np.zeros(H * W, dtype=np.uint16)
planes1 = (u16p * 1)(plane.ctypes.data_as(u16p))
nullplanes = (u16p * 1)(u16p())
check(lib.dc_stream_header(h, None, ctypes.byref(clen)) == 1, "dc_stream_header(NULL out) -> 1")
check(lib.dc_stream_add_frame(h, None, None, ctypes.byref(cout), ctypes.byref(clen)) == 1,
      "add_frame with a NULL plane array -> 1")
check(lib.dc_stream_add_frame(h, None, nullplanes, ctypes.byref(cout), ctypes.byref(clen)) == 1,
      "add_frame with a NULL plane pointer -> 1")
# The stream declared no RGB track, so a frame carrying RGB has nowhere to put it.
check(lib.dc_stream_add_frame(h, wb, planes1, ctypes.byref(cout), ctypes.byref(clen)) == 1,
      "add_frame with unexpected rgb -> 1")
check(lib.dc_stream_add_frame(h, None, planes1, ctypes.byref(cout), ctypes.byref(clen)) == 0,
      "add_frame with a valid plane -> 0")
check(lib.dc_stream_finish(h, ctypes.byref(cout), ctypes.byref(clen)) == 0,
      "dc_stream_finish -> 0")
if clen.value:
    lib.dc_free(cout)
check(lib.dc_stream_finish(h, ctypes.byref(cout), ctypes.byref(clen)) == 6,
      "dc_stream_finish twice -> 6")
check(lib.dc_stream_add_frame(h, None, planes1, ctypes.byref(cout), ctypes.byref(clen)) == 6,
      "add_frame after finish -> 6")
lib.dc_stream_destroy(h)
check(True, "dc_stream_destroy on a finished stream does not crash")

print("garbage input returns an error instead of crashing")
mj, mlen = ctypes.c_char_p(), ctypes.c_size_t()
for name, junk, must_fail in [
    ("single zero byte", b"\x00", True),
    ("random bytes", bytes(rng.integers(0, 256, 4096).astype(np.uint8)), True),
    ("EBML header only", webm[:32], True),
    ("truncated real file", webm[: len(webm) // 3], False),
]:
    jb = buf(junk)
    rc_p = lib.dc_probe(jb, len(junk), None, None, None, None, None, None, None, None)
    rc_m = lib.dc_get_metadata(jb, len(junk), ctypes.byref(mj), ctypes.byref(mlen))
    if rc_m == 0:
        lib.dc_free(ctypes.cast(mj, u8p))
    if must_fail:
        check(rc_p != 0 and rc_m != 0, f"{name}: rejected (probe={rc_p}, metadata={rc_m})")
    else:
        check(True, f"{name}: returned cleanly (probe={rc_p}, metadata={rc_m})")

print("dc_decode_signal reports an unknown id rather than reading past the buffer")
sink = np.zeros(N * H * W, dtype=np.uint16)
check(lib.dc_decode_signal(wb, wlen, b"nope", sink.ctypes.data_as(u16p), sink.size) == 8,
      "unknown signal id -> 8")
check(lib.dc_decode_signal(wb, wlen, b"depth", sink.ctypes.data_as(u16p), sink.size) == 0,
      "known signal id -> 0")

print("quant helpers survive degenerate ranges (no divide-by-zero)")
z = np.array([0.5, 1.0, 5.0, 8.0], dtype=np.float32)
q = np.zeros(4, dtype=np.uint16)
f = np.zeros(4, dtype=np.float32)
codes = np.array([1, 100, 5000, 65535], dtype=np.uint16)

for label, near, far, levels in [
    ("near=0", 0.0, 9.0, cz.LEVELS_FULL),
    ("far=0", 0.3, 0.0, cz.LEVELS_FULL),
    ("near==far", 5.0, 5.0, cz.LEVELS_FULL),
    ("negative near", -1.0, 9.0, cz.LEVELS_FULL),
    ("levels=2 (M=0)", 0.3, 9.0, 2),
    ("levels=1", 0.3, 9.0, 1),
]:
    q[:] = 7
    lib.dc_quantize_inverse(z.ctypes.data_as(f32p), 4, near, far, levels, q.ctypes.data_as(u16p))
    check(bool(np.all(q == 0)), f"quantize {label}: all-invalid (0), got {q.tolist()}")
    f[:] = 1.0
    lib.dc_dequantize_inverse(codes.ctypes.data_as(u16p), 4, near, far, levels,
                              f.ctypes.data_as(f32p))
    check(bool(np.all(np.isnan(f))), f"dequantize {label}: all NaN, got {f.tolist()}")

q[:] = 7
lib.dc_quantize_inverse(None, 4, 0.3, 9.0, cz.LEVELS_FULL, q.ctypes.data_as(u16p))
check(bool(np.all(q == 7)), "quantize(NULL in) is a no-op")
lib.dc_quantize_inverse(z.ctypes.data_as(f32p), 0, 0.3, 9.0, cz.LEVELS_FULL, None)
lib.dc_dequantize_inverse(None, 4, 0.3, 9.0, cz.LEVELS_FULL, None)
check(True, "quant helpers with NULL/zero-length args do not crash")

# A usable range must still work exactly as before.
lib.dc_quantize_inverse(z.ctypes.data_as(f32p), 4, 0.3, 9.0, cz.LEVELS_FULL, q.ctypes.data_as(u16p))
lib.dc_dequantize_inverse(q.ctypes.data_as(u16p), 4, 0.3, 9.0, cz.LEVELS_FULL, f.ctypes.data_as(f32p))
check(bool(np.all(np.abs(f - z) < 0.01)) and not any(map(math.isnan, f.tolist())),
      f"usable range still round-trips ({f.tolist()})")

print("Python wrapper rejects fps <= 0 up front")
for bad in (0, -1, 1.5):
    try:
        cz.encode({"depth": depth}, fps=bad)
        check(False, f"cz.encode(fps={bad!r}) should raise ValueError")
    except ValueError:
        check(True, f"cz.encode(fps={bad!r}) -> ValueError")
    except Exception as e:  # noqa: BLE001
        check(False, f"cz.encode(fps={bad!r}) raised {type(e).__name__}")

# ── dccli argument handling (only when a built binary is around) ──
here = os.path.dirname(os.path.abspath(__file__))
cli = next((p for p in (os.path.join(here, "..", "build", "dccli"),
                        os.path.join(here, "..", "bld", "dccli"),
                        os.path.join(here, "..", "native", "dccli"))
            if os.path.exists(p)), None)
if cli:
    print("dccli argument handling")
    # encodergbd reads argv[11]; with exactly 11 args the old guard let it through and passed
    # the terminating NULL to fopen(). Expect a usage error (2), never a signal (negative rc).
    r = subprocess.run([cli, "encodergbd", "a", "b", "1", "1", "1", "30", "0.3", "9", "100"],
                       capture_output=True)
    check(r.returncode == 2, f"encodergbd with 10 args -> usage error 2 (got {r.returncode})")

    # Use a real (empty) regular file: readFile runs before the dimension parse and now rejects
    # anything that is not one, so /dev/null would exit 1 on the input rather than 2 on the args.
    with tempfile.TemporaryDirectory() as td:
        src, dst = os.path.join(td, "in.u16"), os.path.join(td, "out.webm")
        open(src, "wb").close()
        for label, args in [
            ("W=0", [src, "0", "16", "1", "30", "0.3", "9", dst]),
            ("fps=0", [src, "16", "16", "1", "0", "0.3", "9", dst]),
            ("W not a number", [src, "abc", "16", "1", "30", "0.3", "9", dst]),
        ]:
            r = subprocess.run([cli, "encode"] + args, capture_output=True)
            check(r.returncode == 2, f"encode {label} -> usage error 2 (got {r.returncode})")

    # readFile must reject anything that is not a regular file. A directory is the interesting
    # case: it opens fine on Linux and its SEEK_END offset is a huge directory-hash cookie, so
    # sizing a buffer from ftell aborted the process (SIGABRT, rc -6) rather than erroring out.
    # Assert the exact clean-exit code, so a crash (negative rc) can never read as "an error".
    for label, arg in [("directory", here), ("character device", "/dev/zero")]:
        r = subprocess.run([cli, "info", arg], capture_output=True)
        check(r.returncode == 1,
              f"info <{label}> exits cleanly with 1, not a signal (got {r.returncode})")
else:
    print("dccli not built — skipping CLI argument checks")

class CAbi(unittest.TestCase):
    def test_c_abi_is_total(self):
        # The checks above run at import and accumulate into `fails`; this is where they are
        # reported. Asserting through a method call keeps them alive under `python -O`.
        self.assertEqual(fails, [], "\n".join(fails))


if __name__ == "__main__":
    unittest.main()
