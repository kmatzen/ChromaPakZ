// The WASM decoder must not trust the file's metadata about frame geometry.
//
// The copy loops in native/wasm/dc_vp9.cpp read planes[0] as 8-bit rows of W bytes and the chroma
// planes at half resolution, using the W/H the *metadata* declares. Nothing in the container ties
// that metadata to the bitstream, so a file claiming a larger frame than it actually codes made
// those row memcpys read past libvpx's plane allocations. 5cee74c added a per-image format and
// dimension check (dec_image_ok) for exactly this — but the fix lives in a committed .wasm binary
// that only a manual `npm run build:wasm` regenerates, so without this test a rebuild that drops
// it is invisible. The native/Python side of the same guard is tests/test_decode_bounds.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEncoder, createDecoder } from '../src/chromapakz.js';

const W = 48, H = 32, N = 3;

async function encodeHonest() {
  const enc = createEncoder({ W, H, fps: 30, signals: [{ id: 'raw' }], backend: 'wasm' });
  for (let f = 0; f < N; f++) {
    const u16 = new Uint16Array(W * H);
    for (let i = 0; i < u16.length; i++) u16[i] = (i * 97 + f * 613) % 60000 + 1;
    await enc.addFrame({ signals: { raw: { u16 } } });
  }
  return enc.finish();
}

async function drain(bytes) {
  const dec = createDecoder(bytes, { backend: 'wasm' });
  const out = [];
  for await (const fr of dec) out.push(fr);
  await dec.close();
  return out;
}

// latin1 keeps the byte<->char mapping 1:1, so a same-length text substitution is a byte-exact
// patch of the embedded JSON metadata. Preserving the length keeps every enclosing EBML size
// valid — the crafted file is well-formed, it just lies.
function claim(bytes, field, honest, lie) {
  const from = `"${field}":${honest}`, to = `"${field}":${lie}`;
  assert.equal(from.length, to.length, 'patch must preserve byte length');
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.includes(from), `metadata should contain ${from}`);
  return new Uint8Array(Buffer.from(text.replace(from, to), 'latin1'));
}

// Sanity first, so a failure below is the guard firing and not the decoder being broken outright.
test('honest file round-trips through the wasm backend', async () => {
  assert.equal((await drain(await encodeHonest())).length, N);
});

for (const [field, honest] of [['width', W], ['height', H]]) {
  test(`decode rejects a file claiming ${field}=99 over a ${W}x${H} bitstream`, async () => {
    const lying = claim(await encodeHonest(), field, honest, 99);
    await assert.rejects(() => drain(lying));
  });
}
