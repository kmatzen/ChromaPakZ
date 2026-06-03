"""Head-to-head lossless-depth compression benchmark: depthcodec vs every credible alternative.

Same uint16 depth fed to each codec; reports bits/pixel. Run from python/:
    python benchmark_codecs.py
Requires ffmpeg (ffv1/x265/x264), Pillow (PNG-16); JPEG-XL/AV1 noted if absent.
"""
import os, subprocess, tempfile, lzma, zlib, bz2, sys
import numpy as np
sys.path.insert(0, ".")
import depthcodec as dc, webm_inspect

NPZ = "sample_rgbd.npz"
if not os.path.exists(NPZ):
    import make_synthetic_rgbd as m
    d, r = m.make(); np.savez_compressed(NPZ, depth=d, rgb=r)

z = np.load(NPZ); depth = z["depth"]
N, H, W = depth.shape
valid = np.isfinite(depth) & (depth > 0)
near = float(np.percentile(depth[valid], 1)); far = float(np.percentile(depth[valid], 99))
PX = N * W * H
bpp = lambda b: b * 8 / PX


def codes(levels):
    return dc.quantize_inverse(depth.astype(np.float32), near, far, levels)


def run(cmd, stdin=None):
    return subprocess.run(cmd, input=stdin, capture_output=True)


def ffmpeg_size(codes16, args, pix="gray16le", suffix=".mkv"):
    """Encode a gray raw stream with ffmpeg `args`, return output bytes (or None on failure)."""
    with tempfile.TemporaryDirectory() as d:
        raw = os.path.join(d, "in.raw"); out = os.path.join(d, "out" + suffix)
        codes16.astype("<u2").tofile(raw)
        cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", pix,
               "-video_size", f"{W}x{H}", "-framerate", "30", "-i", raw, *args, out]
        r = run(cmd)
        if r.returncode != 0 or not os.path.exists(out):
            return None, r.stderr.decode()[:120]
        return os.path.getsize(out), None


def png16_size(codes16):
    from PIL import Image
    total = 0
    for i in range(N):
        with tempfile.NamedTemporaryFile(suffix=".png") as f:
            Image.fromarray(codes16[i], mode="I;16").save(f.name, optimize=True)
            total += os.path.getsize(f.name)
    return total


def depthcodec_size(c16, levels):
    data = dc.encode_depth(c16, fps=30, near=near, far=far, levels=levels)
    ts = webm_inspect.track_sizes(data)
    return sum(t["bytes"] for t in ts.values() if t["name"].startswith("depth"))


def bench(levels, label):
    bits = levels.bit_length() - 1
    c16 = codes(levels)
    rows = []
    rows.append(("depthcodec (VP9 lossless, tri-fold 8+8, inter)", depthcodec_size(c16, levels), "video"))
    s, _ = ffmpeg_size(c16, ["-c:v", "ffv1", "-level", "3", "-g", "1"]); rows.append(("FFV1 (16-bit, intra)", s, "intra"))
    rows.append(("PNG-16 per frame (intra)", png16_size(c16), "intra"))
    if bits <= 12:
        c12 = (c16 >> max(0, bits - 12)) if bits > 12 else c16
        s, e = ffmpeg_size(c16, ["-pix_fmt", "gray12le", "-c:v", "libx265",
                                 "-x265-params", "lossless=1:log-level=none"], pix="gray12le")
        rows.append((f"x265/HEVC lossless 12-bit ({'patent pool' if s else e})", s, "video"))
    # x264 on the triangle-folded 8+8 planes (the GPL old-codec family)
    hi = (c16 >> 8).astype(np.uint8); lo = (c16 & 0xff).astype(np.uint8)
    h = (c16 >> 8); folded = np.where(h & 1, 255 - (c16 & 0xff), c16 & 0xff).astype(np.uint8)
    sh, _ = ffmpeg_size(hi, ["-c:v", "libx264", "-qp", "0"], pix="gray", suffix=".mkv")
    sl, _ = ffmpeg_size(folded, ["-c:v", "libx264", "-qp", "0"], pix="gray", suffix=".mkv")
    rows.append(("x264 lossless 8+8 tri-fold (GPL)", (sh + sl) if sh and sl else None, "video"))
    # generic byte compressors on raw uint16
    raw = c16.astype("<u2").tobytes()
    rows.append(("raw uint16 + LZMA -9e", len(lzma.compress(raw, preset=9 | lzma.PRESET_EXTREME)), "generic"))
    rows.append(("raw uint16 + zlib -9", len(zlib.compress(raw, 9)), "generic"))
    rows.append(("raw uint16 + bzip2 -9", len(bz2.compress(raw, 9)), "generic"))
    rows.append(("raw uint16 (uncompressed)", len(raw), "—"))

    print(f"\n=== {label}: {W}×{H}×{N}, near={near:.2f} far={far:.2f}, ~{bits}-bit grid, {100*valid.mean():.0f}% valid ===")
    print(f"{'codec':<48}{'bpp':>9}   {'vs depthcodec':>14}")
    print("-" * 76)
    base = next(b for n, b, _ in rows if n.startswith("depthcodec"))
    for name, b, kind in rows:
        if b is None:
            print(f"{name:<48}{'—':>9}   (unavailable)")
            continue
        rel = (b / base - 1) * 100
        print(f"{name:<48}{bpp(b):>9.3f}   {('+' if rel>=0 else '')+f'{rel:.0f}%':>14}")


bench(65536, "Full 16-bit (realistic noisy depth)")
bench(2048, "Matched 11-bit precision (noise-floor-matched)")
