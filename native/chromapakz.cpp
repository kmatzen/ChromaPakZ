// chromapakz native core: triangle-fold packing + libvpx VP9 lossless + a minimal
// Matroska/WebM mux/demux that is byte-compatible with src/webm.js.
#include "chromapakz.h"
#include <functional>
#include <future>
#include <thread>
#include <vector>
#include <string>
#include <cstring>
#include <cstdio>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <algorithm>
#include <memory>
#include <new>

#include <vpx/vpx_encoder.h>
#include <vpx/vpx_decoder.h>
#include <vpx/vp8cx.h>
#include <vpx/vp8dx.h>

namespace {
using Bytes = std::vector<uint8_t>;

// strtod on crafted metadata yields NaN/inf/1e300, and casting those to int is undefined.
// Saturate into int range first. (Geometry is separately range-checked by dimsUsable below,
// which is what actually decides whether a header describes a usable frame.)
int clampToInt(double v){
  if(std::isnan(v)) return 0;
  if(v <= (double)INT32_MIN) return INT32_MIN;
  if(v >= (double)INT32_MAX) return INT32_MAX;
  return (int)v;
}

// ── EBML element IDs (same set as src/webm.js) ──
enum : uint32_t {
  ID_EBML=0x1A45DFA3, ID_EBMLVersion=0x4286, ID_EBMLReadVersion=0x42F7, ID_EBMLMaxIDLength=0x42F2,
  ID_EBMLMaxSizeLength=0x42F3, ID_DocType=0x4282, ID_DocTypeVersion=0x4287, ID_DocTypeReadVersion=0x4285,
  ID_Segment=0x18538067, ID_Info=0x1549A966, ID_TimestampScale=0x2AD7B1, ID_MuxingApp=0x4D80, ID_WritingApp=0x5741,
  ID_Tracks=0x1654AE6B, ID_TrackEntry=0xAE, ID_TrackNumber=0xD7, ID_TrackUID=0x73C5, ID_TrackType=0x83,
  ID_FlagLacing=0x9C, ID_CodecID=0x86, ID_Name=0x536E, ID_Video=0xE0, ID_PixelWidth=0xB0, ID_PixelHeight=0xBA,
  ID_Tags=0x1254C367, ID_Tag=0x7373, ID_Targets=0x63C0, ID_SimpleTag=0x67C8, ID_TagName=0x45A3, ID_TagString=0x4487,
  ID_Cluster=0x1F43B675, ID_Timestamp=0xE7, ID_SimpleBlock=0xA3, ID_Duration=0x4489,
  ID_BlockGroup=0xA0, ID_Block=0xA1, ID_BlockDuration=0x9B,
  ID_Cues=0x1C53BB6B, ID_CuePoint=0xBB, ID_CueTime=0xB3, ID_CueTrackPositions=0xB7,
  ID_CueTrack=0xF7, ID_CueClusterPosition=0xF1,
  ID_Colour=0x55B0, ID_MatrixCoefficients=0x55B1, ID_BitsPerChannel=0x55B2, ID_Range=0x55B9,
  ID_TransferCharacteristics=0x55BA, ID_Primaries=0x55BB, ID_MaxCLL=0x55BC, ID_MaxFALL=0x55BD,
  ID_MasteringMetadata=0x55D0, ID_PrimaryRChromaticityX=0x55D1, ID_PrimaryRChromaticityY=0x55D2,
  ID_PrimaryGChromaticityX=0x55D3, ID_PrimaryGChromaticityY=0x55D4, ID_PrimaryBChromaticityX=0x55D5,
  ID_PrimaryBChromaticityY=0x55D6, ID_WhitePointChromaticityX=0x55D7, ID_WhitePointChromaticityY=0x55D8,
  ID_LuminanceMax=0x55D9, ID_LuminanceMin=0x55DA,
};

void append(Bytes& a, const Bytes& b){ a.insert(a.end(), b.begin(), b.end()); }

Bytes vint(uint64_t n){
  // EBML length vints top out at 8 bytes; without the L<8 bound a nonsense size would
  // shift by >=64, which is undefined. Payloads that big are not representable anyway.
  int L=1; while(L<8 && n >= ((1ULL<<(7*L))-1)) L++;
  uint64_t v = n + (1ULL<<(7*L)); Bytes out(L);
  for(int i=L-1;i>=0;i--){ out[i]=v&0xff; v>>=8; } return out;
}
Bytes idBytes(uint32_t id){ Bytes b; while(id){ b.insert(b.begin(), id&0xff); id>>=8; } return b; }
Bytes uintBytes(uint64_t n){ if(n==0) return Bytes{0}; Bytes b; while(n){ b.insert(b.begin(), n&0xff); n>>=8; } return b; }
Bytes strBytes(const std::string& s){ return Bytes(s.begin(), s.end()); }
Bytes f8(double v){ uint64_t u; std::memcpy(&u,&v,8); Bytes b(8); for(int i=7;i>=0;i--){ b[i]=u&0xff; u>>=8; } return b; } // EBML float (big-endian)

Bytes el(uint32_t id, const Bytes& payload){
  Bytes out = idBytes(id); Bytes sz = vint(payload.size());
  append(out, sz); append(out, payload); return out;
}
Bytes elU(uint32_t id, uint64_t n){ return el(id, uintBytes(n)); }
Bytes elS(uint32_t id, const std::string& s){ return el(id, strBytes(s)); }

// HDR display-track description: what the WebM Colour element and the VP9 profile-2 encoder
// need. `enabled` false ⇒ the track is the classic 8-bit SDR one and no Colour is written.
struct HdrMeta {
  bool enabled=false;
  int transfer=16;                 // WebM TransferCharacteristics: 16 = PQ, 18 = HLG
  int maxCll=0, maxFall=0;         // 0 = unset
  bool hasMastering=false;         // ST 2086 mastering display, below
  double rx=0, ry=0, gx=0, gy=0, bx=0, by=0, wx=0, wy=0;
  double lumMax=0, lumMin=0;
};

struct Track { int number; std::string codecID, name; int width, height; int type=1; HdrMeta colour{}; };
struct Frame { int track; bool key; int timeMs; const uint8_t* data; size_t len; };

// The container half of HDR signalling — HDR10 static metadata lives here, not in the VP9
// bitstream. Element order is fixed and mirrored by src/webm.js's colourElement(), so identical
// descriptors mux to identical bytes.
Bytes colourElement(const HdrMeta& c){
  Bytes p;
  append(p, elU(ID_MatrixCoefficients, 9));       // BT.2020 non-constant luminance
  append(p, elU(ID_BitsPerChannel, 10));
  append(p, elU(ID_Range, 1));                    // broadcast ("studio") range, the HDR10 convention
  append(p, elU(ID_TransferCharacteristics, c.transfer));
  append(p, elU(ID_Primaries, 9));                // BT.2020
  if(c.maxCll) append(p, elU(ID_MaxCLL, c.maxCll));
  if(c.maxFall) append(p, elU(ID_MaxFALL, c.maxFall));
  if(c.hasMastering){
    Bytes m;
    append(m, el(ID_PrimaryRChromaticityX, f8(c.rx))); append(m, el(ID_PrimaryRChromaticityY, f8(c.ry)));
    append(m, el(ID_PrimaryGChromaticityX, f8(c.gx))); append(m, el(ID_PrimaryGChromaticityY, f8(c.gy)));
    append(m, el(ID_PrimaryBChromaticityX, f8(c.bx))); append(m, el(ID_PrimaryBChromaticityY, f8(c.by)));
    append(m, el(ID_WhitePointChromaticityX, f8(c.wx))); append(m, el(ID_WhitePointChromaticityY, f8(c.wy)));
    append(m, el(ID_LuminanceMax, f8(c.lumMax))); append(m, el(ID_LuminanceMin, f8(c.lumMin)));
    append(p, el(ID_MasteringMetadata, m));
  }
  return el(ID_Colour, p);
}

Bytes trackEntry(const Track& t){
  Bytes p;
  append(p, elU(ID_TrackNumber, t.number)); append(p, elU(ID_TrackUID, t.number));
  append(p, elU(ID_TrackType, t.type)); append(p, elU(ID_FlagLacing, 0));
  append(p, elS(ID_CodecID, t.codecID));
  if(!t.name.empty()) append(p, elS(ID_Name, t.name));
  if(t.type==1 && t.width && t.height){ Bytes v; append(v, elU(ID_PixelWidth, t.width)); append(v, elU(ID_PixelHeight, t.height));
    if(t.colour.enabled) append(v, colourElement(t.colour));
    append(p, el(ID_Video, v)); }
  return el(ID_TrackEntry, p);
}
Bytes simpleBlock(int track, int relTime, bool key, const uint8_t* data, size_t len){
  Bytes p = vint(track);
  p.push_back((relTime>>8)&0xff); p.push_back(relTime&0xff);   // int16 big-endian
  p.push_back(key?0x80:0x00);
  p.insert(p.end(), data, data+len);
  return el(ID_SimpleBlock, p);
}

// Subtitle cues need a duration, and SimpleBlock has nowhere to put one, so timed
// text goes in a BlockGroup instead. Same wire position as a SimpleBlock otherwise.
Bytes blockGroup(int track, int relTime, int durMs, const uint8_t* data, size_t len){
  Bytes b = vint(track);
  b.push_back((relTime>>8)&0xff); b.push_back(relTime&0xff);   // int16 big-endian
  b.push_back(0x00);
  b.insert(b.end(), data, data+len);
  Bytes g; append(g, el(ID_Block, b));
  if(durMs>0) append(g, elU(ID_BlockDuration, (uint64_t)durMs));
  return el(ID_BlockGroup, g);
}

Bytes ebmlHeader(){
  Bytes hdr;
  append(hdr, elU(ID_EBMLVersion,1)); append(hdr, elU(ID_EBMLReadVersion,1));
  append(hdr, elU(ID_EBMLMaxIDLength,4)); append(hdr, elU(ID_EBMLMaxSizeLength,8));
  append(hdr, elS(ID_DocType,"webm")); append(hdr, elU(ID_DocTypeVersion,2)); append(hdr, elU(ID_DocTypeReadVersion,2));
  return el(ID_EBML, hdr);
}

// The Segment's leading elements — Info, Tracks and the CHROMAPAKZ tag. Everything a reader needs
// before the first block, which is exactly what the streaming muxer emits up front.
Bytes buildPre(const std::vector<Track>& tracks, const std::string& metadata, int durationMs){
  Bytes info; append(info, elU(ID_TimestampScale,1000000));
  if(durationMs>0) append(info, el(ID_Duration, f8((double)durationMs)));
  append(info, elS(ID_MuxingApp,"chromapakz")); append(info, elS(ID_WritingApp,"chromapakz"));
  Bytes pre; append(pre, el(ID_Info, info));

  Bytes te; for(auto& t : tracks) append(te, trackEntry(t)); append(pre, el(ID_Tracks, te));

  if(!metadata.empty()){
    Bytes st; append(st, elS(ID_TagName,"CHROMAPAKZ")); append(st, elS(ID_TagString, metadata));
    Bytes tag; append(tag, el(ID_Targets, Bytes{})); append(tag, el(ID_SimpleTag, st));
    append(pre, el(ID_Tags, el(ID_Tag, tag)));
  }
  return pre;
}

// Cue track = the RGB track if present, else the first track. Clusters start on its keyframes.
int cueTrackOf(const std::vector<Track>& tracks){
  int cueTrack = tracks.empty()?1:tracks[0].number;
  for(auto& t : tracks) if(t.name=="rgb") cueTrack=t.number;
  return cueTrack;
}

// cues: (cue time ms, byte offset of the Cluster from the start of the Segment's data).
Bytes cuesElement(const std::vector<std::pair<int,size_t>>& cues, int cueTrack){
  Bytes cb;
  for(auto& c : cues){
    Bytes tp; append(tp, elU(ID_CueTrack, cueTrack)); append(tp, elU(ID_CueClusterPosition, c.second));
    Bytes pt; append(pt, elU(ID_CueTime, c.first)); append(pt, el(ID_CueTrackPositions, tp));
    append(cb, el(ID_CuePoint, pt));
  }
  return el(ID_Cues, cb);
}

Bytes mux(const std::vector<Track>& tracks, std::vector<Frame> frames,
          const std::string& metadata, int durationMs, int clusterSpanMs=30000){
  Bytes header = ebmlHeader();
  Bytes seg = buildPre(tracks, metadata, durationMs);
  int cueTrack = cueTrackOf(tracks);

  std::stable_sort(frames.begin(), frames.end(), [](const Frame&a, const Frame&b){ return a.timeMs<b.timeMs; });
  std::vector<std::pair<int,size_t>> cues;   // (cue time ms, Segment-relative byte offset of cluster)
  Bytes blocks; int base=0; bool open=false, hasCue=false;
  auto flush=[&](){ if(!open) return;
    size_t pos=seg.size();                   // offset of this Cluster from start of Segment data
    Bytes cl; append(cl, elU(ID_Timestamp, base)); append(cl, blocks);
    append(seg, el(ID_Cluster, cl));
    if(hasCue) cues.push_back({base, pos});
    blocks.clear(); open=false; hasCue=false; };
  for(auto& f : frames){
    bool cueKey = f.track==cueTrack && f.key;
    if(open && (cueKey || f.timeMs-base>=clusterSpanMs)) flush();
    if(!open){ base=f.timeMs; open=true; hasCue=false; }
    if(cueKey) hasCue=true;
    append(blocks, simpleBlock(f.track, f.timeMs-base, f.key, f.data, f.len));
  }
  flush();

  if(!cues.empty()) append(seg, cuesElement(cues, cueTrack));
  Bytes out = header; append(out, el(ID_Segment, seg));
  return out;
}

// ── incremental mux (live recording) ──
// The counterpart of createStreamMux() in src/webm.js, and byte-compatible with it: the header
// goes out before a single frame has been encoded, then each Cluster is handed back as one whole
// element as it closes. Bytes already handed out are not retained — only the open cluster, and
// the cue index when one was asked for.
//
// The Segment size is written "unknown" (the reserved all-ones vint): clusters are appended after
// the header has already gone out over the wire, so no finite size written here could cover them,
// and a truncated recording is still a valid WebM whose blocks all sit inside the Segment.
Bytes vintUnknown(){ return Bytes{0x01,0xff,0xff,0xff,0xff,0xff,0xff,0xff}; }

struct StreamMux {
  Bytes header;                              // EBML + Segment id/unknown-size + Info/Tracks/Tags
  int cueTrack=1, clusterSpanMs=30000;
  size_t segOffset=0;                        // where the next Cluster starts within the Segment
  Bytes blocks; int base=0; bool open=false, hasCue=false;
  // Declining the index is what keeps a long recording's memory flat: nothing accumulates here
  // either, so only the encoder state and the open cluster are ever held.
  bool emitCues=true;
  std::vector<std::pair<int,size_t>> cues;

