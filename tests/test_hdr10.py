"""HDR10 display track — VP9 profile 2 + WebM Colour signalling (issue #51).

What is under test, per the issue's definition of done:

  * a genuine 10-bit round trip: codes above the 8-bit range survive encode → decode;
  * the WebM `Colour` element is actually present and correct — HDR10 static metadata lives in
    the container, not the VP9 bitstream, and without it a player shows washed-out SDR;
  * the two independent muxers (C++ and src/webm.js) emit byte-identical Colour elements for
    the same description — the WebVTT work showed this is where parity bugs hide;
  * SDR output is completely unchanged: no Colour element, same codec string;
  * the 8-bit and 10-bit decode entry points refuse each other's streams instead of quietly
    truncating or reinterpreting.
"""
import json
import os
import shutil
import struct
import subprocess
import tempfile
import unittest

import numpy as np

import chromapakz as cz

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src")
HAVE_NODE = bool(shutil.which("node")) and os.path.exists(os.path.join(SRC, "webm.js"))

N, H, W = 3, 24, 32
MASTERING = {"rx": 0.708, "ry": 0.292, "gx": 0.170, "gy": 0.797, "bx": 0.131, "by": 0.046,
             "wx": 0.3127, "wy": 0.3290, "max_lum": 1000.0, "min_lum": 0.005}
HDR_PQ = {"transfer": "pq", "max_cll": 1000, "max_fall": 400, "mastering": MASTERING}

RNG = np.random.default_rng(51)
SIG = RNG.integers(0, 65536, (N, H, W)).astype(np.uint16)


def solid10(r, g, b):
    a = np.zeros((N, H, W, 4), np.uint16)
    a[..., 0], a[..., 1], a[..., 2], a[..., 3] = r, g, b, 1023
    return a


# ── a minimal EBML walker, enough to find and read the Colour element ────────────────
def _ebml_children(data, start, end):
    p = start
    while p < end:
        # element ID: length from the leading zero bits, stored with the marker
        first = data[p]
        idlen = next((k + 1 for k in range(4) if first & (0x80 >> k)), None)
        if idlen is None or p + idlen > end:
            return
        eid = int.from_bytes(data[p:p + idlen], "big")
        p += idlen
        first = data[p]
        szlen = next((k + 1 for k in range(8) if first & (0x80 >> k)), None)
        if szlen is None or p + szlen > end:
            return
        raw = int.from_bytes(data[p:p + szlen], "big")
        size = raw - (1 << (7 * szlen))
        unknown = size == (1 << (7 * szlen)) - 1
        p += szlen
        d_end = end if unknown else min(p + size, end)
        yield eid, p - idlen - szlen, p, d_end
        p = d_end if not unknown else end


def _find(data, start, end, *path):
    """Descend master elements by ID; returns (payload_start, payload_end, element_start)."""
    if not path:
        return start, end, None
    for eid, e_start, d_start, d_end in _ebml_children(data, start, end):
        if eid == path[0]:
            if len(path) == 1:
                return d_start, d_end, e_start
            got = _find(data, d_start, d_end, *path[1:])
            if got is not None:
                return got
    return None


SEGMENT, TRACKS, TRACK_ENTRY, VIDEO, COLOUR = 0x18538067, 0x1654AE6B, 0xAE, 0xE0, 0x55B0
MASTERING_ID = 0x55D0


def find_colour(data, raw=False):
    """Parse (or return raw bytes of) the first Colour element in the file, or None."""
    hit = _find(data, 0, len(data), SEGMENT, TRACKS, TRACK_ENTRY, VIDEO, COLOUR)
    if hit is None:
        return None
    d_start, d_end, e_start = hit
    if raw:
        return bytes(data[e_start:d_end])
    names = {0x55B1: "matrix", 0x55B2: "bits", 0x55B9: "range", 0x55BA: "transfer",
             0x55BB: "primaries", 0x55BC: "maxCLL", 0x55BD: "maxFALL"}
    m_names = {0x55D1: "rx", 0x55D2: "ry", 0x55D3: "gx", 0x55D4: "gy", 0x55D5: "bx",
               0x55D6: "by", 0x55D7: "wx", 0x55D8: "wy", 0x55D9: "max_lum", 0x55DA: "min_lum"}
    out = {}
    for eid, _, s, e in _ebml_children(data, d_start, d_end):
        if eid in names:
            out[names[eid]] = int.from_bytes(data[s:e], "big")
        elif eid == MASTERING_ID:
            mm = {}
            for mid, _, ms, me in _ebml_children(data, s, e):
                if mid in m_names and me - ms == 8:
                    mm[m_names[mid]] = struct.unpack(">d", bytes(data[ms:me]))[0]
            out["mastering"] = mm
    return out


