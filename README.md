# ChromaPakZ

<p align="center"><img src="docs/logo.png" alt="ChromaPakZ — lossless RGBD video encoder" width="680"></p>

**A lossless RGBD video codec** (クロマパックZ): one ordinary `.webm` that carries an 8-bit **RGB** track
alongside **bit-exact 16-bit depth**, in sync. It is built so that

- a **legacy player shows plain RGB** — the depth rides in extra tracks a normal player ignores;
- it uses only **royalty-free** codecs (VP9 / libvpx, BSD) — no GPL encoder, no patent pool;
- it **encodes and decodes in the browser with no WASM**, via WebCodecs; and
- depth is packed with one **reversible map**, not the range-slice bookkeeping of older schemes.

It's a clean-room redo of an older MP4/x264 approach (RGB as YUV, plus 16-bit depth sliced into several
lossless-10-bit ranges). That design worked but had three thorns: x264 is GPL, the range-slicing was
fiddly, and the browser needed a WASM codec. ChromaPakZ removes all three.

The same format is implemented three times — **browser (WebCodecs)**, **C++ (libvpx)**, and **Python** —
and a file written by any one decodes bit-exactly in the others.

## Quickstart

```sh
# Browser demo — encode→file→decode→view, entirely in-page, no WASM
python3 -m http.server 8000      # from the repo root, then open http://localhost:8000/demo/

# Python — pip compiles the native libvpx core via CMake and bundles it
pip install .
python -c "import chromapakz as cz; cz.decode_depth(open('clip.webm','rb').read())"
#   cz.encode_rgbd(rgb_NHWc4_uint8, depth_NHW_uint16, near=.., far=..) -> webm bytes

# C++ / CLI
cmake -S . -B build && cmake --build build -j     # or: native/build.sh
native/dccli selftest
native/dccli decode clip.webm depth.u16           # depth track of any ChromaPakZ file
```

## How it works

| Layer | Choice |
|---|---|
| **Container** | WebM / Matroska, multi-track. RGB is track 1, so any player shows it; depth tracks are ignored by players that don't know them. |
| **RGB track** | 8-bit VP9, YUV 4:2:0, BT.709 full-range — a normal, viewable video stream. |
| **Depth** | float depth → **inverse-depth uint16** → **triangle-fold into two 8-bit planes** → two **VP9 lossless** tracks, inter-coded. |
| **Metadata** | A WebM tag carries the quantization contract (`near`/`far`/`levels`, scheme, units) so any decoder can reconstruct float depth. |

**Inverse-depth quantization** spends precision where it matters (near surfaces), matching how stereo/ToF
sensors behave. Float can't be stored losslessly in 16 bits, so this quantization *is* the format's defined
precision boundary; everything below it is bit-exact.

**Triangle-fold** is the key trick. The naive low byte `d & 0xFF` is a sawtooth — a hard `255→0` cliff
every 256 levels — and those manufactured edges wreck any spatial predictor (this is exactly why the old
design needed range slices). Reflecting every other segment (`lo = (high&1) ? 255-lo : lo`) turns it into a
continuous triangle wave with no cliffs, so VP9's own predictor works. It's range-slicing collapsed into one
reversible map, with nothing to manage.

**Full color range is signaled** in the bitstream (`VP9E_SET_COLOR_RANGE`), so a range-honouring decoder
returns the packed luma unscaled instead of applying a limited-range conversion that would corrupt depth.

### Why these choices (measured, not assumed — Chromium 148)

WebCodecs has no "lossless" switch, so every claim here is a measurement from
`experiments/webcodecs-lossless`:

- **VP9 at QP 0 is bit-exact through WebCodecs; AV1 is not** (AV1 `quantizer:0` drifts by up to ~257). So
  VP9 carries depth; AV1 is fine only for the lossy RGB track.
- **Triangle-fold beats a naive byte-split by ~13%**, and **inter-coding cuts another ~52%** (and stays
  bit-exact across the GOP) — most of what looks like incompressible LSB noise is actually static fold
  structure that temporal prediction removes.
