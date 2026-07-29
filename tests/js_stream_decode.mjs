/** Node tests for the network (push/finish) decode path — the behaviours it must share with the
 *  buffered path, plus its own lifecycle. Run: node tests/js_stream_decode.mjs
 *
 *  Files are built by re-muxing a real encoded clip, so every block is a genuine VP9 frame and
 *  each track's frames stay in order; only the timestamps are rearranged. That is enough to model
 *  a file whose tracks do not share a timeline — the case that used to strand frames forever.
 */
import { createEncoder, createDecoder } from '../src/chromapakz.js';
import { demux, createStreamMux, concatChunks } from '../src/webm.js';

const W = 32, H = 24, N = 4;

let failed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failed++; }
}

function makeU16(f) {
  const u16 = new Uint16Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) u16[r * W + c] = (1000 + f * 300 + c * 40 + r * 17) & 0xffff;
  return u16;
}
function makeRgb(f) {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = (i + f * 9) & 0xff; rgba[i * 4 + 1] = (i * 3) & 0xff; rgba[i * 4 + 2] = f * 30 & 0xff; rgba[i * 4 + 3] = 255; }
  return rgba;
}

// One real clip: rgb + a lossless uint16 signal, every frame carrying both.
const enc = createEncoder({ W, H, fps: 30, signals: [{ id: 'raw' }], backend: 'wasm' });
for (let f = 0; f < N; f++) await enc.addFrame({ rgb: makeRgb(f), signals: { raw: { u16: makeU16(f) } } });
const baseBytes = await enc.finish();
const source = demux(baseBytes);
const meta = source.metadata;
const rgbTrack = meta.rgb.track;
const sig = meta.signals[0];

/** Re-mux the clip's blocks with a per-track timestamp offset applied. */
function remux(offsetForTrack) {
  const tracks = [
    { number: rgbTrack, codecID: 'V_VP9', name: 'rgb', width: W, height: H },
    { number: sig.tracks.hi, codecID: 'V_VP9', name: `signal-${sig.id}-hi`, width: W, height: H },
    { number: sig.tracks.lo, codecID: 'V_VP9', name: `signal-${sig.id}-lo`, width: W, height: H },
  ];
  const frames = source.frames
    .map(f => ({ ...f, timeMs: f.timeMs + offsetForTrack(f.track) }))
    .sort((a, b) => a.timeMs - b.timeMs || a.track - b.track);
  const sm = createStreamMux({ tracks, metadata: { ...meta, frames: null, streaming: true } });
  const parts = [sm.header];
  for (const f of frames) { const c = sm.writeFrame(f); if (c) parts.push(c); }
  parts.push(sm.finish());
  return concatChunks(parts);
}

async function decodeBuffered(bytes) {
  const dec = createDecoder(bytes, { backend: 'wasm' });
  const out = [];
  for await (const fr of dec) out.push(fr);
  await dec.close();
  return out;
}

async function decodeStreamed(bytes, chunkSize = 500) {
  const dec = createDecoder(undefined, { backend: 'wasm' });
  for (let o = 0; o < bytes.length; o += chunkSize) dec.push(bytes.subarray(o, Math.min(o + chunkSize, bytes.length)));
  dec.finish();
  const out = [];
  for await (const fr of dec) out.push(fr);
  await dec.close();
  return out;
}

const shape = frames => frames.map(f => `${f.rgb ? 'rgb' : '-'}/${Object.keys(f.signals ?? {}).sort().join('+') || '-'}`).join(' ');

// ── aligned tracks: the ordinary case still round-trips, both ways ──
{
  const buffered = await decodeBuffered(baseBytes);
  const streamed = await decodeStreamed(baseBytes);
  ok(buffered.length === N, `buffered frames ${buffered.length}/${N}`);
  ok(shape(streamed) === shape(buffered), `streamed shape "${shape(streamed)}" vs buffered "${shape(buffered)}"`);
  const want = makeU16(2);
  ok(streamed[2].signals.raw.u16.every((v, i) => v === want[i]), 'streamed signal bit-exact');
  ok(!!streamed[1].rgb, 'streamed rgb present');
}

