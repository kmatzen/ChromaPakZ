// DOM-free core of the lossless depth-packing probe.
// Imported by index.html (UI) and headless.html (Playwright runner).

// ── Synthetic depth: slanted plane + raised disc + far band + ±3-LSB sensor noise ──
// Wide value span so the low byte crosses many segment boundaries (the sawtooth-cliff stressor).
export function makeDepth(W, H) {
  const d = new Uint16Array(W * H);
  let s = 0x9e3779b9 >>> 0;
  const noise = () => { s ^= s<<13; s^=s>>>17; s^=s<<5; s>>>=0; return ((s & 7) - 3); };
  const cx = W*0.55, cy = H*0.45, R = Math.min(W,H)*0.28;
  for (let r=0;r<H;r++) for (let c=0;c<W;c++){
    let z = 9000 + (c*70) + (r*45);
    if ((c-cx)**2 + (r-cy)**2 < R*R) z -= 6000;
    if (r > H*0.85) z = 60000;
    z += noise();
    d[r*W+c] = Math.max(0, Math.min(65535, z));
  }
  return d;
}

// ── Packing schemes: uint16 depth → two 8-bit planes (hi, lo), reversibly ──
export const SCHEMES = {
  'byte-split': {
    pack(d){ const hi=new Uint8Array(d.length), lo=new Uint8Array(d.length);
      for(let i=0;i<d.length;i++){ hi[i]=d[i]>>8; lo[i]=d[i]&0xff; } return {hi,lo}; },
    unpack(hi,lo){ const d=new Uint16Array(hi.length);
      for(let i=0;i<d.length;i++) d[i]=(hi[i]<<8)|lo[i]; return d; },
  },
  'triangle-fold': {
    pack(d){ const hi=new Uint8Array(d.length), lo=new Uint8Array(d.length);
      for(let i=0;i<d.length;i++){ const h=d[i]>>8, l=d[i]&0xff; hi[i]=h; lo[i]=(h&1)?(255-l):l; }
      return {hi,lo}; },
    unpack(hi,lo){ const d=new Uint16Array(hi.length);
      for(let i=0;i<d.length;i++){ const h=hi[i], l=(h&1)?(255-lo[i]):lo[i]; d[i]=(h<<8)|l; }
      return d; },
  },
};

function makeFrame(yPlane, W, H, i=0){
  const cW=W>>1, cH=H>>1, buf=new Uint8Array(W*H+2*cW*cH);
  buf.set(yPlane,0); buf.fill(128, W*H);
  return new VideoFrame(buf,{ format:'I420', codedWidth:W, codedHeight:H, timestamp:i*1000,
    colorSpace:{ primaries:'bt709', transfer:'iec61966-2-1', matrix:'bt709', fullRange:true }});
}
async function readY(frame, W, H){
  const dst=new Uint8Array(frame.allocationSize()); const lay=await frame.copyTo(dst); const y=lay[0];
  const out=new Uint8Array(W*H);
  for(let r=0;r<H;r++) out.set(dst.subarray(y.offset+r*y.stride, y.offset+r*y.stride+W), r*W);
  return out;
}
// Encode one 8-bit plane losslessly (QP=0), decode it back. Returns {bytes, recovered}.
function roundTrip(codec, plane, W, H){
  return new Promise((resolve,reject)=>{
    let bytes=0, recovered=null;
    const dec=new VideoDecoder({ output:async f=>{ try{recovered=await readY(f,W,H);}finally{f.close();} }, error:reject });
    const qpKey = codec.startsWith('vp09') ? 'vp9' : 'av1';
    const enc=new VideoEncoder({ output:(chunk,meta)=>{ if(meta?.decoderConfig) dec.configure(meta.decoderConfig);
      bytes+=chunk.byteLength; dec.decode(chunk); }, error:reject });
    enc.configure({ codec, width:W, height:H, bitrateMode:'quantizer', latencyMode:'quality' });
    const fr=makeFrame(plane,W,H); enc.encode(fr,{ keyFrame:true, [qpKey]:{ quantizer:0 } }); fr.close();
    enc.flush().then(()=>dec.flush()).then(()=>{ enc.close(); dec.close(); resolve({bytes,recovered}); }).catch(reject);
  });
}
async function supported(codec, W, H){
  try{ return (await VideoEncoder.isConfigSupported({codec,width:W,height:H,bitrateMode:'quantizer'})).supported; }
  catch{ return false; }
}
const eq=(a,b)=>{ if(a.length!==b.length) return false; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; };
const maxDelta=(a,b)=>{ let m=0; for(let i=0;i<a.length;i++){ const d=Math.abs(a[i]-b[i]); if(d>m) m=d; } return m; };

