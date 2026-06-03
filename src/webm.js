// Minimal pure-JS Matroska/WebM muxer + demuxer for the subset chromapakz needs:
// multiple VP9 video tracks, one cluster-split timeline, and a metadata tag.
// No dependencies, no WASM. Sizes are computed bottom-up (whole file buffered in memory).

// ── EBML element IDs (stored with their length-marker bits, as on disk) ──
const ID = {
  EBML:0x1A45DFA3, EBMLVersion:0x4286, EBMLReadVersion:0x42F7, EBMLMaxIDLength:0x42F2,
  EBMLMaxSizeLength:0x42F3, DocType:0x4282, DocTypeVersion:0x4287, DocTypeReadVersion:0x4285,
  Segment:0x18538067, Info:0x1549A966, TimestampScale:0x2AD7B1, MuxingApp:0x4D80, WritingApp:0x5741,
  Tracks:0x1654AE6B, TrackEntry:0xAE, TrackNumber:0xD7, TrackUID:0x73C5, TrackType:0x83,
  FlagLacing:0x9C, CodecID:0x86, Name:0x536E, Video:0xE0, PixelWidth:0xB0, PixelHeight:0xBA,
  Tags:0x1254C367, Tag:0x7373, Targets:0x63C0, SimpleTag:0x67C8, TagName:0x45A3, TagString:0x4487,
  Cluster:0x1F43B675, Timestamp:0xE7, SimpleBlock:0xA3, Duration:0x4489,
  Cues:0x1C53BB6B, CuePoint:0xBB, CueTime:0xB3, CueTrackPositions:0xB7, CueTrack:0xF7, CueClusterPosition:0xF1,
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

function trackEntry({number, codecID, name, width, height}){
  const parts=[ elU(ID.TrackNumber,number), elU(ID.TrackUID,number), elU(ID.TrackType,1),
    elU(ID.FlagLacing,0), elS(ID.CodecID,codecID) ];
  if(name) parts.push(elS(ID.Name,name));
  if(width&&height) parts.push(el(ID.Video, cat([elU(ID.PixelWidth,width), elU(ID.PixelHeight,height)])));
  return el(ID.TrackEntry, cat(parts));
}
function simpleBlock(track, relTime, key, data){
  const tc=new Uint8Array(2); const dv=new DataView(tc.buffer); dv.setInt16(0, relTime, false);
  const flags=Uint8Array.of(key?0x80:0x00);
  return el(ID.SimpleBlock, cat([vint(track), tc, flags, data])); // track# as vint (small → 1 byte)
}

// frames: [{track, key, timeMs, data:Uint8Array}] across all tracks, any order.
// tracks: [{number, codecID, name, width, height}]. metadata: JSON-serializable or null.
// durationMs: total length (enables a correct <video> timeline). Clusters start on a keyframe of the
// "cue" track (the RGB track if present), and a Cues index points at them → seekable playback.
export function mux({ tracks, frames, metadata, durationMs=0, timestampScaleNs=1_000_000, clusterSpanMs=30_000 }){
  const header = el(ID.EBML, cat([
    elU(ID.EBMLVersion,1), elU(ID.EBMLReadVersion,1), elU(ID.EBMLMaxIDLength,4), elU(ID.EBMLMaxSizeLength,8),
    elS(ID.DocType,'webm'), elU(ID.DocTypeVersion,2), elU(ID.DocTypeReadVersion,2) ]));
  const infoParts=[ elU(ID.TimestampScale,timestampScaleNs) ];
  if(durationMs>0) infoParts.push(el(ID.Duration, f8(durationMs)));
  infoParts.push(elS(ID.MuxingApp,'chromapakz'), elS(ID.WritingApp,'chromapakz'));
  const pre=[ el(ID.Info, cat(infoParts)), el(ID.Tracks, cat(tracks.map(trackEntry))) ];
  if(metadata!=null){
    const tag = el(ID.Tag, cat([ el(ID.Targets, new Uint8Array(0)),
      el(ID.SimpleTag, cat([ elS(ID.TagName,'CHROMAPAKZ'), elS(ID.TagString, JSON.stringify(metadata)) ])) ]));
    pre.push(el(ID.Tags, tag));
  }
  const rgb = tracks.find(t=>t.name==='rgb');
  const cueTrack = rgb ? rgb.number : tracks[0].number;

  // Build clusters, starting a new one at each cue-track keyframe (also cap span to keep timecodes
  // within int16). Track each cluster's byte offset from the start of the Segment data, for the Cues.
  const ordered=[...frames].sort((a,b)=> a.timeMs-b.timeMs);
  let off = pre.reduce((a,b)=>a+b.length,0);   // offset of the first cluster (Segment-data-relative)
  const clusterEls=[], cues=[];
  let cur=null, base=0, hasCue=false;
  const flush=()=>{ if(!cur) return;
    const e=el(ID.Cluster, cat([elU(ID.Timestamp, base), ...cur]));
    if(hasCue) cues.push({ t:base, pos:off }); off+=e.length; clusterEls.push(e); cur=null; };
  for(const f of ordered){
    const cueKey = f.track===cueTrack && f.key;
    if(cur && (cueKey || f.timeMs-base>=clusterSpanMs)) flush();
    if(!cur){ cur=[]; base=f.timeMs; hasCue=false; }
    if(cueKey) hasCue=true;
    cur.push(simpleBlock(f.track, f.timeMs-base, f.key, f.data));
  }
  flush();

  const segChildren=[...pre, ...clusterEls];
  if(cues.length) segChildren.push(el(ID.Cues, cat(cues.map(c =>
    el(ID.CuePoint, cat([ elU(ID.CueTime, c.t),
      el(ID.CueTrackPositions, cat([ elU(ID.CueTrack, cueTrack), elU(ID.CueClusterPosition, c.pos) ])) ]))))));
  return cat([header, el(ID.Segment, cat(segChildren))]);
}

// ── decoder ──
function readId(buf,p){ const first=buf[p]; let L=1, m=0x80; while(L<=4 && !(first&m)){ m>>=1; L++; }
  let id=0; for(let k=0;k<L;k++) id=id*256+buf[p+k]; return {id, len:L}; }
function readSize(buf,p){ const first=buf[p]; let L=1, m=0x80; while(L<=8 && !(first&m)){ m>>=1; L++; }
  let v=first & (m-1); for(let k=1;k<L;k++) v=v*256+buf[p+k]; return {size:v, len:L}; }
const readUint=(buf,s,e)=>{ let v=0; for(let k=s;k<e;k++) v=v*256+buf[k]; return v; };

// Recursively collect children of a master element into a flat list of {id,start,end}.
function* children(buf,start,end){ let p=start;
  while(p<end){ const a=readId(buf,p); const b=readSize(buf,p+a.len); const dStart=p+a.len+b.len;
    yield {id:a.id, dStart, dEnd:dStart+b.size}; p=dStart+b.size; } }

const MASTERS=new Set([ID.Segment,ID.Tracks,ID.TrackEntry,ID.Video,ID.Tags,ID.Tag,ID.SimpleTag,ID.Cluster,ID.Info]);

export function demux(buf){
  const tracks={}; const out={tracks, metadata:null, frames:[]};
  function walkTracks(s,e){ for(const c of children(buf,s,e)) if(c.id===ID.TrackEntry){
    const t={}; for(const f of children(buf,c.dStart,c.dEnd)){
      if(f.id===ID.TrackNumber) t.number=readUint(buf,f.dStart,f.dEnd);
      else if(f.id===ID.CodecID) t.codecID=new TextDecoder().decode(buf.subarray(f.dStart,f.dEnd));
      else if(f.id===ID.Name) t.name=new TextDecoder().decode(buf.subarray(f.dStart,f.dEnd));
      else if(f.id===ID.Video) for(const v of children(buf,f.dStart,f.dEnd)){
        if(v.id===ID.PixelWidth) t.width=readUint(buf,v.dStart,v.dEnd);
        if(v.id===ID.PixelHeight) t.height=readUint(buf,v.dStart,v.dEnd); } }
    t.frames=[]; tracks[t.number]=t; } }
  function walkTags(s,e){ for(const tag of children(buf,s,e)) if(tag.id===ID.Tag)
    for(const st of children(buf,tag.dStart,tag.dEnd)) if(st.id===ID.SimpleTag){
      let name=null,val=null; for(const f of children(buf,st.dStart,st.dEnd)){
        if(f.id===ID.TagName) name=new TextDecoder().decode(buf.subarray(f.dStart,f.dEnd));
        if(f.id===ID.TagString) val=new TextDecoder().decode(buf.subarray(f.dStart,f.dEnd)); }
      if(name==='CHROMAPAKZ') out.metadata=JSON.parse(val); } }
  function walkCluster(s,e){ let base=0;
    for(const c of children(buf,s,e)){
      if(c.id===ID.Timestamp) base=readUint(buf,c.dStart,c.dEnd);
      else if(c.id===ID.SimpleBlock){ let p=c.dStart;
        const tv=readSize(buf,p); const track=tv.size; p+=tv.len;       // track# is a vint
        const dv=new DataView(buf.buffer, buf.byteOffset+p, 2); const rel=dv.getInt16(0,false); p+=2;
        const flags=buf[p]; p+=1; const data=buf.subarray(p,c.dEnd);
        const fr={track, key:!!(flags&0x80), timeMs:base+rel, data};
        out.frames.push(fr); if(tracks[track]) tracks[track].frames.push(fr); } } }
  // top level: EBML header, then Segment
  for(const top of children(buf,0,buf.length)) if(top.id===ID.Segment)
    for(const c of children(buf,top.dStart,top.dEnd)){
      if(c.id===ID.Tracks) walkTracks(c.dStart,c.dEnd);
      else if(c.id===ID.Tags) walkTags(c.dStart,c.dEnd);
      else if(c.id===ID.Cluster) walkCluster(c.dStart,c.dEnd); }
  return out;
}
