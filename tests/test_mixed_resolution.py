"""Per-stream resolution (format v4): streams share the frame grid, not the geometry.

The motivating case is a depth map at sensor resolution (e.g. 256x192 LiDAR) riding beside a
full-resolution RGB stream. Coverage here:

  * batch encode/decode with a signal (and an RGB stream) at its own resolution — bit-exact,
    correct output shapes, `"version": 4` with per-entry width/height in the metadata;
  * a file all of whose streams share the file resolution keeps writing `"version": 3`, so
    nothing that existed before v4 changes a byte;
  * the streaming encoder's spec dicts (`width`/`height` on signals, dict entries in `rgbs`);
  * validation: half-declared geometry, wrong-size planes, and frame-count mismatches raise.
"""
import unittest

import numpy as np

import chromapakz as cz

N, H, W = 4, 48, 64      # file (primary) geometry
DH, DW = 24, 32          # the low-res streams


def _rng():
    return np.random.default_rng(42)


class BatchMixedResolution(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = _rng()
        cls.depth = rng.integers(0, 65536, (N, DH, DW)).astype(np.uint16)
        cls.ids = rng.integers(0, 65536, (N, H, W)).astype(np.uint16)
        cls.rgb = rng.integers(0, 256, (N, H, W, 4)).astype(np.uint8)
        cls.cam1 = rng.integers(0, 256, (N, DH, DW, 4)).astype(np.uint8)
        cls.data = cz.encode({"depth": cls.depth, "objectId": cls.ids}, rgb=cls.rgb)

    def test_metadata_is_v4_with_per_signal_dims(self):
        meta = cz.parse_metadata(self.data)
        self.assertEqual(meta["version"], 4)
        self.assertEqual(meta["width"], W)
        self.assertEqual(meta["height"], H)
        by_id = {s["id"]: s for s in meta["signals"]}
        self.assertEqual((by_id["depth"]["width"], by_id["depth"]["height"]), (DW, DH))
        self.assertNotIn("width", by_id["objectId"], "a default-geometry stream carries no keys")

    def test_signals_decode_bit_exact_at_their_own_shapes(self):
        depth = cz.decode_signal(self.data, "depth")
        self.assertEqual(depth.shape, (N, DH, DW))
        self.assertTrue(np.array_equal(depth, self.depth))
        ids = cz.decode_signal(self.data, "objectId")
        self.assertEqual(ids.shape, (N, H, W))
        self.assertTrue(np.array_equal(ids, self.ids))

    def test_decode_returns_per_stream_shapes(self):
        out = cz.decode(self.data)
        self.assertEqual(out["signals"]["depth"].shape, (N, DH, DW))
        self.assertEqual(out["signals"]["objectId"].shape, (N, H, W))
        self.assertEqual(out["rgb"].shape, (N, H, W, 4))
        self.assertEqual((out["width"], out["height"]), (W, H))

    def test_probe_reports_file_dims_and_per_stream_dims(self):
        info = cz.probe(self.data)
        self.assertEqual((info["width"], info["height"]), (W, H))
        by_id = {s["id"]: s for s in info["signals"]}
        self.assertEqual((by_id["depth"]["width"], by_id["depth"]["height"]), (DW, DH))

    def test_rgb_streams_at_their_own_resolution(self):
        data = cz.encode({"depth": self.depth}, rgbs={"cam0": self.rgb, "cam1": self.cam1})
        meta = cz.parse_metadata(data)
        self.assertEqual(meta["version"], 4)
        by_id = {r["id"]: r for r in meta["rgbs"]}
        self.assertNotIn("width", by_id["cam0"], "the primary is the file geometry")
        self.assertEqual((by_id["cam1"]["width"], by_id["cam1"]["height"]), (DW, DH))
        self.assertEqual(cz.decode_rgb(data).shape, (N, H, W, 4))
        self.assertEqual(cz.decode_rgb(data, stream="cam1").shape, (N, DH, DW, 4))

    def test_uniform_file_stays_v3(self):
        data = cz.encode({"objectId": self.ids}, rgb=self.rgb)
        self.assertEqual(cz.parse_metadata(data)["version"], 3)
        for s in cz.parse_metadata(data)["signals"]:
            self.assertNotIn("width", s)

    def test_signal_only_file_takes_first_signals_geometry(self):
        data = cz.encode({"depth": self.depth, "objectId": self.ids})
        info = cz.probe(data)
        self.assertEqual((info["width"], info["height"]), (DW, DH))
        self.assertTrue(np.array_equal(cz.decode_signal(data, "objectId"), self.ids))

    def test_frame_count_mismatch_still_raises(self):
        with self.assertRaises(ValueError):
            cz.encode({"depth": self.depth[:-1], "objectId": self.ids})
        with self.assertRaises(ValueError):
            cz.encode({"depth": self.depth}, rgb=self.rgb[:-1])


class StreamingMixedResolution(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = _rng()
        cls.depth = rng.integers(0, 65536, (N, DH, DW)).astype(np.uint16)
        cls.rgb = rng.integers(0, 256, (N, H, W, 4)).astype(np.uint8)
        cls.cam1 = rng.integers(0, 256, (N, DH, DW, 4)).astype(np.uint8)

    def _take(self, enc, frames):
        chunks = [enc.header]
        for kwargs in frames:
            chunks.append(enc.add_frame(**kwargs))
        chunks.append(enc.finish())
        enc.close()
        return b"".join(chunks)

    def test_low_res_signal_roundtrip(self):
        enc = cz.create_encoder(W, H, has_rgb=True,
                                signals=[{"id": "depth", "width": DW, "height": DH}])
        data = self._take(enc, [dict(rgb=self.rgb[i], signals={"depth": self.depth[i]})
                                for i in range(N)])
        self.assertEqual(cz.parse_metadata(data)["version"], 4)
        back = cz.decode_signal(data, "depth")
        self.assertEqual(back.shape, (N, DH, DW))
        self.assertTrue(np.array_equal(back, self.depth))

    def test_low_res_rgb_stream_roundtrip(self):
        enc = cz.create_encoder(W, H, signals=[{"id": "depth", "width": DW, "height": DH}],
                                rgbs=["cam0", {"id": "cam1", "width": DW, "height": DH}])
        data = self._take(enc, [dict(rgbs={"cam0": self.rgb[i], "cam1": self.cam1[i]},
                                     signals={"depth": self.depth[i]}) for i in range(N)])
        self.assertEqual(cz.decode_rgb(data, stream="cam1").shape, (N, DH, DW, 4))
        self.assertTrue(np.array_equal(cz.decode_signal(data, "depth"), self.depth))

    def test_wrong_size_plane_names_the_stream_geometry(self):
        enc = cz.create_encoder(W, H, signals=[{"id": "depth", "width": DW, "height": DH}])
        with self.assertRaises(ValueError) as ctx:
            enc.add_frame(signals={"depth": np.zeros((H, W), np.uint16)})
        self.assertIn(str((DH, DW)), str(ctx.exception))
        enc.close()

    def test_declaring_the_default_geometry_stays_v3(self):
        enc = cz.create_encoder(W, H, has_rgb=True,
                                signals=[{"id": "objectId", "width": W, "height": H}])
        data = self._take(enc, [dict(rgb=self.rgb[i],
                                     signals={"objectId": np.zeros((H, W), np.uint16)})
                                for i in range(N)])
        self.assertEqual(cz.parse_metadata(data)["version"], 3)

    def test_half_declared_geometry_is_rejected(self):
        with self.assertRaises(ValueError):
            cz.create_encoder(W, H, signals=[{"id": "depth", "width": DW}])
        with self.assertRaises(ValueError):
            cz.create_encoder(W, H, signals=[{"id": "d"}],
                              rgbs=[{"id": "cam0", "height": DH}])


if __name__ == "__main__":
    unittest.main()