- **8+8 beats high-bit-depth.** 10-bit VP9 encode *is* available in browsers, but a 10+6 split is ~4%
  *worse* than 8+8 and narrows browser reach, so 8+8 wins on both counts.

[`docs/EVALUATION.md`](docs/EVALUATION.md) is the full due-diligence record: every codec/container/packing
alternative considered, the constraint that eliminates each, a head-to-head benchmark (ChromaPakZ beats
FFV1, PNG-16, HEVC and x264 on the same depth, and lands within 1–2% of LZMA), cited licensing/browser
facts, and a sensitivity analysis of when a different choice would win.

## What it costs

Lossless 16-bit depth of a real sensor is **noise-bound**: the low bits are largely sensor noise, and
lossless coding must preserve every bit of it. On **real Kinect data** (TUM RGB-D `fr1/desk`, 30 frames at
640×480, 78% valid):

| track | bits / pixel |
|---|---|
| RGB | 0.19 |
| depth (hi + lo) | 0.50 + 4.35 |
| **total** | **5.04** |

— depth round-tripped **bit-exact**. Reproduce with `examples/tum_fr1desk.py` (see its header for the
one-line dataset fetch).

The one knob that moves this is the **quantization precision** vs the sensor's noise floor. Spreading depth
over all 65,535 codes makes one step far finer than the noise, so the codec faithfully archives randomness.
Coarsening the grid to match the noise collapses the cost — without losing real signal:

| effective bits | depth precision at 7.8 m | depth bpp |
|---|---|---|
| 16 (default) | 1.7 mm per step | 13.2 |
| 12 | 28 mm per step | 9.7 |
| 11 | 56 mm per step | 8.1 |
| 10 | 112 mm per step | 6.9 |

`levels` is a first-class, metadata-stored parameter (default 65536 = full 16-bit) shared by all three
implementations, so reduced-precision files reconstruct identically everywhere. Set it with
`ingest.py --depth-bits N` or the `levels=` argument.

### Codec rate-distortion

This is a separate axis from precision: how faithfully the *codec* carries whatever quantized depth you
give it. PSNR here is the encode→decode path measured against the source codes.

![ChromaPakZ codec rate-distortion](docs/rate-distortion.svg)

The lossless codecs all sit on the **∞-dB band** — they reproduce depth exactly and differ only in size,
where ChromaPakZ (VP9) is smallest, just under FFV1, with PNG-16 well behind. The blue curve is ChromaPakZ's
own near-lossless option (sweeping the VP9 quantizer trades fidelity for size), but the default operating
point is **QP 0, bit-exact**. Regenerate with `python python/plot_rd.py`.

> **A note on ffmpeg.** *Decoding* ChromaPakZ files with ffmpeg (or any conformant VP9 decoder) is
> bit-exact. But *encode* with ChromaPakZ, not the ffmpeg CLI: `ffmpeg -c:v libvpx-vp9 -lossless 1` is
> lossless yet **~3× larger** (≈39 vs ≈13 bpp) — same library, far worse coding decisions, and no flag
> tested closes the gap. `python/plot_rd.py` therefore uses the real WebCodecs encoder for the VP9 numbers.

## Cross-language implementations

All three read and write the identical `.webm`, verified bit-exact in every direction (browser ⇄ C++ ⇄
Python), and produce standard files — `ffprobe` reports `matroska,webm` with three VP9 streams, and ffmpeg
decodes track 0 as plain RGB.

| Surface | Codec | Build |
|---|---|---|
| **Browser** | WebCodecs VP9 | none — `src/chromapakz.js`, `src/webm.js` (pure JS) |
| **C++** | libvpx VP9 | CMake → `build/_core` + `dccli` |
| **Python** | binds the C++ core via ctypes | `pip install .` (scikit-build-core compiles & bundles the lib) |

```sh
native/dccli encodergbd rgb.rgba depth.u16 W H N fps near far kbps out.webm   # full RGBD
native/dccli decodergb  clip.webm rgb.rgba                                    # RGB track → raw RGBA
```

## Real-data ingestion (`python/`)

