/** v2 metadata with multiple lossless signals, through the container. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mux, demux } from '../src/webm.js';
import { normalizeMetadata, buildFileMetadata, planSignals, buildTracksFromPlan } from '../src/signals.js';

test('two signals survive mux -> demux -> normalizeMetadata', () => {
  const W = 32, H = 24, N = 2;
  const signals = planSignals([
    { id: 'depth', near: 0.3, far: 8, levels: 1024 },
    { id: 'objectId' },
  ], false);
  const tracks = buildTracksFromPlan(W, H, false, signals);
  const frames = [];
  for (let i = 0; i < N; i++) {
    const t = i * 40;
    // fake VP9 payloads (container-only test)
    frames.push({ track: signals[0].tracks.hi, key: i === 0, timeMs: t, data: new Uint8Array([1, 2, 3, i]) });
    frames.push({ track: signals[0].tracks.lo, key: i === 0, timeMs: t, data: new Uint8Array([4, 5, 6, i]) });
    frames.push({ track: signals[1].tracks.hi, key: i === 0, timeMs: t, data: new Uint8Array([7, 8, i]) });
    frames.push({ track: signals[1].tracks.lo, key: i === 0, timeMs: t, data: new Uint8Array([9, 10, i]) });
  }
  const metadata = buildFileMetadata({ W, H, fps: 30, n: N, hasRgb: false, signals });
  const d = demux(mux({ tracks, frames, metadata, durationMs: 100 }));
  const meta = normalizeMetadata(d.metadata);
  assert.equal(meta.version, 2);
  assert.deepEqual(meta.signals.map(s => s.id), ['depth', 'objectId']);
  assert.equal(d.frames.length, N * 4, 'frame packets');
});
