/**
 * Concurrency regression test: overlapping addFrame()/readFrame() must not corrupt the stream.
 *
 * `await Promise.all(frames.map(f => enc.addFrame(f)))` is the natural way to hand a batch of
 * frames to an async API, and it used to break badly. addFrame() awaits before lazily building
 * its track encoders, so every concurrent call got past the `if(!sigEnc[id])` guard and built its
 * own encoder pair — each frame came out as frame 0 of a different encoder, i.e. every block a
 * keyframe at t=0, all but the last encoder leaked unclosed. On the WebCodecs backend the
 * single-slot output waiter compounded it into a permanent hang.
 *
 * VP9 encoding is inherently sequential, so the contract is: concurrent calls are serialized in
 * call order and must produce exactly what the sequential path produces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEncoder, createDecoder } from '../src/chromapakz.js';

const W = 48, H = 32, N = 5;
const BACKEND = 'wasm';   // the only backend reachable headless under Node (and Safari's path)

function makeSeq() {
  const frames = [];
  for (let f = 0; f < N; f++) {
    const u16 = new Uint16Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) u16[r * W + c] = 9000 + f * 900 + c * 13 + r * 5;
    frames.push(u16);
  }
  return frames;
}
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const seq = makeSeq();
const frameOf = u16 => ({ signals: { raw: { u16 } } });

// Any hang here is itself the bug, so bound every drive.
function withTimeout(p, label, ms = 30000) {
  let timer;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out — deadlock`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

async function encodeWith(drive, opts = {}) {
  const enc = createEncoder({ W, H, fps: 30, signals: [{ id: 'raw' }], backend: BACKEND, ...opts });
  await withTimeout(drive(enc), 'addFrame');
  const bytes = await withTimeout(enc.finish(), 'finish');
  return { bytes, frameCount: enc.frameCount };
}

const driveSequential = async enc => { for (const u16 of seq) await enc.addFrame(frameOf(u16)); };
const driveConcurrent = enc => Promise.all(seq.map(u16 => enc.addFrame(frameOf(u16))));

async function decodeAll(bytes) {
  const dec = createDecoder(bytes, { backend: BACKEND });
  const out = [];
  for await (const fr of dec) out.push(fr.signals.raw.u16);
  await dec.close();
  return out;
}

test('buffered encode: concurrent addFrame is byte-identical to sequential', async () => {
  const base = await encodeWith(driveSequential);
  const conc = await encodeWith(driveConcurrent);
  assert.equal(conc.frameCount, N, 'concurrent frameCount');
  // Serialization must reproduce the sequential result exactly, not merely something decodable.
  assert.ok(eq(conc.bytes, base.bytes),
    `concurrent encode not byte-identical (${conc.bytes.length} vs ${base.bytes.length} bytes)`);

  const decoded = await decodeAll(conc.bytes);
  assert.equal(decoded.length, N, 'decoded frame count');
  // Order matters as much as content: frame i must be seq[i], not some surviving permutation.
  for (let i = 0; i < N; i++) assert.ok(eq(decoded[i], seq[i]), `frame ${i} bit-exact and in order`);
});

test('streaming encode: concurrent addFrame is byte-identical to sequential', async () => {
  // Compare streaming-against-streaming: the live mux writes an unknown-size Segment and a
  // streaming metadata header, so its bytes legitimately differ from the buffered mux().
  const chunksSeq = [], chunksConc = [];
  const sSeq = await encodeWith(driveSequential, { onChunk: c => chunksSeq.push(c) });
  const sConc = await encodeWith(driveConcurrent, { onChunk: c => chunksConc.push(c) });
  assert.ok(eq(sConc.bytes, sSeq.bytes),
    `streaming concurrent not byte-identical (${sConc.bytes.length} vs ${sSeq.bytes.length} bytes)`);
  assert.equal(chunksConc.length, chunksSeq.length, 'streaming chunk count');
  const decoded = await decodeAll(sConc.bytes);
  assert.ok(decoded.every((u, i) => eq(u, seq[i])), 'streaming concurrent bytes decode bit-exact');
});

test('concurrent readFrame() yields frames in call order', async () => {
  const { bytes } = await encodeWith(driveSequential);
  const dec = createDecoder(bytes, { backend: BACKEND });
  const frames = await withTimeout(Promise.all(Array.from({ length: N }, () => dec.readFrame())), 'readFrame');
  await dec.close();
  assert.ok(frames.every(f => f && f.signals.raw), `concurrent readFrame returned ${N} frames`);
  assert.ok(frames.every((f, i) => eq(f.signals.raw.u16, seq[i])), 'frames in call order, bit-exact');
});
