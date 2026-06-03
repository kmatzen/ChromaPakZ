# depthcodec

A single container holding **RGB + bit-exact 16-bit depth**, synchronized, that:

- a **legacy player shows as plain RGB** (depth lives in extra tracks it ignores),
- uses only **royalty-free** codecs (no GPL encoder, no patent pool),
- needs **no WASM** to encode *or* decode in a browser, and
- carries depth with a **trivial reversible pack**, not range-slice bookkeeping.

This is a from-scratch reboot of an older MP4/x264 approach (RGB as YUV + lossless-10-bit
depth split into multiple range slices). The three pains being fixed: x264 is GPL,
range-slicing was fiddly, and the browser needed a WASM codec.

## Status: working prototype (verified end-to-end)

`src/` is a runnable, dependency-free implementation:
- **`src/depthcodec.js`** — `encode()`/`decode()`: inverse-depth quantization + triangle-fold 8+8 +
  VP9 lossless inter-coded depth tracks + a normal VP9 RGB track, via WebCodecs.
- **`src/webm.js`** — a minimal pure-JS Matroska/WebM muxer + demuxer (multi VP9 track + metadata tag).

### Try it (browser demo)
`demo/index.html` is a self-contained, WASM-free page: synthesize (or load) an RGBD clip, encode it
to a `.webm` in-browser via WebCodecs, then decode and view RGB beside a colour-mapped depth pane,
with live per-track bpp and a bit-exact integrity check. Serve over http (WebCodecs needs a secure
context — `localhost` counts):
```sh
python3 -m http.server 8000      # from the repo root, then open http://localhost:8000/demo/
```
Headless smoke test: `cd experiments/webcodecs-lossless && node smoke-demo.mjs` (drives
generate→encode→decode, asserts bit-exact, writes `demo/preview.png`).

Verified headless (`node experiments/webcodecs-lossless/run.mjs webm`): depth round-trips
**bit-exact through the real container**, RGB decodes, and the output is a standard WebM —
`ffprobe` sees `matroska,webm` with 3 VP9 streams, and **`ffmpeg` decodes track 0 as plain RGB**
(legacy fallback confirmed by an external tool). 256×256×30 sample: RGB 0.19 + depth-hi 0.36 +
depth-lo 4.15 bpp (the lo plane is the noise floor of the synthetic ±3-LSB data).

## Cross-language support (browser · C++ · Python)

All three implementations read/write the **same** `.webm` — verified bit-exact in every direction.

| Surface | Codec | Container | Build |
|---|---|---|---|
| **Browser** | WebCodecs VP9 | `src/webm.js` (pure JS) | none — `src/depthcodec.js` |
| **C++** | libvpx VP9 (`pkg-config vpx`) | `native/depthcodec.cpp` EBML (port of `webm.js`) | `native/build.sh` → `libdepthcodec.{dylib,so}` + `dccli` |
| **Python** | (binds the C++ core via ctypes) | — | `python/depthcodec.py`, needs the built lib + numpy |

No GPL and no patent pool anywhere: VP9 + libvpx (BSD) on native, WebCodecs VP9 in-browser.

```sh
# native
native/build.sh && native/dccli selftest
native/dccli decode    clip.webm depth.u16            # depth track of any depthcodec file
native/dccli decodergb clip.webm rgb.rgba             # RGB track → raw RGBA
native/dccli encode     depth.u16 W H N fps near far out.webm                 # depth-only
native/dccli encodergbd rgb.rgba depth.u16 W H N fps near far kbps out.webm   # full RGBD

# python
python3 -c "import sys; sys.path.insert(0,'python'); import depthcodec as dc; \
            data=open('clip.webm','rb').read(); \
            print(dc.decode_depth(data).shape, dc.decode_rgb(data).shape)"
# dc.encode_rgbd(rgb_NHWc4_uint8, depth_NHW_uint16, near=.., far=..) -> webm bytes
```

**Full RGBD, all verified bit-exact:** browser- and native-encoded RGBD files interchange in every
direction (browser ⇄ C++ ⇄ Python), depth always bit-exact; `ffprobe` reads them as standard
`matroska,webm` with 3 VP9 streams; and `ffmpeg` decodes track 0 as plain RGB (legacy fallback).
RGB uses lossy VP9 with BT.709 full-range, signaled in the bitstream so players colour it correctly.

