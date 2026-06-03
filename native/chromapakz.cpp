// chromapakz native core: triangle-fold packing + libvpx VP9 lossless + a minimal
// Matroska/WebM mux/demux that is byte-compatible with src/webm.js.
#include "chromapakz.h"
#include <vector>
#include <string>
#include <cstring>
#include <cmath>
#include <cstdlib>
#include <algorithm>

#include <vpx/vpx_encoder.h>
#include <vpx/vpx_decoder.h>
#include <vpx/vp8cx.h>
#include <vpx/vp8dx.h>

namespace {
using Bytes = std::vector<uint8_t>;

// ── EBML element IDs (same set as src/webm.js) ──
enum : uint32_t {
  ID_EBML=0x1A45DFA3, ID_EBMLVersion=0x4286, ID_EBMLReadVersion=0x42F7, ID_EBMLMaxIDLength=0x42F2,
  ID_EBMLMaxSizeLength=0x42F3, ID_DocType=0x4282, ID_DocTypeVersion=0x4287, ID_DocTypeReadVersion=0x4285,
  ID_Segment=0x18538067, ID_Info=0x1549A966, ID_TimestampScale=0x2AD7B1, ID_MuxingApp=0x4D80, ID_WritingApp=0x5741,
  ID_Tracks=0x1654AE6B, ID_TrackEntry=0xAE, ID_TrackNumber=0xD7, ID_TrackUID=0x73C5, ID_TrackType=0x83,
  ID_FlagLacing=0x9C, ID_CodecID=0x86, ID_Name=0x536E, ID_Video=0xE0, ID_PixelWidth=0xB0, ID_PixelHeight=0xBA,
  ID_Tags=0x1254C367, ID_Tag=0x7373, ID_Targets=0x63C0, ID_SimpleTag=0x67C8, ID_TagName=0x45A3, ID_TagString=0x4487,
  ID_Cluster=0x1F43B675, ID_Timestamp=0xE7, ID_SimpleBlock=0xA3,
};

void append(Bytes& a, const Bytes& b){ a.insert(a.end(), b.begin(), b.end()); }

Bytes vint(uint64_t n){
  int L=1; while(n >= ((1ULL<<(7*L))-1)) L++;
  uint64_t v = n + (1ULL<<(7*L)); Bytes out(L);
  for(int i=L-1;i>=0;i--){ out[i]=v&0xff; v>>=8; } return out;
}
Bytes idBytes(uint32_t id){ Bytes b; while(id){ b.insert(b.begin(), id&0xff); id>>=8; } return b; }
Bytes uintBytes(uint64_t n){ if(n==0) return Bytes{0}; Bytes b; while(n){ b.insert(b.begin(), n&0xff); n>>=8; } return b; }
Bytes strBytes(const std::string& s){ return Bytes(s.begin(), s.end()); }

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
          const std::string& metadata, int clusterSpanMs=30000){
  Bytes hdr;
  append(hdr, elU(ID_EBMLVersion,1)); append(hdr, elU(ID_EBMLReadVersion,1));
  append(hdr, elU(ID_EBMLMaxIDLength,4)); append(hdr, elU(ID_EBMLMaxSizeLength,8));
  append(hdr, elS(ID_DocType,"webm")); append(hdr, elU(ID_DocTypeVersion,2)); append(hdr, elU(ID_DocTypeReadVersion,2));
  Bytes header = el(ID_EBML, hdr);

  Bytes info; append(info, elU(ID_TimestampScale,1000000));
  append(info, elS(ID_MuxingApp,"chromapakz")); append(info, elS(ID_WritingApp,"chromapakz"));
  Bytes seg; append(seg, el(ID_Info, info));

  Bytes te; for(auto& t : tracks) append(te, trackEntry(t)); append(seg, el(ID_Tracks, te));

  if(!metadata.empty()){
    Bytes st; append(st, elS(ID_TagName,"CHROMAPAKZ")); append(st, elS(ID_TagString, metadata));
    Bytes tag; append(tag, el(ID_Targets, Bytes{})); append(tag, el(ID_SimpleTag, st));
    append(seg, el(ID_Tags, el(ID_Tag, tag)));
  }

  std::stable_sort(frames.begin(), frames.end(), [](const Frame&a, const Frame&b){ return a.timeMs<b.timeMs; });
  size_t i=0;
  while(i<frames.size()){
    int base = frames[i].timeMs; Bytes cl; append(cl, elU(ID_Timestamp, base));
    while(i<frames.size() && frames[i].timeMs-base < clusterSpanMs){
      auto& f=frames[i++]; append(cl, simpleBlock(f.track, f.timeMs-base, f.key, f.data, f.len));
    }
    append(seg, el(ID_Cluster, cl));
  }
  Bytes out = header; append(out, el(ID_Segment, seg));
  return out;
}

