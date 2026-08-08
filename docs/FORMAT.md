# ChromaPakZ file format (v3)

One Matroska/WebM file with **M lossy RGB streams** (M ≥ 0; tracks 1..M, stereo / multi-camera
rigs store one per camera) and **N lossless signal pairs** (two VP9 lossless luma tracks each,
triangle-fold 8+8).

## CHROMAPAKZ metadata tag

JSON in a Matroska `SimpleTag` named `CHROMAPAKZ`:

```json
{
  "version": 3,
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
`"rgb"`. All streams share the file's one `width`×`height` and its frame grid: an encoder
writes every declared stream on every frame (the JS encoder additionally allows a stream to
*start* late, as signals always could, but never to gap). Rigs that are not frame-synchronized
are out of scope — represent them as separate files.

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
