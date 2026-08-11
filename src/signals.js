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

/** Track number the primary RGB stream always occupies when a file carries any. */
export const RGB_TRACK = 1;

/** Stream id used when a file carries RGB that was never given an explicit id. */
export const DEFAULT_RGB_ID = 'rgb';

/**
 * Slot key for one RGB stream. JSON-quoting the id keeps the key space collision-free against
 * signal keys (`${id}:hi` / `${id}:lo`): an rgb key always ends in `"`, a signal key never does,
 * whatever characters either id contains.
 */
export const rgbSlotKey = id => `rgb:${JSON.stringify(id)}`;

/**
 * Normalize createEncoder's `rgbs` declaration — an array of ids (strings) or
 * `{ id, kbps? }` entries — into `[{ id, kbps }]`, order preserved (it fixes track numbering).
 */
export function normalizeRgbSpecs(rgbs){
  if(!Array.isArray(rgbs)) throw new Error('rgbs must be an array of stream ids or { id, kbps } entries');
  const out=[]; const seen=new Set();
  for(const raw of rgbs){
    const spec = typeof raw === 'string' ? { id: raw } : raw;
    const id=spec?.id;
    if(typeof id !== 'string' || !id) throw new Error('each rgb stream needs a non-empty string id');
    if(seen.has(id)) throw new Error(`duplicate rgb stream id "${id}"`);
    seen.add(id);
    out.push({ id, kbps: spec.kbps ?? null });
  }
  return out;
}

/**
 * Assign track numbers and container names to RGB streams. The primary stream keeps track 1 and
 * the container name "rgb" — that pair is what pre-multi-RGB readers (and the cue-track choice)
 * key on — and secondaries follow as `rgb-{id}` on tracks 2..N. Signals number after all of them.
 */
export function planRgbs(specs){
  return specs.map((s, i)=>({
    id: s.id, track: i+1, codec: VP9, kbps: s.kbps ?? null,
    trackName: i===0 ? 'rgb' : `rgb-${s.id}`,
  }));
}

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
  // `signals` must be present and an array — that is the v2 shape — but it is
  // allowed to be empty. planSignals() calls an RGB-only take (video plus
  // wrapper metadata, no aux planes) a valid plan and the encoder writes
  // `signals: []` for it, so refusing to read one here made the decoder reject
  // files this library itself produces. The real emptiness check is below, once
  // rgbs[] has been resolved: neither signals nor RGB means nothing to decode.
  if(!Array.isArray(meta.signals))
    throw new Error('metadata must include signals[] (v2)');
  const signals=meta.signals.map(s=>{
    const quant=s.quant && typeof s.quant === 'object'
      ? { ...s.quant, type: s.quant.type ?? (s.quant.near !== undefined ? QUANT_INVERSE_DEPTH : null) }
      : s.quant === QUANT_INVERSE_DEPTH ? { type: QUANT_INVERSE_DEPTH, near: s.near, far: s.far, levels: s.levels } : s.quant;
    return { ...s, tracks: { hi: s.tracks.hi, lo: s.tracks.lo }, quant };
  });
  // rgbs[] (v3) is authoritative when present; a legacy `rgb` (v2, always the sole stream)
  // is folded into a one-entry list under the default id so every reader path below sees
  // one shape. `rgb` stays on the object untouched for callers that still read it.
  const rgbs = Array.isArray(meta.rgbs) && meta.rgbs.length
    ? meta.rgbs.filter(r=>r && r.track).map((r, i)=>({
        id: typeof r.id === 'string' && r.id ? r.id : (i===0 ? DEFAULT_RGB_ID : `rgb${i}`),
        track: r.track, codec: r.codec,
        ...(r.hdr ? { hdr: r.hdr } : {}) }))
    : meta.rgb ? [{ id: DEFAULT_RGB_ID, track: meta.rgb.track ?? RGB_TRACK, codec: meta.rgb.codec }] : [];
  if(!signals.length && !rgbs.length)
    throw new Error('metadata declares neither signals[] nor an rgb stream');
  return { ...meta, rgbs, signals };
}

export function planSignals(specs, rgbCount){
  // Historically a boolean (one RGB stream or none); a number counts the RGB streams that
  // precede the signal tracks.
  const nRgb = typeof rgbCount === 'number' ? rgbCount : (rgbCount ? 1 : 0);
  // An RGB-only take (video + wrapper metadata, no aux planes) is a valid plan; a file
  // with no tracks at all is not.
  if(!specs?.length){
    if(!nRgb) throw new Error('planSignals: need rgb or at least one signal spec');
    return [];
  }
  const signals=[];
  // Numbering is frozen here, so the RGB stream count must be final: a track reserved for RGB
  // that never arrives (or an RGB track claimed after the fact) collides with signals[0].tracks.hi.
  let next=nRgb+1;
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
      // Optional, semantically inert hint: the id of the RGB stream whose camera frame this
      // signal lives in. Recorded in the metadata for downstream consumers; never interpreted.
      view: typeof raw.view === 'string' && raw.view ? raw.view : null,
    });
  }
  return signals;
}

