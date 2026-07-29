"""Replay the cross-language quantizer golden vectors against the native implementation.

tests/fixtures/quant_golden.csv is generated from the JS quantizer and replayed here (through
ctypes into dc_quantize_inverse) and by `dccli goldencheck` in C++. Bit-exact agreement between
the three is the core product claim; before this, nothing pinned it. The interesting cases are
the half-step rounding boundaries, where JS Math.round (half up) and C++ lround (half away from
zero) are not the same function.

Regenerate the file with:  node tests/fixtures/regen_quant_golden.mjs
"""
import math
import os
import struct
import unittest

import numpy as np

import chromapakz as cz

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "quant_golden.csv")


def _decode_float(tok):
    """'nan' | 'inf' | '-inf' | '0xXXXXXXXX' -> the exact float32 value."""
    if tok == "nan":
        return math.nan
    if tok == "inf":
        return math.inf
    if tok == "-inf":
        return -math.inf
    return struct.unpack("<f", struct.pack("<I", int(tok, 16)))[0]


def _load(path):
    cases = []
    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("near,"):
                continue
            near, far, levels, z, code, back = line.split(",")
            cases.append((float(near), float(far), int(levels),
                          _decode_float(z), int(code), _decode_float(back)))
    return cases


CASES = _load(GOLDEN)


class QuantGoldenVectors(unittest.TestCase):
    def test_golden_file_is_non_trivial(self):
        self.assertGreaterEqual(len(CASES), 100)
        self.assertTrue(any(c[4] == 0 for c in CASES), "no invalid-input case")
        self.assertTrue(any(c[4] > 0 for c in CASES), "no valid-depth case")

    def test_quantize_reproduces_every_golden_code(self):
        for near, far, levels, z, code, _ in CASES:
            got = int(cz.quantize_inverse(np.array([z], np.float32), near, far, levels)[0])
            self.assertEqual(got, code,
                             f"near={near} far={far} levels={levels} z={z!r}: {got} != {code}")

    def test_dequantize_reproduces_every_golden_depth(self):
        for near, far, levels, z, code, back in CASES:
            got = float(cz.dequantize_inverse(np.array([code], np.uint16), near, far, levels)[0])
            label = f"near={near} far={far} levels={levels} code={code}"
            if math.isnan(back):
                self.assertTrue(math.isnan(got), f"{label}: expected NaN, got {got!r}")
            else:
                # Both sides are float32, so this is an exact comparison, not an approximate one.
                self.assertEqual(got, back, f"{label}: {got!r} != {back!r}")


if __name__ == "__main__":
    unittest.main()