// ── demux ──
struct Child { uint32_t id; size_t dStart, dEnd; };
int readId(const uint8_t* b, size_t p, uint32_t& id){
  uint8_t first=b[p]; int L=1, m=0x80; while(L<=4 && !(first&m)){ m>>=1; L++; }
  id=0; for(int k=0;k<L;k++) id=(id<<8)|b[p+k]; return L;
}
int readSize(const uint8_t* b, size_t p, uint64_t& size){
  uint8_t first=b[p]; int L=1, m=0x80; while(L<=8 && !(first&m)){ m>>=1; L++; }
  size = first & (m-1); for(int k=1;k<L;k++) size=(size<<8)|b[p+k]; return L;
}
uint64_t readUint(const uint8_t* b, size_t s, size_t e){ uint64_t v=0; for(size_t k=s;k<e;k++) v=(v<<8)|b[k]; return v; }
std::vector<Child> kids(const uint8_t* b, size_t start, size_t end){
  std::vector<Child> r; size_t p=start;
  while(p<end){ uint32_t id; size_t la=readId(b,p,id); uint64_t sz; size_t lb=readSize(b,p+la,sz);
    size_t ds=p+la+lb; r.push_back({id, ds, ds+sz}); p=ds+sz; }
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
      else if(c.id==ID_SimpleBlock){ size_t p=c.dStart; uint64_t tv; size_t lt=readSize(b,p,tv); p+=lt;
        int rel=(int)(int16_t)((b[p]<<8)|b[p+1]); p+=2; uint8_t flags=b[p]; p+=1;
        d.frames.push_back({(int)tv, (flags&0x80)!=0, (int)(base+rel), b+p, c.dEnd-p}); } } };
  for(auto& top : kids(b,0,len)) if(top.id==ID_Segment)
    for(auto& c : kids(b,top.dStart,top.dEnd)){
      if(c.id==ID_Tracks) walkTracks(c.dStart,c.dEnd);
      else if(c.id==ID_Tags) walkTags(c.dStart,c.dEnd);
      else if(c.id==ID_Cluster) walkCluster(c.dStart,c.dEnd); }
  return d;
}

// ── tiny JSON field extractor for our own deterministic metadata ──
bool jnum(const std::string& j, const char* key, double& out){
  std::string k = std::string("\"")+key+"\":"; auto p=j.find(k); if(p==std::string::npos) return false;
  p+=k.size(); out=strtod(j.c_str()+p, nullptr); return true;
}

// ── triangle-fold 8+8 ──
void pack(const uint16_t* d, int n, uint8_t* hi, uint8_t* lo){
  for(int i=0;i<n;i++){ int h=d[i]>>8, l=d[i]&0xff; hi[i]=h; lo[i]=(h&1)?(255-l):l; }
}
void unpack(const uint8_t* hi, const uint8_t* lo, int n, uint16_t* d){
  for(int i=0;i<n;i++){ int h=hi[i], l=(h&1)?(255-lo[i]):lo[i]; d[i]=(uint16_t)((h<<8)|l); }
}

// ── libvpx VP9 lossless encode of an 8-bit luma-plane sequence (chroma const 128) ──
bool encodePlaneSeq(const std::vector<const uint8_t*>& planes, int W, int H, int fps,
                    std::vector<Bytes>& outFrames, std::vector<bool>& outKey){
  vpx_codec_iface_t* iface = vpx_codec_vp9_cx();
  vpx_codec_enc_cfg_t cfg{}; if(vpx_codec_enc_config_default(iface,&cfg,0)) return false;
  cfg.g_w=W; cfg.g_h=H; cfg.g_timebase.num=1; cfg.g_timebase.den=fps;
  cfg.g_profile=0; cfg.g_lag_in_frames=0; cfg.rc_min_quantizer=0; cfg.rc_max_quantizer=0;
  cfg.kf_mode=VPX_KF_DISABLED; cfg.g_pass=VPX_RC_ONE_PASS; cfg.g_error_resilient=0;
  vpx_codec_ctx_t c{}; if(vpx_codec_enc_init(&c,iface,&cfg,0)) return false;
  vpx_codec_control(&c, VP9E_SET_LOSSLESS, 1);
  vpx_codec_control(&c, VP8E_SET_CPUUSED, 1);
  vpx_codec_control(&c, VP9E_SET_COLOR_RANGE, VPX_CR_FULL_RANGE);   // signal full-range in the bitstream
  vpx_image_t img; vpx_img_alloc(&img, VPX_IMG_FMT_I420, W, H, 1);
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
  return ok;
}

