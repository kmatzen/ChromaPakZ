/** Node tests: signal planning, metadata normalization, and frame-slot assembly.
 *  Run: node tests/js_signals_plan.mjs */
import {
  planSignals,
  normalizeMetadata,
  buildFileMetadata,
  buildTracksFromPlan,
  u16FromFramePayload,
  materializeSignal,
  blocksByTime,
  slotKeysForMetadata,
  isSlotComplete,
  collectFrameInputs,
} from '../src/signals.js';

let failed = 0;
function ok(c, m){ if(!c){ console.error('FAIL:', m); failed++; } }
function throws(fn, re, m){
  try{ fn(); ok(false, `${m}: expected throw`); }
  catch(e){ ok(re.test(String(e)), `${m}: message "${e}"`); }
}

// ── planSignals: validation ──
throws(()=>planSignals([], true), /at least one/, 'empty specs');
throws(()=>planSignals(null, true), /at least one/, 'null specs');
throws(()=>planSignals([{}], true), /needs an id/, 'spec without id');
throws(()=>planSignals([{ id:'x', scheme:'delta-16' }], true), /unsupported scheme/, 'unknown scheme');
throws(()=>planSignals([{ id:'depth', near:0.5 }], true), /near and far/, 'near without far');
throws(()=>planSignals([{ id:'depth', near:0, far:5 }], true), /0 < near < far/, 'near=0');
throws(()=>planSignals([{ id:'depth', near:5, far:5 }], true), /0 < near < far/, 'far==near');
throws(()=>planSignals([{ id:'depth', near:-1, far:5 }], true), /0 < near < far/, 'negative near');

// ── planSignals: track numbering with and without RGB ──
{
  const withRgb=planSignals([{ id:'depth', near:0.3, far:9 }, { id:'objectId' }], true);
  ok(withRgb[0].tracks.hi===2 && withRgb[0].tracks.lo===3, 'rgb: first signal on tracks 2/3');
  ok(withRgb[1].tracks.hi===4 && withRgb[1].tracks.lo===5, 'rgb: second signal on tracks 4/5');
  const noRgb=planSignals([{ id:'a' }, { id:'b' }], false);
  ok(noRgb[0].tracks.hi===1 && noRgb[1].tracks.hi===3, 'no rgb: signals start at track 1');
  ok(withRgb[0].trackNames.hi==='signal-depth-hi' && withRgb[0].trackNames.lo==='signal-depth-lo', 'track names');
  ok(withRgb[1].quant===null, 'raw signal has null quant');
  ok(withRgb[0].quant.levels===65536, 'default levels');
  ok(withRgb.every(s=>s.lossless===true && s.dtype==='uint16'), 'lossless uint16 defaults');
}

// ── planSignals: `name` alias and explicit quant object ──
{
  const s=planSignals([{ name:'ids' }], false);
  ok(s[0].id==='ids', 'name accepted as id alias');
  const q=planSignals([{ id:'d', quant:{ type:'inverse-depth', near:1, far:4, levels:512 } }], false);
  ok(q[0].quant.near===1 && q[0].quant.far===4 && q[0].quant.levels===512, 'explicit quant object honored');
}

// ── buildTracksFromPlan mirrors the plan ──
{
  const plan=planSignals([{ id:'depth', near:0.3, far:9 }], true);
  const tracks=buildTracksFromPlan(64, 48, true, plan);
  ok(tracks.length===3, 'rgb + hi + lo');
  ok(tracks[0].number===1 && tracks[0].name==='rgb', 'rgb is track 1');
  ok(tracks.every(t=>t.width===64 && t.height===48 && t.codecID==='V_VP9'), 'per-track geometry/codec');
}

// ── buildFileMetadata: batch vs streaming ──
{
  const plan=planSignals([{ id:'depth', near:0.3, far:9 }], true);
  const batch=buildFileMetadata({ W:64, H:48, fps:30, n:7, hasRgb:true, signals:plan });
  ok(batch.version===2 && batch.frames===7 && batch.streaming===undefined, 'batch metadata');
  ok(batch.rgb?.track===1, 'rgb track recorded');
  const stream=buildFileMetadata({ W:64, H:48, fps:30, n:0, hasRgb:false, signals:plan, streaming:true });
  ok(stream.frames===null && stream.streaming===true && stream.rgb===null, 'streaming metadata');
  // metadata must survive JSON (that is how it is stored in the container)
  const rt=normalizeMetadata(JSON.parse(JSON.stringify(batch)));
  ok(rt.signals[0].quant.near===0.3, 'metadata JSON round-trip');
}

