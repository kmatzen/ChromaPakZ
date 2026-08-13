# Changelog

Notable changes per release. Versions are shared by the Python package (PyPI `chromapakz`) and the
browser library (npm `chromapakz`), which are cut from the same tag — so a version present on one
registry means the same commit on the other.

## 0.11.0 — 2026-08-12

Streaming encodes now run a realtime profile; batch encodes are unchanged.

### Changed — the streaming encoder targets the frame budget, not the archive

`dc_stream_*` encoders (live capture: WurldCam, the browser recorder's native
sibling) now encode with the REALTIME deadline, cpu-used 8 on lossy RGB and 9
on lossless planes. Batch (`encode`, the converters) keeps GOOD_QUALITY and its
measured tradeoffs — a converter is not racing a sensor, and its bytes are
archival.

Measured on Apple-silicon arm64 at the LiDAR-capture geometry (960x720 RGB +
256x192 depth + confidence, noisy planes):

|                              | before | after | speedup |
|------------------------------|--------|-------|---------|
| full streaming pipeline      | 47.4 ms/frame | 12.7 ms | 3.7x |
| lossy RGB 960x720            | 32.2 ms | 7.3-10.4 ms | 3-4x |
| lossless signals 256x192 x2  | 25.0 ms | 6.1 ms | 4.1x |

On an iPhone 15 Pro this moves a real capture from ~19 fps effective (half the
frames dropped by backpressure) to the full sensor rate at 960x720.

Two things did not change. Lossless stays bit-exact: `VP9E_SET_LOSSLESS` gates
fidelity at every speed step, so realtime costs a few percent of compression
ratio, never a bit of data — reverified by round-trip. And lossy quality is a
bitrate question now rather than a deadline question: at the same bitrate the
realtime deadline costs ~7 dB PSNR, but at 6000 kbps it measures 39.2 dB —
above the old 2000 kbps baseline's 38.6 — while still 3x faster. Callers that
stream lossy RGB should raise their bitrate accordingly; WurldCam does.

## 0.10.0 — 2026-08-12

### Added — per-stream resolution (format v4)

Streams no longer have to share the file's one `width`×`height` — only its frame grid. The
motivating case: depth at sensor resolution (a 256×192 LiDAR map) riding beside full-resolution
RGB, instead of upsampling the depth to the video size and paying to code pixels that carry no
information. Any `rgbs[]` or `signals[]` entry may now declare its own `width`/`height`.

- **Format.** An entry carries the keys only when its resolution actually differs, and the file
  says `"version": 4` only when at least one entry does — a file whose streams all share the
  file resolution is **byte-identical v3 output**, so nothing written before this changes and
  the committed fixtures stand. The top-level `width`/`height` remain the primary display
  resolution (the primary RGB stream's; the first signal's in an RGB-less file). Each video
  TrackEntry's `PixelWidth`/`PixelHeight` now states its own track's geometry. Pre-v4 readers
  fail loudly (`DC_ERR_GEOMETRY` / a geometry mismatch, never silent corruption) on the streams
  that differ, and read everything else as before. Nothing resamples: pixel alignment across
  geometries belongs to wrapper formats, as `view` always did.
- **Python.** Batch `encode()` simply accepts what it used to reject: each signal/stream array
  brings its own `(H, W)`, and only the frame count must agree. `create_encoder()` declares
  geometry per spec — `width`/`height` on a signal spec, dict entries in `rgbs`
  (`rgbs=["cam0", {"id": "guide", "width": 320, "height": 240}]`). Decoders size every buffer
  from the stream's own metadata entry, so each comes back at its own shape;
  `chromapakz-ingest` now takes depth and RGB of different sizes.
- **Browser.** Same shape: `width`/`height` on signal specs and `rgbs` entries; per-frame plane
  checks, the codec tracks, and both decoders (buffered and streaming) run at each stream's own
  geometry. The two writers emit identical metadata for identical configurations, as ever.
