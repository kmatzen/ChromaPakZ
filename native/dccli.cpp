// chromapakz CLI / test driver. Commands:
//   selftest                                  encode→decode synthetic depth, assert bit-exact
//   goldencheck <quant_golden.csv>            replay the cross-language quantizer golden vectors
//   decode  <in.webm> <out.u16>               decode depth track to raw uint16-LE
//   encode  <in.u16> W H N fps near far <out.webm>
//   info    <in.webm>                         print header
#include "chromapakz.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <climits>
#include <vector>
#include <string>
#include <sys/stat.h>   // fstat/S_ISREG — POSIX; dccli is a dev tool built only on Linux/macOS
#include <unistd.h>

static std::vector<uint8_t> readFile(const char* p){
  FILE* f=fopen(p,"rb"); if(!f){ perror(p); exit(1); }
  // Only a regular file can be sized with ftell, and the failure modes differ by platform:
  // ftell returns -1 for a pipe, but a directory *opens* on Linux and its SEEK_END offset is a
  // directory-hash cookie (astronomically large on ext4), not a byte count. Sizing a vector from
  // either would attempt an absurd allocation — the negative case sign-extends to ~2^64, the
  // Linux directory case is simply enormous — so check the file type up front instead of trying
  // to sanity-check the number afterwards.
  struct stat st;
  if(fstat(fileno(f),&st)!=0){ perror(p); fclose(f); exit(1); }
  if(!S_ISREG(st.st_mode)){ fprintf(stderr,"%s: not a regular file\n",p); fclose(f); exit(1); }
  if(fseek(f,0,SEEK_END)!=0){ perror(p); fclose(f); exit(1); }
  long n=ftell(f);
  if(n<0){ perror(p); fclose(f); exit(1); }
  if(fseek(f,0,SEEK_SET)!=0){ perror(p); fclose(f); exit(1); }
  std::vector<uint8_t> b((size_t)n);
  if(n && fread(b.data(),1,(size_t)n,f)!=(size_t)n){ perror("read"); fclose(f); exit(1); }
  fclose(f); return b;
}
static void writeFile(const char* p, const uint8_t* d, size_t n){
  FILE* f=fopen(p,"wb"); if(!f){ perror(p); exit(1); }
  // A short fwrite or a failing fclose (full disk, quota, I/O error) would otherwise leave a
  // silently truncated file behind while the command still reports success.
  if(n && fwrite(d,1,n,f)!=n){ perror(p); fclose(f); exit(1); }
  if(fclose(f)!=0){ perror(p); exit(1); }
}

// atoi has no way to report garbage or overflow; every dimension here must be a positive count.
static int posInt(const char* s, const char* what){
  char* end=nullptr; long v=strtol(s,&end,10);
  if(end==s || *end || v<=0 || v>INT_MAX){ fprintf(stderr,"%s must be a positive integer (got \"%s\")\n",what,s); exit(2); }
  return (int)v;
}

static int encodeDepthOnly(const uint16_t* depth, int W, int H, int N, int fps,
                           double near_, double far_, int levels, uint8_t** out, size_t* out_len){
  dc_signal_spec_t spec{"depth", depth, 1, near_, far_, levels>0?levels:65536};
  return dc_encode_multi(nullptr, 0, &spec, 1, W, H, N, fps, out, out_len);
}

// ── cross-language quantizer golden vectors ─────────────────────────────────────────────────
// tests/fixtures/quant_golden.csv is generated from the JS quantizer and replayed here and in
// Python, so all three implementations are pinned to the same codes. The format is deliberately
// CSV rather than JSON so this side needs no parser: near,far,levels,z,code,back — where z and
// back are the token nan/inf/-inf or 0x + the float32 bit pattern, which crosses the language
// boundary without decimal rounding.
static float decodeFloatToken(const char* tok){
  if(!strcmp(tok,"nan")) return NAN;
  if(!strcmp(tok,"inf")) return INFINITY;
  if(!strcmp(tok,"-inf")) return -INFINITY;
  uint32_t bits=(uint32_t)strtoul(tok, nullptr, 16);
  float f; memcpy(&f, &bits, sizeof f); return f;
}

