// Shared quantization + triangle-fold packing (no WebCodecs / WebM).

export const LEVELS_FULL = 65536;

export function quantizeInverseDepth(z, near, far, levels=LEVELS_FULL){
  const M=levels-2, maxc=levels-1, out=new Uint16Array(z.length), a=1/near, b=1/far, inv=1/(a-b);
  for(let i=0;i<z.length;i++){ const v=z[i];
    if(!(v>0)) { out[i]=0; continue; }
    let q=Math.round((1/v - b)*inv*M)+1;
    out[i]=q<1?1:(q>maxc?maxc:q);
  }
  return out;
}

export function dequantizeInverseDepth(d, near, far, levels=LEVELS_FULL){
  const M=levels-2, out=new Float32Array(d.length), a=1/near, b=1/far;
  for(let i=0;i<d.length;i++){ const c=d[i];
    out[i]= c===0 ? NaN : 1/(((c-1)/M)*(a-b)+b);
  }
  return out;
}

/** Inverse-depth range from valid-pixel percentiles (depth signal helper). */
export function autoNearFar(depthFrames, lo=1, hi=99){
  const vals=[];
  for(const z of depthFrames) for(let i=0;i<z.length;i++){
    const v=z[i]; if(v>0 && Number.isFinite(v)) vals.push(v);
  }
  if(!vals.length) throw new Error('no valid (>0, finite) depth samples');
  vals.sort((a,b)=>a-b);
  let near=vals[Math.floor(vals.length*lo/100)];
  let far=vals[Math.floor(vals.length*hi/100)];
  if(near<=0) near=vals.find(v=>v>0);
  if(far<=near) far=near*1.0001+1e-6;
  return { near, far };
}

const FOLD_BITS = 8;

export function triFoldPack(d){
  const hi=new Uint8Array(d.length), lo=new Uint8Array(d.length);
  for(let i=0;i<d.length;i++){ const h=d[i]>>FOLD_BITS, l=d[i]&0xff; hi[i]=h; lo[i]=(h&1)?(255-l):l; }
  return { hi, lo };
}

export function triFoldUnpack(hi, lo){
  const d=new Uint16Array(hi.length);
  for(let i=0;i<d.length;i++){ const h=hi[i], l=(h&1)?(255-lo[i]):lo[i]; d[i]=(h<<FOLD_BITS)|l; }
  return d;
}