  void start(const std::vector<Track>& tracks, const std::string& metadata){
    Bytes pre = buildPre(tracks, metadata, 0);
    cueTrack = cueTrackOf(tracks);
    segOffset = pre.size();
    header = ebmlHeader();
    append(header, idBytes(ID_Segment)); append(header, vintUnknown()); append(header, pre);
  }

  Bytes closeCluster(){
    if(!open) return Bytes{};
    Bytes cl; append(cl, elU(ID_Timestamp, base)); append(cl, blocks);
    Bytes e = el(ID_Cluster, cl);
    if(hasCue && emitCues) cues.push_back({base, segOffset});
    segOffset += e.size(); blocks.clear(); open=false; hasCue=false;
    return e;
  }

  /** Append one SimpleBlock; returns the previous Cluster's bytes when this frame closes it. */
  Bytes writeFrame(const Frame& f){
    Bytes out;
    bool cueKey = f.track==cueTrack && f.key;
    if(open && (cueKey || f.timeMs-base>=clusterSpanMs)) out = closeCluster();
    if(!open){ base=f.timeMs; open=true; hasCue=false; }
    if(cueKey) hasCue=true;
    append(blocks, simpleBlock(f.track, f.timeMs-base, f.key, f.data, f.len));
    return out;
  }

  /** Append one timed-text BlockGroup. Text never drives cluster boundaries — those
      belong to the cue track — so this only forces a new cluster when the relative
      timestamp would not fit the int16 a Block header allows. */
  Bytes writeText(int track, int timeMs, int durMs, const uint8_t* data, size_t len){
    Bytes out;
    if(open){ long rel = (long)timeMs - base; if(rel < -32768 || rel > 32767) out = closeCluster(); }
    if(!open){ base=timeMs; open=true; hasCue=false; }
    // WebM frames a WebVTT block as: cue-identifier '\n' cue-settings '\n' payload.
    // Both leading fields are optional but the newlines are not — without them a
    // reader takes the whole block as the identifier and the cue extracts empty.
    Bytes framed; framed.push_back('\n'); framed.push_back('\n');
    framed.insert(framed.end(), data, data+len);
    append(blocks, blockGroup(track, timeMs-base, durMs, framed.data(), framed.size()));
    return out;
  }

