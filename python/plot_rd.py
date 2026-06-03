"""Rate-distortion plot: depth PSNR vs file size as the quantization precision sweeps.

Lossless depth has zero distortion vs the stored codes, so the meaningful R-D curve comes from
the precision knob: each depth-bits setting is an operating point (file size, PSNR-vs-original-float).
Overlays competing lossless codecs at equal distortion. Writes docs/rate-distortion.svg (no deps).
"""
import os, subprocess, tempfile, sys, math
import numpy as np
sys.path.insert(0, ".")
import chromapakz as dc, webm_inspect

z = np.load("sample_rgbd.npz"); depth = z["depth"].astype(np.float32)
N, H, W = depth.shape; PX = N * W * H
valid = np.isfinite(depth) & (depth > 0)
near = float(np.percentile(depth[valid], 1)); far = float(np.percentile(depth[valid], 99))
PEAK = far


def psnr(levels):
    c = dc.quantize_inverse(depth, near, far, levels)
    r = dc.dequantize_inverse(c, near, far, levels)
    m = valid & np.isfinite(r)
    mse = float(np.mean((r[m].astype(np.float64) - depth[m].astype(np.float64)) ** 2))
    return c, (20 * math.log10(PEAK / math.sqrt(mse)) if mse > 0 else float("inf"))


def chromapakz_bpp(c, levels):
    data = dc.encode_depth(c, fps=30, near=near, far=far, levels=levels)
    b = sum(t["bytes"] for t in webm_inspect.track_sizes(data).values() if t["name"].startswith("depth"))
    return b * 8 / PX


def ffmpeg_bpp(c, args, pix="gray16le"):
    with tempfile.TemporaryDirectory() as d:
        raw = os.path.join(d, "i.raw"); out = os.path.join(d, "o.mkv")
        c.astype("<u2").tofile(raw)
        r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", pix,
                            "-video_size", f"{W}x{H}", "-framerate", "30", "-i", raw, *args, out],
                           capture_output=True)
        return (os.path.getsize(out) * 8 / PX) if r.returncode == 0 else None


def png_bpp(c):
    from PIL import Image
    t = 0
    for i in range(N):
        with tempfile.NamedTemporaryFile(suffix=".png") as f:
            Image.fromarray(c[i]).save(f.name, optimize=True); t += os.path.getsize(f.name)
    return t * 8 / PX


BITS = [8, 9, 10, 11, 12, 13, 14, 16]
series = {"ChromaPakZ (VP9 lossless)": [], "FFV1": [], "PNG-16": []}
print(f"{'bits':>5} {'PSNR dB':>9} {'ChromaPakZ bpp':>15} {'FFV1 bpp':>10} {'PNG bpp':>9}")
for bits in BITS:
    L = 1 << bits
    c, p = psnr(L)
    cz = chromapakz_bpp(c, L)
    fv = ffmpeg_bpp(c, ["-c:v", "ffv1", "-level", "3", "-g", "1"])
    pn = png_bpp(c)
    series["ChromaPakZ (VP9 lossless)"].append((cz, p, bits))
    series["FFV1"].append((fv, p, bits))
    series["PNG-16"].append((pn, p, bits))
    print(f"{bits:>5} {p:>9.1f} {cz:>12.2f} {fv:>10.2f} {pn:>9.2f}")

# ── hand-rolled SVG ──
Wsvg, Hsvg = 760, 480
ML, MR, MT, MB = 74, 24, 54, 64
px0, py0, px1, py1 = ML, MT, Wsvg - MR, Hsvg - MB
allx = [x for s in series.values() for x, y, b in s if x]
ally = [y for s in series.values() for x, y, b in s if x]
xmin, xmax = math.floor(min(allx)), math.ceil(max(allx))
ymin, ymax = round(min(ally) - 0.2, 1), round(max(ally) + 0.2, 1)
mx = lambda x: px0 + (x - xmin) / (xmax - xmin) * (px1 - px0)
my = lambda y: py1 - (y - ymin) / (ymax - ymin) * (py1 - py0)
COL = {"ChromaPakZ (VP9 lossless)": "#2563eb", "FFV1": "#ef4444", "PNG-16": "#10b981"}

s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{Wsvg}" height="{Hsvg}" font-family="ui-monospace,Menlo,monospace" font-size="12">']
s.append(f'<rect width="{Wsvg}" height="{Hsvg}" fill="#ffffff"/>')
s.append(f'<text x="{Wsvg/2}" y="26" text-anchor="middle" font-size="15" font-weight="700">'
         f'ChromaPakZ rate-distortion: lossless depth vs precision ({W}×{H}×{N}, noisy synthetic)</text>')
# gridlines + ticks
for i in range(6):
    xv = xmin + (xmax - xmin) * i / 5; X = mx(xv)
    s.append(f'<line x1="{X:.1f}" y1="{py0}" x2="{X:.1f}" y2="{py1}" stroke="#eee"/>')
    s.append(f'<text x="{X:.1f}" y="{py1+18}" text-anchor="middle" fill="#555">{xv:.0f}</text>')
    yv = ymin + (ymax - ymin) * i / 5; Y = my(yv)
    s.append(f'<line x1="{px0}" y1="{Y:.1f}" x2="{px1}" y2="{Y:.1f}" stroke="#eee"/>')
    s.append(f'<text x="{px0-8}" y="{Y+4:.1f}" text-anchor="end" fill="#555">{yv:.1f}</text>')
s.append(f'<rect x="{px0}" y="{py0}" width="{px1-px0}" height="{py1-py0}" fill="none" stroke="#ccc"/>')
s.append(f'<text x="{(px0+px1)/2}" y="{Hsvg-22}" text-anchor="middle" fill="#222">file size  (bits / pixel / frame)</text>')
s.append(f'<text x="20" y="{(py0+py1)/2}" text-anchor="middle" fill="#222" transform="rotate(-90 20 {(py0+py1)/2})">depth PSNR vs original (dB)</text>')
# series
for name, pts in series.items():
    pts = [(x, y, b) for x, y, b in pts if x]
    poly = " ".join(f"{mx(x):.1f},{my(y):.1f}" for x, y, b in pts)
    s.append(f'<polyline points="{poly}" fill="none" stroke="{COL[name]}" stroke-width="2"/>')
    for x, y, b in pts:
        s.append(f'<circle cx="{mx(x):.1f}" cy="{my(y):.1f}" r="3.2" fill="{COL[name]}"/>')
    if name.startswith("ChromaPakZ"):
        for x, y, b in pts:
            s.append(f'<text x="{mx(x):.1f}" y="{my(y)-8:.1f}" text-anchor="middle" fill="#2563eb" font-size="10">{b}b</text>')
# legend (short names so it fits inside the plot)
ly = py0 + 14
for name in series:
    s.append(f'<rect x="{px1-150}" y="{ly-9}" width="12" height="12" fill="{COL[name]}"/>')
    s.append(f'<text x="{px1-134}" y="{ly+1}" fill="#222">{name.split(" (")[0]}</text>'); ly += 20
s.append(f'<text x="{px1-150}" y="{ly+2}" fill="#777" font-size="10">labels = depth-bits</text>')
s.append("</svg>")

os.makedirs("../docs", exist_ok=True)
open("../docs/rate-distortion.svg", "w").write("\n".join(s))
print("\nwrote docs/rate-distortion.svg")
