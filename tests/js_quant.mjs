/** Node tests for chromapakz.js helpers (no WebCodecs required). Run: node tests/js_quant.mjs */
import {
  autoNearFar,
  triFoldPack,
  triFoldUnpack,
  quantizeInverseDepth,
  dequantizeInverseDepth,
  LEVELS_FULL,
} from '../src/chromapakz.js';

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed++;
  }
}

// autoNearFar
const z1 = new Float32Array([0.5, 1.0, 2.0, NaN, 0, 5.0]);
const z2 = new Float32Array([3.0, 4.0]);
const { near, far } = autoNearFar([z1, z2]);
ok(near === 0.5, `autoNearFar near=${near}`);
ok(far === 5.0, `autoNearFar far=${far}`);
try {
  autoNearFar([new Float32Array([NaN, 0, -1])]);
  ok(false, 'autoNearFar should throw on empty valid set');
} catch {
  ok(true, 'autoNearFar throws on no valid samples');
}

// triangle-fold roundtrip
const codes = new Uint16Array([0, 1, 255, 256, 65535]);
const { hi, lo } = triFoldPack(codes);
ok(triFoldUnpack(hi, lo).every((v, i) => v === codes[i]), 'triFoldPack/unpack bit-exact');

// inverse-depth quantize roundtrip on valid pixels
const z = new Float32Array([0.3, 1.5, 8.0]);
const q = quantizeInverseDepth(z, 0.2, 10, LEVELS_FULL);
const back = dequantizeInverseDepth(q, 0.2, 10, LEVELS_FULL);
for (let i = 0; i < z.length; i++) {
  ok(q[i] > 0, `code ${i} valid`);
  ok(Math.abs(back[i] - z[i]) < 0.01, `dequant error ${i}: ${back[i]} vs ${z[i]}`);
}
ok(q[0] > q[1] && q[1] > q[2], 'inverse-depth spends more codes near camera');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
