"""Generate docs/rate-distortion.svg — the codec rate-distortion plot, all methods on one dataset.

PSNR measures the codec's encode/decode path on already-quantized depth (decoded vs source codes).
- ChromaPakZ (VP9): the real WebCodecs codec, swept over QP — lossy curve + the QP0 lossless (∞) point.
- FFV1, PNG-16: lossless comparison codecs → ∞ dB points (they differ only in file size).

The VP9 numbers come from the browser (the actual codec; ffmpeg's libvpx-vp9 lossless is ~3x bloated and
not representative). FFV1/PNG are scored in Python on the exact same codes the browser exported.

    python plot_rd.py            # needs: node+playwright (experiments/), ffmpeg, Pillow, numpy
"""
import base64
import json
import math
import os
import subprocess
import tempfile

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXP = os.path.join(ROOT, "experiments", "webcodecs-lossless")
SIZE, N = 256, 16


def browser_vp9():
    """Run the WebCodecs QP sweep; return (rows, codes[N,H,W])."""
    r = subprocess.run(["node", "run.mjs", "rd", str(SIZE), str(N)], cwd=EXP,
                       capture_output=True, text=True)
    line = next((l for l in r.stdout.splitlines() if l.startswith("RDJSON ")), None)
    if line is None:
        raise SystemExit("no RDJSON from browser sweep:\n" + r.stdout + r.stderr)
    d = json.loads(line[len("RDJSON "):])
    codes = np.frombuffer(base64.b64decode(d["codesB64"]), "<u2").reshape(d["N"], d["H"], d["W"])
    return d, codes


def ffv1_bpp(codes):
    N_, H, W = codes.shape
    with tempfile.TemporaryDirectory() as t:
        raw, out = f"{t}/i.raw", f"{t}/o.mkv"
        codes.astype("<u2").tofile(raw)
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray16le",
                        "-video_size", f"{W}x{H}", "-framerate", "30", "-i", raw,
                        "-c:v", "ffv1", "-level", "3", "-g", "1", out], check=True)
        return os.path.getsize(out) * 8 / (N_ * H * W)


def png_bpp(codes):
    from PIL import Image
    N_, H, W = codes.shape
    total = 0
    for i in range(N_):
        with tempfile.NamedTemporaryFile(suffix=".png") as f:
            Image.fromarray(codes[i]).save(f.name, optimize=True)
            total += os.path.getsize(f.name)
    return total * 8 / (N_ * H * W)


# ── gather ──
d, codes = browser_vp9()
W, H, NN = d["W"], d["H"], d["N"]
lossy = [r for r in d["rows"] if not r["exact"]]
vp9_lossless = next(r for r in d["rows"] if r["exact"])["bpp"]
points = [   # lossless comparison points (∞ dB)
    ("ChromaPakZ · VP9", vp9_lossless, "#16a34a"),
    ("FFV1", ffv1_bpp(codes), "#ef4444"),
    ("PNG-16", png_bpp(codes), "#f59e0b"),
]
print(f"size {W}x{H}x{NN}")
for name, b, _ in points:
    print(f"  {name:18} {b:6.2f} bpp  (lossless, ∞ dB)")
for r in lossy:
    print(f"  VP9 QP{r['qp']:<3}        {r['bpp']:6.2f} bpp  {r['psnr']:.1f} dB")

# ── SVG ──
Wd, Hd, ML, MR, MT, MB = 770, 480, 74, 150, 54, 62
x0, y0, x1, y1 = ML, MT, Wd - MR, Hd - MB
allx = [r["bpp"] for r in lossy] + [b for _, b, _ in points]
ymin = math.floor(min(r["psnr"] for r in lossy) - 3)
ymax = max(r["psnr"] for r in lossy) + 6          # headroom; ∞ band sits above this
xmin, xmax = math.floor(min(allx) - 0.5), math.ceil(max(allx) + 0.5)
inf_y = y0 + 16                                    # the "lossless (∞)" band
mx = lambda x: x0 + (x - xmin) / (xmax - xmin) * (x1 - x0)
my = lambda y: y1 - (y - ymin) / (ymax - ymin) * (y1 - y0)
s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{Wd}" height="{Hd}" font-family="ui-monospace,Menlo,monospace" font-size="12">']
s.append(f'<rect width="{Wd}" height="{Hd}" fill="#fff"/>')
s.append(f'<text x="{(x0+x1)/2}" y="26" text-anchor="middle" font-size="15" font-weight="700">'
         f'ChromaPakZ codec rate–distortion ({W}×{H}×{NN} depth, peak 65535)</text>')
