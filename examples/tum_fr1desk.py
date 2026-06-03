"""Example: real Kinect RGBD from the TUM RGB-D dataset, encoded losslessly with ChromaPakZ.

The TUM data isn't redistributed here (their terms ask you to cite the paper, not re-host), so fetch
it first — about 344 MB for the smallest sequence, fr1/desk:

    curl -L -o /tmp/fr1desk.tgz \\
      https://cvg.cit.tum.de/rgbd/dataset/freiburg1/rgbd_dataset_freiburg1_desk.tgz
    mkdir -p /tmp/tum && tar xzf /tmp/fr1desk.tgz -C /tmp/tum
    python examples/tum_fr1desk.py /tmp/tum/rgbd_dataset_freiburg1_desk

TUM depth is a 16-bit PNG in millimetres × 5000 (0 = no reading) — ChromaPakZ carries those exact codes
losslessly. Dataset: J. Sturm, N. Engelhard, F. Endres, W. Burgard, D. Cremers, "A Benchmark for the
Evaluation of RGB-D SLAM Systems", IROS 2012. https://cvg.cit.tum.de/data/datasets/rgbd-dataset
"""
import glob
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "python"))
import chromapakz as cz
import webm_inspect

base = sys.argv[1] if len(sys.argv) > 1 else "/tmp/tum/rgbd_dataset_freiburg1_desk"
n = int(sys.argv[2]) if len(sys.argv) > 2 else 30

dpng = sorted(glob.glob(os.path.join(base, "depth", "*.png")))[:n]
rpng = sorted(glob.glob(os.path.join(base, "rgb", "*.png")))[:n]
if not dpng:
    raise SystemExit(f"no depth PNGs under {base}/depth — see the download note at the top of this file")

depth = np.stack([np.asarray(Image.open(p)).astype(np.uint16) for p in dpng])      # mm*5000, 0 = invalid
rgb = np.stack([np.asarray(Image.open(p).convert("RGB")) for p in rpng]).astype(np.uint8)
N, H, W = depth.shape
valid = depth > 0
rgba = np.concatenate([rgb, np.full((N, H, W, 1), 255, np.uint8)], axis=-1)

data = cz.encode_rgbd(rgba, depth, fps=30, near=0.5, far=5.0)
px = N * W * H
ok = np.array_equal(cz.decode_depth(data), depth)

print(f"TUM fr1/desk · {N} frames {W}×{H} · valid depth {100*valid.mean():.0f}% · "
      f"range {depth[valid].min()/5000:.2f}–{depth[valid].max()/5000:.2f} m")
print(f"file {len(data)/1024:.0f} KiB · total {len(data)*8/px:.2f} bpp · depth bit-exact: {ok}")
for num, t in webm_inspect.track_sizes(data).items():
    print(f"  track {num}  {t['name']:<9} {t['bytes']*8/px:6.3f} bpp")
out = os.path.join(os.path.dirname(__file__), "tum_fr1desk.webm")
open(out, "wb").write(data)
print(f"wrote {out}")
