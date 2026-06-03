# depthcodec — design evaluation & due diligence

This document defends the design against the question *"did you actually consider the alternatives, or
just pick the convenient one?"* It enumerates the full option space on every axis, states the constraint
that eliminates each rejected option, and backs the load-bearing claims with **measurements run in this
repo** (reproducible) and **cited external sources**. It also says plainly where a *different* choice would
win if the constraints changed, and what remains unverified.

## 1. Method

- **Measured here** = produced by scripts in this repo, reproducible:
  `experiments/webcodecs-lossless/run.mjs` (WebCodecs probes, headless Chromium 148),
  `python/benchmark_codecs.py` (codec head-to-head), `experiments/webcodecs-lossless/png16-test.mjs`
  (browser 16-bit fidelity), `native/dccli selftest` (native bit-exactness).
- **Cited** = external authoritative source, URL in §10.
- All depth benchmarks use the same realistic synthetic clip (`make_synthetic_rgbd.py`: smooth surfaces,
  sharp depth edges, **disparity-domain sensor noise**, occlusion shadows, 5% dropout holes) — chosen to be
  *adversarial-but-realistic*, not flattering.

## 2. Requirements (from the brief)

| # | Requirement | Hardness |
|---|---|---|
| R1 | **Royalty-free** codec (no GPL, no patent pool) | hard |
| R2 | **Bit-exact 16-bit** depth (lossless) | hard |
| R3 | **Encode *and* decode in a browser, no WASM** | hard |
| R4 | RGB + depth in **one container**, synchronized | hard |
| R5 | **Legacy player shows RGB** (depth ignored) | soft (nice-to-have) |
| R6 | Good compression; small, simple pipeline (no range-slice bookkeeping) | soft |

The combination R1∧R2∧R3 is the binding constraint: **no codec is simultaneously royalty-free,
natively 16-bit-lossless, and browser-encodable+decodable without WASM** (proven below). Every decision
flows from resolving that conflict.

## 3. Axis — depth codec

The dominant choice. Properties needed: royalty-free (R1), reachable for **encode *and* decode** in a
browser with no WASM (R3), and able to carry lossless data (R2, possibly via an 8-bit split).

| Codec | License / royalties | Max bit depth · lossless | Browser encode+decode, no WASM | Verdict |
|---|---|---|---|---|
| **VP9** | BSD; royalty-free (AOMedia/Google, disputed by Sisvel) | 12-bit; **true lossless** (q_index 0, 4×4 WHT) | **Yes** — WebCodecs, all 3 desktop engines | **CHOSEN** |
| AV1 | BSD; royalty-free (disputed) | 12-bit; lossless only via identity matrix | decode yes; **encode lossless fails** | rejected (R2/R3) |
| VP8 | BSD; royalty-free | 8-bit; **no lossless mode** | yes | rejected (R2) |
| H.264/AVC | x264 = **GPL**; AVC **patent pool** (Via LA) | 14-bit; lossless (High 4:4:4) | yes | rejected (R1) — *this is the original codec being replaced* |
| HEVC | **patent pools** (Access Advance + Via LA + independents) | **16-bit native** lossless (Main 4:4:4 16 Intra) | no encoder in WebCodecs quantizer mode | rejected (R1, R3) |
| VVC | **patent pool** (Access Advance) | 16-bit (spec); lossless | no browser support | rejected (R1, R3) |
| JPEG-XL | BSD; royalty-free (ISO/IEC 18181) | **up to 32-bit**, true lossless | **no** (removed from Chrome 2023; decode-only flag in Canary; Safari partial) | rejected (R3) — *best ratio if R3 dropped* |
| FFV1 | LGPL; royalty-free (IETF **RFC 9043**) | **16-bit native** lossless, intra | no browser support | rejected (R3) — *best archival if R3 dropped* |
| PNG / APNG | permissive; royalty-free | 16-bit gray lossless | decode exists but **canvas truncates to 8-bit** (measured) | rejected (R2 in-browser, R3 encode) |
| lossless WebP | BSD; royalty-free | **8-bit only** | yes | rejected (R2) |
| AVIF | BSD; royalty-free | 12-bit; lossless via identity matrix | encode rare | rejected (same as AV1) |

