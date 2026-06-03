# ChromaPakZ

Lossless RGB + arbitrary **uint16 signals** in one WebM. Three implementations share v2 `signals[]` metadata only.

Format: [`docs/FORMAT.md`](../docs/FORMAT.md). API: [`docs/API.md`](../docs/API.md).

## Signals

- Metadata **v2** requires `signals: [{ id, tracks, scheme, quant?, … }]`.
- Each lossless signal = two VP9 tracks (`signal-{id}-hi/lo`). RGB = track 1 when present.
- `inverse-depth` quant for float depth; `quant: null` for raw uint16 (object IDs, etc.).
- **No** top-level `depth` field, v1 metadata, or depth-only sugar APIs.

### Browser

```javascript
createEncoder({ W, H, signals: [{ id: 'depth', near, far }, { id: 'objectId' }] });
addFrame({ rgb, signals: { depth: { float }, objectId: { u16 } } });
```

### Python / C++

```python
cz.encode({"depth": u16, "objectId": u16}, specs={"depth": cz.inverse_depth_spec(near, far)}, rgb=rgba)
cz.decode_signal(data, "depth")
```

## Tests

| Command | What |
|---|---|
| `node tests/js_metadata_v2.mjs` | Rejects v1 / empty metadata |
| `python tests/cross_interop.py` | v2-only metadata contract |
| `./build/dccli selftest` | C++ bit-exact |
| `node run.mjs multisignal` | Browser depth + objectId |

## Conventions

- Keep `src/signals.js` and native metadata builders in sync.
- VP9 lossless luma: full range always.
- `createEncoder` requires `signals[]`; depth is just a signal id.
