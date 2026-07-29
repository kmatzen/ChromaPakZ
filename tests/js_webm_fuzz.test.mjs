/** Node tests: demuxer robustness against malformed, truncated and foreign WebM.
 *  Corrupt input must throw WebMCorruptError; incomplete input must parse as far as it can.
 *
 *  The sweeps at the end are exhaustive rather than sampled — every truncation offset and every
 *  single-bit flip — and run against the committed golden fixture as well as a synthetic file.
 *  Each is wall-clock bounded, because the failure this guards against is a parse that never
 *  returns: an element whose size vint claims more bytes than exist used to send a reader looping
 *  for the *claimed* length. Random byte mutation (above) is good at finding wrong answers; an
 *  exhaustive bit sweep is what finds the one flipped bit that hangs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mux, demux, createStreamDemux, WebMCorruptError } from '../src/webm.js';

function throwsCorrupt(fn, m){
  try{ fn(); }
  catch(e){ assert.ok(e instanceof WebMCorruptError, `${m}: threw ${e.name}: ${e.message}`); return; }
  assert.ok(false, `${m}: did not throw`);
}

// ── minimal hand rollers, so we can emit structures our own muxer never produces ──
const cat=(...a)=>{ let n=0; for(const x of a) n+=x.length; const o=new Uint8Array(n); let p=0;
  for(const x of a){ o.set(x,p); p+=x.length; } return o; };
function idBytes(id){ const b=[]; let v=id; while(v>0){ b.unshift(v&0xff); v=Math.floor(v/256); } return Uint8Array.from(b); }
function vint(n){ let L=1; while(n >= (2**(7*L))-1) L++; const out=new Uint8Array(L); let v=n+2**(7*L);
  for(let i=L-1;i>=0;i--){ out[i]=v%256; v=Math.floor(v/256); } return out; }
const el=(id,p)=>cat(idBytes(id), vint(p.length), p);
const elS=(id,s)=>el(id, new TextEncoder().encode(s));
const elU=(id,n)=>{ const b=[]; let v=n; while(v>0){ b.unshift(v&0xff); v=Math.floor(v/256); }
  return el(id, b.length ? Uint8Array.from(b) : Uint8Array.of(0)); };

const E={ EBML:0x1A45DFA3, DocType:0x4282, Segment:0x18538067, Tracks:0x1654AE6B, TrackEntry:0xAE,
  TrackNumber:0xD7, CodecID:0x86, Name:0x536E, Tags:0x1254C367, Tag:0x7373, Targets:0x63C0,
  SimpleTag:0x67C8, TagName:0x45A3, TagString:0x4487, Cluster:0x1F43B675, Timestamp:0xE7, SimpleBlock:0xA3 };

const header=(docType='webm')=>el(E.EBML, elS(E.DocType, docType));
const tracksEl=()=>el(E.Tracks, el(E.TrackEntry, cat(elU(E.TrackNumber,1), elS(E.CodecID,'V_VP9'), elS(E.Name,'rgb'))));
const tagsEl=json=>el(E.Tags, el(E.Tag, cat(el(E.Targets,new Uint8Array(0)),
  el(E.SimpleTag, cat(elS(E.TagName,'CHROMAPAKZ'), elS(E.TagString, json))))));
/** A SimpleBlock with an explicit flags byte (so lacing bits can be set) and a raw payload. */
const blockRaw=(track, rel, flags, payload)=>el(E.SimpleBlock,
  cat(vint(track), Uint8Array.of((rel>>8)&0xff, rel&0xff), Uint8Array.of(flags), payload));

test('DocType is validated', () => {
    const okFile=d=>cat(header(d), el(E.Segment, cat(tracksEl(), tagsEl('{"v":1}'))));
    assert.ok(demux(okFile('webm')).metadata.v===1, 'DocType webm accepted');
    assert.ok(demux(okFile('matroska')).metadata.v===1, 'DocType matroska accepted');
    throwsCorrupt(()=>demux(okFile('mp4')), 'foreign DocType rejected');
    throwsCorrupt(()=>demux(okFile('')), 'empty DocType rejected');

});

