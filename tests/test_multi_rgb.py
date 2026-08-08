"""Multi-RGB (stereo / multi-camera) tracks — issue #47.

A v3 file carries N synchronized RGB streams beside the lossless signals. The compatibility
contract under test:

  * the legacy `rgb` metadata key stays, always describing the primary stream (== rgbs[0],
    track 1, container name "rgb"), so pre-v3 readers decode the primary exactly as before;
  * `rgbs[]` names every stream; signal hi/lo tracks number after all RGB tracks;
  * all three implementations write byte-identical metadata for the same configuration
    (checked here between the C streaming writer and the JS streaming writer);
  * a signal's optional `view` hint is recorded verbatim and interpreted by nothing.

Stream identity is asserted through lossy VP9 by giving each camera a far-apart solid colour.
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

import numpy as np

import chromapakz as cz

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src", "chromapakz.js")
HAVE_NODE = bool(shutil.which("node")) and os.path.exists(SRC)

N, H, W = 3, 24, 32
FPS = 30


def solid(r, g, b):
    a = np.zeros((N, H, W, 4), np.uint8)
    a[..., 0], a[..., 1], a[..., 2], a[..., 3] = r, g, b, 255
    return a


CAM0 = solid(220, 30, 30)   # red-ish
CAM1 = solid(30, 30, 220)   # blue-ish
RNG = np.random.default_rng(47)
SIG = RNG.integers(0, 65536, (N, H, W)).astype(np.uint16)


def assert_looks_like(test, got, ref, what):
    for c in (0, 2):
        test.assertLess(abs(float(got[..., c].mean()) - float(ref[..., c].mean())), 40.0,
                        f"{what}: channel {c} should stay near its source colour")


class BatchStereo(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = cz.encode({"disparity": SIG}, specs={"disparity": {"view": "cam0"}},
                             rgbs={"cam0": CAM0, "cam1": CAM1}, rgb_kbps={"cam1": 900}, fps=FPS)

    def test_metadata_shape(self):
        meta = cz.parse_metadata(self.data)
        self.assertEqual(meta["version"], 3)
        self.assertEqual(meta["rgb"], {"track": 1, "codec": "vp09.00.10.08"},
                         "legacy key = primary stream, for pre-v3 readers")
        self.assertEqual([(r["id"], r["track"]) for r in meta["rgbs"]],
                         [("cam0", 1), ("cam1", 2)])
        self.assertEqual(meta["signals"][0]["tracks"], {"hi": 3, "lo": 4},
                         "signals number after all RGB tracks")
        self.assertEqual(meta["signals"][0]["view"], "cam0")

    def test_probe_counts_streams(self):
        info = cz.probe(self.data)
        self.assertTrue(info["has_rgb"])
        self.assertEqual([r["id"] for r in info["rgbs"]], ["cam0", "cam1"])

    def test_both_streams_decode_with_their_own_pixels(self):
        out = cz.decode(self.data)
        self.assertEqual(sorted(out["rgbs"]), ["cam0", "cam1"])
        assert_looks_like(self, out["rgbs"]["cam0"], CAM0, "cam0")
        assert_looks_like(self, out["rgbs"]["cam1"], CAM1, "cam1")
        self.assertTrue(np.array_equal(out["rgb"], out["rgbs"]["cam0"]),
                        "the legacy rgb result is the primary stream")
        self.assertTrue(np.array_equal(out["signals"]["disparity"], SIG),
                        "signals stay bit-exact beside two RGB tracks")

    def test_legacy_entry_point_sees_the_primary(self):
        # dc_decode_rgb (what every pre-v3 reader ultimately does) must return cam0's pixels.
        legacy = cz.decode_rgb(self.data)
        by_id = cz.decode_rgb(self.data, stream="cam0")
        self.assertTrue(np.array_equal(legacy, by_id))

    def test_unknown_stream_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "no rgb stream 'cam9'"):
            cz.decode_rgb(self.data, stream="cam9")

    def test_validation(self):
        with self.assertRaisesRegex(ValueError, "not both"):
            cz.encode({"d": SIG}, rgb=CAM0, rgbs={"cam0": CAM0})
        with self.assertRaisesRegex(ValueError, "duplicate rgb stream id"):
            cz.encode({"d": SIG}, rgbs=[("a", CAM0), ("a", CAM1)])
        with self.assertRaisesRegex(ValueError, r"\(N, H, W, 4\)"):
            cz.encode({"d": SIG}, rgbs={"a": CAM0[..., :3]})


class StreamingStereo(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chunks = []
        enc = cz.create_encoder(W, H, fps=FPS, rgbs=["cam0", ("cam1", 900)],
                                signals=[{"id": "disparity", "view": "cam0"}],
                                on_chunk=cls.chunks.append)
        cls.rgb_ids = enc.rgb_ids
        for i in range(N):
            enc.add_frame(rgbs={"cam0": CAM0[i], "cam1": CAM1[i]},
                          signals={"disparity": SIG[i]})
        enc.finish()
        cls.data = b"".join(cls.chunks)

    def test_declared_ids(self):
        self.assertEqual(self.rgb_ids, ["cam0", "cam1"])

    def test_streamed_stereo_decodes(self):
        out = cz.decode(self.data)
        self.assertEqual(out["frames"], N)
        assert_looks_like(self, out["rgbs"]["cam0"], CAM0, "cam0")
        assert_looks_like(self, out["rgbs"]["cam1"], CAM1, "cam1")
        self.assertTrue(np.array_equal(out["signals"]["disparity"], SIG))

    def test_every_declared_stream_every_frame(self):
        enc = cz.create_encoder(W, H, rgbs=["cam0", "cam1"], signals=[{"id": "d"}])
        try:
            with self.assertRaisesRegex(ValueError, "missing rgb stream 'cam1'"):
                enc.add_frame(rgbs={"cam0": CAM0[0]}, signals={"d": SIG[0]})
            with self.assertRaisesRegex(ValueError, "unknown rgb stream"):
                enc.add_frame(rgbs={"cam0": CAM0[0], "cam1": CAM1[0], "cam9": CAM0[0]},
                              signals={"d": SIG[0]})
            with self.assertRaisesRegex(ValueError, "pass rgbs"):
                enc.add_frame(rgb=CAM0[0], signals={"d": SIG[0]})
        finally:
            enc.close()

    def test_single_stream_paths_unchanged(self):
        # has_rgb=True keeps working and still writes the default-id stream.
        chunks = []
        enc = cz.create_encoder(W, H, has_rgb=True, signals=[{"id": "d"}], on_chunk=chunks.append)
        for i in range(N):
            enc.add_frame(rgb=CAM0[i], signals={"d": SIG[i]})
        enc.finish()
        meta = cz.parse_metadata(b"".join(chunks))
        self.assertEqual([(r["id"], r["track"]) for r in meta["rgbs"]], [("rgb", 1)])


@unittest.skipUnless(HAVE_NODE, "node or src/chromapakz.js not available")
class CrossLanguageStereo(unittest.TestCase):
    """Python(C)-encoded stereo decodes in JS; JS-encoded stereo decodes in Python; and the two
    writers produce byte-identical metadata for the same configuration."""

    JS = r"""
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { createDecoder, createEncoder } = await import(pathToFileURL(process.env.CZ_SRC).href);
const [N, W, H, FPS] = [3, 32, 24, 30];

