/** Multi-RGB (stereo / multi-camera) tracks — issue #47.
 *
 *  A v3 file carries N synchronized RGB streams beside the lossless signals. The primary stream
 *  keeps track 1 + container name "rgb" (and the legacy `rgb` metadata key), so pre-multi-RGB
 *  readers decode it exactly as before; secondaries ride tracks 2..N as `rgb-{id}`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEncoder, createDecoder, decode, encode } from '../src/chromapakz.js';
import { demux } from '../src/webm.js';
import { normalizeMetadata } from '../src/signals.js';

const W=32, H=16, N=3, BACKEND='wasm';

const ids=f=>{ const u=new Uint16Array(W*H); for(let i=0;i<u.length;i++) u[i]=(i*37+f*911)&0xffff; return u; };
// Solid, far-apart colours per camera: RGB is lossy, so identity is asserted by mean colour.
const solid=(r,g,b)=>{ const a=new Uint8Array(W*H*4);
  for(let i=0;i<W*H;i++){ a[4*i]=r; a[4*i+1]=g; a[4*i+2]=b; a[4*i+3]=255; }
  return a; };
const CAM0=solid(220, 30, 30), CAM1=solid(30, 30, 220);
const meanChannel=(rgba, c)=>{ let s=0; for(let i=0;i<W*H;i++) s+=rgba[4*i+c]; return s/(W*H); };
const looksLike=(rgba, ref, what)=>{
  for(const c of [0, 2])
    assert.ok(Math.abs(meanChannel(rgba, c)-meanChannel(ref, c))<40, `${what}: channel ${c} near source`);
};

async function encodeStereo({ onChunk=null }={}){
  const enc=createEncoder({ W, H, fps:30, signals:[{ id:'objectId' }],
    rgbs:['cam0', { id:'cam1', kbps:1_000_000 }], backend:BACKEND, onChunk });
  for(let f=0; f<N; f++)
    await enc.addFrame({ rgbs:{ cam0:CAM0, cam1:CAM1 }, signals:{ objectId:{ u16: ids(f) } } });
  return enc.finish();
}

test('stereo file: metadata, track layout, and both streams decode', async () => {
  const bytes=await encodeStereo();
  const { tracks, metadata }=demux(bytes);
  assert.equal(metadata.version, 3);
  assert.deepEqual(metadata.rgb, { track: 1, codec: 'vp09.00.10.08' }, 'legacy rgb = primary');
  assert.deepEqual(metadata.rgbs.map(r=>[r.id, r.track]), [['cam0', 1], ['cam1', 2]]);
  assert.deepEqual(metadata.signals[0].tracks, { hi: 3, lo: 4 }, 'signals number after all RGB tracks');
  assert.equal(tracks[1].name, 'rgb', 'primary keeps the container name pre-v3 readers scan for');
  assert.equal(tracks[2].name, 'rgb-cam1');
  assert.equal(tracks[1].frames.length, N);
  assert.equal(tracks[2].frames.length, N);

  const dec=createDecoder(bytes, { backend:BACKEND });
  const frames=[];
  for await (const fr of dec) frames.push(fr);
  await dec.close();
  assert.equal(frames.length, N);
  for(const fr of frames){
    assert.deepEqual(Object.keys(fr.rgbs).sort(), ['cam0', 'cam1']);
    assert.equal(fr.rgb, fr.rgbs.cam0, 'frame.rgb is the primary stream');
    looksLike(fr.rgbs.cam0, CAM0, 'cam0');
    looksLike(fr.rgbs.cam1, CAM1, 'cam1');
    assert.equal(fr.signals.objectId.u16.length, W*H);
  }
});

test('stereo file: streaming decode agrees with buffered', async () => {
  const chunks=[];
  await encodeStereo({ onChunk:c=>chunks.push(c) });
  const dec=createDecoder(undefined, { backend:BACKEND });
  for(const c of chunks) dec.push(c);
  dec.finish();
  const frames=[];
  for await (const fr of dec) frames.push(fr);
  await dec.close();
  assert.equal(frames.length, N);
  looksLike(frames[N-1].rgbs.cam0, CAM0, 'cam0 (streamed)');
  looksLike(frames[N-1].rgbs.cam1, CAM1, 'cam1 (streamed)');
});

test('decode() convenience: per-stream series plus the legacy primary series', async () => {
  const out=await decode(await encodeStereo(), { backend:BACKEND });
  assert.equal(out.rgb.length, N, 'legacy series = primary');
  assert.deepEqual(Object.keys(out.rgbs).sort(), ['cam0', 'cam1']);
  assert.equal(out.rgbs.cam1.length, N);
  assert.equal(out.rgb[0], out.rgbs.cam0[0]);
});

test('signal view hint is recorded verbatim and stays inert', async () => {
  const enc=createEncoder({ W, H, fps:30, rgbs:['cam0', 'cam1'], backend:BACKEND,
    signals:[{ id:'disparity', view:'cam0' }] });
  await enc.addFrame({ rgbs:{ cam0:CAM0, cam1:CAM1 }, signals:{ disparity:{ u16: ids(0) } } });
  const meta=normalizeMetadata(demux(await enc.finish()).metadata);
  assert.equal(meta.signals[0].view, 'cam0');
});

test('declaration and per-frame invariants', async () => {
  const mk=()=>createEncoder({ W, H, fps:30, signals:[{ id:'x' }], rgbs:['cam0', 'cam1'], backend:BACKEND });
  assert.throws(()=>createEncoder({ W, H, signals:[{ id:'x' }], rgbs:['a', 'a'] }), /duplicate rgb stream id/);
  assert.throws(()=>createEncoder({ W, H, signals:[{ id:'x' }], rgbs:['a'], hasRgb:true }), /not both/);

  const enc=mk();
  await assert.rejects(()=>enc.addFrame({ rgbs:{ cam9:CAM0 } }), /unknown rgb stream "cam9"/);

  // Named streams cannot be inferred from frame 0 — order would come from object keys.
  const inferred=createEncoder({ W, H, fps:30, signals:[{ id:'x' }], backend:BACKEND });
  await assert.rejects(()=>inferred.addFrame({ rgbs:{ cam0:CAM0 } }), /declared up front/);

  // A started stream must not gap (same rule signals already follow).
  const gap=mk();
  await gap.addFrame({ rgbs:{ cam0:CAM0, cam1:CAM1 }, signals:{ x:{ u16: ids(0) } } });
  await gap.addFrame({ rgbs:{ cam0:CAM0 }, signals:{ x:{ u16: ids(1) } } });
  await assert.rejects(()=>gap.addFrame({ rgbs:{ cam0:CAM0, cam1:CAM1 }, signals:{ x:{ u16: ids(2) } } }),
    /absent on frame 1 but present on frame 2/);

  // A declared stream that never sees a frame fails at finish, per stream.
  const empty=mk();
  await empty.addFrame({ rgbs:{ cam0:CAM0 }, signals:{ x:{ u16: ids(0) } } });
  await assert.rejects(()=>empty.finish(), /reserved rgb track "cam1"/);

  // frame.rgb is sugar for the primary stream, even under multi-RGB.
  const sugar=mk();
  await sugar.addFrame({ rgb:CAM0, rgbs:{ cam1:CAM1 }, signals:{ x:{ u16: ids(0) } } });
  await assert.rejects(()=>sugar.addFrame({ rgb:CAM0, rgbs:{ cam0:CAM0, cam1:CAM1 } }),
    /both name the primary stream/);
  const bytes=await (async()=>{ await sugar.addFrame({ rgb:CAM0, rgbs:{ cam1:CAM1 }, signals:{ x:{ u16: ids(1) } } }); return sugar.finish(); })();
  const dec=createDecoder(bytes, { backend:BACKEND });
  const fr=await dec.readFrame();
  assert.ok(fr.rgbs.cam0 && fr.rgbs.cam1, 'sugar frame carried both streams');
  await dec.close();
});

test('batch encode() with named streams requires the rgbs declaration', async () => {
  const frames=[{ rgbs:{ cam0:CAM0, cam1:CAM1 }, signals:{ x:{ u16: ids(0) } } }];
  await assert.rejects(()=>encode({ W, H, signals:[{ id:'x' }], frames }), /declare them with encode/);
  const bytes=await encode({ W, H, signals:[{ id:'x' }], frames, rgbs:['cam0', 'cam1'] });
  const meta=normalizeMetadata(demux(bytes).metadata);
  assert.deepEqual(meta.rgbs.map(r=>r.id), ['cam0', 'cam1']);
});
