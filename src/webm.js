// Minimal pure-JS Matroska/WebM muxer + demuxer for the subset chromapakz needs: multiple VP9
// video tracks, one cluster-split timeline, a metadata tag, an optional WebVTT timed-text track,
// and the Colour element that carries HDR signalling (see colourElement / walkColour).
// Batch mux/demux plus incremental createStreamMux / createStreamDemux for network streaming.

// ── EBML element IDs (stored with their length-marker bits, as on disk) ──
const ID = {
  EBML:0x1A45DFA3, EBMLVersion:0x4286, EBMLReadVersion:0x42F7, EBMLMaxIDLength:0x42F2,
  EBMLMaxSizeLength:0x42F3, DocType:0x4282, DocTypeVersion:0x4287, DocTypeReadVersion:0x4285,
  Segment:0x18538067, Info:0x1549A966, TimestampScale:0x2AD7B1, MuxingApp:0x4D80, WritingApp:0x5741,
  Tracks:0x1654AE6B, TrackEntry:0xAE, TrackNumber:0xD7, TrackUID:0x73C5, TrackType:0x83,
  FlagLacing:0x9C, CodecID:0x86, Name:0x536E, Video:0xE0, PixelWidth:0xB0, PixelHeight:0xBA,
  Tags:0x1254C367, Tag:0x7373, Targets:0x63C0, SimpleTag:0x67C8, TagName:0x45A3, TagString:0x4487,
  Cluster:0x1F43B675, Timestamp:0xE7, SimpleBlock:0xA3, Duration:0x4489,
  BlockGroup:0xA0, Block:0xA1, BlockDuration:0x9B,
  Cues:0x1C53BB6B, CuePoint:0xBB, CueTime:0xB3, CueTrackPositions:0xB7, CueTrack:0xF7, CueClusterPosition:0xF1,
  Colour:0x55B0, MatrixCoefficients:0x55B1, BitsPerChannel:0x55B2, Range:0x55B9,
  TransferCharacteristics:0x55BA, Primaries:0x55BB, MaxCLL:0x55BC, MaxFALL:0x55BD,
  MasteringMetadata:0x55D0, PrimaryRChromaticityX:0x55D1, PrimaryRChromaticityY:0x55D2,
  PrimaryGChromaticityX:0x55D3, PrimaryGChromaticityY:0x55D4, PrimaryBChromaticityX:0x55D5,
  PrimaryBChromaticityY:0x55D6, WhitePointChromaticityX:0x55D7, WhitePointChromaticityY:0x55D8,
  LuminanceMax:0x55D9, LuminanceMin:0x55DA,
};

// ── encoders ──
const cat = arrs => { let n=0; for(const a of arrs) n+=a.length; const o=new Uint8Array(n); let p=0;
  for(const a of arrs){ o.set(a,p); p+=a.length; } return o; };

function idBytes(id){ // emit the ID using as many bytes as its value occupies
  const b=[]; let v=id; while(v>0){ b.unshift(v&0xff); v=Math.floor(v/256); } return Uint8Array.from(b);
}
function vint(n){ // EBML variable-length integer (size descriptor), 1..8 bytes
  let L=1; while(n >= (2**(7*L))-1) L++;             // -1: all-ones is reserved (unknown size)
  const out=new Uint8Array(L); let v=n + 2**(7*L);   // set the marker bit at position L
  for(let i=L-1;i>=0;i--){ out[i]=v%256; v=Math.floor(v/256); } return out;
}
/** EBML unknown element size (all length-value bits set). */
function vintUnknown(L=8){
  if(L===1) return Uint8Array.of(0xff);
  if(L===2) return Uint8Array.of(0x7f, 0xff);
  if(L===4) return Uint8Array.of(0x1f, 0xff, 0xff, 0xff);   // marker bit at 0x10, all value bits set
  if(L===8) return Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  throw new Error(`vintUnknown: unsupported length ${L}`);
}
function uintBytes(n){ // minimal big-endian unsigned (>=1 byte)
  if(n===0) return Uint8Array.of(0);
  const b=[]; let v=n; while(v>0){ b.unshift(v&0xff); v=Math.floor(v/256); } return Uint8Array.from(b);
}
const strBytes = s => new TextEncoder().encode(s);
const f8 = v => { const b=new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, false); return b; }; // EBML float (Duration)
// One element: ID + size(vint) + payload.
function el(id, payload){ const i=idBytes(id); return cat([i, vint(payload.length), payload]); }
const elU = (id,n) => el(id, uintBytes(n));
const elS = (id,s) => el(id, strBytes(s));