  /** Flush the open cluster and append the Cues index, if one was being kept. */
  Bytes finish(){
    Bytes out = closeCluster();
    if(!cues.empty()) append(out, cuesElement(cues, cueTrack));
    return out;
  }
};

// ── demux ──
// Everything below parses untrusted bytes. The invariant the readers maintain is that a
// Child's dStart/dEnd always satisfy start <= dStart <= dEnd <= end, so `dEnd - dStart`
// can never wrap and no read ever leaves the caller's buffer.
struct Child { uint32_t id; size_t dStart, dEnd; };

// Returns the header length, or 0 if the vint is malformed or would run past `end`.
int readId(const uint8_t* b, size_t p, size_t end, uint32_t& id){
  if(p>=end) return 0;
  uint8_t first=b[p]; int L=1, m=0x80; while(L<=4 && !(first&m)){ m>>=1; L++; }
  if(L>4) return 0;                          // no marker bit in the first four positions
  if((size_t)L > end-p) return 0;            // header straddles the buffer/parent end
  id=0; for(int k=0;k<L;k++) id=(id<<8)|b[p+k]; return L;
}
int readSize(const uint8_t* b, size_t p, size_t end, uint64_t& size, bool* unknown=nullptr){
  if(p>=end) return 0;
  uint8_t first=b[p]; int L=1, m=0x80; while(L<=8 && !(first&m)){ m>>=1; L++; }
  if(L>8) return 0;                          // all-zero descriptor: not a valid length vint
  if((size_t)L > end-p) return 0;
  size = first & (m-1); for(int k=1;k<L;k++) size=(size<<8)|b[p+k];
  // An all-ones value (the reserved vint pattern) marks an unknown-size element —
  // the JS streaming muxer emits these for the Segment. Mirror src/webm.js readSize().
  if(unknown){ uint64_t allOnes=((uint64_t)1<<(7*L))-1; *unknown=(size==allOnes); }
  return L;
}
// EBML unsigned ints are 1..8 bytes. Anything longer is malformed, and shifting it in
// would silently wrap, so refuse it instead of returning a fabricated value.
uint64_t readUint(const uint8_t* b, size_t s, size_t e){
  if(e<=s || e-s>8) return 0;
  uint64_t v=0; for(size_t k=s;k<e;k++) v=(v<<8)|b[k]; return v;
}
std::vector<Child> kids(const uint8_t* b, size_t start, size_t end){
  std::vector<Child> r;
  if(start>=end) return r;
  size_t p=start;
  while(p<end){
    uint32_t id; int la=readId(b,p,end,id);
    if(!la) break;                           // truncated or malformed header: stop, don't guess
    bool unk=false; uint64_t sz=0; int lb=readSize(b,p+la,end,sz,&unk);
    if(!lb) break;
    size_t ds=p+(size_t)la+(size_t)lb;       // readSize checked ds<=end, so this cannot pass the end
    size_t de = (unk || sz > (uint64_t)(end-ds)) ? end : ds+(size_t)sz;
    r.push_back({id, ds, de});               // ds<=de<=end by construction
    if(unk) break;                           // unknown size runs to the parent's end (matches the JS demuxer)
    p=de;                                    // de>=ds>p (la,lb>=1), so this always advances
  }
  return r;
}

struct Demuxed { std::vector<Track> tracks; std::string metadata; std::vector<Frame> frames; };
Demuxed demux(const uint8_t* b, size_t len){
  Demuxed d;
  auto walkTracks=[&](size_t s, size_t e){ for(auto& c : kids(b,s,e)) if(c.id==ID_TrackEntry){
    Track t{}; t.width=t.height=0; for(auto& f : kids(b,c.dStart,c.dEnd)){
      if(f.id==ID_TrackNumber) t.number=(int)readUint(b,f.dStart,f.dEnd);
      else if(f.id==ID_CodecID) t.codecID.assign((const char*)b+f.dStart, f.dEnd-f.dStart);
      else if(f.id==ID_Name) t.name.assign((const char*)b+f.dStart, f.dEnd-f.dStart);
      else if(f.id==ID_Video) for(auto& v : kids(b,f.dStart,f.dEnd)){
        if(v.id==ID_PixelWidth) t.width=(int)readUint(b,v.dStart,v.dEnd);
        if(v.id==ID_PixelHeight) t.height=(int)readUint(b,v.dStart,v.dEnd); } }
    d.tracks.push_back(t); } };
  auto walkTags=[&](size_t s, size_t e){ for(auto& tag : kids(b,s,e)) if(tag.id==ID_Tag)
    for(auto& st : kids(b,tag.dStart,tag.dEnd)) if(st.id==ID_SimpleTag){
      std::string name, val; for(auto& f : kids(b,st.dStart,st.dEnd)){
        if(f.id==ID_TagName) name.assign((const char*)b+f.dStart, f.dEnd-f.dStart);
        if(f.id==ID_TagString) val.assign((const char*)b+f.dStart, f.dEnd-f.dStart); }
      if(name=="CHROMAPAKZ") d.metadata=val; } };
  auto walkCluster=[&](size_t s, size_t e){ uint64_t base=0;
    for(auto& c : kids(b,s,e)){
      if(c.id==ID_Timestamp) base=readUint(b,c.dStart,c.dEnd);
      else if(c.id==ID_SimpleBlock){
        size_t p=c.dStart; uint64_t tv=0; int lt=readSize(b,p,c.dEnd,tv);
        if(!lt) continue; p+=lt;
        if(c.dEnd-p < 3) continue;           // needs rel-timecode (2 bytes) + flags (1)
        if(tv > (uint64_t)INT32_MAX) continue;                       // absurd track number
        int rel=(int)(int16_t)((b[p]<<8)|b[p+1]); p+=2; uint8_t flags=b[p]; p+=1;
        // timeMs only orders frames, but base is attacker-controlled, so saturate rather
        // than let the int64→int conversion go out of range.
        int64_t t=(int64_t)(base & (uint64_t)INT64_MAX)+rel;
        if(t>INT32_MAX) t=INT32_MAX; else if(t<INT32_MIN) t=INT32_MIN;
        d.frames.push_back({(int)tv, (flags&0x80)!=0, (int)t, b+p, c.dEnd-p}); } } };
  for(auto& top : kids(b,0,len)) if(top.id==ID_Segment)
    for(auto& c : kids(b,top.dStart,top.dEnd)){
      if(c.id==ID_Tracks) walkTracks(c.dStart,c.dEnd);
      else if(c.id==ID_Tags) walkTags(c.dStart,c.dEnd);
      else if(c.id==ID_Cluster) walkCluster(c.dStart,c.dEnd); }
  return d;
}

// ── metadata JSON ──
// The CHROMAPAKZ tag is a JSON document, and which implementation wrote the file decides what is
// in it. The JS encoder serialises with JSON.stringify, so strings arrive with real escapes and a
// signal id may contain *any* character — including `"`, `\` and `]`. This used to be read with
// substring search, which broke three ways: `j.find(']')` to end the signals array stopped at the
// first `]` inside an id, `j.find('"')` to end an id stopped at an escaped quote, and a signal
// entry was bounded by a fixed 480-character window, so a signal with no quantization inherited
// the *next* signal's inverse-depth near/far.
//
// So both directions are structural now. jsonEscape() on the way out; on the way in, a scanner
// that walks values in place — no DOM, no allocation beyond the strings it returns. The input is
// untrusted, so every function here is total: it reports failure rather than running off the end
// of the buffer, and nesting is depth-capped so a crafted document cannot exhaust the stack.
// Parsing is deliberately lenient about *content* (an unreadable member keeps the caller's
// default) and strict about *structure* (a malformed document stops the walk where it faults,
// keeping only what was already read).

constexpr int JSON_MAX_DEPTH = 32;   // this metadata nests 3 deep; anything near 32 is hostile

std::string jsonEscape(const std::string& s){
  std::string out; out.reserve(s.size()+2);
  for(unsigned char c : s){
    switch(c){
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b";  break;
      case '\f': out += "\\f";  break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:
        if(c < 0x20){ char u[8]; snprintf(u,sizeof u,"\\u%04x",(unsigned)c); out += u; }
        else out += (char)c;   // >= 0x20 passes through, so a UTF-8 id stays UTF-8
    }
  }
  return out;
}

void jWs(const std::string& j, size_t& p){
  while(p<j.size() && (j[p]==' '||j[p]=='\t'||j[p]=='\n'||j[p]=='\r')) p++;
}

void utf8Append(std::string& out, unsigned cp){
  if(cp<0x80) out+=(char)cp;
  else if(cp<0x800){ out+=(char)(0xC0|(cp>>6)); out+=(char)(0x80|(cp&0x3F)); }
  else if(cp<0x10000){ out+=(char)(0xE0|(cp>>12)); out+=(char)(0x80|((cp>>6)&0x3F)); out+=(char)(0x80|(cp&0x3F)); }
  else { out+=(char)(0xF0|(cp>>18)); out+=(char)(0x80|((cp>>12)&0x3F));
         out+=(char)(0x80|((cp>>6)&0x3F)); out+=(char)(0x80|(cp&0x3F)); }
}

bool jHex4(const std::string& j, size_t& p, unsigned& out){
  if(p+4>j.size()) return false;
  out=0;
  for(int i=0;i<4;i++){
    char c=j[p+i]; unsigned d;
    if(c>='0'&&c<='9') d=(unsigned)(c-'0');
    else if(c>='a'&&c<='f') d=10u+(unsigned)(c-'a');
    else if(c>='A'&&c<='F') d=10u+(unsigned)(c-'A');
    else return false;
    out=(out<<4)|d;
  }
  p+=4; return true;
}

/** Parse the string at j[p] (must be '"') into `out`; leaves p just past the closing quote. */
bool jString(const std::string& j, size_t& p, std::string& out){
  if(p>=j.size() || j[p]!='"') return false;
  p++; out.clear();
  while(p<j.size()){
    char c=j[p];
    if(c=='"'){ p++; return true; }
    if(c!='\\'){
      if((unsigned char)c < 0x20) return false;   // a raw control byte is not legal JSON
      out+=c; p++; continue;
    }
    if(++p>=j.size()) return false;
    char e=j[p++];
    switch(e){
      case '"':  out+='"';  break;
      case '\\': out+='\\'; break;
      case '/':  out+='/';  break;
      case 'b':  out+='\b'; break;
      case 'f':  out+='\f'; break;
      case 'n':  out+='\n'; break;
      case 'r':  out+='\r'; break;
      case 't':  out+='\t'; break;
      case 'u': {
        unsigned cp;
        if(!jHex4(j,p,cp)) return false;
        if(cp>=0xD800 && cp<=0xDBFF && p+1<j.size() && j[p]=='\\' && j[p+1]=='u'){
          size_t q=p+2; unsigned lo;                       // a surrogate pair is one code point
          if(jHex4(j,q,lo) && lo>=0xDC00 && lo<=0xDFFF){ cp=0x10000u+((cp-0xD800u)<<10)+(lo-0xDC00u); p=q; }
        }
        utf8Append(out,cp);
        break;
      }
      default: return false;
    }
  }
  return false;   // ran out of input before the closing quote
}

bool jNumber(const std::string& j, size_t& p, double& out){
  const char* s=j.c_str()+p; char* e=nullptr;
  double v=strtod(s,&e);
  if(e==s) return false;
  p += (size_t)(e-s); out=v; return true;
}

bool jLiteral(const std::string& j, size_t& p, const char* lit){
  size_t n=strlen(lit);
  if(j.compare(p,n,lit)!=0) return false;
  p+=n; return true;
}

bool jSkipValue(const std::string& j, size_t& p, int depth);

/** Objects and arrays differ only in their brackets and whether items carry a `"key":` prefix. */
bool jSkipContainer(const std::string& j, size_t& p, char open, char close, bool keyed, int depth){
  if(depth>=JSON_MAX_DEPTH) return false;
  if(p>=j.size() || j[p]!=open) return false;
  p++; jWs(j,p);
  if(p<j.size() && j[p]==close){ p++; return true; }
  for(;;){
    jWs(j,p);
    if(keyed){
      std::string k;
      if(!jString(j,p,k)) return false;
      jWs(j,p);
      if(p>=j.size() || j[p]!=':') return false;
      p++;
    }
    if(!jSkipValue(j,p,depth+1)) return false;
    jWs(j,p);
    if(p>=j.size()) return false;
    if(j[p]==','){ p++; continue; }
    if(j[p]==close){ p++; return true; }
    return false;
  }
}

bool jSkipValue(const std::string& j, size_t& p, int depth){
  jWs(j,p);
  if(p>=j.size()) return false;
  switch(j[p]){
    case '{': return jSkipContainer(j,p,'{','}',true,depth);
    case '[': return jSkipContainer(j,p,'[',']',false,depth);
    case '"': { std::string s; return jString(j,p,s); }
    case 't': return jLiteral(j,p,"true");
    case 'f': return jLiteral(j,p,"false");
    case 'n': return jLiteral(j,p,"null");
    default:  { double v; return jNumber(j,p,v); }
  }
}

/**
 * Walk the members of the object at j[p]. `fn(key, p)` is called with p at each member's value and
 * must leave p exactly past that value. Key order is irrelevant — that is the point of walking
 * rather than searching for `"key":` in the raw text.
 */
template <typename F>
bool jEachMember(const std::string& j, size_t& p, int depth, F fn){
  if(depth>=JSON_MAX_DEPTH) return false;
  jWs(j,p);
  if(p>=j.size() || j[p]!='{') return false;
  p++; jWs(j,p);
  if(p<j.size() && j[p]=='}'){ p++; return true; }
  for(;;){
    jWs(j,p);
    std::string key;
    if(!jString(j,p,key)) return false;
    jWs(j,p);
    if(p>=j.size() || j[p]!=':') return false;
    p++; jWs(j,p);
    if(!fn(key,p)) return false;
    jWs(j,p);
    if(p>=j.size()) return false;
    if(j[p]==','){ p++; continue; }
    if(j[p]=='}'){ p++; return true; }
    return false;
  }
}

/** As jEachMember, for the elements of the array at j[p]. */
template <typename F>
bool jEachElement(const std::string& j, size_t& p, int depth, F fn){
  if(depth>=JSON_MAX_DEPTH) return false;
  jWs(j,p);
  if(p>=j.size() || j[p]!='[') return false;
  p++; jWs(j,p);
  if(p<j.size() && j[p]==']'){ p++; return true; }
  for(;;){
    jWs(j,p);
    if(!fn(p)) return false;
    jWs(j,p);
    if(p>=j.size()) return false;
    if(j[p]==','){ p++; continue; }
    if(j[p]==']'){ p++; return true; }
    return false;
  }
}

/**
 * Read the value at p as a number. Returns true (and consumes it) when it is one. A value of any
 * other type — `"frames":null` is the one that actually occurs, in streamed files — is skipped and
 * false returned, so the caller keeps its default. `ok` goes false only for malformed structure.
 */
bool jNumberValue(const std::string& j, size_t& p, int depth, double& out, bool& ok){
  jWs(j,p);
  if(p<j.size() && (j[p]=='-' || (j[p]>='0' && j[p]<='9'))){
    if(!jNumber(j,p,out)){ ok=false; return false; }
    return true;
  }
  if(!jSkipValue(j,p,depth)) ok=false;
  return false;
}

struct SignalQuantMeta { bool inverse_depth=false; double near_=0, far_=0; int levels=65536; };
struct SignalMeta { std::string id; int track_hi=0, track_lo=0; SignalQuantMeta quant; std::string view; };
struct RgbMeta { std::string id; int track=1; int bits=8; };   // bits: 8 = SDR, 10 = HDR profile 2
struct FileMeta {
  int version=1, width=0, height=0, fps=30, frames=0;
  bool has_rgb=false; int rgb_track=1;
  // Every RGB stream, primary first. Parsed from v3 `rgbs[]`; for a pre-v3 file the legacy
  // `rgb` key is folded into a single entry under the default id, so readers see one shape.
  std::vector<RgbMeta> rgbs;
  std::vector<SignalMeta> signals;
};

/** The `"quant"` member of one signal: an object, or null when the signal is unquantized. */
bool parseQuantValue(const std::string& j, size_t& p, int depth, SignalQuantMeta& q){
  jWs(j,p);
  if(p<j.size() && j[p]=='n') return jLiteral(j,p,"null");   // "quant":null — carried as raw codes
  SignalQuantMeta got; bool isInverse=false, ok=true;
  bool wf=jEachMember(j,p,depth,[&](const std::string& k, size_t& vp)->bool{
    if(k=="type"){
      jWs(j,vp);
      if(vp<j.size() && j[vp]=='"'){
        std::string t; if(!jString(j,vp,t)) return false;
        isInverse=(t=="inverse-depth"); return true;
      }
      return jSkipValue(j,vp,depth+1);
    }
    double v=0;
    if(k=="near"){   if(jNumberValue(j,vp,depth+1,v,ok)) got.near_=v; return ok; }
    if(k=="far"){    if(jNumberValue(j,vp,depth+1,v,ok)) got.far_ =v; return ok; }
    if(k=="levels"){ if(jNumberValue(j,vp,depth+1,v,ok)){ int l=clampToInt(v); got.levels = l>0?l:65536; } return ok; }
    return jSkipValue(j,vp,depth+1);
  });
  if(!wf || !ok) return false;
  // Only an inverse-depth quant means anything to this core; an unrecognised `type` leaves the
  // signal unquantized rather than adopting a near/far it does not know how to apply.
  if(isInverse){ got.inverse_depth=true; q=got; }
  return true;
}

/** One element of `signals[]`. */
bool parseSignalEntry(const std::string& j, size_t& p, int depth, SignalMeta& s, bool& haveId){
  bool ok=true, quantIsInverseString=false;
  SignalQuantMeta sibling;   // the pre-v2 shape put near/far/levels on the signal itself
  bool wf=jEachMember(j,p,depth,[&](const std::string& k, size_t& vp)->bool{
    if(k=="id"){
      jWs(j,vp);
      if(vp<j.size() && j[vp]=='"'){
        if(!jString(j,vp,s.id)) return false;
        haveId=true; return true;
      }
      return jSkipValue(j,vp,depth+1);
    }
    if(k=="tracks"){
      return jEachMember(j,vp,depth+1,[&](const std::string& tk, size_t& tp)->bool{
        double v=0;
        if(tk=="hi"){ if(jNumberValue(j,tp,depth+2,v,ok)) s.track_hi=clampToInt(v); return ok; }
        if(tk=="lo"){ if(jNumberValue(j,tp,depth+2,v,ok)) s.track_lo=clampToInt(v); return ok; }
        return jSkipValue(j,tp,depth+2);
      });
    }
    if(k=="quant"){
      jWs(j,vp);
      if(vp<j.size() && j[vp]=='"'){   // "quant":"inverse-depth", with near/far as siblings
        std::string t; if(!jString(j,vp,t)) return false;
        quantIsInverseString=(t=="inverse-depth"); return true;
      }
      return parseQuantValue(j,vp,depth+1,s.quant);
    }
    double v=0;
    if(k=="near"){   if(jNumberValue(j,vp,depth+1,v,ok)) sibling.near_=v; return ok; }
    if(k=="far"){    if(jNumberValue(j,vp,depth+1,v,ok)) sibling.far_ =v; return ok; }
    if(k=="levels"){ if(jNumberValue(j,vp,depth+1,v,ok)){ int l=clampToInt(v); sibling.levels = l>0?l:65536; } return ok; }
    return jSkipValue(j,vp,depth+1);
  });
  if(!wf || !ok) return false;
  if(quantIsInverseString){ s.quant=sibling; s.quant.inverse_depth=true; }
  return true;
}

/** `signals[]`, starting at the array's `[`. A malformed element ends the walk, prefix kept. */
void parseSignalsV2(const std::string& j, size_t at, FileMeta& m){
  size_t p=at;
  jEachElement(j,p,1,[&](size_t& ep)->bool{
    SignalMeta s; bool haveId=false;
    if(!parseSignalEntry(j,ep,2,s,haveId)) return false;
    // A signal whose two planes are missing or aliased cannot be decoded; drop it here so
    // dc_decode_signal reports "no such signal" rather than unpacking mismatched planes.
    if(haveId && s.track_hi>0 && s.track_lo>0 && s.track_hi!=s.track_lo) m.signals.push_back(s);
    return true;
  });
}

/** `rgbs[]` (v3), starting at the array's `[`. An entry without a usable id+track is dropped. */
void parseRgbsV3(const std::string& j, size_t at, FileMeta& m){
  size_t p=at;
  jEachElement(j,p,1,[&](size_t& ep)->bool{
    RgbMeta r; r.track=0; bool haveId=false, ok=true;
    bool wf=jEachMember(j,ep,2,[&](const std::string& k, size_t& vp)->bool{
      if(k=="id"){
        jWs(j,vp);
        if(vp<j.size() && j[vp]=='"'){
          if(!jString(j,vp,r.id)) return false;
          haveId=true; return true;
        }
        return jSkipValue(j,vp,3);
      }
      double v=0;
      if(k=="track"){ if(jNumberValue(j,vp,3,v,ok)) r.track=clampToInt(v); return ok; }
      if(k=="hdr"){
        // Only the bit depth matters to this core (it decides the decode path); the rest of the
        // hdr object is display metadata that readers take from the raw JSON.
        jWs(j,vp);
        if(vp<j.size() && j[vp]=='{'){
          r.bits=10;   // an hdr object without an explicit "bits" still means the profile-2 track
          return jEachMember(j,vp,3,[&](const std::string& hk, size_t& hp)->bool{
            double hv=0;
            if(hk=="bits"){ if(jNumberValue(j,hp,4,hv,ok)){ int b=clampToInt(hv); r.bits = b>0?b:10; } return ok; }
            return jSkipValue(j,hp,4);
          });
        }
        return jSkipValue(j,vp,3);
      }
      return jSkipValue(j,vp,3);
    });
    if(!wf || !ok) return false;
    if(haveId && r.track>0) m.rgbs.push_back(r);
    return true;
  });
}

FileMeta parseMetadata(const std::string& j){
  FileMeta m;
  size_t p=0, signalsAt=std::string::npos, rgbsAt=std::string::npos;
  bool ok=true;
  // `signals` is parsed after the walk rather than during it, because whether to parse it at all
  // depends on `version`, which JSON does not promise to have seen first.
  jEachMember(j,p,0,[&](const std::string& k, size_t& vp)->bool{
    double v=0;
    if(k=="width"){   if(jNumberValue(j,vp,1,v,ok)) m.width =clampToInt(v); return ok; }
    if(k=="height"){  if(jNumberValue(j,vp,1,v,ok)) m.height=clampToInt(v); return ok; }
    if(k=="fps"){     if(jNumberValue(j,vp,1,v,ok)) m.fps   =clampToInt(v); return ok; }
    if(k=="frames"){  if(jNumberValue(j,vp,1,v,ok)) m.frames=clampToInt(v); return ok; }
    if(k=="version"){ if(jNumberValue(j,vp,1,v,ok)){ int ver=clampToInt(v); m.version = ver>0?ver:1; } return ok; }
    if(k=="rgb"){
      jWs(j,vp);
      m.has_rgb = !(vp<j.size() && j[vp]=='n');   // present and not null
      if(m.has_rgb && vp<j.size() && j[vp]=='{')
        return jEachMember(j,vp,1,[&](const std::string& rk, size_t& rp)->bool{
          double t=0;
          if(rk=="track"){ if(jNumberValue(j,rp,2,t,ok)) m.rgb_track=clampToInt(t); return ok; }
          return jSkipValue(j,rp,2);
        });
      return jSkipValue(j,vp,1);
    }
    if(k=="signals"){ signalsAt=vp; return jSkipValue(j,vp,1); }
    if(k=="rgbs"){ rgbsAt=vp; return jSkipValue(j,vp,1); }
    return jSkipValue(j,vp,1);
  });
  if(m.fps<=0) m.fps=30;
  if(m.frames<0) m.frames=0;
  if(m.version>=2 && signalsAt!=std::string::npos) parseSignalsV2(j,signalsAt,m);
  if(rgbsAt!=std::string::npos) parseRgbsV3(j,rgbsAt,m);
  // One shape for every reader below: rgbs[] is authoritative when the file carries it,
  // otherwise the legacy `rgb` key becomes the sole stream under the default id.
  if(!m.rgbs.empty()){ m.has_rgb=true; m.rgb_track=m.rgbs[0].track; }
  else if(m.has_rgb) m.rgbs.push_back({"rgb", m.rgb_track});
  return m;
}

const SignalMeta* findSignal(const FileMeta& m, const char* id){
  for(auto& s : m.signals) if(s.id==id) return &s;
  return nullptr;
}

std::string quantJson(const SignalQuantMeta& q){
  // JSON has no inf/nan, and printf would emit exactly those bare words for a range the C ABI was
  // handed directly (the JS and Python wrappers reject it up front, a C caller need not). Writing
  // them would produce a document no JSON reader can load, so record "no quantization" instead.
  if(!q.inverse_depth || !std::isfinite(q.near_) || !std::isfinite(q.far_)) return "null";
  char buf[192];
  // %.17g, not %g: %g keeps 6 significant digits, so a near/far that needed more came back out of
  // the file as a different number than went in, and dequantized to slightly different metres.
  // 17 significant digits round-trip an IEEE double exactly.
  snprintf(buf,sizeof buf,"{\"type\":\"inverse-depth\",\"near\":%.17g,\"far\":%.17g,\"levels\":%d}",
           q.near_, q.far_, q.levels);
  return buf;
}

// Codec string for one RGB stream. SDR keeps the short historical form; HDR uses the full form
// (profile.level.depth.chroma.primaries.transfer.matrix) WebCodecs needs to configure an HDR
// decode: profile 2, 10-bit, 4:2:0 colocated, BT.2020 primaries/matrix, PQ or HLG transfer.
std::string rgbCodecString(const HdrMeta& hdr){
  if(!hdr.enabled) return "vp09.00.10.08";
  char buf[40]; snprintf(buf,sizeof buf,"vp09.02.10.10.01.09.%02d.09", hdr.transfer);
  return buf;
}

// The `"hdr"` object of one rgbs[] entry. Key order matches the JS writer's.
std::string hdrJson(const HdrMeta& h){
  std::string out="{\"bits\":10,\"transfer\":\"";
  out += h.transfer==18 ? "hlg" : "pq"; out += "\"";
  char buf[64];
  if(h.maxCll){ snprintf(buf,sizeof buf,",\"maxCLL\":%d",h.maxCll); out+=buf; }
  if(h.maxFall){ snprintf(buf,sizeof buf,",\"maxFALL\":%d",h.maxFall); out+=buf; }
  if(h.hasMastering){
    // %.17g round-trips an IEEE double exactly, as for quant near/far.
    const std::pair<const char*,double> kv[]={{"rx",h.rx},{"ry",h.ry},{"gx",h.gx},{"gy",h.gy},
      {"bx",h.bx},{"by",h.by},{"wx",h.wx},{"wy",h.wy},{"maxLum",h.lumMax},{"minLum",h.lumMin}};
    out += ",\"mastering\":{";
    for(size_t i=0;i<10;i++){
      snprintf(buf,sizeof buf,"%s\"%s\":%.17g", i?",":"", kv[i].first, kv[i].second);
      out += buf;
    }
    out += "}";
  }
  out += "}";
  return out;
}

// `streaming` writes "frames":null,"streaming":true in place of a count, matching what the JS
// stream muxer emits: when the header goes out the take has not happened yet, and a reader
// recovers the count by counting blocks (see the note in dc_probe).
//
// v3: the legacy `rgb` key stays, always describing the primary stream (== rgbs[0]) so pre-v3
// readers decode it unchanged; `rgbs[]` names every stream and is what v3 readers use.
std::string buildMetadataJson(int W,int H,int N,int fps,const std::vector<RgbMeta>& rgbs,
                              const std::vector<SignalMeta>& signals, bool streaming=false,
                              const HdrMeta& hdr=HdrMeta{}){
  // Built with std::string throughout — the document grows with signal count and id length,
  // so a fixed stack buffer would silently truncate (and emit invalid JSON) past some size.
  std::string sigs="[";
  for(size_t i=0;i<signals.size();i++){
    if(i) sigs+=",";
    const auto& s=signals[i];
    char nums[64]; snprintf(nums,sizeof nums,"\"hi\":%d,\"lo\":%d", s.track_hi, s.track_lo);
    sigs += "{\"id\":\""; sigs += jsonEscape(s.id); sigs += "\",\"tracks\":{"; sigs += nums;
    sigs += "},\"codec\":\"vp09.00.10.08\",\"lossless\":true,\"scheme\":\"tri-fold-8+8\","
            "\"dtype\":\"uint16\",\"invalidCode\":0,\"quant\":";
    sigs += quantJson(s.quant);
    if(!s.view.empty()){ sigs += ",\"view\":\""; sigs += jsonEscape(s.view); sigs += "\""; }
    sigs += "}";
  }
  sigs+="]";
  std::string rgb="null", rgbsJson;
  if(!rgbs.empty()){
    const std::string codec=rgbCodecString(hdr);
    const std::string hdrObj=hdr.enabled ? hdrJson(hdr) : "";
    char pb[80]; snprintf(pb,sizeof pb,"{\"track\":%d,\"codec\":\"%s\"}", rgbs[0].track, codec.c_str());
    rgb=pb;
    rgbsJson="[";
    for(size_t i=0;i<rgbs.size();i++){
      if(i) rgbsJson+=",";
      char tb[80]; snprintf(tb,sizeof tb,"\",\"track\":%d,\"codec\":\"%s\"", rgbs[i].track, codec.c_str());
      rgbsJson += "{\"id\":\""; rgbsJson += jsonEscape(rgbs[i].id); rgbsJson += tb;
      if(hdr.enabled){ rgbsJson += ",\"hdr\":"; rgbsJson += hdrObj; }
      rgbsJson += "}";
    }
    rgbsJson+="]";
  }
  char head[192];
  if(streaming)
    snprintf(head,sizeof head,
             "{\"version\":3,\"width\":%d,\"height\":%d,\"fps\":%d,\"frames\":null,\"streaming\":true,\"rgb\":",W,H,fps);
  else
    snprintf(head,sizeof head,"{\"version\":3,\"width\":%d,\"height\":%d,\"fps\":%d,\"frames\":%d,\"rgb\":",W,H,fps,N);
  std::string out=head; out+=rgb;
  if(!rgbs.empty()){ out+=",\"rgbs\":"; out+=rgbsJson; }
  out+=",\"signals\":"; out+=sigs; out+="}";
  return out;
}

struct SignalEncodeSpec {
  std::string id;
  const uint16_t* data=nullptr;
  SignalQuantMeta quant;
  std::string view;   // optional, recorded verbatim in the metadata
};

struct RgbEncodeSpec { std::string id; int kbps=0; };

// RGB streams take tracks 1..N in declaration order; the primary keeps the container name "rgb"
// (the name pre-v3 readers and the cue-track choice scan for), secondaries are "rgb-{id}".
std::vector<RgbMeta> planRgbTracks(const std::vector<RgbEncodeSpec>& specs){
  std::vector<RgbMeta> out;
  for(size_t i=0;i<specs.size();i++) out.push_back({specs[i].id, (int)i+1});
  return out;
}

// Container track descriptors for a plan. Shared by the batch and streaming builders, so both
// name and number their tracks identically. An enabled `hdr` puts a Colour element on every
// RGB track; signal tracks never carry one (their "video" is packed data, not colour).
std::vector<Track> tracksForPlan(const std::vector<SignalMeta>& sigMeta,
                                 const std::vector<RgbMeta>& rgbs, int W, int H,
                                 const HdrMeta& hdr=HdrMeta{}){
  std::vector<Track> tracks;
  for(size_t i=0;i<rgbs.size();i++){
    Track t{rgbs[i].track,"V_VP9", i==0?std::string("rgb"):"rgb-"+rgbs[i].id, W,H};
    t.colour=hdr;
    tracks.push_back(t);
  }
  for(auto& sm : sigMeta){
    tracks.push_back({sm.track_hi,"V_VP9","signal-"+sm.id+"-hi",W,H});
    tracks.push_back({sm.track_lo,"V_VP9","signal-"+sm.id+"-lo",W,H});
  }
  return tracks;
}

std::vector<SignalMeta> planSignalTracks(const std::vector<SignalEncodeSpec>& specs, size_t numRgb){
  std::vector<SignalMeta> out;
  int next=(int)numRgb+1;
  for(auto& sp : specs){
    SignalMeta s; s.id=sp.id; s.track_hi=next++; s.track_lo=next++; s.quant=sp.quant; s.view=sp.view;
    out.push_back(s);
  }
  return out;
}

// Shared validation for the dc_rgb_spec_t list: ids must be unique and non-empty; NULL is
// allowed only for a single stream, where it means the default id "rgb".
bool normalizeRgbSpecs(const dc_rgb_spec_t* rgbs, int num_rgbs, std::vector<RgbEncodeSpec>& out){
  if(num_rgbs<0) return false;
  if(num_rgbs>0 && !rgbs) return false;
  for(int i=0;i<num_rgbs;i++){
    RgbEncodeSpec r;
    if(rgbs[i].id && *rgbs[i].id) r.id=rgbs[i].id;
    else if(!rgbs[i].id && num_rgbs==1) r.id="rgb";
    else return false;
    r.kbps=rgbs[i].kbps;
    for(auto& prev : out) if(prev.id==r.id) return false;
    out.push_back(r);
  }
  return true;
}

// ── triangle-fold 8+8 ──
void pack(const uint16_t* d, size_t n, uint8_t* hi, uint8_t* lo){
  for(size_t i=0;i<n;i++){ int h=d[i]>>8, l=d[i]&0xff; hi[i]=h; lo[i]=(h&1)?(255-l):l; }
}
void unpack(const uint8_t* hi, const uint8_t* lo, size_t n, uint16_t* d){
  for(size_t i=0;i<n;i++){ int h=hi[i], l=(h&1)?(255-lo[i]):lo[i]; d[i]=(uint16_t)((h<<8)|l); }
}

// NO_LOSSLESS is separate from FAIL because it is the one failure a caller can act on: the
// libvpx build cannot do what the metadata would claim.
enum EncStatus { ENC_OK=0, ENC_FAIL=1, ENC_NO_LOSSLESS=2 };

// ── decoding untrusted files ──
// VP9's own maximum frame dimension, plus a pixel-count cap that keeps W*H*4 inside a 32-bit
// size_t as well — 2^28 px is 16384x16384, already far past any real frame. Header dimensions
// beyond either can never describe a decodable bitstream, and rejecting them before any
// arithmetic means the byte counts below cannot wrap and quietly defeat the bounds they feed.
const int kMaxDim = 65536;
const uint64_t kMaxPixels = 1ull << 28;

bool dimsUsable(int W, int H){
  return W>0 && H>0 && W<=kMaxDim && H<=kMaxDim && (uint64_t)W*(uint64_t)H <= kMaxPixels;
}

// Why a decoded track can be a different shape from what the file's header says: the metadata
// and the bitstream are independent, and nothing in the container ties them together. A crafted
// header can declare a frame count far below what the clusters actually hold, one SimpleBlock
// can carry a VP9 superframe that decodes to several images, and the coded frame size is a
// property of the bitstream that no amount of header parsing can predict. So the decode loops
// check every image and stop at the caller's capacity rather than trusting either source.
enum DecStatus { DEC_OK=0, DEC_CODEC=1, DEC_GEOMETRY=2, DEC_CAPACITY=3 };

// The copy loops below index planes[0] as 8-bit rows of W bytes and planes[1..2] at half
// resolution, so an image is only safe to copy out if it is exactly 8-bit I420 at W*H.
// libvpx will otherwise hand back e.g. a 16x16 frame, or 16-bit planes for a profile-2 stream.
bool imageMatches(const vpx_image_t* img, int W, int H){
  return img && img->fmt==VPX_IMG_FMT_I420 && (int)img->d_w==W && (int)img->d_h==H;
}
// The 10-bit HDR display track's counterpart: 16-bit I420 storage carrying 10-bit samples.
bool imageMatches16(const vpx_image_t* img, int W, int H){
  return img && img->fmt==VPX_IMG_FMT_I42016 && (int)img->d_w==W && (int)img->d_h==H
      && img->bit_depth==10;
}

// Decode a VP9 track's packets (in order) → luma planes (W*H each), at most maxFrames of them.
int decodePlaneTrack(std::vector<Frame>& frs, int W, int H, size_t maxFrames,
                     std::vector<Bytes>& outPlanes){
  std::stable_sort(frs.begin(), frs.end(), [](const Frame&a,const Frame&b){ return a.timeMs<b.timeMs; });
  vpx_codec_ctx_t c{}; if(vpx_codec_dec_init(&c, vpx_codec_vp9_dx(), nullptr, 0)) return DEC_CODEC;
  int st=DEC_OK;
  for(auto& f : frs){
    if(vpx_codec_decode(&c, f.data, (unsigned)f.len, nullptr, 0)){ st=DEC_CODEC; break; }
    vpx_image_t* img; vpx_codec_iter_t it=nullptr;
    while((img=vpx_codec_get_frame(&c,&it))){
      if(!imageMatches(img,W,H)){ st=DEC_GEOMETRY; break; }
      if(outPlanes.size()>=maxFrames){ st=DEC_CAPACITY; break; }
      Bytes plane((size_t)W*H);
      for(int r=0;r<H;r++) memcpy(plane.data()+(size_t)r*W, img->planes[0]+(size_t)r*img->stride[0], W);
      outPlanes.push_back(std::move(plane));
    }
    if(st) break;
  }
  vpx_codec_destroy(&c);
  return st;
}

// ── RGB ↔ I420, BT.709 full-range (signaled in the bitstream so players decode correctly) ──
inline uint8_t clamp8(double v){ return (uint8_t)(v<0?0:(v>255?255:v+0.5)); }

void rgbaToI420(const uint8_t* rgba, int W, int H, vpx_image_t* img){
  for(int r=0;r<H;r++) for(int c=0;c<W;c++){ const uint8_t* p=rgba+((size_t)r*W+c)*4;
    img->planes[0][r*img->stride[0]+c] = clamp8(0.2126*p[0]+0.7152*p[1]+0.0722*p[2]); }
  int cW=(W+1)/2, cH=(H+1)/2;
  for(int r=0;r<cH;r++) for(int c=0;c<cW;c++){
    int r0=r*2,c0=c*2,r1=(r0+1<H)?r0+1:r0,c1=(c0+1<W)?c0+1:c0; double R=0,G=0,B=0;
    int pts[4][2]={{r0,c0},{r0,c1},{r1,c0},{r1,c1}};
    for(auto&t:pts){ const uint8_t* p=rgba+((size_t)t[0]*W+t[1])*4; R+=p[0];G+=p[1];B+=p[2]; }
    R/=4;G/=4;B/=4; double Y=0.2126*R+0.7152*G+0.0722*B;
    img->planes[1][r*img->stride[1]+c]=clamp8((B-Y)/1.8556+128);
    img->planes[2][r*img->stride[2]+c]=clamp8((R-Y)/1.5748+128); }
}
void i420ToRGBA(const vpx_image_t* img, int W, int H, uint8_t* rgba){
  for(int r=0;r<H;r++) for(int c=0;c<W;c++){
    double Y=img->planes[0][r*img->stride[0]+c];
    double Cb=img->planes[1][(r/2)*img->stride[1]+(c/2)]-128.0;
    double Cr=img->planes[2][(r/2)*img->stride[2]+(c/2)]-128.0;
    uint8_t* p=rgba+((size_t)r*W+c)*4;
    p[0]=clamp8(Y+1.5748*Cr); p[1]=clamp8(Y-0.1873*Cb-0.4681*Cr); p[2]=clamp8(Y+1.8556*Cb); p[3]=255; }
}

// ── 10-bit RGB ↔ 16-bit I420, BT.2020 non-constant luminance, broadcast range ──
// The HDR10 convention: PQ/HLG-encoded 10-bit display codes (0..1023), YCbCr with BT.2020
// coefficients (Kr 0.2627, Kb 0.0593), limited-range quantization (Y 64..940, C 64..960).
// Both range and colour space are also signalled in the bitstream and the container's Colour
// element, so a player reconstructs exactly these codes.
inline uint16_t clamp10(double v){ return (uint16_t)(v<0?0:(v>1023?1023:v+0.5)); }

void rgba16ToI42016(const uint16_t* rgba, int W, int H, vpx_image_t* img){
  auto ey=[](double R,double G,double B){ return (0.2627*R+0.6780*G+0.0593*B)/1023.0; };
  uint16_t* yp=(uint16_t*)img->planes[0]; int ys=img->stride[0]/2;
  for(int r=0;r<H;r++) for(int c=0;c<W;c++){
    const uint16_t* p=rgba+((size_t)r*W+c)*4;
    double R=p[0]>1023?1023:p[0], G=p[1]>1023?1023:p[1], B=p[2]>1023?1023:p[2];
    yp[r*ys+c]=clamp10(64.0+876.0*ey(R,G,B));
  }
  int cW=(W+1)/2, cH=(H+1)/2;
  uint16_t* up=(uint16_t*)img->planes[1]; int us=img->stride[1]/2;
  uint16_t* vp=(uint16_t*)img->planes[2]; int vs=img->stride[2]/2;
  for(int r=0;r<cH;r++) for(int c=0;c<cW;c++){
    int r0=r*2,c0=c*2,r1=(r0+1<H)?r0+1:r0,c1=(c0+1<W)?c0+1:c0; double R=0,G=0,B=0;
    int pts[4][2]={{r0,c0},{r0,c1},{r1,c0},{r1,c1}};
    for(auto&t:pts){ const uint16_t* p=rgba+((size_t)t[0]*W+t[1])*4;
      R+=p[0]>1023?1023:p[0]; G+=p[1]>1023?1023:p[1]; B+=p[2]>1023?1023:p[2]; }
    R/=4;G/=4;B/=4; double Ey=ey(R,G,B);
    up[r*us+c]=clamp10(512.0+896.0*(B/1023.0-Ey)/1.8814);
    vp[r*vs+c]=clamp10(512.0+896.0*(R/1023.0-Ey)/1.4746);
  }
}
void i42016ToRGBA16(const vpx_image_t* img, int W, int H, uint16_t* rgba){
  const uint16_t* yp=(const uint16_t*)img->planes[0]; int ys=img->stride[0]/2;
  const uint16_t* up=(const uint16_t*)img->planes[1]; int us=img->stride[1]/2;
  const uint16_t* vp=(const uint16_t*)img->planes[2]; int vs=img->stride[2]/2;
  for(int r=0;r<H;r++) for(int c=0;c<W;c++){
    double Ey=((double)yp[r*ys+c]-64.0)/876.0;
    double Cb=((double)up[(r/2)*us+(c/2)]-512.0)/896.0;
    double Cr=((double)vp[(r/2)*vs+(c/2)]-512.0)/896.0;
    double Bn=Ey+1.8814*Cb, Rn=Ey+1.4746*Cr;
    double Gn=(Ey-0.2627*Rn-0.0593*Bn)/0.6780;
    uint16_t* p=rgba+((size_t)r*W+c)*4;
    p[0]=clamp10(Rn*1023.0); p[1]=clamp10(Gn*1023.0); p[2]=clamp10(Bn*1023.0); p[3]=1023; }
}

// ── one VP9 track encoder, held open across frames ──
// Both the batch helpers below and the streaming ABI drive this; the difference is only how long
// it lives. Kept open for the length of a recording, it is what lets a frame's blocks be emitted
// as the frame is captured instead of at the end of the take.
//
// 'luma' tracks carry a packed signal plane in Y with constant 128 chroma and are encoded
// losslessly; the 'rgba' track is the lossy preview. FULL colour range is signalled in the
// bitstream either way: depth is packed full-range 0..255 in luma, and a decoder that honoured
// the default limited ("tv") range would rescale and clip it.
struct TrackEncoder {
  vpx_codec_ctx_t ctx{};
  vpx_image_t img{};
  bool haveCtx=false, haveImg=false, rgba=false, hdr10=false;
  int W=0, H=0;
  int keyEvery=0;      // force a keyframe every N frames; 0 = only the first frame
  int64_t pushed=0;    // frames handed to libvpx, including the terminating flush

