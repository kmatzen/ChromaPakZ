// ChromaPakZ lossless signal model — arbitrary W×H uint16 planes in VP9 lossless track pairs.

import {
  LEVELS_FULL,
  quantizeInverseDepth,
  dequantizeInverseDepth,
  triFoldPack,
  triFoldUnpack,
} from './chromapakz-core.js';

export { LEVELS_FULL, quantizeInverseDepth, dequantizeInverseDepth, triFoldPack, triFoldUnpack };

const VP9 = 'vp09.00.10.08';
const SCHEME_TRIFOLD = 'tri-fold-8+8';
const QUANT_INVERSE_DEPTH = 'inverse-depth';

export const SIGNAL_DEPTH = {
  id: 'depth',
  scheme: SCHEME_TRIFOLD,
  dtype: 'uint16',
  invalidCode: 0,
  quant: { type: QUANT_INVERSE_DEPTH },
};

/** Raw uint16 pass-through (object IDs, packed labels, quantized normals, …). */
export const SIGNAL_RAW_U16 = {
  id: 'raw',
  scheme: SCHEME_TRIFOLD,
  dtype: 'uint16',
  invalidCode: 0,
  quant: null,
};

export function normalizeMetadata(meta){
  if(!meta) throw new Error('missing CHROMAPAKZ metadata');
  if(!Array.isArray(meta.signals) || !meta.signals.length)
    throw new Error('metadata must include signals[] (v2)');
  const signals=meta.signals.map(s=>{
    const quant=s.quant && typeof s.quant === 'object'
      ? { ...s.quant, type: s.quant.type ?? (s.quant.near !== undefined ? QUANT_INVERSE_DEPTH : null) }
      : s.quant === QUANT_INVERSE_DEPTH ? { type: QUANT_INVERSE_DEPTH, near: s.near, far: s.far, levels: s.levels } : s.quant;
    return { ...s, tracks: { hi: s.tracks.hi, lo: s.tracks.lo }, quant };
  });
  return { ...meta, signals };
}

export function planSignals(specs, hasRgb){
  if(!specs?.length) throw new Error('planSignals: need at least one signal spec');
  const signals=[];
  let next=hasRgb ? 2 : 1;
  for(const raw of specs){
    const id=raw.id ?? raw.name;
    if(!id) throw new Error('each signal needs an id');
    const scheme=raw.scheme ?? SCHEME_TRIFOLD;
    if(scheme!==SCHEME_TRIFOLD) throw new Error(`unsupported scheme: ${scheme}`);
    let quant=raw.quant ?? null;
    if(quant?.type === QUANT_INVERSE_DEPTH || raw.near !== undefined){
      quant={ type: QUANT_INVERSE_DEPTH, near: quant?.near ?? raw.near, far: quant?.far ?? raw.far,
        levels: quant?.levels ?? raw.levels ?? LEVELS_FULL };
      if(quant.near === undefined || quant.far === undefined)
        throw new Error(`signal "${id}": inverse-depth requires near and far`);
      if(!(quant.near > 0) || !(quant.far > quant.near))
        throw new Error(`signal "${id}": need 0 < near < far`);
    }
    const hi=next++, lo=next++;
    signals.push({
      id, scheme, dtype: raw.dtype ?? 'uint16', invalidCode: raw.invalidCode ?? 0,
      codec: VP9, lossless: true,
      tracks: { hi, lo },
      trackNames: { hi: `signal-${id}-hi`, lo: `signal-${id}-lo` },
      quant,
    });
  }
  return signals;
}

export function buildTracksFromPlan(W, H, hasRgb, signals){
  const tracks=[];
  if(hasRgb) tracks.push({ number:1, codecID:'V_VP9', name:'rgb', width:W, height:H });
  for(const s of signals){
    tracks.push({ number:s.tracks.hi, codecID:'V_VP9', name:s.trackNames.hi, width:W, height:H });
    tracks.push({ number:s.tracks.lo, codecID:'V_VP9', name:s.trackNames.lo, width:W, height:H });
  }
  return tracks;
}

export function buildFileMetadata({ W, H, fps, n, hasRgb, signals, streaming=false }){
  const sigMeta=signals.map(s=>({
    id: s.id,
    tracks: { hi: s.tracks.hi, lo: s.tracks.lo },
    codec: s.codec,
    lossless: s.lossless,
    scheme: s.scheme,
    dtype: s.dtype,
    invalidCode: s.invalidCode,
    quant: s.quant,
  }));
  return {
    version: 2, width: W, height: H, fps,
    frames: streaming ? null : n,
    streaming: streaming || undefined,
    rgb: hasRgb ? { track: 1, codec: VP9 } : null,
    signals: sigMeta,
  };
}

export function u16FromFramePayload(payload, signal){
  if(!payload) return null;
  if(payload.u16) return payload.u16;
  if(payload.float){
    const q=signal.quant;
    if(!q || q.type !== QUANT_INVERSE_DEPTH)
      throw new Error(`signal "${signal.id}": float requires inverse-depth quant`);
    return quantizeInverseDepth(payload.float, q.near, q.far, q.levels ?? LEVELS_FULL);
  }
  throw new Error(`signal "${signal.id}": pass { u16 } or { float }`);
}

export function materializeSignal(u16, signal){
  const out={ u16 };
  const q=signal.quant;
  if(q?.type === QUANT_INVERSE_DEPTH)
    out.float=dequantizeInverseDepth(u16, q.near, q.far, q.levels ?? LEVELS_FULL);
  return out;
}

export function blocksByTime(tracks, metadata){
  const meta=normalizeMetadata(metadata);
  const rgbT=meta.rgb?.track;
  const map=new Map();
  function add(key, fr){
    if(!map.has(fr.timeMs)) map.set(fr.timeMs, { timeMs: fr.timeMs });
    map.get(fr.timeMs)[key]=fr;
  }
  if(rgbT && tracks[rgbT]) for(const f of tracks[rgbT].frames) add('rgb', f);
  for(const s of meta.signals){
    if(tracks[s.tracks.hi]) for(const f of tracks[s.tracks.hi].frames) add(`${s.id}:hi`, f);
    if(tracks[s.tracks.lo]) for(const f of tracks[s.tracks.lo].frames) add(`${s.id}:lo`, f);
  }
  return [...map.keys()].sort((a,b)=>a-b).map(t=>map.get(t));
}

export function slotKeysForMetadata(metadata){
  const meta=normalizeMetadata(metadata);
  const keys={ rgb: !!meta.rgb };
  for(const s of meta.signals) keys[s.id]=true;
  return keys;
}

export function isSlotComplete(slot, keys){
  if(keys.rgb && !slot.rgb) return false;
  for(const id of Object.keys(keys)){
    if(id==='rgb') continue;
    if(!slot[`${id}:hi`] || !slot[`${id}:lo`]) return false;
  }
  return true;
}

export function collectFrameInputs(frame, signalPlan){
  const byId={};
  if(!frame.signals) return byId;
  for(const s of signalPlan) byId[s.id]=frame.signals[s.id] ?? null;
  return byId;
}
