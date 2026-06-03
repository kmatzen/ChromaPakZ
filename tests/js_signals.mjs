/** Node test: v2 metadata with multiple lossless signals. Run: node tests/js_signals.mjs */
import { mux, demux } from '../src/webm.js';
import { normalizeMetadata, buildFileMetadata, planSignals, buildTracksFromPlan } from '../src/signals.js';

let failed = 0;
function ok(c, m){ if(!c){ console.error('FAIL:', m); failed++; } }

const W=32, H=24, N=2;
const signals=planSignals([
  { id: 'depth', near: 0.3, far: 8, levels: 1024 },
  { id: 'objectId' },
], false);
const tracks=buildTracksFromPlan(W, H, false, signals);
const frames=[];
for(let i=0;i<N;i++){
  const t=i*40;
  const dep=new Uint16Array(W*H); dep.fill(100+i);
  const oid=new Uint16Array(W*H); oid.fill(2000+i);
  // fake VP9 payloads (container-only test)
  frames.push({ track:signals[0].tracks.hi, key:i===0, timeMs:t, data:new Uint8Array([1,2,3,i]) });
  frames.push({ track:signals[0].tracks.lo, key:i===0, timeMs:t, data:new Uint8Array([4,5,6,i]) });
  frames.push({ track:signals[1].tracks.hi, key:i===0, timeMs:t, data:new Uint8Array([7,8,i]) });
  frames.push({ track:signals[1].tracks.lo, key:i===0, timeMs:t, data:new Uint8Array([9,10,i]) });
}
const metadata=buildFileMetadata({ W, H, fps:30, n:N, hasRgb:false, signals });
const bytes=mux({ tracks, frames, metadata, durationMs:100 });
const d=demux(bytes);
const meta=normalizeMetadata(d.metadata);
ok(meta.version===2, 'version 2');
ok(meta.signals.length===2, 'two signals');
ok(meta.signals[0].id==='depth' && meta.signals[1].id==='objectId', 'signal ids');
ok(meta.depth?.near===0.3, 'legacy depth mirror');
ok(d.frames.length===N*4, `frame packets ${d.frames.length}`);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