// 1) decode the Python-encoded clip, report per-stream mean colour + signal
const bytes = new Uint8Array(readFileSync(process.env.CZ_CLIP));
const dec = createDecoder(bytes, { backend: 'wasm' });
const seen = { frames: 0, means: {}, sig: [] };
for await (const fr of dec) {
  seen.frames++;
  for (const [id, p] of Object.entries(fr.rgbs)) {
    let r = 0, b = 0; const px = W * H;
    for (let i = 0; i < px; i++) { r += p[4 * i]; b += p[4 * i + 2]; }
    seen.means[id] = [r / px, b / px];
  }
  seen.sig.push(Array.from(fr.signals.disparity.u16));
}
await dec.close();
seen.metadataJson = JSON.stringify(dec.metadata);

// 2) encode the same stereo configuration from JS (streaming, so the metadata matches the
//    C streaming writer's byte-for-byte) and hand the bytes back
const solid = (r, g, b) => { const a = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { a[4 * i] = r; a[4 * i + 1] = g; a[4 * i + 2] = b; a[4 * i + 3] = 255; }
  return a; };
const cam0 = solid(220, 30, 30), cam1 = solid(30, 30, 220);
const sig = f => { const u = new Uint16Array(W * H);
  for (let i = 0; i < u.length; i++) u[i] = seen.sig[f][i]; return u; };
