/** Regenerate tests/fixtures/quant_golden.csv — the cross-language quantizer contract.
 *  Run from the repo root: node tests/fixtures/regen_quant_golden.mjs
 *
 *  Bit-exact interop between the JS, Python and C++ quantizers is the core product claim, but the
 *  three are independent implementations (JS Math.round on doubles; C++ lround, which Python calls
 *  through ctypes). Nothing pinned that they agree — least of all on the half-step rounding
 *  boundaries, where Math.round (half up) and lround (half away from zero) differ for negatives.
 *  This file is the shared oracle: tests/js_quant_golden.test.mjs, tests/test_quant_golden.py and
 *  `dccli goldencheck` all replay it.
 *
 *  Format — CSV, one case per line, so that the C++ side needs no JSON parser:
 *      near,far,levels,z,code,back
 *  z and back are either the token nan/inf/-inf or 0x + the 8 hex digits of the float32 bit
 *  pattern, which transports the exact value across all three languages without decimal rounding.
 */
import { writeFileSync } from 'node:fs';
import { quantizeInverseDepth, dequantizeInverseDepth } from '../../src/chromapakz-core.js';

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function encode(v) {
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  f32[0] = v;
  return '0x' + u32[0].toString(16).padStart(8, '0');
}

/** Every (near, far, levels) triple worth pinning, including the smallest legal level count. */
const RANGES = [
  { near: 0.2, far: 10, levels: 65536 },
  { near: 0.5, far: 5, levels: 4096 },
  { near: 0.25, far: 8, levels: 1024 },
  { near: 0.3, far: 9, levels: 2048 },
  { near: 1, far: 100, levels: 3 },        // M == 1: the degenerate two-code case
  { near: 0.001, far: 1000, levels: 65536 },  // six orders of magnitude
];

function casesFor({ near, far, levels }) {
  const M = levels - 2, a = 1 / near, b = 1 / far;
  const zs = [
    0, -0, -1, -1e-30, NaN, Infinity, -Infinity,   // every input that must map to code 0 (bar +Inf)
    5e-324, 1e-30,                                 // denormal and tiny positive: valid, clamp to max
    near, far,                                     // exact endpoints
    near * 0.5, far * 2, 1e30,                     // outside the range on both sides
    (near + far) / 2,
  ];
  // Values landing exactly on a half-step boundary, where the two roundings can disagree.
  for (const k of [0, 1, 2, M - 1, M, Math.floor(M / 2)]) {
    if (!(k >= 0 && k <= M)) continue;
    zs.push(1 / (b + (k + 0.5) * (a - b) / M));
    zs.push(1 / (b + k * (a - b) / M));            // and exactly on a code centre
  }
  // A spread of ordinary depths across the range.
  for (let i = 0; i <= 8; i++) zs.push(near + (far - near) * i / 8);
  return zs;
}

const lines = [
  '# ChromaPakZ cross-language quantizer golden vectors — regenerate with',
  '# node tests/fixtures/regen_quant_golden.mjs  (see that file for the format)',
  'near,far,levels,z,code,back',
];

for (const range of RANGES) {
  const { near, far, levels } = range;
  const zs = casesFor(range);
  const input = Float32Array.from(zs);                       // round the inputs to float32 first
  const codes = quantizeInverseDepth(input, near, far, levels);
  const back = dequantizeInverseDepth(codes, near, far, levels);
  for (let i = 0; i < input.length; i++)
    lines.push(`${near},${far},${levels},${encode(input[i])},${codes[i]},${encode(back[i])}`);
}

const out = new URL('quant_golden.csv', import.meta.url);
writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${lines.length - 3} golden cases to ${out.pathname}`);