- **`ingest.py`** — load depth (`.exr` / `.npy` / `.npz` / 16-bit PNG·TIFF / raw) and optional RGB (image
  sequence, video via ffmpeg, or array), auto-derive inverse-depth `near`/`far` from percentiles, encode,
  and report real per-track bpp. Invalid pixels (`<=0`/NaN) map to code 0.
  `python ingest.py --depth 'd_*.exr' --rgb 'rgb_*.png' -o clip.webm --report --verify`
- **`make_synthetic_rgbd.py`** — a realistic RGBD generator (smooth surfaces, depth edges, disparity-domain
  noise, occlusion shadows, dropout holes) for when you don't have a sensor handy.
- **`webm_inspect.py`** — pure-Python EBML parser for the per-track byte breakdown.

## How it relates to RealSense / Kinect

Depth-camera ecosystems already split into two camps; ChromaPakZ takes the best of both.

- **Intel RealSense** colorizes 16-bit depth into an RGB image (Hue, ~10.5 effective bits) and encodes that
  with a stock H.264/H.265 codec. Great for streaming and reuse of hardware codecs, but **lossy** — unfit
  for ground-truth or archival depth.
- **Kinect / RGBD datasets** store depth raw or as 16-bit PNG. Azure Kinect even records to **Matroska**
  with a 16-bit depth track (lossless via per-frame PNG); TUM RGB-D, NYU and ScanNet use 16-bit PNG
  sequences. Bit-exact, but **intra-only and large** — no temporal compression.

| | RealSense colorize | Kinect / PNG | **ChromaPakZ** |
|---|---|---|---|
| bit-exact 16-bit depth | ✗ (lossy) | ✓ | **✓** |
| RGB plays in any legacy player | ✓ | — | **✓** |
| inter-frame (temporal) compression | ✓ (lossy) | ✗ | **✓ (lossless)** |
| royalty-free, browser-native, no WASM | — | — | **✓** |

That Azure Kinect already chose Matroska — WebM's basis — is telling. ChromaPakZ differs by *compressing*
depth losslessly (VP9 + triangle-fold, inter-coded) rather than storing raw or intra PNG, and by running in
the browser. Sources:
[RealSense colorized depth](https://dev.intelrealsense.com/docs/depth-image-compression-by-colorization-for-intel-realsense-depth-cameras),
[Azure Kinect record format](https://learn.microsoft.com/en-us/azure/kinect-dk/record-file-format).

## Repository layout

```
src/          chromapakz.js, webm.js        browser implementation (WebCodecs, no deps)
native/       chromapakz.{h,cpp}, dccli.cpp  C++ core (libvpx) + CLI; CMakeLists.txt at root
python/       chromapakz/ (pip package), ingest.py, make_synthetic_rgbd.py, plot_rd.py
demo/         index.html                     in-browser encode→decode→view demo
examples/     tum_fr1desk.py                 real Kinect data (TUM RGB-D) example
experiments/  webcodecs-lossless/            measurement harness (run.mjs) + headless tests
docs/         EVALUATION.md, RELEASING.md, rate-distortion.svg
tests/        roundtrip.py, ffmpeg_interop.py
```

CI builds and tests on Linux + macOS and runs the in-browser VP9-lossless probe in headless Chromium;
`docs/RELEASING.md` covers wheels and PyPI publishing. The full design rationale and benchmarks are in
[`docs/EVALUATION.md`](docs/EVALUATION.md).

## Status & limitations

Working end-to-end and verified across all three implementations. Honest caveats:

- **Browser support is engine-specific** (measured, [`EVALUATION.md` §11](docs/EVALUATION.md)): lossless
  *encode* is Chromium-only today (WebKit lacks WebCodecs' quantizer mode; Firefox's QP 0 isn't lossless);
  lossless *decode* works on Chromium and WebKit/Safari. Firefox decodes VP9 to color-converted BGRX, so
  it needs a fallback. These are Playwright engine builds — reconfirm on shipping browsers before hard
  claims.
- **No Cues/Duration yet**, so `<video>` seeking isn't smooth; the native RGB GOP uses a single keyframe.
- **"Royalty-free"** reflects the AOMedia/Google position on VP9; Sisvel operates pools that dispute it.
- An **auto precision picker** (estimate the sensor noise floor to choose `--depth-bits`) is future work.
