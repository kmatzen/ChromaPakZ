/**
 * Signal ids are opaque strings, and the format never restricted them. The JS side serialises
 * metadata with JSON.stringify, so it has always handled `"`, `\` and `]` correctly — these
 * tests pin that, so the contract the native core was fixed to meet (tests/test_metadata_json.py)
 * cannot drift on this side either. A file written here must stay readable there and vice versa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mux, demux } from '../src/webm.js';
import { buildFileMetadata, normalizeMetadata, planSignals } from '../src/signals.js';

const IDS = [
  'a]b',                 // used to end the native signals array early
  'ev"il',               // used to break out of the JSON string
  'back\\slash',
  'brace}s{',
  'comma,colon:',
  'new\nline\ttab',
  'unicode-日本語-😀',
  'x'.repeat(600),       // longer than the native parser's old 480-character scan window
];

/** Round-trip a metadata document through the real muxer and demuxer. */
function throughFile(specs) {
  const signals = planSignals(specs, false);
  const metadata = buildFileMetadata({ W: 64, H: 48, fps: 30, n: 0, hasRgb: false, signals });
  const tracks = signals.flatMap(s => [
    { number: s.tracks.hi, codecID: 'V_VP9', name: s.trackNames.hi, width: 64, height: 48 },
    { number: s.tracks.lo, codecID: 'V_VP9', name: s.trackNames.lo, width: 64, height: 48 },
  ]);
  return normalizeMetadata(demux(mux({ tracks, frames: [], metadata, durationMs: 0 })).metadata);
}

test('every adversarial id survives a mux/demux round-trip', () => {
  for (const id of IDS) {
    const meta = throughFile([{ id }]);
    assert.deepEqual(meta.signals.map(s => s.id), [id], `id ${JSON.stringify(id)} was mangled`);
  }
});

test('adversarial ids do not disturb their neighbours', () => {
  const meta = throughFile(IDS.map(id => ({ id })));
  assert.deepEqual(meta.signals.map(s => s.id), IDS);
  // Track numbers are assigned in pairs from 1; a mis-parsed id would shift or merge them.
  assert.deepEqual(meta.signals.map(s => [s.tracks.hi, s.tracks.lo]),
                   IDS.map((_, i) => [1 + 2 * i, 2 + 2 * i]));
});

test('an unquantized signal does not inherit the next signal quant', () => {
  // The native counterpart of this: a fixed-width scan window used to read the following
  // signal's inverse-depth range into this one.
  const meta = throughFile([{ id: 'depth' }, { id: 'disparity', near: 0.25, far: 7.5 }]);
  const byId = Object.fromEntries(meta.signals.map(s => [s.id, s]));
  assert.equal(byId.depth.quant, null);
  assert.equal(byId.disparity.quant.near, 0.25);
  assert.equal(byId.disparity.quant.far, 7.5);
});

test('an id whose text looks like metadata is carried as a string, not structure', () => {
  // Pasted in unescaped, this id would close the string and add members of its own.
  const hostile = '","width":9999,"quant":{"type":"inverse-depth","near":5,"far":6},"y';
  const meta = throughFile([{ id: hostile }]);
  assert.equal(meta.width, 64, 'geometry must come from the real member');
  assert.deepEqual(meta.signals.map(s => s.id), [hostile]);
  assert.equal(meta.signals[0].quant, null);
});

test('near/far keep full double precision through the file', () => {
  const near = 1 / 3, far = 7.123456789012345;
  const meta = throughFile([{ id: 'depth', near, far }]);
  assert.equal(meta.signals[0].quant.near, near);
  assert.equal(meta.signals[0].quant.far, far);
});