/**
 * WebM Colour element — the container half of HDR signalling (HDR10 static metadata lives here,
 * not in the VP9 bitstream). `colour` is
 *   { matrix, bits, range, transfer, primaries, maxCLL?, maxFALL?,
 *     mastering?: { rx, ry, gx, gy, bx, by, wx, wy, maxLum, minLum } }
 * with the numeric values Matroska defines (PQ transfer = 16, HLG = 18, BT.2020 primaries = 9).
 * Element order is fixed and mirrored by the C muxer, so identical descriptors mux to
 * identical bytes.
 */
function colourElement(c){
  const parts=[ elU(ID.MatrixCoefficients,c.matrix), elU(ID.BitsPerChannel,c.bits),
    elU(ID.Range,c.range), elU(ID.TransferCharacteristics,c.transfer), elU(ID.Primaries,c.primaries) ];
  if(c.maxCLL) parts.push(elU(ID.MaxCLL,c.maxCLL));
  if(c.maxFALL) parts.push(elU(ID.MaxFALL,c.maxFALL));
  if(c.mastering){
    const m=c.mastering;
    parts.push(el(ID.MasteringMetadata, cat([
      el(ID.PrimaryRChromaticityX,f8(m.rx)), el(ID.PrimaryRChromaticityY,f8(m.ry)),
      el(ID.PrimaryGChromaticityX,f8(m.gx)), el(ID.PrimaryGChromaticityY,f8(m.gy)),
      el(ID.PrimaryBChromaticityX,f8(m.bx)), el(ID.PrimaryBChromaticityY,f8(m.by)),
      el(ID.WhitePointChromaticityX,f8(m.wx)), el(ID.WhitePointChromaticityY,f8(m.wy)),
      el(ID.LuminanceMax,f8(m.maxLum)), el(ID.LuminanceMin,f8(m.minLum)),
    ])));
  }
  return el(ID.Colour, cat(parts));
}

function trackEntry({number, codecID, name, width, height, type=1, colour=null}){
  const parts=[ elU(ID.TrackNumber,number), elU(ID.TrackUID,number), elU(ID.TrackType,type),
    elU(ID.FlagLacing,0), elS(ID.CodecID,codecID) ];
  if(name) parts.push(elS(ID.Name,name));
  if(type===1 && width&&height){
    const video=[ elU(ID.PixelWidth,width), elU(ID.PixelHeight,height) ];
    if(colour) video.push(colourElement(colour));
    parts.push(el(ID.Video, cat(video)));
  }
  return el(ID.TrackEntry, cat(parts));
}
function simpleBlock(track, relTime, key, data){
  const tc=new Uint8Array(2); const dv=new DataView(tc.buffer); dv.setInt16(0, relTime, false);
  const flags=Uint8Array.of(key?0x80:0x00);
  return el(ID.SimpleBlock, cat([vint(track), tc, flags, data])); // track# as vint (small → 1 byte)
}

function ebmlHeader(){
  return el(ID.EBML, cat([
    elU(ID.EBMLVersion,1), elU(ID.EBMLReadVersion,1), elU(ID.EBMLMaxIDLength,4), elU(ID.EBMLMaxSizeLength,8),
    elS(ID.DocType,'webm'), elU(ID.DocTypeVersion,2), elU(ID.DocTypeReadVersion,2) ]));
}

function buildPre({ tracks, metadata, durationMs=0, timestampScaleNs=1_000_000 }){
  const infoParts=[ elU(ID.TimestampScale,timestampScaleNs) ];
  if(durationMs>0) infoParts.push(el(ID.Duration, f8(durationMs)));
  infoParts.push(elS(ID.MuxingApp,'chromapakz'), elS(ID.WritingApp,'chromapakz'));
  const pre=[ el(ID.Info, cat(infoParts)), el(ID.Tracks, cat(tracks.map(trackEntry))) ];
  if(metadata!=null){
    const tag = el(ID.Tag, cat([ el(ID.Targets, new Uint8Array(0)),
      el(ID.SimpleTag, cat([ elS(ID.TagName,'CHROMAPAKZ'), elS(ID.TagString, JSON.stringify(metadata)) ])) ]));
    pre.push(el(ID.Tags, tag));
  }
  return cat(pre);
}

function cueTrackOf(tracks){
  const rgb=tracks.find(t=>t.name==='rgb');
  return rgb ? rgb.number : tracks[0].number;
}

