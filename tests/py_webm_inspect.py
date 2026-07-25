"""Tests for the pure-Python EBML inspector (no native library, no numpy).

Builds a minimal definite-size WebM in-process (mirroring src/webm.js output) and checks
that webm_inspect.track_sizes reports the right per-track byte/frame breakdown.
Run: python tests/py_webm_inspect.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
from webm_inspect import track_sizes

_SEGMENT, _TRACKS, _TRACKENTRY = 0x18538067, 0x1654AE6B, 0xAE
_TRACKNUMBER, _NAME = 0xD7, 0x536E
_CLUSTER, _TIMESTAMP, _SIMPLEBLOCK = 0x1F43B675, 0xE7, 0xA3
_EBML = 0x1A45DFA3


def _id(eid):
    out = b""
    while eid:
        out = bytes([eid & 0xFF]) + out
        eid >>= 8
    return out


def _vint(n):
    length = 1
    while n >= (1 << (7 * length)) - 1:
        length += 1
    v = n + (1 << (7 * length))
    return v.to_bytes(length, "big")


def _el(eid, payload):
    return _id(eid) + _vint(len(payload)) + payload


def _uint(n):
    if n == 0:
        return b"\x00"
    out = b""
    while n:
        out = bytes([n & 0xFF]) + out
        n >>= 8
    return out


def _simple_block(track, rel_ms, key, data):
    return _el(_SIMPLEBLOCK, _vint(track) + rel_ms.to_bytes(2, "big", signed=True)
               + bytes([0x80 if key else 0x00]) + data)


def _track_entry(num, name):
    return _el(_TRACKENTRY, _el(_TRACKNUMBER, _uint(num)) + _el(_NAME, name.encode()))


def build_webm(track_frames):
    """track_frames: {num: (name, [payload, ...])} -> definite-size WebM bytes."""
    tracks = _el(_TRACKS, b"".join(_track_entry(n, name) for n, (name, _) in sorted(track_frames.items())))
    blocks = b"".join(
        _simple_block(n, 0, True, p)
        for n, (_, payloads) in sorted(track_frames.items()) for p in payloads
    )
    cluster = _el(_CLUSTER, _el(_TIMESTAMP, _uint(0)) + blocks)
    return _el(_EBML, b"") + _el(_SEGMENT, tracks + cluster)


failed = 0


def ok(cond, msg):
    global failed
    if not cond:
        print("FAIL:", msg)
        failed += 1


# per-track byte and frame accounting
data = build_webm({
    1: ("rgb", [b"\x01" * 100, b"\x02" * 50]),
    2: ("signal-depth-hi", [b"\x03" * 7]),
    3: ("signal-depth-lo", [b"\x04" * 3000]),  # payload size needs a 2-byte vint
})
info = track_sizes(data)
ok(set(info) == {1, 2, 3}, f"track set {sorted(info)}")
ok(info[1]["name"] == "rgb" and info[1]["bytes"] == 150 and info[1]["frames"] == 2,
   f"rgb accounting {info.get(1)}")
ok(info[2]["bytes"] == 7 and info[2]["frames"] == 1, f"hi accounting {info.get(2)}")
ok(info[3]["name"] == "signal-depth-lo" and info[3]["bytes"] == 3000, f"lo accounting {info.get(3)}")

# a track declared in Tracks but with no blocks must not appear (sizes are block-driven)
data2 = build_webm({1: ("rgb", [b"\xff" * 10]), 7: ("empty", [])})
info2 = track_sizes(data2)
ok(7 not in info2 and info2[1]["bytes"] == 10, f"blockless track skipped {info2}")

# zero-length payload frames count as frames with 0 bytes
info3 = track_sizes(build_webm({1: ("rgb", [b"", b""])}))
ok(info3[1]["frames"] == 2 and info3[1]["bytes"] == 0, f"empty payloads {info3}")

# empty input: no tracks, no crash
ok(track_sizes(b"") == {}, "empty input -> empty result")

print(f"\n{failed} failed" if failed else "\nall passed")
sys.exit(1 if failed else 0)
