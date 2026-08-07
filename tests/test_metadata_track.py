"""The optional timed-text track: a WebVTT metadata track muxed alongside the video.

The point of the feature is that tools we do not control can read it, so these
tests check ffmpeg's view of the output rather than only our own parser.
"""

import ctypes
import json
import os
import shutil
import subprocess
import tempfile
import unittest

import numpy as np

import chromapakz as cz

U8P = ctypes.POINTER(ctypes.c_ubyte)
SZP = ctypes.POINTER(ctypes.c_size_t)
HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _lib():
    for suffix in ("_core.dylib", "_core.so", "_core.pyd"):
        path = cz.__file__.replace("__init__.py", suffix)
        if os.path.exists(path):
            break
    else:
        raise unittest.SkipTest("no native core built")
    lib = ctypes.CDLL(path)
    lib.dc_stream_create_ex.argtypes = [ctypes.c_int] * 6 + [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    lib.dc_stream_add_text.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_int, U8P, ctypes.c_size_t,
        ctypes.POINTER(U8P), SZP]
    lib.dc_stream_add_frame.argtypes = [
        ctypes.c_void_p, U8P, ctypes.c_void_p, ctypes.POINTER(U8P), SZP]
    for fn in ("dc_stream_header", "dc_stream_finish"):
        getattr(lib, fn).argtypes = [ctypes.c_void_p, ctypes.POINTER(U8P), SZP]
    return lib


def _record(path, n=8, track_name=b"poses"):
    """Record a short take with one cue per frame; returns the cue payloads."""
    lib = _lib()
    enc = ctypes.c_void_p()
    if lib.dc_stream_create_ex(64, 48, 30, 500, 1, 1, None, 0, track_name,
                               ctypes.byref(enc)) != 0:
        raise RuntimeError("dc_stream_create_ex failed")
    out, olen = U8P(), ctypes.c_size_t()
    chunks, texts = [], []

    def take():
        if olen.value:
            chunks.append(bytes(bytearray(out[:olen.value])))

    lib.dc_stream_header(enc, ctypes.byref(out), ctypes.byref(olen))
    take()
    for i in range(n):
        rgba = np.random.default_rng(i).integers(0, 255, (48, 64, 4), dtype=np.uint8).ravel()
        lib.dc_stream_add_frame(enc, rgba.ctypes.data_as(U8P), None,
                                ctypes.byref(out), ctypes.byref(olen))
        take()
        payload = f"i={i} value={i * 0.25:.3f}".encode()
        texts.append(payload.decode())
        buf = (ctypes.c_ubyte * len(payload)).from_buffer_copy(payload)
        lib.dc_stream_add_text(enc, int(i * 1000 / 30), 33, buf, len(payload),
                               ctypes.byref(out), ctypes.byref(olen))
        take()
    lib.dc_stream_finish(enc, ctypes.byref(out), ctypes.byref(olen))
    take()
    with open(path, "wb") as f:
        f.write(b"".join(chunks))
    return texts


class MetadataTrack(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "text.webm")

    def tearDown(self):
        self.dir.cleanup()

    @unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
    def test_ffmpeg_resolves_the_track_as_webvtt(self):
        _record(self.path)
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "stream=index,codec_type,codec_name:stream_tags=title",
             "-of", "json", self.path], capture_output=True, text=True, check=True)
        streams = json.loads(probe.stdout)["streams"]
        text = [s for s in streams if s["codec_type"] == "subtitle"]
        self.assertEqual(len(text), 1, streams)
        # An unrecognised CodecID still demuxes as a subtitle stream, so assert the
        # codec resolved: WebM needs D_WEBVTT/*, not Matroska's S_TEXT/WEBVTT.
        self.assertEqual(text[0]["codec_name"], "webvtt")
        self.assertEqual(text[0]["tags"]["title"], "poses")

    @unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not on PATH")
    def test_cues_survive_extraction_by_ffmpeg(self):
        texts = _record(self.path)
        out = os.path.join(self.dir.name, "out.vtt")
        subprocess.run(["ffmpeg", "-v", "error", "-i", self.path, "-map", "0:s:0",
                        "-c", "copy", "-y", out], check=True)
        with open(out) as f:
            body = f.read()
        self.assertTrue(body.startswith("WEBVTT"), body[:80])
        # Payloads only survive when the block carries WebM's cue framing
        # (identifier '\n' settings '\n' payload); without it every cue extracts
        # empty while the file still looks structurally fine.
        for t in texts:
            self.assertIn(t, body)

    @unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not on PATH")
    def test_video_is_unaffected(self):
        _record(self.path)
        subprocess.run(["ffmpeg", "-v", "error", "-i", self.path, "-map", "0:v:0",
                        "-f", "null", "-"], check=True)

    def test_our_decoder_ignores_the_extra_track(self):
        _record(self.path)
        with open(self.path, "rb") as f:
            decoded = cz.decode(f.read())
        rgb = decoded["rgb"] if isinstance(decoded, dict) else decoded
        self.assertIsNotNone(rgb)
        self.assertEqual(len(rgb), 8)

    def test_text_without_a_declared_track_is_refused(self):
        lib = _lib()
        enc = ctypes.c_void_p()
        self.assertEqual(
            lib.dc_stream_create_ex(64, 48, 30, 500, 1, 1, None, 0, None,
                                    ctypes.byref(enc)), 0)
        out, olen = U8P(), ctypes.c_size_t()
        lib.dc_stream_header(enc, ctypes.byref(out), ctypes.byref(olen))
        payload = b"nope"
        buf = (ctypes.c_ubyte * len(payload)).from_buffer_copy(payload)
        self.assertNotEqual(
            lib.dc_stream_add_text(enc, 0, 33, buf, len(payload),
                                   ctypes.byref(out), ctypes.byref(olen)), 0)


if __name__ == "__main__":
    unittest.main()
