// chromapakz: RGB + bit-exact lossless signals in one WebM (depth, object IDs, normals, …).
// API reference: docs/API.md
import { mux, demux, createStreamMux, createStreamDemux, concatChunks } from './webm.js';
import {
  LEVELS_FULL,
  quantizeInverseDepth,
  dequantizeInverseDepth,
  autoNearFar,
  triFoldPack,
  triFoldUnpack,
} from './chromapakz-core.js';
import {
  planSignals,
  buildTracksFromPlan,
  buildFileMetadata,
  normalizeMetadata,
  u16FromFramePayload,
  materializeSignal,
  blocksByTime,
  slotKeysForMetadata,
  isSlotComplete,
  collectFrameInputs,
  SIGNAL_DEPTH,
  SIGNAL_RAW_U16,
} from './signals.js';
import { pickEncoderBackend, pickDecoderBackend } from './backend/select.js';

export {
  LEVELS_FULL,
  quantizeInverseDepth,
  dequantizeInverseDepth,
  autoNearFar,
  triFoldPack,
  triFoldUnpack,
  SIGNAL_DEPTH,
  SIGNAL_RAW_U16,
};

// ── codec backends ──
// All VP9 frame encode/decode goes through a pluggable backend (native WebCodecs or a WASM
// libvpx fallback), selected per operation by src/backend/select.js. Tracks are described by
// `kind`: 'luma' (8-bit Y plane, lossless for signals) or 'rgba' (lossy preview RGB).

function resolveSignalSpecs(signals){
  if(!signals?.length) throw new Error('createEncoder: signals[] required');
  return signals;
}

function makeFrameReader({ meta, W, H, blocks, getBackend }){
  let i=0, shut=false;
  const rgbDec={};
  const sigDec={}; // id → { hi, lo }
  const signals=meta.signals;

  return {
    get frameCount(){ return blocks.length; },
    get meta(){ return meta; },

    async readFrame(){
      if(shut) throw new Error('decoder closed');
      if(i>=blocks.length) return null;
      const slot=blocks[i++];
      const out={ rgb: null, signals: {} };
      const be=await getBackend();

      if(slot.rgb){
        if(!rgbDec.dec) rgbDec.dec=be.createTrackDecoder({ kind:'rgba', W, H });
        rgbDec.dec.push(slot.rgb);
        out.rgb=await rgbDec.dec.next();
      }

      for(const s of signals){
        const hiKey=`${s.id}:hi`, loKey=`${s.id}:lo`;
        if(!slot[hiKey]) continue;
        if(!sigDec[s.id]) sigDec[s.id]={ hi: be.createTrackDecoder({ kind:'luma', W, H }), lo: be.createTrackDecoder({ kind:'luma', W, H }) };
        sigDec[s.id].hi.push(slot[hiKey]);
        sigDec[s.id].lo.push(slot[loKey]);
        const hi=await sigDec[s.id].hi.next();
        const lo=await sigDec[s.id].lo.next();
        if(hi && lo) out.signals[s.id]=materializeSignal(triFoldUnpack(hi, lo), s);
      }
      return out;
    },

    async close(){
      if(shut) return;
      shut=true;
      if(rgbDec.dec) await rgbDec.dec.close();
      for(const d of Object.values(sigDec)){
        if(d.hi) await d.hi.close();
        if(d.lo) await d.lo.close();
      }
    },

    [Symbol.asyncIterator](){
      const self=this;
      return { async next(){
        const frame=await self.readFrame();
        return frame ? { value:frame, done:false } : { done:true };
      }};
    },
  };
}

// ── streaming encode ──
/**
 * @param signals — e.g. [{ id:'depth', near, far }, { id:'objectId' }]
 */
