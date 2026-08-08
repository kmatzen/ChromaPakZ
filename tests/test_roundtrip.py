"""Smoke/round-trip test for the installed chromapakz package (used by CI and cibuildwheel).

Assertions go through unittest's assert* methods on purpose: bare `assert` statements are
compiled away under `python -O`, which would make the whole suite pass vacuously.
"""
import unittest

import numpy as np

import chromapakz as cz


class RoundTrip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(0)
        cls.depth = rng.integers(5000, 45000, size=(6, 48, 64)).astype(np.uint16)
        cls.rgb = rng.integers(0, 255, size=(6, 48, 64, 4), dtype=np.uint8)
        cls.object_id = rng.integers(1000, 60000, size=(6, 48, 64)).astype(np.uint16)
        cls.depth_spec = cz.inverse_depth_spec(0.3, 9.0, 2048)

    def test_probe_reports_the_encoded_header(self):
        data = cz.encode({"depth": self.depth}, specs={"depth": self.depth_spec}, rgb=self.rgb)
        info = cz.probe(data)
        self.assertTrue(info["has_rgb"])
        self.assertEqual(info["frames"], 6)
        self.assertEqual(info["levels"], 2048)
        self.assertEqual([s["id"] for s in info["signals"]], ["depth"])
        self.assertEqual(info["metadata"]["version"], 3)

    def test_signal_and_rgb_decode(self):
        data = cz.encode({"depth": self.depth}, specs={"depth": self.depth_spec}, rgb=self.rgb)
        self.assertTrue(np.array_equal(cz.decode_signal(data, "depth"), self.depth))
        self.assertEqual(cz.decode_rgb(data).shape, (6, 48, 64, 4))

    def test_signal_only_file_round_trips(self):
        depth_only = cz.encode({"depth": self.depth}, specs={"depth": cz.inverse_depth_spec(0.2, 10.0)})
        self.assertTrue(np.array_equal(cz.decode_signal(depth_only, "depth"), self.depth))

    def test_multi_signal_decode(self):
        multi = cz.encode(
            {"depth": self.depth, "objectId": self.object_id},
            specs={"depth": self.depth_spec},
            rgb=self.rgb,
        )
        decoded = cz.decode(multi)
        self.assertTrue(np.array_equal(decoded["signals"]["depth"], self.depth))
        self.assertTrue(np.array_equal(decoded["signals"]["objectId"], self.object_id))

    def test_quantize_dequantize_round_trip(self):
        z = np.array([0.5, 1.5, 5.0], np.float32)
        back = cz.dequantize_inverse(cz.quantize_inverse(z, 0.3, 9.0, 4096), 0.3, 9.0, 4096)
        self.assertTrue(np.allclose(back, z, rtol=0.02), back)


if __name__ == "__main__":
    unittest.main()
