// chromapakz native core: triangle-fold packing + libvpx VP9 lossless + a minimal
// Matroska/WebM mux/demux that is byte-compatible with src/webm.js.
#include "chromapakz.h"
#include <vector>
#include <string>
#include <cstring>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <algorithm>
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
  ID_Cues=0x1C53BB6B, ID_CuePoint=0xBB, ID_CueTime=0xB3, ID_CueTrackPositions=0xB7,
  ID_CueTrack=0xF7, ID_CueClusterPosition=0xF1,
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

struct Track { int number; std::string codecID, name; int width, height; };
struct Frame { int track; bool key; int timeMs; const uint8_t* data; size_t len; };

Bytes trackEntry(const Track& t){
  Bytes p;
  append(p, elU(ID_TrackNumber, t.number)); append(p, elU(ID_TrackUID, t.number));
  append(p, elU(ID_TrackType, 1)); append(p, elU(ID_FlagLacing, 0));
  append(p, elS(ID_CodecID, t.codecID));
  if(!t.name.empty()) append(p, elS(ID_Name, t.name));
  if(t.width && t.height){ Bytes v; append(v, elU(ID_PixelWidth, t.width)); append(v, elU(ID_PixelHeight, t.height));
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

Bytes mux(const std::vector<Track>& tracks, std::vector<Frame> frames,
          const std::string& metadata, int durationMs, int clusterSpanMs=30000){
  Bytes hdr;
  append(hdr, elU(ID_EBMLVersion,1)); append(hdr, elU(ID_EBMLReadVersion,1));
  append(hdr, elU(ID_EBMLMaxIDLength,4)); append(hdr, elU(ID_EBMLMaxSizeLength,8));
  append(hdr, elS(ID_DocType,"webm")); append(hdr, elU(ID_DocTypeVersion,2)); append(hdr, elU(ID_DocTypeReadVersion,2));
  Bytes header = el(ID_EBML, hdr);

  Bytes info; append(info, elU(ID_TimestampScale,1000000));
  if(durationMs>0) append(info, el(ID_Duration, f8((double)durationMs)));
  append(info, elS(ID_MuxingApp,"chromapakz")); append(info, elS(ID_WritingApp,"chromapakz"));
  Bytes seg; append(seg, el(ID_Info, info));

  Bytes te; for(auto& t : tracks) append(te, trackEntry(t)); append(seg, el(ID_Tracks, te));

  if(!metadata.empty()){
    Bytes st; append(st, elS(ID_TagName,"CHROMAPAKZ")); append(st, elS(ID_TagString, metadata));
    Bytes tag; append(tag, el(ID_Targets, Bytes{})); append(tag, el(ID_SimpleTag, st));
    append(seg, el(ID_Tags, el(ID_Tag, tag)));
  }

  // Cue track = the RGB track if present, else the first track. Clusters start on its keyframes.
  int cueTrack = tracks.empty()?1:tracks[0].number;
  for(auto& t : tracks) if(t.name=="rgb") cueTrack=t.number;

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

  if(!cues.empty()){
    Bytes cb;
    for(auto& c : cues){
      Bytes tp; append(tp, elU(ID_CueTrack, cueTrack)); append(tp, elU(ID_CueClusterPosition, c.second));
      Bytes pt; append(pt, elU(ID_CueTime, c.first)); append(pt, el(ID_CueTrackPositions, tp));
      append(cb, el(ID_CuePoint, pt));
    }
    append(seg, el(ID_Cues, cb));
  }
  Bytes out = header; append(out, el(ID_Segment, seg));
  return out;
}

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

// ── metadata (v2 signals) ──
bool jnum(const std::string& j, const char* key, double& out){
  std::string k = std::string("\"")+key+"\":"; auto p=j.find(k); if(p==std::string::npos) return false;
  p+=k.size(); while(p<j.size() && (j[p]==' '||j[p]=='\t')) p++;
  // Report failure when nothing numeric follows (e.g. `"width":null`) so callers keep
  // their default instead of silently adopting strtod's 0.
  const char* s=j.c_str()+p; char* e=nullptr; double v=strtod(s,&e);
  if(e==s) return false;
  out=v; return true;
}
bool jstr(const std::string& j, const char* key, std::string& out){
  std::string k = std::string("\"")+key+"\":"; auto p=j.find(k); if(p==std::string::npos) return false;
  p+=k.size(); while(p<j.size() && (j[p]==' '||j[p]=='\t')) p++;
  if(p>=j.size() || j[p]!='"') return false; p++;
  auto e=j.find('"',p); if(e==std::string::npos) return false;
  out=j.substr(p,e-p); return true;
}
bool jint(const std::string& j, const char* key, int& out){
  double v; if(!jnum(j,key,v)) return false; out=(int)v; return true;
}

struct SignalQuantMeta { bool inverse_depth=false; double near_=0, far_=0; int levels=65536; };
struct SignalMeta { std::string id; int track_hi=0, track_lo=0; SignalQuantMeta quant; };
struct FileMeta {
  int version=1, width=0, height=0, fps=30, frames=0;
  bool has_rgb=false; int rgb_track=1;
  std::vector<SignalMeta> signals;
};

void parseSignalsV2(const std::string& j, FileMeta& m){
  auto start=j.find("\"signals\":[");
  if(start==std::string::npos) return;
  start+=11;
  auto arr_end=j.find(']', start);
  if(arr_end==std::string::npos) return;
  size_t pos=start;
  while(pos<arr_end){
    auto idk=j.find("\"id\":", pos);
    if(idk==std::string::npos || idk>=arr_end) break;
    SignalMeta s;
    size_t p=idk+5; while(p<j.size() && j[p]==' ') p++;
    if(p>=j.size() || j[p]!='"'){ pos=idk+1; continue; }
    p++; auto e=j.find('"', p); if(e==std::string::npos) break;
    s.id=j.substr(p,e-p);
    size_t chunk_end=std::min(arr_end, e+480);
    std::string chunk=j.substr(idk, chunk_end-idk);
    double hi=0, lo=0;
    if(jnum(chunk,"hi",hi)) s.track_hi=clampToInt(hi);
    if(jnum(chunk,"lo",lo)) s.track_lo=clampToInt(lo);
    if(chunk.find("inverse-depth")!=std::string::npos){
      s.quant.inverse_depth=true;
      jnum(chunk,"near",s.quant.near_); jnum(chunk,"far",s.quant.far_);
      double lv; if(jnum(chunk,"levels",lv)){ int l=clampToInt(lv); s.quant.levels = l>0 ? l : 65536; }
    }
    // A signal whose two planes are missing or aliased cannot be decoded; drop it here so
    // dc_decode_signal reports "no such signal" rather than unpacking mismatched planes.
    if(s.track_hi>0 && s.track_lo>0 && s.track_hi!=s.track_lo) m.signals.push_back(s);
    pos=e+1;
  }
}

FileMeta parseMetadata(const std::string& j){
  FileMeta m; m.has_rgb = j.find("\"rgb\":null")==std::string::npos && j.find("\"rgb\":")!=std::string::npos;
  // Each key keeps the struct's default when absent — reading an indeterminate `double v`
  // (as this used to) is undefined and produced garbage geometry from truncated metadata.
  double v=0;
  if(jnum(j,"width",v))  m.width =clampToInt(v);
  if(jnum(j,"height",v)) m.height=clampToInt(v);
  if(jnum(j,"fps",v))    m.fps   =clampToInt(v);
  if(jnum(j,"frames",v)) m.frames=clampToInt(v);
  if(jnum(j,"version",v)){ int ver=clampToInt(v); m.version = ver>0 ? ver : 1; }
  if(m.fps<=0) m.fps=30;
  if(m.frames<0) m.frames=0;
  if(m.version>=2) parseSignalsV2(j,m);
  return m;
}

const SignalMeta* findSignal(const FileMeta& m, const char* id){
  for(auto& s : m.signals) if(s.id==id) return &s;
  return nullptr;
}

std::string quantJson(const SignalQuantMeta& q){
  if(!q.inverse_depth) return "null";
  char buf[128];
  snprintf(buf,sizeof buf,"{\"type\":\"inverse-depth\",\"near\":%g,\"far\":%g,\"levels\":%d}",
           q.near_, q.far_, q.levels);
  return buf;
}

std::string buildMetadataJson(int W,int H,int N,int fps,bool hasRgb,const std::vector<SignalMeta>& signals){
  // Built with std::string throughout — the document grows with signal count and id length,
  // so a fixed stack buffer would silently truncate (and emit invalid JSON) past some size.
  std::string sigs="[";
  for(size_t i=0;i<signals.size();i++){
    if(i) sigs+=",";
    const auto& s=signals[i];
    char nums[64]; snprintf(nums,sizeof nums,"\"hi\":%d,\"lo\":%d", s.track_hi, s.track_lo);
    sigs += "{\"id\":\""; sigs += s.id; sigs += "\",\"tracks\":{"; sigs += nums;
    sigs += "},\"codec\":\"vp09.00.10.08\",\"lossless\":true,\"scheme\":\"tri-fold-8+8\","
            "\"dtype\":\"uint16\",\"invalidCode\":0,\"quant\":";
    sigs += quantJson(s.quant); sigs += "}";
  }
  sigs+="]";
  std::string rgb = hasRgb ? "{\"track\":1,\"codec\":\"vp09.00.10.08\"}" : "null";
  char head[160];
  snprintf(head,sizeof head,"{\"version\":2,\"width\":%d,\"height\":%d,\"fps\":%d,\"frames\":%d,\"rgb\":",W,H,fps,N);
  std::string out=head; out+=rgb; out+=",\"signals\":"; out+=sigs; out+="}";
  return out;
}

struct SignalEncodeSpec {
  std::string id;
  const uint16_t* data=nullptr;
  SignalQuantMeta quant;
};

std::vector<SignalMeta> planSignalTracks(const std::vector<SignalEncodeSpec>& specs, bool hasRgb){
  std::vector<SignalMeta> out;
  int next=hasRgb?2:1;
  for(auto& sp : specs){
    SignalMeta s; s.id=sp.id; s.track_hi=next++; s.track_lo=next++; s.quant=sp.quant;
    out.push_back(s);
  }
  return out;
}

// ── triangle-fold 8+8 ──
void pack(const uint16_t* d, size_t n, uint8_t* hi, uint8_t* lo){
  for(size_t i=0;i<n;i++){ int h=d[i]>>8, l=d[i]&0xff; hi[i]=h; lo[i]=(h&1)?(255-l):l; }
}
void unpack(const uint8_t* hi, const uint8_t* lo, size_t n, uint16_t* d){
  for(size_t i=0;i<n;i++){ int h=hi[i], l=(h&1)?(255-lo[i]):lo[i]; d[i]=(uint16_t)((h<<8)|l); }
}

// ── libvpx VP9 lossless encode of an 8-bit luma-plane sequence (chroma const 128) ──
// NO_LOSSLESS is separate from FAIL because it is the one failure a caller can act on: the
// libvpx build cannot do what the metadata would claim.
enum EncStatus { ENC_OK=0, ENC_FAIL=1, ENC_NO_LOSSLESS=2 };

EncStatus encodePlaneSeq(const std::vector<const uint8_t*>& planes, int W, int H, int fps,
                         std::vector<Bytes>& outFrames, std::vector<bool>& outKey){
  vpx_codec_iface_t* iface = vpx_codec_vp9_cx();
  vpx_codec_enc_cfg_t cfg{}; if(vpx_codec_enc_config_default(iface,&cfg,0)) return ENC_FAIL;
  cfg.g_w=W; cfg.g_h=H; cfg.g_timebase.num=1; cfg.g_timebase.den=fps;
  cfg.g_profile=0; cfg.g_lag_in_frames=0; cfg.rc_min_quantizer=0; cfg.rc_max_quantizer=0;
  cfg.kf_mode=VPX_KF_DISABLED; cfg.g_pass=VPX_RC_ONE_PASS; cfg.g_error_resilient=0;
  vpx_codec_ctx_t c{}; if(vpx_codec_enc_init(&c,iface,&cfg,0)) return ENC_FAIL;
  // Gate on the lossless control: an old or misbuilt libvpx that rejects it would encode the
  // packed depth planes LOSSY while the metadata still advertises "lossless":true. Silent data
  // corruption is worse than a failed encode, so refuse rather than proceed.
  if(vpx_codec_control(&c, VP9E_SET_LOSSLESS, 1)){ vpx_codec_destroy(&c); return ENC_NO_LOSSLESS; }
  vpx_codec_control(&c, VP8E_SET_CPUUSED, 1);   // speed knob only — costs time, not fidelity
  vpx_codec_control(&c, VP9E_SET_COLOR_RANGE, VPX_CR_FULL_RANGE);   // signal full-range in the bitstream
  // On failure vpx_img_alloc returns NULL and leaves img.planes unset — the copy loop below
  // would then memcpy through wild pointers.
  vpx_image_t img;
  if(!vpx_img_alloc(&img, VPX_IMG_FMT_I420, W, H, 1)){ vpx_codec_destroy(&c); return ENC_FAIL; }
  // Signal FULL range: depth is packed full-range 0..255 in luma. Without this the stream
  // defaults to limited ("tv") range and any decoder that honours it (e.g. ffmpeg) rescales/
  // clips the luma, corrupting depth. Full-range makes every conformant decoder reproduce Y exactly.
  img.cs = VPX_CS_BT_709; img.range = VPX_CR_FULL_RANGE;
  bool ok=true;
  for(size_t i=0;i<=planes.size() && ok;i++){
    vpx_image_t* in=nullptr;
    if(i<planes.size()){
      for(int r=0;r<H;r++) memcpy(img.planes[0]+r*img.stride[0], planes[i]+r*W, W);
      for(int p=1;p<3;p++) for(int r=0;r<(H+1)/2;r++) memset(img.planes[p]+r*img.stride[p],128,(W+1)/2);
      in=&img;
    }
    vpx_enc_frame_flags_t fl = (i==0)?VPX_EFLAG_FORCE_KF:0;
    if(vpx_codec_encode(&c,in,(vpx_codec_pts_t)i,1,fl,VPX_DL_GOOD_QUALITY)){ ok=false; break; }
    const vpx_codec_cx_pkt_t* pkt; vpx_codec_iter_t it=nullptr;
    while((pkt=vpx_codec_get_cx_data(&c,&it))) if(pkt->kind==VPX_CODEC_CX_FRAME_PKT){
      outFrames.emplace_back((uint8_t*)pkt->data.frame.buf, (uint8_t*)pkt->data.frame.buf+pkt->data.frame.sz);
      outKey.push_back((pkt->data.frame.flags & VPX_FRAME_IS_KEY)!=0);
    }
  }
  vpx_img_free(&img); vpx_codec_destroy(&c);
  return ok ? ENC_OK : ENC_FAIL;
}

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

// Lossy VP9 RGB track (one forced keyframe + P-frames, matching the browser path).
bool encodeRGBSeq(const std::vector<const uint8_t*>& rgba, int W, int H, int fps, int kbps,
                  std::vector<Bytes>& outFrames, std::vector<bool>& outKey){
  vpx_codec_iface_t* iface = vpx_codec_vp9_cx();
  vpx_codec_enc_cfg_t cfg{}; if(vpx_codec_enc_config_default(iface,&cfg,0)) return false;
  cfg.g_w=W; cfg.g_h=H; cfg.g_timebase.num=1; cfg.g_timebase.den=fps; cfg.g_profile=0;
  cfg.g_lag_in_frames=0; cfg.rc_end_usage=VPX_VBR; cfg.rc_target_bitrate=kbps; cfg.kf_mode=VPX_KF_DISABLED;
  vpx_codec_ctx_t c{}; if(vpx_codec_enc_init(&c,iface,&cfg,0)) return false;
  vpx_codec_control(&c, VP8E_SET_CPUUSED, 2);
  vpx_codec_control(&c, VP9E_SET_COLOR_SPACE, VPX_CS_BT_709);
  vpx_codec_control(&c, VP9E_SET_COLOR_RANGE, VPX_CR_FULL_RANGE);
  vpx_image_t img;
  if(!vpx_img_alloc(&img, VPX_IMG_FMT_I420, W, H, 1)){ vpx_codec_destroy(&c); return false; }
  img.cs=VPX_CS_BT_709; img.range=VPX_CR_FULL_RANGE;
  bool ok=true; int keyEvery = fps>0?fps:30;          // ~1s keyframe interval → seekable RGB (Cues)
  for(size_t i=0;i<=rgba.size() && ok;i++){ vpx_image_t* in=nullptr;
    if(i<rgba.size()){ rgbaToI420(rgba[i],W,H,&img); in=&img; }
    vpx_enc_frame_flags_t fl=(i%keyEvery==0)?VPX_EFLAG_FORCE_KF:0;
    if(vpx_codec_encode(&c,in,(vpx_codec_pts_t)i,1,fl,VPX_DL_GOOD_QUALITY)){ ok=false; break; }
    const vpx_codec_cx_pkt_t* pkt; vpx_codec_iter_t it=nullptr;
    while((pkt=vpx_codec_get_cx_data(&c,&it))) if(pkt->kind==VPX_CODEC_CX_FRAME_PKT){
      outFrames.emplace_back((uint8_t*)pkt->data.frame.buf,(uint8_t*)pkt->data.frame.buf+pkt->data.frame.sz);
      outKey.push_back((pkt->data.frame.flags & VPX_FRAME_IS_KEY)!=0); } }
  vpx_img_free(&img); vpx_codec_destroy(&c); return ok;
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

// Build a full file from optional RGB and lossless signals.
int buildFileMulti(const uint8_t* rgba, int kbps,
                   const std::vector<SignalEncodeSpec>& specs,
                   int W, int H, int N, int fps, Bytes& file){
  if(specs.empty() && !rgba) return 1;
  if(!dimsUsable(W,H) || N<=0 || fps<=0) return 1;
  // Guard the per-frame strides used below ((size_t)i*W*H*4) against wrapping.
  if((size_t)N > SIZE_MAX/((size_t)W*(size_t)H*4)) return 1;
  std::vector<Track> tracks; std::vector<Frame> frames;
  bool hasRgb=rgba!=nullptr;
  auto sigMeta=planSignalTracks(specs, hasRgb);
  std::vector<Bytes> rgbF; std::vector<bool> rgbK;
  if(rgba){
    std::vector<const uint8_t*> p(N); for(int i=0;i<N;i++) p[i]=rgba+(size_t)i*W*H*4;
    if(!encodeRGBSeq(p,W,H,fps,kbps?kbps:2000,rgbF,rgbK)) return 2;
    if((int)rgbF.size()!=N) return 6;
    tracks.push_back({1,"V_VP9","rgb",W,H});
  }
  size_t px=(size_t)W*(size_t)H;
  struct SigEnc { std::vector<Bytes> hiF, loF, hiP, loP; std::vector<bool> hiK, loK; };
  std::vector<SigEnc> enc(specs.size());
  for(size_t si=0; si<specs.size(); si++){
    auto& sp=specs[si]; auto& se=enc[si]; auto& sm=sigMeta[si];
    if(!sp.data) return 1;
    se.hiP.resize(N); se.loP.resize(N);
    std::vector<const uint8_t*> hp(N), lp(N);
    for(int i=0;i<N;i++){
      se.hiP[i].resize(px); se.loP[i].resize(px);
      pack(sp.data+(size_t)i*px, px, se.hiP[i].data(), se.loP[i].data());
      hp[i]=se.hiP[i].data(); lp[i]=se.loP[i].data();
    }
    if(EncStatus st=encodePlaneSeq(hp,W,H,fps,se.hiF,se.hiK)) return st==ENC_NO_LOSSLESS?DC_ERR_CODEC:3;
    if(EncStatus st=encodePlaneSeq(lp,W,H,fps,se.loF,se.loK)) return st==ENC_NO_LOSSLESS?DC_ERR_CODEC:4;
    if((int)se.hiF.size()!=N || (int)se.loF.size()!=N) return 7;
    char hiName[128], loName[128];
    snprintf(hiName,sizeof hiName,"signal-%s-hi", sm.id.c_str());
    snprintf(loName,sizeof loName,"signal-%s-lo", sm.id.c_str());
    tracks.push_back({sm.track_hi,"V_VP9",hiName,W,H});
    tracks.push_back({sm.track_lo,"V_VP9",loName,W,H});
  }
  for(int i=0;i<N;i++){ int t=(int)(1000.0*i/fps);
    if(rgba) frames.push_back({1,(bool)rgbK[i],t,rgbF[i].data(),rgbF[i].size()});
    for(size_t si=0; si<specs.size(); si++){
      auto& se=enc[si]; auto& sm=sigMeta[si];
      frames.push_back({sm.track_hi,(bool)se.hiK[i],t,se.hiF[i].data(),se.hiF[i].size()});
      frames.push_back({sm.track_lo,(bool)se.loK[i],t,se.loF[i].data(),se.loF[i].size()});
    }
  }
  int durationMs = (int)llround(N * 1000.0 / (fps>0?fps:30));
  file = mux(tracks, frames, buildMetadataJson(W,H,N,fps,hasRgb,sigMeta), durationMs);
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

// ── C ABI ──
extern "C" {

static int finish(Bytes& file, uint8_t** out, size_t* out_len){
  *out=(uint8_t*)malloc(file.size()); if(!*out) return 5;
  memcpy(*out, file.data(), file.size()); *out_len=file.size(); return 0;
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

int dc_decode_rgb(const uint8_t* webm, size_t len, uint8_t* rgba_out, size_t rgba_cap){
  if(!webm || !len || !rgba_out) return 1;
  return guard([&]{
  Demuxed d=demux(webm,len); if(d.metadata.empty()) return 1;
  if(d.metadata.find("\"rgb\":null")!=std::string::npos) return 6;
  FileMeta meta=parseMetadata(d.metadata);   // reads the keys once, with defaults when absent
  int W=meta.width, H=meta.height;
  if(!dimsUsable(W,H)) return 2;
  size_t frameBytes=(size_t)W*H*4;
  int rgbTrack=1; for(auto& t:d.tracks) if(t.name=="rgb") rgbTrack=t.number;
  std::vector<Frame> frs; for(auto& f:d.frames) if(f.track==rgbTrack) frs.push_back(f);
  std::vector<Bytes> planes;
  int st=decodeRGBTrack(frs,W,H,rgba_cap/frameBytes,planes);
  if(st) return decStatusToRc(st,3);
  for(size_t i=0;i<planes.size();i++) memcpy(rgba_out+i*frameBytes, planes[i].data(), frameBytes);
  return 0;
  });
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
  if(has_rgb) *has_rgb = meta.has_rgb ? 1 : 0;
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

int dc_encode_multi(const uint8_t* rgba, int rgb_kbps,
                    const dc_signal_spec_t* signals, int num_signals,
                    int W, int H, int N, int fps,
                    uint8_t** out, size_t* out_len){
  // fps reaches the encoder timebase (g_timebase.den) and the block timestamps (1000*i/fps);
  // at 0 the first divides by zero and the second yields inf, which is UB when cast to int.
  // dimsUsable is the same bound the decoders enforce — here it also keeps the encoder's int
  // plane arithmetic from wrapping (W=H=65536 wraps W*H to 0, so the encoder would read rows
  // out of a zero-length plane).
  if(!out || !out_len || N<=0 || fps<=0 || !dimsUsable(W,H)) return 1;
  if(num_signals<=0 && !rgba) return 1;
  if(num_signals>0 && !signals) return 1;
  return guard([&]{
  std::vector<SignalEncodeSpec> specs;
  for(int i=0;i<num_signals;i++){
    const dc_signal_spec_t& in=signals[i];
    if(!in.id || !in.data) return 1;
    SignalEncodeSpec s; s.id=in.id; s.data=in.data;
    if(in.inverse_depth){
      s.quant.inverse_depth=true;
      s.quant.near_=in.near_; s.quant.far_=in.far_;
      s.quant.levels = in.levels<=0 ? 65536 : in.levels;
    }
    specs.push_back(s);
  }
  Bytes file; int rc=buildFileMulti(rgba, rgb_kbps, specs, W, H, N, fps, file);
  if(rc) return rc;
  return finish(file, out, out_len);
  });
}

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
