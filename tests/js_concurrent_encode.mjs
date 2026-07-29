/**
 * Concurrency regression test: overlapping addFrame()/readFrame() must not corrupt the stream.
 * Run: node tests/js_concurrent_encode.mjs
 *
 * `await Promise.all(frames.map(f => enc.addFrame(f)))` is the natural way to hand a batch of
 * frames to an async API, and it used to break badly. addFrame() awaits before lazily building
 * its track encoders, so every concurrent call got past the `if(!sigEnc[id])` guard and built its
 * own encoder pair — each frame came out as frame 0 of a different encoder, i.e. every block a
 * keyframe at t=0, all but the last encoder leaked unclosed. On the WebCodecs backend the
 * single-slot output waiter compounded it into a permanent hang.
 *
 * VP9 encoding is inherently sequential, so the contract is: concurrent calls are serialized in
 * call order and must produce exactly what the sequential path produces.
 */
import { createEncoder, createDecoder } from '../src/chromapakz.js';

let failed = 0;
function ok(c, m){ if(!c){ console.error('FAIL:', m); failed++; } }

const W=48, H=32, N=5;
const BACKEND='wasm';   // the only backend reachable headless under Node (and Safari's path)

function makeSeq(){
  const frames=[];
  for(let f=0; f<N; f++){
    const u16=new Uint16Array(W*H);
    for(let r=0;r<H;r++) for(let c=0;c<W;c++) u16[r*W+c]=9000 + f*900 + c*13 + r*5;
    frames.push(u16);
  }
  return frames;
}
const eqU16=(a,b)=>a.length===b.length && a.every((v,i)=>v===b[i]);
const eqBytes=(a,b)=>a.length===b.length && a.every((v,i)=>v===b[i]);

const seq=makeSeq();
const frameOf=u16=>({ signals:{ raw:{ u16 } } });

// Any hang here is itself the bug, so bound every drive.
function withTimeout(p, label, ms=30000){
  return Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej(new Error(`${label} timed out — deadlock`)), ms))]);
}

async function encodeWith(drive, opts={}){
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'raw' }], backend:BACKEND, ...opts });
  await withTimeout(drive(enc), 'addFrame');
  const bytes=await withTimeout(enc.finish(), 'finish');
  return { bytes, frameCount: enc.frameCount };
}

const driveSequential=async enc=>{ for(const u16 of seq) await enc.addFrame(frameOf(u16)); };
const driveConcurrent=enc=>Promise.all(seq.map(u16=>enc.addFrame(frameOf(u16))));

async function decodeAll(bytes){
  const dec=createDecoder(bytes, { backend:BACKEND });
  const out=[];
  for await (const fr of dec) out.push(fr.signals.raw.u16);
  await dec.close();
  return out;
}

// ── buffered encode ──
const base=await encodeWith(driveSequential);
const conc=await encodeWith(driveConcurrent);

ok(conc.frameCount===N, `concurrent frameCount ${conc.frameCount} === ${N}`);
// Serialization must reproduce the sequential result exactly, not merely something decodable.
ok(eqBytes(conc.bytes, base.bytes),
   `concurrent encode is byte-identical to sequential (${conc.bytes.length} vs ${base.bytes.length} bytes)`);

const decoded=await decodeAll(conc.bytes);
ok(decoded.length===N, `decoded ${decoded.length} frames === ${N}`);
// Order matters as much as content: frame i must be seq[i], not some surviving permutation.
for(let i=0;i<Math.min(decoded.length, N);i++)
  ok(eqU16(decoded[i], seq[i]), `frame ${i} bit-exact and in order`);

// ── streaming encode (onChunk) — the mux is order-sensitive, so it has its own exposure ──
{
  // Compare streaming-against-streaming: the live mux writes an unknown-size Segment and a
  // streaming metadata header, so its bytes legitimately differ from the buffered mux().
  const chunksSeq=[], chunksConc=[];
  const sSeq=await encodeWith(driveSequential, { onChunk:c=>chunksSeq.push(c) });
  const sConc=await encodeWith(driveConcurrent, { onChunk:c=>chunksConc.push(c) });
  ok(eqBytes(sConc.bytes, sSeq.bytes),
     `streaming concurrent is byte-identical to streaming sequential (${sConc.bytes.length} vs ${sSeq.bytes.length} bytes)`);
  ok(chunksConc.length===chunksSeq.length,
     `streaming emitted ${chunksConc.length} chunks === sequential ${chunksSeq.length}`);
  ok((await decodeAll(sConc.bytes)).every((u,i)=>eqU16(u, seq[i])), 'streaming concurrent bytes decode bit-exact');
}

// ── concurrent readFrame() on the decoder ──
{
  const dec=createDecoder(base.bytes, { backend:BACKEND });
  const frames=await withTimeout(Promise.all(Array.from({ length:N }, ()=>dec.readFrame())), 'readFrame');
  await dec.close();
  ok(frames.every(f=>f && f.signals.raw), `concurrent readFrame returned ${N} frames`);
  ok(frames.every((f,i)=>f && eqU16(f.signals.raw.u16, seq[i])),
     'concurrent readFrame yields frames in call order, bit-exact');
}

console.log(`concurrent encode/decode: ${N} frames, ${W}x${H} — serialized, byte-identical to sequential`);
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
