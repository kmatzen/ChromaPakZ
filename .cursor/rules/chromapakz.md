# ChromaPakZ

Lossless RGB + arbitrary **uint16 signals** (depth, object IDs, packed attributes) in one WebM.
Three implementations must stay byte- and metadata-compatible: `src/`, `native/`, `python/chromapakz/`.

Format reference: [`docs/FORMAT.md`](../docs/FORMAT.md). API reference: [`docs/API.md`](../docs/API.md).

## Signals (not just depth)

- Metadata **v2** uses `signals: [{ id, tracks, scheme, quant?, … }]`.
- Each lossless signal = two VP9 tracks (triangle-fold 8+8). RGB stays track 1 when present.
- Track names: `signal-{id}-hi`, `signal-{id}-lo`.
- `inverse-depth` quant is only for float depth; raw uint16 signals use `quant: null`.
- New encodes write legacy `metadata.depth` when `id === 'depth'` with inverse-depth quant.
- v1 files (top-level `depth` only) must still decode via promotion to `signals[0]`.

### Browser (`src/chromapakz.js`, `src/signals.js`)

```javascript
const enc = createEncoder({ W, H, signals: [{ id: 'depth', near, far }, { id: 'objectId' }] });
await enc.addFrame({ rgb, signals: { depth: { float }, objectId: { u16 } } });
const dec = createDecoder(bytes);
for await (const frame of dec) {
  frame.signals.depth.u16;
  frame.signals.objectId.u16;
}
```

Legacy sugar: top-level `near`/`far`, `depthFloat`/`depthU16` → single depth signal.

Network streaming: `onChunk` on encode; `createDecoder()` + `push()` + `finish()` on decode.

### Python / C++

```python
data = cz.encode({"depth": u16, "objectId": u16},
                  specs={"depth": {"inverse_depth": True, "near": 0.3, "far": 9.0}},
                  rgb=rgba)
out = cz.decode(data)["signals"]
```

C ABI: `dc_encode_multi`, `dc_decode_signal`, `dc_get_metadata` in `native/chromapakz.h`.
Sugar: `encode_depth`, `encode_rgbd`, `decode_depth`.

## near / far

- Apply to **inverse-depth depth signals** only.
- No hardcoded defaults in JS. Use `autoNearFar()` or explicit signal spec.
- Decoders read quant from metadata — never pass `near`/`far` to `createDecoder()`.

## Tests (run before merge)

| Command | What |
|---|---|
| `node tests/js_quant.mjs` | Quant helpers (Node) |
| `node tests/js_signals.mjs` | v2 metadata mux/demux |
| `node tests/webm_stream.mjs` | Incremental mux/demux |
| `python tests/roundtrip.py` | Python RGBD + multi-signal |
| `python tests/cross_interop.py` | v2 metadata + legacy depth mirror |
| `python tests/ffmpeg_interop.py` | ffmpeg full-range depth |
| `./build/dccli selftest` | C++ bit-exact |
| `cd experiments/webcodecs-lossless && node run.mjs multisignal` | Browser depth + objectId |
| `cd experiments/webcodecs-lossless && node smoke-demo.mjs` | Demo page smoke |

CI runs these in `.github/workflows/ci.yml`.

## Conventions

- Keep `src/signals.js` and native `buildMetadataJson` / `parseMetadata` in sync.
- Do not break v1 read path when extending metadata.
- VP9 lossless luma: full range (`VP9E_SET_COLOR_RANGE` / WebCodecs `fullRange: true`).
- Prefer `createEncoder` / `createDecoder` over batch helpers for new browser code.
