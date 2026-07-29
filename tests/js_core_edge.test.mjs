/** Quantization + triangle-fold edge cases (src/chromapakz-core.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quantizeInverseDepth,
  dequantizeInverseDepth,
  triFoldPack,
  triFoldUnpack,
  autoNearFar,
  LEVELS_FULL,
} from '../src/chromapakz-core.js';

test('triFold round-trips every uint16 value', () => {
  const all = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) all[i] = i;
  const { hi, lo } = triFoldPack(all);
  const back = triFoldUnpack(hi, lo);
  for (let i = 0; i < 65536; i++) assert.equal(back[i], i, `code ${i}`);

  // continuity across byte boundaries: adjacent codes never produce a lo-byte cliff
  let maxStep = 0;
  for (let i = 1; i < 65536; i++) maxStep = Math.max(maxStep, Math.abs(lo[i] - lo[i - 1]));
  assert.equal(maxStep, 1, 'lo plane is continuous');
});

test('invalid depths map to code 0, and only code 0', () => {
  const z = new Float32Array([0, -1, -0.0001, NaN, Infinity, -Infinity]);
  const q = quantizeInverseDepth(z, 0.2, 10);
  assert.deepEqual([q[0], q[1], q[2], q[3]], [0, 0, 0, 0], 'zero/negative/NaN -> code 0');
  assert.equal(q[5], 0, '-Infinity -> code 0');
  // +Infinity is a "valid" (>0) but beyond-far depth: must clamp into range, never 0
  assert.ok(q[4] >= 1, '+Infinity clamps to a valid far code');
});

test('depths clamp at the near/far ends', () => {
  const near = 0.5, far = 5;
  const z = new Float32Array([0.001, near, far, 1000]);
  const q = quantizeInverseDepth(z, near, far);
  assert.equal(q[0], LEVELS_FULL - 1, 'nearer-than-near clamps to max code');
  assert.equal(q[1], LEVELS_FULL - 1, 'depth==near maps to max code');
  assert.equal(q[2], 1, 'depth==far maps to code 1');
  assert.equal(q[3], 1, 'farther-than-far clamps to code 1');
});

test('code 0 dequantizes to NaN, every valid code to an in-range depth', () => {
  const near = 0.3, far = 9;
  const codes = new Uint16Array([0, 1, 32768, LEVELS_FULL - 1]);
  const z = dequantizeInverseDepth(codes, near, far);
  assert.ok(Number.isNaN(z[0]), 'code 0 -> NaN');
  for (let i = 1; i < codes.length; i++)
    assert.ok(Number.isFinite(z[i]) && z[i] >= near * 0.999 && z[i] <= far * 1.001,
      `code ${codes[i]} -> in-range depth (${z[i]})`);
  assert.ok(Math.abs(z[1] - far) < 1e-3 * far, 'code 1 -> ~far');
  assert.ok(Math.abs(z[3] - near) < 1e-3 * near, 'max code -> ~near');
});

for (const levels of [4, 256, 1024, 4096]) {
  test(`levels=${levels}: round-trip error bounded by half a step`, () => {
    const near = 0.5, far = 8, M = levels - 2;
    const step = (1 / near - 1 / far) / M;
    const n = 500;
    const z = new Float32Array(n);
    for (let i = 0; i < n; i++) z[i] = near + (far - near) * i / (n - 1);
    const q = quantizeInverseDepth(z, near, far, levels);
    const back = dequantizeInverseDepth(q, near, far, levels);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      assert.ok(q[i] >= 1 && q[i] <= levels - 1, `code ${q[i]} outside [1, ${levels - 1}]`);
      worst = Math.max(worst, Math.abs(1 / back[i] - 1 / z[i]) / step);
    }
    assert.ok(worst <= 0.51, `max inverse-depth error ${worst.toFixed(3)} steps (want <=0.5)`);
  });
}

test('quantization is monotone: deeper never gets a larger code', () => {
  const n = 2000, z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = 0.2 + i * (10 - 0.2) / (n - 1);
  const q = quantizeInverseDepth(z, 0.2, 10, 1024);
  for (let i = 1; i < n; i++) assert.ok(q[i] <= q[i - 1], `code rose at ${i}`);
});

test('autoNearFar honours percentile arguments', () => {
  const z = new Float32Array(101);
  for (let i = 0; i <= 100; i++) z[i] = 1 + i * 0.1;      // 1.0 .. 11.0
  const d = autoNearFar([z], 10, 90);
  assert.ok(Math.abs(d.near - 2.0) < 0.11, `10th pct near ~2.0 (${d.near})`);
  assert.ok(Math.abs(d.far - 10.0) < 0.11, `90th pct far ~10.0 (${d.far})`);
});

test('autoNearFar widens a degenerate (constant-depth) spread', () => {
  const flat = new Float32Array(50).fill(3.25);
  const df = autoNearFar([flat]);
  assert.equal(df.near, 3.25);
  assert.ok(df.far > df.near, `far must exceed near (${df.far})`);
});
