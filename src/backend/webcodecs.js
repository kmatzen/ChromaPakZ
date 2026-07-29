// WebCodecs codec backend: drives VideoEncoder/VideoDecoder over single planes.
// Implements the track-codec interface consumed by chromapakz.js. The WASM backend
// (./wasm/encode.js, ./wasm/decode.js) exposes the same shape so the two are swappable.
//
// chunk = { key:boolean, timeMs:number, data:Uint8Array }   (raw VP9 frame bytes)
// A track is one of:
//   kind:'luma' — an 8-bit Y plane (W*H), chroma filled 128. Lossless (QP=0) for signals.
//   kind:'rgba' — RGBA (W*H*4). Lossy (bitrate) for the optional preview RGB track.

import { encoderConfig, decoderConfig } from './codec-config.js';

export const id = 'webcodecs';

// ── frame in/out helpers ──
function lumaFrame(plane, W, H, tsUs){
  const cW=(W+1)>>1, cH=(H+1)>>1, buf=new Uint8Array(W*H+2*cW*cH);  // I420 chroma is ceil(W/2)×ceil(H/2)
  buf.set(plane,0); buf.fill(128, W*H);
  return new VideoFrame(buf,{ format:'I420', codedWidth:W, codedHeight:H, timestamp:tsUs,
    colorSpace:{ primaries:'bt709', transfer:'iec61966-2-1', matrix:'bt709', fullRange:true }});
}
function rgbaFrame(rgba, W, H, tsUs){
  return new VideoFrame(rgba,{ format:'RGBA', codedWidth:W, codedHeight:H, timestamp:tsUs });
}
async function readLuma(frame, W, H){
  const dst=new Uint8Array(frame.allocationSize()); const lay=await frame.copyTo(dst); const y=lay[0];
  const out=new Uint8Array(W*H);
  for(let r=0;r<H;r++) out.set(dst.subarray(y.offset+r*y.stride, y.offset+r*y.stride+W), r*W);
  return out;
}
async function readRGBA(frame, W, H){
  const opts={format:'RGBA'}; const buf=new Uint8Array(frame.allocationSize(opts)); await frame.copyTo(buf,opts);
  return buf;
}

const makeFrameFor = (kind) => kind==='rgba' ? rgbaFrame : lumaFrame;
const readFnFor    = (kind) => kind==='rgba' ? readRGBA  : readLuma;

export function createTrackEncoder({ kind='luma', lossless, W, H, fps, bitrate, keyEvery=Infinity }){
  const makeFrame=makeFrameFor(kind);
  const planeBytes=kind==='rgba' ? W*H*4 : W*H;
  // waitOut is a *queue*: a single slot would be overwritten by a second push() issued before the
  // first one's chunk arrives, leaving the first push()'s promise unresolved forever (a hang) and
  // handing the first chunk to the wrong caller.
  let i=0; const usPerFrame=1e6/fps; const outQ=[]; const waitOut=[];
  let err=null, closed=false;
  // Stash-and-reject, mirroring the decoder below. Throwing from the async error callback would
  // surface as an unhandled exception and leave every pending push() promise unresolved — an
  // encode that hangs rather than one that reports what went wrong.
  const fail=e=>{ err ??= (e instanceof Error ? e : new Error(String(e)));
    while(waitOut.length) waitOut.shift().rej(err); };
  const enc=new VideoEncoder({ output:(c)=>{ const data=new Uint8Array(c.byteLength); c.copyTo(data);
    const chunk={ key:c.type==='key', timeMs:Math.round(c.timestamp/1000), data };
    if(waitOut.length) waitOut.shift().res(chunk); else outQ.push(chunk);
  }, error:fail });
  enc.configure(encoderConfig({ lossless, W, H, fps, bitrate }));
  return {
    async push(src){
      if(err) throw err;
      if(closed) throw new Error('track encoder closed');
      // Mirrors the WASM backend's check so both report the same error: a short luma plane would
      // otherwise silently encode zero-filled rows, and an oversized one would overwrite the
      // chroma half of the I420 buffer. rgba reaches VideoFrame as raw bytes (any BufferSource);
      // luma is copied element-wise into the I420 buffer, so there src.length is the bound.
      const n=kind==='rgba' ? (src.byteLength ?? src.length) : src.length;
      if(n!==planeBytes)
        throw new Error(`webcodecs encode: ${kind} plane has ${n} bytes, expected ${planeBytes} (${W}x${H})`);
      const f=makeFrame(src, W, H, i*usPerFrame); const isKey=i===0 || i%keyEvery===0;
      enc.encode(f, lossless ? { keyFrame:i===0, vp9:{ quantizer:0 } } : { keyFrame:isKey }); f.close(); i++;
      if(outQ.length) return outQ.shift();
      let settled=false;
      const p=new Promise((res,rej)=>{ waitOut.push({ res, rej }); })
        .finally(()=>{ settled=true; });
      // This interface is one chunk per frame (the WASM backend pins lag_in_frames=0 to match).
      // An encoder that buffers instead — lag > 0 — would emit nothing until something drains it,
      // so if the chunk hasn't arrived by the next turn, drain it. flush() is a no-op when the
      // encoder is already caught up, and does not reset codec state or force a keyframe.
      setTimeout(()=>{ if(!settled && !err && !closed) enc.flush().catch(fail); }, 0);
      return p;
    },
    async close(){
      if(closed) return [];
      closed=true;
      if(err) throw err;
      try{ await enc.flush(); }catch(e){ fail(e); }
      if(enc.state!=='closed') enc.close();
      if(err) throw err;
      const rest=outQ.splice(0);
      while(waitOut.length) waitOut.shift().res(rest.length ? rest.shift() : null);
      return rest;
    },
  };
}

export function createTrackDecoder({ kind='luma', W, H }){
  const readFn=readFnFor(kind);
  // `wait` is a queue for the same reason as the encoder's waitOut: a lone slot loses every
  // waiter but the last when next() is called more than once before output arrives.
  const queue=[]; const wait=[]; let err=null, closed=false;
  const wake=()=>{ while(wait.length) wait.shift()(); };
  const dec=new VideoDecoder({ output:async f=>{ try{
    queue.push(await readFn(f,W,H));
    wake();
  } finally{ f.close(); } }, error:e=>{ err=e; wake(); } });
  dec.configure(decoderConfig({ W, H }));
  return {
    push(fr){
      if(err) throw err;
      if(closed) throw new Error('track decoder closed');
      dec.decode(new EncodedVideoChunk({ type:fr.key?'key':'delta', timestamp:fr.timeMs*1000, data:fr.data }));
    },
    async next(){
      if(err) throw err;
      if(queue.length) return queue.shift();
      if(closed) return null;
      await new Promise(res=>{ wait.push(res); });
      if(err) throw err;
      return queue.length ? queue.shift() : null;
    },
    async close(){ await dec.flush(); dec.close(); closed=true; wake(); },
  };
}
