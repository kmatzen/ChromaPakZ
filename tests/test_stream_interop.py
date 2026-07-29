"""Regression: a browser-streamed file (unknown-size Segment, "frames":null) must decode
bit-exact through the C++/Python core.

The JS streaming muxer (createEncoder({onChunk})) emits an unknown-size Segment and omits the
frame count from the header. The native demuxer therefore has to (a) recognise the all-ones EBML
size marker and (b) recover the frame count by counting blocks. tests/fixtures/stream.webm is a
real WASM-encoded streamed clip; regenerate it with tests/fixtures/regen_stream.mjs.

tests/test_fixtures.py is the staleness tripwire for the fixture itself.
"""
import os
import unittest

import numpy as np

import chromapakz as cz

HERE = os.path.dirname(os.path.abspath(__file__))
N, H, W = 5, 24, 40


class StreamInterop(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(HERE, "fixtures", "stream.webm"), "rb") as f:
            cls.data = f.read()
        cls.expected = np.fromfile(
            os.path.join(HERE, "fixtures", "stream_depth.u16"), dtype="<u2").reshape(N, H, W)

    def test_frame_count_is_recovered_from_the_blocks(self):
        # The header carries no count; probe() must recover it from the blocks, not trust metadata.
        info = cz.probe(self.data)
        self.assertEqual(info["frames"], N, "frame count from streamed file")
        self.assertEqual((info["width"], info["height"]), (W, H))
        self.assertIsNone(cz.parse_metadata(self.data)["frames"],
                          "streamed metadata should carry frames:null")

    def test_signals_decode_bit_exactly(self):
        for sid in ("depth", "objectId"):
            with self.subTest(signal=sid):
                got = cz.decode_signal(self.data, sid)
                self.assertEqual(got.shape, (N, H, W))
                self.assertTrue(np.array_equal(got, self.expected),
                                f"{sid} not bit-exact from streamed file")


if __name__ == "__main__":
    unittest.main()
