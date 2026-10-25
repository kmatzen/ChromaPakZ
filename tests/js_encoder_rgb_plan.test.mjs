/** Node test: RGB presence vs. the frozen track plan (issue #9).
 *
 *  createEncoder freezes signal track numbers on the first addFrame. If frame 0 carries no rgb,
 *  signals start at track 1 — the number rgb writes to — so rgb arriving later used to produce a
 *  file with two track-1s, decoded as both `rgb` and `<signal>:hi`. RGB presence must therefore be
 *  declared up front (`hasRgb:true`) or the encoder must fail loudly.
 *  Run: node tests/js_encoder_rgb_plan.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEncoder, encode, createDecoder } from '../src/chromapakz.js';
import { demux } from '../src/webm.js';
import { normalizeMetadata } from '../src/signals.js';

const W=32, H=16, BACKEND='wasm';

const ids=f=>{ const u=new Uint16Array(W*H); for(let i=0;i<u.length;i++) u[i]=(i*37+f*911)&0xffff; return u; };
const rgba=f=>{ const a=new Uint8Array(W*H*4);
  for(let i=0;i<W*H;i++){ a[4*i]=(i+f)&255; a[4*i+1]=128; a[4*i+2]=(f*40)&255; a[4*i+3]=255; }
  return a; };
const eqU16=(a,b)=>a.length===b.length && a.every((v,i)=>v===b[i]);

async function rejects(fn, re, m){
  try{ await fn(); assert.ok(false, `${m}: expected throw`); }
  catch(e){ assert.ok(re.test(String(e.message)), `${m}: "${e.message}"`); }
}
const trackNumbers=meta=>[...(meta.rgb ? [meta.rgb.track] : []), ...meta.signals.flatMap(s=>[s.tracks.hi, s.tracks.lo])];

test('inferred plan: rgb after frame 0 is refused, not silently collided', async () => {
    const enc=createEncoder({ W, H, fps:30, signals:[{ id:'objectId' }], backend:BACKEND });
    await enc.addFrame({ signals:{ objectId:{ u16: ids(0) } } });
    await rejects(()=>enc.addFrame({ rgb: rgba(1), signals:{ objectId:{ u16: ids(1) } } }),
      /rgb appeared after the track plan was frozen/, 'buffered: late rgb refused');

});
{
  const chunks=[];
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'objectId' }], backend:BACKEND, onChunk:c=>chunks.push(c) });
  await enc.addFrame({ signals:{ objectId:{ u16: ids(0) } } });
  assert.ok(chunks.length>0, 'streaming: header emitted before the collision would occur');
  await rejects(()=>enc.addFrame({ rgb: rgba(1), signals:{ objectId:{ u16: ids(1) } } }),
    /rgb appeared after the track plan was frozen/, 'streaming: late rgb refused');
}

test('explicit declarations', async () => {
    const enc=createEncoder({ W, H, fps:30, signals:[{ id:'objectId' }], backend:BACKEND, hasRgb:false });
    await rejects(()=>enc.addFrame({ rgb: rgba(0), signals:{ objectId:{ u16: ids(0) } } }),
      /declared none/, 'hasRgb:false rejects an rgb frame');

});
{
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'objectId' }], backend:BACKEND, hasRgb:true });
  assert.ok(enc.signalPlan[0].tracks.hi===2 && enc.signalPlan[0].tracks.lo===3, 'hasRgb:true reserves track 1 before any frame');
  await enc.addFrame({ signals:{ objectId:{ u16: ids(0) } } });
  await rejects(()=>enc.finish(), /no frame carried rgb/, 'hasRgb:true with no rgb frame fails at finish');
}
try{ createEncoder({ W, H, signals:[{ id:'x' }], hasRgb:'yes' }); assert.ok(false, 'hasRgb type check: expected throw'); }
catch(e){ assert.ok(/hasRgb must be true, false, or omitted/.test(e.message), 'hasRgb rejects non-boolean'); }

test('declared up front: rgb starting at frame 1 round-trips with distinct tracks', async () => {
    const enc=createEncoder({ W, H, fps:30, signals:[{ id:'objectId' }], backend:BACKEND, hasRgb:true });
    await enc.addFrame({ signals:{ objectId:{ u16: ids(0) } } });
    await enc.addFrame({ rgb: rgba(1), signals:{ objectId:{ u16: ids(1) } } });
    const bytes=await enc.finish();

    const { tracks, metadata }=demux(bytes);
    const meta=normalizeMetadata(metadata);
    const nums=trackNumbers(meta);
    assert.ok(new Set(nums).size===nums.length, `track numbers are unique (${nums.join(',')})`);
    assert.ok(meta.rgb.track===1 && meta.signals[0].tracks.hi===2 && meta.signals[0].tracks.lo===3,
      'rgb on track 1, signal on 2/3');
    assert.ok(tracks[1].frames.length===1, 'rgb track carries only the one rgb frame');
    assert.ok(tracks[2].frames.length===2, 'signal hi track carries both frames');

    const dec=createDecoder(bytes, { backend:BACKEND });
    const frames=[];
    for await (const fr of dec) frames.push(fr);
    await dec.close();
    assert.ok(frames.length===2, `decoded 2 frames (got ${frames.length})`);
    assert.ok(!frames[0].rgb, 'frame 0 has no rgb');
    assert.ok(frames[1].rgb?.length===W*H*4, 'frame 1 decodes rgb');
    assert.ok(eqU16(frames[0].signals.objectId.u16, ids(0)) && eqU16(frames[1].signals.objectId.u16, ids(1)),
      'signal stays bit-exact — not overwritten by rgb blocks');

});

test("a stream that resumes after a gap can't be offset back into alignment: refuse it", async () => {
    const enc=createEncoder({ W, H, fps:30, signals:[{ id:'a' }, { id:'b' }], backend:BACKEND });
    await enc.addFrame({ signals:{ a:{ u16: ids(0) }, b:{ u16: ids(0) } } });
    await enc.addFrame({ signals:{ a:{ u16: ids(1) } } });
    await rejects(()=>enc.addFrame({ signals:{ a:{ u16: ids(2) }, b:{ u16: ids(2) } } }),
      /"b" is absent on frame 1 but present on frame 2/, 'gap in a started stream refused');

});

test('batch encode() sees every frame, so it declares rgb itself', async () => {
    const bytes=await encode({ W, H, fps:30, signals:[{ id:'objectId' }],
      frames:[{ signals:{ objectId:{ u16: ids(0) } } }, { rgb: rgba(1), signals:{ objectId:{ u16: ids(1) } } }] });
    const meta=normalizeMetadata(demux(bytes).metadata);
    const nums=trackNumbers(meta);
    assert.ok(new Set(nums).size===nums.length, `encode(): track numbers are unique (${nums.join(',')})`);
    assert.ok(meta.rgb?.track===1 && meta.signals[0].tracks.hi===2, 'encode(): late rgb planned on track 1');

});

test('signals:[] is legal when an RGB track is declared (RGB-only container)', async () => {
    const enc=createEncoder({ W, H, fps:30, signals:[], backend:BACKEND, hasRgb:true });
    await enc.addFrame({ rgb: rgba(0) });
    await enc.addFrame({ rgb: rgba(1) });
    const bytes=await enc.finish();

    const meta=normalizeMetadata(demux(bytes).metadata);
    assert.deepEqual(meta.signals, [], 'RGB-only container declares no signal tracks');
    assert.equal(meta.rgb?.track, 1, 'rgb keeps track 1');

    const dec=createDecoder(bytes, { backend:BACKEND });
    assert.equal(dec.frameCount, 2, 'both frames round-trip');
    const f0=await dec.readFrame();
    assert.equal(f0?.rgb?.length, W*H*4, 'rgb decodes');
    assert.deepEqual(Object.keys(f0?.signals ?? {}), [], 'no signals on the decoded frame');
    assert.ok(await dec.readFrame(), 'frame 1 decodes');
    assert.equal(await dec.readFrame(), null, 'stream ends');
    await dec.close();
});

test('named rgbs[] declare the track too; an empty declaration does not', async () => {
    const enc=createEncoder({ W, H, fps:30, signals:[], backend:BACKEND, rgbs:[{ id:'rgb' }] });
    await enc.addFrame({ rgb: rgba(0) });
    assert.ok((await enc.finish()).length>0, 'rgbs:[{id}] satisfies signals[] for an RGB-only file');

    assert.throws(() => createEncoder({ W, H, fps:30, signals:[], backend:BACKEND, rgbs:[] }),
      /signals\[\] required/, 'rgbs:[] declares zero tracks, so signals[] is still required');
});

test('signals:[] is still refused when nothing declares an RGB track', async () => {
    assert.throws(() => createEncoder({ W, H, fps:30, signals:[], backend:BACKEND }),
      /signals\[\] required/, 'omitted hasRgb infers nothing at create time');
    assert.throws(() => createEncoder({ W, H, fps:30, signals:[], backend:BACKEND, hasRgb:false }),
      /signals\[\] required/, 'hasRgb:false declares no track');
    await rejects(()=>encode({ W, H, fps:30, signals:[], frames:[{ signals:{} }] }),
      /signals\[\] required/, 'encode(): neither signals nor rgb declares a track');
});

test('batch encode() accepts an RGB-only clip', async () => {
    const bytes=await encode({ W, H, fps:30, signals:[], frames:[{ rgb: rgba(0) }, { rgb: rgba(1) }] });
    const meta=normalizeMetadata(demux(bytes).metadata);
    assert.deepEqual(meta.signals, [], 'encode(): no signal tracks');
    assert.equal(meta.rgb?.track, 1, 'encode(): rgb planned on track 1');

    const dec=createDecoder(bytes, { backend:BACKEND });
    assert.equal(dec.frameCount, 2, 'encode(): both frames round-trip');
    await dec.close();
});

console.log('all passed');