// Decode a VP9 track's packets (in order) → luma planes (W*H each).
bool decodePlaneTrack(std::vector<Frame>& frs, int W, int H, std::vector<Bytes>& outPlanes){
  std::stable_sort(frs.begin(), frs.end(), [](const Frame&a,const Frame&b){ return a.timeMs<b.timeMs; });
  vpx_codec_ctx_t c{}; if(vpx_codec_dec_init(&c, vpx_codec_vp9_dx(), nullptr, 0)) return false;
  bool ok=true;
  for(auto& f : frs){
    if(vpx_codec_decode(&c, f.data, (unsigned)f.len, nullptr, 0)){ ok=false; break; }
    vpx_image_t* img; vpx_codec_iter_t it=nullptr;
    while((img=vpx_codec_get_frame(&c,&it))){
      Bytes plane(W*H); for(int r=0;r<H;r++) memcpy(plane.data()+r*W, img->planes[0]+r*img->stride[0], W);
      outPlanes.push_back(std::move(plane));
    }
  }
  vpx_codec_destroy(&c);
  return ok;
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
  vpx_image_t img; vpx_img_alloc(&img, VPX_IMG_FMT_I420, W, H, 1);
  img.cs=VPX_CS_BT_709; img.range=VPX_CR_FULL_RANGE;
  bool ok=true;
  for(size_t i=0;i<=rgba.size() && ok;i++){ vpx_image_t* in=nullptr;
    if(i<rgba.size()){ rgbaToI420(rgba[i],W,H,&img); in=&img; }
    vpx_enc_frame_flags_t fl=(i==0)?VPX_EFLAG_FORCE_KF:0;
    if(vpx_codec_encode(&c,in,(vpx_codec_pts_t)i,1,fl,VPX_DL_GOOD_QUALITY)){ ok=false; break; }
    const vpx_codec_cx_pkt_t* pkt; vpx_codec_iter_t it=nullptr;
    while((pkt=vpx_codec_get_cx_data(&c,&it))) if(pkt->kind==VPX_CODEC_CX_FRAME_PKT){
      outFrames.emplace_back((uint8_t*)pkt->data.frame.buf,(uint8_t*)pkt->data.frame.buf+pkt->data.frame.sz);
      outKey.push_back((pkt->data.frame.flags & VPX_FRAME_IS_KEY)!=0); } }
  vpx_img_free(&img); vpx_codec_destroy(&c); return ok;
}
bool decodeRGBTrack(std::vector<Frame>& frs, int W, int H, std::vector<Bytes>& out){
  std::stable_sort(frs.begin(),frs.end(),[](const Frame&a,const Frame&b){return a.timeMs<b.timeMs;});
  vpx_codec_ctx_t c{}; if(vpx_codec_dec_init(&c,vpx_codec_vp9_dx(),nullptr,0)) return false;
  bool ok=true;
  for(auto& f : frs){ if(vpx_codec_decode(&c,f.data,(unsigned)f.len,nullptr,0)){ ok=false; break; }
    vpx_image_t* img; vpx_codec_iter_t it=nullptr;
    while((img=vpx_codec_get_frame(&c,&it))){ Bytes rgba((size_t)W*H*4); i420ToRGBA(img,W,H,rgba.data()); out.push_back(std::move(rgba)); } }
  vpx_codec_destroy(&c); return ok;
}