function clusterize(frames, tracks, clusterSpanMs=30_000, segOffsetStart=0){
  const cueTrack=cueTrackOf(tracks);
  const ordered=[...frames].sort((a,b)=> a.timeMs-b.timeMs);
  let off=segOffsetStart;
  const clusterEls=[], cues=[];
  let cur=null, base=0, hasCue=false;
  const flush=()=>{ if(!cur) return;
    const e=el(ID.Cluster, cat([elU(ID.Timestamp, base), ...cur]));
    if(hasCue) cues.push({ t:base, pos:off }); off+=e.length; clusterEls.push(e); cur=null; };
  for(const f of ordered){
    const cueKey=f.track===cueTrack && f.key;
    if(cur && (cueKey || f.timeMs-base>=clusterSpanMs)) flush();
    if(!cur){ cur=[]; base=f.timeMs; hasCue=false; }
    if(cueKey) hasCue=true;
    cur.push(simpleBlock(f.track, f.timeMs-base, f.key, f.data));
  }
  flush();
  return { clusterEls, cues, segOffset: off };
}

// frames: [{track, key, timeMs, data:Uint8Array}] across all tracks, any order.
// tracks: [{number, codecID, name, width, height}]. metadata: JSON-serializable or null.
// durationMs: total length (enables a correct <video> timeline). Clusters start on a keyframe of the
// "cue" track (the RGB track if present), and a Cues index points at them → seekable playback.
export function mux({ tracks, frames, metadata, durationMs=0, timestampScaleNs=1_000_000, clusterSpanMs=30_000 }){
  const pre=buildPre({ tracks, metadata, durationMs, timestampScaleNs });
  const { clusterEls, cues }=clusterize(frames, tracks, clusterSpanMs, pre.length);
  const segParts=[pre, ...clusterEls];
  if(cues.length){
    const cueTrack=cueTrackOf(tracks);
    segParts.push(el(ID.Cues, cat(cues.map(c =>
      el(ID.CuePoint, cat([ elU(ID.CueTime, c.t),
        el(ID.CueTrackPositions, cat([ elU(ID.CueTrack, cueTrack), elU(ID.CueClusterPosition, c.pos) ])) ]))))));
  }
  return cat([ebmlHeader(), el(ID.Segment, cat(segParts))]);
}

// ── incremental mux (network streaming) ──
/** Emit header immediately, then cluster bytes per frame; Cues on finish(). */
// Timed text needs a duration, which SimpleBlock has nowhere to put, so cues go in a
// BlockGroup. WebM frames a WebVTT block as `identifier \n settings \n payload`; drop
// the newlines and a reader takes the whole block as the identifier, so every cue
// extracts empty while the file still parses.
function textBlockGroup(track, relTime, durMs, text){
  const tc=new Uint8Array(2); new DataView(tc.buffer).setInt16(0, relTime, false);
  const payload=new TextEncoder().encode('\n\n'+text);
  const block=el(ID.Block, cat([vint(track), tc, Uint8Array.of(0x00), payload]));
  return el(ID.BlockGroup, durMs>0 ? cat([block, elU(ID.BlockDuration, durMs)]) : block);
}

export function createStreamMux({ tracks, metadata, durationMs=0, timestampScaleNs=1_000_000, clusterSpanMs=30_000 }){
  const cueTrack=cueTrackOf(tracks);
  const pre=buildPre({ tracks, metadata, durationMs, timestampScaleNs });
  let segOffset=pre.length;
  let cur=null, base=0, hasCue=false;
  const cues=[];

  const flushCluster=()=>{
    if(!cur) return null;
    const body=el(ID.Cluster, cat([elU(ID.Timestamp, base), ...cur]));
    if(hasCue) cues.push({ t:base, pos:segOffset });
    segOffset+=body.length; cur=null;
    return body;
  };

  // The Segment size is always "unknown": clusters are appended after the header is handed to the
  // caller, so no finite size written here could cover them — a fixed size would place every later
  // cluster outside the Segment, where demuxers (ours included) never look.
  const header=cat([ebmlHeader(), cat([idBytes(ID.Segment), vintUnknown(8), pre])]);

  return {
    /** File prefix: EBML + Segment header (Info, Tracks, Tags). */
    header,

    /** Append one SimpleBlock; returns a new Cluster element when the previous cluster closes. */
    writeFrame(frame){
      const out=[];
      const cueKey=frame.track===cueTrack && frame.key;
      if(cur && (cueKey || frame.timeMs-base>=clusterSpanMs)){
        const c=flushCluster(); if(c) out.push(c);
      }
      if(!cur){ cur=[]; base=frame.timeMs; hasCue=false; }
      if(cueKey) hasCue=true;
      cur.push(simpleBlock(frame.track, frame.timeMs-base, frame.key, frame.data));
      return out.length ? cat(out) : null;
    },

    /** Append one timed-text cue. Text never drives cluster boundaries — those belong to
        the cue track — so this only forces a new cluster when the relative timestamp would
        not fit the int16 a Block header allows. */
    writeText(track, timeMs, durMs, text){
      const out=[];
      if(cur){ const rel=timeMs-base; if(rel<-32768 || rel>32767){ const c=flushCluster(); if(c) out.push(c); } }
      if(!cur){ cur=[]; base=timeMs; hasCue=false; }
      cur.push(textBlockGroup(track, timeMs-base, durMs, text));
      return out.length ? cat(out) : null;
    },

    /** Flush the open cluster and append the Cues index. */
    finish(finalDurationMs=0){
      const out=[];
      const tail=flushCluster(); if(tail) out.push(tail);
      if(cues.length){
        out.push(el(ID.Cues, cat(cues.map(c =>
          el(ID.CuePoint, cat([ elU(ID.CueTime, c.t),
            el(ID.CueTrackPositions, cat([ elU(ID.CueTrack, cueTrack), elU(ID.CueClusterPosition, c.pos) ])) ]))))));
      }
      if(finalDurationMs>0 && durationMs===0){
        // Duration was omitted in header; seekable players need Cues (above). Duration patch not supported.
      }
      return out.length ? cat(out) : new Uint8Array(0);
    },

    get cues(){ return cues; },
  };
}

