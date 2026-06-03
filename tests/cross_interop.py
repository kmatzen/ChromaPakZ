"""Metadata and multi-signal contract checks (native Python).

Verifies v2 `signals[]`, legacy `depth` mirror, and per-id decode. Exits nonzero on failure.
"""
import numpy as np
import chromapakz as cz

rng = np.random.default_rng(2)
N, H, W = 4, 32, 40
depth = rng.integers(1000, 60000, size=(N, H, W), dtype=np.uint16)
object_id = rng.integers(1, 50000, size=(N, H, W), dtype=np.uint16)

data = cz.encode(
    {"depth": depth, "objectId": object_id},
    specs={"depth": {"inverse_depth": True, "near": 0.25, "far": 8.0, "levels": 4096}},
)

meta = cz.parse_metadata(data)
assert meta["version"] == 2, meta
assert len(meta["signals"]) == 2, meta["signals"]
ids = {s["id"] for s in meta["signals"]}
assert ids == {"depth", "objectId"}, ids

# legacy depth mirror for v1 tools
assert meta["depth"] is not None, "expected legacy depth mirror"
assert meta["depth"]["trackHi"] == meta["signals"][0]["tracks"]["hi"]
assert meta["depth"]["near"] == 0.25

# dc_get_metadata / probe agree on depth quant
probe = cz.probe(data)
assert probe["near"] == 0.25 and probe["far"] == 8.0
assert probe["levels"] == 4096
assert probe["metadata"]["version"] == 2

decoded = cz.decode(data)
assert np.array_equal(decoded["signals"]["depth"], depth)
assert np.array_equal(decoded["signals"]["objectId"], object_id)

# depth-only sugar still v2
solo = cz.encode_depth(depth, near=0.2, far=10.0)
solo_meta = cz.parse_metadata(solo)
assert solo_meta["version"] == 2
assert len(solo_meta["signals"]) == 1
assert solo_meta["signals"][0]["id"] == "depth"
assert np.array_equal(cz.decode_signal(solo, "depth"), depth)

print("cross_interop OK — v2 signals + legacy depth mirror")
