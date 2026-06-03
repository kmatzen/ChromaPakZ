"""chromapakz ingestion — turn real RGBD data into a chromapakz .webm.

Loads depth (EXR float / .npy / .npz / 16-bit PNG-TIFF / raw) and optional RGB
(image sequence / video / array), applies inverse-depth quantization (auto near/far
by default), encodes, and reports real per-track bits-per-pixel.

API:
    from ingest import encode_clip, load_depth, load_rgb, auto_near_far
    data, stats = encode_clip(depth=depth_NHW_float, rgb=rgb_NHWc, near=None, far=None)

CLI:
    python ingest.py --depth 'frames/d_*.exr' --rgb 'frames/rgb_*.png' -o clip.webm
    python ingest.py --depth clip.npz -o clip.webm --report
"""
import glob
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import chromapakz as dc
import webm_inspect


# ── near/far + quantization ─────────────────────────────────────────────────
def auto_near_far(depth, lo=1.0, hi=99.0):
    """Inverse-depth range from valid-pixel percentiles (ignores <=0 / non-finite)."""
    v = depth[np.isfinite(depth) & (depth > 0)]
    if v.size == 0:
        raise ValueError("no valid (>0, finite) depth samples")
    near = float(np.percentile(v, lo))
    far = float(np.percentile(v, hi))
    if near <= 0:
        near = float(v[v > 0].min())
    if far <= near:
        far = near * 1.0001 + 1e-6
    return near, far


def to_codes(depth, near, far, levels=dc.LEVELS_FULL):
    """Float depth -> uint16 inverse-depth codes (matches C++/JS exactly; 0 == invalid)."""
    return dc.quantize_inverse(np.ascontiguousarray(depth, np.float32), near, far, levels)


# ── loaders ─────────────────────────────────────────────────────────────────
def _is_glob(p):
    return any(c in p for c in "*?[")


def _imread(path):
    try:
        import imageio.v3 as iio
        return np.asarray(iio.imread(path))
    except ImportError:
        try:
            from PIL import Image
            return np.asarray(Image.open(path))
        except ImportError:
            raise ImportError(f"reading {os.path.splitext(path)[1]} needs `imageio` or `Pillow`")


def load_depth(path, dtype=None, shape=None):
    """Load depth into (N, H, W). Accepts a single file, a glob of per-frame files,
    or an array file already shaped (N,H,W). raw/.bin needs dtype=('float32'|'uint16') and shape=(H,W)."""
    files = sorted(glob.glob(path)) if _is_glob(path) else [path]
    if not files:
        raise FileNotFoundError(path)
    frames = []
    for f in files:
        ext = os.path.splitext(f)[1].lower()
        if ext == ".npy":
            a = np.load(f)
        elif ext == ".npz":
            z = np.load(f)
            a = z["depth"] if "depth" in z else z[list(z.keys())[0]]
        elif ext in (".exr",):
            a = _imread(f).astype(np.float32)
            if a.ndim == 3:
                a = a[..., 0]                         # depth in R channel
        elif ext in (".png", ".tif", ".tiff", ".pgm"):
            a = _imread(f)
            if a.ndim == 3:
                a = a[..., 0]
        elif ext in (".raw", ".bin"):
            if dtype is None or shape is None:
                raise ValueError("raw depth needs dtype= and shape=(H,W)")
            a = np.fromfile(f, dtype=np.dtype(dtype)).reshape(shape)
        else:
            raise ValueError(f"unsupported depth format: {ext}")
        frames.append(a)
    arr = frames[0] if len(frames) == 1 else np.stack(frames)
    if arr.ndim == 2:
        arr = arr[None]
    return arr


def load_rgb(path, n=None, dtype_hint=None):
    """Load RGB into (N, H, W, 3|4) uint8. Accepts image glob/file, an array file, or a video."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".mp4", ".mov", ".mkv", ".webm", ".avi") and not _is_glob(path):
        return _load_video_rgba(path)
    if ext in (".npy", ".npz") and not _is_glob(path):
        z = np.load(path)
        a = z["rgb"] if (ext == ".npz" and "rgb" in z) else (z[list(z.keys())[0]] if ext == ".npz" else z)
        return a.astype(np.uint8)
    files = sorted(glob.glob(path)) if _is_glob(path) else [path]
    frames = [np.asarray(_imread(f)) for f in files]
    arr = frames[0] if len(frames) == 1 else np.stack(frames)
    if arr.ndim == 3 and arr.shape[-1] in (3, 4):
        arr = arr[None] if len(files) == 1 else arr
    return arr.astype(np.uint8)


def _load_video_rgba(path):
    """Pull every frame of a video as RGBA via ffmpeg (handles any codec ffmpeg supports)."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=,", path],
        capture_output=True, text=True, check=True)
    W, H = (int(x) for x in probe.stdout.strip().split(","))
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo",
                          "-pix_fmt", "rgba", "pipe:1"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W, 4).copy()