// ── decoder ──
// Two failure modes must stay distinguishable, because the streaming demuxer sees every file
// in a truncated state on the way to being complete:
//   corrupt    — the bytes we already hold cannot be valid WebM ⇒ WebMCorruptError (permanent;
//                appending more bytes can never repair a byte that is already wrong).
//   incomplete — the structure is fine so far but an element runs past the end of what we hold
//                ⇒ parse what we can, set `truncated`, never invent values from missing bytes.
/** Thrown when a buffer is structurally invalid WebM (as opposed to merely truncated). */
export class WebMCorruptError extends Error {
  constructor(msg){ super(msg); this.name='WebMCorruptError'; }
}
const corrupt = msg => { throw new WebMCorruptError(msg); };

const EBML_MAX_ID_LEN=4, EBML_MAX_SIZE_LEN=8;

// Master (container) elements: their children are independently parseable, so a master whose
// declared size overruns the buffer can still be descended into. Leaf elements cannot.
const MASTER=new Set([ID.EBML, ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video,
  ID.Tags, ID.Tag, ID.Targets, ID.SimpleTag, ID.Cluster, ID.Cues, ID.CuePoint, ID.CueTrackPositions]);

// Level-1 elements (direct children of Segment) plus the two top-level ones. An unknown-size
// Cluster ends where one of these begins — that is the only way to find its end.
const SEEK_HEAD=0x114D9B74, CHAPTERS=0x1043A770, ATTACHMENTS=0x1941A469, VOID=0xEC;
const LEVEL1=new Set([ID.Info, ID.Tracks, ID.Tags, ID.Cluster, ID.Cues,
  SEEK_HEAD, CHAPTERS, ATTACHMENTS, ID.EBML, ID.Segment]);

// readId/readSize return null when the descriptor runs past `end` (incomplete) and throw when the
// descriptor itself is malformed (corrupt). Neither ever indexes past `end`.
function readId(buf,p,end){
  if(p>=end) return null;
  const first=buf[p];
  let L=1, m=0x80; while(L<=EBML_MAX_ID_LEN && !(first&m)){ m>>=1; L++; }
  if(L>EBML_MAX_ID_LEN) corrupt(`invalid EBML id at ${p}: no length marker in ${EBML_MAX_ID_LEN} bytes`);
  if(p+L>end) return null;
  let id=0; for(let k=0;k<L;k++) id=id*256+buf[p+k];
  return {id, len:L};
}
function readSize(buf,p,end){
  if(p>=end) return null;
  const first=buf[p];
  let L=1, m=0x80; while(L<=EBML_MAX_SIZE_LEN && !(first&m)){ m>>=1; L++; }
  if(L>EBML_MAX_SIZE_LEN) corrupt(`invalid EBML size at ${p}: no length marker in ${EBML_MAX_SIZE_LEN} bytes`);
  if(p+L>end) return null;
  let v=first & (m-1); for(let k=1;k<L;k++) v=v*256+buf[p+k];
  const max=(2**(7*L))-1;
  return { size:v===max ? Infinity : v, len:L, unknown:v===max };
}
const readUint=(buf,s,e)=>{ let v=0; for(let k=s;k<e;k++) v=v*256+buf[k]; return v; };
// EBML floats are 4 or 8 bytes, big-endian; anything else is malformed → NaN.
const readFloat=(buf,s,e)=>{
  const n=e-s;
  if(n!==4 && n!==8) return NaN;
  const dv=new DataView(buf.buffer, buf.byteOffset+s, n);
  return n===4 ? dv.getFloat32(0,false) : dv.getFloat64(0,false);
};