- **C ABI.** New `dc_rgb_spec2_t` / `dc_signal_spec3_t` (the old structs plus `width`/`height`;
  0,0 = the file default) with `dc_encode_multi3` / `dc_encode_multi_hdr3` /
  `dc_stream_create3` / `dc_stream_create_hdr3`, following the `*2` precedent — every existing
  entry point is untouched. Decode entry points need no new forms: they resolve each stream's
  geometry from the metadata, and their capacity contract already bounds the writes.

## 0.9.1 — 2026-08-11

Two browser-side fixes, both cases where the library rejected or discarded
something it had told the caller was fine.

### Fixed

- **The JS decoder refused RGB-only files.** `normalizeMetadata` treated an empty
  `signals[]` as malformed, so `createDecoder` threw `metadata must include
  signals[] (v2)` on files this library itself writes — `planSignals` has always
  called an RGB-only take a valid plan ("video plus wrapper metadata, no aux
  planes") and both writers emit `signals: []` for one. Encoder and decoder
  disagreed about whether such a file was legal, and the decoder lost.

  Found from the outside: dropping an RGB-only capture into the wurld web viewer
  did nothing at all, because the throw escaped into an unhandled rejection.

  `signals` must still be present and an array — that is the v2 shape — but
  emptiness is only an error when there is no RGB stream either, which is the
  genuine nothing-to-decode case. That check now runs after `rgbs[]` is resolved.
  Nothing that decoded before decodes differently.
- **`addText` on a buffered browser encoder silently dropped the cue.** Timed text is written
  through the incremental muxer, but the buffered path builds its file from `muxFrames` via
  `mux()`, which emits SimpleBlocks and has nowhere to put a cue's duration — so the finished
  file declared the text track and carried none of its blocks. It now throws, pointing at the
  streaming encoder. Present since the metadata track landed in 0.5.0.

### Docs

- Swept every doc for claims the 0.7.0/0.8.0 format changes invalidated: the README's one-RGB-track
  and 8-bit-SDR framing, the cross-language "bit-exact in every direction" claim (HDR is
  write-native / play-in-browser), `docs/RELEASING.md`'s libvpx flag list (missing
  `--enable-vp9-highbitdepth`, and its now-three acceptance conditions), `decode_rgb`'s dtype for
  HDR streams, the Python signatures missing `hdr=`/`text_track=`, `DC_ERR_GEOMETRY`'s 8-bit-only
  wording, and the C entry-point list. Also documented the timed-text track, which had shipped in
  0.5.0 with no user-facing docs at all.

## 0.9.0 — 2026-08-09

Two changes to how the batch path behaves, neither of which alters a byte of
output for a whole-file encode or decode.

`decode()` now sizes its buffers from the data rather than the header, so a
partial decode returns the frames it actually decoded instead of a
whole-sequence array padded with black ones — and costs 14.7 MB per Cluster
where it cost 277 MB. New `frames_present(data)` answers "how many frames are in
these bytes", which `probe()["frames"]` deliberately does not.

The batch encoder runs its tracks concurrently, as the streaming path already
did: 1.3-1.5x faster wherever a lossless signal is present, byte-identical
output.

### Changed — the batch encoder runs its tracks concurrently — #59

`buildFileMulti` encoded each track in turn: RGB, then every signal's high plane,
then its low plane. The streaming path was made concurrent when multi-track
landed; the batch path was not, and it is the one every converter uses.

The tracks were already independent — separate VP9 contexts writing separate
buffers — so this is a scheduling change, not a rewrite. Packing moved ahead of
the encodes, which is what the streaming path also had to do: a shared hi/lo
scratch pair is exactly what forces encodes to be serial.

Lossless coding dominates, which is why it pays. At 752x480 with RGB + depth:
RGB 8.7 ms/frame, depth 82.5 ms, total 91.2 ms.

|      size | before | after |
|-----------|--------|-------|
|   256x192 |  20.1  | 13.0  |
|   752x480 |  90.4  | 59.9  |
|  1280x720 | 166.1  | 126.8 |

End to end on a real TUM `freiburg1_desk` conversion: 106 s -> 87 s.

Output is **byte-identical** — same sha256 on a two-signal file, and the TUM
conversions above compare equal byte for byte. Only the scheduling changed.

