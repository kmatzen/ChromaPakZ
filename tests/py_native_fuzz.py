"""Systematic fuzz sweep over the native decode path.

tests/py_decode_bounds.py covers the crafted-metadata cases and tests/py_c_abi.py a handful of
hand-picked malformed inputs; tests/js_webm_fuzz.mjs sweeps every prefix of a file but through
the *JS* demuxer. Nothing sweeps the **native** parser, which is the one written in C++ against
attacker-controlled bytes, where a mistake is a crash or an out-of-bounds write rather than an
exception. This drives every dc_* entry point over hundreds of truncations and single-bit
mutations of a real file.

The asserted contract is deliberately weak — return, or raise a Python exception — because that
is the whole requirement: no segfault, no hang, no silent overflow. Run it against an
AddressSanitizer build of _core for the stronger version.

Run: python tests/py_native_fuzz.py  (needs the compiled native core, like roundtrip.py)
"""
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
import numpy as np

import chromapakz as cz

TRUNCATIONS, BITFLIPS = 400, 400

W, H, N = 8, 8, 4
rng = np.random.default_rng(7)
depth = rng.integers(0, 65535, (N, H, W)).astype(np.uint16)
good = cz.encode({"depth": depth}, specs={"depth": cz.inverse_depth_spec(0.2, 10.0)}, fps=30)

if not np.array_equal(cz.decode_signal(good, "depth"), depth):
    raise AssertionError("baseline round-trip is not bit-exact — fix that before reading further")


def exercise(data):
    """Drive every native entry point over `data`. Only a crash can fail this."""
    for fn in (lambda: cz.parse_metadata(data),
               lambda: cz.probe(data),
               lambda: cz.decode_signal(data, "depth"),
               lambda: cz.decode_rgb(data)):
        try:
            fn()
        except Exception:      # noqa: BLE001 — any *reported* failure is acceptable here
            pass


# ── truncation: a prefix of a real file, at ~400 offsets plus the one-byte-short case ──
step = max(1, len(good) // TRUNCATIONS)
cuts = list(range(0, len(good), step)) + [len(good) - 1]
for cut in cuts:
    exercise(good[:cut])

# ── single-bit mutations anywhere in the file (deterministic seed, so failures reproduce) ──
rnd = random.Random(11)
for _ in range(BITFLIPS):
    i = rnd.randrange(len(good))
    mutated = bytearray(good)
    mutated[i] ^= 1 << rnd.randrange(8)
    exercise(bytes(mutated))

# ── input that is not EBML at all, and an EBML ID leading nowhere ──
for junk in (b"", b"\x00" * 64, bytes(range(256)), b"\xff" * 128, b"\x1a\x45\xdf\xa3" + b"\x00" * 32):
    exercise(junk)

# The honest file must still decode after all of that (no global state was corrupted).
if not np.array_equal(cz.decode_signal(good, "depth"), depth):
    raise AssertionError("the valid file stopped decoding after the fuzz sweep")

print(f"native fuzz OK — {len(cuts)} truncations + {BITFLIPS} bit flips, no crash, "
      "and the valid file still round-trips bit-exactly")
