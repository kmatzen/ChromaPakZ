"""Streaming encode (cz.create_encoder) — the live-recording counterpart of cz.encode().

Three properties carry the whole feature, and each has a test here:

  * the chunks are **element-aligned** — the header is the whole file prefix, every later chunk a
    whole number of Cluster elements — so a wrapper format (worldline weaves camera poses in as
    Matroska tags) can inject its own elements between them without re-parsing byte boundaries;
  * the header is **valid immediately**, because the Segment carries an unknown size, so a
    recording is a decodable WebM from the first chunk and stays one if the capture is cut short;
  * what comes out decodes **bit-exactly**, and the same way for the native and browser readers.

tests/test_stream_interop.py is the mirror of this file: it reads a *browser*-streamed fixture
through the native decoder, where this one writes the stream from Python.
"""
import unittest

import numpy as np

import chromapakz as cz
from chromapakz.webm_inspect import _children, track_sizes

W, H, N = 40, 24, 12
FPS = 4            # RGB keyframes land every `fps` frames, so a short clip still spans clusters

ID_SEGMENT = 0x18538067
ID_CLUSTER = 0x1F43B675
ID_CUES = 0x1C53BB6B
ID_TAGS = 0x1254C367
ID_TAG, ID_TARGETS, ID_SIMPLETAG = 0x7373, 0x63C0, 0x67C8
ID_TAGNAME, ID_TAGSTRING = 0x45A3, 0x4487


def vint(n):
    """EBML length descriptor (all-ones is reserved for 'unknown', hence the -1)."""
    L = 1
    while n >= (1 << (7 * L)) - 1:
        L += 1
    return (n + (1 << (7 * L))).to_bytes(L, "big")


