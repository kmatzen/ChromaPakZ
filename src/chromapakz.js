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
  planRgbs,
  normalizeRgbSpecs,
  buildTracksFromPlan,
  buildFileMetadata,
  normalizeMetadata,
  u16FromFramePayload,
  materializeSignal,
  blocksByTime,
  slotKeysForMetadata,
  isSlotComplete,
  slotHasContent,
  collectFrameInputs,
  rgbSlotKey,
  DEFAULT_RGB_ID,
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
  const rgbDec={}; // rgb stream id → decoder
  const sigDec={}; // signal id → { hi, lo }
  const signals=meta.signals;

  // readFrame() claims a slot, pushes into stateful VP9 decoders and awaits their output, so
  // overlapping calls interleave pushes and returns against a decoder that must see frames in
  // order. (Unlike the encoder's getSigEnc, the lazy decoder construction below is safe — it
  // happens synchronously after the shared getBackend() await — but the push/next interleaving
  // is not.) Serializing in call order also makes concurrent readFrame()s resolve in that order.
  let opQueue=Promise.resolve();
  function serialize(fn){
    const run=opQueue.then(fn, fn);
    opQueue=run.then(()=>{}, ()=>{});
    return run;
  }

  async function readFrameImpl(){
    if(shut) throw new Error('decoder closed');
    if(i>=blocks.length) return null;
    const slot=blocks[i++];
    const out={ rgb: null, rgbs: {}, signals: {} };
    const be=await getBackend();

    for(const r of meta.rgbs){
      const block=slot[rgbSlotKey(r.id)];
      if(!block) continue;
      if(!rgbDec[r.id]) rgbDec[r.id]=be.createTrackDecoder({ kind:'rgba', W, H });
      rgbDec[r.id].push(block);
      const plane=await rgbDec[r.id].next();
      if(plane) out.rgbs[r.id]=plane;
    }
    // Legacy field: the primary stream (rgbs[0]), exactly what pre-multi-RGB callers read.
    if(meta.rgbs.length) out.rgb=out.rgbs[meta.rgbs[0].id] ?? null;

    for(const s of signals){
      const hiKey=`${s.id}:hi`, loKey=`${s.id}:lo`;
      // A slot may legitimately carry no plane for this signal (rgb-only frames), and a truncated
      // or corrupt file may carry hi without lo — both skip, rather than pushing undefined at a
      // decoder that would then desync every later frame on the track.
      if(!slot[hiKey] || !slot[loKey]) continue;
      if(!sigDec[s.id]) sigDec[s.id]={ hi: be.createTrackDecoder({ kind:'luma', W, H }), lo: be.createTrackDecoder({ kind:'luma', W, H }) };
      sigDec[s.id].hi.push(slot[hiKey]);
      sigDec[s.id].lo.push(slot[loKey]);
      const hi=await sigDec[s.id].hi.next();
      const lo=await sigDec[s.id].lo.next();
      if(hi && lo) out.signals[s.id]=materializeSignal(triFoldUnpack(hi, lo), s);
    }
    return out;
  }

  return {
    get frameCount(){ return blocks.length; },
    get meta(){ return meta; },

    readFrame(){ return serialize(readFrameImpl); },

    async close(){
      if(shut) return;
      shut=true;
      for(const d of Object.values(rgbDec)) await d.close();
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
 * @param hasRgb — declare a single default RGB stream up front (true/false). Left null (and with
 *   no `rgbs`), it is inferred from the first frame; a clip whose RGB starts later than frame 0
 *   must declare it, because track numbers are frozen with the plan (see planSignals).
 * @param rgbs — declare multiple RGB streams (stereo / multi-camera): an array of stream ids or
 *   `{ id, kbps? }` entries, order fixing track numbers. Mutually exclusive with hasRgb. Frames
 *   then carry `rgbs: { id: plane }` (`rgb:` stays sugar for the first stream).
 */
export function createEncoder({ W, H, fps=30, signals, rgbKbps=2_000_000, onChunk=null, backend='auto', hasRgb=null, rgbs=null, textTrack=null }){
  const specList=resolveSignalSpecs(signals);
  if(hasRgb!==null && typeof hasRgb!=='boolean')
    throw new Error('createEncoder: hasRgb must be true, false, or omitted');
  if(rgbs!==null && hasRgb!==null)
    throw new Error('createEncoder: pass rgbs or hasRgb, not both');
  // null → infer a single default stream from the first frame; an array (possibly empty) is final.
  const declaredRgbs = rgbs!==null ? normalizeRgbSpecs(rgbs)
    : hasRgb===null ? null
    : hasRgb ? [{ id: DEFAULT_RGB_ID, kbps: null }] : [];
  let n=0, sawDefaultRgb=false;
  let signalPlan=null, rgbPlan=null;  // frozen together: track numbers derive from both
  const rgbEnc={};  // rgb stream id → encoder          (resolved; read synchronously by finish())
  const rgbEncP={}; // rgb stream id → Promise<encoder> (in-flight guard)
  const sigEnc={};  // id → { hi, lo }          (resolved encoders; read synchronously by finish())
  const sigEncP={}; // id → Promise<{ hi, lo }> (in-flight guard, so concurrent callers share one)
  let streamMux=null, byteParts=null;
  const muxFrames=[];
  const rgbKeyEvery=Math.max(1, Math.round(fps));
  let textTrackNumber=0;   // 0 when no metadata track was declared
  const pixels=W*H;   // samples per signal plane; rgb is pixels*4 bytes (RGBA)

  // Backends are picked once per encoder, lazily, on first frame. Lossless (signals) and
  // lossy (rgb) probe independently — a browser may have native lossy but need WASM lossless.
  let losslessBackendP=null, lossyBackendP=null;
  const losslessBackend=()=> losslessBackendP ??= pickEncoderBackend({ lossless:true, force:backend });
  const lossyBackend=()=> lossyBackendP ??= pickEncoderBackend({ lossless:false, force:backend });

  function ensurePlan(){
    if(signalPlan) return;
    rgbPlan=planRgbs(declaredRgbs ?? (sawDefaultRgb ? [{ id: DEFAULT_RGB_ID, kbps: null }] : []));
    signalPlan=planSignals(specList, rgbPlan.length);
  }

  function ensureStreamMux(){
    if(streamMux) return;
    ensurePlan();
    const tracks=buildTracksFromPlan(W, H, rgbPlan, signalPlan);
    if(textTrack){
      // Appended last so the video/signal track numbers are unchanged. WebM defines its
      // own WebVTT CodecIDs — Matroska's S_TEXT/WEBVTT demuxes as an unknown codec — and
      // D_WEBVTT/METADATA, though the better semantic fit, is given a metadata disposition
      // by ffmpeg which then reads no packets from it at all.
      textTrackNumber=tracks.reduce((m,t)=>Math.max(m, t.number), 0)+1;
      tracks.push({ number:textTrackNumber, codecID:'D_WEBVTT/SUBTITLES', name:String(textTrack), type:17 });
    }
    const metadata=buildFileMetadata({ W, H, fps, n:0, rgbs:rgbPlan, signals: signalPlan, streaming:true });
    streamMux=createStreamMux({ tracks, metadata, durationMs:0 });
    byteParts=[streamMux.header];
    if(onChunk) onChunk(streamMux.header);
  }

  // Memoize on the *promise*, not the resolved value: `if(!sigEnc[id]) { await … }` lets every
  // concurrent caller past the guard before any of them assigns, so each would build its own pair
  // of track encoders and encode its frame as that encoder's frame 0 — every block a keyframe at
  // t=0, and all but the last encoder leaked unclosed.
  function getSigEnc(id){
    return sigEncP[id] ??= (async()=>{
      const be=await losslessBackend();
      return sigEnc[id]={
        hi: be.createTrackEncoder({ kind:'luma', lossless:true, W, H, fps, keyEvery:rgbKeyEvery }),
        lo: be.createTrackEncoder({ kind:'luma', lossless:true, W, H, fps, keyEvery:rgbKeyEvery }),
      };
    })();
  }

  function getRgbEnc(r){
    return rgbEncP[r.id] ??= (async()=>{
      const be=await lossyBackend();
      return rgbEnc[r.id]=be.createTrackEncoder({
        kind:'rgba', lossless:false, W, H, fps, bitrate: r.kbps ?? rgbKbps, keyEvery:rgbKeyEvery });
    })();
  }

  // addFrame()/finish() mutate encoder state across await points and drive stateful VP9 encoders
  // that require frames in order, so they must never interleave. Callers that fan out — the
  // natural `await Promise.all(frames.map(f => enc.addFrame(f)))` — are serialized here in call
  // order instead of corrupting the stream. Video encoding is inherently sequential, so this
  // costs no parallelism that was ever available.
  let opQueue=Promise.resolve();
  function serialize(fn){
    const run=opQueue.then(fn, fn);      // run even if a previous call rejected
    opQueue=run.then(()=>{}, ()=>{});    // a rejection must not poison later calls
    return run;
  }

  // Each track encoder timestamps from its own frame counter, starting at 0, so a stream whose
  // first frame is not frame 0 (rgb declared via hasRgb, or a signal that starts late) would be
  // written back at t=0 and land in the wrong frame slot. Every stream records the frame it
  // started on and shifts its chunks by that much. A stream that resumes *after* a gap can't be
  // repaired by any single offset, so it is refused rather than silently misaligned.
  // Keys never collide across kinds: rgb streams use rgbSlotKey(id) (starts `rgb:"`), signals
  // use `sig:${id}`.
  const streams={};   // stream key → { start, last }
  function checkStream(key, label){
    const st=streams[key];
    if(st && n!==st.last+1)
      throw new Error(`addFrame: "${label}" is absent on frame ${st.last+1} but present on frame ${n}; `
        + 'once a stream starts it must be written on every frame');
  }
  function markStream(key){
    const st=streams[key];
    if(st) st.last=n; else streams[key]={ start:n, last:n };
  }
  function stamp(key, track, chunk){
    const offsetMs=Math.round(streams[key].start*1000/fps);
    return { track, key:chunk.key, data:chunk.data, timeMs: chunk.timeMs+offsetMs };
  }

  function emitMuxFrames(writes){
    if(!streamMux) return;
    for(const f of writes.sort((a,b)=>a.timeMs-b.timeMs || a.track-b.track)){
      const c=streamMux.writeFrame(f);
      if(c){ byteParts.push(c); if(onChunk) onChunk(c); }
    }
  }

  // near/far have to be readable before the first frame — right after setNearFar(), say — but
  // planning is deliberately deferred until then, since undeclared rgb is only known once frame 0
  // arrives. So read them off a throwaway plan instead of freezing the real one; only the quant
  // range is wanted here, and that does not depend on the track numbering.
  const depthQuant=()=>{
    try{
      const nRgb=(declaredRgbs ?? (sawDefaultRgb ? [0] : [])).length;
      return (signalPlan ?? planSignals(specList, nRgb)).find(s=>s.id==='depth')?.quant;
    }
    catch{ return undefined; }
  };

  return {
    get signalPlan(){ ensurePlan(); return signalPlan; },
    get near(){ return depthQuant()?.near; },
    get far(){ return depthQuant()?.far; },
    get frameCount(){ return n; },

    setNearFar(near_, far_){
      // Frames already encoded were quantized against the old range, and in streaming mode the
      // header carrying near/far has long since gone out over onChunk — either way the metadata
      // would no longer describe the data it labels.
      if(n) throw new Error('setNearFar: must be called before the first addFrame()');
      const d=specList.find(s=>(s.id ?? 'depth')==='depth');
      const qType=d?.quant?.type ?? (d?.near !== undefined ? 'inverse-depth' : null);
      if(!d || qType !== 'inverse-depth')
        throw new Error('no inverse-depth signal configured');
      if(d.quant) { d.quant.near=near_; d.quant.far=far_; }
      else { d.near=near_; d.far=far_; }
      signalPlan=null;
    },

    addFrame(frame){ return serialize(()=>addFrameImpl(frame)); },

    /** Append one timed-text cue to the metadata track. `timestamp`/`duration` in seconds. */
    addText(text, timestamp, duration=null){
      return serialize(async ()=>{
        if(!textTrack) throw new Error('addText: createEncoder was not given a textTrack');
        ensureStreamMux();
        const durMs=Math.max(0, Math.round((duration ?? 1/fps)*1000));
        const chunk=streamMux.writeText(textTrackNumber, Math.round(timestamp*1000), durMs, String(text));
        if(chunk){ byteParts.push(chunk); if(onChunk) onChunk(chunk); }
        return chunk ?? new Uint8Array(0);
      });
    },
    finish(){ return serialize(()=>finishImpl()); },
  };

  async function addFrameImpl(frame){
    const writes=[];
    // Plane geometry is checked before anything stateful: a wrong-length plane is a caller bug
    // the codec backends cannot absorb (the WASM one copies it into a W*H*4 allocation on the
    // libvpx heap), and it says nothing about how this encoder was configured.
    const checkPlane=(plane, label)=>{
      const bytes=plane.byteLength ?? plane.length;
      if(bytes!==pixels*4)
        throw new Error(`addFrame: ${label} plane has ${bytes} bytes, expected ${pixels*4} (${W}x${H} RGBA)`);
    };
    if(frame.rgbs!=null && typeof frame.rgbs!=='object')
      throw new Error('addFrame: rgbs must be an object of { streamId: plane }');
    const named=frame.rgbs ? Object.entries(frame.rgbs).filter(([,p])=>p!=null) : [];
    if(frame.rgb!=null) checkPlane(frame.rgb, 'rgb');
    for(const [id, plane] of named) checkPlane(plane, `rgb stream "${id}"`);

    if(frame.rgb!=null){
      // Track numbers were frozen without an RGB track, so this frame's RGB would be written to
      // track 1 — already owned by signals[0].tracks.hi. Fail here rather than emit a file whose
      // RGB and first signal decode as the same track.
      if(declaredRgbs!==null && !declaredRgbs.length)
        throw new Error('addFrame: frame carries rgb, but createEncoder({ hasRgb:false }) declared none');
      if(signalPlan && !rgbPlan.length)
        throw new Error('addFrame: rgb appeared after the track plan was frozen (frame 0 had none); '
          + 'pass createEncoder({ hasRgb:true }) to reserve the rgb track up front');
      if(declaredRgbs===null) sawDefaultRgb=true;
    }
    // Named streams cannot be inferred: object key order is too weak a footing to freeze track
    // numbers on, so they must have been declared (or the plan already frozen by earlier frames).
    if(named.length && declaredRgbs===null && !signalPlan && !sawDefaultRgb)
      throw new Error('addFrame: rgbs{} requires the streams to be declared up front — pass '
        + 'createEncoder({ rgbs:[...] }) (or hasRgb:true for the single default stream)');
    ensurePlan();

    // Map this frame's rgb payloads onto the planned streams; `rgb` is sugar for the primary.
    const rgbIn={};
    for(const [id, plane] of named){
      if(!rgbPlan.some(r=>r.id===id))
        throw new Error(`addFrame: unknown rgb stream "${id}" — this encoder's streams are `
          + `[${rgbPlan.map(r=>r.id).join(', ')}]`);
      rgbIn[id]=plane;
    }
    if(frame.rgb!=null){
      const primary=rgbPlan[0];
      if(rgbIn[primary.id]!=null)
        throw new Error(`addFrame: rgb and rgbs["${primary.id}"] both name the primary stream`);
      rgbIn[primary.id]=frame.rgb;
    }
    const rgbPresent=rgbPlan.filter(r=>rgbIn[r.id]!=null);

    const inputs=collectFrameInputs(frame, signalPlan);
    // Quantize, size-check and gap-check everything this frame carries *before* pushing any of it
    // into a stateful encoder, so a rejected frame leaves the encoders untouched.
    const present=[];
    for(const s of signalPlan){
      const u16=u16FromFramePayload(inputs[s.id], s, pixels);
      if(u16) present.push({ s, u16 });
    }
    if(!rgbPresent.length && !present.length) throw new Error('addFrame: pass rgb and/or signals');
    for(const r of rgbPresent) checkStream(rgbSlotKey(r.id), `rgb "${r.id}"`);
    for(const { s } of present) checkStream(`sig:${s.id}`, s.id);

    for(const { s, u16 } of present){
      markStream(`sig:${s.id}`);
      const enc=await getSigEnc(s.id);
      const { hi, lo }=triFoldPack(u16);
      const chi=await enc.hi.push(hi), clo=await enc.lo.push(lo);
      writes.push(stamp(`sig:${s.id}`, s.tracks.hi, chi), stamp(`sig:${s.id}`, s.tracks.lo, clo));
    }
    if(onChunk) ensureStreamMux();

    for(const r of rgbPresent){
      markStream(rgbSlotKey(r.id));
      const enc=await getRgbEnc(r);
      const c=await enc.push(rgbIn[r.id]);
      writes.push(stamp(rgbSlotKey(r.id), r.track, c));
    }
    if(onChunk) emitMuxFrames(writes);
    else muxFrames.push(...writes);
    n++;
  }

  async function finishImpl(){
    if(!n) throw new Error('no frames encoded');
    ensurePlan();
    // A reserved-but-empty RGB track advertises itself in the metadata while carrying no blocks,
    // which stalls the streaming decoder — every slot there waits on an rgb block.
    for(const r of rgbPlan)
      if(!streams[rgbSlotKey(r.id)])
        throw new Error(`finish: createEncoder reserved rgb track "${r.id}", but no frame carried rgb for it`);
    if(onChunk){
      ensureStreamMux();
      const tailWrites=[];
      for(const r of rgbPlan){
        if(!rgbEnc[r.id]) continue;
        (await rgbEnc[r.id].close()).forEach(c=>tailWrites.push(stamp(rgbSlotKey(r.id), r.track, c)));
      }
      for(const s of signalPlan){
        if(!sigEnc[s.id]) continue;
        (await sigEnc[s.id].hi.close()).forEach(c=>tailWrites.push(stamp(`sig:${s.id}`, s.tracks.hi, c)));
        (await sigEnc[s.id].lo.close()).forEach(c=>tailWrites.push(stamp(`sig:${s.id}`, s.tracks.lo, c)));
      }
      emitMuxFrames(tailWrites);
      const tailBytes=streamMux.finish(Math.round(n*1000/fps));
      if(tailBytes.length){ byteParts.push(tailBytes); onChunk(tailBytes); }
      return concatChunks(byteParts);
    }
    for(const r of rgbPlan){ if(rgbEnc[r.id]) await rgbEnc[r.id].close(); }
    for(const s of signalPlan){ if(sigEnc[s.id]){ await sigEnc[s.id].hi.close(); await sigEnc[s.id].lo.close(); } }
    const tracks=buildTracksFromPlan(W, H, rgbPlan, signalPlan);
    if(textTrack){
      // Appended last so the video/signal track numbers are unchanged. WebM defines its
      // own WebVTT CodecIDs — Matroska's S_TEXT/WEBVTT demuxes as an unknown codec — and
      // D_WEBVTT/METADATA, though the better semantic fit, is given a metadata disposition
      // by ffmpeg which then reads no packets from it at all.
      textTrackNumber=tracks.reduce((m,t)=>Math.max(m, t.number), 0)+1;
      tracks.push({ number:textTrackNumber, codecID:'D_WEBVTT/SUBTITLES', name:String(textTrack), type:17 });
    }
    const metadata=buildFileMetadata({ W, H, fps, n, rgbs:rgbPlan, signals: signalPlan });
    return mux({ tracks, frames:muxFrames, metadata, durationMs: Math.round(n*1000/fps) });
  }
}

export async function encode({ W, H, fps=30, signals, frames, rgbKbps=2_000_000, rgbs=null, onChunk=null }){
  if(!signals?.length) throw new Error('encode: signals[] required');
  if(!frames?.length) throw new Error('encode: frames[] required');
  if(rgbs===null && frames.some(f=>f.rgbs && Object.keys(f.rgbs).length))
    throw new Error('encode: frames carry named rgb streams — declare them with encode({ rgbs:[...] })');
  // Every frame is known here, so RGB presence is declared rather than inferred from frame 0 —
  // a clip whose RGB starts mid-sequence plans its track numbers correctly.
  const enc=createEncoder({ W, H, fps, signals, rgbKbps, onChunk,
    ...(rgbs!==null ? { rgbs } : { hasRgb: frames.some(f=>!!f.rgb) }) });
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
  let core=null, claimed=0;
  const waitBlock=[];   // a queue, so overlapping readFrame()s can't strand each other's waiter

  function notify(){ while(waitBlock.length) waitBlock.shift()(); }

  function emitSlot(timeMs){
    const slot=slotPending.get(timeMs);
    slotPending.delete(timeMs);
    if(slot && slotHasContent(slot, meta)){ blockQueue.push(slot); return true; }
    return false;
  }

  // Blocks arrive in ascending time, so once a newer timestamp shows up (or the stream ends) every
  // older slot has all the blocks it will ever get. Without this, frames the encoder legitimately
  // writes with only some of the declared keys — rgb-only, signal-only — never satisfy
  // isSlotComplete() and are stranded in slotPending forever, which is why streaming decode used to
  // disagree with the buffered path on the same file.
  function flushBefore(timeMs){
    let any=false;
    for(const t of [...slotPending.keys()].filter(t=>t<timeMs).sort((a,b)=>a-b)) any=emitSlot(t)||any;
    return any;
  }

  function onBlock(block){
    if(!meta) return;
    let key=null;
    for(const r of meta.rgbs) if(block.track===r.track){ key=rgbSlotKey(r.id); break; }
    if(!key){
      for(const s of meta.signals){
        if(block.track===s.tracks.hi) key=`${s.id}:hi`;
        else if(block.track===s.tracks.lo) key=`${s.id}:lo`;
      }
    }
    if(!key) return;
    let ready=flushBefore(block.timeMs);   // drain older slots first, so blockQueue stays ordered
    let slot=slotPending.get(block.timeMs);
    if(!slot){ slot={ timeMs:block.timeMs }; slotPending.set(block.timeMs, slot); }
    slot[key]=block;
    if(isSlotComplete(slot, keys)) ready=emitSlot(block.timeMs)||ready;
    if(ready) notify();
  }

  function ingest(events){
    for(const ev of events){
      if(ev.type==='metadata'){
        meta=normalizeMetadata(ev.metadata);
        W=meta.width; H=meta.height;
        keys=slotKeysForMetadata(meta);
      }else if(ev.type==='block') onBlock(ev.block);
      else if(ev.type==='end'){
        if(meta) flushBefore(Infinity);
        streamDone=true;
        notify();
      }
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

    // Waits for the next slot to arrive rather than reporting end-of-stream early. `claimed` is
    // bumped synchronously so overlapping readFrame()s each reserve a distinct slot before
    // suspending; waitBlock is FIFO, so they claim in call order — the order makeFrameReader
    // then resolves them in.
    async readFrame(){
      for(;;){
        if(shut) throw new Error('decoder closed');
        if(!meta) throw new Error('waiting for metadata');
        if(claimed<blockQueue.length){ claimed++; break; }
        if(streamDone) return null;
        await new Promise(res=>{ waitBlock.push(res); });   // close() wakes this too — hence the shut recheck
      }
      core ??= makeFrameReader({ meta, W, H, blocks:blockQueue, getBackend });
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
  const rgb=[], rgbSeries={}, signalSeries={};
  for await (const frame of dec){
    if(frame.rgb) rgb.push(frame.rgb);
    for(const [id, plane] of Object.entries(frame.rgbs ?? {})){
      if(!rgbSeries[id]) rgbSeries[id]=[];
      rgbSeries[id].push(plane);
    }
    for(const [id, sig] of Object.entries(frame.signals ?? {})){
      if(!signalSeries[id]) signalSeries[id]=[];
      signalSeries[id].push(sig);
    }
  }
  await dec.close();
  return { metadata:dec.metadata, width:dec.width, height:dec.height, signals:dec.signals,
    rgb: rgb.length ? rgb : null,
    rgbs: Object.keys(rgbSeries).length ? rgbSeries : null,
    signalSeries: Object.keys(signalSeries).length ? signalSeries : null };
}

export { createStreamMux, createStreamDemux, concatChunks, WebMCorruptError } from './webm.js';
export { normalizeMetadata, planSignals, planRgbs, normalizeRgbSpecs } from './signals.js';
