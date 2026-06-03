# ChromaPakZ API reference

Format schema: [`docs/FORMAT.md`](FORMAT.md).

---

## Browser (`src/chromapakz.js`)

```javascript
const enc = createEncoder({
  W, H, fps: 30,
  signals: [{ id: 'depth', near: 0.4, far: 12 }, { id: 'objectId' }],
});
await enc.addFrame({
  rgb: rgbaUint8,
  signals: { depth: { float: z }, objectId: { u16: ids } },
});
const bytes = await enc.finish();

const dec = createDecoder(bytes);
for await (const frame of dec) {
  frame.signals.depth.u16;
  frame.signals.objectId.u16;
}
```

Batch helpers require explicit `signals` and `frames`:

```javascript
await encode({
  W, H, fps: 30,
  signals: [{ id: 'depth', near, far }],
  frames: depthFloat.map((z, i) => ({ rgb: rgb[i], signals: { depth: { float: z } } })),
});
const { signalSeries } = await decode(bytes);
```

Network: `onChunk` on encode; `createDecoder()` + `push()` + `finish()` on decode.

Quant helpers: `quantizeInverseDepth`, `dequantizeInverseDepth`, `autoNearFar`, `triFoldPack`, `triFoldUnpack`.

---

## Python (`python/chromapakz`)

```python
import chromapakz as cz

data = cz.encode(
    {"depth": depth_u16, "objectId": ids_u16},
    specs={"depth": cz.inverse_depth_spec(0.3, 9.0, 2048)},
    rgb=rgba,
)
out = cz.decode(data)
depth = cz.decode_signal(data, "depth")
```

| Function | Purpose |
|---|---|
| `encode(signals, specs=, rgb=, …)` | Multi-signal encode |
| `decode(data, signal_ids=)` | Decode signals + optional RGB |
| `decode_signal(data, id)` | One `(N,H,W)` uint16 plane |
| `inverse_depth_spec(near, far, levels)` | Spec dict for depth signal |
| `parse_metadata(data)` | Full v2 JSON |

---

## C++ / CLI

| Function | Purpose |
|---|---|
| `dc_encode_multi` | RGB + N signals |
| `dc_decode_signal` | Decode by id |
| `dc_get_metadata` | CHROMAPAKZ JSON |
| `dc_probe` / `dc_decode_rgb` | Header + RGB |

```sh
./build/dccli selftest
./build/dccli encode depth.u16 W H N fps near far out.webm
./build/dccli decodesignal clip.webm depth out.u16
```

---

## Tests

```sh
node tests/js_quant.mjs && node tests/js_signals.mjs && node tests/js_metadata_v2.mjs && node tests/webm_stream.mjs
cmake --build build && ./build/dccli selftest
python tests/roundtrip.py && python tests/cross_interop.py && python tests/ffmpeg_interop.py
cd experiments/webcodecs-lossless && node run.mjs multisignal && node smoke-demo.mjs
```
