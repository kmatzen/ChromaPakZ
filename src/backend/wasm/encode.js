// WASM encode backend: drives the libvpx VP9 encoder (vp9-encode.wasm) behind the same
// track-codec interface as src/backend/webcodecs.js. Only imported when src/backend/select.js
// finds native WebCodecs can't losslessly encode here (e.g. Safari/WebKit). Kept in its own
// bundler chunk so it (and its ~4x-larger .wasm) never loads on decode-only sessions.
import Module from './vp9-encode.js';

let modP = null;
const getModule = () => (modP ??= Module());

export const id = 'wasm-encode';

export function createTrackEncoder({ kind='luma', lossless, W, H, fps, bitrate, keyEvery=Infinity }){
  const cKind = kind==='rgba' ? 1 : 0;
  const kbps = Math.max(1, Math.round((bitrate||2_000_000)/1000));   // bitrate is bps; C wants kbps
  const keyEveryC = Number.isFinite(keyEvery) ? keyEvery : 0;        // 0 ⇒ keyframe on frame 0 only
  const planeBytes = cKind ? W*H*4 : W*H;
  let mod=null, handle=0, inPtr=0, lenPtr=0, keyPtr=0, tsPtr=0, closed=false, readyP=null;

  // Memoized on the promise: guarding with `if(mod) return` lets concurrent push()es all get past
  // the check before any of them assigns, so each would allocate its own libvpx encoder and heap
  // buffers and clobber `handle`/`inPtr`. close() frees only the survivor, leaking the rest.
  function ensure(){
    return readyP ??= (async()=>{
      const m = await getModule();
      const h = m._dcvp9_enc_new(W, H, fps, cKind, kbps, keyEveryC);
      if(!h) throw new Error('dcvp9_enc_new failed');
      mod = m; handle = h;
      inPtr = m._malloc(planeBytes);
      lenPtr = m._malloc(4); keyPtr = m._malloc(4); tsPtr = m._malloc(4);
    })();
  }
  function pullOne(){
    const ptr = mod._dcvp9_enc_next(handle, lenPtr, keyPtr, tsPtr);
    if(!ptr) return null;
    const len = mod.HEAP32[lenPtr>>2];
    return { key: !!mod.HEAP32[keyPtr>>2], timeMs: mod.HEAP32[tsPtr>>2], data: mod.HEAPU8.slice(ptr, ptr+len) };
  }

  return {
    async push(src){
      // HEAPU8 is the whole WASM heap, so .set() copies src.length bytes with no bound of its own:
      // an oversized plane would scribble past the inPtr allocation over live libvpx state, an
      // undersized one would encode stale heap bytes. Both are caller bugs — refuse them here.
      if(src.length!==planeBytes)
        throw new Error(`wasm encode: ${kind} plane has ${src.length} bytes, expected ${planeBytes} (${W}x${H})`);
      await ensure();
      mod.HEAPU8.set(src, inPtr);
      const rc = mod._dcvp9_enc_encode(handle, inPtr, 0);
      if(rc) throw new Error('vp9 wasm encode failed (rc='+rc+')');
      return pullOne();   // g_lag_in_frames=0 ⇒ exactly one packet per encoded frame
    },
    async close(){
      if(closed) return [];
      closed=true;
      const rest=[];
      if(handle){
        mod._dcvp9_enc_flush(handle);
        let p; while((p=pullOne())) rest.push(p);
        mod._dcvp9_enc_free(handle); handle=0;
        mod._free(inPtr); mod._free(lenPtr); mod._free(keyPtr); mod._free(tsPtr);
      }
      return rest;
    },
  };
}
