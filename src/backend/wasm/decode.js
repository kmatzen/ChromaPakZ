// WASM decode backend: drives the libvpx VP9 decoder (vp9-decode.wasm) behind the same
// track-codec interface as src/backend/webcodecs.js, so chromapakz.js can swap them freely.
// This module (and its .wasm) is only ever imported when src/backend/select.js decides native
// WebCodecs decode is untrustworthy — a bundler keeps it in its own chunk, so a browser that
// decodes natively never downloads it, and one that decodes here never pulls the encoder.
import Module from './vp9-decode.js';

let modP = null;
const getModule = () => (modP ??= Module());

export const id = 'wasm-decode';

export function createTrackDecoder({ kind='luma', W, H }){
  const cKind = kind==='rgba' ? 1 : 0;
  let mod=null, handle=0, lenPtr=0, closed=false;
  const pending=[];   // raw chunks pushed but not yet decoded
  const planes=[];    // decoded planes ready to hand back

  async function ensure(){
    if(mod) return;
    mod = await getModule();
    handle = mod._dcvp9_dec_new(W, H, cKind);
    if(!handle) throw new Error('dcvp9_dec_new failed');
    lenPtr = mod._malloc(4);
  }
  function drainPlanes(){
    for(;;){
      const ptr = mod._dcvp9_dec_next(handle, lenPtr);
      if(!ptr) break;
      const len = mod.HEAP32[lenPtr>>2];
      planes.push(mod.HEAPU8.slice(ptr, ptr+len));   // copy off the heap
    }
  }
  async function decodePending(){
    if(!pending.length) return;
    await ensure();
    for(const fr of pending.splice(0)){
      const inPtr = mod._malloc(fr.data.length);
      mod.HEAPU8.set(fr.data, inPtr);
      const rc = mod._dcvp9_dec_decode(handle, inPtr, fr.data.length);
      mod._free(inPtr);
      if(rc) throw new Error('vp9 wasm decode failed (rc='+rc+')');
    }
    drainPlanes();
  }

  return {
    push(fr){
      if(closed) throw new Error('track decoder closed');
      pending.push(fr);
    },
    async next(){
      if(planes.length) return planes.shift();
      await decodePending();
      return planes.length ? planes.shift() : null;
    },
    async close(){
      if(closed) return;
      await decodePending();
      if(handle){ mod._dcvp9_dec_flush(handle); drainPlanes(); }
      closed=true;
      if(handle){ mod._dcvp9_dec_free(handle); handle=0; mod._free(lenPtr); }
    },
  };
}
