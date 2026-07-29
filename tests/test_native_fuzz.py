"""Systematic fuzz sweep over the native decode path.

tests/test_decode_bounds.py covers the crafted-metadata cases and tests/test_c_abi.py a handful of
hand-picked malformed inputs; tests/js_webm_fuzz.test.mjs sweeps every prefix of a file but through
the *JS* demuxer. This sweeps the **native** parser, which is the one written in C++ against
attacker-controlled bytes, where a mistake is a crash or an out-of-bounds write rather than an
exception. It drives every dc_* entry point over truncations and single-bit mutations of a real
file, plus the committed streaming fixture.

The asserted contract is deliberately weak — return, or raise a Python exception — because that
is the whole requirement: no segfault, no hang, no silent overflow. Run it against an
AddressSanitizer build of _core for the stronger version.

The sweeps run in a *subprocess*: a native crash would otherwise take the whole test runner down
with it, reporting nothing useful. Here it surfaces as a failed assertion carrying the child's
exit status (-6 for SIGABRT, -11 for SIGSEGV), and the timeout is the hang detector. That is not
hypothetical — an earlier revision aborted the interpreter (std::length_error) inside dc_probe()
on a file truncated to 108 bytes.

Run a sweep directly with:  python tests/test_native_fuzz.py truncate
"""
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_PYTHON = os.path.join(HERE, "..", "python")
FIXTURE = os.path.join(HERE, "fixtures", "stream.webm")

BITFLIPS = 400
# Bit-flipping the whole fixture would be ~30k parses for little extra signal over the header,
# where the size vints that steer every extent live. The bound is deliberate, not incidental.
FIXTURE_FLIP_LIMIT = 512
TIMEOUT_S = 600


def _setup():
    sys.path.insert(0, REPO_PYTHON)
    import numpy as np
    import chromapakz as cz

    W, H, N = 8, 8, 4
    rng = np.random.default_rng(7)
    depth = rng.integers(0, 65535, (N, H, W)).astype(np.uint16)
    good = cz.encode({"depth": depth}, specs={"depth": cz.inverse_depth_spec(0.2, 10.0)}, fps=30)
    if not np.array_equal(cz.decode_signal(good, "depth"), depth):
        raise AssertionError("baseline round-trip is not bit-exact — fix that before reading further")
    return cz, np, depth, good


def _exercise(cz, data):
    """Drive every native entry point over `data`. Only a crash can fail this."""
    for fn in (lambda: cz.parse_metadata(data),
               lambda: cz.probe(data),
               lambda: cz.decode_signal(data, "depth"),
               lambda: cz.decode_rgb(data)):
        try:
            fn()
        except Exception:      # noqa: BLE001 — any *reported* failure is acceptable here
            pass


def _sweep(mode):
    import random
    cz, np, depth, good = _setup()

    if mode == "truncate":
        # Every offset, not a sample: the interesting prefixes are the ones that cut a vint in half.
        for cut in range(len(good) + 1):
            _exercise(cz, good[:cut])
        with open(FIXTURE, "rb") as f:
            fixture = f.read()
        for cut in range(len(fixture) + 1):
            _exercise(cz, fixture[:cut])

    elif mode == "flip":
        rnd = random.Random(11)                       # deterministic, so failures reproduce
        for _ in range(BITFLIPS):
            i = rnd.randrange(len(good))
            mutated = bytearray(good)
            mutated[i] ^= 1 << rnd.randrange(8)
            _exercise(cz, bytes(mutated))
        # exhaustive over the fixture's header, where a bad size vint does the most damage
        with open(FIXTURE, "rb") as f:
            fixture = bytearray(f.read())
        for i in range(min(FIXTURE_FLIP_LIMIT, len(fixture))):
            for bit in range(8):
                mutated = bytearray(fixture)
                mutated[i] ^= 1 << bit
                _exercise(cz, bytes(mutated))

    elif mode == "garbage":
        for junk in (b"", b"\x00" * 64, bytes(range(256)), b"\xff" * 128,
                     b"\x1a\x45\xdf\xa3" + b"\x00" * 32,
                     # a valid EBML header, then a Segment claiming 2^56 bytes
                     b"\x1a\x45\xdf\xa3\x80\x18\x53\x80\x67\x01\xff\xff\xff\xff\xff\xff\xfe"):
            _exercise(cz, junk)
    else:
        raise SystemExit(f"unknown sweep {mode!r}")

    # The honest file must still decode after all of that (no global state was corrupted).
    if not np.array_equal(cz.decode_signal(good, "depth"), depth):
        raise AssertionError("the valid file stopped decoding after the fuzz sweep")
    print("SWEEP OK")


class NativeDemuxerFuzz(unittest.TestCase):
    def _run_sweep(self, mode):
        proc = subprocess.run([sys.executable, os.path.abspath(__file__), mode],
                              capture_output=True, text=True, timeout=TIMEOUT_S)
        self.assertEqual(
            proc.returncode, 0,
            f"native parser died on the {mode} sweep (exit {proc.returncode}); "
            f"stderr tail: {proc.stderr[-500:]}")
        self.assertIn("SWEEP OK", proc.stdout)

    def test_truncation_at_every_byte_offset(self):
        self._run_sweep("truncate")

    def test_single_bit_flips(self):
        self._run_sweep("flip")

    def test_structured_garbage(self):
        self._run_sweep("garbage")


if __name__ == "__main__":
    _sweep(sys.argv[1] if len(sys.argv) > 1 else "truncate")