  TrackEncoder()=default;
  TrackEncoder(const TrackEncoder&)=delete;
  TrackEncoder& operator=(const TrackEncoder&)=delete;
  ~TrackEncoder(){ if(haveImg) vpx_img_free(&img); if(haveCtx) vpx_codec_destroy(&ctx); }

  EncStatus init(int W_, int H_, int fps, bool lossless, int kbps, int keyEvery_, bool hdr10_=false){
    W=W_; H=H_; rgba=!lossless; keyEvery=keyEvery_; hdr10=hdr10_;
    vpx_codec_iface_t* iface = vpx_codec_vp9_cx();
    vpx_codec_enc_cfg_t cfg{}; if(vpx_codec_enc_config_default(iface,&cfg,0)) return ENC_FAIL;
    cfg.g_w=W; cfg.g_h=H; cfg.g_timebase.num=1; cfg.g_timebase.den=fps;
    cfg.g_profile=0; cfg.g_lag_in_frames=0; cfg.kf_mode=VPX_KF_DISABLED;
    if(hdr10){
      // VP9 profile 2: 10-bit samples in 16-bit I420 storage. The init flag is required —
      // without it libvpx rejects a high-bit-depth config outright, which is also the failure
      // mode on a libvpx built without --enable-vp9-highbitdepth (reported as ENC_FAIL).
      cfg.g_profile=2;
      cfg.g_bit_depth=VPX_BITS_10;
      cfg.g_input_bit_depth=10;
    }
    // Row multithreading, below. Four threads is where this plateaus for the small
    // frames here (256x192): 2 threads 53.3 ms, 4 threads 51.0, 8 threads 51.1.
    // Encoders run one at a time on the write queue, so they do not contend.
    // Row multithreading, below. With the streaming path now encoding its tracks
    // concurrently this barely matters there (1 thread 16.4 ms, 4 threads 16.0),
    // but the batch encoder still drives tracks serially and gains ~8 ms/frame
    // from it. Avoid 2: it measured reliably worse than either 1 or 4 (22.6 ms),
    // reproducibly, so it is not sampling noise.
    cfg.g_threads = std::min(4u, std::max(1u, std::thread::hardware_concurrency()));
    if(lossless){
      cfg.rc_min_quantizer=0; cfg.rc_max_quantizer=0;
      cfg.g_pass=VPX_RC_ONE_PASS; cfg.g_error_resilient=0;
    }else{
      cfg.rc_end_usage=VPX_VBR; cfg.rc_target_bitrate=kbps;
    }
    if(vpx_codec_enc_init(&ctx,iface,&cfg, hdr10?VPX_CODEC_USE_HIGHBITDEPTH:0)) return ENC_FAIL;
    haveCtx=true;
    if(lossless){
      // Gate on the lossless control: an old or misbuilt libvpx that rejects it would encode the
      // packed depth planes LOSSY while the metadata still advertises "lossless":true. Silent
      // data corruption is worse than a failed encode, so refuse rather than proceed.
      if(vpx_codec_control(&ctx, VP9E_SET_LOSSLESS, 1)) return ENC_NO_LOSSLESS;
      // Speed knob only: under VP9E_SET_LOSSLESS the reconstruction is bit-exact at
      // every setting, so this trades encode time against compression ratio, never
      // fidelity. Measured on a real LiDAR take (256x192, RGB + depth + confidence),
      // which is the demanding case because sensor noise is expensive to code
      // losslessly: cpu-used=1 89.7 ms/frame at 39.1 KiB, cpu-used=6 58.9 ms at
      // 40.1 KiB — 1.5x faster for 2.5% more bytes. 7..9 give nothing further.
      // Capture is frame-budget bound, so the time matters more than the bytes.
      vpx_codec_control(&ctx, VP8E_SET_CPUUSED, 6);
    }else{
      // Lossy, so unlike the lossless path this trades picture quality, not just
      // size: on a real take, cpu-used=2 gives 42.75 dB PSNR and =4 gives 40.75 dB,
      // for ~7 ms/frame. Capture is frame-budget bound and the RGB track is the
      // colour reference beside bit-exact depth, so the milliseconds win. Past 4 is
      // pointless — cpu-used=6 measured both slower and worse.
      vpx_codec_control(&ctx, VP8E_SET_CPUUSED, 4);
      vpx_codec_control(&ctx, VP9E_SET_COLOR_SPACE, hdr10?VPX_CS_BT_2020:VPX_CS_BT_709);
    }
    // SDR/signal tracks are full-range on purpose (packed luma must not be rescaled); the HDR
    // display track follows the HDR10 broadcast-range convention instead, and says so both here
    // (bitstream) and in the container's Colour element.
    vpx_codec_control(&ctx, VP9E_SET_COLOR_RANGE, hdr10?VPX_CR_STUDIO_RANGE:VPX_CR_FULL_RANGE);
    // On failure vpx_img_alloc returns NULL and leaves img.planes unset — the copy below would
    // then memcpy through wild pointers.
    // g_threads alone buys nothing (59.5 -> 58.7 ms): VP9 only spreads work across
    // threads with row-mt or tiling, and tile columns need >=256px per tile, which
    // a 256-wide frame cannot give more than one of. Row-mt is width-independent
    // and is the whole gain: 59.5 -> 51.0 ms, identical bytes, still bit-exact.
    vpx_codec_control(&ctx, VP9E_SET_ROW_MT, 1);
    if(!vpx_img_alloc(&img, hdr10?VPX_IMG_FMT_I42016:VPX_IMG_FMT_I420, W, H, 1)) return ENC_FAIL;
    haveImg=true;
    img.cs = hdr10?VPX_CS_BT_2020:VPX_CS_BT_709;
    img.range = hdr10?VPX_CR_STUDIO_RANGE:VPX_CR_FULL_RANGE;
    if(hdr10) img.bit_depth = 10;
    return ENC_OK;
  }

