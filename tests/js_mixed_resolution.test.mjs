// Per-stream resolution (format v4) in the browser library: plan/metadata shape, the WASM
// encode→decode roundtrip at mixed geometries, and the reader's handling of foreign metadata.
// The cross-language halves live in tests/test_mixed_resolution.py (native) and
// tests/test_mixres_js_interop.py (Python-written files through both JS decoders).
import test from 'node:test';
import assert from 'node:assert/strict';

import { encode, decode } from '../src/chromapakz.js';
import {
  planSignals,
  planRgbs,
  normalizeRgbSpecs,
  buildFileMetadata,
  buildTracksFromPlan,
  normalizeMetadata,
} from '../src/signals.js';

const W = 64, H = 48, DW = 32, DH = 24, N = 3;

function depthPlane(i){
  const p = new Uint16Array(DW * DH);
  for(let k = 0; k < p.length; k++) p[k] = (k * 7 + i * 991) & 0xffff;
  return p;
}
function idsPlane(i){
  const p = new Uint16Array(W * H);
  for(let k = 0; k < p.length; k++) p[k] = (k * 3 + i) & 0xffff;
  return p;
}
function rgbaPlane(i, w = W, h = H){
  const p = new Uint8Array(w * h * 4);
  p.fill((i * 37) % 256);
  return p;
}

test('planSignals carries per-signal geometry and rejects half of one', () => {
  const plan = planSignals([{ id: 'depth', width: DW, height: DH }, { id: 'ids' }], 1);
  assert.equal(plan[0].width, DW);
  assert.equal(plan[0].height, DH);
  assert.equal(plan[1].width, undefined);
  assert.throws(() => planSignals([{ id: 'depth', width: DW }], 1), /together/);
  assert.throws(() => planSignals([{ id: 'depth', width: -2, height: DH }], 1), /positive/);
});

test('normalizeRgbSpecs accepts per-stream geometry on dict entries', () => {
  const specs = normalizeRgbSpecs(['cam0', { id: 'cam1', width: DW, height: DH }]);
  assert.equal(specs[0].width, null);
  assert.equal(specs[1].width, DW);
  assert.throws(() => normalizeRgbSpecs([{ id: 'cam1', width: DW }]), /together/);
});

test('buildFileMetadata writes v4 with dims only where they differ; uniform stays v3', () => {
  const rgbPlan = planRgbs(normalizeRgbSpecs(['cam0', { id: 'cam1', width: DW, height: DH }]));
  const sigPlan = planSignals([{ id: 'depth', width: DW, height: DH }, { id: 'ids' }], rgbPlan.length);
  const meta = buildFileMetadata({ W, H, fps: 30, n: N, rgbs: rgbPlan, signals: sigPlan });
  assert.equal(meta.version, 4);
  assert.deepEqual([meta.rgbs[1].width, meta.rgbs[1].height], [DW, DH]);
  assert.equal(meta.rgbs[0].width, undefined);
  assert.deepEqual([meta.signals[0].width, meta.signals[0].height], [DW, DH]);
  assert.equal(meta.signals[1].width, undefined);
  // a stream that merely restates the file geometry is the default — no keys, no version bump
  const same = buildFileMetadata({
    W, H, fps: 30, n: N, rgbs: planRgbs(normalizeRgbSpecs(['cam0'])),
    signals: planSignals([{ id: 'ids', width: W, height: H }], 1),
  });
  assert.equal(same.version, 3);
  assert.equal(same.signals[0].width, undefined);
});

test('buildTracksFromPlan sizes each TrackEntry by its own stream', () => {
  const rgbPlan = planRgbs(normalizeRgbSpecs([{ id: 'cam0', width: DW, height: DH }]));
  const sigPlan = planSignals([{ id: 'depth', width: DW, height: DH }, { id: 'ids' }], 1);
  const tracks = buildTracksFromPlan(W, H, rgbPlan, sigPlan);
  assert.deepEqual(tracks.map(t => [t.width, t.height]),
    [[DW, DH], [DW, DH], [DW, DH], [W, H], [W, H]]);
});

test('normalizeMetadata keeps whole per-stream dims and drops half-declared ones', () => {
  const meta = normalizeMetadata({
    version: 4, width: W, height: H,
    rgbs: [{ id: 'cam0', track: 1 }, { id: 'cam1', track: 2, width: DW, height: DH }],
    signals: [
      { id: 'depth', tracks: { hi: 3, lo: 4 }, width: DW, height: DH },
      { id: 'ids', tracks: { hi: 5, lo: 6 }, width: DW },          // half-declared: dropped
      { id: 'neg', tracks: { hi: 7, lo: 8 }, width: -1, height: 4 }, // degenerate: dropped
    ],
  });
  assert.deepEqual([meta.rgbs[1].width, meta.rgbs[1].height], [DW, DH]);
  assert.deepEqual([meta.signals[0].width, meta.signals[0].height], [DW, DH]);
  assert.equal(meta.signals[1].width, undefined);
  assert.equal(meta.signals[2].width, undefined);
});

test('mixed-resolution encode→decode roundtrip is bit-exact at each geometry', async () => {
  const frames = [...Array(N).keys()].map(i => ({
    rgb: rgbaPlane(i),
    signals: { depth: { u16: depthPlane(i) }, ids: { u16: idsPlane(i) } },
  }));
  const bytes = await encode({
    W, H, fps: 30, backend: 'wasm',
    signals: [{ id: 'depth', width: DW, height: DH }, { id: 'ids' }],
    frames,
  });
  const out = await decode(bytes, { backend: 'wasm' });
  assert.equal(out.metadata.version, 4);
  for(let i = 0; i < N; i++){
    assert.deepEqual(out.signalSeries.depth[i].u16, depthPlane(i));
    assert.deepEqual(out.signalSeries.ids[i].u16, idsPlane(i));
    assert.equal(out.rgb[i].length, W * H * 4);
  }
});

test('rgb streams at their own geometry roundtrip through the JS pipeline', async () => {
  const frames = [...Array(N).keys()].map(i => ({
    rgbs: { cam0: rgbaPlane(i), cam1: rgbaPlane(i, DW, DH) },
    signals: { ids: { u16: idsPlane(i) } },
  }));
  const bytes = await encode({
    W, H, fps: 30, backend: 'wasm',
    rgbs: ['cam0', { id: 'cam1', width: DW, height: DH }],
    signals: [{ id: 'ids' }],
    frames,
  });
  const out = await decode(bytes, { backend: 'wasm' });
  assert.equal(out.metadata.version, 4);
  assert.equal(out.rgbs.cam0[0].length, W * H * 4);
  assert.equal(out.rgbs.cam1[0].length, DW * DH * 4);
  for(let i = 0; i < N; i++) assert.deepEqual(out.signalSeries.ids[i].u16, idsPlane(i));
});

test('a wrong-size plane is rejected against its own stream geometry', async () => {
  await assert.rejects(encode({
    W, H, fps: 30, backend: 'wasm',
    signals: [{ id: 'depth', width: DW, height: DH }],
    frames: [{ signals: { depth: { u16: idsPlane(0) } } }],   // W*H samples ≠ DW*DH
  }), new RegExp(`expected ${DW * DH}`));
  await assert.rejects(encode({
    W, H, fps: 30, backend: 'wasm',
    rgbs: [{ id: 'cam0', width: DW, height: DH }], signals: [{ id: 'ids' }],
    frames: [{ rgbs: { cam0: rgbaPlane(0) }, signals: { ids: { u16: idsPlane(0) } } }],
  }), new RegExp(`expected ${DW * DH * 4}`));
});
