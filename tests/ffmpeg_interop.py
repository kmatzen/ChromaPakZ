"""Regression test: a conformant external decoder (ffmpeg) must reproduce ChromaPakZ depth bit-exactly.

Guards the color-range contract — the depth stream must signal full range so ffmpeg returns the luma
unscaled. Needs ffmpeg/ffprobe on PATH plus an installed `chromapakz`. Exits nonzero on failure.
"""
import subprocess
import tempfile

import numpy as np
import chromapakz as cz

rng = np.random.default_rng(1)
N, H, W = 6, 48, 64
depth = rng.integers(5000, 45000, size=(N, H, W)).astype(np.uint16)  # depth signal → tracks 2,3 (no RGB)
data = cz.encode({"depth": depth}, specs={"depth": cz.inverse_depth_spec(0.2, 10.0)})


def gray(path, stream):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", f"0:{stream}",
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8)[:N * H * W].reshape(N, H, W)


with tempfile.TemporaryDirectory() as t:
    f = f"{t}/clip.webm"
    open(f, "wb").write(data)

    cr = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                         "-show_entries", "stream=color_range", "-of", "csv=p=0", f],
                        capture_output=True, text=True).stdout.strip()
    assert cr == "pc", f"depth stream must signal full range, got color_range={cr!r}"

    hi, lo = gray(f, 0), gray(f, 1)                       # ffmpeg streams 0,1 = depth-hi, depth-lo
    l = np.where(hi & 1, 255 - lo, lo).astype(np.uint16)  # invert the triangle-fold
    recovered = (hi.astype(np.uint16) << 8) | l
    assert np.array_equal(recovered, depth), "ffmpeg-decoded depth is not bit-exact"
    assert np.array_equal(cz.decode_signal(data, "depth"), depth), "native decode bit-exact"

print("ffmpeg decode interop OK — full range signaled, depth bit-exact")
