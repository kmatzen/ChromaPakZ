# ChromaPakZ API reference

Browser, Python, and C++ share the v2 metadata schema — see [`docs/FORMAT.md`](FORMAT.md).

---

## Browser (`src/chromapakz.js`)

Pure-JS encode/decode via WebCodecs VP9. One **RGB** track (legacy playback) plus any number of **lossless 16-bit signals** — each signal uses two VP9 lossless luma tracks (triangle-fold 8+8).

### Model

| Concept | Meaning |
|---|---|
| **RGB** | Optional 8-bit viewable video (track 1) |
| **Signal** | One synchronized `W×H` plane per frame, bit-exact as `uint16` |
| **Scheme** | `tri-fold-8+8` — reversible split into two 8-bit planes for VP9 |
| **Quant** | Optional encode step before packing. `inverse-depth` for float depth; omit for raw uint16 |

Metadata **v2** stores `signals: [...]`. Legacy v1 `depth` objects still decode. New encodes write a `depth` mirror when a depth signal is present.

### Example

```javascript
import { createEncoder, SIGNAL_DEPTH, SIGNAL_RAW_U16 } from './src/chromapakz.js';

const enc = createEncoder({
  W, H, fps: 30,
  signals: [
    { id: 'depth', near: 0.4, far: 12, levels: 65536 },
    { id: 'objectId' },
  ],
});
await enc.addFrame({
  rgb: rgbaUint8,
  signals: { depth: { float: zFloat32 }, objectId: { u16: idU16 } },
});
const bytes = await enc.finish();
```

### Quantization helpers (`chromapakz-core.js`)

`LEVELS_FULL`, `quantizeInverseDepth`, `dequantizeInverseDepth`, `autoNearFar`, `triFoldPack`, `triFoldUnpack`.

### Streaming encode / decode

```javascript
const enc = createEncoder({ W, H, signals, onChunk: (u8) => socket.send(u8) });
await enc.addFrame({ rgb, signals: { depth: { float }, objectId: { u16 } } });

const dec = createDecoder();
dec.push(chunk); dec.finish();
const frame = await dec.readFrame();
// frame.signals.depth.u16, frame.signals.objectId.u16
// frame.depthU16 / frame.depthFloat — legacy aliases
```

Legacy sugar: top-level `near`/`far`, `depthFloat`/`depthU16` → single depth signal.

Batch `encode()` / `decode()` remain thin wrappers; `decode()` returns `signalSeries`.

---

## Python (`python/chromapakz`)

```python
import chromapakz as cz

data = cz.encode(
    {"depth": depth_u16, "objectId": ids_u16},
    specs={"depth": {"inverse_depth": True, "near": 0.3, "far": 9.0, "levels": 2048}},
    rgb=rgba,
)
info = cz.probe(data)       # width, height, frames, signals[], metadata
out = cz.decode(data)       # out["signals"]["depth"], out["signals"]["objectId"], out["rgb"]
meta = cz.parse_metadata(data)

# Sugar
cz.encode_rgbd(rgb, depth, near=0.2, far=10.0)
cz.encode_depth(depth)
cz.decode_depth(data)
cz.decode_signal(data, "objectId")
cz.quantize_inverse(z_float32, near, far, levels)
```

| Function | Purpose |
|---|---|
| `encode(signals, specs=, rgb=, …)` | General multi-signal encode |
| `decode(data, signal_ids=)` | Decode selected or all signals + RGB |
| `parse_metadata(data)` | Full v2 JSON dict |
| `probe(data)` | Header summary + `signals` list |

---

## C++ / CLI

C ABI in `native/chromapakz.h`:

| Function | Purpose |
|---|---|
| `dc_encode_multi` | RGB + N signals |
| `dc_decode_signal` | Decode one id |
| `dc_get_metadata` | CHROMAPAKZ JSON string |
| `dc_encode_depth` / `dc_encode_rgbd` | Depth sugar |
| `dc_decode_depth` | Same as `dc_decode_signal(..., "depth", ...)` |

```sh
./build/dccli selftest
./build/dccli encode depth.u16 W H N fps near far out.webm
./build/dccli encodergbd rgb.rgba depth.u16 W H N fps near far kbps out.webm
./build/dccli decode clip.webm depth.u16
./build/dccli decodesignal clip.webm objectId ids.u16
./build/dccli info clip.webm
```

---

## Tests

```sh
# Node (no WebCodecs)
node tests/js_quant.mjs
node tests/js_signals.mjs
node tests/webm_stream.mjs

# Python / native
cmake -S . -B build && cmake --build build -j && ./build/dccli selftest
python tests/roundtrip.py
python tests/cross_interop.py
python tests/ffmpeg_interop.py

# Browser (Chromium)
cd experiments/webcodecs-lossless
node run.mjs multisignal 128 6
node run.mjs streaming 256 12
node smoke-demo.mjs
```

---

## Engine support

Lossless VP9 **encode** is Chromium-only today. **Decode** works on Chromium and WebKit/Safari.
See [`docs/EVALUATION.md`](EVALUATION.md) §11.
