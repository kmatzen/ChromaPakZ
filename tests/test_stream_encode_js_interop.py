"""Cross-language: a file streamed *from Python* must decode through the browser library.

tests/test_stream_interop.py already covers the other direction — a browser-streamed fixture read
by the native core. This one closes the loop, and it is the path that matters for wrappers like
worldline, which record from Python (robot, rig, simulator) and play back in a browser.

Both JS decoders are exercised, because they parse differently and a streamed file is exactly
where they can disagree:

  * `createDecoder(bytes)` demuxes a complete buffer;
  * `createDecoder()` + `push()` is the incremental parser, fed the encoder's chunks one at a
    time, in the sizes the encoder actually emitted — so it sees the same byte boundaries a
    network consumer would.

Skipped when node or the JS sources are not around (the cibuildwheel test environment ships
neither).
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

N, H, W = 9, 24, 32
FPS = 3

# Decodes <clip> with both JS decoders and reports what it saw, as JSON on stdout. Chunk sizes are
# passed in so the incremental decoder is fed the encoder's own chunk boundaries rather than an
# arbitrary split.
DECODE_MJS = r"""
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { createDecoder } = await import(pathToFileURL(process.env.CZ_SRC).href);

const bytes = new Uint8Array(readFileSync(process.env.CZ_CLIP));
const sizes = JSON.parse(process.env.CZ_SIZES);
const out = {};

async function drain(dec) {
  const frames = [];
  for await (const f of dec) frames.push(Array.from(f.signals.depth.u16));
  await dec.close();
  return frames;
}

// Buffered: the whole file at once.
const buffered = createDecoder(bytes);
out.metadata = { frames: buffered.metadata.frames, streaming: !!buffered.metadata.streaming,
                 width: buffered.width, height: buffered.height,
                 near: buffered.near, far: buffered.far };
out.buffered = await drain(buffered);

// Incremental: the encoder's own chunks, in order.
const net = createDecoder();
let off = 0;
for (const n of sizes) { net.push(bytes.subarray(off, off + n)); off += n; }
net.finish();
out.network = await drain(net);

process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(HAVE_NODE, "node or src/chromapakz.js not available")
class StreamEncodeJsInterop(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(23)
        cls.depth = rng.integers(1, 65536, (N, H, W)).astype(np.uint16)
        rgb = rng.integers(0, 256, (N, H, W, 4)).astype(np.uint8)

        chunks = []
        enc = cz.create_encoder(W, H, fps=FPS, has_rgb=True, on_chunk=chunks.append,
                                signals=[{"id": "depth", "near": 0.4, "far": 12.0}])
        for i in range(N):
            enc.add_frame(rgb=rgb[i], signals={"depth": cls.depth[i]})
        enc.finish()

        cls._tmp = tempfile.TemporaryDirectory()
        clip = os.path.join(cls._tmp.name, "clip.webm")
        script = os.path.join(cls._tmp.name, "decode.mjs")
        with open(clip, "wb") as f:
            f.write(b"".join(chunks))
        with open(script, "w") as f:
            f.write(DECODE_MJS)
        env = dict(os.environ,
                   CZ_SRC=os.path.abspath(SRC),
                   CZ_CLIP=clip,
                   CZ_SIZES=json.dumps([len(c) for c in chunks]))
        run = subprocess.run(["node", script], capture_output=True, text=True, env=env)
        if run.returncode:
            raise unittest.SkipTest(f"node could not run the JS decoder: {run.stderr.strip()}")
        cls.out = json.loads(run.stdout)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_the_js_reader_sees_a_streamed_file(self):
        meta = self.out["metadata"]
        self.assertIsNone(meta["frames"], "a streamed header declares no frame count")
        self.assertTrue(meta["streaming"])
        self.assertEqual((meta["width"], meta["height"]), (W, H))
        self.assertEqual((meta["near"], meta["far"]), (0.4, 12.0))

    def test_both_js_decoders_reproduce_the_depth_bit_exactly(self):
        for mode in ("buffered", "network"):
            with self.subTest(decoder=mode):
                got = np.array(self.out[mode], dtype=np.uint16)
                self.assertEqual(got.shape, (N, H * W), "frame count from the JS decoder")
                self.assertTrue(np.array_equal(got.reshape(N, H, W), self.depth),
                                f"{mode} JS decode is not bit-exact with what Python encoded")


if __name__ == "__main__":
    unittest.main()
