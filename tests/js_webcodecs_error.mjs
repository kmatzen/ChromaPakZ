/** Node tests: the WebCodecs encoder's failure and buffering behaviour, against stub codecs.
 *  A codec error must reject the pending push(), and an encoder that buffers frames (lag > 0)
 *  must not strand it — both used to hang forever.
 *  Run: node tests/js_webcodecs_error.mjs */
import { readFileSync } from 'node:fs';
import { encoderConfig } from '../src/backend/codec-config.js';

let failed = 0;
function ok(c, m){ if(!c){ console.error('FAIL:', m); failed++; } }
// A promise that escapes unawaited is exactly the failure mode being fixed.
process.on('unhandledRejection', e=>{ console.error('FAIL: unhandled rejection:', e); process.exit(1); });

// ── stub WebCodecs ──
// 'immediate' emits a chunk per encode() (what Chrome does today), 'lag' emits only when drained,
// 'error' reports an async codec failure — the three cases createTrackEncoder has to survive.
let MODE='immediate';
const configs=[], supportedQueries=[];

class FakeVideoFrame{
  constructor(data, init){ this.data=data; this.timestamp=init.timestamp; this.closed=false; }
  close(){ this.closed=true; }
}
class FakeVideoEncoder{
  constructor({ output, error }){ this.output=output; this.onerror=error; this.state='unconfigured'; this.buf=[]; }
  configure(cfg){ configs.push(cfg); this.state='configured'; }
  encode(frame, opts){
    if(MODE==='error'){ queueMicrotask(()=>this.onerror(new Error('stub codec exploded'))); return; }
    this.buf.push({ timestamp:frame.timestamp, key:!!opts.keyFrame });
    if(MODE==='immediate') this.drain();
  }
  drain(){
    while(this.buf.length){
      const f=this.buf.shift();
      this.output({ type:f.key?'key':'delta', timestamp:f.timestamp, byteLength:3, copyTo:d=>d.set([1,2,3]) });
    }
  }
  async flush(){ this.drain(); }
  close(){ this.state='closed'; }
  static async isConfigSupported(cfg){ supportedQueries.push(cfg); return { supported:true, config:cfg }; }
}
class FakeVideoDecoder{
  constructor({ output, error }){ this.output=output; this.onerror=error; this.state='unconfigured'; }
  configure(){ this.state='configured'; } decode(){} async flush(){} close(){ this.state='closed'; }
}
globalThis.VideoFrame=FakeVideoFrame;
globalThis.VideoEncoder=FakeVideoEncoder;
globalThis.VideoDecoder=FakeVideoDecoder;
globalThis.EncodedVideoChunk=class{ constructor(o){ Object.assign(this,o); } };

const { createTrackEncoder }=await import('../src/backend/webcodecs.js');
const W=16, H=16, FPS=30;
const plane=()=>new Uint8Array(W*H);

// A push() that hangs is the bug under test, so every await gets a deadline.
function withTimeout(p, ms, label){
  return Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej(new Error(`timeout: ${label}`)), ms))]);
}

// ── happy path: one chunk per frame ──
{
  MODE='immediate';
  const enc=createTrackEncoder({ kind:'luma', lossless:true, W, H, fps:FPS });
  let c=null, thrown=null;
  try{ c=await withTimeout(enc.push(plane()), 2000, 'immediate push'); }catch(e){ thrown=e; }
  ok(!thrown, `immediate encoder: push resolves (${thrown?.message ?? ''})`);
  ok(c?.key===true && c?.data?.length===3, 'immediate encoder: chunk shape');
  ok((await enc.close()).length===0, 'immediate encoder: nothing left at close');
}

// ── lag > 0: the encoder holds frames back; push() must still resolve ──
{
  MODE='lag';
  const enc=createTrackEncoder({ kind:'luma', lossless:true, W, H, fps:FPS });
  let c=null, thrown=null;
  try{ c=await withTimeout(enc.push(plane()), 2000, 'lagging push'); }catch(e){ thrown=e; }
  ok(!thrown, `lagging encoder: push resolves instead of hanging (${thrown?.message ?? ''})`);
  ok(c?.data?.length===3, 'lagging encoder: chunk delivered');
  let second=null;
  try{ second=await withTimeout(enc.push(plane()), 2000, 'lagging push 2'); }catch(e){ thrown=e; }
  ok(!thrown && second, `lagging encoder: subsequent push resolves (${thrown?.message ?? ''})`);
  await enc.close();
}

// ── codec error: push() rejects rather than raising an unhandled exception into the void ──
{
  MODE='error';
  const enc=createTrackEncoder({ kind:'luma', lossless:true, W, H, fps:FPS });
  let thrown=null;
  try{ await withTimeout(enc.push(plane()), 2000, 'failing push'); }catch(e){ thrown=e; }
  ok(thrown && thrown.message==='stub codec exploded', `failing encoder: push rejects with the codec error (${thrown?.message})`);

  let again=null;
  try{ await enc.push(plane()); }catch(e){ again=e; }
  ok(again && again.message==='stub codec exploded', 'failing encoder: later push()es report the same error');

  let onClose=null;
  try{ await enc.close(); }catch(e){ onClose=e; }
  ok(onClose && onClose.message==='stub codec exploded', 'failing encoder: close() reports the error too');
}

// ── probe/production config parity ──
{
  MODE='immediate';
  configs.length=0; supportedQueries.length=0;
  const enc=createTrackEncoder({ kind:'luma', lossless:true, W, H, fps:FPS });
  await enc.push(plane()); await enc.close();
  const want=encoderConfig({ lossless:true, W, H, fps:FPS });
  ok(JSON.stringify(configs[0])===JSON.stringify(want), `production lossless config is the shared one (${JSON.stringify(configs[0])})`);

  const { probeEncode, _resetProbes }=await import('../src/backend/probe.js');
  _resetProbes();
  ok(await probeEncode({ lossless:false })===true, 'lossy probe runs against the stub');
  const probed=supportedQueries.at(-1);
  const prodLossy=encoderConfig({ lossless:false, W:probed.width, H:probed.height, fps:probed.framerate, bitrate:probed.bitrate });
  ok(JSON.stringify(probed)===JSON.stringify(prodLossy), `probe asks about the production config (${JSON.stringify(probed)})`);

  // Guard the fix rather than just its current output: the codec settings must live in one file,
  // or probe and production will drift apart again.
  for(const f of ['src/backend/probe.js','src/backend/webcodecs.js']){
    const src=readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    ok(!/vp09\.|bitrateMode|latencyMode/.test(src), `${f} carries no inline codec settings`);
  }
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