const chunks = [];
const enc = createEncoder({ W, H, fps: FPS, rgbs: ['cam0', 'cam1'], backend: 'wasm',
  signals: [{ id: 'disparity', view: 'cam0' }], onChunk: c => chunks.push(c) });
for (let f = 0; f < N; f++)
  await enc.addFrame({ rgbs: { cam0, cam1 }, signals: { disparity: { u16: sig(f) } } });
await enc.finish();
let total = 0; for (const c of chunks) total += c.length;
const out = new Uint8Array(total); let off = 0;
for (const c of chunks) { out.set(c, off); off += c.length; }
writeFileSync(process.env.CZ_OUT, out);
process.stdout.write(JSON.stringify(seen));
"""

    @classmethod
    def setUpClass(cls):
        chunks = []
        enc = cz.create_encoder(W, H, fps=FPS, rgbs=["cam0", "cam1"],
                                signals=[{"id": "disparity", "view": "cam0"}],
                                on_chunk=chunks.append)
        for i in range(N):
            enc.add_frame(rgbs={"cam0": CAM0[i], "cam1": CAM1[i]},
                          signals={"disparity": SIG[i]})
        enc.finish()
        cls.py_bytes = b"".join(chunks)

        cls._tmp = tempfile.TemporaryDirectory()
        clip = os.path.join(cls._tmp.name, "clip.webm")
        js_out = os.path.join(cls._tmp.name, "js.webm")
        script = os.path.join(cls._tmp.name, "stereo.mjs")
        with open(clip, "wb") as f:
            f.write(cls.py_bytes)
        with open(script, "w") as f:
            f.write(cls.JS)
        env = dict(os.environ, CZ_SRC=os.path.abspath(SRC), CZ_CLIP=clip, CZ_OUT=js_out)
        run = subprocess.run(["node", script], capture_output=True, text=True, env=env)
        if run.returncode:
            raise unittest.SkipTest(f"node could not run the JS side: {run.stderr.strip()}")
        cls.js_seen = json.loads(run.stdout)
        with open(js_out, "rb") as f:
            cls.js_bytes = f.read()

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_js_decodes_both_python_streams(self):
        self.assertEqual(self.js_seen["frames"], N)
        r0, b0 = self.js_seen["means"]["cam0"]
        r1, b1 = self.js_seen["means"]["cam1"]
        self.assertGreater(r0, 150); self.assertLess(b0, 100)
        self.assertGreater(b1, 150); self.assertLess(r1, 100)
        got = np.array(self.js_seen["sig"], dtype=np.uint16).reshape(N, H, W)
        self.assertTrue(np.array_equal(got, SIG), "signal bit-exact through the JS decoder")

    def test_python_decodes_both_js_streams(self):
        out = cz.decode(self.js_bytes)
        self.assertEqual(sorted(out["rgbs"]), ["cam0", "cam1"])
        assert_looks_like(self, out["rgbs"]["cam0"], CAM0, "cam0 (JS-encoded)")
        assert_looks_like(self, out["rgbs"]["cam1"], CAM1, "cam1 (JS-encoded)")
        self.assertTrue(np.array_equal(out["signals"]["disparity"], SIG))

    def test_metadata_is_byte_identical_across_writers(self):
        c_meta = json.loads(json.dumps(cz.parse_metadata(self.py_bytes)))
        js_meta = json.loads(self.js_seen["metadataJson"])
        self.assertEqual(c_meta, js_meta, "C and JS writers must emit the same v3 document")
        # And literally the same bytes in the container tag, not just the same values.
        raw_c = self._raw_tag(self.py_bytes)
        raw_js = self._raw_tag(self.js_bytes)
        self.assertEqual(raw_c, raw_js)

    @staticmethod
    def _raw_tag(data):
        lib = cz._load()
        import ctypes
        buf = (ctypes.c_uint8 * len(data)).from_buffer_copy(data)
        out, n = ctypes.c_char_p(), ctypes.c_size_t()
        rc = lib.dc_get_metadata(buf, len(data), ctypes.byref(out), ctypes.byref(n))
        if rc:
            raise RuntimeError(f"dc_get_metadata failed ({rc})")
        try:
            return ctypes.string_at(out, n.value)
        finally:
            lib.dc_free(ctypes.cast(out, ctypes.POINTER(ctypes.c_uint8)))


if __name__ == "__main__":
    unittest.main()
