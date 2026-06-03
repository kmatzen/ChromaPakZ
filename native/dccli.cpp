// chromapakz CLI / test driver. Commands:
//   selftest                                  encode→decode synthetic depth, assert bit-exact
//   decode  <in.webm> <out.u16>               decode depth track to raw uint16-LE
//   encode  <in.u16> W H N fps near far <out.webm>
//   info    <in.webm>                         print header
#include "chromapakz.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <string>

static std::vector<uint8_t> readFile(const char* p){
  FILE* f=fopen(p,"rb"); if(!f){ perror(p); exit(1); }
  fseek(f,0,SEEK_END); long n=ftell(f); fseek(f,0,SEEK_SET);
  std::vector<uint8_t> b(n); if(fread(b.data(),1,n,f)!=(size_t)n){ perror("read"); exit(1); } fclose(f); return b;
}
static void writeFile(const char* p, const uint8_t* d, size_t n){
  FILE* f=fopen(p,"wb"); if(!f){ perror(p); exit(1); } fwrite(d,1,n,f); fclose(f);
}

static int encodeDepthOnly(const uint16_t* depth, int W, int H, int N, int fps,
                           double near_, double far_, int levels, uint8_t** out, size_t* out_len){
  dc_signal_spec_t spec{"depth", depth, 1, near_, far_, levels>0?levels:65536};
  return dc_encode_multi(nullptr, 0, &spec, 1, W, H, N, fps, out, out_len);
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
    if(encodeDepthOnly(depth.data(),W,H,N,fps,near_,far_,65536,&buf,&len)){ fprintf(stderr,"encode failed\n"); return 1; }
    std::vector<uint16_t> back((size_t)px*N);
    if(dc_decode_signal(buf,len,"depth",back.data())){ fprintf(stderr,"decode failed\n"); return 1; }
    int dMax=0; for(size_t i=0;i<back.size();i++){ int dd=abs((int)depth[i]-(int)back[i]); if(dd>dMax) dMax=dd; }
    printf("selftest: %dx%d x%d  file=%.1f KiB  bit-exact=%s (maxΔ=%d)\n",
           W,H,N,len/1024.0, dMax==0?"YES":"NO", dMax);
    dc_free(buf); return dMax==0?0:1;
  }

  if(cmd=="decodesignal"){
    if(argc<5){ fprintf(stderr,"decodesignal <in.webm> <signal-id> <out.u16>\n"); return 2; }
    auto webm=readFile(argv[2]); int W=0,H=0,N=0,fps=0,rgb=0,levels=0; double near_=0,far_=0;
    if(dc_probe(webm.data(),webm.size(),&W,&H,&N,&fps,&near_,&far_,&levels,&rgb)){ fprintf(stderr,"not a chromapakz file\n"); return 1; }
    std::vector<uint16_t> out((size_t)W*H*N);
    if(dc_decode_signal(webm.data(),webm.size(),argv[3],out.data())){ fprintf(stderr,"decode signal failed\n"); return 1; }
    writeFile(argv[4],(uint8_t*)out.data(),out.size()*2);
    printf("decoded signal %s %dx%d x%d → %s\n",argv[3],W,H,N,argv[4]); return 0;
  }

  if(cmd=="decode"){
    if(argc<4){ fprintf(stderr,"decode <in.webm> <out.u16>\n"); return 2; }
    auto webm=readFile(argv[2]); int W=0,H=0,N=0,fps=0,rgb=0,levels=0; double near_=0,far_=0;
    if(dc_probe(webm.data(),webm.size(),&W,&H,&N,&fps,&near_,&far_,&levels,&rgb)){ fprintf(stderr,"not a chromapakz file\n"); return 1; }
    std::vector<uint16_t> depth((size_t)W*H*N);
    if(dc_decode_signal(webm.data(),webm.size(),"depth",depth.data())){ fprintf(stderr,"decode failed\n"); return 1; }
    writeFile(argv[3],(uint8_t*)depth.data(),depth.size()*2);
    printf("decoded %dx%d x%d → %s\n",W,H,N,argv[3]); return 0;
  }

  if(cmd=="encode"){
    if(argc<10){ fprintf(stderr,"encode <in.u16> W H N fps near far <out.webm>\n"); return 2; }
    auto raw=readFile(argv[2]); int W=atoi(argv[3]),H=atoi(argv[4]),N=atoi(argv[5]),fps=atoi(argv[6]);
    double near_=atof(argv[7]),far_=atof(argv[8]);
    if(raw.size()!=(size_t)W*H*N*2){ fprintf(stderr,"size mismatch: %zu vs %d\n",raw.size(),W*H*N*2); return 1; }
    uint8_t* buf; size_t len;
    if(encodeDepthOnly((const uint16_t*)raw.data(),W,H,N,fps,near_,far_,65536,&buf,&len)){ fprintf(stderr,"encode failed\n"); return 1; }
    writeFile(argv[9],buf,len); printf("encoded → %s (%.1f KiB)\n",argv[9],len/1024.0); dc_free(buf); return 0;
  }

  if(cmd=="encodergbd"){
    if(argc<11){ fprintf(stderr,"encodergbd <rgba.bin> <depth.u16> W H N fps near far kbps <out.webm>\n"); return 2; }
    auto rgb=readFile(argv[2]); auto dep=readFile(argv[3]);
    int W=atoi(argv[4]),H=atoi(argv[5]),N=atoi(argv[6]),fps=atoi(argv[7]);
    double near_=atof(argv[8]),far_=atof(argv[9]); int kbps=atoi(argv[10]);
    if(rgb.size()!=(size_t)W*H*N*4){ fprintf(stderr,"rgba size mismatch\n"); return 1; }
    if(dep.size()!=(size_t)W*H*N*2){ fprintf(stderr,"depth size mismatch\n"); return 1; }
    uint8_t* buf; size_t len;
    dc_signal_spec_t spec{"depth", (const uint16_t*)dep.data(), 1, near_, far_, 65536};
    if(dc_encode_multi(rgb.data(), kbps, &spec, 1, W, H, N, fps, &buf, &len)){ fprintf(stderr,"encode failed\n"); return 1; }
    writeFile(argv[11],buf,len); printf("encoded RGBD → %s (%.1f KiB)\n",argv[11],len/1024.0); dc_free(buf); return 0;
  }

  if(cmd=="decodergb"){
    if(argc<4){ fprintf(stderr,"decodergb <in.webm> <out.rgba>\n"); return 2; }
    auto webm=readFile(argv[2]); int W=0,H=0,N=0,fps=0,rgb=0,levels=0; double near_=0,far_=0;
    if(dc_probe(webm.data(),webm.size(),&W,&H,&N,&fps,&near_,&far_,&levels,&rgb)){ fprintf(stderr,"not a chromapakz file\n"); return 1; }
    if(!rgb){ fprintf(stderr,"file has no RGB track\n"); return 1; }
    std::vector<uint8_t> out((size_t)W*H*N*4);
    if(dc_decode_rgb(webm.data(),webm.size(),out.data())){ fprintf(stderr,"rgb decode failed\n"); return 1; }
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
