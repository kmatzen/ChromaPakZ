# ChromaPakZ file format (v2)

One Matroska/WebM file with an optional **RGB** track (track 1) and **N lossless signal pairs**
(two VP9 lossless luma tracks each, triangle-fold 8+8). All three implementations (browser, C++, Python)
read and write the same bytes.

## CHROMAPAKZ metadata tag

JSON string in a Matroska `SimpleTag` named `CHROMAPAKZ`.

### v2 (current)

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
      "codec": "vp09.00.10.08",
      "lossless": true,
      "scheme": "tri-fold-8+8",
      "dtype": "uint16",
      "invalidCode": 0,
      "quant": null
    }
  ],
  "depth": {
    "trackHi": 2,
    "trackLo": 3,
    "codec": "vp09.00.10.08",
    "lossless": true,
    "scheme": "tri-fold-8+8",
    "quant": "inverse-depth",
    "near": 0.3,
    "far": 9.0,
    "levels": 2048,
    "invalidCode": 0,
    "dtype": "uint16"
  }
}
```

| Field | Meaning |
|---|---|
| `signals[]` | Authoritative list of lossless planes |
| `signals[].id` | Stable name (`depth`, `objectId`, `normalX`, …) |
| `signals[].tracks.hi/lo` | Matroska track numbers for the 8+8 pair |
| `signals[].quant` | `null` = raw uint16; `{ type: "inverse-depth", near, far, levels }` for float depth |
| `depth` | Legacy mirror when a depth signal uses inverse-depth quant (v1 tools) |
| `streaming` | Optional; `frames` may be `null` for live mux |

Track names: `rgb`, `signal-{id}-hi`, `signal-{id}-lo`.

### v1 (read-only)

Legacy files use `"version": 1` with a top-level `depth` object (`trackHi`/`trackLo`, string `"quant": "inverse-depth"`).
Decoders promote this to `signals: [{ id: "depth", … }]`.

## Triangle-fold 8+8

Each uint16 sample `d` splits into hi/lo bytes for two VP9 lossless tracks:

- `hi = d >> 8`
- `lo = (hi & 1) ? (255 - (d & 255)) : (d & 255)`

Unpack inverts this map bit-exactly. VP9 luma must signal **full range** (`color_range=pc`) so external decoders (ffmpeg) do not rescale planes.

## Implementation map

| Layer | Module |
|---|---|
| Signal model + metadata | `src/signals.js`, `native/chromapakz.cpp` (`parseMetadata`, `buildMetadataJson`) |
| Mux/demux | `src/webm.js`, `native/chromapakz.cpp` |
| Browser API | `src/chromapakz.js` |
| Python API | `python/chromapakz/__init__.py` → `dc_encode_multi`, `dc_decode_signal` |

See [`docs/API.md`](API.md) for encode/decode call patterns.