static int goldenCheck(const char* path){
  FILE* f=fopen(path,"r");
  if(!f){ perror(path); return 1; }
  char line[512];
  long checked=0, failed=0;
  while(fgets(line, sizeof line, f)){
    if(line[0]=='#' || line[0]=='\n' || !strncmp(line,"near,",5)) continue;
    char zt[64], bt[64]; double near_, far_; int levels; unsigned code;
    if(sscanf(line, "%lf,%lf,%d,%63[^,],%u,%63[^,\n]", &near_, &far_, &levels, zt, &code, bt)!=6){
      fprintf(stderr,"malformed golden line: %s", line); fclose(f); return 1; }

    float z=decodeFloatToken(zt), want_back=decodeFloatToken(bt);
    uint16_t got_code=0;
    dc_quantize_inverse(&z, 1, near_, far_, levels, &got_code);
    if(got_code!=code){
      fprintf(stderr,"MISMATCH code near=%g far=%g levels=%d z=%g: got %u want %u\n",
              near_, far_, levels, (double)z, got_code, code);
      failed++;
    }
    uint16_t in_code=(uint16_t)code; float got_back=0;
    dc_dequantize_inverse(&in_code, 1, near_, far_, levels, &got_back);
    bool back_ok = std::isnan(want_back) ? std::isnan(got_back)
                                         : (memcmp(&got_back, &want_back, sizeof(float))==0);
    if(!back_ok){
      fprintf(stderr,"MISMATCH depth near=%g far=%g levels=%d code=%u: got %g want %g\n",
              near_, far_, levels, code, (double)got_back, (double)want_back);
      failed++;
    }
    checked++;
  }
  fclose(f);
  if(checked<100){ fprintf(stderr,"golden file looks truncated: only %ld cases\n", checked); return 1; }
  printf("goldencheck: %ld cases, %ld mismatches — %s\n", checked, failed, failed?"FAIL":"bit-exact with JS/Python");
  return failed?1:0;
}

