"""Metadata and multi-signal contract checks (native Python)."""
import unittest

import numpy as np

import chromapakz as cz


class CrossInterop(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(2)
        N, H, W = 4, 32, 40
        cls.depth = rng.integers(1000, 60000, size=(N, H, W), dtype=np.uint16)
        cls.object_id = rng.integers(1, 50000, size=(N, H, W), dtype=np.uint16)
        cls.data = cz.encode({"depth": cls.depth, "objectId": cls.object_id},
                             specs={"depth": cz.inverse_depth_spec(0.25, 8.0, 4096)})

    def test_metadata_is_v2_signals_only(self):
        meta = cz.parse_metadata(self.data)
        self.assertEqual(meta["version"], 3)
        self.assertEqual({s["id"] for s in meta["signals"]}, {"depth", "objectId"})
        self.assertNotIn("depth", meta, "v1 top-level depth key must be gone")

    def test_probe_reports_the_quant_range(self):
        probe = cz.probe(self.data)
        self.assertEqual((probe["near"], probe["far"], probe["levels"]), (0.25, 8.0, 4096))

    def test_every_signal_decodes_bit_exactly(self):
        decoded = cz.decode(self.data)
        self.assertTrue(np.array_equal(decoded["signals"]["depth"], self.depth))
        self.assertTrue(np.array_equal(decoded["signals"]["objectId"], self.object_id))

    def test_single_signal_file(self):
        solo = cz.encode({"depth": self.depth}, specs={"depth": cz.inverse_depth_spec(0.2, 10.0)})
        self.assertEqual(len(cz.parse_metadata(solo)["signals"]), 1)
        self.assertTrue(np.array_equal(cz.decode_signal(solo, "depth"), self.depth))


if __name__ == "__main__":
    unittest.main()
