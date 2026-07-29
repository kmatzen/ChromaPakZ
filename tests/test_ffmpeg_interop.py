"""Regression test: a conformant external decoder (ffmpeg) must reproduce ChromaPakZ depth bit-exactly.

Guards the color-range contract — the depth stream must signal full range so ffmpeg returns the luma
unscaled. Skipped when ffmpeg/ffprobe are not on PATH (e.g. the cibuildwheel test environment).
"""
import shutil
import subprocess
import tempfile
import unittest

import numpy as np

import chromapakz as cz

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
N, H, W = 6, 48, 64


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class FfmpegInterop(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(1)
        # depth signal -> tracks 2,3 (no RGB), which ffmpeg sees as streams 0,1
        cls.depth = rng.integers(5000, 45000, size=(N, H, W)).astype(np.uint16)
        cls.data = cz.encode({"depth": cls.depth}, specs={"depth": cz.inverse_depth_spec(0.2, 10.0)})
        cls._tmp = tempfile.TemporaryDirectory()
        cls.path = f"{cls._tmp.name}/clip.webm"
        with open(cls.path, "wb") as f:
            f.write(cls.data)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def _gray(self, stream):
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", self.path, "-map", f"0:{stream}",
                              "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                             capture_output=True, check=True).stdout
        return np.frombuffer(raw, np.uint8)[:N * H * W].reshape(N, H, W)

    def test_depth_stream_signals_full_range(self):
        cr = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                             "-show_entries", "stream=color_range", "-of", "csv=p=0", self.path],
                            capture_output=True, text=True).stdout.strip()
        self.assertEqual(cr, "pc", "depth stream must signal full range")

    def test_ffmpeg_decodes_depth_bit_exactly(self):
        hi, lo = self._gray(0), self._gray(1)                 # streams 0,1 = depth-hi, depth-lo
        l = np.where(hi & 1, 255 - lo, lo).astype(np.uint16)  # invert the triangle-fold
        recovered = (hi.astype(np.uint16) << 8) | l
        self.assertTrue(np.array_equal(recovered, self.depth), "ffmpeg-decoded depth is not bit-exact")
        self.assertTrue(np.array_equal(cz.decode_signal(self.data, "depth"), self.depth),
                        "native decode is not bit-exact")


if __name__ == "__main__":
    unittest.main()
