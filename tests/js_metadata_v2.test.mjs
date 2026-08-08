/** v2-only metadata (no v1 depth promotion). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMetadata, buildFileMetadata, planSignals } from '../src/signals.js';

test('v1 depth-only metadata is rejected', () => {
  assert.throws(
    () => normalizeMetadata({ version: 1, width: 64, depth: { trackHi: 2, trackLo: 3, near: 0.5, far: 5 } }),
    /signals/);
});

test('empty signals[] is rejected', () => {
  assert.throws(() => normalizeMetadata({ version: 2, width: 64, signals: [] }));
});

test('encode metadata is v3 with no top-level depth', () => {
  const signals = planSignals([{ id: 'depth', near: 0.3, far: 9 }], false);
  const meta = buildFileMetadata({ W: 64, H: 48, fps: 30, n: 1, hasRgb: false, signals });
  assert.equal(meta.version, 3);
  assert.ok(!('depth' in meta), 'no top-level depth key');
  assert.equal(normalizeMetadata(meta).signals.length, 1);
});
