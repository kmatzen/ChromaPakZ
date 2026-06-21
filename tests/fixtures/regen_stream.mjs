/** Regenerate the streaming-interop golden fixture used by tests/stream_interop.py.
 *  Run from the repo root: node tests/fixtures/regen_stream.mjs
 *
 *  Produces a real WASM-encoded streamed clip — createEncoder({onChunk}) emits an unknown-size
 *  Segment with "frames":null — plus the verbatim uint16 codes the decoder must return. */
import { createEncoder } from '../../src/chromapakz.js';
import { concatChunks } from '../../src/webm.js';
import { writeFileSync } from 'node:fs';

const W = 40, H = 24, N = 5;
const seq = [];
for (let f = 0; f < N; f++) {
  const u = new Uint16Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) u[r * W + c] = (c * 131 + r * 517 + f * 7919) & 0xffff;
  seq.push(u);
}

const chunks = [];
const enc = createEncoder({ W, H, fps: 30, signals: [{ id: 'depth' }, { id: 'objectId' }],
  backend: 'wasm', onChunk: c => chunks.push(c) });
for (const u16 of seq) await enc.addFrame({ signals: { depth: { u16 }, objectId: { u16 } } });
await enc.finish();

const here = new URL('.', import.meta.url).pathname;
writeFileSync(here + 'stream.webm', concatChunks(chunks));
const flat = new Uint16Array(N * W * H);
let o = 0; for (const u of seq) { flat.set(u, o); o += u.length; }
writeFileSync(here + 'stream_depth.u16', Buffer.from(flat.buffer));
console.log(`regenerated stream.webm (${concatChunks(chunks).length} B) + stream_depth.u16`);
