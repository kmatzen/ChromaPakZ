// Runtime capability probes: decide whether native WebCodecs can be trusted for an
// operation, per the README §11 reality — Safari can't lossless-encode, Firefox reports
// VP9 support but color-converts on decode (so QP=0 isn't bit-exact). Only a real
// round-trip catches that, so we probe rather than sniff the UA. Each verdict is memoized
// in a module-level promise → at most one probe per page/process.

const CODEC = 'vp09.00.10.08';

function hasWebCodecs(){
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined'
    && typeof VideoFrame !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

function b64ToBytes(b64){
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
function eq(a,b){ if(a.length!==b.length) return false; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; }

// A tiny luma plane whose values span byte boundaries (stresses lossless reconstruction).
function probePlane(W,H){
  const p=new Uint8Array(W*H);
  for(let r=0;r<H;r++) for(let c=0;c<W;c++) p[r*W+c]=(c*16 + r*5) & 0xff;
  return p;
}
function lumaFrame(plane, W, H){
  const cW=W>>1, cH=H>>1, buf=new Uint8Array(W*H+2*cW*cH);
  buf.set(plane,0); buf.fill(128, W*H);
  return new VideoFrame(buf,{ format:'I420', codedWidth:W, codedHeight:H, timestamp:0,
    colorSpace:{ primaries:'bt709', transfer:'iec61966-2-1', matrix:'bt709', fullRange:true }});
}
async function readLuma(frame, W, H){
  const dst=new Uint8Array(frame.allocationSize()); const lay=await frame.copyTo(dst); const y=lay[0];
  const out=new Uint8Array(W*H);
  for(let r=0;r<H;r++) out.set(dst.subarray(y.offset+r*y.stride, y.offset+r*y.stride+W), r*W);
  return out;
}

// Encode one lossless keyframe and decode it back via WebCodecs; return the recovered Y plane.
function nativeRoundTrip(plane, W, H){
  return new Promise((resolve,reject)=>{
    let recovered=null;
    const dec=new VideoDecoder({ output:async f=>{ try{ recovered=await readLuma(f,W,H); } finally{ f.close(); } }, error:reject });
    const enc=new VideoEncoder({ output:(chunk,meta)=>{ if(meta?.decoderConfig) dec.configure(meta.decoderConfig); dec.decode(chunk); }, error:reject });
    enc.configure({ codec:CODEC, width:W, height:H, bitrateMode:'quantizer', latencyMode:'quality' });
    const fr=lumaFrame(plane,W,H); enc.encode(fr,{ keyFrame:true, vp9:{ quantizer:0 } }); fr.close();
    enc.flush().then(()=>dec.flush()).then(()=>{ enc.close(); dec.close(); resolve(recovered); }).catch(reject);
  });
}

// Decode a single pre-encoded bare VP9 frame and return the recovered Y plane.
function nativeDecodeOne(chunkBytes, W, H){
  return new Promise((resolve,reject)=>{
    let recovered=null;
    const dec=new VideoDecoder({ output:async f=>{ try{ recovered=await readLuma(f,W,H); } finally{ f.close(); } }, error:reject });
    dec.configure({ codec:CODEC, codedWidth:W, codedHeight:H });
    dec.decode(new EncodedVideoChunk({ type:'key', timestamp:0, data:chunkBytes }));
    dec.flush().then(()=>{ dec.close(); resolve(recovered); }).catch(reject);
  });
}

async function _probeEncode(lossless){
  if(!hasWebCodecs()) return false;
  const W=32, H=32, plane=probePlane(W,H);
  try{
    if(lossless){
      const rec=await nativeRoundTrip(plane,W,H);   // QP=0 must be bit-exact (catches Firefox)
      return !!rec && eq(plane,rec);
    }
    // Lossy: just confirm the config is constructible & supported.
    const sup=await VideoEncoder.isConfigSupported({ codec:CODEC, width:W, height:H, bitrate:1_000_000 });
    return !!sup?.supported;
  }catch{ return false; }
}

async function _probeDecode(){
  if(!hasWebCodecs()) return false;
  let ref;
  try{ ref=(await import('./decode-ref.js')).DECODE_REF; }
  catch{ ref=null; }
  // No baked reference → be conservative and fall back to WASM decode (always correct, if heavier).
  if(!ref) return false;
  try{
    const chunk=b64ToBytes(ref.chunkB64), expect=b64ToBytes(ref.planeB64);
    const rec=await nativeDecodeOne(chunk, ref.W, ref.H);
    return !!rec && eq(expect, rec);   // mismatch ⇒ engine color-converted (Firefox) ⇒ WASM
  }catch{ return false; }
}

const cache = new Map();
function memo(key, fn){ if(!cache.has(key)) cache.set(key, fn()); return cache.get(key); }

/** @returns {Promise<boolean>} true if native WebCodecs can losslessly/lossily encode here. */
export function probeEncode({ lossless=true }={}){
  return memo(lossless ? 'enc:lossless' : 'enc:lossy', ()=>_probeEncode(lossless));
}
/** @returns {Promise<boolean>} true if native WebCodecs decode is bit-exact here. */
export function probeDecode(){
  return memo('dec', _probeDecode);
}

/** Test hook: clear memoized verdicts. */
export function _resetProbes(){ cache.clear(); }
