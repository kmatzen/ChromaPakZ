# ChromaPakZ file format (v2)

One Matroska/WebM file with optional **RGB** (track 1) and **N lossless signal pairs**
(two VP9 lossless luma tracks each, triangle-fold 8+8).

## CHROMAPAKZ metadata tag

JSON in a Matroska `SimpleTag` named `CHROMAPAKZ`:

```json
{
  "version": 2,
  "width": 320,
  "height": 240,
  "fps": 30,
  "frames": 30,
  "rgb": { "track": 1, "codec": "vp09.00.10.08" },
  "signals": [
    {
      "id": "depth",
      "tracks": { "hi": 2, "lo": 3 },
      "codec": "vp09.00.10.08",
      "lossless": true,
      "scheme": "tri-fold-8+8",
      "dtype": "uint16",
      "invalidCode": 0,
      "quant": { "type": "inverse-depth", "near": 0.3, "far": 9.0, "levels": 2048 }
    },
    {
      "id": "objectId",
      "tracks": { "hi": 4, "lo": 5 },
      "quant": null
    }
  ]
}
```

Track names: `rgb`, `signal-{id}-hi`, `signal-{id}-lo`.

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
