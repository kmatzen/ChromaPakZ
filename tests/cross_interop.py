"""Metadata and multi-signal contract checks (native Python)."""
import numpy as np
import chromapakz as cz

rng = np.random.default_rng(2)
N, H, W = 4, 32, 40
depth = rng.integers(1000, 60000, size=(N, H, W), dtype=np.uint16)
object_id = rng.integers(1, 50000, size=(N, H, W), dtype=np.uint16)
depth_spec = cz.inverse_depth_spec(0.25, 8.0, 4096)

data = cz.encode({"depth": depth, "objectId": object_id}, specs={"depth": depth_spec})
meta = cz.parse_metadata(data)
assert meta["version"] == 2
assert len(meta["signals"]) == 2
assert "depth" not in meta
assert {s["id"] for s in meta["signals"]} == {"depth", "objectId"}

probe = cz.probe(data)
assert probe["near"] == 0.25 and probe["far"] == 8.0 and probe["levels"] == 4096

decoded = cz.decode(data)
assert np.array_equal(decoded["signals"]["depth"], depth)
assert np.array_equal(decoded["signals"]["objectId"], object_id)

solo = cz.encode({"depth": depth}, specs={"depth": cz.inverse_depth_spec(0.2, 10.0)})
assert len(cz.parse_metadata(solo)["signals"]) == 1
assert np.array_equal(cz.decode_signal(solo, "depth"), depth)

print("cross_interop OK — v2 signals only")
