/** Signal planning, metadata normalization, and frame-slot assembly. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planSignals,
  normalizeMetadata,
  buildFileMetadata,
  buildTracksFromPlan,
  u16FromFramePayload,
  materializeSignal,
  blocksByTime,
  slotKeysForMetadata,
  isSlotComplete,
  collectFrameInputs,
} from '../src/signals.js';

test('planSignals rejects malformed specs', () => {
  assert.throws(() => planSignals([], false), /rgb or at least one/, 'no tracks at all');
  assert.throws(() => planSignals(null, false), /rgb or at least one/, 'no tracks at all (null)');
  assert.throws(() => planSignals([{}], true), /needs an id/, 'spec without id');
  assert.throws(() => planSignals([{ id: 'x', scheme: 'delta-16' }], true), /unsupported scheme/);
  assert.throws(() => planSignals([{ id: 'depth', near: 0.5 }], true), /near and far/);
  assert.throws(() => planSignals([{ id: 'depth', near: 0, far: 5 }], true), /0 < near < far/);
  assert.throws(() => planSignals([{ id: 'depth', near: 5, far: 5 }], true), /0 < near < far/);
  assert.throws(() => planSignals([{ id: 'depth', near: -1, far: 5 }], true), /0 < near < far/);
});

test('planSignals allows an RGB-only plan', () => {
  assert.deepEqual(planSignals([], true), [], 'empty specs with rgb: empty plan');
  assert.deepEqual(planSignals(null, true), [], 'null specs with rgb: empty plan');
});

test('planSignals numbers tracks around the optional RGB track', () => {
  const withRgb = planSignals([{ id: 'depth', near: 0.3, far: 9 }, { id: 'objectId' }], true);
  assert.deepEqual(withRgb[0].tracks, { hi: 2, lo: 3 }, 'rgb: first signal on tracks 2/3');
  assert.deepEqual(withRgb[1].tracks, { hi: 4, lo: 5 }, 'rgb: second signal on tracks 4/5');
  const noRgb = planSignals([{ id: 'a' }, { id: 'b' }], false);
  assert.equal(noRgb[0].tracks.hi, 1, 'no rgb: signals start at track 1');
  assert.equal(noRgb[1].tracks.hi, 3);
  assert.deepEqual(withRgb[0].trackNames, { hi: 'signal-depth-hi', lo: 'signal-depth-lo' });
  assert.equal(withRgb[1].quant, null, 'raw signal has null quant');
  assert.equal(withRgb[0].quant.levels, 65536, 'default levels');
  assert.ok(withRgb.every(s => s.lossless === true && s.dtype === 'uint16'), 'lossless uint16 defaults');
});

test('planSignals accepts the `name` alias and an explicit quant object', () => {
  assert.equal(planSignals([{ name: 'ids' }], false)[0].id, 'ids');
  const q = planSignals([{ id: 'd', quant: { type: 'inverse-depth', near: 1, far: 4, levels: 512 } }], false);
  assert.deepEqual(
    { near: q[0].quant.near, far: q[0].quant.far, levels: q[0].quant.levels },
    { near: 1, far: 4, levels: 512 });
});

test('buildTracksFromPlan mirrors the plan', () => {
  const plan = planSignals([{ id: 'depth', near: 0.3, far: 9 }], true);
  const tracks = buildTracksFromPlan(64, 48, true, plan);
  assert.equal(tracks.length, 3, 'rgb + hi + lo');
  assert.equal(tracks[0].number, 1);
  assert.equal(tracks[0].name, 'rgb');
  assert.ok(tracks.every(t => t.width === 64 && t.height === 48 && t.codecID === 'V_VP9'),
    'per-track geometry/codec');
});

test('buildFileMetadata: batch vs streaming', () => {
  const plan = planSignals([{ id: 'depth', near: 0.3, far: 9 }], true);
  const batch = buildFileMetadata({ W: 64, H: 48, fps: 30, n: 7, hasRgb: true, signals: plan });
  assert.equal(batch.version, 2);
  assert.equal(batch.frames, 7);
  assert.equal(batch.streaming, undefined);
  assert.equal(batch.rgb?.track, 1, 'rgb track recorded');

  const stream = buildFileMetadata({ W: 64, H: 48, fps: 30, n: 0, hasRgb: false, signals: plan, streaming: true });
  assert.equal(stream.frames, null);
  assert.equal(stream.streaming, true);
  assert.equal(stream.rgb, null);

  // metadata must survive JSON (that is how it is stored in the container)
  const rt = normalizeMetadata(JSON.parse(JSON.stringify(batch)));
  assert.equal(rt.signals[0].quant.near, 0.3, 'metadata JSON round-trip');
});

test('normalizeMetadata accepts the quant spelling variants', () => {
  const base = {
    version: 2, width: 8, height: 8,
    signals: [{ id: 'd', tracks: { hi: 1, lo: 2 }, quant: { near: 0.5, far: 5 } }],
  };  // quant object without explicit type
  assert.equal(normalizeMetadata(base).signals[0].quant.type, 'inverse-depth',
    'near in quant implies inverse-depth');

  const legacy = {
    version: 2, width: 8, height: 8,
    signals: [{ id: 'd', tracks: { hi: 1, lo: 2 }, quant: 'inverse-depth', near: 0.5, far: 5, levels: 256 }],
  };  // string form with flat fields
  const nl = normalizeMetadata(legacy).signals[0];
  assert.equal(nl.quant.type, 'inverse-depth');
  assert.equal(nl.quant.near, 0.5);
  assert.equal(nl.quant.levels, 256);

  const raw = { version: 2, width: 8, height: 8, signals: [{ id: 'ids', tracks: { hi: 1, lo: 2 }, quant: null }] };
  assert.equal(normalizeMetadata(raw).signals[0].quant, null, 'null quant preserved');

  assert.throws(() => normalizeMetadata(null), /missing/);
  assert.throws(() => normalizeMetadata({ version: 2 }), /signals/);
});

test('u16FromFramePayload / materializeSignal', () => {
  const rawSig = { id: 'ids', quant: null };
  const depthSig = { id: 'depth', quant: { type: 'inverse-depth', near: 0.5, far: 5, levels: 65536 } };
  assert.equal(u16FromFramePayload(null, rawSig), null, 'null payload -> null');

  const u = new Uint16Array([1, 2, 3]);
  assert.equal(u16FromFramePayload({ u16: u }, rawSig), u, 'u16 passthrough (no copy)');

  const f = new Float32Array([1.0, 2.0, 0]);
  const q = u16FromFramePayload({ float: f }, depthSig);
  assert.ok(q instanceof Uint16Array);
  assert.equal(q[2], 0, 'invalid depth -> code 0');
  assert.ok(q[0] > q[1], 'float quantized via signal quant');
  assert.throws(() => u16FromFramePayload({ float: f }, rawSig), /inverse-depth/, 'float on raw signal');
  assert.throws(() => u16FromFramePayload({}, rawSig), /float/, 'empty payload');

  const m = materializeSignal(q, depthSig);
  assert.equal(m.u16, q);
  assert.ok(m.float instanceof Float32Array, 'materialize adds float for quantized signal');
  assert.ok(Number.isNaN(m.float[2]) && Math.abs(m.float[0] - 1.0) < 1e-3, 'dequantized values sane');
  assert.equal(materializeSignal(u, rawSig).float, undefined, 'raw signal stays u16-only');
});

test('blocksByTime sorts slots and slot completeness needs every track', () => {
  const meta = {
    version: 2, width: 8, height: 8, rgb: { track: 1 },
    signals: [{ id: 'd', tracks: { hi: 2, lo: 3 }, quant: null }],
  };
  const fr = (t) => ({ timeMs: t });
  const tracks = {
    1: { frames: [fr(0), fr(33)] },
    2: { frames: [fr(33), fr(0)] },   // out of order on purpose
    3: { frames: [fr(0), fr(33)] },
  };
  const slots = blocksByTime(tracks, meta);
  assert.deepEqual(slots.map(s => s.timeMs), [0, 33], 'slots sorted by time');

  const keys = slotKeysForMetadata(meta);
  assert.ok(keys.rgb === true && keys.d === true, 'slot keys include rgb + signal');
  assert.ok(isSlotComplete(slots[0], keys) && isSlotComplete(slots[1], keys), 'complete slots');
  assert.ok(!isSlotComplete({ timeMs: 66, rgb: fr(66), 'd:hi': fr(66) }, keys), 'missing lo -> incomplete');
  assert.ok(!isSlotComplete({ timeMs: 66, 'd:hi': fr(66), 'd:lo': fr(66) }, keys), 'missing rgb -> incomplete');

  const noRgbKeys = slotKeysForMetadata({ version: 2, signals: [{ id: 'd', tracks: { hi: 1, lo: 2 } }] });
  assert.ok(isSlotComplete({ 'd:hi': fr(0), 'd:lo': fr(0) }, noRgbKeys), 'no-rgb file: signal pair suffices');
});

test('collectFrameInputs keeps known ids and drops unknown ones', () => {
  const plan = planSignals([{ id: 'a' }, { id: 'b' }], false);
  assert.deepEqual(collectFrameInputs({}, plan), {}, 'no signals key -> empty');
  const got = collectFrameInputs({ signals: { a: { u16: new Uint16Array(1) }, zz: { u16: new Uint16Array(1) } } }, plan);
  assert.ok(got.a !== null, 'known id kept');
  assert.equal(got.b, null, 'missing id -> null');
  assert.ok(!('zz' in got), 'unknown id dropped');
});
