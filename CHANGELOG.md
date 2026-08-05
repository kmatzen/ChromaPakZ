# Changelog

Notable changes per release. Versions are shared by the Python package (PyPI `chromapakz`) and the
browser library (npm `chromapakz`), which are cut from the same tag — so a version present on one
registry means the same commit on the other.

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