// End of an unknown-size Cluster: scan its children until a level-1 element (the next Cluster,
// Cues, …) starts. Live/foreign WebM writes clusters this way; the old code gave up at the first
// one and dropped the rest of the file.
function unknownClusterEnd(buf,start,end){
  let p=start;
  while(p<end){
    const a=readId(buf,p,end); if(!a) return end;
    if(LEVEL1.has(a.id)) return p;
    const b=readSize(buf,p+a.len,end); if(!b) return end;
    if(b.unknown) return end;              // nested unknown size inside a cluster: give up here
    p=p+a.len+b.len+b.size;
  }
  return end;
}

// Iterate the children of a master element. `ctx.truncated` is set when the scan stops early
// because the buffer ends mid-element.
function* children(buf,start,end,ctx={}){
  let p=start;
  while(p<end){
    const a=readId(buf,p,end); if(!a){ ctx.truncated=true; return; }
    const b=readSize(buf,p+a.len,end); if(!b){ ctx.truncated=true; return; }
    const dStart=p+a.len+b.len;
    if(b.unknown){
      // An unknown-size Segment legitimately runs to EOF; an unknown-size Cluster ends where the
      // next level-1 element starts, and only counts as truncated if we never found one.
      const isCluster=a.id===ID.Cluster;
      const dEnd=isCluster ? unknownClusterEnd(buf,dStart,end) : end;
      if(isCluster && dEnd>=end) ctx.truncated=true;
      yield {id:a.id, dStart, dEnd, size:b.size, unknown:true, hdrLen:a.len+b.len};
      p=dEnd>p ? dEnd : end;                         // never rewind on a zero-length unknown element
      continue;
    }
    const dEnd=dStart+b.size;
    if(dEnd>end){
      ctx.truncated=true;
      // A truncated master still yields whatever children are present (this is how a fixed-size
      // Segment surrenders its metadata before the file finishes arriving); a truncated leaf's
      // bytes are simply not there, so it is dropped rather than read short.
      if(MASTER.has(a.id)) yield {id:a.id, dStart, dEnd:end, size:b.size, unknown:false, hdrLen:a.len+b.len, truncated:true};
      return;
    }
    yield {id:a.id, dStart, dEnd, size:b.size, unknown:false, hdrLen:a.len+b.len};
    p=dEnd;
  }
}

const SUPPORTED_DOCTYPES=new Set(['webm','matroska']);
function checkDocType(buf, hdr, ctx){
  for(const f of children(buf,hdr.dStart,hdr.dEnd,ctx)) if(f.id===ID.DocType){
    const dt=new TextDecoder().decode(buf.subarray(f.dStart,f.dEnd)).replace(/\0+$/,'');
    if(!SUPPORTED_DOCTYPES.has(dt)) corrupt(`unsupported EBML DocType ${JSON.stringify(dt)}`);
    return dt;
  }
  return null;
}

function walkColour(buf, s, e, ctx){
  const c={};
  for(const f of children(buf,s,e,ctx)){
    if(f.id===ID.MatrixCoefficients) c.matrix=readUint(buf,f.dStart,f.dEnd);
    else if(f.id===ID.BitsPerChannel) c.bits=readUint(buf,f.dStart,f.dEnd);
    else if(f.id===ID.Range) c.range=readUint(buf,f.dStart,f.dEnd);
    else if(f.id===ID.TransferCharacteristics) c.transfer=readUint(buf,f.dStart,f.dEnd);
    else if(f.id===ID.Primaries) c.primaries=readUint(buf,f.dStart,f.dEnd);
    else if(f.id===ID.MaxCLL) c.maxCLL=readUint(buf,f.dStart,f.dEnd);
    else if(f.id===ID.MaxFALL) c.maxFALL=readUint(buf,f.dStart,f.dEnd);
    else if(f.id===ID.MasteringMetadata){
      const m={};
      const put={ [ID.PrimaryRChromaticityX]:'rx', [ID.PrimaryRChromaticityY]:'ry',
        [ID.PrimaryGChromaticityX]:'gx', [ID.PrimaryGChromaticityY]:'gy',
        [ID.PrimaryBChromaticityX]:'bx', [ID.PrimaryBChromaticityY]:'by',
        [ID.WhitePointChromaticityX]:'wx', [ID.WhitePointChromaticityY]:'wy',
        [ID.LuminanceMax]:'maxLum', [ID.LuminanceMin]:'minLum' };
      for(const g of children(buf,f.dStart,f.dEnd,ctx))
        if(put[g.id]) m[put[g.id]]=readFloat(buf,g.dStart,g.dEnd);
      c.mastering=m;
    }
  }
  return c;
}

