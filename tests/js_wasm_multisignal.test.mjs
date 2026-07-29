// Multi-signal WASM round-trip in Node: a float depth signal (inverse-depth quant, reduced
// levels) plus a raw uint16 signal in one file — u16 codes must be bit-exact, dequantized
// depth within the quantization step — exercised through BOTH decode entry points:
// buffered createDecoder(bytes) and the network decoder (push()/finish()) fed by onChunk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEncoder, createDecoder } from '../src/chromapakz.js';

const W = 48, H = 32, N = 4, LEVELS = 4096, NEAR = 0.4, FAR = 6;

function makeDepth(f) {
  const z = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    z[r * W + c] = 0.5 + 4.5 * (r / H) + 0.4 * Math.sin((c + f * 3) / 6);
    if ((r + c + f) % 97 === 0) z[r * W + c] = 0;          // dropout holes -> code 0 -> NaN
  }
  return z;
}
function makeIds(f) {
  const u = new Uint16Array(W * H);
  for (let i = 0; i < u.length; i++) u[i] = ((i * 31 + f * 7919) & 0xffff);
  return u;
}

async function encodeClip(onChunk) {
  const enc = createEncoder({
    W, H, fps: 30,
    signals: [{ id: 'depth', near: NEAR, far: FAR, levels: LEVELS }, { id: 'objectId' }],
    backend: 'wasm', onChunk,
  });
  for (let f = 0; f < N; f++)
    await enc.addFrame({ signals: { depth: { float: makeDepth(f) }, objectId: { u16: makeIds(f) } } });
  return enc.finish();
}

async function collect(dec) {
  const frames = [];
  for await (const fr of dec) frames.push(fr);
  await dec.close();
  return frames;
}

function checkFrames(frames, label) {
  assert.equal(frames.length, N, `${label}: frame count`);
  const M = LEVELS - 2, step = (1 / NEAR - 1 / FAR) / M;
  for (let f = 0; f < N; f++) {
    const got = frames[f].signals;
    assert.ok(got.objectId.u16.every((v, i) => v === makeIds(f)[i]), `${label}: objectId frame ${f} bit-exact`);
    const zin = makeDepth(f), zout = got.depth.float, codes = got.depth.u16;
    assert.ok(zout instanceof Float32Array, `${label}: depth float missing`);
    for (let i = 0; i < zin.length; i++) {
      if (!(zin[i] > 0)) {
        assert.ok(codes[i] === 0 && Number.isNaN(zout[i]),
          `${label}: invalid pixel ${i} frame ${f}: code=${codes[i]} z=${zout[i]}`);
        continue;
      }
      assert.ok(codes[i] >= 1 && codes[i] <= LEVELS - 1, `${label}: code out of range: ${codes[i]}`);
      const err = Math.abs(1 / zout[i] - 1 / Math.min(Math.max(zin[i], NEAR), FAR));
      assert.ok(err <= step * 0.51, `${label}: depth err ${err} > half step ${step / 2} (frame ${f}, px ${i})`);
    }
  }
}

test('wasm backend: buffered decode of a multi-signal clip', async () => {
  const bytes = await encodeClip(null);
  const dec = createDecoder(bytes, { backend: 'wasm' });
  assert.equal(dec.metadata.signals.length, 2, 'metadata signals');
  assert.deepEqual({ near: dec.near, far: dec.far, levels: dec.levels },
    { near: NEAR, far: FAR, levels: LEVELS }, 'metadata quant');
  assert.equal(dec.frameCount, N);
  checkFrames(await collect(dec), 'buffered');
});

test('wasm backend: network decoder consumes encoder chunks as they arrive', async () => {
  const chunks = [];
  const streamed = await encodeClip(c => chunks.push(c));
  assert.ok(chunks.length >= 2, 'onChunk: expected multiple chunks');

  const net = createDecoder(undefined, { backend: 'wasm' });
  await assert.rejects(() => net.readFrame(), 'readFrame before metadata should throw');
  net.push(chunks[0]);
  assert.ok(net.ready, 'metadata should parse from header chunk');
  assert.equal(net.levels, LEVELS, 'quant metadata from header chunk');

  // start reading before the remaining bytes arrive — exercises the wait/notify path
  const reading = (async () => {
    const frames = [];
    for (;;) { const fr = await net.readFrame(); if (!fr) break; frames.push(fr); }
    return frames;
  })();
  for (const c of chunks.slice(1)) net.push(c);
  net.finish();
  checkFrames(await reading, 'network');
  await net.close();

  // streamed bytes and buffered readback agree on content
  checkFrames(await collect(createDecoder(streamed, { backend: 'wasm' })), 'streamed-bytes');
});