// ── normalizeMetadata: quant spelling variants ──
{
  const base={ version:2, width:8, height:8, signals:[{ id:'d', tracks:{ hi:1, lo:2 },
    quant:{ near:0.5, far:5 } }] };  // quant object without explicit type
  ok(normalizeMetadata(base).signals[0].quant.type==='inverse-depth', 'near in quant implies inverse-depth');
  const legacy={ version:2, width:8, height:8, signals:[{ id:'d', tracks:{ hi:1, lo:2 },
    quant:'inverse-depth', near:0.5, far:5, levels:256 }] };  // string form with flat fields
  const nl=normalizeMetadata(legacy).signals[0];
  ok(nl.quant.type==='inverse-depth' && nl.quant.near===0.5 && nl.quant.levels===256, 'string quant promoted');
  const raw={ version:2, width:8, height:8, signals:[{ id:'ids', tracks:{ hi:1, lo:2 }, quant:null }] };
  ok(normalizeMetadata(raw).signals[0].quant===null, 'null quant preserved');
  throws(()=>normalizeMetadata(null), /missing/, 'null metadata');
  throws(()=>normalizeMetadata({ version:2 }), /signals/, 'missing signals[]');
}

// ── u16FromFramePayload / materializeSignal ──
{
  const rawSig={ id:'ids', quant:null };
  const depthSig={ id:'depth', quant:{ type:'inverse-depth', near:0.5, far:5, levels:65536 } };
  ok(u16FromFramePayload(null, rawSig)===null, 'null payload -> null');
  const u=new Uint16Array([1,2,3]);
  ok(u16FromFramePayload({ u16:u }, rawSig)===u, 'u16 passthrough (no copy)');
  const f=new Float32Array([1.0, 2.0, 0]);
  const q=u16FromFramePayload({ float:f }, depthSig);
  ok(q instanceof Uint16Array && q[2]===0 && q[0]>q[1], 'float quantized via signal quant');
  throws(()=>u16FromFramePayload({ float:f }, rawSig), /inverse-depth/, 'float on raw signal');
  throws(()=>u16FromFramePayload({}, rawSig), /u16.*float|float/, 'empty payload');

  const m=materializeSignal(q, depthSig);
  ok(m.u16===q && m.float instanceof Float32Array, 'materialize adds float for quantized signal');
  ok(Number.isNaN(m.float[2]) && Math.abs(m.float[0]-1.0)<1e-3, 'dequantized values sane');
  ok(materializeSignal(u, rawSig).float===undefined, 'raw signal stays u16-only');
}

// ── blocksByTime / slot completeness ──
{
  const meta={ version:2, width:8, height:8, rgb:{ track:1 },
    signals:[{ id:'d', tracks:{ hi:2, lo:3 }, quant:null }] };
  const fr=(t)=>({ timeMs:t });
  const tracks={
    1:{ frames:[fr(0), fr(33)] },
    2:{ frames:[fr(33), fr(0)] },   // out of order on purpose
    3:{ frames:[fr(0), fr(33)] },
  };
  const slots=blocksByTime(tracks, meta);
  ok(slots.length===2 && slots[0].timeMs===0 && slots[1].timeMs===33, 'slots sorted by time');
  const keys=slotKeysForMetadata(meta);
  ok(keys.rgb===true && keys.d===true, 'slot keys include rgb + signal');
  ok(isSlotComplete(slots[0], keys) && isSlotComplete(slots[1], keys), 'complete slots');
  ok(!isSlotComplete({ timeMs:66, rgb:fr(66), 'd:hi':fr(66) }, keys), 'missing lo -> incomplete');
  ok(!isSlotComplete({ timeMs:66, 'd:hi':fr(66), 'd:lo':fr(66) }, keys), 'missing rgb -> incomplete');
  const noRgbKeys=slotKeysForMetadata({ version:2, signals:[{ id:'d', tracks:{ hi:1, lo:2 } }] });
  ok(isSlotComplete({ 'd:hi':fr(0), 'd:lo':fr(0) }, noRgbKeys), 'no-rgb file: signal pair suffices');
}

// ── collectFrameInputs ──
{
  const plan=planSignals([{ id:'a' }, { id:'b' }], false);
  ok(JSON.stringify(collectFrameInputs({}, plan))==='{}', 'no signals key -> empty');
  const got=collectFrameInputs({ signals:{ a:{ u16:new Uint16Array(1) }, zz:{ u16:new Uint16Array(1) } } }, plan);
  ok(got.a!==null && got.b===null && !('zz' in got), 'known ids kept, unknown dropped, missing null');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
