"""Smoke/round-trip test for the installed chromapakz package (used by CI and cibuildwheel).

Exits nonzero on any failure. Requires numpy and an installed `chromapakz`.
"""
import numpy as np
import chromapakz as cz

rng = np.random.default_rng(0)
depth = rng.integers(5000, 45000, size=(6, 48, 64)).astype(np.uint16)
rgb = rng.integers(0, 255, size=(6, 48, 64, 4), dtype=np.uint8)

# full RGBD, reduced precision
data = cz.encode_rgbd(rgb, depth, near=0.3, far=9.0, levels=2048)
info = cz.probe(data)
assert info["has_rgb"] and info["frames"] == 6 and info["levels"] == 2048, info
assert np.array_equal(cz.decode_depth(data), depth), "depth not bit-exact (rgbd, 11-bit)"
assert cz.decode_rgb(data).shape == (6, 48, 64, 4), "rgb shape wrong"

# depth-only, full 16-bit
assert np.array_equal(cz.decode_depth(cz.encode_depth(depth)), depth), "depth not bit-exact (16-bit)"

# quantization round-trip is bounded
z = np.array([0.5, 1.5, 5.0], np.float32)
back = cz.dequantize_inverse(cz.quantize_inverse(z, 0.3, 9.0, 4096), 0.3, 9.0, 4096)
assert np.allclose(back, z, rtol=0.02), back

print(f"chromapakz {cz.__version__} round-trip OK")
