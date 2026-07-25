"""Python API tests: input validation, error paths, and reduced-levels round-trips.

Complements tests/roundtrip.py (happy path) with the contract edges: bad specs must raise
ValueError before touching native code, garbage bytes must raise RuntimeError (never crash),
and quantization/round-trip must hold at non-default levels and for non-contiguous inputs.
Run: python tests/py_api_validation.py  (needs the compiled native core, like roundtrip.py)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
import numpy as np

import chromapakz as cz


def expect_raises(exc, fn, msg):
    try:
        fn()
    except exc:
        return
    except Exception as e:  # noqa: BLE001 — report the wrong type explicitly
        raise AssertionError(f"{msg}: raised {type(e).__name__} instead of {exc.__name__}") from e
    raise AssertionError(f"{msg}: did not raise")


rng = np.random.default_rng(7)
W, H, N = 40, 24, 3
depth = rng.integers(1, 65536, (N, H, W)).astype(np.uint16)
ids = rng.integers(0, 65536, (N, H, W)).astype(np.uint16)

# ── spec validation raises before hitting ctypes ──
expect_raises(ValueError, lambda: cz.encode({}), "no signals and no rgb")
expect_raises(ValueError, lambda: cz.encode({"d": depth[0]}), "2-D signal rejected")
expect_raises(ValueError,
              lambda: cz.encode({"a": depth, "b": ids[:, :-2, :]}), "shape mismatch rejected")
expect_raises(ValueError,
              lambda: cz.encode({"d": depth}, specs={"d": {"inverse_depth": True}}),
              "inverse_depth without near/far")
expect_raises(ValueError,
              lambda: cz.encode({"d": depth}, specs={"d": {"inverse_depth": True, "near": 2, "far": 1}}),
              "far <= near")
expect_raises(ValueError, lambda: cz.inverse_depth_spec(0, 5), "near=0")
expect_raises(ValueError, lambda: cz.inverse_depth_spec(-1, 5), "near<0")
expect_raises(ValueError, lambda: cz.inverse_depth_spec(0.5, 0.5), "far==near")
expect_raises(ValueError, lambda: cz.inverse_depth_spec(0.5, 9, levels=2), "levels<3")
expect_raises(ValueError, lambda: cz.quantize_inverse(np.zeros(4, np.float32), 1, 0.5), "quantize bad range")
expect_raises(ValueError, lambda: cz.dequantize_inverse(np.zeros(4, np.uint16), 0, 5), "dequantize bad near")

# rgb shape validation
expect_raises(ValueError,
              lambda: cz.encode({"d": depth}, rgb=np.zeros((N, H, W, 3), np.uint8)), "RGB (not RGBA) rejected")
expect_raises(ValueError,
              lambda: cz.encode({"d": depth}, rgb=np.zeros((N, H + 1, W, 4), np.uint8)),
              "rgb/signal shape mismatch rejected")

# ── garbage bytes: RuntimeError, never a crash ──
for blob in (b"", b"\x00" * 64, bytes(range(256)) * 4):
    expect_raises(RuntimeError, lambda b=blob: cz.parse_metadata(b), f"parse_metadata garbage len={len(blob)}")
    expect_raises(RuntimeError, lambda b=blob: cz.probe(b), f"probe garbage len={len(blob)}")

# ── multi-signal encode: metadata contract + per-signal bit-exact decode ──
data = cz.encode({"depth": depth, "objectId": ids},
                 specs={"depth": cz.inverse_depth_spec(0.4, 6.0, levels=4096)})
meta = cz.parse_metadata(data)
assert meta.get("version") == 2, f"metadata version {meta.get('version')}"
by_id = {s["id"]: s for s in meta["signals"]}
assert set(by_id) == {"depth", "objectId"}, f"signal ids {sorted(by_id)}"
assert by_id["depth"]["tracks"]["hi"] != by_id["objectId"]["tracks"]["hi"], "distinct tracks"

info = cz.probe(data)
assert (info["width"], info["height"], info["frames"]) == (W, H, N), f"probe dims {info}"
assert info["levels"] == 4096, f"probe levels {info['levels']}"
assert abs(info["near"] - 0.4) < 1e-9 and abs(info["far"] - 6.0) < 1e-9, "probe near/far"

out = cz.decode(data)
assert np.array_equal(out["signals"]["depth"], depth), "depth codes bit-exact"
assert np.array_equal(out["signals"]["objectId"], ids), "objectId bit-exact"

# subset selection decodes only what was asked for
sub = cz.decode(data, signal_ids=["objectId"])
assert set(sub["signals"]) == {"objectId"}, f"subset decode {set(sub['signals'])}"

# unknown signal id is an error, not junk output
expect_raises(RuntimeError, lambda: cz.decode_signal(data, "nope"), "unknown signal id")
# RGB-less file refuses decode_rgb
expect_raises(RuntimeError, lambda: cz.decode_rgb(data), "decode_rgb without RGB track")

# ── non-contiguous input arrays are handled (ascontiguousarray path) ──
strided = np.ascontiguousarray(rng.integers(0, 65536, (N, H, W * 2)).astype(np.uint16))[:, :, ::2]
assert not strided.flags["C_CONTIGUOUS"]
data2 = cz.encode({"s": strided})
assert np.array_equal(cz.decode_signal(data2, "s"), strided), "non-contiguous signal bit-exact"

# ── quantize/dequantize: invariants at reduced levels ──
for levels in (16, 1024, cz.LEVELS_FULL):
    near, far = 0.5, 8.0
    z = np.linspace(near, far, 300, dtype=np.float32)
    z_bad = np.array([0.0, -1.0, np.nan], dtype=np.float32)
    q = cz.quantize_inverse(np.concatenate([z, z_bad]), near, far, levels)
    assert q[-3:].tolist() == [0, 0, 0], f"levels={levels}: invalid -> code 0"
    codes = q[:-3].astype(np.int64)
    assert codes.min() >= 1 and codes.max() <= levels - 1, f"levels={levels}: code range"
    assert (np.diff(codes) <= 0).all(), f"levels={levels}: monotone in depth"
    back = cz.dequantize_inverse(q, near, far, levels)
    assert np.isnan(back[-3:]).all(), f"levels={levels}: code 0 -> NaN"
    step = (1 / near - 1 / far) / (levels - 2)
    err = np.abs(1 / back[:-3] - 1 / z)
    assert err.max() <= step * 0.51, f"levels={levels}: max inv-depth err {err.max()} vs step {step}"

# reduced-levels codes survive the full encode->decode round-trip bit-exactly
zf = (0.5 + 7.5 * rng.random((N, H, W))).astype(np.float32)
codes = cz.quantize_inverse(zf, 0.5, 8.0, 1024)
data3 = cz.encode({"depth": codes}, specs={"depth": cz.inverse_depth_spec(0.5, 8.0, 1024)})
assert np.array_equal(cz.decode_signal(data3, "depth"), codes), "levels=1024 round-trip bit-exact"
assert cz.probe(data3)["levels"] == 1024, "levels stored in metadata"

print("all passed")