function walkTracks(buf, tracks, s, e, ctx){
  for(const c of children(buf,s,e,ctx)) if(c.id===ID.TrackEntry){
    const t={}; for(const f of children(buf,c.dStart,c.dEnd,ctx)){
      if(f.id===ID.TrackNumber) t.number=readUint(buf,f.dStart,f.dEnd);
      else if(f.id===ID.CodecID) t.codecID=new TextDecoder().decode(buf.subarray(f.dStart,f.dEnd));
      else if(f.id===ID.Name) t.name=new TextDecoder().decode(buf.subarray(f.dStart,f.dEnd));
      else if(f.id===ID.Video) for(const v of children(buf,f.dStart,f.dEnd,ctx)){
        if(v.id===ID.PixelWidth) t.width=readUint(buf,v.dStart,v.dEnd);
        if(v.id===ID.PixelHeight) t.height=readUint(buf,v.dStart,v.dEnd);
        if(v.id===ID.Colour) t.colour=walkColour(buf,v.dStart,v.dEnd,ctx); } }
    if(t.number===undefined) continue;                 // TrackNumber not (yet) present
    t.frames=[]; tracks[t.number]=t; }
}

function walkTags(buf, out, s, e, ctx){
  for(const tag of children(buf,s,e,ctx)) if(tag.id===ID.Tag)
    for(const st of children(buf,tag.dStart,tag.dEnd,ctx)) if(st.id===ID.SimpleTag){
      let name=null,val=null; for(const f of children(buf,st.dStart,st.dEnd,ctx)){
        if(f.id===ID.TagName) name=new TextDecoder().decode(buf.subarray(f.dStart,f.dEnd));
        if(f.id===ID.TagString) val=new TextDecoder().decode(buf.subarray(f.dStart,f.dEnd)); }
      if(name==='CHROMAPAKZ' && val!=null){
        // The tag element parsed whole, so `val` is the complete string: bad JSON here is
        // corruption, not a short read, and must not look like "metadata hasn't arrived yet".
        try{ out.metadata=JSON.parse(val); }
        catch(err){ corrupt(`CHROMAPAKZ metadata is not valid JSON: ${err.message}`); }
      } }
}

// Split a (Simple)Block payload into its constituent frames, honouring the lacing flags.
// Lacing is bits 1–2 of the flags byte: 0 none, 1 Xiph, 2 fixed-size, 3 EBML.
function laceFrames(buf, p, end, flags){
  const lacing=(flags>>1)&0x03;
  if(lacing===0) return [[p, end]];
  if(p>=end) corrupt('laced block truncated before the frame count');
  const count=buf[p]+1; p+=1;
  const sizes=[];
  if(lacing===2){                                            // fixed-size: equal split
    const total=end-p;
    if(total % count) corrupt(`fixed-lace block of ${total} bytes does not divide into ${count} frames`);
    for(let k=0;k<count;k++) sizes.push(total/count);
  }else if(lacing===1){                                      // Xiph: 255-terminated byte runs
    for(let k=0;k<count-1;k++){
      let n=0, b;
      do{ if(p>=end) corrupt('Xiph lace size runs past the block'); b=buf[p++]; n+=b; }while(b===255);
      sizes.push(n);
    }
  }else{                                                     // EBML: first absolute, rest signed deltas
    const first=readSize(buf,p,end); if(!first) corrupt('EBML lace size runs past the block');
    if(first.unknown) corrupt('EBML lace size is the reserved unknown value');
    sizes.push(first.size); p+=first.len;
    for(let k=1;k<count-1;k++){
      const d=readSize(buf,p,end); if(!d) corrupt('EBML lace size runs past the block');
      if(d.unknown) corrupt('EBML lace size is the reserved unknown value');
      const delta=d.size-((2**(7*d.len-1))-1);               // signed vint bias
      const next=sizes[sizes.length-1]+delta;
      if(next<0) corrupt('EBML lace delta yields a negative frame size');
      sizes.push(next); p+=d.len;
    }
  }
  if(lacing!==2){                                            // last frame takes the remainder
    const used=sizes.reduce((a,b)=>a+b,0);
    const rest=end-p-used;
    if(rest<0) corrupt('lace frame sizes exceed the block payload');
    sizes.push(rest);
  }
  const out=[];
  for(const n of sizes){ if(p+n>end) corrupt('lace frame runs past the block'); out.push([p, p+n]); p+=n; }
  return out;
}

