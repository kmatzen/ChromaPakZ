# ChromaPakZ API reference

Format schema: [`docs/FORMAT.md`](FORMAT.md).

---

## Browser (`src/chromapakz.js`)

```javascript
const enc = createEncoder({
  W, H, fps: 30,
  signals: [{ id: 'depth', near: 0.4, far: 12 }, { id: 'objectId' }],
});
await enc.addFrame({
  rgb: rgbaUint8,
  signals: { depth: { float: z }, objectId: { u16: ids } },
});
const bytes = await enc.finish();

const dec = createDecoder(bytes);
for await (const frame of dec) {
  frame.signals.depth.u16;
  frame.signals.objectId.u16;
}
```

Batch helpers require explicit `signals` and `frames`:

```javascript
await encode({
  W, H, fps: 30,
  signals: [{ id: 'depth', near, far }],
  frames: depthFloat.map((z, i) => ({ rgb: rgb[i], signals: { depth: { float: z } } })),
});
const { signalSeries } = await decode(bytes);
```

### Network streaming

`onChunk` on encode; `createDecoder()` with no bytes, then `push()` / `finish()`, on decode:

```javascript
const dec = createDecoder();                       // no bytes ⇒ network decoder
for await (const chunk of response.body) dec.push(chunk);   // frames decode as chunks arrive
dec.finish();                                       // no more bytes are coming

for await (const frame of dec) { … }                // may run concurrently with the pushes above
```

Decoding is progressive: each block is delivered as soon as its bytes are complete, so `readFrame()`
resolves without waiting for the end of the stream, and the demuxer retains only the element
currently in flight rather than the whole file. A `readFrame()` with nothing left to read waits for
the next chunk; it returns `null` only after `finish()`, and rejects with `decoder closed` if
`close()` comes first. Encoding emits an unknown-size Segment, so the header is valid the moment it
is written and clusters appended later are still inside the Segment.

Streaming and buffered decode return the same frames for the same file. A frame is delivered when it
has anything decodable — RGB, or a complete hi/lo plane pair for a signal — so clips whose tracks do
not share one timeline (RGB-only frames, signal-only frames) decode identically either way.

`setNearFar()` must be called before the first `addFrame()`: afterwards, already-quantized frames —
and, when streaming, the header already sent — would no longer match the range.

`push()` throws `WebMCorruptError` (exported from the package root) as soon as the bytes received so
far cannot be valid WebM — a bad DocType, a malformed EBML descriptor, unparseable CHROMAPAKZ
metadata. Bytes that are merely incomplete are not an error: the decoder keeps waiting. Catch it to
tell "this stream is broken" from "this stream hasn't finished arriving".

### Track layout and `hasRgb`

`createEncoder` freezes the track numbering on the first `addFrame`: RGB, when present, is track 1
and signal pairs follow it. If frame 0 carries no `rgb`, signals start at track 1 instead — so a
clip whose RGB only starts later must say so up front. (With several RGB streams the rule
generalizes — streams take tracks 1..N and signals start at N+1; see *Multiple RGB streams* below.)

```javascript
createEncoder({ W, H, signals, hasRgb: true });   // reserve track 1 for rgb before frame 0
```

Passing `rgb` on a later frame without that declaration throws, rather than writing RGB onto the
first signal's track. `hasRgb: true` with no `rgb` frame at all also throws (at `finish()`), since
an advertised-but-empty RGB track stalls the streaming decoder. The batch `encode()` helper sees
every frame up front and declares this for you.

Once a stream (RGB or a given signal) has been written, it must appear on every subsequent frame:
a stream that stops and resumes is refused, because each track's timestamps come from its own frame
counter and a gap cannot be realigned.

### Multiple RGB streams (stereo / multi-camera)

`rgbs` declares N synchronized RGB streams instead of the single default one (mutually exclusive
with `hasRgb`; entries are ids or `{ id, kbps }` for a per-stream bitrate). Order fixes the track
numbering — the first stream is the **primary**: track 1, container name `rgb`, the stream legacy
readers and plain `<video>` playback see. Frames then carry `rgbs: { id: plane }`; `rgb:` stays
sugar for the primary. Named streams cannot be inferred from frame 0, so `rgbs` must be declared:

```javascript
const enc = createEncoder({ W, H, signals, rgbs: ['cam0', { id: 'cam1', kbps: 1_000_000 }] });
await enc.addFrame({ rgbs: { cam0, cam1 }, signals: { … } });
```

