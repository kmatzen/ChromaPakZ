"""The CHROMAPAKZ metadata tag is JSON, and the native core must read and write it as JSON.

It used to do neither. `buildMetadataJson` pasted signal ids into the document unescaped, and
the reader searched the raw text: `find(']')` for the end of `signals[]`, `find('"')` for the end
of an id, and a fixed 480-character window to bound one signal entry. Three consequences, all
reproduced below:

  1. an id containing `]` ended the signals array early — the encoder wrote a file its own
     decoder could not read back ("no such signal");
  2. an id containing `"` produced a document that was not JSON at all, so the JS and Python
     readers (which use real JSON parsers) could not load a file the C++ encoder had just
     written;
  3. the 480-character window overran into the *next* entry, so a signal with `"quant":null`
     inherited the following signal's inverse-depth near/far — dc_probe then reported a
     quantization range for a signal that had none.

The second group of tests drives the parser directly, through a hand-built WebM carrying nothing
but a Tags element, so a document can be posed to it that no encoder here would ever emit.
"""
import ctypes
import json
import unittest

import numpy as np

import chromapakz as cz

ERR_NO_SUCH_SIGNAL = 8

W, H, N = 24, 16, 2
rng = np.random.default_rng(11)
CODES = rng.integers(1, 65535, (N, H, W)).astype(np.uint16)


# ── a WebM carrying only metadata, for testing the parser in isolation ──────────────
def _vint(n):
    L = 1
    while n >= (1 << (7 * L)) - 1:
        L += 1
    return (n + (1 << (7 * L))).to_bytes(L, "big")