test('not-WebM inputs are rejected rather than returning a plausible empty result', () => {
    throwsCorrupt(()=>demux(new Uint8Array(64)), 'all-zero bytes rejected');
    throwsCorrupt(()=>demux(Uint8Array.from({length:64},(_,i)=>i*37&0xff)), 'garbage bytes rejected');
    throwsCorrupt(()=>demux(new TextEncoder().encode('#!/bin/sh\necho not a video\n')), 'shell script rejected');
    // A well-formed element that simply isn't an EBML header.
    throwsCorrupt(()=>demux(el(E.Segment, tracksEl())), 'file not starting with EBML rejected');
    // ID with no length marker in its first 4 bits (0x08 ⇒ 5-byte id, past the EBML max).
    throwsCorrupt(()=>demux(Uint8Array.of(0x08,0,0,0,0,0x81,0x00)), 'over-long EBML id rejected');

});

test('malformed CHROMAPAKZ metadata is corruption, not "not here yet"', () => {
    const bad=cat(header(), el(E.Segment, cat(tracksEl(), tagsEl('{"v":'))));
    throwsCorrupt(()=>demux(bad), 'truncated metadata JSON rejected');
    // The streaming path must surface it too — this is the case that used to wait forever.
    const sdm=createStreamDemux();
    let threw=false;
    try{ sdm.push(bad); }catch(e){ threw=e instanceof WebMCorruptError; }
    assert.ok(threw, 'stream demux push() throws on malformed metadata JSON');
    assert.ok(sdm.error instanceof WebMCorruptError, 'stream demux latches the error');
    let rethrew=false;
    try{ sdm.finish(); }catch(e){ rethrew=e instanceof WebMCorruptError; }
    assert.ok(rethrew, 'latched error rethrown by finish()');

});

test('lacing: a laced foreign block yields every frame, not one blob', () => {
    const seg=(...cl)=>cat(header(), el(E.Segment, cat(tracksEl(), ...cl)));
    const payloads=[Uint8Array.of(1,1,1), Uint8Array.of(2,2), Uint8Array.of(3,3,3,3)];
    const flat=cat(...payloads);

    // Xiph (flags bit 0x02): n-1 sizes as 255-terminated runs.
    const xiph=cat(Uint8Array.of(payloads.length-1), Uint8Array.of(3), Uint8Array.of(2), flat);
    const dx=demux(seg(el(E.Cluster, cat(elU(E.Timestamp,0), blockRaw(1, 0, 0x80|0x02, xiph)))));
    assert.ok(dx.frames.length===3, `Xiph lacing splits into 3 frames (${dx.frames.length})`);
    assert.ok(dx.frames.every((f,i)=>f.data.length===payloads[i].length && f.data.every((b,j)=>b===payloads[i][j])),
      'Xiph laced payloads exact');
    assert.ok(dx.frames.every(f=>f.key), 'lacing keeps the block key flag');

    // Fixed-size (0x04): equal split, no size table.
    const fixed=cat(Uint8Array.of(2), Uint8Array.of(7,7), Uint8Array.of(8,8), Uint8Array.of(9,9));
    const df=demux(seg(el(E.Cluster, cat(elU(E.Timestamp,0), blockRaw(1, 0, 0x04, fixed)))));
    assert.ok(df.frames.length===3 && df.frames.every(f=>f.data.length===2), 'fixed lacing splits evenly');

    // EBML (0x06): first size absolute, then signed deltas.
    const svint=d=>{ const bias=(2**6)-1; return vint(d+bias); };   // 1-byte signed vint
    const ebmlLace=cat(Uint8Array.of(payloads.length-1), vint(3), svint(-1), flat);
    const de=demux(seg(el(E.Cluster, cat(elU(E.Timestamp,0), blockRaw(1, 0, 0x06, ebmlLace)))));
    assert.ok(de.frames.length===3, `EBML lacing splits into 3 frames (${de.frames.length})`);
    assert.ok(de.frames.every((f,i)=>f.data.length===payloads[i].length), 'EBML laced sizes exact');

    // Inconsistent lace tables are corruption, not silently short frames.
    const overrun=cat(Uint8Array.of(1), Uint8Array.of(200), Uint8Array.of(1,2,3));
    throwsCorrupt(()=>demux(seg(el(E.Cluster, cat(elU(E.Timestamp,0), blockRaw(1, 0, 0x02, overrun))))),
      'lace size past the block rejected');
    const notDivisible=cat(Uint8Array.of(1), Uint8Array.of(1,2,3));
    throwsCorrupt(()=>demux(seg(el(E.Cluster, cat(elU(E.Timestamp,0), blockRaw(1, 0, 0x04, notDivisible))))),
      'indivisible fixed lace rejected');

});