Decoded frames gain `frame.rgbs` (`{ id: plane }`) beside the legacy `frame.rgb` (= the primary),
and the batch `decode()` returns a per-stream `rgbs` series. All streams share the encoder's
`W`×`H` and the frame grid; the per-frame contiguity rule above applies to each stream. A signal
spec may carry `view: '<rgb id>'` — an informational hint (recorded in the metadata, interpreted
by nothing) naming the camera frame the signal lives in.

### HDR display tracks (read side only)

The browser encoder is SDR-only — `createEncoder({ hdr })` throws; HDR files are written by the
native/Python encoder, and a browser's job is to *play* them (`<video>` handles VP9 profile 2
natively — that is the point of the display track). The JS decoder reads HDR files without
choking: signals and any SDR streams decode as usual, HDR RGB streams are skipped (`frame.rgbs`
omits them; there is no 10-bit WebCodecs output path yet), and their metadata — the
`vp09.02.…` codec string and the `hdr` object — is available on `metadata.rgbs[i]`. The muxer
and demuxer in `src/webm.js` fully support the WebM `Colour` element (`track.colour`),
byte-compatible with the C muxer.

### Timed-text metadata track

A file can carry one WebVTT track for machine-readable per-frame notes — poses, GPS fixes, event
markers — beside the video. Declare it at construction (the header is written before frame 0, so
it cannot be added later) and write cues with timestamps in seconds. In the browser this is a
**streaming-encoder** feature: cues go through the incremental muxer, so `onChunk` is required
and `addText` throws without it.

```javascript
const enc = createEncoder({ W, H, signals, hasRgb: true, textTrack: 'poses', onChunk: sink });
await enc.addText(JSON.stringify({ t, pose }), timestampSeconds, durationSeconds);
```

Python mirrors it: `create_encoder(..., text_track="poses")` then `enc.add_text(text, timestamp,
duration=None)`; the C ABI is `dc_stream_create_ex` + `dc_stream_add_text`. The track is appended
after all video/signal tracks, so it never shifts their numbers, and ordinary players treat it as
subtitles they may ignore. Cues ride inside whichever cluster the surrounding frames are filling,
so `addText` usually returns no bytes of its own.

### Plane sizes

Every plane handed to `addFrame()` must match the encoder's geometry exactly: `W*H` samples for a
signal (`u16` or `float`), `W*H*4` bytes for `rgb` (RGBA). A mismatch throws before any encoder is
touched, so the rejected frame is not counted and the encoder stays usable for the next one.

### Concurrency

`addFrame()`, `finish()` and `readFrame()` are safe to call without awaiting the previous one —
overlapping calls are serialized internally **in call order**, so

```javascript
await Promise.all(frames.map(f => enc.addFrame(f)));   // == awaiting each in turn
```

produces byte-identical output to the sequential loop. VP9 is inherently sequential (each frame
predicts from the last), so this buys correctness, not parallelism: fanning out does not make
encoding faster. Prefer the plain `for … await` loop when you want backpressure — the fan-out form
holds every frame's input buffer live until its turn comes.

Quant helpers: `quantizeInverseDepth`, `dequantizeInverseDepth`, `autoNearFar`, `triFoldPack`, `triFoldUnpack`.

### Codec backend & WASM fallback