A file with no lossless signal gains little (real EuRoC stereo: 26 s -> 25 s),
since lossy RGB was never the expensive part.

### Fixed — a partial decode sized its buffers from the header — #57

Cluster independence (#45) exists so a caller can splice one Cluster onto a
file's header and decode just that. `probe()["frames"]` reports what the header
*declares* — the whole sequence — and the decoders sized their output from it,
with two consequences. The second is the sharper one:

- Every partial decode allocated for the entire sequence: **277 MB per Cluster**
  on a 600-frame 320x240 file with depth, against **14.7 MB** now. Fetching a
  single frame cost 279 MB and now costs 16.4 MB.
- The returned array was padded with zeroed frames that were never decoded, and
  nothing distinguished them from genuinely black ones. Splicing one 30-frame
  Cluster of a 600-frame file returned 600 rows, 570 of them silently black. A
  caller who did not already know the Cluster's count could not tell.

Buffers are now sized by counting the blocks actually present, clamped to what
the header declares so a file carrying *more* blocks than it claims behaves as
before. `decode()["frames"]` reports what came back, so it always equals
`len(result["rgb"])`; `metadata` still carries the declared length.

`probe()["frames"]` is unchanged and still reports the header's value — that is
the sequence's declared length, and a partial decode legitimately differs from
it. New `frames_present(data)` answers the other question. Counting costs a walk
of the Cluster headers: ~4 ms on a 13 MB 600-frame file, against a decode of the
same file measured in seconds.

Whole-file decode is unaffected: same rows, same bytes, same peak.

## 0.8.0 — 2026-08-08

### Added — HDR10/HLG display track: VP9 profile 2 + WebM Colour signalling — #51

The lossy display track can now be HDR: **VP9 profile 2, 10-bit, BT.2020
non-constant-luminance, broadcast range**, with the part that actually makes a
player treat it as HDR — the WebM **`Colour`** element (`TransferCharacteristics`
PQ 16 / HLG 18, `Primaries` 9, `MatrixCoefficients` 9, `Range`, optional
`MaxCLL`/`MaxFALL` and ST 2086 `MasteringMetadata`) — written by **both** muxers,
byte-identically. The metadata's rgbs entries carry the full WebCodecs codec
string (`vp09.02.10.10.01.09.16.09`) plus an `"hdr"` object mirroring the Colour
element. HDR applies to all of a file's RGB streams; pixels cross every API as
uint16 planes of 10-bit display codes (0..1023). Scene-referred HDR is
explicitly not this — scene-linear data belongs in the lossless signal tracks.

- **C ABI**: `dc_hdr_meta_t`, `dc_encode_multi_hdr`, `dc_stream_create_hdr`,
  `dc_stream_add_frame16`, `dc_decode_rgb16`. The 8-bit and 10-bit forms refuse
  each other's streams (decode error 7) instead of truncating or reinterpreting.
- **Python**: `encode(..., hdr={'transfer': 'pq', 'max_cll', 'max_fall',
  'mastering'})`, `create_encoder(hdr=...)`; `decode_rgb`/`decode()` return
  uint16 codes for HDR streams automatically, uint8 for SDR as before.
- **JS**: the muxer/demuxer in `src/webm.js` read and write the Colour element
  (byte-compatible with the C muxer); the decoder reads HDR files — signals and
  SDR streams decode, HDR RGB streams are skipped (no 10-bit WebCodecs output
  path yet) with their metadata exposed; `createEncoder({ hdr })` throws rather
  than writing 8-bit data under an HDR label. Browsers play HDR files natively
  in `<video>`, which is the display track's job.

### Compatibility

SDR files are byte-unchanged (no Colour element, same codec string). HDR files
are a new capability: pre-0.8.0 readers fail loudly on the profile-2 stream
(geometry error) rather than mis-decoding it; their signals still decode.
Verified in Chrome 148: `mediaCapabilities.decodingInfo` reports the exact
HDR10 configuration supported/smooth/power-efficient, and a `VideoDecoder`
configured from the file's own codec string decodes every packet. Interactive
HDR-display rendering (and Safari, where VP9 support is narrower) still wants a
human eye — see #51.

## 0.7.0 — 2026-08-08

### Added — multiple RGB tracks (stereo / multi-camera) — #47

A file can now carry N synchronized lossy RGB streams beside the lossless
signals — a stereo rig stores both cameras' pixels in the same clusters, on the
same timeline. Metadata is **v3**: `rgbs[]` lists every stream
(`{id, track, codec}`, tracks 1..N in declaration order); the legacy `rgb` key
stays and always duplicates `rgbs[0]`. The **primary** stream keeps track 1 and
the container name `rgb` — the pair pre-0.7.0 readers key on — so old readers
decode it exactly as before and ignore the rest; secondaries are named
`rgb-{id}`. Signal hi/lo tracks number after all RGB tracks. All streams share
the file's W×H and its frame grid: every declared stream is written on every
frame (the JS encoder additionally lets a stream start late, as signals always
could, but never gap). Unsynchronized rigs are out of scope.

- **JS**: `createEncoder({ rgbs: ['cam0', { id: 'cam1', kbps }] })`,
  `addFrame({ rgbs: { cam0, cam1 } })` (`rgb:` stays sugar for the primary);
  decoded frames gain `frame.rgbs`, `decode()` a per-stream `rgbs` series.
- **Python**: `encode(rgbs={id: array}, rgb_kbps={id: kbps})`,
  `create_encoder(rgbs=[...])` + `add_frame(rgbs={...})`,
  `decode_rgb(data, stream=)`, `decode()["rgbs"]`, `probe()["rgbs"]`.
- **C ABI**: new `dc_rgb_spec_t` / `dc_signal_spec2_t`, `dc_encode_multi2`,
  `dc_stream_create2`, `dc_stream_add_frame2`, `dc_decode_rgb_id`. The original
  entry points are unchanged single-stream forms (a multi-stream encoder refuses
  the single-pointer `dc_stream_add_frame`); `dc_probe`'s `has_rgb` out-param now
  counts streams — still 0/1 for old files, so truthiness checks keep working.
- **`view` hint**: a signal spec/metadata entry may name the RGB stream whose
  camera frame it lives in (e.g. disparity in `cam0`'s rectified frame).
  Recorded verbatim, interpreted by nothing — association semantics belong to
  wrapper formats.

### Compatibility

Additive. Old files (v2, no `rgbs`) read unchanged in 0.7.0 readers as a single
stream under the default id `"rgb"`. New single-stream files bump to
`"version": 3` and add a one-entry `rgbs[]`; pre-0.7.0 readers ignore the
unknown key (the C parser walks the document structurally) and decode via the
legacy `rgb` key / track name as before. Multi-stream files decode their primary
in old readers; the extra streams are invisible there. The C and JS writers
remain byte-identical for identical configurations (covered by
`tests/test_multi_rgb.py`).

## 0.6.0 — 2026-08-07

### Changed — encode speed

A capture's write chain runs one frame at a time, so every millisecond here is
frame budget. Measured throughout on a real LiDAR take (256x192, RGB + depth +
confidence) rather than synthetic data — sensor noise is what makes lossless
coding expensive, and smooth synthetic depth understates it threefold.

    original                        89.7 ms/frame
    lossless cpu-used 1 -> 6        59.5
    row multithreading              51.2
    lossy rgb cpu-used 2 -> 4       44.3
    concurrent track encoding       ~18            5x overall

- **Tracks encode concurrently.** Each track is an independent VP9 encoder, so a
  frame's slots can run at the same time; only the muxing has to stay ordered.
  The single hi/lo packing scratch pair was reused across signals, which is what
  had forced the encodes to be serial — packing now happens first, into
  per-signal buffers. Output is byte-identical run to run: blocks merge in slot
  order and are still sorted by (time, track) before muxing.

- **Lossless `cpu-used` 1 -> 6.** Under `VP9E_SET_LOSSLESS` the reconstruction is
  bit-exact at every setting, so this knob only trades encode time against
  compression ratio. It was pinned near the slow end. 1.5x faster for 2.5% more
  bytes; 7..9 give nothing further.

- **Row multithreading.** `g_threads` alone buys nothing — VP9 only spreads work
  across threads with row-mt or tiling, and tile columns want >=256px per tile,
  which a 256-wide frame cannot give more than one of. Now mostly matters to the
  batch encoder, which still drives tracks serially. Avoid `g_threads=2`: it
  measured reproducibly worse than either 1 or 4.

- **Lossy RGB `cpu-used` 2 -> 4.** The one fidelity change in this release: at a
  fixed 2000 kbps, PSNR 42.75 dB -> 40.75 dB for ~7 ms/frame. Depth and other
  lossless signals are unaffected and remain bit-exact.

### Compatibility

No API or format change. Files written by 0.6.0 differ from 0.5.0 only in the
lossy RGB track's rate-distortion choices; every lossless signal round-trips
bit-exactly as before, and 0.5.0 readers read 0.6.0 files.

## 0.5.0 — 2026-08-07

### Added

- **Timed-text metadata track.** `create_encoder(..., text_track="name")` declares a WebVTT
  track alongside the video and signal tracks, and `add_text(text, timestamp, duration=None)`
  appends cues into the cluster the surrounding frames are already filling. In JavaScript:
  `createEncoder({ textTrack })` and `addText()`. In C: `dc_stream_create_ex` and
  `dc_stream_add_text`.

  This exists so per-frame metadata is reachable by tools nobody here controls. Container tags
  are for file-level data, and ffmpeg's Matroska demuxer maps `TagString` into metadata while
  skipping `TagBinary` entirely — so binary per-frame tables are invisible to it. A track is
  what GoPro (GPMF), MISB KLV and Apple's `mebx` all use for the same reason.

  Two container details are easy to get wrong and are covered by tests in both implementations:
  WebM defines its own WebVTT CodecIDs, so Matroska's `S_TEXT/WEBVTT` demuxes as a subtitle
  stream with an unknown codec; and a WebVTT block is framed
  `identifier \n settings \n payload`, so omitting the newlines makes a reader take the whole
  block as the identifier and every cue extracts empty from a file that otherwise parses fine.

  Text never drives cluster boundaries — those stay with the cue track — so it only forces a new
  cluster when the relative timestamp would overflow the `int16` in a Block header. Cues carry a
  duration, which `SimpleBlock` cannot express, so they are written as `BlockGroup`.

### Compatibility

- Additive. `dc_stream_create` forwards to `dc_stream_create_ex` with no track, so 0.4.0 callers
  are unaffected, and the Python layer binds the new entry points only when the loaded core
  exposes them — a stale native build still streams, just without a metadata track.

## 0.4.0 — 2026-08-06

### Added

- **RGB-only streaming encode.** `create_encoder(W, H, has_rgb=True)` with no `signals` was
  refused by both wrapper layers even though the native ABI accepts it and the batch encoder always
  allowed `encode({}, rgb=…)`. A pose-only wrapper recording (wurld: RGB + camera poses, no
  depth) needs exactly this. `None`, `[]` and `{}` are equivalent; a stream with no tracks at all
  is still refused ("need rgb or at least one signal"). (#44)

### Changed

- **Signal tracks keyframe at the RGB cadence** (every `fps` frames, matching the muxer's cluster
  flush), so every Cluster starts with keyframes on all tracks and `[header + Cluster k]` decodes
  that cluster's frames bit-exactly in isolation — Cues-based random access now works for depth/ID
  planes, not just RGB. Measured cost: +1.0% file size on a 90-frame 480×360 RGBD clip.
  Bit-exactness and old-decoder compatibility are unaffected. (#45)

### Added

- **Streaming encode from Python: `cz.create_encoder()`.** The Python API was batch-only —
  `encode()` needs every frame up front — so live capture from a robot, rig or simulator had no
  path, and an interrupted take lost everything rather than its tail. The new encoder writes the
  file as it is captured, mirroring the browser encoder's `onChunk`: the header goes out before the
  first frame, whole Cluster elements follow as they close, and nothing it retains grows with the
  take. Because the Segment carries an unknown size, what is on disk is a valid, decodable WebM at
  every point.

  ```python
  enc = cz.create_encoder(W, H, fps=30, has_rgb=True, on_chunk=f.write,
                          signals=[{"id": "depth", "near": 0.4, "far": 12.0}])
  enc.add_frame(rgb=rgba, signals={"depth": {"float": z}})
  enc.finish()
  ```

  The chunks are element-aligned, so a wrapper format can interleave its own Matroska elements
  between them without re-parsing byte boundaries — pass `cues=False` when it does, since injected
  bytes invalidate the cue offsets. See [docs/API.md](docs/API.md#streaming-encode-live-recording).
- **C ABI: `dc_stream_create` / `_header` / `_add_frame` / `_finish` / `_destroy`**, the entry
  points behind it. Additive — no existing declaration changed, and a batch encode produces
  byte-identical output to 0.3.1.

### Internal

- The two batch encode paths and the streaming one now share one `TrackEncoder`, and the batch and
  streaming muxers share their EBML header, track and Cues builders, rather than each carrying its
  own copy of the libvpx configuration.

## 0.3.1 — 2026-08-05

A documentation release. No code changed: the wheels, the npm tarball and the file format are
functionally identical to 0.3.0. It exists because a registry's project page is frozen at upload
time — neither PyPI nor npm can edit a published description — so the only way to correct one is to
publish a version.

### Fixed

- **The README's images and doc links were dead on PyPI.** The README is the PyPI long description,
  and its asset paths were repo-relative, so on the project page they resolved against
  `pypi.org/project/chromapakz/` — both images rendered broken and the six `docs/*.md` links went
  nowhere. They are now absolute GitHub URLs (`raw.githubusercontent.com` for the images, which
  serves the SVG as `image/svg+xml` so PyPI's camo proxy accepts it), which resolve on every
  registry as well as on GitHub.

### Internal

- A release whose changelog section still says "unreleased", or carries no date, now fails
  `version-guard` rather than shipping — the tag freezes the tree and the sdist carries
  `CHANGELOG.md` to PyPI permanently, which is how 0.3.0 shipped an undated section.

## 0.3.0 — 2026-07-29

First release of the browser library to npm, and the first with a breaking change to the native C
ABI. The file format itself is unchanged: a `.webm` written by 0.2.0 decodes bit-exactly under
0.3.0 and vice versa.

### Breaking

- **The C ABI decode entry points take a buffer capacity.** `dc_decode_signal` and `dc_decode_rgb`
  each gained a trailing `size_t` (`out_cap` / `rgba_cap`), and four shared error codes were added
  (`DC_ERR_CAPACITY` 9, `DC_ERR_GEOMETRY` 10, `DC_ERR_INTERNAL` 11, `DC_ERR_CODEC` 12). Callers of
  the Python or JavaScript API are unaffected — the wrappers pass the capacity. Anyone calling the
  C ABI directly must recompile against the new `native/chromapakz.h`: the old four-argument call
  still links, and then reads an uninitialised capacity at runtime.
- **32-bit Linux (`i686`) wheels are no longer built.** 0.2.0 published them because they came in
  with cibuildwheel's default architectures; `manylinux_2_28` has no i686 image. Install from the
  sdist if you need one.
- **Linux wheels are now `manylinux_2_28`** (glibc 2.28+ — RHEL 8, Debian 10, Ubuntu 18.10 and
  newer) rather than `manylinux2014`, whose CentOS 7 base is end-of-life. Older glibc falls back to
  a source build from the sdist.

### Security / correctness

- **The native decoders no longer trust the header.** A file's metadata, its bitstreams and what
  `dc_probe` reports can all disagree. A header declaring `"frames":1` over a hundred-frame track
  used to walk off the end of the caller's buffer, and one claiming 4096×4096 over a 16×16
  bitstream read far past libvpx's planes. Each decode now takes the caller's capacity, refuses to
  exceed it, and validates every decoded image's geometry before copying it out.
- **The metadata tag is read and written as JSON**, not matched as substrings. Signal ids
  containing `"`, `\` or `]` produced files the encoder's own decoder could not read back, or that
  were not valid JSON at all; a fixed-width scan window let an unquantized signal inherit the next
  signal's inverse-depth range. Nesting is depth-capped, so a crafted document cannot exhaust the
  stack.
- **The native EBML/SimpleBlock demuxer is hardened against malformed input** — truncated
  elements, oversized declared sizes and unknown-size elements are clamped to their parent rather
  than producing out-of-range reads.
- **The C ABI is total**: no exceptions escape it, libvpx return codes are checked (a codec that
  cannot be configured losslessly reports `DC_ERR_CODEC` instead of silently encoding lossily), and
  `fps=0` no longer divides by zero.
- **The JS demuxer is hardened** likewise, and a WebCodecs error no longer leaves an encode hanging
  on a promise that will never settle.
- **Plane lengths are validated** before they reach either codec backend, so a short luma plane can
  no longer encode zero-filled rows and an oversized one cannot overwrite the I420 chroma half.
- **libvpx is linked statically and the export table is restricted to `dc_*`.** `_core` exported
  ~13 undefined `vpx_*` symbols, which ELF resolves through the process-global scope in load order
  — so `import decord` (which dlopens its own libvpx with `RTLD_GLOBAL`) before `import chromapakz`
  bound our encoder to decord's ABI-incompatible copy and broke encoding.

### Fixed

- `near`/`far` were written to the file with `%g` — six significant digits — so a range needing
  more came back out as a different number and dequantized to slightly different metres. They now
  round-trip exactly.
- The network streaming decoder buffered the whole stream and emitted every frame at `finish()`.
  It is now a real incremental parser that yields blocks as they arrive and releases bytes it has
  already parsed.
- Concurrent `addFrame`/`readFrame` calls are serialized; overlapping calls previously handed a
  chunk to the wrong caller or left a promise unresolved.
- RGB no longer collides with signal track 1 when the first RGB frame arrives after frame 0.
- The Python API rejects lossy `uint16` casts instead of silently wrapping mod 65536.
- The pure-Python WebM inspector parses streamed (unknown-size) files.
- `ingest` and `webm_inspect` ship in the wheel, and `chromapakz-ingest` is installed as a command.
- The native core loads lazily, so the pure-Python helpers import without a compiled `_core`.

### Packaging

- **npm**: the browser library is published as [`chromapakz`](https://www.npmjs.com/package/chromapakz)
  with build provenance. `src/` is the shipped artifact — there is no build step — and the
  committed `vp9-*.wasm` codecs are included for engines whose native WebCodecs path is not
  bit-exact.
- **macOS wheels target 13.0 rather than 15.0**, so macOS 13 and 14 get a wheel instead of a source
  build. The deployment target used to be pinned by Homebrew's libvpx bottle, which carries the
  build runner's own macOS as its minimum; libvpx is now built from source. Still arm64 only —
  GitHub retired the last Intel macOS runner image in December 2025, and Intel macOS continues to
  fall back to the sdist.
- **CPython 3.14 wheels** are built.
- **Linux aarch64 wheels** are built on a native arm64 runner.

### Internal

- Test discovery is glob-driven on both sides (`node --test`, pytest), so a new test file cannot be
  forgotten by a hand-maintained list. Added golden quantizer vectors shared by all three
  implementations, fuzz sweeps over truncations and bit flips, and coverage measurement.
- CI runs multi-OS/multi-version matrices, a bundle job that exercises the built output in
  Chromium/Firefox/WebKit, packaging checks for both registries, and a release version guard.
- The WASM codecs are rebuilt from source in CI and checked against the committed binaries, so a
  change to `native/wasm/` cannot sit unbuilt.
- The in-browser demo is published to GitHub Pages.

## 0.2.0 — 2026-06-21

Initial public release: lossless RGB + bit-exact 16-bit auxiliary signals in one WebM, implemented
three times (browser/WebCodecs, C++/libvpx, Python) against one format.