def _el(eid, payload):
    return eid.to_bytes((eid.bit_length() + 7) // 8, "big") + _vint(len(payload)) + payload


def webm_with_metadata(meta_json):
    """A minimal, structurally valid WebM whose only content is the CHROMAPAKZ tag."""
    header = _el(0x1A45DFA3, _el(0x4282, b"webm"))
    simple = _el(0x67C8, _el(0x45A3, b"CHROMAPAKZ") + _el(0x4487, meta_json.encode("utf-8")))
    tags = _el(0x1254C367, _el(0x7373, _el(0x63C0, b"") + simple))
    return header + _el(0x18538067, tags)


def signal_doc(signal_id, quant="null", width=8, height=8):
    """A v2 document with one signal. `signal_id` and `quant` go in as raw JSON bodies, so a test
    can pose text an encoder would have escaped."""
    return ('{"version":2,"width":%d,"height":%d,"fps":30,"frames":0,"rgb":null,"signals":'
            '[{"id":"%s","tracks":{"hi":1,"lo":2},"scheme":"tri-fold-8+8","quant":%s}]}'
            % (width, height, signal_id, quant))


def probe_raw(data):
    """dc_probe alone — no json.loads, so malformed documents can be posed to the C++ parser."""
    lib = cz._load()
    buf = (ctypes.c_uint8 * len(data)).from_buffer_copy(data)
    W_, H_, N_, fps, levels, rgb = (ctypes.c_int() for _ in range(6))
    near, far = ctypes.c_double(), ctypes.c_double()
    rc = lib.dc_probe(buf, len(data),
                      *(ctypes.byref(x) for x in (W_, H_, N_, fps, near, far, levels, rgb)))
    return rc, dict(width=W_.value, height=H_.value, frames=N_.value, fps=fps.value,
                    near=near.value, far=far.value, levels=levels.value, has_rgb=bool(rgb.value))


def finds_signal(data, signal_id):
    """True when the parser recovered `signal_id` from the document (rc 8 == no such signal)."""
    lib = cz._load()
    buf = (ctypes.c_uint8 * len(data)).from_buffer_copy(data)
    out = np.zeros(64, np.uint16)
    rc = lib.dc_decode_signal(buf, len(data), signal_id.encode("utf-8"),
                              out.ctypes.data_as(ctypes.POINTER(ctypes.c_uint16)), out.size)
    return rc != ERR_NO_SUCH_SIGNAL


# ── 1-3: the three failures, through the real encoder ───────────────────────────────
class AdversarialSignalIds(unittest.TestCase):
    """Ids the format never forbade, so the encoder must round-trip them (issues 1 and 2)."""

    IDS = [
        "a]b",              # ended the signals array early
        'ev"il',            # broke out of the JSON string
        "back\\slash",
        "brace}s{",
        "comma,colon:",
        "new\nline\ttab",
        "unicode-日本語-😀",
        "x" * 600,          # longer than the old 480-character scan window
    ]

    def test_metadata_is_valid_json(self):
        # parse_metadata is json.loads over the raw tag, so it fails outright on a document the
        # encoder mis-escaped — which is exactly how the JS and Python readers would fail.
        for sid in self.IDS:
            with self.subTest(id=sid):
                meta = cz.parse_metadata(cz.encode({sid: CODES}))
                self.assertEqual([s["id"] for s in meta["signals"]], [sid])

    def test_decodes_back_bit_exactly(self):
        for sid in self.IDS:
            with self.subTest(id=sid):
                data = cz.encode({sid: CODES})
                self.assertTrue(np.array_equal(cz.decode_signal(data, sid), CODES),
                                f"id {sid!r} did not round-trip")

    def test_several_adversarial_ids_in_one_file(self):
        signals = {sid: CODES for sid in ("a]b", 'ev"il', "plain")}
        data = cz.encode(signals)
        decoded = cz.decode(data)["signals"]
        self.assertEqual(set(decoded), set(signals))
        for sid in signals:
            self.assertTrue(np.array_equal(decoded[sid], CODES), sid)


class QuantDoesNotLeakBetweenSignals(unittest.TestCase):
    """Issue 3: a signal's quant must come from that signal, not from whatever follows it."""

    def test_unquantized_depth_before_a_quantized_signal(self):
        # "depth" carries raw codes; "disparity" is the one with an inverse-depth range. The old
        # 480-character window read "inverse-depth" out of the *next* entry and reported
        # disparity's 0.25/7.5 as depth's.
        data = cz.encode({"depth": CODES, "disparity": CODES},
                         specs={"disparity": cz.inverse_depth_spec(0.25, 7.5, 4096)})
        probe = cz.probe(data)
        self.assertEqual((probe["near"], probe["far"]), (0.0, 0.0),
                         "depth has no quant — it must not inherit disparity's range")
        self.assertEqual(probe["levels"], cz.LEVELS_FULL)
        by_id = {s["id"]: s for s in cz.parse_metadata(data)["signals"]}
        self.assertIsNone(by_id["depth"]["quant"])
        self.assertEqual(by_id["disparity"]["quant"]["near"], 0.25)

    def test_quantized_depth_is_still_reported(self):
        data = cz.encode({"depth": CODES, "objectId": CODES},
                         specs={"depth": cz.inverse_depth_spec(0.4, 6.0, 1024)})
        probe = cz.probe(data)
        self.assertEqual((probe["near"], probe["far"], probe["levels"]), (0.4, 6.0, 1024))

    def test_quant_survives_a_long_id_in_the_preceding_signal(self):
        data = cz.encode({"x" * 900: CODES, "depth": CODES},
                         specs={"depth": cz.inverse_depth_spec(0.5, 9.0, 2048)})
        probe = cz.probe(data)
        self.assertEqual((probe["near"], probe["far"], probe["levels"]), (0.5, 9.0, 2048))


class QuantPrecision(unittest.TestCase):
    def test_near_far_round_trip_to_the_last_bit(self):
        # %g kept 6 significant digits, so the range read back out of the file was not the range
        # that went in, and dequantization landed on slightly different metres.
        near, far = 1.0 / 3.0, 7.123456789012345
        data = cz.encode({"depth": CODES}, specs={"depth": cz.inverse_depth_spec(near, far)})
        probe = cz.probe(data)
        self.assertEqual(probe["near"], near)
        self.assertEqual(probe["far"], far)


# ── 4: the parser, driven directly ──────────────────────────────────────────────────
class ParserContract(unittest.TestCase):
    def test_member_order_does_not_matter(self):
        doc = ('{"signals":[{"quant":null,"tracks":{"lo":2,"hi":1},"id":"depth"}],'
               '"rgb":null,"frames":3,"height":48,"width":64,"fps":25,"version":2}')
        rc, p = probe_raw(webm_with_metadata(doc))
        self.assertEqual(rc, 0)
        self.assertEqual((p["width"], p["height"], p["fps"], p["frames"]), (64, 48, 25, 3))
        self.assertTrue(finds_signal(webm_with_metadata(doc), "depth"))

    def test_null_frames_keeps_the_default(self):
        doc = ('{"version":2,"width":64,"height":48,"fps":30,"frames":null,"rgb":null,'
               '"signals":[{"id":"depth","tracks":{"hi":1,"lo":2},"quant":null}]}')
        rc, p = probe_raw(webm_with_metadata(doc))
        self.assertEqual(rc, 0)
        self.assertEqual((p["width"], p["height"]), (64, 48))
        self.assertEqual(p["frames"], 0)   # no blocks to count in a metadata-only file

    def test_escapes_are_decoded(self):
        for escaped, literal in [(r"a\"b", 'a"b'),
                                 (r"a\\b", "a\\b"),
                                 (r"a\/b", "a/b"),
                                 (r"tab\there", "tab\there"),
                                 (r"nl\nhere", "nl\nhere"),
                                 (r"AB", "AB"),
                                 (r"é", "é"),
                                 (r"😀", "😀")]:      # surrogate pair -> one code point
            with self.subTest(escaped=escaped):
                data = webm_with_metadata(signal_doc(escaped))
                self.assertTrue(finds_signal(data, literal),
                                f"{escaped} should decode to {literal!r}")

    def test_json_inside_an_id_is_not_read_as_structure(self):
        # The id's *text* looks like the members the parser is looking for. Walking the document
        # structurally means it is a string here and nothing else.
        doc = signal_doc(r"x\",\"width\":9999,\"hi\":77,\"quant\":{\"type\":\"inverse-depth\",\"near\":5,\"far\":6},\"y",
                         width=64, height=48)
        json.loads(json.dumps(json.loads(doc)))          # the document really is valid JSON
        rc, p = probe_raw(webm_with_metadata(doc))
        self.assertEqual(rc, 0)
        self.assertEqual((p["width"], p["height"]), (64, 48), "an id must not redefine the geometry")
        self.assertEqual((p["near"], p["far"]), (0.0, 0.0))

    def test_a_bracket_in_an_id_does_not_end_the_signals_array(self):
        doc = ('{"version":2,"width":8,"height":8,"fps":30,"frames":0,"rgb":null,"signals":['
               '{"id":"a]b","tracks":{"hi":1,"lo":2},"quant":null},'
               '{"id":"second","tracks":{"hi":3,"lo":4},"quant":null}]}')
        data = webm_with_metadata(doc)
        self.assertTrue(finds_signal(data, "a]b"))
        self.assertTrue(finds_signal(data, "second"), "the entry after the `]` must still be seen")

    def test_rgb_presence_is_structural(self):
        rgb_null = signal_doc("depth")
        self.assertFalse(probe_raw(webm_with_metadata(rgb_null))[1]["has_rgb"])
        with_rgb = rgb_null.replace('"rgb":null', '"rgb":{"track":1,"codec":"vp09.00.10.08"}')
        self.assertTrue(probe_raw(webm_with_metadata(with_rgb))[1]["has_rgb"])
        # ...and an id that merely *says* "rgb":null does not turn the RGB track off
        lying = with_rgb.replace('"id":"depth"', r'"id":"\"rgb\":null"')
        self.assertTrue(probe_raw(webm_with_metadata(lying))[1]["has_rgb"])

    def test_signal_missing_or_aliased_tracks_is_dropped(self):
        for tracks in ('{"hi":1}', '{"hi":1,"lo":1}', '{"hi":0,"lo":2}', "null"):
            with self.subTest(tracks=tracks):
                doc = ('{"version":2,"width":8,"height":8,"fps":30,"frames":0,"rgb":null,'
                       '"signals":[{"id":"depth","tracks":%s,"quant":null}]}' % tracks)
                self.assertFalse(finds_signal(webm_with_metadata(doc), "depth"))

    def test_unknown_quant_type_is_not_treated_as_inverse_depth(self):
        # A near/far the core does not know how to apply must not be reported as if it did.
        doc = signal_doc("depth", quant='{"type":"log-depth","near":1,"far":2}')
        rc, p = probe_raw(webm_with_metadata(doc))
        self.assertEqual(rc, 0)
        self.assertEqual((p["near"], p["far"]), (0.0, 0.0))

    def test_inverse_depth_quant_is_read_from_the_nested_object(self):
        doc = signal_doc("depth", quant='{"type":"inverse-depth","near":0.75,"far":12.5,"levels":8192}')
        rc, p = probe_raw(webm_with_metadata(doc))
        self.assertEqual(rc, 0)
        self.assertEqual((p["near"], p["far"], p["levels"]), (0.75, 12.5, 8192))

    def test_deep_nesting_is_refused_without_crashing(self):
        # 200 levels is far past the parser's depth cap; it must stop, not recurse into the stack.
        deep = "[" * 200 + "]" * 200
        doc = ('{"version":2,"width":64,"height":48,"fps":30,"frames":0,"rgb":null,'
               '"signals":[{"id":"depth","tracks":{"hi":1,"lo":2},"quant":null}],"junk":%s}' % deep)
        rc, p = probe_raw(webm_with_metadata(doc))
        self.assertEqual(rc, 0)
        self.assertEqual((p["width"], p["height"]), (64, 48))   # members read before the junk survive

    def test_truncated_and_malformed_documents_do_not_crash(self):
        full = signal_doc("depth", width=64, height=48)
        for cut in range(0, len(full), 7):
            rc, _ = probe_raw(webm_with_metadata(full[:cut]))
            self.assertIn(rc, (0, 1))
        for junk in ("", "{", "[]", "null", '{"width":', '{"a":"\\uZZZZ"}', '{"signals":[{'):
            with self.subTest(junk=junk):
                rc, _ = probe_raw(webm_with_metadata(junk))
                self.assertIn(rc, (0, 1))


if __name__ == "__main__":
    unittest.main()