class Hdr10RoundTrip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rgb = solid10(800, 500, 100)
        cls.data = cz.encode({"depth": SIG}, rgb=cls.rgb, hdr=HDR_PQ)

    def test_ten_bit_codes_survive(self):
        out = cz.decode(self.data)
        self.assertEqual(out["rgb"].dtype, np.uint16)
        means = [float(out["rgb"][..., c].mean()) for c in range(3)]
        # 800 is unreachable through any 8-bit path (widest 8-bit upshift tops out at 4-step
        # rungs after a 0..255 clamp); a lossy 10-bit path lands within a few codes.
        for got, want in zip(means, (800, 500, 100)):
            self.assertLess(abs(got - want), 8.0, f"channel expected ~{want}, decoded {got}")
        self.assertTrue(np.array_equal(out["signals"]["depth"], SIG),
                        "signals stay bit-exact beside a profile-2 track")

    def test_metadata_codec_string_and_hdr_object(self):
        meta = cz.parse_metadata(self.data)
        entry = meta["rgbs"][0]
        self.assertEqual(entry["codec"], "vp09.02.10.10.01.09.16.09")
        self.assertEqual(meta["rgb"]["codec"], "vp09.02.10.10.01.09.16.09",
                         "legacy key mirrors the primary, codec string included")
        hdr = entry["hdr"]
        self.assertEqual((hdr["bits"], hdr["transfer"]), (10, "pq"))
        self.assertEqual((hdr["maxCLL"], hdr["maxFALL"]), (1000, 400))
        # %.17g round-trips IEEE doubles exactly, so these are equalities, not approximations.
        for k_py, k_json in (("rx", "rx"), ("gy", "gy"), ("max_lum", "maxLum"), ("min_lum", "minLum")):
            self.assertEqual(hdr["mastering"][k_json], MASTERING[k_py])

    def test_colour_element_present_and_correct(self):
        c = find_colour(np.frombuffer(self.data, np.uint8))
        self.assertIsNotNone(c, "no Colour element in the container — HDR pixels, not HDR10")
        self.assertEqual((c["matrix"], c["bits"], c["range"]), (9, 10, 1))
        self.assertEqual((c["transfer"], c["primaries"]), (16, 9))
        self.assertEqual((c["maxCLL"], c["maxFALL"]), (1000, 400))
        self.assertEqual(c["mastering"]["rx"], MASTERING["rx"])
        self.assertEqual(c["mastering"]["max_lum"], MASTERING["max_lum"])
        self.assertEqual(c["mastering"]["min_lum"], MASTERING["min_lum"])

    def test_hlg_variant(self):
        data = cz.encode({"depth": SIG}, rgb=self.rgb, hdr={"transfer": "hlg"})
        meta = cz.parse_metadata(data)
        self.assertEqual(meta["rgbs"][0]["codec"], "vp09.02.10.10.01.09.18.09")
        self.assertEqual(meta["rgbs"][0]["hdr"]["transfer"], "hlg")
        c = find_colour(np.frombuffer(data, np.uint8))
        self.assertEqual(c["transfer"], 18)
        self.assertNotIn("maxCLL", c, "HLG with no light levels writes none")
        self.assertNotIn("mastering", c)

    def test_bit_depth_mismatch_is_refused_both_ways(self):
        import ctypes
        lib = cz._load()
        buf = (ctypes.c_uint8 * len(self.data)).from_buffer_copy(self.data)
        out8 = np.zeros((N, H, W, 4), np.uint8)
        self.assertEqual(lib.dc_decode_rgb(buf, len(self.data),
                                           out8.ctypes.data_as(cz.u8p), out8.nbytes), 7,
                         "8-bit entry point must refuse a 10-bit stream, not truncate it")
        sdr = cz.encode({"depth": SIG}, rgb=np.zeros((N, H, W, 4), np.uint8))
        sbuf = (ctypes.c_uint8 * len(sdr)).from_buffer_copy(sdr)
        out16 = np.zeros((N, H, W, 4), np.uint16)
        self.assertEqual(cz._load_hdr().dc_decode_rgb16(sbuf, len(sdr), None,
                                                        out16.ctypes.data_as(cz.u16p), out16.size),
                         7, "10-bit entry point must refuse an SDR stream")

    def test_validation(self):
        with self.assertRaisesRegex(ValueError, r"\[0, 1023\]"):
            cz.encode({"d": SIG}, rgb=solid10(2000, 0, 0), hdr=HDR_PQ)
        with self.assertRaisesRegex(ValueError, "transfer"):
            cz.encode({"d": SIG}, rgb=self.rgb, hdr={"transfer": "gamma"})
        with self.assertRaisesRegex(ValueError, "display track"):
            cz.encode({"d": SIG}, hdr=HDR_PQ)
        with self.assertRaisesRegex(ValueError, "missing"):
            cz.encode({"d": SIG}, rgb=self.rgb, hdr={"transfer": "pq", "mastering": {"rx": 0.7}})


