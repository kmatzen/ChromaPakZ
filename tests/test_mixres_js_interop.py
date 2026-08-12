"""Cross-language: a mixed-resolution (format v4) file written by Python must decode through
the browser library — depth at its own low resolution beside full-resolution RGB, which is the
feature's motivating case. Both JS decoders run (buffered and incremental), because they parse
differently; the streamed take is fed to the incremental one at the encoder's own chunk
boundaries. The reverse direction — a JS-written v4 file through the native decoder — is
tests/js_mixed_resolution.test.mjs plus the shared-writer guarantees the metadata tests pin.

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

N, H, W = 5, 48, 64
DH, DW = 24, 32
FPS = 5

DECODE_MJS = r"""
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { createDecoder } = await import(pathToFileURL(process.env.CZ_SRC).href);

const bytes = new Uint8Array(readFileSync(process.env.CZ_CLIP));
const sizes = process.env.CZ_SIZES ? JSON.parse(process.env.CZ_SIZES) : null;
const out = {};

async function drain(dec) {
  const frames = [];
  for await (const f of dec) {
    frames.push({
      depth: Array.from(f.signals.depth.u16),
      rgbLen: f.rgb ? f.rgb.length : 0,
    });
  }
  await dec.close();
  return frames;
}

const buffered = createDecoder(bytes, { backend: 'wasm' });
out.version = buffered.metadata.version;
const depthMeta = buffered.metadata.signals.find(s => s.id === 'depth');
out.depthDims = [depthMeta.width ?? buffered.width, depthMeta.height ?? buffered.height];
out.fileDims = [buffered.width, buffered.height];
out.buffered = await drain(buffered);

if (sizes) {
  const net = createDecoder(undefined, { backend: 'wasm' });
  let off = 0;
  for (const n of sizes) { net.push(bytes.subarray(off, off + n)); off += n; }
  net.finish();
  out.network = await drain(net);
}

process.stdout.write(JSON.stringify(out));
"""


def _run_node(clip_path, sizes=None):
    env = dict(os.environ, CZ_SRC=SRC, CZ_CLIP=clip_path)
    if sizes is not None:
        env["CZ_SIZES"] = json.dumps(sizes)
    res = subprocess.run(
        ["node", "--input-type=module", "-e", DECODE_MJS],
        env=env, capture_output=True, text=True, timeout=300,
    )
    if res.returncode != 0:
        raise AssertionError(f"node decode failed:\n{res.stderr}")
    return json.loads(res.stdout)


@unittest.skipUnless(HAVE_NODE, "needs node and the JS sources")
class MixedResolutionJsInterop(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(3)
        cls.depth = rng.integers(0, 65536, (N, DH, DW)).astype(np.uint16)
        cls.rgb = rng.integers(0, 256, (N, H, W, 4)).astype(np.uint8)

    def _assert_frames(self, frames):
        self.assertEqual(len(frames), N)
        for i, f in enumerate(frames):
            got = np.asarray(f["depth"], dtype=np.uint16).reshape(DH, DW)
            self.assertTrue(np.array_equal(got, self.depth[i]), f"frame {i} depth differs")
            self.assertEqual(f["rgbLen"], W * H * 4)

    def test_batch_file_decodes_in_js(self):
        data = cz.encode({"depth": self.depth}, rgb=self.rgb, fps=FPS)
        with tempfile.TemporaryDirectory() as d:
            clip = os.path.join(d, "clip.webm")
            with open(clip, "wb") as f:
                f.write(data)
            out = _run_node(clip)
        self.assertEqual(out["version"], 4)
        self.assertEqual(out["depthDims"], [DW, DH])
        self.assertEqual(out["fileDims"], [W, H])
        self._assert_frames(out["buffered"])

    def test_streamed_file_decodes_in_both_js_decoders(self):
        enc = cz.create_encoder(W, H, fps=FPS, has_rgb=True,
                                signals=[{"id": "depth", "width": DW, "height": DH}])
        chunks = [enc.header]
        for i in range(N):
            chunks.append(enc.add_frame(rgb=self.rgb[i], signals={"depth": self.depth[i]}))
        chunks.append(enc.finish())
        enc.close()
        data = b"".join(chunks)
        with tempfile.TemporaryDirectory() as d:
            clip = os.path.join(d, "clip.webm")
            with open(clip, "wb") as f:
                f.write(data)
            out = _run_node(clip, sizes=[len(c) for c in chunks])
        self.assertEqual(out["version"], 4)
        self.assertEqual(out["depthDims"], [DW, DH])
        self._assert_frames(out["buffered"])
        self._assert_frames(out["network"])


if __name__ == "__main__":
    unittest.main()
