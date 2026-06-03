"""Generate a realistic synthetic RGBD clip and save it as an .npz (depth float + rgb uint8).

A stand-in for real sensor data until you have some — exercises the things that drive
lossless-depth bitrate: smooth surfaces, sharp depth edges, distance-dependent noise
(modeled in the disparity domain, as real stereo/ToF noise is), occlusion shadows, and
dropout holes (invalid == 0). Run, then feed the .npz straight through ingest.py.

    python make_synthetic_rgbd.py           # -> sample_rgbd.npz
    python ingest.py --depth sample_rgbd.npz --rgb sample_rgbd.npz -o real.webm --report --verify
"""
import numpy as np


def make(W=320, H=240, N=30, seed=7, fx=380.0, baseline=0.055, disp_noise_px=0.4):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    v = yy / (H - 1)                                   # 0 top .. 1 bottom
    horizon = 0.45

    depth = np.empty((N, H, W), np.float32)
    rgb = np.empty((N, H, W, 3), np.uint8)

    for f in range(N):
        # ── geometry: back wall above the horizon, tilted floor below ──
        Z = np.where(v < horizon, 6.0, 0.9 + (1.0 - v) * 9.0).astype(np.float32)
        Z += 0.15 * np.sin(xx / W * 6.28)              # gentle wall/floor undulation

        # ── a sphere drifting across, closer to the camera ──
        cx = W * (0.2 + 0.6 * f / max(1, N - 1))
        cy = H * 0.55
        r = min(W, H) * 0.18
        d2 = (xx - cx) ** 2 + (yy - cy) ** 2
        inside = d2 < r * r
        zc = 1.8
        bump = np.sqrt(np.clip(r * r - d2, 0, None)) / r * 0.35
        Zs = zc - bump
        Z = np.where(inside, Zs, Z)

        # ── distance-dependent noise via the disparity domain ──
        disp = fx * baseline / Z
        disp = disp + rng.normal(0, disp_noise_px, size=Z.shape).astype(np.float32)
        Z = (fx * baseline / np.maximum(disp, 1e-3)).astype(np.float32)

        # ── invalids (== 0): occlusion shadow beside the sphere + speckle dropout ──
        shadow = ((xx - (cx + r)) ** 2 / (r * 0.8) ** 2 + (yy - cy) ** 2 / r ** 2 < 1) & ~inside
        speckle = rng.random(Z.shape) < 0.015
        Z[shadow | speckle] = 0.0
        Z.ravel()[rng.integers(0, Z.size, size=Z.size // 500)] = np.nan  # a few NaNs too

        # ── plausible shading for the RGB pair ──
        light = (0.55 + 0.45 * (1.0 - v))[..., None]
        sph_shade = (0.5 + 0.6 * bump / 0.35)[..., None]
        wall = np.array([70, 95, 135], np.float32)
        floor = np.array([120, 118, 110], np.float32)
        ball = np.array([205, 70, 55], np.float32)
        col = np.where((v < horizon)[..., None], wall, floor) * light
        col = np.where(inside[..., None], ball * sph_shade, col)
        col += rng.normal(0, 4, col.shape)             # mild sensor grain
        rgb[f] = np.clip(col, 0, 255).astype(np.uint8)
        depth[f] = Z

    return depth, rgb


if __name__ == "__main__":
    depth, rgb = make()
    np.savez_compressed("sample_rgbd.npz", depth=depth, rgb=rgb)
    valid = np.isfinite(depth) & (depth > 0)
    print(f"wrote sample_rgbd.npz: depth{depth.shape} rgb{rgb.shape}")
    print(f"  valid depth {100*valid.mean():.1f}%   range {depth[valid].min():.2f}..{depth[valid].max():.2f} m")