/** `rgbPlan` is planRgbs() output; a boolean is accepted for pre-multi-RGB callers. */
function coerceRgbPlan(rgbPlan){
  if(Array.isArray(rgbPlan)) return rgbPlan;
  return rgbPlan ? planRgbs([{ id: DEFAULT_RGB_ID }]) : [];
}

export function buildTracksFromPlan(W, H, rgbPlan, signals){
  const tracks=[];
  for(const r of coerceRgbPlan(rgbPlan))
    tracks.push({ number:r.track, codecID:'V_VP9', name:r.trackName, width:W, height:H });
  for(const s of signals){
    tracks.push({ number:s.tracks.hi, codecID:'V_VP9', name:s.trackNames.hi, width:W, height:H });
    tracks.push({ number:s.tracks.lo, codecID:'V_VP9', name:s.trackNames.lo, width:W, height:H });
  }
  return tracks;
}

export function buildFileMetadata({ W, H, fps, n, hasRgb, rgbs, signals, streaming=false }){
  const rgbPlan=coerceRgbPlan(rgbs ?? hasRgb);
  const sigMeta=signals.map(s=>({
    id: s.id,
    tracks: { hi: s.tracks.hi, lo: s.tracks.lo },
    codec: s.codec,
    lossless: s.lossless,
    scheme: s.scheme,
    dtype: s.dtype,
    invalidCode: s.invalidCode,
    quant: s.quant,
    view: s.view ?? undefined,
  }));
  // v3 keeps the legacy `rgb` key pointing at the primary stream (always equal to rgbs[0]),
  // so pre-multi-RGB readers decode it exactly as before; `rgbs` is what v3 readers use.
  return {
    version: 3, width: W, height: H, fps,
    frames: streaming ? null : n,
    streaming: streaming || undefined,
    rgb: rgbPlan.length ? { track: rgbPlan[0].track, codec: VP9 } : null,
    rgbs: rgbPlan.length ? rgbPlan.map(r=>({ id: r.id, track: r.track, codec: r.codec })) : undefined,
    signals: sigMeta,
  };
}

/**
 * @param pixels — expected sample count (W*H). Pass it whenever the frame geometry is known:
 *   a plane that is not exactly W*H is a caller bug, and left unchecked it reaches the codec
 *   backends as an out-of-range copy (the WASM one writes straight into the libvpx heap).
 */
export function u16FromFramePayload(payload, signal, pixels=null){
  if(!payload) return null;
  const check=(plane, what)=>{
    if(pixels!=null && plane.length!==pixels)
      throw new Error(`signal "${signal.id}": ${what} plane has ${plane.length} samples, expected ${pixels}`);
    return plane;
  };
  if(payload.u16) return check(payload.u16, 'u16');
  if(payload.float){
    const q=signal.quant;
    if(!q || q.type !== QUANT_INVERSE_DEPTH)
      throw new Error(`signal "${signal.id}": float requires inverse-depth quant`);
    check(payload.float, 'float');
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

/**
 * Is there anything in this slot a reader can decode — an rgb stream, or a complete hi/lo pair?
 * Tracks need not share timestamps (rgb-only frames, per-track offsets, truncated files), so a slot
 * can end up holding nothing usable. Both decode paths drop those slots by this one rule, which is
 * what keeps buffered and streaming decode agreeing on frame counts for the same file.
 * `meta` is normalized metadata (it needs both `rgbs` and `signals`).
 */
export function slotHasContent(slot, meta){
  if(meta.rgbs.some(r=>slot[rgbSlotKey(r.id)])) return true;
  return meta.signals.some(s=>slot[`${s.id}:hi`] && slot[`${s.id}:lo`]);
}

export function blocksByTime(tracks, metadata){
  const meta=normalizeMetadata(metadata);
  const map=new Map();
  function add(key, fr){
    if(!map.has(fr.timeMs)) map.set(fr.timeMs, { timeMs: fr.timeMs });
    map.get(fr.timeMs)[key]=fr;
  }
  for(const r of meta.rgbs)
    if(tracks[r.track]) for(const f of tracks[r.track].frames) add(rgbSlotKey(r.id), f);
  for(const s of meta.signals){
    if(tracks[s.tracks.hi]) for(const f of tracks[s.tracks.hi].frames) add(`${s.id}:hi`, f);
    if(tracks[s.tracks.lo]) for(const f of tracks[s.tracks.lo].frames) add(`${s.id}:lo`, f);
  }
  return [...map.keys()].sort((a,b)=>a-b).map(t=>map.get(t))
    .filter(slot=>slotHasContent(slot, meta));
}

export function slotKeysForMetadata(metadata){
  const meta=normalizeMetadata(metadata);
  return { rgbIds: meta.rgbs.map(r=>r.id), signalIds: meta.signals.map(s=>s.id) };
}

export function isSlotComplete(slot, keys){
  for(const id of keys.rgbIds) if(!slot[rgbSlotKey(id)]) return false;
  for(const id of keys.signalIds) if(!slot[`${id}:hi`] || !slot[`${id}:lo`]) return false;
  return true;
}

export function collectFrameInputs(frame, signalPlan){
  const byId={};
  if(!frame.signals) return byId;
  for(const s of signalPlan) byId[s.id]=frame.signals[s.id] ?? null;
  return byId;
}
