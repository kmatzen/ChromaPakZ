"""Regression: a browser-streamed file (unknown-size Segment, "frames":null) must decode
bit-exact through the C++/Python core.

The JS streaming muxer (createEncoder({onChunk})) emits an unknown-size Segment and omits the
frame count from the header. The native demuxer therefore has to (a) recognise the all-ones EBML
size marker and (b) recover the frame count by counting blocks. tests/fixtures/stream.webm is a
real WASM-encoded streamed clip; regenerate it with tests/fixtures/regen_stream.mjs.
"""
import os
import numpy as np
import chromapakz as cz

HERE = os.path.dirname(os.path.abspath(__file__))
N, H, W = 5, 24, 40
data = open(os.path.join(HERE, "fixtures", "stream.webm"), "rb").read()
expected = np.fromfile(os.path.join(HERE, "fixtures", "stream_depth.u16"), dtype="<u2").reshape(N, H, W)

# The header carries no count; probe() must recover it from the blocks, not trust metadata.
info = cz.probe(data)
assert info["frames"] == N, f"frame count from streamed file: {info['frames']} != {N}"
assert (info["width"], info["height"]) == (W, H)
assert cz.parse_metadata(data)["frames"] is None, "streamed metadata should carry frames:null"

for sid in ("depth", "objectId"):
    got = cz.decode_signal(data, sid)
    assert got.shape == (N, H, W), f"{sid} shape {got.shape}"
    assert np.array_equal(got, expected), f"{sid} not bit-exact from streamed file"

print("stream_interop OK — unknown-size Segment decodes bit-exact in the native core")
