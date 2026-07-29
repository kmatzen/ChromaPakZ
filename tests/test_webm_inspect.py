"""Tests for the pure-Python EBML inspector (no compiled native library needed).

Builds minimal WebM files in-process (mirroring src/webm.js output) — definite-size and
streamed unknown-size, laced and BlockGroup-wrapped — and checks that
chromapakz.webm_inspect.track_sizes reports the right per-track byte/frame breakdown.
Also parses the streaming golden fixture the JS muxer produced.
Run: python tests/py_webm_inspect.py
"""
import unittest

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
from chromapakz.webm_inspect import EbmlError, track_sizes

_SEGMENT, _TRACKS, _TRACKENTRY = 0x18538067, 0x1654AE6B, 0xAE
_TRACKNUMBER, _NAME = 0xD7, 0x536E
_CLUSTER, _TIMESTAMP, _SIMPLEBLOCK = 0x1F43B675, 0xE7, 0xA3
_BLOCKGROUP, _BLOCK = 0xA0, 0xA1
_EBML = 0x1A45DFA3
_FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "stream.webm")


def _id(eid):
    out = b""
    while eid:
        out = bytes([eid & 0xFF]) + out
        eid >>= 8
    return out


def _vint(n, length=1):
    while n >= (1 << (7 * length)) - 1:          # -1: all-ones is reserved (unknown size)
        length += 1
    v = n + (1 << (7 * length))
    return v.to_bytes(length, "big")


def _svint(d):
    """Signed VINT (EBML lacing size deltas): value biased by 2^(7L-1) - 1."""
    length = 1
    while not (1 - (1 << (7 * length - 1)) <= d <= (1 << (7 * length - 1)) - 1):
        length += 1
    return _vint(d + (1 << (7 * length - 1)) - 1, length)


def _unknown_vint(length=8):
    """All-ones VINT_DATA — the streaming muxer's unknown-size marker."""
    marker = 1 << (8 - length)
    return bytes([marker | (marker - 1)]) + b"\xff" * (length - 1)


def _el(eid, payload):
    return _id(eid) + _vint(len(payload)) + payload


def _el_unknown(eid, payload, length=8):
    return _id(eid) + _unknown_vint(length) + payload


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


