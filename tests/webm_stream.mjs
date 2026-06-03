/** Node tests for incremental WebM mux/demux. Run: node tests/webm_stream.mjs */
import { mux, demux, createStreamMux, createStreamDemux, concatChunks } from '../src/webm.js';
import { buildFileMetadata, planSignals, buildTracksFromPlan } from '../src/signals.js';

let failed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failed++; }
}

const signals = planSignals([{ id: 'depth', near: 0.5, far: 5, levels: 65536 }], true);
const tracks = buildTracksFromPlan(64, 48, true, signals);
const metadata = buildFileMetadata({ W: 64, H: 48, fps: 30, n: 3, hasRgb: true, signals });
const frames = [];
for (let i = 0; i < 3; i++) {
  const t = i * 33;
  frames.push({ track: 1, key: i === 0, timeMs: t, data: new Uint8Array([i, 1, 2]) });
  frames.push({ track: signals[0].tracks.hi, key: i === 0, timeMs: t, data: new Uint8Array([i, 10]) });
  frames.push({ track: signals[0].tracks.lo, key: i === 0, timeMs: t, data: new Uint8Array([i, 20]) });
}

const nearFrom = (m) => m.signals?.find(s => s.id === 'depth')?.quant?.near;

const batch = mux({ tracks, frames, metadata, durationMs: 100 });

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
ok(nearFrom(dBatch.metadata) === nearFrom(dStream.metadata), 'metadata round-trip');

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

const sm2 = createStreamMux({ tracks, metadata, durationMs: 0, unknownSegmentSize: true });
const early = createStreamDemux();
early.push(sm2.header);
ok(!!early.metadata, 'metadata after full header push');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