  /**
   * Encode one frame, or flush the encoder when `src` is NULL. Appends whatever packets libvpx
   * hands back — with g_lag_in_frames=0 that is exactly one per frame, which is what keeps every
   * track of a streamed recording in lockstep.
   *
   * An hdr10 track's `src` is really `const uint16_t*` (W*H*4 samples of 10-bit RGBA codes),
   * passed through the same byte-pointer plumbing every slot shares.
   */
  bool encode(const uint8_t* src, std::vector<Bytes>& outFrames, std::vector<bool>& outKey){
    vpx_image_t* in=nullptr;
    if(src){
      if(rgba && hdr10) rgba16ToI42016((const uint16_t*)src, W, H, &img);
      else if(rgba) rgbaToI420(src, W, H, &img);
      else{
        for(int r=0;r<H;r++) memcpy(img.planes[0]+r*img.stride[0], src+(size_t)r*W, W);
        for(int p=1;p<3;p++) for(int r=0;r<(H+1)/2;r++) memset(img.planes[p]+r*img.stride[p],128,(W+1)/2);
      }
      in=&img;
    }
    vpx_enc_frame_flags_t fl = (pushed==0 || (keyEvery>0 && pushed%keyEvery==0)) ? VPX_EFLAG_FORCE_KF : 0;
    vpx_codec_pts_t pts=(vpx_codec_pts_t)pushed;
    pushed++;
    if(vpx_codec_encode(&ctx,in,pts,1,fl,VPX_DL_GOOD_QUALITY)) return false;
    const vpx_codec_cx_pkt_t* pkt; vpx_codec_iter_t it=nullptr;
    while((pkt=vpx_codec_get_cx_data(&ctx,&it))) if(pkt->kind==VPX_CODEC_CX_FRAME_PKT){
      outFrames.emplace_back((uint8_t*)pkt->data.frame.buf, (uint8_t*)pkt->data.frame.buf+pkt->data.frame.sz);
      outKey.push_back((pkt->data.frame.flags & VPX_FRAME_IS_KEY)!=0);
    }
    return true;
  }
};

// VP9 lossless encode of an 8-bit luma-plane sequence, start to finish.
EncStatus encodePlaneSeq(const std::vector<const uint8_t*>& planes, int W, int H, int fps,
                         std::vector<Bytes>& outFrames, std::vector<bool>& outKey){
  TrackEncoder te;
  if(EncStatus st=te.init(W,H,fps,/*lossless=*/true,0,/*keyEvery=*/fps>0?fps:30)) return st;
  for(size_t i=0;i<=planes.size();i++)
    if(!te.encode(i<planes.size()?planes[i]:nullptr, outFrames, outKey)) return ENC_FAIL;
  return ENC_OK;
}

// Lossy VP9 RGB track (~1s keyframe interval → seekable RGB via Cues, matching the browser path).
// `hdr10` selects the profile-2 path, where each plane pointer is really `const uint16_t*`.
bool encodeRGBSeq(const std::vector<const uint8_t*>& rgba, int W, int H, int fps, int kbps,
                  std::vector<Bytes>& outFrames, std::vector<bool>& outKey, bool hdr10=false){
  TrackEncoder te;
  if(te.init(W,H,fps,/*lossless=*/false,kbps,/*keyEvery=*/fps>0?fps:30,hdr10)) return false;
  for(size_t i=0;i<=rgba.size();i++)
    if(!te.encode(i<rgba.size()?rgba[i]:nullptr, outFrames, outKey)) return false;
  return true;
}
// Same capacity/geometry contract as decodePlaneTrack.
int decodeRGBTrack(std::vector<Frame>& frs, int W, int H, size_t maxFrames, std::vector<Bytes>& out){
  std::stable_sort(frs.begin(),frs.end(),[](const Frame&a,const Frame&b){return a.timeMs<b.timeMs;});
  vpx_codec_ctx_t c{}; if(vpx_codec_dec_init(&c,vpx_codec_vp9_dx(),nullptr,0)) return DEC_CODEC;
  int st=DEC_OK;
  for(auto& f : frs){ if(vpx_codec_decode(&c,f.data,(unsigned)f.len,nullptr,0)){ st=DEC_CODEC; break; }
    vpx_image_t* img; vpx_codec_iter_t it=nullptr;
    while((img=vpx_codec_get_frame(&c,&it))){
      if(!imageMatches(img,W,H)){ st=DEC_GEOMETRY; break; }
      if(out.size()>=maxFrames){ st=DEC_CAPACITY; break; }
      Bytes rgba((size_t)W*H*4); i420ToRGBA(img,W,H,rgba.data()); out.push_back(std::move(rgba)); }
    if(st) break; }
  vpx_codec_destroy(&c); return st;
}
// 10-bit variant: each output Bytes is W*H*4 uint16 samples (10-bit codes).
int decodeRGBTrack16(std::vector<Frame>& frs, int W, int H, size_t maxFrames, std::vector<Bytes>& out){
  std::stable_sort(frs.begin(),frs.end(),[](const Frame&a,const Frame&b){return a.timeMs<b.timeMs;});
  vpx_codec_ctx_t c{}; if(vpx_codec_dec_init(&c,vpx_codec_vp9_dx(),nullptr,0)) return DEC_CODEC;
  int st=DEC_OK;
  for(auto& f : frs){ if(vpx_codec_decode(&c,f.data,(unsigned)f.len,nullptr,0)){ st=DEC_CODEC; break; }
    vpx_image_t* img; vpx_codec_iter_t it=nullptr;
    while((img=vpx_codec_get_frame(&c,&it))){
      if(!imageMatches16(img,W,H)){ st=DEC_GEOMETRY; break; }
      if(out.size()>=maxFrames){ st=DEC_CAPACITY; break; }
      Bytes rgba((size_t)W*H*4*2); i42016ToRGBA16(img,W,H,(uint16_t*)rgba.data()); out.push_back(std::move(rgba)); }
    if(st) break; }
  vpx_codec_destroy(&c); return st;
}

// Build a full file from any number of RGB streams and lossless signals. An enabled `hdr`
// makes every RGB stream a 10-bit profile-2 track whose `rgbas` pointers are really
// `const uint16_t*` planes of 10-bit codes.
int buildFileMulti(const uint8_t* const* rgbas, const std::vector<RgbEncodeSpec>& rgbSpecs,
                   const std::vector<SignalEncodeSpec>& specs,
                   int W, int H, int N, int fps, Bytes& file, const HdrMeta& hdr=HdrMeta{}){
  if(specs.empty() && rgbSpecs.empty()) return 1;
  if(!rgbSpecs.empty() && !rgbas) return 1;
  if(!dimsUsable(W,H) || N<=0 || fps<=0) return 1;
  const size_t rgbFrameBytes=(size_t)W*(size_t)H*4*(hdr.enabled?2:1);
  // Guard the per-frame strides used below against wrapping.
  if((size_t)N > SIZE_MAX/rgbFrameBytes) return 1;
  std::vector<Frame> frames;
  auto rgbMeta=planRgbTracks(rgbSpecs);
  auto sigMeta=planSignalTracks(specs, rgbSpecs.size());
  struct RgbEnc { std::vector<Bytes> F; std::vector<bool> K; };
  std::vector<RgbEnc> rgbEnc(rgbSpecs.size());
  for(size_t ri=0; ri<rgbSpecs.size(); ri++) if(!rgbas[ri]) return 1;

  size_t px=(size_t)W*(size_t)H;
  struct SigEnc { std::vector<Bytes> hiF, loF, hiP, loP; std::vector<bool> hiK, loK; };
  std::vector<SigEnc> enc(specs.size());
  for(size_t si=0; si<specs.size(); si++) if(!specs[si].data) return 1;

  // Pack every signal before encoding any of them. Packing is cheap next to
  // lossless coding, and doing it up front is what lets the plane encodes run
  // side by side — the streaming path had to make the same change, because a
  // shared hi/lo scratch pair is exactly what forces encodes to be serial.
  for(size_t si=0; si<specs.size(); si++){
    auto& sp=specs[si]; auto& se=enc[si];
    se.hiP.resize(N); se.loP.resize(N);
    for(int i=0;i<N;i++){
      se.hiP[i].resize(px); se.loP[i].resize(px);
      pack(sp.data+(size_t)i*px, px, se.hiP[i].data(), se.loP[i].data());
    }
  }

  // One task per track. Every track is an independent VP9 encoder writing only
  // its own vectors, so the wall clock becomes the slowest track rather than
  // their sum. Measured at 752x480 with RGB + depth, where the two lossless
  // depth planes dominate: 91 ms/frame serial, 48 ms/frame here.
  //
  // Error codes are collected per task and returned in the original order, so a
  // failure reports the same code it did when this ran serially.
  {
    std::vector<std::function<int()>> tasks;
    tasks.reserve(rgbSpecs.size() + 2*specs.size());
    for(size_t ri=0; ri<rgbSpecs.size(); ri++){
      tasks.push_back([&,ri]()->int{
        std::vector<const uint8_t*> p(N);
        for(int i=0;i<N;i++) p[i]=rgbas[ri]+(size_t)i*rgbFrameBytes;
        int kbps=rgbSpecs[ri].kbps;
        if(!encodeRGBSeq(p,W,H,fps,kbps?kbps:2000,rgbEnc[ri].F,rgbEnc[ri].K,hdr.enabled)) return 2;
        if((int)rgbEnc[ri].F.size()!=N) return 6;
        return 0;
      });
    }
    for(size_t si=0; si<specs.size(); si++){
      tasks.push_back([&,si]()->int{
        auto& se=enc[si];
        std::vector<const uint8_t*> hp(N);
        for(int i=0;i<N;i++) hp[i]=se.hiP[i].data();
        if(EncStatus st=encodePlaneSeq(hp,W,H,fps,se.hiF,se.hiK))
          return st==ENC_NO_LOSSLESS?DC_ERR_CODEC:3;
        if((int)se.hiF.size()!=N) return 7;
        return 0;
      });
      tasks.push_back([&,si]()->int{
        auto& se=enc[si];
        std::vector<const uint8_t*> lp(N);
        for(int i=0;i<N;i++) lp[i]=se.loP[i].data();
        if(EncStatus st=encodePlaneSeq(lp,W,H,fps,se.loF,se.loK))
          return st==ENC_NO_LOSSLESS?DC_ERR_CODEC:4;
        if((int)se.loF.size()!=N) return 7;
        return 0;
      });
    }

    std::vector<int> rcOf(tasks.size(), 0);
    std::vector<std::future<void>> running;
    running.reserve(tasks.size());
    for(size_t k=1;k<tasks.size();k++)
      running.push_back(std::async(std::launch::async, [&,k]{ rcOf[k]=tasks[k](); }));
    if(!tasks.empty()) rcOf[0]=tasks[0]();      // slot 0 here: one fewer hand-off
    for(auto& f : running) f.get();
    for(size_t k=0;k<rcOf.size();k++) if(rcOf[k]) return rcOf[k];
  }
  for(int i=0;i<N;i++){ int t=(int)(1000.0*i/fps);
    for(size_t ri=0; ri<rgbSpecs.size(); ri++)
      frames.push_back({rgbMeta[ri].track,(bool)rgbEnc[ri].K[i],t,rgbEnc[ri].F[i].data(),rgbEnc[ri].F[i].size()});
    for(size_t si=0; si<specs.size(); si++){
      auto& se=enc[si]; auto& sm=sigMeta[si];
      frames.push_back({sm.track_hi,(bool)se.hiK[i],t,se.hiF[i].data(),se.hiF[i].size()});
      frames.push_back({sm.track_lo,(bool)se.loK[i],t,se.loF[i].data(),se.loF[i].size()});
    }
  }
  int durationMs = (int)llround(N * 1000.0 / (fps>0?fps:30));
  file = mux(tracksForPlan(sigMeta, rgbMeta, W, H, hdr), frames,
             buildMetadataJson(W,H,N,fps,rgbMeta,sigMeta,/*streaming=*/false,hdr), durationMs);
  return 0;
}
// Every dc_* entry point allocates (std::vector/std::string sized from file or caller-supplied
// dimensions), so std::bad_alloc is reachable with crafted input. Letting it unwind through
// extern "C" is undefined behaviour and in practice calls std::terminate, killing the host
// process — including the Python interpreter. Funnel every entry through this instead.
template <class F>
int guard(F&& body) noexcept {
  try { return body(); }
  catch(const std::bad_alloc&){ return DC_ERR_INTERNAL; }
  catch(...){ return DC_ERR_INTERNAL; }
}
} // namespace