def _laced_body(track, lacing, payloads):
    """Block body with Xiph (1), fixed-size (2) or EBML (3) lacing."""
    head = _vint(track) + (0).to_bytes(2, "big", signed=True) + bytes([0x80 | (lacing << 1)])
    head += bytes([len(payloads) - 1])
    if lacing == 1:                                    # Xiph: 0xFF-continued byte runs
        for p in payloads[:-1]:
            head += b"\xff" * (len(p) // 255) + bytes([len(p) % 255])
    elif lacing == 3:                                  # EBML: first size, then signed deltas
        head += _vint(len(payloads[0]))
        for prev, p in zip(payloads, payloads[1:-1]):
            head += _svint(len(p) - len(prev))
    return head + b"".join(payloads)


def _block_group(track, data):
    """ffmpeg-style BlockGroup wrapping a plain Block."""
    return _el(_BLOCKGROUP, _el(_BLOCK, _vint(track) + (0).to_bytes(2, "big", signed=True)
                                + b"\x00" + data))


def _track_entry(num, name):
    return _el(_TRACKENTRY, _el(_TRACKNUMBER, _uint(num)) + _el(_NAME, name.encode()))


def build_webm(track_frames, unknown_segment=False):
    """track_frames: {num: (name, [payload, ...])} -> WebM bytes (streamed if unknown_segment)."""
    tracks = _el(_TRACKS, b"".join(_track_entry(n, name) for n, (name, _) in sorted(track_frames.items())))
    blocks = b"".join(
        _simple_block(n, 0, True, p)
        for n, (_, payloads) in sorted(track_frames.items()) for p in payloads
    )
    cluster = _el(_CLUSTER, _el(_TIMESTAMP, _uint(0)) + blocks)
    seg = _el_unknown(_SEGMENT, tracks + cluster) if unknown_segment else _el(_SEGMENT, tracks + cluster)
    return _el(_EBML, b"") + seg


class WebmInspect(unittest.TestCase):
    def test_all(self):
        failures = []

        def ok(cond, msg=""):
            if not cond:
                failures.append(msg or "check failed")

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

        # unknown-size Segment (what the streaming muxer emits) parses identically to the definite one
        spec = {1: ("rgb", [b"\x01" * 100, b"\x02" * 50]), 2: ("signal-depth-hi", [b"\x03" * 7])}
        ok(track_sizes(build_webm(spec, unknown_segment=True)) == track_sizes(build_webm(spec)),
           "unknown-size Segment matches definite-size accounting")

        # the same, at every legal unknown-size VINT width
        for width in (1, 2, 4, 8):
            tracks = _el(_TRACKS, _track_entry(1, "rgb"))
            cluster = _el(_CLUSTER, _el(_TIMESTAMP, _uint(0)) + _simple_block(1, 0, True, b"\x09" * 42))
            streamed = _el(_EBML, b"") + _el_unknown(_SEGMENT, tracks + cluster, width)
            info = track_sizes(streamed)
            ok(info.get(1, {}).get("bytes") == 42, f"unknown Segment vint width {width}: {info}")

        # unknown-size Clusters terminate at the next level-1 element, not at end-of-buffer
        c1 = _el_unknown(_CLUSTER, _el(_TIMESTAMP, _uint(0)) + _simple_block(1, 0, True, b"\xaa" * 11), 1)
        c2 = _el_unknown(_CLUSTER, _el(_TIMESTAMP, _uint(1)) + _simple_block(1, 0, True, b"\xbb" * 22), 1)
        streamed = _el(_EBML, b"") + _el_unknown(_SEGMENT, _el(_TRACKS, _track_entry(1, "rgb")) + c1 + c2)
        info = track_sizes(streamed)
        ok(info[1]["bytes"] == 33 and info[1]["frames"] == 2, f"unknown-size clusters {info}")

        # the streaming golden fixture (real WASM-encoded, unknown-size Segment) — see tests/stream_interop.py
        if os.path.exists(_FIXTURE):
            info = track_sizes(open(_FIXTURE, "rb").read())
            ok(sorted(t["name"] for t in info.values()) ==
               ["signal-depth-hi", "signal-depth-lo", "signal-objectId-hi", "signal-objectId-lo"],
               f"fixture track names {[t['name'] for t in info.values()]}")
            ok(all(t["frames"] == 5 and t["bytes"] > 0 for t in info.values()), f"fixture accounting {info}")

        # track numbers >= 127 need the full multi-byte vint, not the low 7 bits of its first byte
        info = track_sizes(build_webm({127: ("a", [b"\x01" * 5]), 200: ("b", [b"\x02" * 9])}))
        ok(sorted(info) == [127, 200], f"multi-byte track numbers {sorted(info)}")
        ok(info[200]["name"] == "b" and info[200]["bytes"] == 9, f"track 200 accounting {info.get(200)}")

        # BlockGroup/Block (ffmpeg-remuxed WebM) counts the same as a SimpleBlock
        tracks = _el(_TRACKS, _track_entry(1, "rgb"))
        cluster = _el(_CLUSTER, _el(_TIMESTAMP, _uint(0)) + _block_group(1, b"\x01" * 30) + _block_group(1, b"\x02" * 12))
        info = track_sizes(_el(_EBML, b"") + _el(_SEGMENT, tracks + cluster))
        ok(info[1]["bytes"] == 42 and info[1]["frames"] == 2, f"BlockGroup accounting {info}")

        # laced blocks: every laced frame counts, and the lacing header is not charged as payload
        for lacing, payloads in ((1, [b"a" * 10, b"b" * 300, b"c" * 20]),   # Xiph (300 needs a 0xFF run)
                                 (2, [b"a" * 16, b"b" * 16, b"c" * 16]),    # fixed-size
                                 (3, [b"a" * 10, b"b" * 300, b"c" * 20])):  # EBML
            body = _laced_body(1, lacing, payloads)
            cluster = _el(_CLUSTER, _el(_TIMESTAMP, _uint(0)) + _el(_SIMPLEBLOCK, body))
            info = track_sizes(_el(_EBML, b"") + _el(_SEGMENT, _el(_TRACKS, _track_entry(1, "rgb")) + cluster))
            want = sum(len(p) for p in payloads)
            ok(info[1]["bytes"] == want and info[1]["frames"] == len(payloads),
               f"lacing {lacing}: {info} (want {want} bytes / {len(payloads)} frames)")


        def raises(fn, msg):
            try:
                fn()
            except EbmlError:
                return
            except Exception as exc:                     # noqa: BLE001 - any other error is the bug
                ok(False, f"{msg}: raised {type(exc).__name__} instead of EbmlError")
                return
            ok(False, f"{msg}: no error raised")


        # garbage in -> a clean EbmlError, never IndexError or silent nonsense
        raises(lambda: track_sizes(b"\x00\x00\x00\x00"), "zero first byte (no vint marker)")
        raises(lambda: track_sizes(b"\x1a\x45\xdf\xa3"), "element id with no size")
        raises(lambda: track_sizes(b"\x1a\x45\xdf"), "truncated element id")
        raises(lambda: track_sizes(build_webm({1: ("rgb", [b"\x01" * 20])})[:-30] + b"\x00"),
               "truncated mid-cluster")

        self.assertEqual(failures, [], "\n".join(failures))


if __name__ == "__main__":
    unittest.main()
