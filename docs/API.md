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
clip whose RGB only starts later must say so up front:

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
| `encode(signals, specs=, rgb=, fps=30, rgb_kbps=2000)` | Multi-signal encode → WebM bytes |
| `decode(data, signal_ids=)` | Decode signals + optional RGB |
| `decode_signal(data, id)` | One `(N,H,W)` uint16 plane |
| `decode_rgb(data)` | RGB track → `(N,H,W,4)` uint8 RGBA |
| `probe(data)` | `width`, `height`, `frames`, `fps`, `near`, `far`, `levels`, `has_rgb`, `signals` |
| `parse_metadata(data)` | Full v2 JSON |
| `inverse_depth_spec(near, far, levels=65536)` | Spec dict for a depth signal (`3 <= levels <= 65536`) |
| `quantize_inverse(z, near=, far=, levels=)` | Float depth → uint16 codes (`0` = invalid) |
| `dequantize_inverse(d, near=, far=, levels=)` | uint16 codes → float32 metres (invalid → NaN) |

`fps` and `rgb_kbps` are encode-time knobs: frame rate written to the container, and the VP9 bitrate
for the *lossy* RGB track (signals are always lossless, and unaffected by `rgb_kbps`).

The native core is loaded on first use, not at import — so `inverse_depth_spec`, the validation
helpers and `chromapakz.webm_inspect` are usable (and unit-testable) without a compiled `_core`.

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
| `dc_encode_multi` | RGB + N signals |
| `dc_decode_signal` | Decode by id |
| `dc_get_metadata` | CHROMAPAKZ JSON |
| `dc_probe` / `dc_decode_rgb` | Header + RGB |

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
| `10` (`DC_ERR_GEOMETRY`) | a decoded frame is not the 8-bit I420 `W×H` the metadata declares |

Neither ever writes past `*_cap`. Frames the file does not actually contain are left untouched,
so zero the buffer first if you read all of it back — the Python bindings do.

---

## Tests

```sh
npm test                     # full Node suite, incl. the version-consistency check
cmake --build build && ./build/dccli selftest
python tests/py_lazy_native.py && python tests/py_webm_inspect.py     # no compiled core needed
python tests/roundtrip.py && python tests/cross_interop.py && python tests/ffmpeg_interop.py
python tests/py_api_validation.py && python tests/py_decode_bounds.py
cd experiments/webcodecs-lossless && node run.mjs multisignal && node smoke-demo.mjs
```