// ── 10-bit plumbing: carry a 10-bit plane (vals 0..1023) through VP9 profile 2 ──
function makeFrame10(yPlane, W, H, i=0){
  const cW=W>>1, cH=H>>1, buf=new Uint16Array(W*H+2*cW*cH);
  buf.set(yPlane,0); buf.fill(512, W*H);              // chroma mid (10-bit)
  return new VideoFrame(buf.buffer,{ format:'I420P10', codedWidth:W, codedHeight:H, timestamp:i*1000,
    colorSpace:{ primaries:'bt709', transfer:'iec61966-2-1', matrix:'bt709', fullRange:true }});
}
async function readY10(frame, W, H){
  const dst=new Uint8Array(frame.allocationSize()); const lay=await frame.copyTo(dst); const y=lay[0];
  const dv=new DataView(dst.buffer); const out=new Uint16Array(W*H);
  for(let r=0;r<H;r++){ let off=y.offset+r*y.stride; for(let c=0;c<W;c++){ out[r*W+c]=dv.getUint16(off,true); off+=2; } }
  return out;
}
// 10+6 packing: high 10 bits coherent, low 6 bits triangle-folded (parity of the high part).
const PACK10 = {
  pack(d){ const hi=new Uint16Array(d.length), lo=new Uint8Array(d.length);
    for(let i=0;i<d.length;i++){ const h=d[i]>>6, l=d[i]&0x3f; hi[i]=h; lo[i]=(h&1)?(63-l):l; } return {hi,lo}; },
  unpack(hi,lo){ const d=new Uint16Array(hi.length);
    for(let i=0;i<d.length;i++){ const h=hi[i], l=(h&1)?(63-lo[i]):lo[i]; d[i]=(h<<6)|l; } return d; },
};

// ── Temporally-coherent depth sequence: the disc drifts right, noise is fresh each frame ──
export function makeDepthSeq(W, H, N) {
  const frames = [];
  for (let f=0; f<N; f++){
    const d = new Uint16Array(W*H);
    let s = (0x9e3779b9 ^ (f*2654435761)) >>> 0;
    const noise = () => { s ^= s<<13; s^=s>>>17; s^=s<<5; s>>>=0; return ((s & 7) - 3); };
    const cx = W*(0.25 + 0.5*f/Math.max(1,N-1)), cy = H*0.45, R = Math.min(W,H)*0.22;
    for (let r=0;r<H;r++) for (let c=0;c<W;c++){
      let z = 9000 + (c*70) + (r*45);
      if ((c-cx)**2 + (r-cy)**2 < R*R) z -= 6000;
      if (r > H*0.85) z = 60000;
      z += noise();
      d[r*W+c] = Math.max(0, Math.min(65535, z));
    }
    frames.push(d);
  }
  return frames;
}

// Encode a whole plane-sequence as one stream. intra=true forces every frame to a keyframe.
// depth=8 uses I420 frames; depth=10 uses I420P10 (VP9 profile 2).
function roundTripSeq(codec, planeSeq, W, H, intra, depth=8){
  const mk = depth===10 ? makeFrame10 : makeFrame;
  const rd = depth===10 ? readY10 : readY;
  return new Promise((resolve,reject)=>{
    const bytes=[], recovered=[];
    const dec=new VideoDecoder({ output:async f=>{ try{recovered.push(await rd(f,W,H));}finally{f.close();} }, error:reject });
    const enc=new VideoEncoder({ output:(chunk,meta)=>{ if(meta?.decoderConfig) dec.configure(meta.decoderConfig);
      bytes.push(chunk.byteLength); dec.decode(chunk); }, error:reject });
    enc.configure({ codec, width:W, height:H, bitrateMode:'quantizer', latencyMode:'quality' });
    planeSeq.forEach((plane,i)=>{ const fr=mk(plane,W,H,i);
      enc.encode(fr,{ keyFrame: intra || i===0, vp9:{ quantizer:0 } }); fr.close(); });
    enc.flush().then(()=>dec.flush()).then(()=>{ enc.close(); dec.close(); resolve({bytes,recovered}); }).catch(reject);
  });
}