**The two facts that select VP9** (both *measured here*, because the WebCodecs spec has **no first-class
lossless mode** — it must be validated, not assumed):

1. **VP9 at `bitrateMode:"quantizer"`, QP 0 is bit-exact through WebCodecs encode→decode.** Verified on an
   8-bit luma plane, single-frame and across an inter-coded GOP. (`run.mjs single|gop`)
2. **AV1 at QP 0 is *not* bit-exact** via WebCodecs (max Δ ≈ 257). libaom's true-lossless path
   (identity matrix) isn't reachable through WebCodecs' single quantizer knob. (`run.mjs single`)

So among royalty-free, browser-encodable codecs, **only VP9 delivers bit-exact lossless**. AV1 remains
viable for the *lossy RGB* track only.

## 4. Axis — 16-bit handling (the split)

VP9 caps at 12-bit, and high-bit-depth **encode** is rare in browsers even where decode is common (one
dataset: ~91% AV1 10-bit *decode* vs ~8% *encode* coverage — cited). The reliable substrate is 8-bit, so
16-bit depth must be split. Options, *measured* (`run.mjs split`, inter-coded):

| Split | bpp (synthetic) | Note |
|---|---|---|
| **8 + 8** (two 8-bit planes) | **4.50** | **CHOSEN** — widest browser reach, no profile-2 dependency |
| 10 + 6 (VP9 profile-2 10-bit + 8-bit) | 4.70 (+4%) | 10-bit plane costs more than it saves |
| native 16-bit | n/a | no royalty-free browser-encodable 16-bit codec exists |
| range-slices (original design) | — | the bookkeeping R6 explicitly wants gone |

10-bit VP9 encode *is* available in Chromium (measured: `vp09.02.10.10` supported; 12-bit and AV1-10 not),
but 10+6 is slightly *worse* and narrows portability, so 8+8 wins on both counts.

## 5. Axis — packing transform (8-bit planes)

The low plane is the cost driver. Naive `lo = d & 0xFF` is a **sawtooth** (a 255→0 cliff every 256 levels) —
manufactured high-frequency edges no spatial predictor handles, which is exactly why the original design
needed range slices. Options, *measured* (`run.mjs single`):

| Transform | low-plane bpp | total | Note |
|---|---|---|---|
| byte-split (sawtooth) | 9.41 | 10.80 | the failure mode |
| **triangle-fold** (reflect every other segment) | 8.01 | **9.41 (−13%)** | **CHOSEN** — range-slicing's coherence as one reversible map, zero bookkeeping |
| predictive (MED/Paeth) pre-filter | — | not needed | VP9 lossless already does intra-prediction; the fold is what lets it work |

Triangle-fold is reversible (`lo = (hi&1)?255-lo:lo`), so it preserves R2 exactly. It does **not** remove
true sensor-noise entropy (R2 requires carrying it); it removes only the *artificial* cost. This is the
constructive generalization of the prior-art periodic-wave depth encodings (Pece/Kautz/Weyrich 2011;
Intel RealSense hue) — but those are **lossy/near-lossless**; ours is bit-exact (§8).

## 6. Axis — frame coding, container, RGB, quantization

- **Inter vs intra (depth):** inter-coded lossless (1 keyframe + P-frames, QP 0) is bit-exact across the GOP
  and **−52%** vs intra (`run.mjs gop`: 9.37→4.50 bpp). Most of what looks like "incompressible LSB noise"
  is *static fold structure* that temporal prediction removes. **Inter chosen.**
- **Container:** WebM/Matroska — royalty-free, arbitrary multi-track (R4), and a legacy player plays track 1
  (RGB) and ignores the rest (R5, verified: `ffprobe` reads our files as `matroska,webm` with 3 VP9 streams;
  `ffmpeg` decodes track 0 to RGB). MP4 (VP9-in-ISOBMFF is valid) is a viable alternative but offers no
  advantage here and more muxing work; a custom container would forfeit R5. **WebM chosen.**
- **Browser delivery:** WebCodecs (native codecs, no WASM, R3). Alternatives: a WASM codec (the thing R3
  forbids), or `<video>`+canvas (8-bit only — see §8, fails R2). **WebCodecs chosen.**