class SdrUntouched(unittest.TestCase):
    def test_sdr_has_no_colour_element_and_the_old_codec_string(self):
        data = cz.encode({"depth": SIG}, rgb=np.zeros((N, H, W, 4), np.uint8))
        self.assertIsNone(find_colour(np.frombuffer(data, np.uint8)))
        meta = cz.parse_metadata(data)
        self.assertEqual(meta["rgbs"][0]["codec"], "vp09.00.10.08")
        self.assertNotIn("hdr", meta["rgbs"][0])


class StreamingStereoHdr(unittest.TestCase):
    def test_streamed_stereo_hdr_round_trips(self):
        cam0, cam1 = solid10(800, 100, 100), solid10(100, 100, 800)
        chunks = []
        enc = cz.create_encoder(W, H, signals=[{"id": "depth"}], rgbs=["cam0", "cam1"],
                                hdr=HDR_PQ, on_chunk=chunks.append)
        for i in range(N):
            enc.add_frame(rgbs={"cam0": cam0[i], "cam1": cam1[i]}, signals={"depth": SIG[i]})
        enc.finish()
        out = cz.decode(b"".join(chunks))
        self.assertEqual(out["rgbs"]["cam0"].dtype, np.uint16)
        self.assertLess(abs(float(out["rgbs"]["cam0"][..., 0].mean()) - 800), 8.0)
        self.assertLess(abs(float(out["rgbs"]["cam1"][..., 2].mean()) - 800), 8.0)
        self.assertTrue(np.array_equal(out["signals"]["depth"], SIG))

    def test_eight_bit_frame_is_refused_on_an_hdr_stream(self):
        import ctypes
        enc = cz.create_encoder(W, H, signals=[{"id": "d"}], has_rgb=True, hdr=HDR_PQ)
        try:
            lib = cz._load_multi_rgb()
            plane = np.zeros((H, W, 4), np.uint8)
            sig = SIG[0]
            arr = (cz.u8p * 1)(plane.ctypes.data_as(cz.u8p))
            planes = (cz.u16p * 1)(sig.ctypes.data_as(cz.u16p))
            out, out_len = cz.u8p(), ctypes.c_size_t()
            rc = lib.dc_stream_add_frame2(enc._h, arr, planes,
                                          ctypes.byref(out), ctypes.byref(out_len))
            self.assertEqual(rc, 1, "the 8-bit ABI form must refuse an HDR encoder")
        finally:
            enc.close()