// ── streaming encoder state (the opaque handle behind dc_stream_*) ──
// One VP9 encoder per track, held open for the length of the recording, feeding an incremental
// muxer. Slots are ordered RGB streams (declaration order) then hi/lo per signal — ascending
// track number, so a frame's blocks reach the mux in the order the cluster rule expects.
//
// Each slot timestamps from its own output counter rather than a shared frame index. With
// g_lag_in_frames=0 every push yields exactly one packet, so the counters stay in lockstep and a
// frame's blocks all land on the same timestamp; deriving the time per track rather than assuming
// it keeps that an observation instead of a requirement.
struct dc_stream_encoder {
  struct Slot {
    int track=0;
    std::unique_ptr<TrackEncoder> enc;
    int emitted=0;              // packets already muxed from this track
  };
  int W=0, H=0, fps=30;
  bool finished=false;
  HdrMeta hdr;                    // enabled ⇒ every RGB slot is the 10-bit profile-2 track
  std::vector<RgbMeta> rgbMeta;   // every RGB stream, primary first (empty = no RGB)
  std::vector<SignalMeta> sigMeta;
  std::vector<Slot> slots;
  int textTrack=0;              // 0 when no metadata track was declared
  StreamMux mux;
  struct Packed { Bytes hi, lo; };
  std::vector<Packed> packed;   // per-signal packing scratch, reused across the take

  /**
   * Drive every track through one round — a frame when `rgbas`/`planes` are given, a flush when
   * both are NULL — and mux whatever packets come back, appending any finished Cluster bytes to
   * `chunk`. Returns 0, or the error code named by whichever track failed.
   */
  int round(const uint8_t* const* rgbas, const uint16_t* const* planes, Bytes& chunk){
    // Each track is an independent VP9 encoder, so the slots can run concurrently;
    // only the muxing has to stay ordered. Packing moves ahead of the encode and
    // into per-signal buffers — the old single hi/lo scratch pair was reused across
    // signals, which is exactly what forced the encodes to be serial.
    size_t px=(size_t)W*(size_t)H;
    if(planes){
      packed.resize(sigMeta.size());
      for(size_t i=0;i<sigMeta.size();i++){
        packed[i].hi.resize(px); packed[i].lo.resize(px);
        pack(planes[i], px, packed[i].hi.data(), packed[i].lo.data());
      }
    }

    // Source plane and error code per slot, in slot (== ascending track) order.
    std::vector<const uint8_t*> src(slots.size(), nullptr);
    std::vector<int> errOf(slots.size(), 0);
    size_t idx=0;
    for(size_t i=0;i<rgbMeta.size();i++){ src[idx]=rgbas?rgbas[i]:nullptr; errOf[idx]=2; idx++; }
    for(size_t i=0;i<sigMeta.size();i++){
      src[idx]=planes?packed[i].hi.data():nullptr; errOf[idx]=3; idx++;
      src[idx]=planes?packed[i].lo.data():nullptr; errOf[idx]=3; idx++;
    }

    std::vector<std::vector<Bytes>> pktsOf(slots.size());
    std::vector<std::vector<bool>> keysOf(slots.size());
    std::vector<int> rcOf(slots.size(), 0);
    {
      // One task per slot. Each writes only its own vectors, so nothing is shared
      // across threads; the encoders hold separate vpx contexts.
      std::vector<std::future<void>> running;
      running.reserve(slots.size());
      for(size_t k=1;k<slots.size();k++){
        running.push_back(std::async(std::launch::async, [&,k]{
          if(!slots[k].enc->encode(src[k], pktsOf[k], keysOf[k])) rcOf[k]=errOf[k];
        }));
      }
      // Slot 0 on this thread: one fewer hand-off, and it is usually RGB, the
      // longest single track.
      if(!slots.empty() && !slots[0].enc->encode(src[0], pktsOf[0], keysOf[0])) rcOf[0]=errOf[0];
      for(auto& f : running) f.get();
    }
    for(size_t k=0;k<slots.size();k++) if(rcOf[k]) return rcOf[k];

    std::vector<Bytes> pkts; std::vector<bool> keys;
    std::vector<int> trackOf, timeOf;
    for(size_t k=0;k<slots.size();k++){
      for(size_t n=0;n<pktsOf[k].size();n++){
        pkts.push_back(std::move(pktsOf[k][n]));
        keys.push_back(keysOf[k][n]);
        trackOf.push_back(slots[k].track);
        timeOf.push_back((int)(1000.0*slots[k].emitted/fps));
        slots[k].emitted++;
      }
    }

    // Blocks must reach the mux in (time, track) order: the cluster boundary is decided by the cue
    // track's keyframe, and a block sorted ahead of it would land in the closing cluster instead of
    // the one it belongs to.
    std::vector<size_t> order(pkts.size());
    for(size_t k=0;k<order.size();k++) order[k]=k;
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b){
      return timeOf[a]!=timeOf[b] ? timeOf[a]<timeOf[b] : trackOf[a]<trackOf[b]; });
    for(size_t k : order){
      Frame f{trackOf[k], (bool)keys[k], timeOf[k], pkts[k].data(), pkts[k].size()};
      append(chunk, mux.writeFrame(f));
    }
    return 0;
  }
};