## Real-data ingestion (`python/`)

- **`ingest.py`** — load depth (`.exr` float / `.npy` / `.npz` / 16-bit PNG·TIFF / raw) and optional
  RGB (image sequence / video via ffmpeg / array), auto inverse-depth `near/far` from percentiles
  (ignoring invalid `<=0`/NaN), encode, and report **real per-track bpp**. Handles invalid pixels
  (mapped to code 0). CLI: `python ingest.py --depth 'd_*.exr' --rgb 'rgb_*.png' -o clip.webm --report --verify`.
- **`webm_inspect.py`** — pure-Python EBML parser for per-track byte/frame breakdown (no native dep).
- **`make_synthetic_rgbd.py`** — realistic RGBD generator (smooth surfaces, depth edges,
  **disparity-domain noise** like real stereo/ToF, occlusion shadows, dropout holes) → `.npz`,
  a stand-in until real sensor data is available. Verified: ingest → encode → decode is bit-exact,
  invalids included.

### What lossless 16-bit depth actually costs (and the one knob that controls it)
On realistic noisy depth, **bit-exact 16-bit costs ~13 bpp — most of it is preserving sensor noise.**
The dominant lever is the quantization step vs the noise floor: spreading depth over all 65,534 codes
makes one code ≪ the noise, so the codec faithfully archives ~10 bits of randomness per pixel.
Matching the code step to the noise collapses the cost:

| effective bits | code step @ far | depth bpp |
|---|---|---|
| 16 (default) | ~1.7 mm | 13.2 |
| 12 | ~28 mm | 9.7 |
| 11 | ~56 mm | 8.1 |
| 10 | ~112 mm | 6.9 |

This is *not* lossy depth — it's choosing a uint16 grid matched to real precision, then carrying it
bit-exact. **`levels` is a first-class, metadata-stored quantization parameter** (default 65536 =
full 16-bit) threaded through all three impls: `M = levels-2; code = round((1/z−1/far)/(1/near−1/far)·M)+1`.
Float reconstruction round-trips at the chosen precision in any impl — verified: a Python-encoded
`levels=2048` file decodes in C++ and the browser to identical float depth. Set it via
`ingest.py --depth-bits N`, the `levels=` arg in the JS/Python/C++ encoders, or leave it at the
full-16-bit default.

### Remaining polish
- **Real-data validation** (lo-plane cost is noise-dominated; synthetic ≠ yours).
- **Cues + Duration** elements for seekable playback in `<video>` (current files have none).
- **Firefox/Safari** encode verification (confirmed on Chromium).
- Native could add a CMake target / pip-installable wheel; today it builds via `native/build.sh`.
- An auto noise estimator so `--depth-bits` picks itself (temporal stddev on static pixels).

> **Due diligence:** [`docs/EVALUATION.md`](docs/EVALUATION.md) defends every design choice against the
> full alternative space — codec/container/packing/bit-depth — with reproducible benchmarks (depthcodec
> beats FFV1, PNG-16, HEVC and x264 on the same depth, and is within 1–2% of LZMA) and cited
> licensing/browser-support facts. Includes a sensitivity analysis of when a different choice would win.

## Design (current direction)

| Layer        | Choice | Why |
|--------------|--------|-----|
| Container    | ISO-BMFF / MP4 (WebM variant TBD) | Multi-track; unknown depth track is skipped by legacy players → RGB-only fallback for free. |
| RGB track    | 8-bit VP9 or AV1, YUV 4:2:0 | Royalty-free; native browser decode; what a dumb player shows. |
| Depth track  | **8-bit VP9 in lossless mode (QP=0)**, depth packed into the luma plane | Royalty-free + the substrate browsers can both **encode and decode via WebCodecs without WASM**. VP9 lossless = q_index 0 (4×4 WHT, exact). **Measured bit-exact** (see experiments). AV1 q=0 via WebCodecs is *not* bit-exact (measured max Δ≈257) — AV1 is fine for the RGB track but not for lossless depth in-browser. |
| Depth packing| float depth/disparity → **inverse-depth uint16** (per-clip near/far in metadata) → **two 8-bit planes via triangle-fold** | Inverse-depth puts precision where it matters; triangle-fold keeps each plane spatially coherent so the codec's own predictor works. |
| Metadata     | Sidecar box: bit depth, packing id, near/far, units, intrinsics/extrinsics, valid-mask policy | Decoder needs the quantization contract to reconstruct float. |