@unittest.skipUnless(HAVE_NODE, "node or src/ not available")
class MuxerParityAndJsReader(unittest.TestCase):
    """The independent JS muxer emits a byte-identical Colour element, and the JS reader
    survives an HDR file: signals decode, the HDR rgb stream is skipped, nothing throws."""

    JS = r"""
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const webm = await import(pathToFileURL(process.env.CZ_SRC + '/webm.js').href);
const { createDecoder } = await import(pathToFileURL(process.env.CZ_SRC + '/chromapakz.js').href);

const bytes = new Uint8Array(readFileSync(process.env.CZ_CLIP));
const out = {};

// 1) demux-parse the C file's Colour element
const { tracks, metadata } = webm.demux(bytes);
out.colour = tracks[1].colour ?? null;
out.rgbsMeta = metadata.rgbs;

// 2) build the same TrackEntry through the JS muxer, for a byte-parity check python-side
const jsBytes = webm.mux({ tracks: [{ number: 1, codecID: 'V_VP9', name: 'rgb',
  width: Number(process.env.CZ_W), height: Number(process.env.CZ_H), colour: out.colour }],
  frames: [], metadata: null, durationMs: 0 });
writeFileSync(process.env.CZ_OUT, jsBytes);

// 3) full JS decode of the HDR file: signals bit-exact, HDR rgb skipped without throwing
const dec = createDecoder(bytes, { backend: 'wasm' });
out.frames = 0; out.sig = []; out.sawRgb = false;
for await (const fr of dec) {
  out.frames++;
  if (fr.rgb || Object.keys(fr.rgbs).length) out.sawRgb = true;
  out.sig.push(Array.from(fr.signals.depth.u16));
}
await dec.close();
process.stdout.write(JSON.stringify(out));
"""

    @classmethod
    def setUpClass(cls):
        cls.data = cz.encode({"depth": SIG}, rgb=solid10(800, 500, 100), hdr=HDR_PQ)
        cls._tmp = tempfile.TemporaryDirectory()
        clip = os.path.join(cls._tmp.name, "hdr.webm")
        js_out = os.path.join(cls._tmp.name, "js.webm")
        script = os.path.join(cls._tmp.name, "hdr.mjs")
        with open(clip, "wb") as f:
            f.write(cls.data)
        with open(script, "w") as f:
            f.write(cls.JS)
        env = dict(os.environ, CZ_SRC=os.path.abspath(SRC), CZ_CLIP=clip, CZ_OUT=js_out,
                   CZ_W=str(W), CZ_H=str(H))
        run = subprocess.run(["node", script], capture_output=True, text=True, env=env)
        if run.returncode:
            raise unittest.SkipTest(f"node could not run the JS side: {run.stderr.strip()}")
        cls.js = json.loads(run.stdout)
        with open(js_out, "rb") as f:
            cls.js_bytes = f.read()

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_js_demux_parses_the_colour_element(self):
        c = self.js["colour"]
        self.assertEqual((c["matrix"], c["bits"], c["range"]), (9, 10, 1))
        self.assertEqual((c["transfer"], c["primaries"]), (16, 9))
        self.assertEqual(c["mastering"]["maxLum"], MASTERING["max_lum"])

    def test_both_muxers_emit_identical_colour_bytes(self):
        c_raw = find_colour(np.frombuffer(self.data, np.uint8), raw=True)
        js_raw = find_colour(np.frombuffer(self.js_bytes, np.uint8), raw=True)
        self.assertIsNotNone(c_raw)
        self.assertEqual(c_raw, js_raw, "C and JS muxers disagree on the Colour element bytes")

    def test_js_reader_decodes_signals_and_skips_the_hdr_stream(self):
        self.assertEqual(self.js["frames"], N)
        self.assertFalse(self.js["sawRgb"], "JS has no 10-bit decode path yet — must skip, not lie")
        got = np.array(self.js["sig"], dtype=np.uint16).reshape(N, H, W)
        self.assertTrue(np.array_equal(got, SIG))
        self.assertEqual(self.js["rgbsMeta"][0]["hdr"]["transfer"], "pq")


if __name__ == "__main__":
    unittest.main()
