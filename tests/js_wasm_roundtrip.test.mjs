// Bit-exact round-trip through the WASM (libvpx) codec backend, headless under Node where
// WebCodecs is absent. Encodes a synthetic uint16 signal sequence and decodes it back; the
// recovered values must equal the originals exactly (lossless VP9 QP=0 + triangle-fold).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEncoder, createDecoder } from '../src/chromapakz.js';

const W = 64, H = 48, N = 5;

// Temporally-coherent uint16 field with values spanning byte boundaries (stresses lossless).
function makeSeq() {
  const frames = [];
  for (let f = 0; f < N; f++) {
    const u16 = new Uint16Array(W * H);
    let s = (0x9e3779b9 ^ (f * 2654435761)) >>> 0;
    const noise = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s & 7) - 3; };
    const cx = W * (0.25 + 0.5 * f / Math.max(1, N - 1)), cy = H * 0.45, R = Math.min(W, H) * 0.22;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      let z = 9000 + c * 70 + r * 45;
      if ((c - cx) ** 2 + (r - cy) ** 2 < R * R) z -= 6000;
      z += noise();
      u16[r * W + c] = Math.max(0, Math.min(65535, z));
    }
    frames.push(u16);
  }
  return frames;
}

test('wasm backend: uint16 signal survives encode -> decode bit-exactly', async () => {
  const seq = makeSeq();
  const enc = createEncoder({ W, H, fps: 30, signals: [{ id: 'raw' }], backend: 'wasm' });
  for (const u16 of seq) await enc.addFrame({ signals: { raw: { u16 } } });
  const bytes = await enc.finish();

  const dec = createDecoder(bytes, { backend: 'wasm' });
  const out = [];
  for await (const frame of dec) out.push(frame.signals.raw.u16);
  await dec.close();

  assert.equal(out.length, N, 'frame count');
  for (let i = 0; i < N; i++) {
    if (out[i].every((v, k) => v === seq[i][k])) continue;
    let maxd = 0;
    for (let k = 0; k < seq[i].length; k++) maxd = Math.max(maxd, Math.abs(seq[i][k] - out[i][k]));
    assert.fail(`frame ${i} not bit-exact (max delta ${maxd})`);
  }
  console.log(`wasm round-trip: ${N} frames, ${W}x${H}, ${bytes.length} bytes — bit-exact`);
});