- **RGB track codec:** VP9 (same codec, royalty-free). AV1/H.264 would also decode but add nothing (AV1
  encode is rarer; H.264 is patent-encumbered). **VP9 chosen.**
- **Quantization:** inverse-depth (disparity-like), which allocates precision to near surfaces, with a
  metadata-stored `levels` (default 65536 = full 16-bit). Linear or log are inferior precision allocations
  for depth; this is a standard choice (cf. Google Dynamic Depth `RangeInverse`).

## 7. Empirical head-to-head: is VP9-lossless competitive on *ratio*?

The skeptic's core worry: that we traded compression for browser-convenience. We didn't.
Same uint16 depth, every credible lossless codec, bits/pixel (`python/benchmark_codecs.py`):

**Full 16-bit (realistic noisy depth):**

| codec | bpp | vs depthcodec | royalty-free | 16-bit native | browser enc+dec, no WASM | seekable video |
|---|---|---|---|---|---|---|
| **depthcodec (VP9 lossless, tri-fold 8+8, inter)** | **13.20** | — | ✅ | (8+8) | ✅ | ✅ |
| raw uint16 + LZMA-9e | 13.08 | −1% | ✅ | ✅ | ❌ | ❌ |
| FFV1 (16-bit, intra) | 13.83 | +5% | ✅ | ✅ | ❌ | ❌ |
| PNG-16 per frame (intra) | 13.84 | +5% | ✅ | ✅ | ❌ (8-bit canvas) | ❌ |
| raw uint16 + bzip2-9 | 13.73 | +4% | ✅ | ✅ | ❌ | ❌ |
| x264 lossless 8+8 (GPL) | 19.41 | +47% | ❌ GPL | — | ❌ | ✅ |
| raw uint16 (uncompressed) | 16.00 | +21% | — | — | — | — |

**Matched 11-bit precision (noise-floor-matched):**

| codec | bpp | vs depthcodec |
|---|---|---|
| **depthcodec** | **8.09** | — |
| raw uint16 + LZMA-9e | 7.93 | −2% |
| FFV1 | 8.34 | +3% |
| x265/HEVC lossless 12-bit (patent pool) | 8.58 | +6% |
| PNG-16 | 9.95 | +23% |
| x264 8+8 (GPL) | 11.93 | +47% |

**Reading:** depthcodec **beats FFV1, PNG, HEVC and x264**, and is within **1–2%** of LZMA-9-extreme — a
non-realtime, non-seekable, non-browser archival compressor that satisfies *none* of R1∧R3∧R4∧R5. Under
heavy noise all lossless codecs converge near the entropy floor (the noise *is* the cost), so depthcodec's
real win is meeting every constraint at **no ratio penalty**. (libaom-AV1 and libjxl weren't in this ffmpeg
build; AV1 is ruled out by §3, and JPEG-XL — likely the ratio leader — is ruled out by R3, §3/§9.)

## 8. Settled browser-fidelity questions

- **16-bit PNG/APNG in-browser is not viable for lossless depth.** A 16-bit PNG with 65,536 distinct values
  read back via canvas `getImageData` yields **256 distinct values, max 255** — the readback buffer is
  `Uint8ClampedArray` (8-bit) by spec. (`png16-test.mjs`) This eliminates the most-cited "but it's
  browser-native" alternative. (A WebGL float/16-bit-texture path exists but is complex and not the simple
  `<video>`/canvas route.)
- **WebCodecs has no lossless mode**; bit-exactness must be empirically validated per codec/browser — which
  is why §3's VP9-vs-AV1 result is a measurement, not an assumption.
- **AV1 lossless is unreachable** through WebCodecs' quantizer knob (§3).

## 9. Sensitivity analysis — when a different choice wins

This design is optimal *for R1∧R2∧R3*. Relax a constraint and the answer changes — stated explicitly so the
scope of the recommendation is clear:

| If we drop… | Better choice becomes | Why |
|---|---|---|
| R3 (browser, no WASM) | **JPEG-XL** (ratio leader, 16-bit, royalty-free) or **FFV1** (archival) | both natively 16-bit lossless; JXL likely smallest |
| R3 encode-only (decode-in-browser still needed) | offline FFV1/JXL + a WASM decoder, or AV1 high-bit | removes the hardest half of R3 |
| R2 (lossless) | **Pece-2011 / RealSense hue** colorization, or high-quality lossy VP9/AV1 | near-lossless packs 16-bit into 8-bit channels at a fraction of the size |
| R1 (royalty-free) | **HEVC Main 4:4:4 16 Intra** | only mainstream codec with *native* 16-bit lossless mono — but still no browser encode |
| nothing | **depthcodec as specified** | the only point satisfying all of R1–R5 |

## 10. Prior art surveyed

- **Pece, Kautz & Weyrich, "Adapting Standard Video Codecs for Depth Streaming" (2011)** — the canonical
  periodic/triangle-wave packing of 16-bit depth into 8-bit channels to survive *lossy* codecs.
  Near-lossless; ours adapts the triangle idea but stays **bit-exact** via a lossless codec.
- **Intel RealSense "colorized depth"** — Hue encoding (~10.5 effective bits), lossy, ~80× with commodity
  codecs. Caps precision; not lossless.
- **MPEG Immersive Video (MIV) / 3D-HEVC / MV-HEVC** — standardized multi-view-video-plus-depth for
  volumetric/6-DoF. Heavyweight, HEVC-based (patent pool), not browser-native; overkill for one RGBD stream.
- **Google Draco** — mesh/point-cloud geometry compression, *not* depth-video. Out of scope.
- **Google Dynamic Depth / HEIF depth aux images / glTF** — *still-image* RGB+depth containers
  (XMP/ISOBMFF). Validate the inverse-depth metadata idea (we use `RangeInverse`-style), but not for video.
- **Academic lossless depth-map codecs** (binary-tree + context arithmetic; L∞ near-lossless; DDR;
  edge+diffusion) — beat generic image codecs by exploiting piecewise-smooth depth, but are custom and would
  need WASM (conflicts with R3).

## 11. Residual risks / not-yet-verified

- **VP9 lossless confirmed on Chromium only.** Firefox 130+ and Safari 26+ ship `VideoEncoder`, but
  bit-exact VP9-QP0 on those engines is unverified. Firefox WebCodecs is **desktop-only** (no Android);
  Safari < 26 is partial. Mobile coverage is materially worse than "Chrome full." *(cited)*
- **"Royalty-free" for VP9/AV1 is the AOMedia/Google position; Sisvel operates pools disputing it.** *(cited)*
- Synthetic data only so far — real-sensor bitrate will differ (noise-dominated; §7 shows the trend).
- No Cues/Duration yet (seekable `<video>` playback); native RGB GOP mirrors the browser (one keyframe).

## 12. Sources

VP9 https://en.wikipedia.org/wiki/VP9 · AV1 https://en.wikipedia.org/wiki/AV1 ·
VP8 https://en.wikipedia.org/wiki/VP8 · AVC pool https://www.via-la.com/licensing-2/avc-h-264/ ·
x264 GPL https://x264.org/licensing/ · HEVC https://en.wikipedia.org/wiki/High_Efficiency_Video_Coding ·
VVC pool https://accessadvance.com/licensing-programs/vvc-advance/ · JPEG-XL https://jpegxl.info/ ·
FFV1 RFC 9043 https://datatracker.ietf.org/doc/rfc9043/ · PNG https://www.w3.org/TR/png/ ·
WebP https://developers.google.com/speed/webp/docs/riff_container ·
WebCodecs support https://caniuse.com/webcodecs ,
https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API ·
per-frame quantizer https://gist.github.com/Djuffin/3722232679b977058be787be0dff4254 ,
https://groups.google.com/a/chromium.org/g/blink-dev/c/UZWH1LuwBas ·
VideoFrame formats (I420P10/12) https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame/format ·
Pece 2011 https://jankautz.com/publications/depth-streaming.pdf ·
RealSense colorized depth https://dev.intelrealsense.com/docs/depth-image-compression-by-colorization-for-intel-realsense-depth-cameras ·
MPEG-MIV https://mpeg-miv.org/index.php/overview/ · Draco https://github.com/google/draco ·
Dynamic Depth https://developer.android.com/media/camera/camera2/Dynamic-depth-v1.0.pdf
