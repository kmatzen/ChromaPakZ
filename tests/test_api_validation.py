"""Python API tests: input validation, error paths, and reduced-levels round-trips.

Complements tests/test_roundtrip.py (happy path) with the contract edges: bad specs must raise
ValueError before touching native code, garbage bytes must raise RuntimeError (never crash),
and quantization/round-trip must hold at non-default levels and for non-contiguous inputs.
"""
import unittest

import numpy as np

import chromapakz as cz

W, H, N = 40, 24, 3


class SpecValidation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(7)
        cls.depth = rng.integers(1, 65536, (N, H, W)).astype(np.uint16)
        cls.ids = rng.integers(0, 65536, (N, H, W)).astype(np.uint16)

    def test_encode_rejects_bad_signal_shapes(self):
        with self.assertRaises(ValueError, msg="no signals and no rgb"):
            cz.encode({})
        with self.assertRaises(ValueError, msg="2-D signal"):
            cz.encode({"d": self.depth[0]})
        # Differing H/W is per-stream resolution (format v4), no longer an error — but the
        # frame grid is still shared, so a differing N must raise.
        with self.assertRaises(ValueError, msg="frame count mismatch"):
            cz.encode({"a": self.depth, "b": self.ids[:-1]})

    def test_encode_rejects_bad_quant_specs(self):
        with self.assertRaises(ValueError, msg="inverse_depth without near/far"):
            cz.encode({"d": self.depth}, specs={"d": {"inverse_depth": True}})
        with self.assertRaises(ValueError, msg="far <= near"):
            cz.encode({"d": self.depth}, specs={"d": {"inverse_depth": True, "near": 2, "far": 1}})

    def test_inverse_depth_spec_guards(self):
        for args, kwargs, label in (
            ((0, 5), {}, "near=0"),
            ((-1, 5), {}, "near<0"),
            ((0.5, 0.5), {}, "far==near"),
            ((0.5, 9), {"levels": 2}, "levels<3"),
        ):
            with self.subTest(case=label), self.assertRaises(ValueError):
                cz.inverse_depth_spec(*args, **kwargs)

    def test_quantizer_range_guards(self):
        with self.assertRaises(ValueError, msg="quantize bad range"):
            cz.quantize_inverse(np.zeros(4, np.float32), 1, 0.5)
        with self.assertRaises(ValueError, msg="dequantize bad near"):
            cz.dequantize_inverse(np.zeros(4, np.uint16), 0, 5)

    def test_rgb_shape_validation(self):
        with self.assertRaises(ValueError, msg="RGB (not RGBA)"):
            cz.encode({"d": self.depth}, rgb=np.zeros((N, H, W, 3), np.uint8))
        with self.assertRaises(ValueError, msg="rgb/signal frame count mismatch"):
            cz.encode({"d": self.depth}, rgb=np.zeros((N + 1, H, W, 4), np.uint8))

    def test_levels_beyond_uint16_are_rejected(self):
        """A levels count past 65536 must fail, not wrap codes mod 65536."""
        for bad in (cz.LEVELS_FULL + 1, 1 << 18, 1 << 32):
            with self.subTest(levels=bad):
                with self.assertRaises(ValueError, msg="spec"):
                    cz.inverse_depth_spec(0.2, 10.0, bad)
                with self.assertRaises(ValueError, msg="quantize"):
                    cz.quantize_inverse(np.full(4, 1.0, np.float32), 0.2, 10.0, bad)
                with self.assertRaises(ValueError, msg="dequantize"):
                    cz.dequantize_inverse(np.zeros(4, np.uint16), 0.2, 10.0, bad)
                with self.assertRaises(ValueError, msg="encode spec"):
                    cz.encode({"d": self.depth},
                              specs={"d": {"inverse_depth": True, "near": 0.2, "far": 10.0, "levels": bad}})
        with self.assertRaises(ValueError, msg="non-int levels"):
            cz.inverse_depth_spec(0.2, 10.0, 4096.0)
        self.assertEqual(cz.inverse_depth_spec(0.2, 10.0, cz.LEVELS_FULL)["levels"], cz.LEVELS_FULL)

    def test_lossy_signal_casts_are_rejected(self):
        """Never silently wrap a value into uint16 — the guard is about loss, not dtype pedantry."""
        with self.assertRaises(ValueError, msg="float signal"):
            cz.encode({"d": np.full((N, H, W), 3.7, np.float32)})
        with self.assertRaises(ValueError, msg="float64 signal"):
            cz.encode({"d": self.depth.astype(np.float64)})
        with self.assertRaises(ValueError, msg="signal above 65535"):
            cz.encode({"d": self.depth.astype(np.int64) + 65536})
        with self.assertRaises(ValueError, msg="negative signal"):
            cz.encode({"d": self.depth.astype(np.int32) * -1 - 1})
        with self.assertRaises(ValueError, msg="float codes to dequantize"):
            cz.dequantize_inverse(np.array([-5.0, 3.0]), 0.2, 10.0)
        # in-range wide ints are fine
        wide = self.depth.astype(np.int64)
        self.assertTrue(np.array_equal(cz.decode_signal(cz.encode({"d": wide}), "d"), self.depth))

    def test_rgb_dtype_validation(self):
        with self.assertRaises(ValueError, msg="float rgb"):
            cz.encode({"d": self.depth}, rgb=np.full((N, H, W, 4), 0.5, np.float32))
        with self.assertRaises(ValueError, msg="rgb above 255"):
            cz.encode({"d": self.depth}, rgb=np.full((N, H, W, 4), 300, np.int32))

    def test_rgb_only_encode_validates_shape_before_unpacking(self):
        with self.assertRaises(ValueError, msg="rgb list"):
            cz.encode(rgb=[[0, 0, 0, 255]])
        with self.assertRaises(ValueError, msg="2-D rgb"):
            cz.encode(rgb=np.zeros((H, W), np.uint8))
        rgb_only = cz.encode(rgb=np.zeros((N, H, W, 4), np.uint8))
        info = cz.probe(rgb_only)
        self.assertTrue(info["has_rgb"])
        self.assertEqual(info["frames"], N)

    def test_garbage_bytes_raise_rather_than_crash(self):
        for blob in (b"", b"\x00" * 64, bytes(range(256)) * 4):
            with self.subTest(length=len(blob)):
                with self.assertRaises(RuntimeError):
                    cz.parse_metadata(blob)
                with self.assertRaises(RuntimeError):
                    cz.probe(blob)


class MultiSignalContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(7)
        cls.depth = rng.integers(1, 65536, (N, H, W)).astype(np.uint16)
        cls.ids = rng.integers(0, 65536, (N, H, W)).astype(np.uint16)
        cls.data = cz.encode({"depth": cls.depth, "objectId": cls.ids},
                             specs={"depth": cz.inverse_depth_spec(0.4, 6.0, levels=4096)})

    def test_metadata_lists_both_signals_on_distinct_tracks(self):
        meta = cz.parse_metadata(self.data)
        self.assertEqual(meta.get("version"), 3)
        by_id = {s["id"]: s for s in meta["signals"]}
        self.assertEqual(set(by_id), {"depth", "objectId"})
        self.assertNotEqual(by_id["depth"]["tracks"]["hi"], by_id["objectId"]["tracks"]["hi"])

    def test_probe_reports_dims_and_quant(self):
        info = cz.probe(self.data)
        self.assertEqual((info["width"], info["height"], info["frames"]), (W, H, N))
        self.assertEqual(info["levels"], 4096)
        self.assertAlmostEqual(info["near"], 0.4)
        self.assertAlmostEqual(info["far"], 6.0)

    def test_each_signal_decodes_bit_exactly(self):
        out = cz.decode(self.data)
        self.assertTrue(np.array_equal(out["signals"]["depth"], self.depth))
        self.assertTrue(np.array_equal(out["signals"]["objectId"], self.ids))

    def test_subset_decode_returns_only_what_was_asked_for(self):
        sub = cz.decode(self.data, signal_ids=["objectId"])
        self.assertEqual(set(sub["signals"]), {"objectId"})

    def test_unknown_signal_and_missing_rgb_are_errors(self):
        with self.assertRaises(RuntimeError, msg="unknown signal id"):
            cz.decode_signal(self.data, "nope")
        with self.assertRaises(RuntimeError, msg="decode_rgb without RGB track"):
            cz.decode_rgb(self.data)

    def test_non_contiguous_input_is_handled(self):
        rng = np.random.default_rng(11)
        strided = np.ascontiguousarray(rng.integers(0, 65536, (N, H, W * 2)).astype(np.uint16))[:, :, ::2]
        self.assertFalse(strided.flags["C_CONTIGUOUS"])
        data = cz.encode({"s": strided})
        self.assertTrue(np.array_equal(cz.decode_signal(data, "s"), strided))


class QuantizerInvariants(unittest.TestCase):
    def test_invariants_hold_at_every_level_count(self):
        near, far = 0.5, 8.0
        for levels in (16, 1024, cz.LEVELS_FULL):
            with self.subTest(levels=levels):
                z = np.linspace(near, far, 300, dtype=np.float32)
                z_bad = np.array([0.0, -1.0, np.nan], dtype=np.float32)
                q = cz.quantize_inverse(np.concatenate([z, z_bad]), near, far, levels)
                self.assertEqual(q[-3:].tolist(), [0, 0, 0], "invalid depths -> code 0")

                codes = q[:-3].astype(np.int64)
                self.assertGreaterEqual(codes.min(), 1)
                self.assertLessEqual(codes.max(), levels - 1)
                self.assertTrue((np.diff(codes) <= 0).all(), "monotone in depth")

                back = cz.dequantize_inverse(q, near, far, levels)
                self.assertTrue(np.isnan(back[-3:]).all(), "code 0 -> NaN")
                step = (1 / near - 1 / far) / (levels - 2)
                err = np.abs(1 / back[:-3] - 1 / z)
                self.assertLessEqual(err.max(), step * 0.51)

    def test_reduced_levels_survive_the_container_round_trip(self):
        rng = np.random.default_rng(13)
        zf = (0.5 + 7.5 * rng.random((N, H, W))).astype(np.float32)
        codes = cz.quantize_inverse(zf, 0.5, 8.0, 1024)
        data = cz.encode({"depth": codes}, specs={"depth": cz.inverse_depth_spec(0.5, 8.0, 1024)})
        self.assertTrue(np.array_equal(cz.decode_signal(data, "depth"), codes))
        self.assertEqual(cz.probe(data)["levels"], 1024, "levels stored in metadata")


if __name__ == "__main__":
    unittest.main()
