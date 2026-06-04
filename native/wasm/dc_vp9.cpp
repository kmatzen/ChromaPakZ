// dc_vp9: per-frame streaming VP9 over libvpx (see dc_vp9.h). The codec configuration and
// the BT.709 full-range RGBA<->I420 math are kept byte-identical to native/chromapakz.cpp so
// the WASM fallback interoperates with the native and WebCodecs paths: lossless (QP=0) tracks
// round-trip bit-exact regardless of which encoder produced the bitstream.
#include "dc_vp9.h"
#include <vector>
#include <deque>
#include <cstring>

#include <vpx/vpx_encoder.h>
#include <vpx/vpx_decoder.h>
#include <vpx/vp8cx.h>
#include <vpx/vp8dx.h>

namespace {
using Bytes = std::vector<uint8_t>;

inline uint8_t clamp8(double v){ return (uint8_t)(v<0?0:(v>255?255:v+0.5)); }

// BT.709 full-range, identical to native/chromapakz.cpp.
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

struct Packet { Bytes data; int key; int time_ms; };
} // namespace

// ── Encoder ──
struct dcvp9_enc {
  int W, H, fps, kind, key_every;
  long idx=0;                 // frame counter → pts + time_ms
  bool ok=true;
  vpx_codec_ctx_t ctx{};
  vpx_image_t img{};
  std::deque<Packet> out;
  Bytes last;                 // backing store for the most recently popped packet
};

extern "C" {

dcvp9_enc* dcvp9_enc_new(int W, int H, int fps, int kind, int bitrate_kbps, int key_every){
  if(W<=0||H<=0) return nullptr;
  if(fps<=0) fps=30;
  auto* e=new dcvp9_enc();
  e->W=W; e->H=H; e->fps=fps; e->kind=kind;
  e->key_every = (kind==1) ? (key_every>0?key_every:fps) : 0;  // luma: keyframe only on frame 0

  vpx_codec_iface_t* iface=vpx_codec_vp9_cx();
  vpx_codec_enc_cfg_t cfg{};
  if(vpx_codec_enc_config_default(iface,&cfg,0)){ e->ok=false; return e; }
  cfg.g_w=W; cfg.g_h=H; cfg.g_timebase.num=1; cfg.g_timebase.den=fps;
  cfg.g_profile=0; cfg.g_lag_in_frames=0; cfg.kf_mode=VPX_KF_DISABLED;
  if(kind==0){ // luma lossless
    cfg.rc_min_quantizer=0; cfg.rc_max_quantizer=0; cfg.g_pass=VPX_RC_ONE_PASS; cfg.g_error_resilient=0;
  }else{       // rgba lossy
    cfg.rc_end_usage=VPX_VBR; cfg.rc_target_bitrate = bitrate_kbps>0?bitrate_kbps:2000;
  }
  if(vpx_codec_enc_init(&e->ctx,iface,&cfg,0)){ e->ok=false; return e; }
  if(kind==0){
    vpx_codec_control(&e->ctx, VP9E_SET_LOSSLESS, 1);
    vpx_codec_control(&e->ctx, VP8E_SET_CPUUSED, 1);
  }else{
    vpx_codec_control(&e->ctx, VP8E_SET_CPUUSED, 2);
    vpx_codec_control(&e->ctx, VP9E_SET_COLOR_SPACE, VPX_CS_BT_709);
  }
  vpx_codec_control(&e->ctx, VP9E_SET_COLOR_RANGE, VPX_CR_FULL_RANGE);
  vpx_img_alloc(&e->img, VPX_IMG_FMT_I420, W, H, 1);
  e->img.cs=VPX_CS_BT_709; e->img.range=VPX_CR_FULL_RANGE;
  return e;
}

static void enc_drain(dcvp9_enc* e){
  const vpx_codec_cx_pkt_t* pkt; vpx_codec_iter_t it=nullptr;
  while((pkt=vpx_codec_get_cx_data(&e->ctx,&it))) if(pkt->kind==VPX_CODEC_CX_FRAME_PKT){
    Packet p;
    p.data.assign((uint8_t*)pkt->data.frame.buf, (uint8_t*)pkt->data.frame.buf + pkt->data.frame.sz);
    p.key = (pkt->data.frame.flags & VPX_FRAME_IS_KEY)!=0;
    p.time_ms = (int)(1000.0*(double)pkt->data.frame.pts/e->fps + 0.5);   // timebase is 1/fps
    e->out.push_back(std::move(p));
  }
}

int dcvp9_enc_encode(dcvp9_enc* e, const uint8_t* plane, int force_key){
  if(!e||!e->ok) return 1;
  int W=e->W, H=e->H;
  if(e->kind==0){ // luma: copy Y, fill chroma 128
    for(int r=0;r<H;r++) memcpy(e->img.planes[0]+r*e->img.stride[0], plane+(size_t)r*W, W);
    for(int p=1;p<3;p++) for(int r=0;r<(H+1)/2;r++) memset(e->img.planes[p]+r*e->img.stride[p],128,(W+1)/2);
  }else{
    rgbaToI420(plane, W, H, &e->img);
  }
  bool key = force_key || e->idx==0 || (e->key_every>0 && (e->idx % e->key_every)==0);
  vpx_enc_frame_flags_t fl = key ? VPX_EFLAG_FORCE_KF : 0;
  if(vpx_codec_encode(&e->ctx, &e->img, (vpx_codec_pts_t)e->idx, 1, fl, VPX_DL_GOOD_QUALITY)){ e->ok=false; return 2; }
  e->idx++;
  enc_drain(e);
  return 0;
}

int dcvp9_enc_flush(dcvp9_enc* e){
  if(!e||!e->ok) return 1;
  if(vpx_codec_encode(&e->ctx, nullptr, (vpx_codec_pts_t)e->idx, 1, 0, VPX_DL_GOOD_QUALITY)) return 2;
  enc_drain(e);
  return 0;
}

const uint8_t* dcvp9_enc_next(dcvp9_enc* e, int* len, int* key, int* time_ms){
  if(!e || e->out.empty()) return nullptr;
  e->last = std::move(e->out.front().data);
  if(key) *key = e->out.front().key;
  if(time_ms) *time_ms = e->out.front().time_ms;
  e->out.pop_front();
  if(len) *len = (int)e->last.size();
  return e->last.data();
}

void dcvp9_enc_free(dcvp9_enc* e){ if(!e) return; vpx_img_free(&e->img); vpx_codec_destroy(&e->ctx); delete e; }

} // extern "C"