export function createEncoder({ W, H, fps=30, signals, rgbKbps=2_000_000, onChunk=null, backend='auto' }){
  const specList=resolveSignalSpecs(signals);
  let n=0, hasRgb=false;
  let signalPlan=null;
  let rgbEnc=null;
  const sigEnc={}; // id → { hi, lo }
  let streamMux=null, byteParts=null;
  const muxFrames=[];
  const rgbKeyEvery=Math.max(1, Math.round(fps));

  // Backends are picked once per encoder, lazily, on first frame. Lossless (signals) and
  // lossy (rgb) probe independently — a browser may have native lossy but need WASM lossless.
  let losslessBackendP=null, lossyBackendP=null;
  const losslessBackend=()=> losslessBackendP ??= pickEncoderBackend({ lossless:true, force:backend });
  const lossyBackend=()=> lossyBackendP ??= pickEncoderBackend({ lossless:false, force:backend });

  function ensurePlan(){
    if(signalPlan) return;
    signalPlan=planSignals(specList, hasRgb);
  }

  function ensureStreamMux(){
    if(streamMux) return;
    ensurePlan();
    const tracks=buildTracksFromPlan(W, H, hasRgb, signalPlan);
    const metadata=buildFileMetadata({ W, H, fps, n:0, hasRgb, signals: signalPlan, streaming:true });
    streamMux=createStreamMux({ tracks, metadata, durationMs:0 });
    byteParts=[streamMux.header];
    if(onChunk) onChunk(streamMux.header);
  }

  async function getSigEnc(id){
    if(!sigEnc[id]){
      const be=await losslessBackend();
      sigEnc[id]={
        hi: be.createTrackEncoder({ kind:'luma', lossless:true, W, H, fps }),
        lo: be.createTrackEncoder({ kind:'luma', lossless:true, W, H, fps }),
      };
    }
    return sigEnc[id];
  }

  function emitMuxFrames(writes){
    if(!streamMux) return;
    for(const f of writes.sort((a,b)=>a.timeMs-b.timeMs || a.track-b.track)){
      const c=streamMux.writeFrame(f);
      if(c){ byteParts.push(c); if(onChunk) onChunk(c); }
    }
  }

  const depthSig=()=>signalPlan?.find(s=>s.id==='depth');

  return {
    get signalPlan(){ ensurePlan(); return signalPlan; },
    get near(){ return depthSig()?.quant?.near; },
    get far(){ return depthSig()?.quant?.far; },
    get frameCount(){ return n; },

    setNearFar(near_, far_){
      const d=specList.find(s=>(s.id ?? 'depth')==='depth');
      const qType=d?.quant?.type ?? (d?.near !== undefined ? 'inverse-depth' : null);
      if(!d || qType !== 'inverse-depth')
        throw new Error('no inverse-depth signal configured');
      if(d.quant) { d.quant.near=near_; d.quant.far=far_; }
      else { d.near=near_; d.far=far_; }
      signalPlan=null;
    },

    async addFrame(frame){
      const writes=[];
      if(frame.rgb){
        if(!rgbEnc){ const be=await lossyBackend();
          rgbEnc=be.createTrackEncoder({ kind:'rgba', lossless:false, W, H, fps, bitrate:rgbKbps, keyEvery:rgbKeyEvery }); }
        hasRgb=true;
      }
      ensurePlan();
      const inputs=collectFrameInputs(frame, signalPlan);
      let anySignal=false;
      for(const s of signalPlan){
        const u16=u16FromFramePayload(inputs[s.id], s);
        if(!u16) continue;
        anySignal=true;
        const enc=await getSigEnc(s.id);
        const { hi, lo }=triFoldPack(u16);
        const chi=await enc.hi.push(hi), clo=await enc.lo.push(lo);
        writes.push({ track:s.tracks.hi, ...chi }, { track:s.tracks.lo, ...clo });
      }
      if(!frame.rgb && !anySignal) throw new Error('addFrame: pass rgb and/or signals');
      if(onChunk) ensureStreamMux();

      if(frame.rgb){
        const c=await rgbEnc.push(frame.rgb);
        writes.push({ track:1, ...c });
      }
      if(onChunk) emitMuxFrames(writes);
      else muxFrames.push(...writes);
      n++;
    },

    async finish(){
      if(!n) throw new Error('no frames encoded');
      ensurePlan();
      if(onChunk){
        ensureStreamMux();
        const tailWrites=[];
        if(hasRgb) (await rgbEnc.close()).forEach(c=>tailWrites.push({ track:1, ...c }));
        for(const s of signalPlan){
          if(!sigEnc[s.id]) continue;
          (await sigEnc[s.id].hi.close()).forEach(c=>tailWrites.push({ track:s.tracks.hi, ...c }));
          (await sigEnc[s.id].lo.close()).forEach(c=>tailWrites.push({ track:s.tracks.lo, ...c }));
        }
        emitMuxFrames(tailWrites);
        const tail=streamMux.finish(Math.round(n*1000/fps));
        if(tail.length){ byteParts.push(tail); onChunk(tail); }
        return concatChunks(byteParts);
      }
      if(hasRgb) await rgbEnc.close();
      for(const s of signalPlan){ if(sigEnc[s.id]){ await sigEnc[s.id].hi.close(); await sigEnc[s.id].lo.close(); } }
      const tracks=buildTracksFromPlan(W, H, hasRgb, signalPlan);
      const metadata=buildFileMetadata({ W, H, fps, n, hasRgb, signals: signalPlan });
      return mux({ tracks, frames:muxFrames, metadata, durationMs: Math.round(n*1000/fps) });
    },
  };
}

export async function encode({ W, H, fps=30, signals, frames, rgbKbps=2_000_000, onChunk=null }){
  if(!signals?.length) throw new Error('encode: signals[] required');
  if(!frames?.length) throw new Error('encode: frames[] required');
  const enc=createEncoder({ W, H, fps, signals, rgbKbps, onChunk });
  for(const fr of frames) await enc.addFrame(fr);
  return enc.finish();
}

// ── streaming decode ──
export function createDecoder(bytes, opts={}){
  if(bytes!==undefined) return createDecoderFromBytes(bytes, opts);
  return createNetworkDecoder(opts);
}

