# ChromaPakZ file format (v4)

One Matroska/WebM file with **M lossy RGB streams** (M ≥ 0; tracks 1..M, stereo / multi-camera
rigs store one per camera) and **N lossless signal pairs** (two VP9 lossless luma tracks each,
triangle-fold 8+8).

## CHROMAPAKZ metadata tag

JSON in a Matroska `SimpleTag` named `CHROMAPAKZ`:

```json
{
  "version": 4,
  "width": 320,
  "height": 240,
  "fps": 30,
  "frames": 30,
  "rgb": { "track": 1, "codec": "vp09.00.10.08" },
  "rgbs": [
    { "id": "cam0", "track": 1, "codec": "vp09.00.10.08" },
    { "id": "cam1", "track": 2, "codec": "vp09.00.10.08" }
  ],
  "signals": [
    {
      "id": "depth",
      "tracks": { "hi": 3, "lo": 4 },
      "width": 160,
      "height": 120,
      "codec": "vp09.00.10.08",
      "lossless": true,
      "scheme": "tri-fold-8+8",
      "dtype": "uint16",
      "invalidCode": 0,
      "quant": { "type": "inverse-depth", "near": 0.3, "far": 9.0, "levels": 2048 },
      "view": "cam0"
    },
    {
      "id": "objectId",
      "tracks": { "hi": 5, "lo": 6 },
      "quant": null
    }
  ]
}
```

Track names: `rgb` (primary RGB), `rgb-{id}` (each further RGB stream), `signal-{id}-hi`,
`signal-{id}-lo`.

**RGB streams (v3).** `rgbs[]` lists every RGB stream, in track order; signal tracks number
after all of them. The **primary** stream is `rgbs[0]`: it always sits on **track 1** with the
container name **`rgb`**, and the legacy `rgb` key always duplicates it — that pair is what
pre-v3 readers key on, so they decode the primary exactly as a v2 file and simply ignore the
extra streams. A v2 file (no `rgbs`) reads in v3 readers as a single stream with the default id
`"rgb"`. All streams share the file's frame grid: an encoder writes every declared stream on
every frame (the JS encoder additionally allows a stream to *start* late, as signals always
could, but never to gap). Rigs that are not frame-synchronized are out of scope — represent
them as separate files.

**Per-stream resolution (v4).** Any `rgbs[]` or `signals[]` entry may carry its own
`width`/`height` — always both, always positive — for a stream at a different resolution than
the file: a 256×192 LiDAR depth map beside 1920×1440 video, a low-res guide camera in a rig.
An entry without them rides at the file's top-level `width`×`height`, exactly as every stream
did before v4; the top-level pair remains the **primary display resolution** (the primary RGB
stream's — the first signal's in a file with no RGB), which is what `probe` reports and plain
players show. The keys are written only where the resolution actually differs, and
`"version": 4` only when at least one entry carries them — a file whose streams all share the
file resolution is byte-identical v3 output, so nothing written before v4 changes. Each video
`TrackEntry`'s `PixelWidth`/`PixelHeight` states its own track's geometry (pre-v4 these merely
repeated the file's). Frames still align one-to-one across streams; nothing in ChromaPakZ
resamples or aligns pixels between geometries — that mapping (intrinsics, crop, scale) belongs
to wrapper formats, as `view` does. Pre-v4 readers handed a v4 file fail loudly on the streams
that differ (their decoded frames don't match the geometry such readers assume) and read
everything else as before.

**HDR display tracks (0.8.0, optional).** An RGB stream may be an HDR10/HLG display track:
VP9 **profile 2**, 10-bit, BT.2020 non-constant-luminance, broadcast range. Its `rgbs[]` entry
then carries the full codec string (`vp09.02.10.10.01.09.16.09` for PQ, `…18.09` for HLG) and an
`"hdr"` object:

```json
"hdr": { "bits": 10, "transfer": "pq", "maxCLL": 1000, "maxFALL": 400,
         "mastering": { "rx": 0.708, "ry": 0.292, "gx": 0.170, "gy": 0.797,
                        "bx": 0.131, "by": 0.046, "wx": 0.3127, "wy": 0.3290,
                        "maxLum": 1000, "minLum": 0.005 } }
```

The same information is written where players actually read it: a WebM **`Colour`** element on
each RGB TrackEntry (`MatrixCoefficients` 9, `BitsPerChannel` 10, `Range` 1,
`TransferCharacteristics` 16/18, `Primaries` 9, optional `MaxCLL`/`MaxFALL` and the ST 2086
`MasteringMetadata`) — HDR10 static metadata lives in the container, not the VP9 bitstream.
Both muxers emit byte-identical Colour elements for the same description; SDR files carry no
Colour element and are byte-unchanged. HDR applies to all of a file's RGB streams at once, and
samples are 10-bit display codes (0..1023) — scene-referred data belongs in the lossless signal
tracks, not here. Signal tracks are unaffected either way.

**`view` (optional, informational).** A signal may name the RGB stream whose camera frame it
lives in (e.g. disparity computed in `cam0`'s rectified frame). It is recorded verbatim and
interpreted by nothing in ChromaPakZ; association semantics belong to wrapper formats.

Depth is a **signal id**, not a separate metadata schema. Use `quant: { type: "inverse-depth", … }` for float depth; `quant: null` for raw uint16.

## Streaming profile

A file written incrementally — by the browser encoder's `onChunk`, by Python's `create_encoder()`,
or by anything wrapping them — differs from a batch-written one in three ways, all of them
consequences of the header having to be final before the take exists:

- the **Segment size is unknown** (the reserved all-ones EBML vint) rather than a byte count, so
  clusters appended later are still inside it and the file is valid from the first chunk;
- **`"frames": null`** and **`"streaming": true`** in the metadata — the count is not known when
  the tag is written. Readers recover it by counting blocks on the busiest track;
- **`Duration`** is omitted from `Info`, for the same reason. Seeking relies on `Cues`, which is
  written at the end and may legitimately be absent if the recording was cut short — or suppressed
  deliberately, when a wrapper inserts its own elements between clusters and moves the offsets the
  cue points hold.

Everything else — track layout, names, block timestamps, the packing scheme — is identical, and
both writers produce files the other's reader decodes bit-exactly.

See [`docs/API.md`](API.md) for encode/decode APIs.
