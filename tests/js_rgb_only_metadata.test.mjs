/**
 * An RGB-only file — pixels, no signal planes — must decode.
 *
 * planSignals() has always called this a valid plan ("an RGB-only take ... is a
 * valid plan; a file with no tracks at all is not"), and both writers emit
 * `signals: []` for it. normalizeMetadata() nonetheless rejected an empty
 * signals array outright, so the decoder refused files this library itself
 * produces: dropping an RGB-only capture into the wurld web viewer threw
 * "metadata must include signals[] (v2)" and nothing loaded.
 *
 * The emptiness check belongs after rgbs[] is resolved — neither signals nor RGB
 * is the case that really has nothing to decode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFileMetadata, normalizeMetadata, planSignals } from '../src/signals.js';

test('an RGB-only take is a valid plan and stays readable', () => {
  const signals = planSignals([], 1);
  assert.deepEqual(signals, [], 'no signal specs and rgb present is an empty plan');

  const meta = buildFileMetadata({ W: 64, H: 48, fps: 30, n: 12, hasRgb: true, signals });
  assert.deepEqual(meta.signals, [], 'the writer records an empty signals array');

  const norm = normalizeMetadata(meta);
  assert.deepEqual(norm.signals, []);
  assert.equal(norm.rgbs.length, 1, 'the rgb stream survives normalisation');
});

test('signals[] must still be an array', () => {
  assert.throws(
    () => normalizeMetadata({ width: 64, height: 48, rgb: { track: 1 } }),
    /must include signals\[\]/,
    'a missing signals key is still the v2 shape error');
});

test('neither signals nor rgb is rejected — nothing to decode', () => {
  assert.throws(
    () => normalizeMetadata({ width: 64, height: 48, signals: [] }),
    /neither signals\[\] nor an rgb stream/);
});
