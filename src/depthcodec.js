// depthcodec: RGB + bit-exact 16-bit depth in one WebM, encode+decode in-browser, no WASM.
// Depth path (proven in experiments/): inverse-depth uint16 → triangle-fold 8+8 →
// two VP9 lossless inter-coded tracks. RGB is a normal VP9 track (track 1 → legacy fallback).
import { mux, demux } from './webm.js';

const VP9 = 'vp09.00.10.08';
const FOLD_BITS = 8;

// ── quantization: float depth/disparity → uint16, precision packed by inverse-depth ──
// Code 0 is reserved for "invalid" (z<=0 / NaN). Valid codes span 1..65535.
export const LEVELS_FULL = 65536;   // full 16-bit (default); fewer levels = coarser grid

export function quantizeInverseDepth(z, near, far, levels=LEVELS_FULL){
  const M=levels-2, maxc=levels-1, out=new Uint16Array(z.length), a=1/near, b=1/far, inv=1/(a-b);
  for(let i=0;i<z.length;i++){ const v=z[i];
    if(!(v>0)) { out[i]=0; continue; }
    let q=Math.round((1/v - b)*inv*M)+1;              // map to 1..levels-1
    out[i]=q<1?1:(q>maxc?maxc:q);
  }
  return out;
}
export function dequantizeInverseDepth(d, near, far, levels=LEVELS_FULL){
  const M=levels-2, out=new Float32Array(d.length), a=1/near, b=1/far;
  for(let i=0;i<d.length;i++){ const c=d[i];
    out[i]= c===0 ? NaN : 1/(((c-1)/M)*(a-b)+b);
  }
  return out;
}

// ── triangle-fold 8+8 (reversible; keeps each 8-bit plane spatially coherent) ──
export function triFoldPack(d){ const hi=new Uint8Array(d.length), lo=new Uint8Array(d.length);
  for(let i=0;i<d.length;i++){ const h=d[i]>>FOLD_BITS, l=d[i]&0xff; hi[i]=h; lo[i]=(h&1)?(255-l):l; }
  return {hi,lo}; }
export function triFoldUnpack(hi,lo){ const d=new Uint16Array(hi.length);
  for(let i=0;i<d.length;i++){ const h=hi[i], l=(h&1)?(255-lo[i]):lo[i]; d[i]=(h<<FOLD_BITS)|l; }
  return d; }

// ── WebCodecs helpers ──
function lumaFrame(plane, W, H, tsUs){
  const cW=W>>1, cH=H>>1, buf=new Uint8Array(W*H+2*cW*cH);
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

async function encodeTrack({ srcs, makeFrame, lossless, W, H, fps, bitrate }){
  const chunks=[]; const usPerFrame=1e6/fps;
  const enc=new VideoEncoder({ output:(c)=>{ const data=new Uint8Array(c.byteLength); c.copyTo(data);
    chunks.push({ key:c.type==='key', timeMs:Math.round(c.timestamp/1000), data }); }, error:e=>{ throw e; } });
  const cfg={ codec:VP9, width:W, height:H, framerate:fps };
  if(lossless) cfg.bitrateMode='quantizer'; else cfg.bitrate=bitrate||2_000_000;
  enc.configure(cfg);
  srcs.forEach((s,i)=>{ const f=makeFrame(s, i*usPerFrame);
    enc.encode(f, lossless ? { keyFrame:i===0, vp9:{ quantizer:0 } } : { keyFrame:i===0 }); f.close(); });
  await enc.flush(); enc.close();
  return chunks;
}
function decodeTrack(track, W, H, readFn){
  return new Promise((res,rej)=>{ const out=[];
    const dec=new VideoDecoder({ output:async f=>{ try{ out.push(await readFn(f,W,H)); } finally{ f.close(); } }, error:rej });
    dec.configure({ codec:VP9, codedWidth:W, codedHeight:H });
    [...track.frames].sort((a,b)=>a.timeMs-b.timeMs).forEach(fr=>
      dec.decode(new EncodedVideoChunk({ type:fr.key?'key':'delta', timestamp:fr.timeMs*1000, data:fr.data })));
    dec.flush().then(()=>{ dec.close(); res(out); }).catch(rej);
  });
}

// ── public API ──
// rgbFrames: array of RGBA Uint8Array (W*H*4) or null. depthU16: array of Uint16Array (W*H).
// (Pass float depth through quantizeInverseDepth first, or pass {depthFloat, near, far}.)
export async function encode({ W, H, fps=30, rgbFrames=null, depthU16=null, depthFloat=null, near=0.2, far=10, levels=LEVELS_FULL }){
  if(!depthU16 && depthFloat) depthU16 = depthFloat.map(z=>quantizeInverseDepth(z, near, far, levels));
  const N = depthU16 ? depthU16.length : rgbFrames.length;
  const packed = depthU16 ? depthU16.map(triFoldPack) : null;

  const frames=[]; const tracks=[];
  if(rgbFrames){
    tracks.push({ number:1, codecID:'V_VP9', name:'rgb', width:W, height:H });
    const c=await encodeTrack({ srcs:rgbFrames, makeFrame:(s,ts)=>rgbaFrame(s,W,H,ts), lossless:false, W,H,fps });
    c.forEach(x=>frames.push({ track:1, ...x }));
  }
  if(packed){
    tracks.push({ number:2, codecID:'V_VP9', name:'depth-hi', width:W, height:H });
    tracks.push({ number:3, codecID:'V_VP9', name:'depth-lo', width:W, height:H });
    const chi=await encodeTrack({ srcs:packed.map(p=>p.hi), makeFrame:(s,ts)=>lumaFrame(s,W,H,ts), lossless:true, W,H,fps });
    const clo=await encodeTrack({ srcs:packed.map(p=>p.lo), makeFrame:(s,ts)=>lumaFrame(s,W,H,ts), lossless:true, W,H,fps });
    chi.forEach(x=>frames.push({ track:2, ...x })); clo.forEach(x=>frames.push({ track:3, ...x }));
  }
  const metadata={ version:1, width:W, height:H, fps, frames:N,
    rgb: rgbFrames ? { track:1, codec:VP9 } : null,
    depth: packed ? { trackHi:2, trackLo:3, codec:VP9, lossless:true, scheme:'tri-fold-8+8',
      quant:'inverse-depth', near, far, levels, invalidCode:0, dtype:'uint16' } : null };
  return mux({ tracks, frames, metadata });
}

export async function decode(bytes){
  const { tracks, metadata } = demux(bytes);
  const W=metadata.width, H=metadata.height;
  const result={ metadata, width:W, height:H, rgb:null, depthU16:null, depthFloat:null };
  if(metadata.rgb) result.rgb = await decodeTrack(tracks[metadata.rgb.track], W, H, readRGBA);
  if(metadata.depth){
    const hi = await decodeTrack(tracks[metadata.depth.trackHi], W, H, readLuma);
    const lo = await decodeTrack(tracks[metadata.depth.trackLo], W, H, readLuma);
    result.depthU16 = hi.map((h,i)=>triFoldUnpack(h, lo[i]));
    const lv = metadata.depth.levels ?? LEVELS_FULL;
    result.depthFloat = result.depthU16.map(d=>dequantizeInverseDepth(d, metadata.depth.near, metadata.depth.far, lv));
  }
  return result;
}
