/** Incremental WebM mux/demux: streaming output must match the batch muxer, and blocks must
 *  surface as their bytes arrive rather than at finish(). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mux, demux, createStreamMux, createStreamDemux, concatChunks } from '../src/webm.js';
import { buildFileMetadata, planSignals, buildTracksFromPlan } from '../src/signals.js';

const signals = planSignals([{ id: 'depth', near: 0.5, far: 5, levels: 65536 }], true);
const tracks = buildTracksFromPlan(64, 48, true, signals);
const metadata = buildFileMetadata({ W: 64, H: 48, fps: 30, n: 3, hasRgb: true, signals });
const frames = [];
for (let i = 0; i < 3; i++) {
  const t = i * 33;
  frames.push({ track: 1, key: i === 0, timeMs: t, data: new Uint8Array([i, 1, 2]) });
  frames.push({ track: signals[0].tracks.hi, key: i === 0, timeMs: t, data: new Uint8Array([i, 10]) });
  frames.push({ track: signals[0].tracks.lo, key: i === 0, timeMs: t, data: new Uint8Array([i, 20]) });
}

const nearFrom = (m) => m.signals?.find(s => s.id === 'depth')?.quant?.near;

function streamedBytes() {
  const sm = createStreamMux({ tracks, metadata: { ...metadata, frames: null, streaming: true } });
  const inc = [sm.header];
  for (const f of frames) {
    const c = sm.writeFrame(f);
    if (c) inc.push(c);
  }
  inc.push(sm.finish());
  return concatChunks(inc);
}

test('streaming mux round-trips like the batch muxer', () => {
  const dBatch = demux(mux({ tracks, frames, metadata, durationMs: 100 }));
  const dStream = demux(streamedBytes());
  assert.equal(dStream.frames.length, dBatch.frames.length, 'frame count');
  assert.equal(nearFrom(dStream.metadata), nearFrom(dBatch.metadata), 'metadata round-trip');
});

test('incremental demux yields metadata and every block, progressively', () => {
  const streamed = streamedBytes();
  const expected = demux(streamed).frames.length;
  const sdm = createStreamDemux();
  const chunkSize = 97;
  let gotMeta = false, blocks = 0, blocksBeforeFinish = 0;
  for (let o = 0; o < streamed.length; o += chunkSize) {
    for (const e of sdm.push(streamed.subarray(o, Math.min(o + chunkSize, streamed.length)))) {
      if (e.type === 'metadata') gotMeta = true;
      if (e.type === 'block') { blocks++; blocksBeforeFinish++; }
    }
  }
  for (const e of sdm.finish()) if (e.type === 'block') blocks++;
  assert.ok(gotMeta, 'incremental demux got metadata');
  assert.equal(blocks, expected, 'incremental block count');
  // Blocks must surface during push() — decoding may not wait for the end of a network stream.
  assert.ok(blocksBeforeFinish > 0, 'blocks delivered progressively, before finish()');
});

test('metadata is available as soon as the full header is pushed', () => {
  const sm2 = createStreamMux({ tracks, metadata, durationMs: 0 });
  const early = createStreamDemux();
  early.push(sm2.header);
  assert.ok(early.metadata, 'metadata after full header push');
});