// ── C ABI ──
extern "C" {

static int finish(Bytes& file, uint8_t** out, size_t* out_len){
  *out=(uint8_t*)malloc(file.size()); if(!*out) return 5;
  memcpy(*out, file.data(), file.size()); *out_len=file.size(); return 0;
}

// As finish(), but an empty chunk is handed back as NULL/0 rather than a zero-byte allocation —
// most frames only extend the open cluster and produce no bytes at all.
static int emitChunk(const Bytes& b, uint8_t** out, size_t* out_len){
  if(b.empty()){ *out=nullptr; *out_len=0; return 0; }
  *out=(uint8_t*)malloc(b.size()); if(!*out) return 5;
  memcpy(*out, b.data(), b.size()); *out_len=b.size(); return 0;
}

// Map a track-decode status onto this entry point's codes. `codecErr` is the historical
// "decode failed" number each caller already documented (3 for RGB and the hi plane, 4 for lo).
static int decStatusToRc(int st, int codecErr){
  switch(st){
    case DEC_OK:       return 0;
    case DEC_CAPACITY: return DC_ERR_CAPACITY;
    case DEC_GEOMETRY: return DC_ERR_GEOMETRY;
    default:           return codecErr;
  }
}

// Shared stream lookup for the RGB decode entry points. Returns 0 and fills track/bits, or the
// caller's error code. `want10` selects which bit depth the caller's buffer can hold; the
// opposite depth is error 7 — a 10-bit code does not fit uint8, and silently truncating would
// corrupt the one track that exists to be looked at.
static int findRgbStream(const Demuxed& d, const FileMeta& meta, const char* rgb_id, bool want10,
                         int& track){
  if(!meta.has_rgb) return rgb_id ? 8 : 6;   // structural, not a `"rgb":null` substring search
  const RgbMeta* found=nullptr;
  if(!rgb_id){
    found=&meta.rgbs[0];
  }else{
    for(auto& r:meta.rgbs) if(r.id==rgb_id){ found=&r; break; }
    if(!found) return 8;
  }
  if((found->bits==10) != want10) return 7;
  track=found->track;
  if(!rgb_id){
    // Primary stream. The container name is what pre-multi-RGB files were always resolved by,
    // so it stays authoritative when present; the metadata's rgbs[0] covers files without it.
    for(auto& t:d.tracks) if(t.name=="rgb") track=t.number;
  }
  return 0;
}

int dc_decode_rgb_id(const uint8_t* webm, size_t len, const char* rgb_id,
                     uint8_t* rgba_out, size_t rgba_cap){
  if(!webm || !len || !rgba_out) return 1;
  return guard([&]{
  Demuxed d=demux(webm,len); if(d.metadata.empty()) return 1;
  FileMeta meta=parseMetadata(d.metadata);   // reads the keys once, with defaults when absent
  int rgbTrack=0;
  if(int rc=findRgbStream(d,meta,rgb_id,/*want10=*/false,rgbTrack)) return rc;
  int W=meta.width, H=meta.height;
  if(!dimsUsable(W,H)) return 2;
  size_t frameBytes=(size_t)W*H*4;
  std::vector<Frame> frs; for(auto& f:d.frames) if(f.track==rgbTrack) frs.push_back(f);
  std::vector<Bytes> planes;
  int st=decodeRGBTrack(frs,W,H,rgba_cap/frameBytes,planes);
  if(st) return decStatusToRc(st,3);
  for(size_t i=0;i<planes.size();i++) memcpy(rgba_out+i*frameBytes, planes[i].data(), frameBytes);
  return 0;
  });
}

int dc_decode_rgb16(const uint8_t* webm, size_t len, const char* rgb_id,
                    uint16_t* out, size_t out_cap){
  if(!webm || !len || !out) return 1;
  return guard([&]{
  Demuxed d=demux(webm,len); if(d.metadata.empty()) return 1;
  FileMeta meta=parseMetadata(d.metadata);
  int rgbTrack=0;
  if(int rc=findRgbStream(d,meta,rgb_id,/*want10=*/true,rgbTrack)) return rc;
  int W=meta.width, H=meta.height;
  if(!dimsUsable(W,H)) return 2;
  size_t frameElems=(size_t)W*H*4;
  std::vector<Frame> frs; for(auto& f:d.frames) if(f.track==rgbTrack) frs.push_back(f);
  std::vector<Bytes> planes;   // each W*H*4 uint16 samples
  int st=decodeRGBTrack16(frs,W,H,out_cap/frameElems,planes);
  if(st) return decStatusToRc(st,3);
  for(size_t i=0;i<planes.size();i++) memcpy(out+i*frameElems, planes[i].data(), frameElems*2);
  return 0;
  });
}

int dc_decode_rgb(const uint8_t* webm, size_t len, uint8_t* rgba_out, size_t rgba_cap){
  return dc_decode_rgb_id(webm, len, NULL, rgba_out, rgba_cap);
}

int dc_probe(const uint8_t* webm, size_t len, int* W, int* H, int* N, int* fps,
             double* near_, double* far_, int* levels, int* has_rgb){
  if(!webm || !len) return 1;
  return guard([&]{
  Demuxed d = demux(webm,len); if(d.metadata.empty()) return 1;
  FileMeta meta = parseMetadata(d.metadata);
  if(W) *W=meta.width;
  if(H) *H=meta.height;
  // Streaming files carry "frames":null (the count isn't known when the header is emitted),
  // so fall back to counting actual blocks on the busiest track. This is a hint, not a
  // guarantee: metadata can lie and one block can hold a VP9 superframe of several images, so
  // block counting can over- or under-shoot. Callers size decode buffers from this N and pass
  // that size as the dc_decode_* capacity, which is what actually bounds the writes.
  int n = meta.frames;
  if(n <= 0){
    std::vector<int> seen;
    for(auto& f : d.frames){ bool dup=false; for(int t:seen) if(t==f.track){dup=true;break;} if(!dup) seen.push_back(f.track); }
    for(int t : seen){ int c=0; for(auto& f : d.frames) if(f.track==t) c++; n=std::max(n,c); }
  }
  if(N) *N=n;
  if(fps) *fps=meta.fps;
  if(has_rgb) *has_rgb = (int)meta.rgbs.size();   // stream count; 0/1 for pre-v3 files
  const SignalMeta* depth = findSignal(meta, "depth");
  if(depth && depth->quant.inverse_depth){
    if(near_) *near_=depth->quant.near_;
    if(far_) *far_=depth->quant.far_;
    if(levels) *levels=depth->quant.levels;
  }else{
    if(levels) *levels=65536;
  }
  return 0;
  });
}

int dc_decode_signal(const uint8_t* webm, size_t len, const char* signal_id,
                     uint16_t* out, size_t out_cap){
  if(!webm || !len || !signal_id || !out) return 1;
  return guard([&]{
  Demuxed d = demux(webm,len); if(d.metadata.empty()) return 1;
  FileMeta meta = parseMetadata(d.metadata);
  const SignalMeta* sig = findSignal(meta, signal_id);
  if(!sig) return 8;
  int W=meta.width, H=meta.height;
  if(!dimsUsable(W,H)) return 2;
  size_t px=(size_t)W*H;
  size_t maxFrames=out_cap/px;
  std::vector<Frame> hi, lo;
  for(auto& f : d.frames){
    if(f.track==sig->track_hi) hi.push_back(f);
    else if(f.track==sig->track_lo) lo.push_back(f);
  }
  std::vector<Bytes> hiP, loP;
  int st=decodePlaneTrack(hi,W,H,maxFrames,hiP); if(st) return decStatusToRc(st,3);
  st=decodePlaneTrack(lo,W,H,maxFrames,loP);     if(st) return decStatusToRc(st,4);
  if(hiP.size()!=loP.size()) return 5;
  for(size_t i=0;i<hiP.size();i++) unpack(hiP[i].data(), loP[i].data(), px, out+i*px);
  return 0;
  });
}

int dc_get_metadata(const uint8_t* webm, size_t len, char** json_out, size_t* json_len){
  if(!webm || !len || !json_out || !json_len) return 1;
  return guard([&]{
  Demuxed d = demux(webm,len); if(d.metadata.empty()) return 1;
  size_t n = d.metadata.size();
  char* buf = (char*)malloc(n + 1);
  if(!buf) return 5;
  memcpy(buf, d.metadata.c_str(), n);
  buf[n] = '\0';
  *json_out = buf; *json_len = n;   // publish only once both succeed, so a failed call frees nothing
  return 0;
  });
}

// Shared spec conversion: the v1 struct is the v2 struct without `view`.
static void signalSpecFrom(const dc_signal_spec_t& in, SignalEncodeSpec& s){
  s.id=in.id; s.data=in.data;
  if(in.inverse_depth){
    s.quant.inverse_depth=true;
    s.quant.near_=in.near_; s.quant.far_=in.far_;
    s.quant.levels = in.levels<=0 ? 65536 : in.levels;
  }
}
static void signalSpecFrom2(const dc_signal_spec2_t& in, SignalEncodeSpec& s){
  s.id=in.id; s.data=in.data;
  if(in.inverse_depth){
    s.quant.inverse_depth=true;
    s.quant.near_=in.near_; s.quant.far_=in.far_;
    s.quant.levels = in.levels<=0 ? 65536 : in.levels;
  }
  if(in.view && *in.view) s.view=in.view;
}

int dc_encode_multi2(const uint8_t* const* rgbas,
                     const dc_rgb_spec_t* rgbs, int num_rgbs,
                     const dc_signal_spec2_t* signals, int num_signals,
                     int W, int H, int N, int fps,
                     uint8_t** out, size_t* out_len){
  // fps reaches the encoder timebase (g_timebase.den) and the block timestamps (1000*i/fps);
  // at 0 the first divides by zero and the second yields inf, which is UB when cast to int.
  // dimsUsable is the same bound the decoders enforce — here it also keeps the encoder's int
  // plane arithmetic from wrapping (W=H=65536 wraps W*H to 0, so the encoder would read rows
  // out of a zero-length plane).
  if(!out || !out_len || N<=0 || fps<=0 || !dimsUsable(W,H)) return 1;
  if(num_signals<=0 && num_rgbs<=0) return 1;
  if(num_signals>0 && !signals) return 1;
  if(num_rgbs>0 && !rgbas) return 1;
  return guard([&]{
  std::vector<RgbEncodeSpec> rgbSpecs;
  if(!normalizeRgbSpecs(rgbs, num_rgbs, rgbSpecs)) return 1;
  std::vector<SignalEncodeSpec> specs;
  for(int i=0;i<num_signals;i++){
    if(!signals[i].id || !signals[i].data) return 1;
    SignalEncodeSpec s; signalSpecFrom2(signals[i], s);
    specs.push_back(s);
  }
  Bytes file; int rc=buildFileMulti(rgbas, rgbSpecs, specs, W, H, N, fps, file);
  if(rc) return rc;
  return finish(file, out, out_len);
  });
}

// Validate and widen the ABI's hdr description. False = unusable (error 1 at the caller).
static bool hdrFromAbi(const dc_hdr_meta_t* in, HdrMeta& out){
  if(!in) return false;
  if(in->transfer!=16 && in->transfer!=18) return false;
  out.enabled=true;
  out.transfer=in->transfer;
  out.maxCll=in->max_cll>0?in->max_cll:0;
  out.maxFall=in->max_fall>0?in->max_fall:0;
  if(in->has_mastering){
    out.hasMastering=true;
    out.rx=in->rx; out.ry=in->ry; out.gx=in->gx; out.gy=in->gy; out.bx=in->bx; out.by=in->by;
    out.wx=in->wx; out.wy=in->wy; out.lumMax=in->luminance_max; out.lumMin=in->luminance_min;
  }
  return true;
}

int dc_encode_multi_hdr(const uint16_t* const* rgbas,
                        const dc_rgb_spec_t* rgbs, int num_rgbs,
                        const dc_hdr_meta_t* hdr,
                        const dc_signal_spec2_t* signals, int num_signals,
                        int W, int H, int N, int fps,
                        uint8_t** out, size_t* out_len){
  if(!out || !out_len || N<=0 || fps<=0 || !dimsUsable(W,H)) return 1;
  if(num_rgbs<=0 || !rgbas) return 1;      // HDR describes the display track; there must be one
  if(num_signals>0 && !signals) return 1;
  return guard([&]{
  HdrMeta h;
  if(!hdrFromAbi(hdr,h)) return 1;
  std::vector<RgbEncodeSpec> rgbSpecs;
  if(!normalizeRgbSpecs(rgbs, num_rgbs, rgbSpecs)) return 1;
  std::vector<SignalEncodeSpec> specs;
  for(int i=0;i<num_signals;i++){
    if(!signals[i].id || !signals[i].data) return 1;
    SignalEncodeSpec s; signalSpecFrom2(signals[i], s);
    specs.push_back(s);
  }
  Bytes file;
  int rc=buildFileMulti((const uint8_t* const*)rgbas, rgbSpecs, specs, W, H, N, fps, file, h);
  if(rc) return rc;
  return finish(file, out, out_len);
  });
}

int dc_encode_multi(const uint8_t* rgba, int rgb_kbps,
                    const dc_signal_spec_t* signals, int num_signals,
                    int W, int H, int N, int fps,
                    uint8_t** out, size_t* out_len){
  if(!out || !out_len || N<=0 || fps<=0 || !dimsUsable(W,H)) return 1;
  if(num_signals<=0 && !rgba) return 1;
  if(num_signals>0 && !signals) return 1;
  return guard([&]{
  std::vector<RgbEncodeSpec> rgbSpecs;
  if(rgba) rgbSpecs.push_back({"rgb", rgb_kbps});
  std::vector<SignalEncodeSpec> specs;
  for(int i=0;i<num_signals;i++){
    const dc_signal_spec_t& in=signals[i];
    if(!in.id || !in.data) return 1;
    SignalEncodeSpec s; signalSpecFrom(in, s);
    specs.push_back(s);
  }
  const uint8_t* arr[1]={rgba};
  Bytes file; int rc=buildFileMulti(rgba?arr:nullptr, rgbSpecs, specs, W, H, N, fps, file);
  if(rc) return rc;
  return finish(file, out, out_len);
  });
}

int dc_stream_create(int W, int H, int fps, int rgb_kbps, int has_rgb, int emit_cues,
                     const dc_signal_spec_t* signals, int num_signals,
                     dc_stream_encoder_t** out){
  return dc_stream_create_ex(W,H,fps,rgb_kbps,has_rgb,emit_cues,signals,num_signals,NULL,out);
}

int dc_stream_create_ex(int W, int H, int fps, int rgb_kbps, int has_rgb, int emit_cues,
                     const dc_signal_spec_t* signals, int num_signals,
                     const char* text_track_name,
                     dc_stream_encoder_t** out){
  if(num_signals>0 && !signals) return 1;
  return guard([&]() -> int {
  // The v1 struct is the v2 struct without `view`; widen and delegate.
  std::vector<dc_signal_spec2_t> specs2(num_signals>0?num_signals:0);
  for(int i=0;i<num_signals;i++){
    const dc_signal_spec_t& in=signals[i];
    specs2[i]={in.id, in.data, in.inverse_depth, in.near_, in.far_, in.levels, NULL};
  }
  dc_rgb_spec_t rgb{NULL, rgb_kbps};
  return dc_stream_create2(W,H,fps, has_rgb?&rgb:NULL, has_rgb?1:0, emit_cues,
                           num_signals>0?specs2.data():NULL, num_signals, text_track_name, out);
  });
}

static int streamCreateImpl(int W, int H, int fps,
                     const dc_rgb_spec_t* rgbs, int num_rgbs, const HdrMeta& hdr, int emit_cues,
                     const dc_signal_spec2_t* signals, int num_signals,
                     const char* text_track_name,
                     dc_stream_encoder_t** out){
  if(!out || num_signals<0 || fps<=0 || !dimsUsable(W,H)) return 1;
  if(num_signals>0 && !signals) return 1;
  if(num_signals<=0 && num_rgbs<=0) return 1;
  return guard([&]() -> int {
  std::vector<RgbEncodeSpec> rgbSpecs;
  if(!normalizeRgbSpecs(rgbs, num_rgbs, rgbSpecs)) return 1;
  std::vector<SignalEncodeSpec> specs;
  for(int i=0;i<num_signals;i++){
    if(!signals[i].id) return 1;
    SignalEncodeSpec s; signalSpecFrom2(signals[i], s);
    s.data=nullptr;   // unused here: planes arrive per frame
    specs.push_back(s);
  }
  std::unique_ptr<dc_stream_encoder> h(new dc_stream_encoder());
  h->W=W; h->H=H; h->fps=fps; h->hdr=hdr;
  h->rgbMeta=planRgbTracks(rgbSpecs);
  h->sigMeta=planSignalTracks(specs, rgbSpecs.size());
  for(size_t i=0;i<rgbSpecs.size();i++){
    auto enc=std::unique_ptr<TrackEncoder>(new TrackEncoder());
    int kbps=rgbSpecs[i].kbps;
    if(enc->init(W,H,fps,/*lossless=*/false,kbps?kbps:2000,/*keyEvery=*/fps,hdr.enabled)) return 2;
    h->slots.push_back({h->rgbMeta[i].track, std::move(enc), 0});
  }
  for(auto& sm : h->sigMeta){
    for(int track : {sm.track_hi, sm.track_lo}){
      auto enc=std::unique_ptr<TrackEncoder>(new TrackEncoder());
      if(EncStatus st=enc->init(W,H,fps,/*lossless=*/true,0,/*keyEvery=*/fps>0?fps:30))
        return st==ENC_NO_LOSSLESS?DC_ERR_CODEC:3;
      h->slots.push_back({track, std::move(enc), 0});
    }
  }
  // One cluster per second of media, rather than the batch muxer's 30s cap. Clusters normally
  // close on an RGB keyframe (also ~1s apart), but a recording with no RGB track has keyframes
  // only on frame 0 — and a live writer that emitted nothing for 30 seconds, while holding those
  // 30 seconds of blocks open, would defeat the point of streaming.
  h->mux.clusterSpanMs=1000;
  h->mux.emitCues=emit_cues!=0;
  std::vector<Track> tracks = tracksForPlan(h->sigMeta, h->rgbMeta, W, H, hdr);
  if(text_track_name && *text_track_name){
    int next = 1; for(auto& t : tracks) next = std::max(next, t.number+1);
    // Appended last so existing track numbers are unchanged, and typed subtitle so
    // ordinary players and ffmpeg treat it as timed text rather than a broken video.
    // WebM defines its own WebVTT CodecIDs; Matroska's S_TEXT/WEBVTT is not among
    // them and ffmpeg reports the track as an unknown codec. METADATA rather than
    // SUBTITLES because these cues are machine-readable data — players must not
    // render them over the picture, and browsers expose them as a metadata
    // TextTrack rather than displayed subtitles.
    tracks.push_back({next,"D_WEBVTT/SUBTITLES",text_track_name,0,0,17});
    h->textTrack = next;
  }
  h->mux.start(tracks,
               buildMetadataJson(W,H,0,fps,h->rgbMeta,h->sigMeta,/*streaming=*/true,hdr));
  *out=h.release();
  return 0;
  });
}

int dc_stream_create2(int W, int H, int fps,
                     const dc_rgb_spec_t* rgbs, int num_rgbs, int emit_cues,
                     const dc_signal_spec2_t* signals, int num_signals,
                     const char* text_track_name,
                     dc_stream_encoder_t** out){
  return streamCreateImpl(W,H,fps,rgbs,num_rgbs,HdrMeta{},emit_cues,
                          signals,num_signals,text_track_name,out);
}

int dc_stream_create_hdr(int W, int H, int fps,
                         const dc_rgb_spec_t* rgbs, int num_rgbs,
                         const dc_hdr_meta_t* hdr, int emit_cues,
                         const dc_signal_spec2_t* signals, int num_signals,
                         const char* text_track_name,
                         dc_stream_encoder_t** out){
  HdrMeta h;
  if(!hdrFromAbi(hdr,h)) return 1;
  if(num_rgbs<=0) return 1;   // HDR describes the display track; there must be one
  return streamCreateImpl(W,H,fps,rgbs,num_rgbs,h,emit_cues,
                          signals,num_signals,text_track_name,out);
}

int dc_stream_header(dc_stream_encoder_t* enc, uint8_t** out, size_t* out_len){
  if(!enc || !out || !out_len) return 1;
  return guard([&]{ return emitChunk(enc->mux.header, out, out_len); });
}

int dc_stream_add_text(dc_stream_encoder_t* enc, int timestamp_ms, int duration_ms,
                       const uint8_t* utf8, size_t len, uint8_t** out, size_t* out_len){
  if(!enc || !utf8 || !out || !out_len) return 1;
  if(enc->finished || !enc->textTrack) return 1;
  if(timestamp_ms < 0 || duration_ms < 0) return 1;
  return guard([&]{
    Bytes chunk = enc->mux.writeText(enc->textTrack, timestamp_ms, duration_ms, utf8, len);
    return emitChunk(chunk, out, out_len);
  });
}

// Shared body of the 8- and 16-bit add_frame forms; the caller has already checked that its
// bit depth matches the encoder's, so `rgbas` pointers are whatever the slots expect.
static int streamAddFrameImpl(dc_stream_encoder_t* enc, const uint8_t* const* rgbas,
                              const uint16_t* const* signal_planes,
                              uint8_t** out, size_t* out_len){
  if(!enc || !out || !out_len) return 1;
  if(enc->finished) return 6;
  // RGB presence is frozen by the track plan in the header that has already gone out, so a frame
  // that disagrees with it cannot be written to any track this file declares.
  if(enc->rgbMeta.empty() != (rgbas==nullptr)) return 1;
  if(!enc->sigMeta.empty() && !signal_planes) return 1;
  return guard([&]() -> int {
  for(size_t i=0;i<enc->rgbMeta.size();i++) if(!rgbas[i]) return 1;
  for(size_t i=0;i<enc->sigMeta.size();i++) if(!signal_planes[i]) return 1;
  Bytes chunk;
  if(int rc=enc->round(rgbas, signal_planes, chunk)) return rc;
  return emitChunk(chunk, out, out_len);
  });
}

int dc_stream_add_frame2(dc_stream_encoder_t* enc, const uint8_t* const* rgbas,
                         const uint16_t* const* signal_planes,
                         uint8_t** out, size_t* out_len){
  if(!enc) return 1;
  // The bit depth was fixed by the header: an HDR encoder's RGB slots read uint16 planes, so an
  // 8-bit frame here would be reinterpreted, not converted.
  if(enc->hdr.enabled && !enc->rgbMeta.empty()) return 1;
  return streamAddFrameImpl(enc, rgbas, signal_planes, out, out_len);
}

int dc_stream_add_frame16(dc_stream_encoder_t* enc, const uint16_t* const* rgbas,
                          const uint16_t* const* signal_planes,
                          uint8_t** out, size_t* out_len){
  if(!enc) return 1;
  if(!enc->hdr.enabled) return 1;
  return streamAddFrameImpl(enc, (const uint8_t* const*)rgbas, signal_planes, out, out_len);
}

int dc_stream_add_frame(dc_stream_encoder_t* enc, const uint8_t* rgba,
                        const uint16_t* const* signal_planes,
                        uint8_t** out, size_t* out_len){
  if(!enc) return 1;
  // A multi-RGB stream cannot be fed through the single-pointer form: the array length is the
  // contract, and one pointer is not two.
  if(enc->rgbMeta.size()>1) return 1;
  const uint8_t* arr[1]={rgba};
  return dc_stream_add_frame2(enc, rgba?arr:NULL, signal_planes, out, out_len);
}

int dc_stream_finish(dc_stream_encoder_t* enc, uint8_t** out, size_t* out_len){
  if(!enc || !out || !out_len) return 1;
  if(enc->finished) return 6;
  return guard([&]() -> int {
  Bytes chunk;
  if(int rc=enc->round(nullptr, nullptr, chunk)) return rc;   // NULL everywhere = flush the codecs
  append(chunk, enc->mux.finish());
  enc->finished=true;
  return emitChunk(chunk, out, out_len);
  });
}

void dc_stream_destroy(dc_stream_encoder_t* enc){ delete enc; }

// The Python/JS wrappers reject an unusable inverse-depth range before they get here, but the ABI
// is callable directly, so re-check: near_/far_ of 0 make 1/near_ infinite, near_==far_ makes the
// a-b span 0, and levels<3 makes M=levels-2 zero — each divides by zero and floods the output with
// inf/NaN. Emit the invalid code (0 / NaN) for the whole buffer instead, matching how these
// functions already mark unrepresentable samples.
static bool inverseRangeUsable(double near_, double far_, int levels){
  if(levels<3) return false;
  if(!(near_>0) || !(far_>0)) return false;
  double a=1.0/near_, b=1.0/far_;
  return std::isfinite(a) && std::isfinite(b) && a!=b;
}

void dc_quantize_inverse(const float* z, int n, double near_, double far_, int levels, uint16_t* out){
  if(n<=0 || !z || !out) return;
  if(levels<=0) levels=65536;
  if(!inverseRangeUsable(near_,far_,levels)){ for(int i=0;i<n;i++) out[i]=0; return; }
  double M=levels-2, maxc=levels-1;
  double a=1.0/near_, b=1.0/far_, inv=1.0/(a-b);
  for(int i=0;i<n;i++){ double v=z[i];
    if(!(v>0)){ out[i]=0; continue; }
    double t=(1.0/v - b)*inv*M;
    // Clamp in double space *before* the integer conversion. A depth just above zero drives t to
    // ~1e34, and lround() of a value outside long's range is undefined behaviour: the same source
    // returned maxc at -O2 and 1 — the *farthest* code for the nearest possible depth — at -O0.
    // Clamping first also makes this agree with the JS Math.round path on negative t, where
    // lround (half away from zero) and Math.round (half up) otherwise differ.
    if(!(t>0.0)){ out[i]=1; continue; }              // t <= 0, or NaN from a degenerate range
    if(t>=maxc){ out[i]=(uint16_t)maxc; continue; }
    long q=lround(t)+1; out[i]=(uint16_t)(q<1?1:(q>maxc?(long)maxc:q)); }
}
void dc_dequantize_inverse(const uint16_t* d, int n, double near_, double far_, int levels, float* out){
  if(n<=0 || !d || !out) return;
  if(levels<=0) levels=65536;
  if(!inverseRangeUsable(near_,far_,levels)){ for(int i=0;i<n;i++) out[i]=NAN; return; }
  double M=levels-2;
  double a=1.0/near_, b=1.0/far_;
  for(int i=0;i<n;i++){ unsigned c=d[i];
    out[i]= c==0 ? NAN : (float)(1.0/(((double)(c-1)/M)*(a-b)+b)); }
}

void dc_free(uint8_t* p){ free(p); }

} // extern "C"
