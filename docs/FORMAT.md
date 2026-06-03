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

See [`docs/API.md`](API.md) for encode/decode APIs.