std::string makeMeta(int W,int H,int N,int fps,double near_,double far_,int levels,bool hasRgb,bool hasDepth){
  std::string rgb = hasRgb ? "{\"track\":1,\"codec\":\"vp09.00.10.08\"}" : "null";
  char dep[460];
  if(hasDepth) snprintf(dep,sizeof dep,
    "{\"trackHi\":2,\"trackLo\":3,\"codec\":\"vp09.00.10.08\",\"lossless\":true,\"scheme\":\"tri-fold-8+8\","
    "\"quant\":\"inverse-depth\",\"near\":%g,\"far\":%g,\"levels\":%d,\"invalidCode\":0,\"dtype\":\"uint16\"}",
    near_,far_,levels);
  else snprintf(dep,sizeof dep,"null");
  char buf[760];
  snprintf(buf,sizeof buf,"{\"version\":1,\"width\":%d,\"height\":%d,\"fps\":%d,\"frames\":%d,\"rgb\":%s,\"depth\":%s}",
           W,H,fps,N,rgb.c_str(),dep);
  return buf;
}

// Build a full file from optional RGB and/or depth. Buffers live for the duration of mux().
int buildFile(const uint8_t* rgba, const uint16_t* depth, int W, int H, int N, int fps,
              int kbps, double near_, double far_, int levels, Bytes& file){
  std::vector<Track> tracks; std::vector<Frame> frames;
  std::vector<Bytes> rgbF, hiF, loF, hiP, loP; std::vector<bool> rgbK, hiK, loK;
  if(rgba){
    std::vector<const uint8_t*> p(N); for(int i=0;i<N;i++) p[i]=rgba+(size_t)i*W*H*4;
    if(!encodeRGBSeq(p,W,H,fps,kbps?kbps:2000,rgbF,rgbK)) return 2;
    if((int)rgbF.size()!=N) return 6;
    tracks.push_back({1,"V_VP9","rgb",W,H});
  }
  if(depth){
    int px=W*H; hiP.resize(N); loP.resize(N); std::vector<const uint8_t*> hp(N),lp(N);
    for(int i=0;i<N;i++){ hiP[i].resize(px); loP[i].resize(px);
      pack(depth+(size_t)i*px,px,hiP[i].data(),loP[i].data()); hp[i]=hiP[i].data(); lp[i]=loP[i].data(); }
    if(!encodePlaneSeq(hp,W,H,fps,hiF,hiK)) return 3;
    if(!encodePlaneSeq(lp,W,H,fps,loF,loK)) return 4;
    if((int)hiF.size()!=N || (int)loF.size()!=N) return 7;
    tracks.push_back({2,"V_VP9","depth-hi",W,H}); tracks.push_back({3,"V_VP9","depth-lo",W,H});
  }
  for(int i=0;i<N;i++){ int t=(int)(1000.0*i/fps);
    if(rgba) frames.push_back({1,(bool)rgbK[i],t,rgbF[i].data(),rgbF[i].size()});
    if(depth){ frames.push_back({2,(bool)hiK[i],t,hiF[i].data(),hiF[i].size()});
               frames.push_back({3,(bool)loK[i],t,loF[i].data(),loF[i].size()}); } }
  file = mux(tracks, frames, makeMeta(W,H,N,fps,near_,far_,levels, rgba!=nullptr, depth!=nullptr));
  return 0;
}
} // namespace