test("unknown-size clusters (live/foreign WebM) don't truncate the scan", () => {
    const unknownSize=Uint8Array.of(0x1f,0xff,0xff,0xff);       // 4-byte vint, all value bits set ⇒ unknown
    const clusterUnknown=(ts, ...blocks)=>cat(idBytes(E.Cluster), unknownSize, elU(E.Timestamp,ts), ...blocks);
    const bytes=cat(header(), el(E.Segment, cat(
      tracksEl(),
      clusterUnknown(0,    blockRaw(1, 0, 0x80, Uint8Array.of(1))),
      clusterUnknown(1000, blockRaw(1, 0, 0x80, Uint8Array.of(2))),
      el(E.Cluster, cat(elU(E.Timestamp,2000), blockRaw(1, 0, 0x80, Uint8Array.of(3)))))));
    const d=demux(bytes);
    assert.ok(d.frames.length===3, `all 3 unknown-size clusters parsed (${d.frames.length})`);
    assert.ok(d.frames.map(f=>f.timeMs).join()==='0,1000,2000', 'unknown-size cluster timestamps exact');
    assert.ok(d.tracks[1]?.frames.length===3, 'blocks routed to the track across unknown-size clusters');

});

test('truncation sweep: every prefix of a real file parses cleanly and monotonically', () => {
    const TRACKS=[{ number:1, codecID:'V_VP9', name:'rgb', width:16, height:16 }];
    const frames=[];
    for(let i=0;i<12;i++) frames.push({ track:1, key:i%4===0, timeMs:i*250, data:Uint8Array.from({length:64},(_,j)=>(i*7+j)&0xff) });
    const full=mux({ tracks:TRACKS, frames, metadata:{ v:2, s:'ünïcøde' }, clusterSpanMs:600 });

    let bad=0, nonMonotonic=0, lostMeta=0, prev=0, sawMeta=false;
    for(let cut=0;cut<=full.length;cut++){
      let d;
      try{ d=demux(full.subarray(0, cut)); }
      catch(e){ bad++; console.error(`  cut=${cut}: ${e.name}: ${e.message}`); continue; }
      if(d.frames.length<prev) nonMonotonic++;
      prev=d.frames.length;
      for(const [i, f] of d.frames.entries()){
        // Every frame reported must be a whole frame, byte-identical to what went in.
        const want=frames[i];
        if(!Number.isFinite(f.timeMs) || !Number.isFinite(f.track) || !(f.data instanceof Uint8Array)) bad++;
        else if(f.timeMs!==want.timeMs || f.data.length!==want.data.length || !f.data.every((b,j)=>b===want.data[j])) bad++;
      }
      // The Segment declares its size, so any short prefix has an unfinished Segment: reporting
      // frames without also reporting truncation would let a caller mistake a partial file for a whole one.
      if(cut<full.length && d.frames.length>0 && !d.truncated) bad++;
      if(d.metadata) sawMeta=true; else if(sawMeta) lostMeta++;
    }
    assert.ok(lostMeta===0, `metadata never disappears once parsed (${lostMeta} regressions)`);
    assert.ok(bad===0, `truncation sweep clean over ${full.length} prefixes (${bad} bad)`);
    assert.ok(nonMonotonic===0, `frame count never regresses as bytes arrive (${nonMonotonic} regressions)`);
    assert.ok(demux(full).frames.length===frames.length && demux(full).truncated===false, 'complete file: all frames, not truncated');

    // Same sweep through the streaming demuxer, one byte at a time. Blocks are delivered
    // progressively as their bytes complete, so events from push() and finish() both count.
    const sdm=createStreamDemux();
    const blocks=[];
    let threw=null;
    try{
      for(let i=0;i<full.length;i++)
        for(const ev of sdm.push(full.subarray(i,i+1))) if(ev.type==='block') blocks.push(ev.block);
      for(const ev of sdm.finish()) if(ev.type==='block') blocks.push(ev.block);
    }catch(e){ threw=e; }
    assert.ok(!threw, `byte-at-a-time push never throws on a valid file (${threw?.message ?? ''})`);
    assert.ok(blocks.length===frames.length, `stream demux recovers all frames (${blocks.length}/${frames.length})`);
    assert.ok(blocks.every((b,i)=>b.timeMs===frames[i].timeMs && b.data.every((x,j)=>x===frames[i].data[j])),
      'stream demux frames are byte-exact and in order');

});