// Probe C: 10+6 split (10-bit coherent plane) vs 8+8, both inter-coded. Are wins additive?
export async function runProbe10GOP(W,H,N){
  const seq=makeDepthSeq(W,H,N);
  const eqU=(a,b)=>{ for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; };
  const rows=[];
  // 8+8 triangle-fold, inter
  { const sch=SCHEMES['triangle-fold'], p=seq.map(sch.pack);
    const rhi=await roundTripSeq('vp09.00.10.08',p.map(x=>x.hi),W,H,false,8);
    const rlo=await roundTripSeq('vp09.00.10.08',p.map(x=>x.lo),W,H,false,8);
    let ok=true,dMax=0; for(let i=0;i<N;i++){ const d2=sch.unpack(rhi.recovered[i],rlo.recovered[i]);
      const m=maxDelta(seq[i],d2); if(m>dMax)dMax=m; if(m)ok=false; }
    const hiB=rhi.bytes.reduce((a,b)=>a+b,0), loB=rlo.bytes.reduce((a,b)=>a+b,0);
    rows.push({split:'8+8 (8-bit×2)', lossless:ok, dMax, hiBytes:hiB, loBytes:loB, totalBytes:hiB+loB, px:W*H*N}); }
  // 10+6, inter: hi via VP9 profile2 10-bit, lo (6-bit folded) via 8-bit
  { const p=seq.map(PACK10.pack);
    const rhi=await roundTripSeq('vp09.02.10.10',p.map(x=>x.hi),W,H,false,10);
    const rlo=await roundTripSeq('vp09.00.10.08',p.map(x=>x.lo),W,H,false,8);
    let ok=true,dMax=0; for(let i=0;i<N;i++){
      const okHi=eqU(p[i].hi,rhi.recovered[i]); const d2=PACK10.unpack(rhi.recovered[i],rlo.recovered[i]);
      const m=maxDelta(seq[i],d2); if(m>dMax)dMax=m; if(m||!okHi)ok=false; }
    const hiB=rhi.bytes.reduce((a,b)=>a+b,0), loB=rlo.bytes.reduce((a,b)=>a+b,0);
    rows.push({split:'10+6 (10-bit + 8-bit)', lossless:ok, dMax, hiBytes:hiB, loBytes:loB, totalBytes:hiB+loB, px:W*H*N}); }
  return { width:W, height:H, N, rows };
}

// Probe B: does QP=0 stay bit-exact across P-frames, and how much does inter prediction save?
export async function runProbeGOP(W,H,N){
  const codec='vp09.00.10.08', sch=SCHEMES['triangle-fold'];
  const seq=makeDepthSeq(W,H,N);
  const packed=seq.map(sch.pack), hiSeq=packed.map(p=>p.hi), loSeq=packed.map(p=>p.lo);
  const rows=[];
  for(const intra of [true,false]){
    const rhi=await roundTripSeq(codec,hiSeq,W,H,intra), rlo=await roundTripSeq(codec,loSeq,W,H,intra);
    let lossless=true, dMax=0;
    for(let i=0;i<N;i++){ const d2=sch.unpack(rhi.recovered[i],rlo.recovered[i]);
      const m=maxDelta(seq[i],d2); if(m>dMax)dMax=m; if(m)lossless=false; }
    const hiB=rhi.bytes.reduce((a,b)=>a+b,0), loB=rlo.bytes.reduce((a,b)=>a+b,0);
    rows.push({ mode:intra?'intra-only':'inter (1 key + P)', lossless, dMax,
      hiBytes:hiB, loBytes:loB, totalBytes:hiB+loB, px:W*H*N, N });
  }
  return { width:W, height:H, N, codec, rows };
}

// Probe A: is high-bit-depth (profile 2) encode reachable in this browser? Decides 12+4 viability.
export async function probeHighDepth(W,H){
  const cands=['vp09.02.10.10','vp09.02.10.12','av01.0.04M.10'];
  const cfg=[];
  for(const codec of cands){
    let supported=false, err=null;
    try{ supported=(await VideoEncoder.isConfigSupported({codec,width:W,height:H,bitrateMode:'quantizer'})).supported; }
    catch(e){ err=String(e&&e.message||e); }
    cfg.push({codec,supported,err});
  }
  // Can we even construct a 10-bit input VideoFrame?
  const fmtTries=[];
  for(const format of ['I420P10','I420P12','I010']){
    try{ const px=W*H, buf=new Uint16Array(px+2*((W>>1)*(H>>1)));
      const fr=new VideoFrame(buf.buffer,{format,codedWidth:W,codedHeight:H,timestamp:0}); fr.close();
      fmtTries.push({format,ok:true}); }
    catch(e){ fmtTries.push({format,ok:false,err:String(e&&e.message||e).slice(0,80)}); }
  }
  return { cfg, fmtTries };
}

// Returns an array of result rows: {codec, scheme, lossless, hiBytes, loBytes, totalBytes, error?}
export async function runProbe(depth, W, H){
  const rows=[];
  const codecs=['vp09.00.10.08','av01.0.04M.08'];
  for(const codec of codecs){
    if(!(await supported(codec,W,H))){ rows.push({codec, scheme:'-', error:'unsupported (quantizer mode)'}); continue; }
    for(const [scheme,sch] of Object.entries(SCHEMES)){
      try{
        const {hi,lo}=sch.pack(depth);
        const rhi=await roundTrip(codec,hi,W,H), rlo=await roundTrip(codec,lo,W,H);
        const d2=sch.unpack(rhi.recovered, rlo.recovered);
        const lossless = eq(hi,rhi.recovered)&&eq(lo,rlo.recovered)&&eq(depth,d2);
        rows.push({codec, scheme, lossless, dMax:maxDelta(depth,d2),
                   hiBytes:rhi.bytes, loBytes:rlo.bytes, totalBytes:rhi.bytes+rlo.bytes, px:W*H});
      }catch(e){ rows.push({codec, scheme, error:String(e&&e.message||e)}); }
    }
  }
  return { width:W, height:H, rows, ua:navigator.userAgent, secure:self.isSecureContext };
}