for i in range(6):
    xv = xmin + (xmax - xmin) * i / 5; X = mx(xv)
    s.append(f'<line x1="{X:.1f}" y1="{y0}" x2="{X:.1f}" y2="{y1}" stroke="#eee"/>')
    s.append(f'<text x="{X:.1f}" y="{y1+18}" text-anchor="middle" fill="#555">{xv:.0f}</text>')
    yv = ymin + (ymax - ymin) * i / 5; Y = my(yv)
    s.append(f'<line x1="{x0}" y1="{Y:.1f}" x2="{x1}" y2="{Y:.1f}" stroke="#eee"/>')
    s.append(f'<text x="{x0-8}" y="{Y+4:.1f}" text-anchor="end" fill="#555">{yv:.0f}</text>')
s.append(f'<rect x="{x0}" y="{y0}" width="{x1-x0}" height="{y1-y0}" fill="none" stroke="#ccc"/>')
s.append(f'<text x="{(x0+x1)/2}" y="{Hd-20}" text-anchor="middle" fill="#222">file size (bits / pixel / frame)</text>')
s.append(f'<text x="18" y="{(y0+y1)/2}" text-anchor="middle" fill="#222" transform="rotate(-90 18 {(y0+y1)/2})">PSNR of decoded vs source codes (dB)</text>')
# lossless (∞) band + comparison points
s.append(f'<line x1="{x0}" y1="{inf_y}" x2="{x1}" y2="{inf_y}" stroke="#bbb" stroke-dasharray="5 4"/>')
s.append(f'<text x="{x0+4}" y="{inf_y-5}" fill="#777" font-size="10">lossless · ∞ dB (bit-exact)</text>')
for i, (name, b, col) in enumerate(points):
    s.append(f'<circle cx="{mx(b):.1f}" cy="{inf_y}" r="4.5" fill="{col}"/>')
    dy = 16 if i % 2 == 0 else 28          # stagger so close points (ChromaPakZ/FFV1) don't overlap
    s.append(f'<text x="{mx(b):.1f}" y="{inf_y+dy}" text-anchor="middle" fill="{col}" font-size="10">{b:.1f}</text>')
# VP9 lossy curve
poly = " ".join(f"{mx(r['bpp']):.1f},{my(r['psnr']):.1f}" for r in lossy)
s.append(f'<polyline points="{poly}" fill="none" stroke="#2563eb" stroke-width="2"/>')
for r in lossy:
    s.append(f'<circle cx="{mx(r["bpp"]):.1f}" cy="{my(r["psnr"]):.1f}" r="3.2" fill="#2563eb"/>')
    s.append(f'<text x="{mx(r["bpp"]):.1f}" y="{my(r["psnr"])-8:.1f}" text-anchor="middle" fill="#2563eb" font-size="10">QP{r["qp"]}</text>')
# legend
ly = y0 + 40
for label, col in [("ChromaPakZ VP9", "#16a34a"), ("FFV1", "#ef4444"),
                   ("PNG-16", "#f59e0b"), ("VP9 lossy", "#2563eb")]:
    s.append(f'<rect x="{x1+14}" y="{ly-9}" width="11" height="11" fill="{col}"/>')
    s.append(f'<text x="{x1+29}" y="{ly+1}" fill="#222" font-size="11">{label}</text>'); ly += 19
s.append('</svg>')
open(os.path.join(ROOT, "docs", "rate-distortion.svg"), "w").write("\n".join(s))
print("\nwrote docs/rate-distortion.svg")
