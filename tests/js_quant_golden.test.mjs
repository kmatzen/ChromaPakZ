/** Replay the cross-language quantizer golden vectors against the JS implementation.
 *
 *  The same tests/fixtures/quant_golden.csv is replayed by tests/test_quant_golden.py (native,
 *  via ctypes) and by `dccli goldencheck` (C++). If the three ever disagree — most likely on a
 *  half-step rounding boundary, where JS Math.round and C++ lround part ways — exactly one of
 *  those three will fail, which is the point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quantizeInverseDepth, dequantizeInverseDepth } from '../src/chromapakz-core.js';
import { parseGolden, describeCase } from './fixtures/golden_csv.mjs';

const CASES = parseGolden(readFileSync(new URL('./fixtures/quant_golden.csv', import.meta.url), 'utf8'));

test('the golden file is non-trivial', () => {
  assert.ok(CASES.length >= 100, `only ${CASES.length} golden cases`);
  assert.ok(CASES.some(c => c.code === 0), 'no invalid-input case');
  assert.ok(CASES.some(c => c.code > 0), 'no valid-depth case');
});

test('quantizeInverseDepth reproduces every golden code', () => {
  for (const c of CASES) {
    const got = quantizeInverseDepth(Float32Array.of(c.z), c.near, c.far, c.levels)[0];
    assert.equal(got, c.code, `${describeCase(c)}: code ${got} != golden ${c.code}`);
  }
});

test('dequantizeInverseDepth reproduces every golden depth bit-exactly', () => {
  for (const c of CASES) {
    const got = dequantizeInverseDepth(Uint16Array.of(c.code), c.near, c.far, c.levels)[0];
    if (Number.isNaN(c.back)) {
      assert.ok(Number.isNaN(got), `${describeCase(c)}: expected NaN, got ${got}`);
    } else {
      assert.equal(got, c.back, `${describeCase(c)}: depth ${got} != golden ${c.back}`);
    }
  }
});