// ── C ABI ──
extern "C" {

static int finish(Bytes& file, uint8_t** out, size_t* out_len){
  *out=(uint8_t*)malloc(file.size()); if(!*out) return 5;
  memcpy(*out, file.data(), file.size()); *out_len=file.size(); return 0;
}

int dc_encode_depth(const uint16_t* depth, int W, int H, int N, int fps,
                    double near_, double far_, int levels, uint8_t** out, size_t* out_len){
  if(!depth||!out||!out_len||W<=0||H<=0||N<=0) return 1;
  if(levels<=0) levels=65536;
  Bytes file; int rc=buildFile(nullptr,depth,W,H,N,fps,0,near_,far_,levels,file); if(rc) return rc;
  return finish(file,out,out_len);
}

int dc_encode_rgbd(const uint8_t* rgba, const uint16_t* depth, int W, int H, int N, int fps,
                   int rgb_kbps, double near_, double far_, int levels, uint8_t** out, size_t* out_len){
  if((!rgba&&!depth)||!out||!out_len||W<=0||H<=0||N<=0) return 1;
  if(levels<=0) levels=65536;
  Bytes file; int rc=buildFile(rgba,depth,W,H,N,fps,rgb_kbps,near_,far_,levels,file); if(rc) return rc;
  return finish(file,out,out_len);
}

int dc_decode_rgb(const uint8_t* webm, size_t len, uint8_t* rgba_out){
  Demuxed d=demux(webm,len); if(d.metadata.empty()) return 1;
  if(d.metadata.find("\"rgb\":null")!=std::string::npos) return 6;
  double v; int W=0,H=0; jnum(d.metadata,"width",v); W=(int)v; jnum(d.metadata,"height",v); H=(int)v;
  if(W<=0||H<=0) return 2;
  int rgbTrack=1; for(auto& t:d.tracks) if(t.name=="rgb") rgbTrack=t.number;
  std::vector<Frame> frs; for(auto& f:d.frames) if(f.track==rgbTrack) frs.push_back(f);
  std::vector<Bytes> planes; if(!decodeRGBTrack(frs,W,H,planes)) return 3;
  for(size_t i=0;i<planes.size();i++) memcpy(rgba_out+i*(size_t)W*H*4, planes[i].data(), (size_t)W*H*4);
  return 0;
}

int dc_probe(const uint8_t* webm, size_t len, int* W, int* H, int* N, int* fps,
             double* near_, double* far_, int* levels, int* has_rgb){
  Demuxed d = demux(webm,len); if(d.metadata.empty()) return 1;
  double v;
  if(W && jnum(d.metadata,"width",v)) *W=(int)v;
  if(H && jnum(d.metadata,"height",v)) *H=(int)v;
  if(N && jnum(d.metadata,"frames",v)) *N=(int)v;
  if(fps && jnum(d.metadata,"fps",v)) *fps=(int)v;
  if(near_ && jnum(d.metadata,"near",v)) *near_=v;
  if(far_ && jnum(d.metadata,"far",v)) *far_=v;
  if(levels) *levels = jnum(d.metadata,"levels",v) ? (int)v : 65536;   // default = full 16-bit
  if(has_rgb) *has_rgb = d.metadata.find("\"rgb\":null")==std::string::npos ? 1 : 0;
  return 0;
}

int dc_decode_depth(const uint8_t* webm, size_t len, uint16_t* depth_out){
  Demuxed d = demux(webm,len); if(d.metadata.empty()) return 1;
  double v; int W=0,H=0,thi=2,tlo=3;
  jnum(d.metadata,"width",v); W=(int)v; jnum(d.metadata,"height",v); H=(int)v;
  if(jnum(d.metadata,"trackHi",v)) thi=(int)v; if(jnum(d.metadata,"trackLo",v)) tlo=(int)v;
  if(W<=0||H<=0) return 2;
  std::vector<Frame> hi, lo;
  for(auto& f : d.frames){ if(f.track==thi) hi.push_back(f); else if(f.track==tlo) lo.push_back(f); }
  std::vector<Bytes> hiP, loP;
  if(!decodePlaneTrack(hi,W,H,hiP)) return 3;
  if(!decodePlaneTrack(lo,W,H,loP)) return 4;
  if(hiP.size()!=loP.size()) return 5;
  int px=W*H;
  for(size_t i=0;i<hiP.size();i++) unpack(hiP[i].data(), loP[i].data(), px, depth_out+i*px);
  return 0;
}

void dc_quantize_inverse(const float* z, int n, double near_, double far_, int levels, uint16_t* out){
  if(levels<=0) levels=65536; double M=levels-2, maxc=levels-1;
  double a=1.0/near_, b=1.0/far_, inv=1.0/(a-b);
  for(int i=0;i<n;i++){ double v=z[i];
    if(!(v>0)){ out[i]=0; continue; }
    long q=lround((1.0/v - b)*inv*M)+1; out[i]=(uint16_t)(q<1?1:(q>maxc?(long)maxc:q)); }
}
void dc_dequantize_inverse(const uint16_t* d, int n, double near_, double far_, int levels, float* out){
  if(levels<=0) levels=65536; double M=levels-2;
  double a=1.0/near_, b=1.0/far_;
  for(int i=0;i<n;i++){ unsigned c=d[i];
    out[i]= c==0 ? NAN : (float)(1.0/(((double)(c-1)/M)*(a-b)+b)); }
}

void dc_free(uint8_t* p){ free(p); }

} // extern "C"
