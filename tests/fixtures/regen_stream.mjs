/** Regenerate the streaming-interop golden fixture used by tests/test_stream_interop.py.
 *  Run from the repo root: node tests/fixtures/regen_stream.mjs
 *
 *  Produces a real WASM-encoded streamed clip — createEncoder({onChunk}) emits an unknown-size
 *  Segment with "frames":null — plus the verbatim uint16 codes the decoder must return.
 *
 *  The payload comes from stream_fixture.mjs, which tests/js_fixture_stream.test.mjs also reads,
 *  so a regenerated fixture and the test's expectations cannot drift apart. */
import { createEncoder } from '../../src/chromapakz.js';
import { concatChunks } from '../../src/webm.js';
import { writeFileSync } from 'node:fs';
import { W, H, makeSequence, flatSequence } from './stream_fixture.mjs';

const seq = makeSequence();

const chunks = [];
const enc = createEncoder({ W, H, fps: 30, signals: [{ id: 'depth' }, { id: 'objectId' }],
  backend: 'wasm', onChunk: c => chunks.push(c) });
for (const u16 of seq) await enc.addFrame({ signals: { depth: { u16 }, objectId: { u16 } } });
await enc.finish();

const here = new URL('.', import.meta.url).pathname;
const webm = concatChunks(chunks);
writeFileSync(here + 'stream.webm', webm);
writeFileSync(here + 'stream_depth.u16', Buffer.from(flatSequence().buffer));
console.log(`regenerated stream.webm (${webm.length} B) + stream_depth.u16`);
