/** Node tests: quantization + triangle-fold edge cases. Run: node tests/js_core_edge.mjs */
import {
  quantizeInverseDepth,
  dequantizeInverseDepth,
  triFoldPack,
  triFoldUnpack,
  autoNearFar,
  LEVELS_FULL,
} from '../src/chromapakz-core.js';

let failed = 0;
function ok(c, m){ if(!c){ console.error('FAIL:', m); failed++; } }

// ── triangle-fold: exhaustive round-trip over the full uint16 domain ──
{
  const all=new Uint16Array(65536);
  for(let i=0;i<65536;i++) all[i]=i;
  const { hi, lo }=triFoldPack(all);
  const back=triFoldUnpack(hi, lo);
  let exact=true;
  for(let i=0;i<65536;i++) if(back[i]!==i){ exact=false; break; }
  ok(exact, 'triFold round-trips every uint16 value');

  // continuity across byte boundaries: adjacent codes never produce a lo-byte cliff
  let maxStep=0;
  for(let i=1;i<65536;i++) maxStep=Math.max(maxStep, Math.abs(lo[i]-lo[i-1]));
  ok(maxStep===1, `lo plane is continuous (max adjacent step ${maxStep}, want 1)`);
}

// ── invalid inputs map to code 0, and only code 0 ──
{
  const z=new Float32Array([0, -1, -0.0001, NaN, Infinity, -Infinity]);
  const q=quantizeInverseDepth(z, 0.2, 10);
  ok(q[0]===0 && q[1]===0 && q[2]===0 && q[3]===0, 'zero/negative/NaN -> code 0');
  ok(q[5]===0, '-Infinity -> code 0');
  // +Infinity is a "valid" (>0) but beyond-far depth: must clamp into range, never 0
  ok(q[4]>=1, '+Infinity clamps to a valid far code');
}

// ── clamping at the near/far ends ──
{
  const near=0.5, far=5;
  const z=new Float32Array([0.001, near, far, 1000]);
  const q=quantizeInverseDepth(z, near, far);
  ok(q[0]===LEVELS_FULL-1, 'nearer-than-near clamps to max code');
  ok(q[1]===LEVELS_FULL-1, 'depth==near maps to max code');
  ok(q[2]===1, 'depth==far maps to code 1');
  ok(q[3]===1, 'farther-than-far clamps to code 1');
}

// ── code 0 dequantizes to NaN; every valid code to a finite in-range depth ──
{
  const near=0.3, far=9;
  const codes=new Uint16Array([0, 1, 32768, LEVELS_FULL-1]);
  const z=dequantizeInverseDepth(codes, near, far);
  ok(Number.isNaN(z[0]), 'code 0 -> NaN');
  for(let i=1;i<codes.length;i++)
    ok(Number.isFinite(z[i]) && z[i]>=near*0.999 && z[i]<=far*1.001, `code ${codes[i]} -> in-range depth (${z[i]})`);
  ok(Math.abs(z[1]-far)<1e-3*far, 'code 1 -> ~far');
  ok(Math.abs(z[3]-near)<1e-3*near, 'max code -> ~near');
}

// ── reduced levels: round-trip error bounded by half a step in inverse-depth domain ──
for(const levels of [4, 256, 1024, 4096]){
  const near=0.5, far=8, M=levels-2;
  const a=1/near, b=1/far, step=(a-b)/M;
  const n=500;
  const z=new Float32Array(n);
  for(let i=0;i<n;i++) z[i]=near + (far-near)*i/(n-1);
  const q=quantizeInverseDepth(z, near, far, levels);
  const back=dequantizeInverseDepth(q, near, far, levels);
  let worst=0;
  for(let i=0;i<n;i++){
    ok(q[i]>=1 && q[i]<=levels-1, `levels=${levels}: code in [1,${levels-1}]`);
    worst=Math.max(worst, Math.abs(1/back[i]-1/z[i])/step);
  }
  ok(worst<=0.51, `levels=${levels}: max inverse-depth error ${worst.toFixed(3)} steps (want <=0.5)`);
}

// ── quantization is monotone: deeper never gets a larger code ──
{
  const n=2000, z=new Float32Array(n);
  for(let i=0;i<n;i++) z[i]=0.2 + i*(10-0.2)/(n-1);
  const q=quantizeInverseDepth(z, 0.2, 10, 1024);
  let mono=true;
  for(let i=1;i<n;i++) if(q[i]>q[i-1]) mono=false;
  ok(mono, 'codes non-increasing with depth');
}

// ── autoNearFar: percentile arguments and degenerate spreads ──
{
  const z=new Float32Array(101);
  for(let i=0;i<=100;i++) z[i]=1+i*0.1;      // 1.0 .. 11.0
  const d=autoNearFar([z], 10, 90);
  ok(Math.abs(d.near-2.0)<0.11, `10th pct near ~2.0 (${d.near})`);
  ok(Math.abs(d.far-10.0)<0.11, `90th pct far ~10.0 (${d.far})`);

  const flat=new Float32Array(50).fill(3.25);  // constant depth: far must still exceed near
  const df=autoNearFar([flat]);
  ok(df.near===3.25 && df.far>df.near, `constant depth widened (near=${df.near}, far=${df.far})`);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