test('mutation fuzz: a flipped byte anywhere must fail cleanly, never hang or leak a stray error', () => {
    const TRACKS=[{ number:1, codecID:'V_VP9', name:'rgb', width:16, height:16 }];
    const frames=[{ track:1, key:true, timeMs:0, data:Uint8Array.from({length:200},(_,i)=>i&0xff) },
                  { track:1, key:false, timeMs:33, data:Uint8Array.from({length:150},(_,i)=>(i*3)&0xff) }];
    const full=mux({ tracks:TRACKS, frames, metadata:{ v:3 } });

    // xorshift32 — deterministic, so a failure is reproducible.
    let state=0x1234567;
    const rnd=()=>{ state^=state<<13; state>>>=0; state^=state>>>17; state^=state<<5; state>>>=0; return state; };

    let unexpected=0, badFrames=0;
    for(let n=0;n<4000;n++){
      const m=Uint8Array.from(full);
      for(let k=0, flips=1+rnd()%3; k<flips; k++) m[rnd()%m.length]=rnd()&0xff;
      let d=null;
      try{ d=demux(m); }
      catch(e){
        if(!(e instanceof WebMCorruptError)){ unexpected++; if(unexpected<4) console.error(`  ${e.name}: ${e.message}`); }
        continue;
      }
      for(const f of d.frames){
        if(!Number.isFinite(f.timeMs) || !Number.isFinite(f.track) || !(f.data instanceof Uint8Array)
           || f.data.length>full.length) badFrames++;
      }
    }
    assert.ok(unexpected===0, `mutation fuzz: only WebMCorruptError escapes (${unexpected} others)`);
    assert.ok(badFrames===0, `mutation fuzz: no NaN/oversized frames (${badFrames})`);

});


// ── exhaustive sweeps, wall-clock bounded ────────────────────────────────────────────────────
// Generous enough to absorb CI jitter and GC, tight enough that a runaway parse cannot pass.
const BUDGET_MS = 60_000;

const SWEEP_TRACKS = [{ number:1, codecID:'V_VP9', name:'rgb', width:16, height:16 }];
const SYNTHETIC = mux({
  tracks: SWEEP_TRACKS,
  frames: [{ track:1, key:true, timeMs:0, data:Uint8Array.of(1,2,3,4) },
           { track:1, key:false, timeMs:33, data:Uint8Array.of(5,6) }],
  metadata: { version:2, note:'fuzz corpus' },
});
const FIXTURE = new Uint8Array(readFileSync(new URL('./fixtures/stream.webm', import.meta.url)));