// ── Decoder ──
struct dcvp9_dec {
  int W, H, kind;
  bool ok=true;
  vpx_codec_ctx_t ctx{};
  std::deque<Bytes> out;
  Bytes last;
};

extern "C" {

dcvp9_dec* dcvp9_dec_new(int W, int H, int kind){
  if(W<=0||H<=0) return nullptr;
  auto* d=new dcvp9_dec();
  d->W=W; d->H=H; d->kind=kind;
  if(vpx_codec_dec_init(&d->ctx, vpx_codec_vp9_dx(), nullptr, 0)) d->ok=false;
  return d;
}

static void dec_drain(dcvp9_dec* d){
  vpx_image_t* img; vpx_codec_iter_t it=nullptr;
  while((img=vpx_codec_get_frame(&d->ctx,&it))){
    if(d->kind==0){
      Bytes plane((size_t)d->W*d->H);
      for(int r=0;r<d->H;r++) memcpy(plane.data()+(size_t)r*d->W, img->planes[0]+r*img->stride[0], d->W);
      d->out.push_back(std::move(plane));
    }else{
      Bytes rgba((size_t)d->W*d->H*4);
      i420ToRGBA(img, d->W, d->H, rgba.data());
      d->out.push_back(std::move(rgba));
    }
  }
}

int dcvp9_dec_decode(dcvp9_dec* d, const uint8_t* chunk, size_t len){
  if(!d||!d->ok) return 1;
  if(vpx_codec_decode(&d->ctx, chunk, (unsigned)len, nullptr, 0)){ d->ok=false; return 2; }
  dec_drain(d);
  return 0;
}

int dcvp9_dec_flush(dcvp9_dec* d){
  if(!d||!d->ok) return 1;
  vpx_codec_decode(&d->ctx, nullptr, 0, nullptr, 0);
  dec_drain(d);
  return 0;
}

const uint8_t* dcvp9_dec_next(dcvp9_dec* d, int* len){
  if(!d || d->out.empty()) return nullptr;
  d->last = std::move(d->out.front());
  d->out.pop_front();
  if(len) *len = (int)d->last.size();
  return d->last.data();
}

void dcvp9_dec_free(dcvp9_dec* d){ if(!d) return; vpx_codec_destroy(&d->ctx); delete d; }

} // extern "C"