// ── rgb and signal on different timestamps: no slot ever holds every declared key ──
// Every frame is rgb-only or signal-only. These used to sit in slotPending forever, so the
// streaming decoder returned nothing while the buffered decoder returned all of them.
{
  const bytes = remux(t => (t === rgbTrack ? 1 : 0));
  const buffered = await decodeBuffered(bytes);
  const streamed = await decodeStreamed(bytes);
  ok(buffered.length === 2 * N, `split-timeline buffered frames ${buffered.length}/${2 * N}`);
  ok(streamed.length === buffered.length, `split-timeline streamed frames ${streamed.length}/${buffered.length}`);
  ok(shape(streamed) === shape(buffered), `split-timeline shape "${shape(streamed)}" vs "${shape(buffered)}"`);
  ok(streamed.filter(f => f.rgb).length === N, 'every rgb-only frame delivered');
  ok(streamed.filter(f => f.signals.raw).length === N, 'every signal-only frame delivered');
}

// ── hi without lo: half a signal is not decodable, and must not reach the codec as undefined ──
{
  const bytes = remux(t => (t === sig.tracks.lo ? 1 : 0));
  const buffered = await decodeBuffered(bytes);
  const streamed = await decodeStreamed(bytes);
  ok(buffered.length === N, `orphan-plane buffered frames ${buffered.length}/${N}`);
  ok(shape(streamed) === shape(buffered), `orphan-plane shape "${shape(streamed)}" vs "${shape(buffered)}"`);
  ok(streamed.every(f => !f.signals.raw), 'unpaired hi plane yields no signal');
  ok(streamed.every(f => !!f.rgb), 'rgb still decodes alongside an unpaired plane');
}

// ── close() unblocks a readFrame() that is waiting for bytes that never come ──
{
  const dec = createDecoder(undefined, { backend: 'wasm' });
  let o = 0;
  while (!dec.ready && o < baseBytes.length) { dec.push(baseBytes.subarray(o, o + 64)); o += 64; }
  ok(dec.ready, 'metadata parsed from the header, before any cluster');
  const pending = dec.readFrame().then(() => 'resolved', e => `rejected: ${e.message}`);
  const timeout = new Promise(res => setTimeout(() => res('deadlock'), 1000));
  await dec.close();
  const outcome = await Promise.race([pending, timeout]);
  ok(outcome !== 'deadlock', `close() left readFrame() hanging (${outcome})`);
  ok(outcome === 'rejected: decoder closed', `pending readFrame settles as closed (${outcome})`);
}

// ── decode runs ahead of finish(), and a drained queue is not the end of the stream ──
{
  const dec = createDecoder(undefined, { backend: 'wasm' });
  for (let o = 0; o < baseBytes.length; o += 256) dec.push(baseBytes.subarray(o, Math.min(o + 256, baseBytes.length)));
  // No finish() — every frame below is decoded from a stream that is still open, which is only
  // possible because blocks now surface during push() instead of being held back until the end.
  const got = [];
  for (let k = 0; k < N; k++) got.push(await dec.readFrame());
  ok(got.every(Boolean), `all frames decoded before finish() (${got.map(Boolean).join()})`);
  const want = makeU16(N - 1);
  ok(got[N - 1].signals.raw.u16.every((v, i) => v === want[i]), 'frames resolve in call order');

  // Queue drained, stream still open: readFrame() must wait for more bytes, not report the end.
  let settled = null;
  const pending = dec.readFrame().then(f => { settled = f === null ? 'null' : 'frame'; });
  await new Promise(res => setTimeout(res, 100));
  ok(settled === null, `readFrame waited on a drained but open stream (settled as ${settled})`);

  dec.finish();
  await pending;
  ok(settled === 'null', `null once the stream is done (${settled})`);
  await dec.close();
}

// ── setNearFar after encoding has begun would desync metadata from the quantized data ──
{
  const e = createEncoder({ W, H, fps: 30, signals: [{ id: 'depth', near: 0.5, far: 5 }], backend: 'wasm' });
  e.setNearFar(1, 8);
  ok(e.near === 1 && e.far === 8, 'setNearFar before the first frame applies');
  await e.addFrame({ signals: { depth: { u16: makeU16(0) } } });
  let threw = false;
  try { e.setNearFar(2, 9); } catch { threw = true; }
  ok(threw, 'setNearFar after addFrame throws');
  ok(e.near === 1 && e.far === 8, 'rejected setNearFar leaves the range untouched');
  await e.finish();
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