def el(eid, payload):
    return eid.to_bytes((eid.bit_length() + 7) // 8, "big") + vint(len(payload)) + payload


def foreign_tag(name, value):
    """A Tags element with someone else's tag in it — what a wrapper format would inject."""
    simple = el(ID_TAGNAME, name.encode()) + el(ID_TAGSTRING, value.encode())
    return el(ID_TAGS, el(ID_TAG, el(ID_TARGETS, b"") + el(ID_SIMPLETAG, simple)))


def segment_children(data):
    """IDs of the Segment's direct children, in file order."""
    for eid, ds, de in _children(memoryview(data), 0, len(data)):
        if eid == ID_SEGMENT:
            return [cid for cid, _, _ in _children(memoryview(data), ds, de)]
    raise AssertionError("no Segment element")


def record(depth, ids=None, rgb=None, **kwargs):
    """Run a whole take through a streaming encoder; returns (chunks, encoder)."""
    chunks = []
    signals = [{"id": "depth", "near": 0.3, "far": 9.0}]
    if ids is not None:
        signals.append({"id": "objectId"})
    enc = cz.create_encoder(W, H, signals=signals, fps=FPS, has_rgb=rgb is not None,
                            on_chunk=chunks.append, **kwargs)
    for i in range(len(depth)):
        frame = {"depth": depth[i]}
        if ids is not None:
            frame["objectId"] = ids[i]
        enc.add_frame(rgb=None if rgb is None else rgb[i], signals=frame)
    enc.finish()
    return chunks, enc


class StreamEncode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(17)
        cls.depth = rng.integers(1, 65536, (N, H, W)).astype(np.uint16)
        cls.ids = rng.integers(1, 50000, (N, H, W)).astype(np.uint16)
        cls.rgb = rng.integers(0, 256, (N, H, W, 4)).astype(np.uint8)
        cls.chunks, cls.enc = record(cls.depth, cls.ids, cls.rgb)
        cls.data = b"".join(cls.chunks)

    # ── the streamed file ──
    def test_signals_and_rgb_round_trip_bit_exactly(self):
        out = cz.decode(self.data)
        self.assertTrue(np.array_equal(out["signals"]["depth"], self.depth), "depth not bit-exact")
        self.assertTrue(np.array_equal(out["signals"]["objectId"], self.ids), "ids not bit-exact")
        self.assertEqual(out["rgb"].shape, (N, H, W, 4))

    def test_probe_recovers_the_frame_count_from_the_blocks(self):
        info = cz.probe(self.data)
        self.assertEqual(info["frames"], N, "streamed header carries no count to trust")
        self.assertEqual((info["width"], info["height"], info["fps"]), (W, H, FPS))
        self.assertEqual((info["near"], info["far"]), (0.3, 9.0))
        self.assertTrue(info["has_rgb"])

    def test_track_plan_matches_the_batch_encoder(self):
        streamed = cz.parse_metadata(self.data)["signals"]
        batch = cz.parse_metadata(
            cz.encode({"depth": self.depth, "objectId": self.ids},
                      specs={"depth": cz.inverse_depth_spec(0.3, 9.0)},
                      rgb=self.rgb, fps=FPS))["signals"]
        self.assertEqual(streamed, batch, "streamed and batch files must describe the same tracks")

    # ── the three properties a wrapper format depends on ──
    def test_chunks_are_element_aligned(self):
        self.assertGreater(len(self.chunks), 2, "clip should span several clusters")
        self.assertEqual(self.chunks[0], self.enc.header, "first chunk is the file prefix")
        for i, chunk in enumerate(self.chunks[1:], start=1):
            with self.subTest(chunk=i):
                # Whole elements: a chunk starts on an element id and walking it as a sequence of
                # elements consumes it exactly — no partial element at either end. Every chunk is
                # Clusters, except that the last one also carries the Cues index that closes the
                # file.
                spans = list(_children(memoryview(chunk), 0, len(chunk)))
                ids = [eid for eid, _, _ in spans]
                self.assertEqual(ids[:-1], [ID_CLUSTER] * (len(ids) - 1))
                self.assertIn(ids[-1], (ID_CLUSTER, ID_CUES))
                self.assertEqual(chunk[:4], ID_CLUSTER.to_bytes(4, "big"))
                self.assertEqual(spans[-1][2], len(chunk), "chunk ends mid-element")

    def test_the_header_alone_is_a_valid_chromapakz_file(self):
        meta = cz.parse_metadata(self.enc.header)
        self.assertEqual(meta["width"], W)
        self.assertIsNone(meta["frames"], "the count is not known when the header is written")
        self.assertTrue(meta["streaming"])
        self.assertEqual([s["id"] for s in meta["signals"]], ["depth", "objectId"])

    def test_a_take_cut_short_still_decodes_what_it_holds(self):
        """The crash-safety claim: no finish(), no tail — the prefix is still a usable file."""
        partial = b"".join(self.chunks[:-1])
        info = cz.probe(partial)
        self.assertGreater(info["frames"], 0, "truncated take decoded nothing")
        self.assertLess(info["frames"], N, "this take should be missing its tail")
        got = cz.decode_signal(partial, "depth")
        self.assertTrue(np.array_equal(got, self.depth[:info["frames"]]),
                        "the frames that did arrive must still be bit-exact")

    def test_foreign_elements_can_be_injected_between_chunks(self):
        """worldline's use: weave its own tag elements between clusters as the take is recorded."""
        chunks, _ = record(self.depth, rgb=self.rgb, cues=False)
        woven = [chunks[0]]
        for i, chunk in enumerate(chunks[1:]):
            woven.append(foreign_tag("TEST_POSES", f'{{"i":{i}}}'))
            woven.append(chunk)
        data = b"".join(woven)
        self.assertTrue(np.array_equal(cz.decode_signal(data, "depth"), self.depth),
                        "injected elements must not disturb the blocks around them")
        self.assertEqual(cz.parse_metadata(data)["width"], W,
                         "a foreign tag must not be mistaken for the CHROMAPAKZ one")

    def test_cues_are_written_by_default_and_can_be_suppressed(self):
        self.assertIn(ID_CUES, segment_children(self.data), "seekable by default")
        chunks, _ = record(self.depth, rgb=self.rgb, cues=False)
        kids = segment_children(b"".join(chunks))
        self.assertNotIn(ID_CUES, kids, "cues=False must emit no index to be invalidated")
        self.assertIn(ID_CLUSTER, kids, "…but still emit the clusters")

    def test_bytes_are_handed_out_during_the_take_not_at_the_end(self):
        """The whole point: chunks arrive while recording, so a crash keeps what came before."""
        chunks = []
        enc = cz.create_encoder(W, H, signals=[{"id": "depth", "near": 0.3, "far": 9.0}],
                                fps=FPS, has_rgb=True, on_chunk=chunks.append)
        for i in range(N):
            enc.add_frame(rgb=self.rgb[i], signals={"depth": self.depth[i]})
        during = len(chunks)
        enc.finish()
        self.assertGreater(during, 1, "only the header was emitted before finish()")
        self.assertGreater(len(chunks), during, "finish() writes the tail")

    def test_a_signal_only_stream_still_closes_clusters_on_a_live_cadence(self):
        """No RGB means no keyframe to split on after frame 0 — the time-based span has to.

        The batch muxer's 30s cap would hold half a minute of blocks open on a live recorder.
        """
        rng = np.random.default_rng(31)
        depth = rng.integers(1, 65536, (40, H, W)).astype(np.uint16)   # 40 frames @ 30fps > 1s
        chunks = []
        enc = cz.create_encoder(W, H, signals=[{"id": "depth"}], fps=30, on_chunk=chunks.append)
        for frame in depth:
            enc.add_frame(signals={"depth": frame})
        self.assertGreater(len(chunks), 1, "no cluster closed during a 1.3s signal-only take")
        enc.finish()
        self.assertTrue(np.array_equal(cz.decode_signal(b"".join(chunks), "depth"), depth))

    def test_a_take_with_no_frames_is_still_a_readable_file(self):
        """A recorder that starts and stops leaves a header, not a corrupt stub."""
        chunks = []
        enc = cz.create_encoder(W, H, signals=[{"id": "depth"}], fps=FPS, on_chunk=chunks.append)
        self.assertEqual(enc.finish(), b"", "nothing was encoded, so there is no tail")
        data = b"".join(chunks)
        self.assertEqual(cz.parse_metadata(data)["width"], W)
        self.assertEqual(cz.probe(data)["frames"], 0)

    def test_the_pure_python_inspector_reads_a_streamed_file(self):
        """webm_inspect has no native dep, so it is what tooling reaches for on a live file."""
        sizes = track_sizes(self.data)
        self.assertEqual({t: v["frames"] for t, v in sizes.items()}, {t: N for t in (1, 2, 3, 4, 5)})
        self.assertEqual(sizes[1]["name"], "rgb")
        self.assertEqual(sizes[2]["name"], "signal-depth-hi")

    # ── the API ──
    def test_signals_may_be_given_as_a_dict_of_specs(self):
        """The `{id: spec}` shape `encode(specs=…)` uses, for symmetry with the batch call."""
        enc = cz.create_encoder(W, H, fps=FPS,
                                signals={"depth": cz.inverse_depth_spec(0.5, 6.0, 4096),
                                         "objectId": None})
        parts = [enc.header,
                 enc.add_frame(signals={"depth": self.depth[0], "objectId": self.ids[0]}),
                 enc.finish()]
        info = cz.probe(b"".join(parts))
        self.assertEqual([s["id"] for s in info["signals"]], ["depth", "objectId"])
        self.assertEqual((info["near"], info["far"], info["levels"]), (0.5, 6.0, 4096))

    def test_reduced_levels_round_trip_through_the_stream(self):
        z = np.linspace(0.6, 5.5, H * W, dtype=np.float32).reshape(H, W)
        enc = cz.create_encoder(W, H, fps=FPS,
                                signals=[{"id": "depth", "near": 0.5, "far": 6.0, "levels": 4096}])
        parts = [enc.header, enc.add_frame(signals={"depth": {"float": z}}), enc.finish()]
        codes = cz.decode_signal(b"".join(parts), "depth")[0]
        self.assertLessEqual(int(codes.max()), 4095, "codes must stay inside the declared levels")
        back = cz.dequantize_inverse(codes, 0.5, 6.0, 4096)
        self.assertLess(float(np.abs(back - z).max()), 0.01)

    def test_chunks_are_returned_as_well_as_pushed(self):
        """A caller can pull the bytes instead of registering a callback."""
        enc = cz.create_encoder(W, H, signals=[{"id": "depth"}], fps=FPS)
        parts = [enc.header]
        for i in range(N):
            parts.append(enc.add_frame(signals={"depth": self.depth[i]}))
        parts.append(enc.finish())
        self.assertEqual(enc.frame_count, N)
        self.assertTrue(np.array_equal(cz.decode_signal(b"".join(parts), "depth"), self.depth))

    def test_float_depth_is_quantized_the_same_way_the_batch_path_is(self):
        z = np.linspace(0.4, 8.0, H * W, dtype=np.float32).reshape(H, W)
        codes = cz.quantize_inverse(z, 0.3, 9.0)
        enc = cz.create_encoder(W, H, signals=[{"id": "depth", "near": 0.3, "far": 9.0}], fps=FPS)
        parts = [enc.header, enc.add_frame(signals={"depth": {"float": z}}), enc.finish()]
        self.assertTrue(np.array_equal(cz.decode_signal(b"".join(parts), "depth")[0], codes))

    def test_context_manager_finishes_a_clean_take_and_abandons_a_failed_one(self):
        chunks = []
        with cz.create_encoder(W, H, signals=[{"id": "depth"}], fps=FPS,
                               on_chunk=chunks.append) as enc:
            enc.add_frame(signals={"depth": self.depth[0]})
        self.assertEqual(cz.probe(b"".join(chunks))["frames"], 1, "clean exit writes the tail")

        aborted = []
        with self.assertRaises(ZeroDivisionError):
            with cz.create_encoder(W, H, signals=[{"id": "depth"}], fps=FPS,
                                   on_chunk=aborted.append) as enc:
                enc.add_frame(signals={"depth": self.depth[0]})
                raise ZeroDivisionError("capture died")
        # The chunks already emitted stand — that is the point — but nothing claims a clean end.
        self.assertEqual(aborted, [enc.header], "an abandoned take must not be given a tail")

    def test_double_finish_and_use_after_finish_are_refused(self):
        enc = cz.create_encoder(W, H, signals=[{"id": "depth"}], fps=FPS)
        enc.add_frame(signals={"depth": self.depth[0]})
        enc.finish()
        with self.assertRaises(RuntimeError, msg="finish twice"):
            enc.finish()
        with self.assertRaises(RuntimeError, msg="add_frame after finish"):
            enc.add_frame(signals={"depth": self.depth[0]})


class StreamEncodeGeometry(unittest.TestCase):
    """Track numbering and plane packing across the shapes that tend to break them.

    Odd dimensions exercise the (W+1)/2 chroma rounding; `has_rgb` shifts every signal's track
    number by one, which is exactly the kind of off-by-one a single happy-path test misses.
    """

    def test_sweep(self):
        rng = np.random.default_rng(37)
        for w, h, n_sig, has_rgb, fps in (
            (17, 9, 1, False, 10),      # odd both ways, no rgb → signal starts at track 1
            (17, 9, 2, True, 10),       # odd, rgb → signals start at track 2
            (2, 2, 1, True, 1),         # the smallest frame the codec will take
            (64, 3, 3, False, 15),      # very wide and short, three signal pairs
        ):
            with self.subTest(w=w, h=h, signals=n_sig, rgb=has_rgb, fps=fps):
                ids = [f"sig{i}" for i in range(n_sig)]
                frames = {sid: rng.integers(0, 65536, (4, h, w)).astype(np.uint16) for sid in ids}
                rgb = rng.integers(0, 256, (4, h, w, 4)).astype(np.uint8) if has_rgb else None
                chunks = []
                enc = cz.create_encoder(w, h, fps=fps, has_rgb=has_rgb, on_chunk=chunks.append,
                                        signals=[{"id": sid} for sid in ids])
                for i in range(4):
                    enc.add_frame(rgb=None if rgb is None else rgb[i],
                                  signals={sid: frames[sid][i] for sid in ids})
                enc.finish()
                data = b"".join(chunks)

                info = cz.probe(data)
                self.assertEqual((info["width"], info["height"], info["frames"]), (w, h, 4))
                self.assertEqual(info["has_rgb"], has_rgb)
                first = 2 if has_rgb else 1
                self.assertEqual([s["tracks"]["hi"] for s in info["signals"]],
                                 list(range(first, first + 2 * n_sig, 2)))
                for sid in ids:
                    self.assertTrue(np.array_equal(cz.decode_signal(data, sid), frames[sid]),
                                    f"{sid} not bit-exact at {w}x{h}")
                if has_rgb:
                    self.assertEqual(cz.decode_rgb(data).shape, (4, h, w, 4))


class StreamEncodeValidation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(19)
        cls.depth = rng.integers(1, 65536, (H, W)).astype(np.uint16)
        cls.rgb = rng.integers(0, 256, (H, W, 4)).astype(np.uint8)

    def make(self, **kwargs):
        kwargs.setdefault("signals", [{"id": "depth", "near": 0.3, "far": 9.0}])
        kwargs.setdefault("fps", FPS)
        return cz.create_encoder(W, H, **kwargs)

    def test_encoder_construction_guards(self):
        for kwargs, label in (
            ({"signals": []}, "no signals"),
            ({"signals": [{"near": 1, "far": 2}]}, "signal with no id"),
            ({"signals": [{"id": "d"}, {"id": "d"}]}, "duplicate id"),
            ({"signals": [{"id": "d", "near": 1}]}, "near without far"),
            ({"signals": [{"id": "d", "near": 5, "far": 1}]}, "far <= near"),
            ({"signals": [{"id": "d", "near": 1, "far": 2, "levels": 2}]}, "levels < 3"),
            ({"fps": 0}, "fps=0"),
            ({"on_chunk": "nope"}, "on_chunk not callable"),
        ):
            with self.subTest(case=label), self.assertRaises(ValueError, msg=label):
                self.make(**kwargs)
        with self.assertRaises(ValueError, msg="width <= 0"):
            cz.create_encoder(0, H, signals=[{"id": "depth"}])

    def test_every_declared_stream_must_appear_on_every_frame(self):
        enc = self.make(signals=[{"id": "depth"}, {"id": "objectId"}])
        with self.assertRaises(ValueError, msg="missing signal"):
            enc.add_frame(signals={"depth": self.depth})
        with self.assertRaises(ValueError, msg="unknown signal"):
            enc.add_frame(signals={"depth": self.depth, "objectId": self.depth, "z": self.depth})
        # The rejected frames must not have disturbed the encoders behind them.
        enc.add_frame(signals={"depth": self.depth, "objectId": self.depth})
        self.assertEqual(enc.frame_count, 1)

    def test_rgb_must_match_what_the_header_declared(self):
        with self.assertRaises(ValueError, msg="has_rgb=True but no rgb"):
            self.make(has_rgb=True).add_frame(signals={"depth": self.depth})
        with self.assertRaises(ValueError, msg="rgb without an rgb track"):
            self.make().add_frame(rgb=self.rgb, signals={"depth": self.depth})

    def test_plane_geometry_is_checked_before_the_codec_sees_it(self):
        enc = self.make(has_rgb=True)
        with self.assertRaises(ValueError, msg="wrong signal shape"):
            enc.add_frame(rgb=self.rgb, signals={"depth": self.depth[:, :-1]})
        with self.assertRaises(ValueError, msg="wrong rgb shape"):
            enc.add_frame(rgb=self.rgb[:, :, :3], signals={"depth": self.depth})
        self.assertEqual(enc.frame_count, 0, "a rejected frame must not be counted")

    def test_lossy_signal_inputs_are_refused_rather_than_wrapped(self):
        enc = self.make()
        with self.assertRaises(ValueError, msg="float without an explicit float payload"):
            enc.add_frame(signals={"depth": self.depth.astype(np.float32)})
        with self.assertRaises(ValueError, msg="out-of-range codes"):
            enc.add_frame(signals={"depth": self.depth.astype(np.int32) + 70000})
        with self.assertRaises(ValueError, msg="float on an unquantized signal"):
            self.make(signals=[{"id": "raw"}]).add_frame(
                signals={"raw": {"float": self.depth.astype(np.float32)}})


if __name__ == "__main__":
    unittest.main()