VP9 frame encode/decode runs on native **WebCodecs** where it's trustworthy, and falls back to a
bundled **libvpx-WASM** codec where it isn't — decided *per operation* by a one-time, cached
runtime probe (a bit-exact round-trip; we probe rather than sniff the UA because some engines
report VP9 support but aren't lossless/bit-exact). The fallback is granular: a browser that only
decodes pulls `vp9-decode.wasm` (~236 KB) and never the larger `vp9-encode.wasm` (~858 KB), and
vice-versa — the two are separate dynamic-import chunks, so your bundler ships only what runs.

```javascript
createEncoder({ W, H, signals, backend: 'auto' });   // 'auto' (default) | 'webcodecs' | 'wasm'
createDecoder(bytes, { backend: 'auto' });            // same option; also on decode(bytes, opts)
```

`'auto'` probes and chooses; `'webcodecs'` / `'wasm'` force a backend (useful for tests/SSR).
With no WebCodecs at all (e.g. Node), `'auto'` resolves to WASM. Rebuild the WASM artifacts with
`npm run build:wasm` (needs an activated Emscripten SDK).

---

## Python (`python/chromapakz`)

```python
import chromapakz as cz

data = cz.encode(
    {"depth": depth_u16, "objectId": ids_u16},
    specs={"depth": cz.inverse_depth_spec(0.3, 9.0, 2048)},
    rgb=rgba,
)
out = cz.decode(data)
depth = cz.decode_signal(data, "depth")
```

| Function | Purpose |
|---|---|
| `encode(signals, specs=, rgb=, rgbs=, fps=30, rgb_kbps=2000, hdr=)` | Multi-signal encode → WebM bytes |
| `create_encoder(width, height, signals=, fps=, has_rgb=, rgbs=, hdr=, on_chunk=, cues=, text_track=)` | Streaming encoder for live recording |
| `decode(data, signal_ids=)` | Decode signals + RGB (`rgb` = primary; `rgbs` = every stream) |
| `decode_signal(data, id)` | One `(N,H,W)` uint16 plane |
| `decode_rgb(data, stream=)` | One RGB stream (default: primary) → `(N,H,W,4)` RGBA — uint8 for SDR, uint16 10-bit codes for HDR |
| `probe(data)` | `width`, `height`, `frames`, `fps`, `near`, `far`, `levels`, `has_rgb`, `rgbs`, `signals` |
| `parse_metadata(data)` | Full metadata JSON |
| `inverse_depth_spec(near, far, levels=65536)` | Spec dict for a depth signal (`3 <= levels <= 65536`) |
| `quantize_inverse(z, near=, far=, levels=)` | Float depth → uint16 codes (`0` = invalid) |
| `dequantize_inverse(d, near=, far=, levels=)` | uint16 codes → float32 metres (invalid → NaN) |

`fps` and `rgb_kbps` are encode-time knobs: frame rate written to the container, and the VP9 bitrate
for the *lossy* RGB tracks (signals are always lossless, and unaffected by `rgb_kbps`).

Stereo / multi-camera pixels go in `rgbs` — `{id: (N,H,W,4) array}`, order fixing the track
numbering, the first stream being the primary one legacy readers decode; `rgb_kbps` may then be a
`{id: kbps}` dict. Streaming mirrors it: `create_encoder(rgbs=["cam0", ("cam1", 900)])` (or a
`{id: kbps}` dict), then `add_frame(rgbs={"cam0": a, "cam1": b}, signals=…)` with every declared
stream on every frame. A spec may carry `view: "<rgb id>"` — an informational hint naming the
camera frame a signal lives in, recorded in the metadata and interpreted by nothing.

`hdr=` makes every RGB stream an HDR display track (VP9 profile 2, 10-bit, BT.2020, WebM
`Colour` element): `{"transfer": "pq"|"hlg", "max_cll"?, "max_fall"?, "mastering"?:
{rx, ry, gx, gy, bx, by, wx, wy, max_lum, min_lum}}`. RGB arrays are then **uint16** planes of
10-bit display codes (0..1023; out-of-range raises), on both `encode(rgbs=…, hdr=…)` and
`create_encoder(hdr=…)`/`add_frame`. On the read side nothing extra is needed: `decode_rgb` /
`decode()` return uint16 codes for an HDR stream (per its metadata `hdr` entry) and uint8 for
SDR, and the 8/10-bit native entry points refuse each other's streams rather than truncate.

The native core is loaded on first use, not at import — so `inverse_depth_spec`, the validation
helpers and `chromapakz.webm_inspect` are usable (and unit-testable) without a compiled `_core`.

### Streaming encode (live recording)

`encode()` needs the whole take in memory before it writes a byte. `create_encoder()` writes the
file as it is captured — the Python counterpart of the browser encoder's `onChunk`:

```python
with open("take.webm", "wb") as f:
    enc = cz.create_encoder(W, H, fps=30, has_rgb=True, on_chunk=f.write,
                            signals=[{"id": "depth", "near": 0.4, "far": 12.0}, {"id": "objectId"}])
    for rgba, z, ids in capture():
        enc.add_frame(rgb=rgba, signals={"depth": {"float": z}, "objectId": ids})
    enc.finish()
```

| Member | Purpose |
|---|---|
| `header` | The file prefix, available before the first frame |
| `add_frame(rgb=, signals=)` | Encode one frame → the bytes that just became final (often `b""`) |
| `finish()` | Flush the codecs and close the file → the tail bytes |
| `close()` / `with` | Release the native state; the context manager finishes a clean take |
| `frame_count` | Frames accepted so far (a rejected frame is not counted) |

`header` + every `add_frame()` chunk + `finish()` is the complete WebM. Each is also passed to
`on_chunk` as it is produced, so `on_chunk=f.write` and collecting the return values are
interchangeable; the callback is not required.

Three properties make this usable as a *recording* format rather than just an incremental encode:

- **The header is valid immediately.** The Segment carries an unknown size, so what is on disk is
  a decodable WebM from the first chunk — an interrupted capture loses its tail, not the take.
  The metadata carries `"frames": null`; `probe()` recovers the count by counting blocks.
- **Chunks are element-aligned.** `header` is the whole prefix (EBML header, Segment header,
  Info/Tracks/Tags) and every later chunk is a whole number of complete Cluster elements, so a
  wrapper format can interleave its own Matroska elements between chunks without re-parsing byte
  boundaries. Pass `cues=False` when it does: cue positions are byte offsets into the Segment, and
  injected bytes move every cluster out from under them.
- **Memory does not grow with the take.** What is retained is the encoder state, the open cluster
  (at most one second of media) and, when `cues=True`, the seek index — about a dozen bytes per
  second. Never the frames already written.

RGB presence is declared with `has_rgb` rather than inferred, because the track plan is frozen in
the header before frame 0 arrives. Signal order fixes the track numbering, the same way
`planSignals` does in the browser encoder. Every declared stream must be written on every frame:
each track carries its own frame counter, so one that stops and resumes cannot be realigned.

A signal payload is `(H, W)` uint16 codes, `{"u16": codes}`, or `{"float": z}` for a signal that
declared `near`/`far` (quantized for you). A bare float array is still refused — as in `encode()`,
a lossy cast has to be asked for.

### Ingestion (`chromapakz.ingest`, `chromapakz.webm_inspect`)

```python
from chromapakz.ingest import encode_clip, load_depth, load_rgb, auto_near_far
from chromapakz.webm_inspect import track_sizes

data, stats = encode_clip(depth=depth_NHW_float, rgb=rgb_NHWc)   # auto near/far, real bpp in stats
track_sizes(data)          # {track: {'name', 'bytes', 'frames'}} — pure-Python EBML, no native deps
```

| Function | Purpose |
|---|---|
| `encode_clip(depth=, rgb=, near=, far=, fps=, rgb_kbps=, levels=)` | Quantize + encode → `(data, stats)` |
| `load_depth(path, dtype=, shape=)` | `.exr` / `.npy` / `.npz` / 16-bit PNG·TIFF / raw → `(N,H,W)` |
| `load_rgb(path)` | image glob, array file, or video (ffmpeg) → `(N,H,W,3\|4)` uint8 |
| `auto_near_far(depth, lo=1, hi=99)` | Inverse-depth range from valid-pixel percentiles |
| `track_sizes(data)` | Per-track byte/frame breakdown of a WebM |

CLI (installed with the wheel): `chromapakz-ingest --depth 'd_*.exr' --rgb 'rgb_*.png' -o clip.webm --report --verify`

Signals must be integer arrays inside `[0, 65535]` and `rgb` uint8 RGBA. Lossy inputs — metric
float depth, `int32` above 65535, float RGB — raise `ValueError` rather than wrapping silently;
quantize float depth with `quantize_inverse()` first.

---

## C++ / CLI

| Function | Purpose |
|---|---|
| `dc_encode_multi` / `dc_encode_multi2` / `dc_encode_multi_hdr` | RGB (one / N streams / N HDR streams) + N signals |
| `dc_stream_create` / `_create_ex` / `_create2` / `_create_hdr` / `_header` / `_add_frame` / `_add_frame2` / `_add_frame16` / `_add_text` / `_finish` / `_destroy` | Frame-at-a-time encode for live recording (`_ex` adds the timed-text track; `_add_text` writes its cues) |
| `dc_decode_signal` | Decode by id |
| `dc_get_metadata` | CHROMAPAKZ JSON |
| `dc_probe` / `dc_decode_rgb` / `dc_decode_rgb_id` / `dc_decode_rgb16` | Header + RGB (primary / by stream id / 10-bit HDR) |

The `*2` entry points (0.7.0) take `dc_rgb_spec_t` stream descriptors and `dc_signal_spec2_t`
(the v1 struct plus `view`); the originals remain as single-stream forms — existing callers are
untouched, and `dc_probe`'s `has_rgb` out-param now counts streams (still 0/1 for old files).
The `*_hdr` / `*16` entry points (0.8.0) add the 10-bit HDR display path: `dc_hdr_meta_t`
describes transfer/light-levels/ST 2086 mastering, RGB planes cross the ABI as uint16 10-bit
codes, and the 8- and 10-bit forms refuse each other's streams (error 7 on decode, 1 on encode).

Every entry point returns `0` on success and a nonzero code on failure — none of them throw, and
none of them abort on NULL or degenerate arguments. Codes `1`–`8` are per-function, documented on
each declaration in `native/chromapakz.h`; `9`–`12` mean the same thing everywhere:

| Code | Meaning |
|---|---|
| `9` (`DC_ERR_CAPACITY`) | decode only — see [Decoding untrusted files](#decoding-untrusted-files) |
| `10` (`DC_ERR_GEOMETRY`) | decode only — see [Decoding untrusted files](#decoding-untrusted-files) |
| `11` (`DC_ERR_INTERNAL`) | out of memory, or an exception caught at the ABI boundary |
| `12` (`DC_ERR_CODEC`) | this libvpx cannot do lossless VP9, so the encode would have silently produced lossy signal planes |

On a nonzero return the out-params are unspecified and nothing needs freeing.

```sh
./build/dccli selftest
./build/dccli encode depth.u16 W H N fps near far out.webm
./build/dccli decodesignal clip.webm depth out.u16
```

### Decoding untrusted files

`dc_probe` reports what a file's header *claims*; nothing in the container makes the VP9
bitstreams agree with it. So both decoders take the capacity of the output buffer and treat
the header as a hint they verify rather than a promise they trust:

```c
int dc_decode_signal(const uint8_t* webm, size_t len, const char* id,
                     uint16_t* out, size_t out_cap);   // out_cap in uint16 elements
int dc_decode_rgb(const uint8_t* webm, size_t len,
                  uint8_t* rgba_out, size_t rgba_cap); // rgba_cap in bytes
```

| Code | Meaning |
|---|---|
| `9` (`DC_ERR_CAPACITY`) | the track decodes to more frames than the capacity holds — the header under-declared `frames`, or a block carried a VP9 superframe |
| `10` (`DC_ERR_GEOMETRY`) | a decoded frame is not the `W×H` I420 the metadata declares — 8-bit for the SDR entry points, 10-bit for `dc_decode_rgb16` |

Neither ever writes past `*_cap`. Frames the file does not actually contain are left untouched,
so zero the buffer first if you read all of it back — the Python bindings do.

---

## Tests

Both suites are discovered by glob — every `tests/*.test.mjs` and every `tests/test_*.py` runs, so
adding a file is enough to add it to CI.

Running the Node suite needs Node 22+ (the test runner's built-in glob); the library itself has no
such floor, which is why there is no `engines` field pushing it onto consumers.

```sh
npm test                      # Node suite  (node --test 'tests/**/*.test.mjs')
npm run test:coverage         # …with a per-file coverage report
pytest tests                  # Python suite (needs an installed chromapakz)
coverage run -m pytest tests && coverage report
pytest tests/test_lazy_native.py tests/test_webm_inspect.py   # these two need no compiled core

cmake --build build && ./build/dccli selftest
./build/dccli goldencheck tests/fixtures/quant_golden.csv   # C++ side of the cross-language vectors

cd experiments/webcodecs-lossless && node run.mjs multisignal && node smoke-demo.mjs
```

Python tests assert through `unittest`'s `assert*` methods rather than bare `assert`, because
`python -O` strips `assert` statements and would make the suite pass vacuously;
`tests/test_suite_hygiene.py` enforces this.

### Fixtures

| File | Regenerate with | Checked by |
| --- | --- | --- |
| `tests/fixtures/stream.webm`, `stream_depth.u16` | `node tests/fixtures/regen_stream.mjs` | `tests/js_fixture_stream.test.mjs` (staleness + JS decode), `tests/test_stream_interop.py` (native decode) |

The streaming *encoder* is covered in the other direction, without a fixture:
`tests/test_stream_encode.py` writes a stream from Python and reads it back through the native
decoder, and `tests/test_stream_encode_js_interop.py` hands the same bytes to both browser
decoders through `node` (skipped when node is not on PATH).
| `tests/fixtures/quant_golden.csv` | `node tests/fixtures/regen_quant_golden.mjs` | `tests/js_quant_golden.test.mjs`, `tests/test_quant_golden.py`, `dccli goldencheck` |

Native coverage is off by default; build it separately so nothing shipped is instrumented:

```sh
cmake -S . -B build-cov -DCHROMAPAKZ_COVERAGE=ON && cmake --build build-cov -j
./build-cov/dccli selftest && gcovr --root . --filter native/ --txt
```
