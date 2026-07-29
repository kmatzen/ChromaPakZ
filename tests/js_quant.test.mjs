/** chromapakz.js helper re-exports (no WebCodecs required). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoNearFar,
  triFoldPack,
  triFoldUnpack,
  quantizeInverseDepth,
  dequantizeInverseDepth,
  LEVELS_FULL,
} from '../src/chromapakz.js';

test('autoNearFar picks the valid-sample extremes', () => {
  const z1 = new Float32Array([0.5, 1.0, 2.0, NaN, 0, 5.0]);
  const z2 = new Float32Array([3.0, 4.0]);
  const { near, far } = autoNearFar([z1, z2]);
  assert.equal(near, 0.5);
  assert.equal(far, 5.0);
});

test('autoNearFar throws when no sample is valid', () => {
  assert.throws(() => autoNearFar([new Float32Array([NaN, 0, -1])]), /no valid/);
});

test('triFoldPack/triFoldUnpack round-trip', () => {
  const codes = new Uint16Array([0, 1, 255, 256, 65535]);
  const { hi, lo } = triFoldPack(codes);
  assert.deepEqual(triFoldUnpack(hi, lo), codes);
});

test('inverse-depth quantize round-trips valid pixels', () => {
  const z = new Float32Array([0.3, 1.5, 8.0]);
  const q = quantizeInverseDepth(z, 0.2, 10, LEVELS_FULL);
  const back = dequantizeInverseDepth(q, 0.2, 10, LEVELS_FULL);
  for (let i = 0; i < z.length; i++) {
    assert.ok(q[i] > 0, `code ${i} valid`);
    assert.ok(Math.abs(back[i] - z[i]) < 0.01, `dequant error ${i}: ${back[i]} vs ${z[i]}`);
  }
  assert.ok(q[0] > q[1] && q[1] > q[2], 'inverse-depth spends more codes near camera');
});
