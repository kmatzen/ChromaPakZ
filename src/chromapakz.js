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

function createTrackEncoder({ makeFrame, lossless, W, H, fps, bitrate, keyEvery=Infinity }){
  let i=0; const usPerFrame=1e6/fps; const outQ=[]; let waitOut=null;
  const enc=new VideoEncoder({ output:(c)=>{ const data=new Uint8Array(c.byteLength); c.copyTo(data);
    const chunk={ key:c.type==='key', timeMs:Math.round(c.timestamp/1000), data };
    if(waitOut){ const w=waitOut; waitOut=null; w(chunk); } else outQ.push(chunk);
  }, error:e=>{ throw e; } });
  const cfg={ codec:'vp09.00.10.08', width:W, height:H, framerate:fps };
  if(lossless) cfg.bitrateMode='quantizer'; else cfg.bitrate=bitrate||2_000_000;
  enc.configure(cfg);
  return {
    async push(src){
      const f=makeFrame(src, i*usPerFrame); const isKey=i===0 || i%keyEvery===0;
      enc.encode(f, lossless ? { keyFrame:i===0, vp9:{ quantizer:0 } } : { keyFrame:isKey }); f.close(); i++;
      if(outQ.length) return outQ.shift();
      return new Promise(res=>{ waitOut=res; });
    },
    async close(){
      await enc.flush(); enc.close();
      const rest=outQ.splice(0);
      if(waitOut){ const w=waitOut; waitOut=null; if(rest.length) w(rest.shift()); else w(null); }
      return rest;
    },
  };
}

function createTrackDecoder(W, H, readFn){
  const queue=[]; let wait=null, err=null, closed=false;
  const dec=new VideoDecoder({ output:async f=>{ try{
    queue.push(await readFn(f,W,H));
    if(wait){ const w=wait; wait=null; w(); }
  } finally{ f.close(); } }, error:e=>{ err=e; if(wait){ const w=wait; wait=null; w(); } } });
  dec.configure({ codec:'vp09.00.10.08', codedWidth:W, codedHeight:H });
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
      await new Promise(res=>{ wait=res; });
      if(err) throw err;
      return queue.length ? queue.shift() : null;
    },
    async close(){ await dec.flush(); dec.close(); closed=true;
      if(wait){ wait(); wait=null; } },
  };
}

function resolveSignalSpecs(signals){
  if(!signals?.length) throw new Error('createEncoder: signals[] required');
  return signals;
}

function makeFrameReader({ meta, W, H, blocks }){
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

      if(slot.rgb){
        if(!rgbDec.dec) rgbDec.dec=createTrackDecoder(W,H,readRGBA);
        rgbDec.dec.push(slot.rgb);
        out.rgb=await rgbDec.dec.next();
      }

      for(const s of signals){
        const hiKey=`${s.id}:hi`, loKey=`${s.id}:lo`;
        if(!slot[hiKey]) continue;
        if(!sigDec[s.id]) sigDec[s.id]={ hi: createTrackDecoder(W,H,readLuma), lo: createTrackDecoder(W,H,readLuma) };
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
export function createEncoder({ W, H, fps=30, signals, rgbKbps=2_000_000, onChunk=null }){
  const specList=resolveSignalSpecs(signals);
  let n=0, hasRgb=false;
  let signalPlan=null;
  let rgbEnc=null;
  const sigEnc={}; // id → { hi, lo }
  let streamMux=null, byteParts=null;
  const muxFrames=[];
  const rgbKeyEvery=Math.max(1, Math.round(fps));

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

  function getSigEnc(id){
    if(!sigEnc[id]){
      sigEnc[id]={
        hi: createTrackEncoder({ makeFrame:(s,ts)=>lumaFrame(s,W,H,ts), lossless:true, W,H,fps }),
        lo: createTrackEncoder({ makeFrame:(s,ts)=>lumaFrame(s,W,H,ts), lossless:true, W,H,fps }),
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
        if(!rgbEnc) rgbEnc=createTrackEncoder({ makeFrame:(s,ts)=>rgbaFrame(s,W,H,ts), lossless:false,
          W,H,fps, bitrate:rgbKbps, keyEvery:rgbKeyEvery });
        hasRgb=true;
      }
      ensurePlan();
      const inputs=collectFrameInputs(frame, signalPlan);
      let anySignal=false;
      for(const s of signalPlan){
        const u16=u16FromFramePayload(inputs[s.id], s);
        if(!u16) continue;
        anySignal=true;
        const enc=getSigEnc(s.id);
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
export function createDecoder(bytes){
  if(bytes!==undefined) return createDecoderFromBytes(bytes);
  return createNetworkDecoder();
}

function createDecoderFromBytes(bytes){
  const { tracks, metadata:raw }=demux(bytes);
  const meta=normalizeMetadata(raw);
  const W=meta.width, H=meta.height;
  const blocks=blocksByTime(tracks, meta);
  const core=makeFrameReader({ meta, W, H, blocks });
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

function createNetworkDecoder(){
  const sdm=createStreamDemux();
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
      if(!core && blockQueue.length) core=makeFrameReader({ meta, W, H, blocks:blockQueue });
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

export async function decode(bytes){
  const dec=createDecoder(bytes);
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