int main(int argc, char** argv){
  if(argc<2){ fprintf(stderr,"usage: dccli <selftest|decode|decodesignal|encode|info|...> ...\n"); return 2; }
  std::string cmd=argv[1];

  if(cmd=="selftest"){
    int W=256,H=256,N=30,fps=30; double near_=0.2,far_=10; int px=W*H;
    std::vector<uint16_t> depth((size_t)px*N);
    for(int f=0;f<N;f++){ uint32_t s=0x9e3779b9u ^ (uint32_t)(f*2654435761u);
      auto noise=[&](){ s^=s<<13; s^=s>>17; s^=s<<5; return (int)(s&7)-3; };
      double cx=W*(0.25+0.5*f/(double)(N-1)), cy=H*0.45, R=(W<H?W:H)*0.22;
      for(int r=0;r<H;r++) for(int c=0;c<W;c++){ double z=9000+c*70+r*45;
        if((c-cx)*(c-cx)+(r-cy)*(r-cy)<R*R) z-=6000; if(r>H*0.85) z=60000; z+=noise();
        long zi=(long)(z<0?0:(z>65535?65535:z)); depth[(size_t)f*px+r*W+c]=(uint16_t)zi; } }

    uint8_t* buf; size_t len;
    if(int rc=encodeDepthOnly(depth.data(),W,H,N,fps,near_,far_,65536,&buf,&len)){ fprintf(stderr,"encode failed (%d)\n",rc); return 1; }
    std::vector<uint16_t> back((size_t)px*N);
    if(int rc=dc_decode_signal(buf,len,"depth",back.data(),back.size())){ fprintf(stderr,"decode failed (%d)\n",rc); return 1; }
    int dMax=0; for(size_t i=0;i<back.size();i++){ int dd=abs((int)depth[i]-(int)back[i]); if(dd>dMax) dMax=dd; }
    printf("selftest: %dx%d x%d  file=%.1f KiB  bit-exact=%s (maxΔ=%d)\n",
           W,H,N,len/1024.0, dMax==0?"YES":"NO", dMax);
    dc_free(buf); return dMax==0?0:1;
  }

  if(cmd=="goldencheck"){
    if(argc<3){ fprintf(stderr,"goldencheck <quant_golden.csv>\n"); return 2; }
    return goldenCheck(argv[2]);
  }

  if(cmd=="decodesignal"){
    if(argc<5){ fprintf(stderr,"decodesignal <in.webm> <signal-id> <out.u16>\n"); return 2; }
    auto webm=readFile(argv[2]); int W=0,H=0,N=0,fps=0,rgb=0,levels=0; double near_=0,far_=0;
    if(dc_probe(webm.data(),webm.size(),&W,&H,&N,&fps,&near_,&far_,&levels,&rgb)){ fprintf(stderr,"not a chromapakz file\n"); return 1; }
    // Every decode below sizes its output buffer from these; a file reporting 0 would leave the
    // buffer empty while the decoder still has frames to write.
    if(W<=0||H<=0||N<=0){ fprintf(stderr,"file reports empty dimensions (%dx%d x%d)\n",W,H,N); return 1; }
    std::vector<uint16_t> out((size_t)W*H*N);
    if(int rc=dc_decode_signal(webm.data(),webm.size(),argv[3],out.data(),out.size())){ fprintf(stderr,"decode signal failed (%d)\n",rc); return 1; }
    writeFile(argv[4],(uint8_t*)out.data(),out.size()*2);
    printf("decoded signal %s %dx%d x%d → %s\n",argv[3],W,H,N,argv[4]); return 0;
  }

  if(cmd=="decode"){
    if(argc<4){ fprintf(stderr,"decode <in.webm> <out.u16>\n"); return 2; }
    auto webm=readFile(argv[2]); int W=0,H=0,N=0,fps=0,rgb=0,levels=0; double near_=0,far_=0;
    if(dc_probe(webm.data(),webm.size(),&W,&H,&N,&fps,&near_,&far_,&levels,&rgb)){ fprintf(stderr,"not a chromapakz file\n"); return 1; }
    // Every decode below sizes its output buffer from these; a file reporting 0 would leave the
    // buffer empty while the decoder still has frames to write.
    if(W<=0||H<=0||N<=0){ fprintf(stderr,"file reports empty dimensions (%dx%d x%d)\n",W,H,N); return 1; }
    std::vector<uint16_t> depth((size_t)W*H*N);
    if(int rc=dc_decode_signal(webm.data(),webm.size(),"depth",depth.data(),depth.size())){ fprintf(stderr,"decode failed (%d)\n",rc); return 1; }
    writeFile(argv[3],(uint8_t*)depth.data(),depth.size()*2);
    printf("decoded %dx%d x%d → %s\n",W,H,N,argv[3]); return 0;
  }

  if(cmd=="encode"){
    if(argc<10){ fprintf(stderr,"encode <in.u16> W H N fps near far <out.webm>\n"); return 2; }
    auto raw=readFile(argv[2]);
    int W=posInt(argv[3],"W"),H=posInt(argv[4],"H"),N=posInt(argv[5],"N"),fps=posInt(argv[6],"fps");
    double near_=atof(argv[7]),far_=atof(argv[8]);
    size_t want=(size_t)W*H*N*2;
    if(raw.size()!=want){ fprintf(stderr,"size mismatch: %zu vs %zu\n",raw.size(),want); return 1; }
    uint8_t* buf; size_t len;
    if(int rc=encodeDepthOnly((const uint16_t*)raw.data(),W,H,N,fps,near_,far_,65536,&buf,&len)){ fprintf(stderr,"encode failed (%d)\n",rc); return 1; }
    writeFile(argv[9],buf,len); printf("encoded → %s (%.1f KiB)\n",argv[9],len/1024.0); dc_free(buf); return 0;
  }

  if(cmd=="encodergbd"){
    // The command reads through argv[11] (out.webm), so it needs 12 argv entries — guarding on 11
    // let `argc==11` through and passed the terminating NULL to writeFile → fopen(NULL) segfault,
    // after the whole encode had already run.
    if(argc<12){ fprintf(stderr,"encodergbd <rgba.bin> <depth.u16> W H N fps near far kbps <out.webm>\n"); return 2; }
    auto rgb=readFile(argv[2]); auto dep=readFile(argv[3]);
    int W=posInt(argv[4],"W"),H=posInt(argv[5],"H"),N=posInt(argv[6],"N"),fps=posInt(argv[7],"fps");
    double near_=atof(argv[8]),far_=atof(argv[9]); int kbps=atoi(argv[10]);
    if(rgb.size()!=(size_t)W*H*N*4){ fprintf(stderr,"rgba size mismatch\n"); return 1; }
    if(dep.size()!=(size_t)W*H*N*2){ fprintf(stderr,"depth size mismatch\n"); return 1; }
    uint8_t* buf; size_t len;
    dc_signal_spec_t spec{"depth", (const uint16_t*)dep.data(), 1, near_, far_, 65536};
    if(int rc=dc_encode_multi(rgb.data(), kbps, &spec, 1, W, H, N, fps, &buf, &len)){ fprintf(stderr,"encode failed (%d)\n",rc); return 1; }
    writeFile(argv[11],buf,len); printf("encoded RGBD → %s (%.1f KiB)\n",argv[11],len/1024.0); dc_free(buf); return 0;
  }

  if(cmd=="decodergb"){
    if(argc<4){ fprintf(stderr,"decodergb <in.webm> <out.rgba>\n"); return 2; }
    auto webm=readFile(argv[2]); int W=0,H=0,N=0,fps=0,rgb=0,levels=0; double near_=0,far_=0;
    if(dc_probe(webm.data(),webm.size(),&W,&H,&N,&fps,&near_,&far_,&levels,&rgb)){ fprintf(stderr,"not a chromapakz file\n"); return 1; }
    // Every decode below sizes its output buffer from these; a file reporting 0 would leave the
    // buffer empty while the decoder still has frames to write.
    if(W<=0||H<=0||N<=0){ fprintf(stderr,"file reports empty dimensions (%dx%d x%d)\n",W,H,N); return 1; }
    if(!rgb){ fprintf(stderr,"file has no RGB track\n"); return 1; }
    std::vector<uint8_t> out((size_t)W*H*N*4);
    if(int rc=dc_decode_rgb(webm.data(),webm.size(),out.data(),out.size())){ fprintf(stderr,"rgb decode failed (%d)\n",rc); return 1; }
    writeFile(argv[3],out.data(),out.size()); printf("decoded RGB %dx%d x%d → %s\n",W,H,N,argv[3]); return 0;
  }

  if(cmd=="info"){
    if(argc<3){ fprintf(stderr,"info <in.webm>\n"); return 2; }
    auto webm=readFile(argv[2]); int W=0,H=0,N=0,fps=0,rgb=0,levels=0; double near_=0,far_=0;
    if(dc_probe(webm.data(),webm.size(),&W,&H,&N,&fps,&near_,&far_,&levels,&rgb)){ fprintf(stderr,"not a chromapakz file\n"); return 1; }
    char* meta=0; size_t mlen=0;
    if(!dc_get_metadata(webm.data(),webm.size(),&meta,&mlen))
      printf("metadata: %.*s\n",(int)mlen,meta);
    printf("chromapakz: %dx%d, %d frames @ %dfps, near=%g far=%g, levels=%d, rgb=%s\n",W,H,N,fps,near_,far_,levels,rgb?"yes":"no");
    if(meta) dc_free((uint8_t*)meta);
    return 0;
  }
  fprintf(stderr,"unknown command: %s\n",cmd.c_str()); return 2;
}
