/** Node tests: plane-length validation on the encode path.
 *
 *  A plane that isn't exactly W*H (or W*H*4 for rgba) used to reach the codec backends unchecked.
 *  The WASM backend copies it into a W*H allocation with `HEAPU8.set()` — an oversized plane wrote
 *  past the allocation into live libvpx state, an undersized one encoded stale heap bytes. These
 *  tests pin the error at three layers (payload helper, addFrame, backend) and check that a
 *  rejected frame leaves the encoder usable rather than half-written.
 *
 *  Run: node tests/js_plane_validation.mjs */
import { createEncoder, createDecoder } from '../src/chromapakz.js';
import { u16FromFramePayload } from '../src/signals.js';
import * as wasmEncode from '../src/backend/wasm/encode.js';

const W=32, H=24, PIX=W*H;

let failed=0;
function ok(c, m){ if(!c){ console.error('FAIL:', m); failed++; } }
function throws(fn, re, m){
  try{ fn(); ok(false, `${m}: expected throw`); }
  catch(e){ ok(re.test(String(e)), `${m}: message "${e}"`); }
}
async function rejects(p, re, m){
  try{ await p; ok(false, `${m}: expected rejection`); }
  catch(e){ ok(re.test(String(e)), `${m}: message "${e}"`); }
}

// ── u16FromFramePayload: length check only when the caller knows the geometry ──
const rawSig={ id:'raw', quant:null };
const depthSig={ id:'depth', quant:{ type:'inverse-depth', near:0.5, far:10 } };

ok(u16FromFramePayload({ u16:new Uint16Array(PIX) }, rawSig, PIX).length===PIX, 'exact u16 accepted');
throws(()=>u16FromFramePayload({ u16:new Uint16Array(PIX+1) }, rawSig, PIX),
  /u16 plane has 769 samples, expected 768/, 'oversized u16');
throws(()=>u16FromFramePayload({ u16:new Uint16Array(PIX-1) }, rawSig, PIX),
  /expected 768/, 'undersized u16');
throws(()=>u16FromFramePayload({ float:new Float32Array(PIX*2) }, depthSig, PIX),
  /float plane has 1536 samples, expected 768/, 'oversized float');
ok(u16FromFramePayload({ float:new Float32Array(PIX).fill(1) }, depthSig, PIX).length===PIX,
  'exact float accepted');
// Without the expected count the helper still passes anything through (used where W*H is unknown).
ok(u16FromFramePayload({ u16:new Uint16Array(3) }, rawSig).length===3, 'no length arg -> no check');

// ── backend: the memory-safety backstop, exercised directly ──
{
  const enc=wasmEncode.createTrackEncoder({ kind:'luma', lossless:true, W, H, fps:30 });
  await rejects(enc.push(new Uint8Array(PIX*4)), /plane has 3072 bytes, expected 768/,
    'wasm luma encoder rejects oversized plane');
  await rejects(enc.push(new Uint8Array(PIX-10)), /expected 768/,
    'wasm luma encoder rejects undersized plane');
  await enc.close();

  const rgba=wasmEncode.createTrackEncoder({ kind:'rgba', lossless:false, W, H, fps:30, bitrate:200_000 });
  await rejects(rgba.push(new Uint8Array(PIX)), /plane has 768 bytes, expected 3072/,
    'wasm rgba encoder rejects luma-sized plane');
  await rgba.close();
}

// ── addFrame: rejects before touching any encoder, and stays usable afterwards ──
function planeAt(f){
  const u16=new Uint16Array(PIX);
  for(let i=0;i<PIX;i++) u16[i]=(i*37+f*911)&0xffff;
  return u16;
}
function eq(a,b){ if(a.length!==b.length) return false; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; }

{
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'raw' }], backend:'wasm' });

  await rejects(enc.addFrame({ signals:{ raw:{ u16:new Uint16Array(PIX+64) } } }),
    /raw.*expected 768/, 'addFrame rejects oversized u16');
  await rejects(enc.addFrame({ signals:{ raw:{ u16:new Uint16Array(PIX>>1) } } }),
    /raw.*expected 768/, 'addFrame rejects undersized u16');
  // Geometry is checked before the track-plan rules, so this reports the wrong-length buffer
  // rather than "rgb appeared after the track plan was frozen" — the buffer is the real bug.
  await rejects(enc.addFrame({ rgb:new Uint8Array(PIX*4-4) }),
    /rgb plane has 3068 bytes, expected 3072/, 'addFrame rejects wrong-length rgb');
  ok(enc.frameCount===0, 'rejected frames are not counted');

  // The rejections must not have advanced any track encoder: 3 good frames still round-trip.
  const seq=[planeAt(0), planeAt(1), planeAt(2)];
  for(const u16 of seq) await enc.addFrame({ signals:{ raw:{ u16 } } });
  ok(enc.frameCount===3, `frameCount after 3 good frames: ${enc.frameCount}`);
  const bytes=await enc.finish();

  const dec=createDecoder(bytes, { backend:'wasm' });
  const out=[];
  for await (const fr of dec) out.push(fr.signals.raw.u16);
  await dec.close();
  ok(out.length===3, `decoded ${out.length} frames, want 3`);
  for(let i=0;i<out.length;i++) ok(eq(seq[i], out[i]), `frame ${i} bit-exact after rejected frames`);
}

// An encoder that reserved an rgb track up front checks the buffer the same way.
{
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'raw' }], backend:'wasm', hasRgb:true });
  await rejects(enc.addFrame({ rgb:new Uint8Array(PIX*4+4), signals:{ raw:{ u16:planeAt(0) } } }),
    /rgb plane has 3076 bytes, expected 3072/, 'declared-rgb encoder rejects oversized rgb');
  ok(enc.frameCount===0, 'rejected rgb frame is not counted');
}

// A wrong-length plane on the *second* signal must not leave the first signal's tracks ahead.
{
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'a' }, { id:'b' }], backend:'wasm' });
  await rejects(enc.addFrame({ signals:{ a:{ u16:planeAt(0) }, b:{ u16:new Uint16Array(PIX+1) } } }),
    /"b".*expected 768/, 'addFrame rejects when a later signal is wrong-length');
  ok(enc.frameCount===0, 'partially-validated frame is not counted');

  await enc.addFrame({ signals:{ a:{ u16:planeAt(0) }, b:{ u16:planeAt(1) } } });
  await enc.addFrame({ signals:{ a:{ u16:planeAt(2) }, b:{ u16:planeAt(3) } } });
  const bytes=await enc.finish();

  const dec=createDecoder(bytes, { backend:'wasm' });
  const out=[];
  for await (const fr of dec) out.push(fr.signals);
  await dec.close();
  ok(out.length===2, `multi-signal: decoded ${out.length} frames, want 2`);
  ok(out.length===2 && eq(out[0].a.u16, planeAt(0)) && eq(out[0].b.u16, planeAt(1))
     && eq(out[1].a.u16, planeAt(2)) && eq(out[1].b.u16, planeAt(3)),
    'multi-signal frames bit-exact and in sync');
}

if(failed){ console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('all passed');
