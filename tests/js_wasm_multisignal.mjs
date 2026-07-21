// Multi-signal WASM round-trip in Node: a float depth signal (inverse-depth quant, reduced
// levels) plus a raw uint16 signal in one file — u16 codes must be bit-exact, dequantized
// depth within the quantization step — exercised through BOTH decode entry points:
// buffered createDecoder(bytes) and the network decoder (push()/finish()) fed by onChunk.
import { createEncoder, createDecoder, LEVELS_FULL } from '../src/chromapakz.js';

const W=48, H=32, N=4, LEVELS=4096, NEAR=0.4, FAR=6;

function makeDepth(f){
  const z=new Float32Array(W*H);
  for(let r=0;r<H;r++) for(let c=0;c<W;c++){
    z[r*W+c]=0.5 + 4.5*(r/H) + 0.4*Math.sin((c+f*3)/6);
    if((r+c+f)%97===0) z[r*W+c]=0;          // dropout holes -> code 0 -> NaN
  }
  return z;
}
function makeIds(f){
  const u=new Uint16Array(W*H);
  for(let i=0;i<u.length;i++) u[i]=((i*31+f*7919)&0xffff);
  return u;
}
const eqU16=(a,b)=>a.length===b.length && a.every((v,i)=>v===b[i]);

async function encodeClip(onChunk){
  const enc=createEncoder({ W, H, fps:30,
    signals:[{ id:'depth', near:NEAR, far:FAR, levels:LEVELS }, { id:'objectId' }],
    backend:'wasm', onChunk });
  for(let f=0;f<N;f++)
    await enc.addFrame({ signals:{ depth:{ float: makeDepth(f) }, objectId:{ u16: makeIds(f) } } });
  return enc.finish();
}

async function collect(dec){
  const frames=[];
  for await (const fr of dec) frames.push(fr);
  await dec.close();
  return frames;
}

function checkFrames(frames, label){
  if(frames.length!==N) throw new Error(`${label}: got ${frames.length} frames, want ${N}`);
  const M=LEVELS-2, step=(1/NEAR-1/FAR)/M;
  for(let f=0;f<N;f++){
    const got=frames[f].signals;
    if(!eqU16(got.objectId.u16, makeIds(f))) throw new Error(`${label}: objectId frame ${f} not bit-exact`);
    const zin=makeDepth(f), zout=got.depth.float, codes=got.depth.u16;
    if(!(zout instanceof Float32Array)) throw new Error(`${label}: depth float missing`);
    for(let i=0;i<zin.length;i++){
      if(!(zin[i]>0)){
        if(codes[i]!==0 || !Number.isNaN(zout[i]))
          throw new Error(`${label}: invalid pixel ${i} frame ${f}: code=${codes[i]} z=${zout[i]}`);
        continue;
      }
      if(codes[i]<1 || codes[i]>LEVELS-1) throw new Error(`${label}: code out of range: ${codes[i]}`);
      const err=Math.abs(1/zout[i]-1/Math.min(Math.max(zin[i], NEAR), FAR));
      if(err>step*0.51) throw new Error(`${label}: depth err ${err} > half step ${step/2} (frame ${f}, px ${i})`);
    }
  }
}

// ── buffered path ──
const bytes=await encodeClip(null);
const dec=createDecoder(bytes, { backend:'wasm' });
if(dec.metadata.signals.length!==2) throw new Error('metadata: want 2 signals');
if(dec.near!==NEAR || dec.far!==FAR || dec.levels!==LEVELS)
  throw new Error(`metadata quant: near=${dec.near} far=${dec.far} levels=${dec.levels}`);
if(dec.frameCount!==N) throw new Error(`frameCount ${dec.frameCount}`);
checkFrames(await collect(dec), 'buffered');

// ── network-streaming path: encoder chunks -> push() -> decoder, with a mid-stream reader ──
{
  const chunks=[];
  const streamed=await encodeClip(c=>chunks.push(c));
  if(chunks.length<2) throw new Error('onChunk: expected multiple chunks');
  const net=createDecoder(undefined, { backend:'wasm' });
  let threw=false;
  try{ await net.readFrame(); }catch{ threw=true; }
  if(!threw) throw new Error('network decoder: readFrame before metadata should throw');
  net.push(chunks[0]);
  if(!net.ready) throw new Error('network decoder: metadata should parse from header chunk');
  if(net.levels!==LEVELS) throw new Error('network decoder: quant metadata');
  // start reading before the remaining bytes arrive — exercises the wait/notify path
  const reading=(async()=>{
    const frames=[];
    while(true){ const fr=await net.readFrame(); if(!fr) break; frames.push(fr); }
    return frames;
  })();
  for(const c of chunks.slice(1)) net.push(c);
  net.finish();
  const frames=await reading;
  checkFrames(frames, 'network');
  await net.close();
  // streamed bytes and buffered readback agree on content
  const dec2=createDecoder(streamed, { backend:'wasm' });
  checkFrames(await collect(dec2), 'streamed-bytes');
}

console.log(`multi-signal wasm round-trip: ${N} frames, ${W}x${H}, levels=${LEVELS} — bit-exact codes, depth within quant step`);
console.log('all passed');
