/** Node test: RGB presence vs. the frozen track plan (issue #9).
 *
 *  createEncoder freezes signal track numbers on the first addFrame. If frame 0 carries no rgb,
 *  signals start at track 1 — the number rgb writes to — so rgb arriving later used to produce a
 *  file with two track-1s, decoded as both `rgb` and `<signal>:hi`. RGB presence must therefore be
 *  declared up front (`hasRgb:true`) or the encoder must fail loudly.
 *  Run: node tests/js_encoder_rgb_plan.mjs */
import { createEncoder, encode, createDecoder } from '../src/chromapakz.js';
import { demux } from '../src/webm.js';
import { normalizeMetadata } from '../src/signals.js';

const W=32, H=16, BACKEND='wasm';

const ids=f=>{ const u=new Uint16Array(W*H); for(let i=0;i<u.length;i++) u[i]=(i*37+f*911)&0xffff; return u; };
const rgba=f=>{ const a=new Uint8Array(W*H*4);
  for(let i=0;i<W*H;i++){ a[4*i]=(i+f)&255; a[4*i+1]=128; a[4*i+2]=(f*40)&255; a[4*i+3]=255; }
  return a; };
const eqU16=(a,b)=>a.length===b.length && a.every((v,i)=>v===b[i]);

let failed=0;
function ok(c, m){ if(c) console.log('ok  -', m); else { console.error('FAIL:', m); failed++; } }
async function rejects(fn, re, m){
  try{ await fn(); ok(false, `${m}: expected throw`); }
  catch(e){ ok(re.test(String(e.message)), `${m}: "${e.message}"`); }
}
const trackNumbers=meta=>[...(meta.rgb ? [meta.rgb.track] : []), ...meta.signals.flatMap(s=>[s.tracks.hi, s.tracks.lo])];

// ── inferred plan: rgb after frame 0 is refused, not silently collided ──
{
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'objectId' }], backend:BACKEND });
  await enc.addFrame({ signals:{ objectId:{ u16: ids(0) } } });
  await rejects(()=>enc.addFrame({ rgb: rgba(1), signals:{ objectId:{ u16: ids(1) } } }),
    /rgb appeared after the track plan was frozen/, 'buffered: late rgb refused');
}
{
  const chunks=[];
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'objectId' }], backend:BACKEND, onChunk:c=>chunks.push(c) });
  await enc.addFrame({ signals:{ objectId:{ u16: ids(0) } } });
  ok(chunks.length>0, 'streaming: header emitted before the collision would occur');
  await rejects(()=>enc.addFrame({ rgb: rgba(1), signals:{ objectId:{ u16: ids(1) } } }),
    /rgb appeared after the track plan was frozen/, 'streaming: late rgb refused');
}

// ── explicit declarations ──
{
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'objectId' }], backend:BACKEND, hasRgb:false });
  await rejects(()=>enc.addFrame({ rgb: rgba(0), signals:{ objectId:{ u16: ids(0) } } }),
    /declared none/, 'hasRgb:false rejects an rgb frame');
}
{
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'objectId' }], backend:BACKEND, hasRgb:true });
  ok(enc.signalPlan[0].tracks.hi===2 && enc.signalPlan[0].tracks.lo===3, 'hasRgb:true reserves track 1 before any frame');
  await enc.addFrame({ signals:{ objectId:{ u16: ids(0) } } });
  await rejects(()=>enc.finish(), /no frame carried rgb/, 'hasRgb:true with no rgb frame fails at finish');
}
try{ createEncoder({ W, H, signals:[{ id:'x' }], hasRgb:'yes' }); ok(false, 'hasRgb type check: expected throw'); }
catch(e){ ok(/hasRgb must be true, false, or omitted/.test(e.message), 'hasRgb rejects non-boolean'); }

// ── declared up front: rgb starting at frame 1 round-trips with distinct tracks ──
{
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'objectId' }], backend:BACKEND, hasRgb:true });
  await enc.addFrame({ signals:{ objectId:{ u16: ids(0) } } });
  await enc.addFrame({ rgb: rgba(1), signals:{ objectId:{ u16: ids(1) } } });
  const bytes=await enc.finish();

  const { tracks, metadata }=demux(bytes);
  const meta=normalizeMetadata(metadata);
  const nums=trackNumbers(meta);
  ok(new Set(nums).size===nums.length, `track numbers are unique (${nums.join(',')})`);
  ok(meta.rgb.track===1 && meta.signals[0].tracks.hi===2 && meta.signals[0].tracks.lo===3,
    'rgb on track 1, signal on 2/3');
  ok(tracks[1].frames.length===1, 'rgb track carries only the one rgb frame');
  ok(tracks[2].frames.length===2, 'signal hi track carries both frames');

  const dec=createDecoder(bytes, { backend:BACKEND });
  const frames=[];
  for await (const fr of dec) frames.push(fr);
  await dec.close();
  ok(frames.length===2, `decoded 2 frames (got ${frames.length})`);
  ok(!frames[0].rgb, 'frame 0 has no rgb');
  ok(frames[1].rgb?.length===W*H*4, 'frame 1 decodes rgb');
  ok(eqU16(frames[0].signals.objectId.u16, ids(0)) && eqU16(frames[1].signals.objectId.u16, ids(1)),
    'signal stays bit-exact — not overwritten by rgb blocks');
}

// ── a stream that resumes after a gap can't be offset back into alignment: refuse it ──
{
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'a' }, { id:'b' }], backend:BACKEND });
  await enc.addFrame({ signals:{ a:{ u16: ids(0) }, b:{ u16: ids(0) } } });
  await enc.addFrame({ signals:{ a:{ u16: ids(1) } } });
  await rejects(()=>enc.addFrame({ signals:{ a:{ u16: ids(2) }, b:{ u16: ids(2) } } }),
    /"b" is absent on frame 1 but present on frame 2/, 'gap in a started stream refused');
}

// ── batch encode() sees every frame, so it declares rgb itself ──
{
  const bytes=await encode({ W, H, fps:30, signals:[{ id:'objectId' }],
    frames:[{ signals:{ objectId:{ u16: ids(0) } } }, { rgb: rgba(1), signals:{ objectId:{ u16: ids(1) } } }] });
  const meta=normalizeMetadata(demux(bytes).metadata);
  const nums=trackNumbers(meta);
  ok(new Set(nums).size===nums.length, `encode(): track numbers are unique (${nums.join(',')})`);
  ok(meta.rgb?.track===1 && meta.signals[0].tracks.hi===2, 'encode(): late rgb planned on track 1');
}

if(failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('all passed');
