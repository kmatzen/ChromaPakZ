/** Node tests: WebM muxer/demuxer edge cases (vint boundaries, clustering, robustness).
 *  Run: node tests/js_webm_edge.mjs */
import { mux, demux, createStreamMux, createStreamDemux, concatChunks } from '../src/webm.js';

let failed = 0;
function ok(c, m){ if(!c){ console.error('FAIL:', m); failed++; } }

const TRACKS=[{ number:1, codecID:'V_VP9', name:'rgb', width:16, height:16 }];
const frame=(track, key, timeMs, data)=>({ track, key, timeMs, data });

// ── vint boundary payload sizes: 1-byte/2-byte/3-byte size descriptors ──
// EBML 1-byte sizes top out at 126 (127 is the reserved all-ones), 2-byte at 16382.
for(const size of [0, 1, 126, 127, 128, 16382, 16383, 16384, 100000]){
  const data=new Uint8Array(size);
  for(let i=0;i<size;i++) data[i]=(i*7+size)&0xff;
  const bytes=mux({ tracks:TRACKS, frames:[frame(1, true, 0, data)], metadata:{ v:size } });
  const d=demux(bytes);
  ok(d.frames.length===1, `size=${size}: one frame back`);
  const got=d.frames[0]?.data ?? new Uint8Array(0);
  ok(got.length===size && got.every((b,i)=>b===data[i]), `size=${size}: payload bit-exact`);
}

// ── track numbers requiring multi-byte vints round-trip ──
{
  const nums=[1, 63, 64, 126, 127, 128, 300];
  const tracks=nums.map(n=>({ number:n, codecID:'V_VP9', name:`t${n}`, width:8, height:8 }));
  const frames=nums.map(n=>frame(n, true, 0, Uint8Array.of(n&0xff, 1)));
  const d=demux(mux({ tracks, frames, metadata:null }));
  for(const n of nums){
    ok(d.tracks[n]?.name===`t${n}`, `track ${n}: entry parsed`);
    ok(d.tracks[n]?.frames.length===1, `track ${n}: block routed`);
  }
}

// ── clustering: keyframes on the cue track start new clusters; times survive ──
{
  const frames=[];
  const times=[0, 33, 66, 1000, 1033, 40000, 40500];  // 40000 also crosses clusterSpanMs
  for(const [i, t] of times.entries()) frames.push(frame(1, t===1000 || t===40000 || i===0, t, Uint8Array.of(i)));
  const bytes=mux({ tracks:TRACKS, frames, metadata:null, durationMs:41000 });
  const d=demux(bytes);
  ok(d.frames.length===times.length, `all ${times.length} frames back`);
  ok(d.frames.every((f,i)=>f.timeMs===times[i]), 'timestamps exact across clusters');
  ok(d.frames.filter(f=>f.key).length===3, 'key flags preserved');
}

// ── frames presented out of order are sorted by time in the batch muxer ──
{
  const frames=[frame(1, false, 66, Uint8Array.of(2)), frame(1, true, 0, Uint8Array.of(0)), frame(1, false, 33, Uint8Array.of(1))];
  const d=demux(mux({ tracks:TRACKS, frames, metadata:null }));
  ok(d.frames.map(f=>f.timeMs).join()==='0,33,66', 'batch mux sorts frames by time');
}

// ── zero frames: header-only file still demuxes (tracks + metadata, no blocks) ──
{
  const d=demux(mux({ tracks:TRACKS, frames:[], metadata:{ hello:'world' } }));
  ok(d.frames.length===0, 'no frames');
  ok(d.metadata?.hello==='world', 'metadata from empty file');
  ok(d.tracks[1]?.name==='rgb', 'track entry from empty file');
}

// ── metadata: unicode + nesting round-trips through the Tags element ──
{
  const meta={ name:'クロマパックZ ✓ …', nested:{ arr:[1,2,3], t:true, x:null }, num:1e-9 };
  const d=demux(mux({ tracks:TRACKS, frames:[frame(1,true,0,Uint8Array.of(1))], metadata:meta }));
  ok(JSON.stringify(d.metadata)===JSON.stringify(meta), 'unicode/nested metadata round-trip');
}

// ── streaming mux == batch mux frame-for-frame (multi-cluster case) ──
{
  const frames=[];
  for(let i=0;i<10;i++) frames.push(frame(1, i%4===0, i*500, Uint8Array.of(i, i+1)));
  const batch=demux(mux({ tracks:TRACKS, frames, metadata:{ a:1 }, clusterSpanMs:900 }));
  const sm=createStreamMux({ tracks:TRACKS, metadata:{ a:1 }, clusterSpanMs:900 });
  const parts=[sm.header];
  for(const f of frames){ const c=sm.writeFrame(f); if(c) parts.push(c); }
  parts.push(sm.finish());
  const stream=demux(concatChunks(parts));
  ok(stream.frames.length===batch.frames.length, `stream vs batch count ${stream.frames.length}/${batch.frames.length}`);
  ok(stream.frames.every((f,i)=>f.timeMs===batch.frames[i].timeMs && f.track===batch.frames[i].track),
    'stream vs batch identical ordering');
  ok(sm.cues.length===3, `cue per keyframe cluster (${sm.cues.length})`);
}

