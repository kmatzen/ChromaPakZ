"""Decoding a subset of a file must size buffers from the data, not the header (issue #57).

Cluster independence (#45) exists so a caller can splice one Cluster onto a
file's header and decode just that. But `probe()["frames"]` reports what the
header *declares* — the whole sequence — and the decoders sized their output
from it. Two consequences, and the second is the sharper one:

  * every partial decode allocated for the entire sequence: 277 MB per Cluster
    on a 600-frame 320x240 file with depth, against 14.7 MB once sized from the
    data;
  * the returned array was padded with zeroed frames that were never decoded,
    and nothing distinguished them from genuinely black ones. A caller who did
    not already know the Cluster's frame count could not tell.

The zeroing itself was deliberate and remains — it is why this was a wrong
answer rather than uninitialised heap.

Run: pytest tests/test_partial_decode.py  (needs the compiled native core)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
import numpy as np

import chromapakz as cz
from chromapakz.webm_inspect import track_sizes

W, H, N, FPS = 64, 48, 60, 30


def _make(frames=N):
    """A file with several Clusters, so a single-Cluster splice is meaningful."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    rgb = np.stack([
        np.dstack([np.clip((0.5 + 0.4 * np.sin(xx / 5 + i * 0.3)) * 255, 0, 255)] * 3
                  + [np.full((H, W), 255, np.float32)]).astype(np.uint8)
        for i in range(frames)])
    depth = np.stack([(1.5 + 0.4 * np.sin(xx / 7 + i * 0.2)).astype(np.float32)
                      for i in range(frames)])
    return cz.encode({"depth": cz.quantize_inverse(depth, near=0.3, far=9.0)},
                     specs={"depth": {"inverse_depth": True, "near": 0.3, "far": 9.0}},
                     rgb=rgb, fps=FPS)


# Minimal EBML walk, so the test does not depend on a consumer's splice helper.
def _vint(b, p, keep):
    first = b[p]
    length = 1
    while length <= 8 and not (first & (0x80 >> (length - 1))):
        length += 1
    value = first if keep else first & (0xFF >> length)
    for k in range(1, length):
        value = (value << 8) | b[p + k]
    return value, p + length


def _elements(b, start, end):
    p = start
    while p < end:
        eid, q = _vint(b, p, True)
        size, r = _vint(b, q, False)
        yield eid, p, r, r + size
        p = r + size


SEGMENT, CLUSTER = 0x18538067, 0x1F43B675


def _first_cluster_only(data):
    """The file's header plus its first Cluster, as a valid standalone WebM."""
    p = 0
    for eid, es, ps, pe in _elements(data, 0, len(data)):
        if eid == SEGMENT:
            seg_start, payload_start, payload_end = es, ps, pe
            break
    else:
        raise AssertionError("no Segment")

    head_end = first_cluster_end = None
    for eid, es, _ps, pe in _elements(data, payload_start, payload_end):
        if eid == CLUSTER:
            head_end, first_cluster_end = es, pe
            break
    if head_end is None:
        raise AssertionError("no Cluster")

    payload = data[payload_start:first_cluster_end]
    size = len(payload).to_bytes(8, "big")
    size = bytes([size[0] | 0x01]) + size[1:]       # 8-byte size vint
    return data[:seg_start] + b"\x18\x53\x80\x67" + size + payload


class PartialDecode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = _make()
        cls.cluster = _first_cluster_only(cls.data)
        cls.present = max(t["frames"] for t in track_sizes(cls.cluster).values())

    def test_the_fixture_really_is_a_subset(self):
        """Without a real subset every assertion below is vacuous."""
        self.assertGreater(len(track_sizes(self.data)), 0)
        self.assertLess(self.present, N)
        self.assertGreater(self.present, 0)
        # The header still declares the whole sequence — that is the point.
        self.assertEqual(cz.probe(self.cluster)["frames"], N)

    def test_frames_present_counts_the_data(self):
        self.assertEqual(cz.frames_present(self.data), N)
        self.assertEqual(cz.frames_present(self.cluster), self.present)

    def test_probe_still_reports_the_declared_length(self):
        """probe() describes the sequence; it must not start describing the bytes."""
        self.assertEqual(cz.probe(self.data)["frames"], N)
        self.assertEqual(cz.probe(self.cluster)["frames"], N)

    def test_partial_decode_returns_only_decoded_frames(self):
        out = cz.decode(self.cluster)
        self.assertEqual(out["rgb"].shape[0], self.present)
        self.assertEqual(out["signals"]["depth"].shape[0], self.present)
        self.assertEqual(out["frames"], self.present)

    def test_no_frame_in_a_partial_decode_is_a_phantom(self):
        """Previously rows past the Cluster came back black and indistinguishable."""
        out = cz.decode(self.cluster)
        for i in range(out["rgb"].shape[0]):
            self.assertTrue(out["rgb"][i].any(), f"frame {i} is entirely zero")

    def test_partial_decode_matches_the_whole_file(self):
        whole = cz.decode(self.data)
        part = cz.decode(self.cluster)
        k = part["rgb"].shape[0]
        self.assertTrue(np.array_equal(part["rgb"], whole["rgb"][:k]))
        self.assertTrue(np.array_equal(part["signals"]["depth"],
                                       whole["signals"]["depth"][:k]))

    def test_whole_file_decode_is_unchanged(self):
        out = cz.decode(self.data)
        self.assertEqual(out["rgb"].shape[0], N)
        self.assertEqual(out["frames"], N)
        self.assertEqual(out["signals"]["depth"].shape[0], N)

    def test_single_decoders_size_from_the_data_too(self):
        self.assertEqual(cz.decode_rgb(self.cluster).shape[0], self.present)
        self.assertEqual(cz.decode_signal(self.cluster, "depth").shape[0], self.present)

    def test_allocation_tracks_the_subset(self):
        """The memory half, compared against decoding the whole file.

        Measured against the whole-file decode rather than a fraction of a byte
        count: on a fixture this small the fixed cost of a decode swamps the
        output buffers, so an absolute bound would be a statement about the
        fixture rather than about the code.
        """
        import tracemalloc

        def peak_of(payload):
            tracemalloc.start()
            cz.decode(payload)
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            return peak

        part, whole = peak_of(self.cluster), peak_of(self.data)
        ratio = self.present / N
        self.assertLess(part, 0.75 * whole,
                        f"partial decode peaked at {part/1e6:.2f} MB against "
                        f"{whole/1e6:.2f} MB for the whole file, while carrying "
                        f"{self.present}/{N} frames ({ratio:.0%})")


if __name__ == "__main__":
    unittest.main()