# ── encode + report ──────────────────────────────────────────────────────────
def encode_clip(depth=None, rgb=None, near=None, far=None, fps=30, rgb_kbps=2000, levels=dc.LEVELS_FULL):
    """Encode depth (float or uint16, (N,H,W)) and/or rgb ((N,H,W,3|4) uint8) to webm bytes.
    Returns (data, stats). Float depth is inverse-depth quantized (auto near/far if None).
    levels = inverse-depth quantization steps (default 65536 = full 16-bit; fewer = smaller files)."""
    codes = None
    if depth is not None:
        depth = np.asarray(depth)
        if np.issubdtype(depth.dtype, np.floating):
            if near is None or far is None:
                near, far = auto_near_far(depth)
            codes = to_codes(depth, near, far, levels)
        else:
            codes = depth.astype(np.uint16)
            near, far = near or 0.2, far or 10.0
    rgba = None
    if rgb is not None:
        rgb = np.asarray(rgb, np.uint8)
        rgba = rgb if rgb.shape[-1] == 4 else np.concatenate(
            [rgb, np.full(rgb.shape[:-1] + (1,), 255, np.uint8)], axis=-1)

    if codes is not None and rgba is not None and codes.shape != rgba.shape[:3]:
        raise ValueError(f"depth {codes.shape} vs rgb {rgba.shape[:3]} dimension mismatch")

    data = dc.encode_rgbd(rgba, codes, fps=fps, near=near or 0.2, far=far or 10.0,
                          rgb_kbps=rgb_kbps, levels=levels)

    shape = (codes if codes is not None else rgba).shape
    N, H, W = shape[0], shape[1], shape[2]
    stats = {"bytes": len(data), "N": N, "W": W, "H": H, "near": near, "far": far, "levels": levels,
             "fps": fps, "bpp_total": len(data) * 8 / (W * H * N)}
    if codes is not None:
        stats["valid_pct"] = 100.0 * np.count_nonzero(codes) / codes.size
    stats["tracks"] = {}
    for num, t in webm_inspect.track_sizes(data).items():
        stats["tracks"][num] = {**t, "bpp": t["bytes"] * 8 / (W * H * N)}
    return data, stats


def print_report(stats):
    print(f"  {stats['W']}×{stats['H']} × {stats['N']} frames @ {stats['fps']}fps   "
          f"file={stats['bytes']/1024:.1f} KiB   total={stats['bpp_total']:.3f} bpp")
    if "valid_pct" in stats:
        bits = (stats["levels"]).bit_length() - 1
        print(f"  near={stats['near']:.4g} far={stats['far']:.4g}   levels={stats['levels']} (~{bits}-bit)"
              f"   valid depth={stats['valid_pct']:.1f}%")
    print("  track  name        frames    bytes      bpp")
    for num, t in stats["tracks"].items():
        print(f"  {num:<6} {t['name']:<11} {t['frames']:>4}   {t['bytes']:>9}   {t['bpp']:.3f}")


def _main(argv):
    import argparse
    ap = argparse.ArgumentParser(description="Ingest RGBD data into a chromapakz .webm")
    ap.add_argument("--depth", help="depth file or glob (.exr/.npy/.npz/.png/.tif/.raw)")
    ap.add_argument("--rgb", help="rgb file/glob/video")
    ap.add_argument("--near", type=float)
    ap.add_argument("--far", type=float)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--rgb-kbps", type=int, default=2000)
    ap.add_argument("--depth-bits", type=int, default=16,
                    help="inverse-depth precision (default 16 = full); fewer = smaller files, matches sensor noise")
    ap.add_argument("--raw-dtype", help="for raw depth: float32|uint16")
    ap.add_argument("--raw-shape", help="for raw depth: HxW e.g. 480x640")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--verify", action="store_true", help="decode back and assert depth bit-exact")
    a = ap.parse_args(argv)

    depth = rgb = None
    if a.depth:
        shape = tuple(int(x) for x in a.raw_shape.split("x")) if a.raw_shape else None
        depth = load_depth(a.depth, dtype=a.raw_dtype, shape=shape)
    if a.rgb:
        rgb = load_rgb(a.rgb)
    levels = 1 << a.depth_bits
    data, stats = encode_clip(depth=depth, rgb=rgb, near=a.near, far=a.far, fps=a.fps,
                              rgb_kbps=a.rgb_kbps, levels=levels)
    open(a.out, "wb").write(data)
    print(f"wrote {a.out}")
    if a.report:
        print_report(stats)
    if a.verify and depth is not None:
        codes = depth.astype(np.uint16) if not np.issubdtype(depth.dtype, np.floating) \
            else to_codes(depth, stats["near"], stats["far"], levels)
        back = dc.decode_depth(data)
        ok = np.array_equal(back, codes)
        print(f"  verify: depth codes bit-exact = {'YES' if ok else 'NO (maxΔ=%d)' % np.abs(back.astype(int)-codes).max()}")


if __name__ == "__main__":
    _main(sys.argv[1:])
