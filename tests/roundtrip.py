"""Smoke/round-trip test for the installed chromapakz package (used by CI and cibuildwheel)."""
import numpy as np
import chromapakz as cz

rng = np.random.default_rng(0)
depth = rng.integers(5000, 45000, size=(6, 48, 64)).astype(np.uint16)
rgb = rng.integers(0, 255, size=(6, 48, 64, 4), dtype=np.uint8)
object_id = rng.integers(1000, 60000, size=(6, 48, 64)).astype(np.uint16)
depth_spec = cz.inverse_depth_spec(0.3, 9.0, 2048)

data = cz.encode(
    {"depth": depth},
    specs={"depth": depth_spec},
    rgb=rgb,
)
info = cz.probe(data)
assert info["has_rgb"] and info["frames"] == 6 and info["levels"] == 2048, info
assert len(info["signals"]) == 1 and info["signals"][0]["id"] == "depth"
assert info["metadata"]["version"] == 2
assert np.array_equal(cz.decode_signal(data, "depth"), depth)
assert cz.decode_rgb(data).shape == (6, 48, 64, 4)

depth_only = cz.encode({"depth": depth}, specs={"depth": cz.inverse_depth_spec(0.2, 10.0)})
assert np.array_equal(cz.decode_signal(depth_only, "depth"), depth)

multi = cz.encode(
    {"depth": depth, "objectId": object_id},
    specs={"depth": depth_spec},
    rgb=rgb,
)
decoded = cz.decode(multi)
assert np.array_equal(decoded["signals"]["depth"], depth)
assert np.array_equal(decoded["signals"]["objectId"], object_id)

z = np.array([0.5, 1.5, 5.0], np.float32)
back = cz.dequantize_inverse(cz.quantize_inverse(z, 0.3, 9.0, 4096), 0.3, 9.0, 4096)
assert np.allclose(back, z, rtol=0.02), back

print(f"chromapakz {cz.__version__} round-trip OK")