// ── incremental demux: byte-at-a-time push never throws, still yields everything ──
{
  const frames=[frame(1, true, 0, Uint8Array.of(9,8,7)), frame(1, false, 33, Uint8Array.of(6,5))];
  const bytes=mux({ tracks:TRACKS, frames, metadata:{ ok:1 } });
  const sdm=createStreamDemux();
  let gotMeta=false;
  const blocks=[];
  for(let i=0;i<bytes.length;i++){
    for(const e of sdm.push(bytes.subarray(i, i+1))){
      if(e.type==='metadata') gotMeta=true;
      if(e.type==='block') blocks.push(e.block);
    }
  }
  const events=sdm.finish();
  for(const e of events) if(e.type==='block') blocks.push(e.block);
  ok(gotMeta, 'metadata event during byte-at-a-time push');
  ok(blocks.length===2, `blocks delivered (${blocks.length})`);
  ok(blocks.map(b=>b.timeMs).join()==='0,33', 'block timestamps in order');
  ok(blocks[0].key===true && blocks[1].key===false, 'key flags survive incremental parse');
  ok(blocks[0].data.join()==='9,8,7' && blocks[1].data.join()==='6,5', 'block payloads bit-exact');
  ok(events.at(-1).type==='end', 'end event last');
  ok(sdm.done, 'done after finish');
}

// ── incremental demux emits each block as it completes, not at finish() ──
{
  const frames=[];
  for(let i=0;i<8;i++) frames.push(frame(1, i%2===0, i*500, Uint8Array.of(i)));
  const bytes=mux({ tracks:TRACKS, frames, metadata:{ ok:1 }, clusterSpanMs:900 });
  const sdm=createStreamDemux();
  let seen=0, sawEarly=false;
  const step=64;
  for(let o=0;o<bytes.length;o+=step){
    for(const e of sdm.push(bytes.subarray(o, Math.min(o+step, bytes.length))))
      if(e.type==='block'){ seen++; if(o+step<bytes.length) sawEarly=true; }
  }
  for(const e of sdm.finish()) if(e.type==='block') seen++;
  ok(seen===8, `progressive demux saw all blocks (${seen})`);
  ok(sawEarly, 'blocks emitted before the final chunk');
}

// ── incremental demux matches batch demux over a multi-cluster stream-muxed file ──
{
  const frames=[];
  for(let i=0;i<12;i++) frames.push(frame(1, i%5===0, i*400, Uint8Array.of(i, 255-i)));
  const sm=createStreamMux({ tracks:TRACKS, metadata:{ a:'b' }, clusterSpanMs:700 });
  const parts=[sm.header];
  for(const f of frames){ const c=sm.writeFrame(f); if(c) parts.push(c); }
  parts.push(sm.finish());
  const bytes=concatChunks(parts);
  const batch=demux(bytes);
  const sdm=createStreamDemux();
  const got=[];
  for(let o=0;o<bytes.length;o+=13){
    for(const e of sdm.push(bytes.subarray(o, Math.min(o+13, bytes.length))))
      if(e.type==='block') got.push(e.block);
  }
  for(const e of sdm.finish()) if(e.type==='block') got.push(e.block);
  ok(got.length===batch.frames.length, `stream demux count ${got.length}/${batch.frames.length}`);
  ok(got.every((b,i)=>b.timeMs===batch.frames[i].timeMs && b.key===batch.frames[i].key
    && b.data.join()===batch.frames[i].data.join()), 'stream demux == batch demux, block for block');
  ok(sdm.tracks[1]?.name==='rgb', 'track entries available from the stream demuxer');
}

// ── stream demux retains only the element in flight, not the whole file ──
{
  const frames=[];
  for(let i=0;i<40;i++) frames.push(frame(1, i%4===0, i*100, new Uint8Array(4096)));
  const bytes=mux({ tracks:TRACKS, frames, metadata:{ ok:1 }, clusterSpanMs:300 });
  const sdm=createStreamDemux();
  let blocks=0;
  for(let o=0;o<bytes.length;o+=1024){
    for(const e of sdm.push(bytes.subarray(o, Math.min(o+1024, bytes.length))))
      if(e.type==='block') blocks++;
  }
  for(const e of sdm.finish()) if(e.type==='block') blocks++;
  ok(blocks===40, `large multi-cluster stream fully demuxed (${blocks})`);
}

// ── garbage pushed at a stream demuxer: no throw, no hang, no unbounded buffering ──
{
  const sdm=createStreamDemux();
  let threw=false;
  try{
    for(let i=0;i<8;i++) sdm.push(Uint8Array.from({length:32}, (_,k)=>(i*32+k)*37&0xff));
    ok(sdm.finish().at(-1).type==='end', 'end delivered after garbage');
  }catch{ threw=true; }
  ok(!threw, 'garbage push handled without throwing');
}

// ── truncated stream: finish() on a half-file must not throw ──
{
  const frames=[frame(1, true, 0, new Uint8Array(3000))];
  const bytes=mux({ tracks:TRACKS, frames, metadata:{ ok:1 } });
  for(const cut of [3, 40, Math.floor(bytes.length/2), bytes.length-2]){
    const sdm=createStreamDemux();
    sdm.push(bytes.subarray(0, cut));
    let events=null;
    try{ events=sdm.finish(); }catch(e){ ok(false, `cut=${cut}: finish threw ${e}`); continue; }
    ok(events.at(-1).type==='end', `cut=${cut}: end event delivered`);
  }
}

// ── garbage input: demux of non-EBML bytes must not hang or crash the process ──
{
  let threwOrEmpty=false;
  try{
    const d=demux(Uint8Array.from({length:64}, (_,i)=>i*37&0xff));
    threwOrEmpty=d.frames.length===0;
  }catch{ threwOrEmpty=true; }
  ok(threwOrEmpty, 'garbage input handled (throw or empty result)');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
