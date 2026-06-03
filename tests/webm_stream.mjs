/** Node tests for incremental WebM mux/demux. Run: node tests/webm_stream.mjs */
import { mux, demux, createStreamMux, createStreamDemux, concatChunks } from '../src/webm.js';

let failed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failed++; }
}

const tracks = [
  { number: 1, codecID: 'V_VP9', name: 'rgb', width: 64, height: 48 },
  { number: 2, codecID: 'V_VP9', name: 'depth-hi', width: 64, height: 48 },
  { number: 3, codecID: 'V_VP9', name: 'depth-lo', width: 64, height: 48 },
];
const metadata = {
  version: 1, width: 64, height: 48, fps: 30, frames: 3,
  rgb: { track: 1, codec: 'vp09.00.10.08' },
  depth: { trackHi: 2, trackLo: 3, near: 0.5, far: 5, levels: 65536 },
};
const frames = [];
for (let i = 0; i < 3; i++) {
  const t = i * 33;
  frames.push({ track: 1, key: i === 0, timeMs: t, data: new Uint8Array([i, 1, 2]) });
  frames.push({ track: 2, key: i === 0, timeMs: t, data: new Uint8Array([i, 10]) });
  frames.push({ track: 3, key: i === 0, timeMs: t, data: new Uint8Array([i, 20]) });
}

const batch = mux({ tracks, frames, metadata, durationMs: 100 });

// incremental mux matches batch frame count
const sm = createStreamMux({ tracks, metadata: { ...metadata, frames: null, streaming: true } });
const inc = [sm.header];
for (const f of frames) {
  const c = sm.writeFrame(f);
  if (c) inc.push(c);
}
inc.push(sm.finish());
const streamed = concatChunks(inc);
const dBatch = demux(batch);
const dStream = demux(streamed);
ok(dBatch.frames.length === dStream.frames.length, `frame count ${dBatch.frames.length} vs ${dStream.frames.length}`);
ok(dBatch.metadata.near === dStream.metadata.near, 'metadata round-trip');

// incremental demux via chunked push
const sdm = createStreamDemux();
const chunkSize = 97;
let gotMeta = false, blocks = 0;
for (let o = 0; o < streamed.length; o += chunkSize) {
  const ev = sdm.push(streamed.subarray(o, Math.min(o + chunkSize, streamed.length)));
  for (const e of ev) if (e.type === 'metadata') gotMeta = true;
}
for (const e of sdm.finish()) if (e.type === 'block') blocks++;
ok(gotMeta, 'incremental demux got metadata');
ok(blocks === dStream.frames.length, `incremental blocks ${blocks}`);

// unknown-size segment header: metadata arrives once Tags element is complete
const sm2 = createStreamMux({ tracks, metadata, durationMs: 0, unknownSegmentSize: true });
const early = createStreamDemux();
early.push(sm2.header);
ok(!!early.metadata, 'metadata after full header push');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