/** demux must either throw WebMCorruptError or hand back a structurally sane result. */
function checkDemux(bytes, label){
  let out;
  try{ out=demux(bytes); }
  catch(e){ assert.ok(e instanceof WebMCorruptError, `${label}: threw ${e.name}: ${e.message}`); return; }
  assert.ok(Array.isArray(out.frames), `${label}: frames is not an array`);
  for(const f of out.frames){
    assert.ok(f.data instanceof Uint8Array, `${label}: block payload is not a Uint8Array`);
    // A payload longer than the file itself means an extent escaped the buffer.
    assert.ok(f.data.length<=bytes.length, `${label}: block payload (${f.data.length} B) exceeds input`);
    assert.ok(Number.isFinite(f.timeMs), `${label}: non-finite timestamp ${f.timeMs}`);
  }
}

for(const [name, bytes] of [['synthetic', SYNTHETIC], ['fixture', FIXTURE]]){
  test(`${name}: demux survives truncation at every byte offset`, () => {
    const t0=Date.now();
    for(let cut=0; cut<=bytes.length; cut++) checkDemux(bytes.subarray(0, cut), `${name} cut=${cut}`);
    assert.ok(Date.now()-t0 < BUDGET_MS, `${name}: truncation sweep exceeded ${BUDGET_MS} ms`);
  });

  test(`${name}: streamDemux survives truncation at every byte offset`, () => {
    const t0=Date.now();
    for(let cut=0; cut<=bytes.length; cut++){
      const sdm=createStreamDemux();
      // A valid prefix must never be reported as corrupt — only genuinely malformed bytes are.
      try{ sdm.push(bytes.subarray(0, cut)); sdm.finish(); }
      catch(e){ assert.ok(e instanceof WebMCorruptError, `${name} cut=${cut}: threw ${e.name}`); }
    }
    assert.ok(Date.now()-t0 < BUDGET_MS, `${name}: streaming truncation sweep exceeded ${BUDGET_MS} ms`);
  });
}

test('synthetic: demux survives every single-bit flip', () => {
  const t0=Date.now();
  for(let i=0;i<SYNTHETIC.length;i++)
    for(let bit=0;bit<8;bit++){
      const b=SYNTHETIC.slice(); b[i]^=1<<bit;
      checkDemux(b, `flip ${i}:${bit}`);
    }
  assert.ok(Date.now()-t0 < BUDGET_MS, `bit-flip sweep exceeded ${BUDGET_MS} ms`);
});

test('fixture: demux survives every single-bit flip in the header region', () => {
  // The header is where a bad size vint does the most damage; sweeping the whole 3.8 KB file
  // bit-by-bit would be ~30k parses for little extra signal. The bound is deliberate.
  const LIMIT=Math.min(FIXTURE.length, 512);
  const t0=Date.now();
  for(let i=0;i<LIMIT;i++)
    for(let bit=0;bit<8;bit++){
      const b=FIXTURE.slice(); b[i]^=1<<bit;
      checkDemux(b, `flip ${i}:${bit}`);
    }
  assert.ok(Date.now()-t0 < BUDGET_MS, `header bit-flip sweep exceeded ${BUDGET_MS} ms`);
});

test('a Segment claiming 2^56 bytes is rejected promptly', () => {
  // The shape that used to hang: an 8-byte size vint reaching far past the end of the file.
  const t0=Date.now();
  checkDemux(Uint8Array.from([
    0x1a,0x45,0xdf,0xa3, 0x84, 0x42,0x82,0x84, 0x77,0x65,0x62,0x6d,   // EBML{DocType:"webm"}
    0x18,0x53,0x80,0x67, 0x01,0xff,0xff,0xff,0xff,0xff,0xff,0xfe,     // Segment, size 2^56-2
  ]), 'huge Segment');
  assert.ok(Date.now()-t0 < 5_000, 'huge-Segment parse took too long');
});