// One (Simple)Block payload [s,e) → its frames. `base` is the enclosing cluster's timestamp.
// Lacing means one block can carry several frames; chromapakz never writes it, foreign WebM does.
// The payload is always complete by the time this runs (both callers buffer the whole element), so
// a header that doesn't fit is corruption rather than a short read.
function readSimpleBlock(buf, s, e, base){
  const tv=readSize(buf,s,e);
  if(!tv) corrupt('SimpleBlock truncated in its track number');
  if(tv.unknown) corrupt('SimpleBlock track number is the reserved unknown value');
  const track=tv.size; let p=s+tv.len;
  if(p+3>e) corrupt('SimpleBlock truncated in its header');
  const rel=(buf[p]<<24>>16) | buf[p+1]; p+=2;             // big-endian int16
  const flags=buf[p]; p+=1;
  // Laced frames share the block timestamp (spacing them needs DefaultDuration, which this
  // subset does not carry).
  return laceFrames(buf, p, e, flags).map(([fs, fe]) =>
    ({ track, key:!!(flags&0x80), timeMs:base+rel, data:new Uint8Array(buf.subarray(fs,fe)) }));
}

function walkCluster(buf, tracks, outFrames, s, e, ctx){
  let base=0; const blocks=[];
  for(const c of children(buf,s,e,ctx)){
    if(c.id===ID.Timestamp) base=readUint(buf,c.dStart,c.dEnd);
    else if(c.id===ID.SimpleBlock){
      for(const fr of readSimpleBlock(buf, c.dStart, c.dEnd, base)){
        blocks.push(fr); outFrames.push(fr);
        if(tracks[fr.track]) tracks[fr.track].frames.push(fr);
      } }
  }
  return blocks;
}

/**
 * Parse a (possibly partial) WebM buffer.
 * @returns {{tracks:object, metadata:any, frames:Array, truncated:boolean}} `truncated` is true
 *   when the buffer ends mid-element — the result holds everything that did parse.
 * @throws {WebMCorruptError} when the bytes cannot be valid WebM.
 */
export function demux(buf){
  const tracks={}; const ctx={truncated:false};
  const out={tracks, metadata:null, frames:[], truncated:false};
  // Every WebM file opens with an EBML header, so the first id alone settles "is this WebM?" —
  // check it before the scan, since a non-WebM file is usually also structurally incomplete and
  // would otherwise come back as a plausible-looking empty result.
  const lead=readId(buf,0,buf.length);
  if(lead && lead.id!==ID.EBML) corrupt(`expected an EBML header, got element 0x${lead.id.toString(16)}`);
  for(const top of children(buf,0,buf.length,ctx)){
    if(top.id===ID.EBML){
      if(!top.truncated) checkDocType(buf, top, ctx);
    }else if(top.id===ID.Segment){
      for(const c of children(buf,top.dStart,top.dEnd,ctx)){
        if(c.id===ID.Tracks) walkTracks(buf, tracks, c.dStart, c.dEnd, ctx);
        else if(c.id===ID.Tags) walkTags(buf, out, c.dStart, c.dEnd, ctx);
        else if(c.id===ID.Cluster) walkCluster(buf, tracks, out.frames, c.dStart, c.dEnd, ctx); }
    }else if(top.id!==VOID){
      corrupt(`unexpected top-level element 0x${top.id.toString(16)}`);
    }
  }
  out.truncated=ctx.truncated;
  return out;
}

// ── incremental demux (network streaming) ──
const MORE=Symbol('need more bytes');
const BlockGroup=0xA0;
// Masters we parse child-by-child rather than as one buffered blob: everything else must be
// complete before it is handled, so descending here is what bounds retention to one element.
const DESCEND=new Set([ID.Segment, ID.Cluster]);
// A Cluster written with unknown size ends at the first ID that cannot be one of its children.
const CLUSTER_CHILD=new Set([ID.Timestamp, ID.SimpleBlock, BlockGroup]);

/**
 * Read one element header at `p` without requiring the payload. MORE when the header itself is
 * still in flight; a malformed descriptor throws (via the shared readers), since no later byte
 * can repair it.
 */
function peekElement(buf, p, end){
  const a=readId(buf,p,end); if(!a) return MORE;
  const b=readSize(buf,p+a.len,end); if(!b) return MORE;
  return { id:a.id, hdrLen:a.len+b.len, size:b.unknown?0:b.size, unknown:b.unknown };
}