### The precision contract
Float can't be carried losslessly in 16 bits, so the **float→uint16 quantization is the format's
defined precision boundary** (inverse-depth / disparity quantization). Everything below that is
**bit-exact on the uint16**. The codec layer must never lose a bit of the packed planes.

### Why triangle-fold instead of byte-split
Naive `lo = d & 0xFF` is a **sawtooth** — a hard `255→0` cliff every 256 depth levels. Those are
high-frequency edges that aren't in the real signal, and spatial predictors model them as huge
residuals (this is why a naive LSB plane compresses terribly, and why the old design used range
slices). Triangle-fold reflects every other segment (`lo = (high&1) ? 255-lo : lo`) so the low
plane is a **continuous triangle wave** — no manufactured cliffs, predictor works, lossless.
It is range-slicing collapsed into one reversible map, with no slices to manage.

It does **not** remove true sensor-noise entropy — bit-exact means that must be carried. If the
browser supports high-bit-depth lossless (VP9 profile 2 / AV1 10–12 bit) we'd split **16→12+4**
instead, shrinking the noisy plane from 8 bits to 4. Whether WebCodecs supports that here is an
open empirical question (see experiments).

## Findings (measured via experiments/webcodecs-lossless, headless Chromium 148)

The depth path is now settled empirically. Numbers are bits/pixel/frame on synthetic depth
(slanted plane + moving disc + far band + ±3-LSB noise).

1. **QP=0 VP9 is bit-exact; AV1 is not.** VP9 lossless (q_index 0) round-trips exactly through
   WebCodecs, encode *and* decode, no WASM. AV1 `quantizer:0` is *not* lossless (max Δ≈257). →
   **VP9 is the depth codec.** AV1 remains fine for the lossy RGB track.
2. **Triangle-fold beats byte-split by ~13%** (single frame) — range-slicing's coherence as one
   reversible map, zero bookkeeping.
3. **Inter coding is the big win: −52%** (9.37→4.50 bpp). Bit-exact across the whole GOP. The hi
   plane drops 74% (static structure), and the "noisy" lo plane drops 48% — most of that plane was
   *static fold structure*, not noise; inter prediction strips it, leaving the true noise floor.
4. **8-bit beats high-bit-depth.** `vp09.02.10.10` (10-bit) encode *is* supported in-browser, but a
   10+6 split is ~4% *worse* than 8+8 under inter coding (the 10-bit plane costs more than it saves).
   So 8+8 wins on both size and browser reach (no profile-2 dependency).

### Locked depth path
`float → inverse-depth uint16 → triangle-fold 8+8 → two VP9 streams (8-bit, profile 0), QP=0,
inter-coded (1 keyframe + P-frames)`. ~4.5 bpp on ±3-noise synthetic data; real-data TBD.

### Still open
- **Real-data validation** — drop actual depth frames through the harness; the lo-plane cost is
  noise-dominated and will differ from synthetic.
- **Browser encode breadth** — `VideoEncoder` is in Chrome, Firefox 130+, Safari 26+ (desktop).
  VP9 lossless confirmed on Chromium; Firefox/Safari unverified.
- **Build**: real encoder/decoder (triangle-fold + VP9 lossless GOP) + MP4/WebM muxing with a
  standard RGB track first (legacy fallback) + metadata box for the inverse-depth contract.

## experiments/webcodecs-lossless

Self-contained, zero-dependency HTML harness that measures #1 and #2 on your machine, on
synthetic depth or your own raw `uint16-LE` square frame.

```sh
cd experiments/webcodecs-lossless
python3 -m http.server 8000
# open http://localhost:8000  (localhost is a secure context, so WebCodecs is available)
```

Report shows, per codec × packing scheme: **lossless? / hi bpp / lo bpp / total bpp / vs byte-split**.
What we're looking for: `EXACT ✓` at QP 0, and triangle-fold's total bpp below byte-split's.
