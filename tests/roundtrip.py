"""Smoke/round-trip test for the installed chromapakz package (used by CI and cibuildwheel).

Exits nonzero on any failure. Requires numpy and an installed `chromapakz`.
"""
import numpy as np
import chromapakz as cz

rng = np.random.default_rng(0)
depth = rng.integers(5000, 45000, size=(6, 48, 64)).astype(np.uint16)
rgb = rng.integers(0, 255, size=(6, 48, 64, 4), dtype=np.uint8)
object_id = rng.integers(1000, 60000, size=(6, 48, 64)).astype(np.uint16)

# full RGBD, reduced precision
data = cz.encode_rgbd(rgb, depth, near=0.3, far=9.0, levels=2048)
info = cz.probe(data)
assert info["has_rgb"] and info["frames"] == 6 and info["levels"] == 2048, info
assert len(info["signals"]) == 1 and info["signals"][0]["id"] == "depth"
assert info["metadata"]["version"] == 2, info["metadata"]
assert np.array_equal(cz.decode_depth(data), depth), "depth not bit-exact (rgbd, 11-bit)"
assert cz.decode_rgb(data).shape == (6, 48, 64, 4), "rgb shape wrong"

# depth-only, full 16-bit (v2 metadata)
depth_only = cz.encode_depth(depth)
assert cz.probe(depth_only)["metadata"]["version"] == 2
assert np.array_equal(cz.decode_depth(depth_only), depth), "depth not bit-exact (16-bit)"

# depth + objectId multi-signal
multi = cz.encode(
    {"depth": depth, "objectId": object_id},
    specs={"depth": {"inverse_depth": True, "near": 0.3, "far": 9.0, "levels": 2048}},
    rgb=rgb,
)
minfo = cz.probe(multi)
assert len(minfo["signals"]) == 2, minfo["signals"]
decoded = cz.decode(multi)
assert np.array_equal(decoded["signals"]["depth"], depth), "multi depth not bit-exact"
assert np.array_equal(decoded["signals"]["objectId"], object_id), "objectId not bit-exact"
assert decoded["rgb"].shape == rgb.shape

# quantization round-trip is bounded
z = np.array([0.5, 1.5, 5.0], np.float32)
back = cz.dequantize_inverse(cz.quantize_inverse(z, 0.3, 9.0, 4096), 0.3, 9.0, 4096)
assert np.allclose(back, z, rtol=0.02), back

print(f"chromapakz {cz.__version__} round-trip OK")