/**
 * Push byte chunks; each returns the events that just became parseable — 'metadata' as soon as the
 * Tags element completes, then a 'block' per SimpleBlock, as it arrives. Only fully-buffered
 * elements are handled, so a block event always carries a complete VP9 frame.
 *
 * Bytes are parsed once and released: the retained buffer never exceeds the largest element still
 * being assembled, so a long stream costs neither quadratic CPU nor full-file memory.
 *
 * `tracks` carries the TrackEntry descriptions only — unlike demux(), per-track `frames` arrays are
 * left empty, since accumulating every frame forever is exactly what streaming exists to avoid.
 *
 * push()/finish() throw WebMCorruptError once the bytes cannot be valid WebM. Incomplete is not an
 * error — the parser simply waits — but corruption is latched and rethrown rather than swallowed,
 * so a caller awaiting metadata that will never come finds out instead of waiting forever.
 */
export function createStreamDemux(){
  let buf=new Uint8Array(0);   // unconsumed tail of the stream
  let base=0;                  // stream offset of buf[0]
  let pos=0;                   // stream offset of the parse cursor
  const stack=[];              // masters we descended into: { id, end } (end=Infinity if unknown)
  const tracks={};
  const out={ metadata:null };
  let clusterBase=0, metaSent=false, ended=false, sawHeader=false, fatal=null;

  function parse(events){
    try{
      for(;;){
        while(stack.length && pos>=stack.at(-1).end) stack.pop();
        const e=peekElement(buf, pos-base, buf.length);
        if(e===MORE) break;

        // A WebM file opens with an EBML header; anything else at top level isn't WebM at all.
        if(!stack.length && !sawHeader){
          if(e.id!==ID.EBML) corrupt(`expected an EBML header, got element 0x${e.id.toString(16)}`);
          sawHeader=true;
        }

        const top=stack.at(-1);
        const inCluster=top?.id===ID.Cluster;
        if(inCluster && top.end===Infinity && !CLUSTER_CHILD.has(e.id)){ stack.pop(); continue; }

        const dStart=pos+e.hdrLen;
        if(DESCEND.has(e.id)){
          stack.push({ id:e.id, end: e.unknown ? Infinity : dStart+e.size });
          if(e.id===ID.Cluster) clusterBase=0;
          pos=dStart;
          continue;
        }
        if(e.unknown) corrupt('unknown size on a leaf element leaves nothing to resync on');
        const dEnd=dStart+e.size;
        if(dEnd-base>buf.length) break;       // payload still in flight

        // The element is whole, so anything wrong inside it is corruption, not a short read.
        const s=dStart-base, t=dEnd-base;
        if(e.id===ID.EBML) checkDocType(buf, { dStart:s, dEnd:t }, {});
        else if(e.id===ID.Tracks) walkTracks(buf, tracks, s, t, {});
        else if(e.id===ID.Tags){
          walkTags(buf, out, s, t, {});
          if(out.metadata && !metaSent){ metaSent=true; events.push({ type:'metadata', metadata:out.metadata }); }
        }
        else if(inCluster && e.id===ID.Timestamp) clusterBase=readUint(buf, s, t);
        else if(inCluster && e.id===ID.SimpleBlock){
          for(const block of readSimpleBlock(buf, s, t, clusterBase)) events.push({ type:'block', block });
        }
        pos=dEnd;
      }
    }catch(err){
      if(err instanceof WebMCorruptError){ fatal=err; buf=new Uint8Array(0); base=pos; }  // stop retaining bytes
      throw err;
    }
    if(pos>base){ buf=buf.subarray(pos-base); base=pos; }   // release everything already parsed
  }

  return {
    get metadata(){ return out.metadata; },
    get tracks(){ return tracks; },
    get done(){ return ended; },
    /** The latched WebMCorruptError, if the stream has been found unparseable. */
    get error(){ return fatal; },

    push(chunk){
      if(fatal) throw fatal;               // nothing after a malformed element can be trusted
      if(!(chunk instanceof Uint8Array)) chunk=new Uint8Array(chunk);
      buf=cat([buf, chunk]);               // copies, so a caller reusing its chunk can't corrupt us
      const events=[];
      parse(events);
      return events;
    },

    finish(){
      ended=true;
      if(fatal) throw fatal;
      const events=[];
      parse(events);          // a trailing element completed by the last push still counts
      events.push({ type:'end' });
      return events;
    },
  };
}

/** Reassemble chunked output from createStreamMux into one buffer (for tests). */
export function concatChunks(chunks){
  return cat(chunks.filter(c=>c && c.length));
}