// Memoized decoder backend, shared across all tracks of one decoder (probes at most once).
function decoderBackendGetter(force){
  let p=null;
  return ()=> p ??= pickDecoderBackend({ force });
}

function createDecoderFromBytes(bytes, { backend='auto' }={}){
  const { tracks, metadata:raw }=demux(bytes);
  const meta=normalizeMetadata(raw);
  const W=meta.width, H=meta.height;
  const blocks=blocksByTime(tracks, meta);
  const core=makeFrameReader({ meta, W, H, blocks, getBackend: decoderBackendGetter(backend) });
  const depth=meta.signals.find(s=>s.id==='depth');
  return {
    get metadata(){ return meta; },
    get signals(){ return meta.signals; },
    get width(){ return W; },
    get height(){ return H; },
    get near(){ return depth?.quant?.near; },
    get far(){ return depth?.quant?.far; },
    get levels(){ return depth?.quant?.levels ?? LEVELS_FULL; },
    get frameCount(){ return core.frameCount; },
    readFrame:()=>core.readFrame(),
    close:()=>core.close(),
    [Symbol.asyncIterator]:()=>core[Symbol.asyncIterator](),
    push(){ throw new Error('buffered decoder: pass bytes to createDecoder(), not push()'); },
    finish(){ throw new Error('buffered decoder: already complete'); },
  };
}

function createNetworkDecoder({ backend='auto' }={}){
  const sdm=createStreamDemux();
  const getBackend=decoderBackendGetter(backend);
  let meta=null, W=0, H=0, keys=null;
  const slotPending=new Map();
  const blockQueue=[];
  let streamDone=false, shut=false;
  let core=null, waitBlock=null;

  function notify(){ if(waitBlock){ const w=waitBlock; waitBlock=null; w(); } }

  function onBlock(block){
    if(!meta) return;
    const rgbT=meta.rgb?.track;
    let key=null;
    if(block.track===rgbT) key='rgb';
    else{
      for(const s of meta.signals){
        if(block.track===s.tracks.hi) key=`${s.id}:hi`;
        else if(block.track===s.tracks.lo) key=`${s.id}:lo`;
      }
    }
    if(!key) return;
    let slot=slotPending.get(block.timeMs);
    if(!slot){ slot={ timeMs:block.timeMs }; slotPending.set(block.timeMs, slot); }
    slot[key]=block;
    if(isSlotComplete(slot, keys)){
      blockQueue.push(slot);
      slotPending.delete(block.timeMs);
      notify();
    }
  }

  function ingest(events){
    for(const ev of events){
      if(ev.type==='metadata'){
        meta=normalizeMetadata(ev.metadata);
        W=meta.width; H=meta.height;
        keys=slotKeysForMetadata(meta);
      }else if(ev.type==='block') onBlock(ev.block);
      else if(ev.type==='end'){ streamDone=true; notify(); }
    }
  }

  const depth=()=>meta?.signals.find(s=>s.id==='depth');

  return {
    get metadata(){ return meta; },
    get signals(){ return meta?.signals ?? []; },
    get width(){ return W; },
    get height(){ return H; },
    get near(){ return depth()?.quant?.near; },
    get far(){ return depth()?.quant?.far; },
    get levels(){ return depth()?.quant?.levels ?? LEVELS_FULL; },
    get frameCount(){ return meta?.frames ?? blockQueue.length; },
    get ready(){ return !!meta; },

    push(chunk){ ingest(sdm.push(chunk)); },
    finish(){ ingest(sdm.finish()); streamDone=true; notify(); },

    async readFrame(){
      if(shut) throw new Error('decoder closed');
      if(!meta) throw new Error('waiting for metadata');
      while(!core && blockQueue.length===0){
        if(streamDone) return null;
        await new Promise(res=>{ waitBlock=res; });
      }
      if(!core && blockQueue.length) core=makeFrameReader({ meta, W, H, blocks:blockQueue, getBackend });
      if(!core) return null;
      return core.readFrame();
    },

    async close(){
      if(shut) return;
      shut=true; notify();
      if(core) await core.close();
    },

    [Symbol.asyncIterator](){
      const self=this;
      return { async next(){
        const frame=await self.readFrame();
        return frame ? { value:frame, done:false } : { done:true };
      }};
    },
  };
}

export async function decode(bytes, opts={}){
  const dec=createDecoder(bytes, opts);
  const rgb=[], signalSeries={};
  for await (const frame of dec){
    if(frame.rgb) rgb.push(frame.rgb);
    for(const [id, sig] of Object.entries(frame.signals ?? {})){
      if(!signalSeries[id]) signalSeries[id]=[];
      signalSeries[id].push(sig);
    }
  }
  await dec.close();
  return { metadata:dec.metadata, width:dec.width, height:dec.height, signals:dec.signals,
    rgb: rgb.length ? rgb : null,
    signalSeries: Object.keys(signalSeries).length ? signalSeries : null };
}

export { createStreamMux, createStreamDemux, concatChunks } from './webm.js';
export { normalizeMetadata, planSignals } from './signals.js';
