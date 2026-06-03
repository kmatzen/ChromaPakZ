// Drive the probe headlessly and print a table. Usage: node run.mjs [size]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');             // repo root, so ../../src/ resolves
const pagePath = '/experiments/webcodecs-lossless/headless.html';
const MODE = process.argv[2] || 'single';            // single | streaming | network | multisignal | …
const SIZE = Number(process.argv[3] || 256);
const N = Number(process.argv[4] || 30);
const TYPES = { '.html':'text/html', '.js':'text/javascript' };

const server = http.createServer((req, res) => {
  const f = path.join(root, req.url === '/' ? pagePath : req.url.split('?')[0]);
  fs.readFile(f, (e, data) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(0);
const port = server.address().port;

// Engine selection: BROWSER=chromium|firefox|webkit (default chromium).
const ENGINES = { chromium, firefox, webkit };
const ENGINE = process.env.BROWSER || 'chromium';
const launcher = ENGINES[ENGINE] || chromium;
const browser = await launcher.launch(
  ENGINE === 'chromium' ? { args: ['--disable-gpu', '--use-gl=disabled'] } : {});
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.error('  [page error]', m.text()); });
page.on('pageerror', e => console.error('  [pageerror]', e.message));

await page.goto(`http://localhost:${port}${pagePath}`);
await page.waitForFunction('window.__ready === true', { timeout: 10000 });

const bpp = (b, px) => (b * 8 / px).toFixed(3);
const verdict = r => r.lossless ? 'EXACT ✓' : `LOSSY ✗ (max Δ=${r.dMax})`;
console.log(`\nengine: ${ENGINE} ${browser.version()}`);

if (MODE === 'caps') {
  const c = await page.evaluate(() => window.__caps()).catch(e => ({ error: String(e) }));
  if (c.error) { await browser.close(); server.close(); console.error('FATAL:', c.error); process.exit(1); }
  console.log(`  VideoEncoder=${c.hasEncoder}  VideoDecoder=${c.hasDecoder}  secureContext=${c.secure}`);
  console.log('  config support (encode):');
  for (const [k, v] of Object.entries(c.codecs || {})) console.log(`    ${k.padEnd(18)} ${v}`);
} else if (MODE === 'rd') {
  const out = await page.evaluate(([w,h,n]) => window.__rdSweep(w,h,n), [SIZE, SIZE, N]).catch(e => ({ error: String(e) }));
  if (out.error) { await browser.close(); server.close(); console.error('FATAL:', out.error); process.exit(1); }
  console.log(`\nVP9 encode/decode on ${out.W}×${out.H}×${out.N} quantized depth (peak 65535):`);
  console.log('  QP    bpp      PSNR(dB)');
  for (const r of out.rows)
    console.log(`  ${String(r.qp).padStart(2)}   ${r.bpp.toFixed(3).padStart(7)}   ${r.exact ? '∞ (lossless)' : r.psnr.toFixed(1)}`);
  console.log('RDJSON ' + JSON.stringify(out));   // consumed by python/plot_rd.py
} else if (MODE === 'decfmt') {
  const webmB64 = fs.readFileSync(process.argv[3]).toString('base64');
  const info = await page.evaluate(b => window.__decodeFormatProbe(b), webmB64).catch(e => ({ error: String(e) }));
  console.log('  decoded-frame format:', JSON.stringify(info));
} else if (MODE === 'single') {
  const out = await page.evaluate(([w, h]) => window.__runProbe(w, h), [SIZE, SIZE]).catch(e => ({ error: String(e) }));
  if (out.error) { await browser.close(); server.close(); console.error('FATAL:', out.error); process.exit(1); }
  console.log(`\nUA: ${out.ua}\nsecureContext: ${out.secure}   size: ${out.width}×${out.height}\n`);
  console.log('codec            scheme          lossless              hi bpp   lo bpp   total bpp   vs byte-split');
  console.log('─'.repeat(96));
  const base = {};
  for (const r of out.rows) {
    if (r.error) { console.log(`${r.codec.padEnd(16)} ${String(r.scheme).padEnd(15)} ${r.error}`); continue; }
    if (r.scheme === 'byte-split') base[r.codec] = r.totalBytes;
    const rel = base[r.codec] ? (r.totalBytes / base[r.codec] - 1) * 100 : 0;
    const relStr = r.scheme === 'byte-split' ? '—' : (rel > 0 ? '+' : '') + rel.toFixed(1) + '%';
    console.log(`${r.codec.padEnd(16)} ${r.scheme.padEnd(15)} ${verdict(r).padEnd(20)} ` +
      `${bpp(r.hiBytes, r.px).padStart(6)}   ${bpp(r.loBytes, r.px).padStart(6)}   ` +
      `${bpp(r.totalBytes, r.px).padStart(9)}   ${relStr}`);
  }
} else if (MODE === 'gop') {
  const out = await page.evaluate(([w, h, n]) => window.__runProbeGOP(w, h, n), [SIZE, SIZE, N]).catch(e => ({ error: String(e) }));
  if (out.error) { await browser.close(); server.close(); console.error('FATAL:', out.error); process.exit(1); }
  console.log(`\nGOP probe · ${out.codec} · triangle-fold · ${out.width}×${out.height} × ${out.N} frames (bpp = per pixel per frame)\n`);
  console.log('mode                  lossless              hi bpp   lo bpp   total bpp   vs intra');
  console.log('─'.repeat(86));
  let base = null;
  for (const r of out.rows) {
    if (r.mode.startsWith('intra')) base = r.totalBytes;
    const rel = base ? (r.totalBytes / base - 1) * 100 : 0;
    const relStr = r.mode.startsWith('intra') ? '—' : (rel > 0 ? '+' : '') + rel.toFixed(1) + '%';
    console.log(`${r.mode.padEnd(21)} ${verdict(r).padEnd(20)} ` +
      `${bpp(r.hiBytes, r.px).padStart(6)}   ${bpp(r.loBytes, r.px).padStart(6)}   ` +
      `${bpp(r.totalBytes, r.px).padStart(9)}   ${relStr}`);
  }
} else if (MODE === 'split') {
  const out = await page.evaluate(([w, h, n]) => window.__runProbe10GOP(w, h, n), [SIZE, SIZE, N]).catch(e => ({ error: String(e) }));
  if (out.error) { await browser.close(); server.close(); console.error('FATAL:', out.error); process.exit(1); }
  console.log(`\nSplit probe · inter-coded · ${out.width}×${out.height} × ${out.N} frames (bpp = per pixel per frame)\n`);
  console.log('split                    lossless              hi bpp   lo bpp   total bpp   vs 8+8');
  console.log('─'.repeat(88));
  let base = null;
  for (const r of out.rows) {
    if (r.split.startsWith('8+8')) base = r.totalBytes;
    const rel = base ? (r.totalBytes / base - 1) * 100 : 0;
    const relStr = r.split.startsWith('8+8') ? '—' : (rel > 0 ? '+' : '') + rel.toFixed(1) + '%';
    console.log(`${r.split.padEnd(24)} ${verdict(r).padEnd(20)} ` +
      `${bpp(r.hiBytes, r.px).padStart(6)}   ${bpp(r.loBytes, r.px).padStart(6)}   ` +
      `${bpp(r.totalBytes, r.px).padStart(9)}   ${relStr}`);
  }
} else if (MODE === 'streaming') {
  const out = await page.evaluate(([w, h, n]) => window.__runStreamingWebM(w, h, n), [SIZE, SIZE, N])
    .catch(e => ({ error: String(e) }));
  if (out.error) { await browser.close(); server.close(); console.error('FATAL:', out.error); process.exit(1); }
  console.log(`\nStreaming API round-trip · ${SIZE}×${SIZE} × ${N} frames\n`);
  console.log(`  createEncoder→createDecoder depth bit-exact: ${out.exact ? 'YES ✓' : 'NO ✗ (max Δ=' + out.dMax + ')'}`);
  console.log(`  batch encode(signals+frames) bit-exact: ${out.batchExact ? 'YES ✓' : 'NO ✗'}`);
  console.log(`  createEncoder without signals throws: ${out.throwsMissing ? 'YES ✓' : 'NO ✗'}`);
  console.log(`  metadata signals: ${out.signalCount}`);
  console.log(`  near/far metadata: ${out.near.toFixed(3)}–${out.far.toFixed(3)}`);
  if (!out.exact || !out.batchExact || !out.throwsMissing) process.exitCode = 1;
} else if (MODE === 'multisignal') {
  const out = await page.evaluate(([w, h, n]) => window.__runMultiSignalWebM(w, h, n), [SIZE, SIZE, N])
    .catch(e => ({ error: String(e) }));
  if (out.error) { await browser.close(); server.close(); console.error('FATAL:', out.error); process.exit(1); }
  console.log(`\nMulti-signal WebM · ${SIZE}×${SIZE} × ${N}\n`);
  console.log(`  depth bit-exact: ${out.exactDepth ? 'YES ✓' : 'NO ✗'}`);
  console.log(`  objectId bit-exact: ${out.exactOid ? 'YES ✓' : 'NO ✗'}`);
  if (!out.exactDepth || !out.exactOid) process.exitCode = 1;
} else if (MODE === 'network') {
  const out = await page.evaluate(([w, h, n]) => window.__runNetworkWebM(w, h, n), [SIZE, SIZE, N])
    .catch(e => ({ error: String(e) }));
  if (out.error) { await browser.close(); server.close(); console.error('FATAL:', out.error); process.exit(1); }
  console.log(`\nNetwork byte streaming · ${SIZE}×${SIZE} × ${N} frames\n`);
  console.log(`  onChunk segments: ${out.chunks}`);
  console.log(`  chunked push decode (batch file) bit-exact: ${out.exact ? 'YES ✓' : 'NO ✗ (max Δ=' + out.dMax + ')'}`);
  console.log(`  onChunk encode bit-exact: ${out.streamExact ? 'YES ✓' : 'NO ✗'}`);
  if (!out.exact || !out.streamExact) process.exitCode = 1;
} else if (MODE === 'webm') {
  const out = await page.evaluate(([w, h, n]) => window.__runWebM(w, h, n), [SIZE, SIZE, N]).catch(e => ({ error: String(e) }));
  if (out.error) { await browser.close(); server.close(); console.error('FATAL:', out.error); process.exit(1); }
  console.log(`\nFull WebM round-trip · ${out.W}×${out.H} × ${out.N} frames\n`);
  console.log(`  depth bit-exact through container: ${out.exact ? 'YES ✓' : 'NO ✗ (max Δ=' + out.dMax + ')'}`);
  console.log(`  RGB frames decoded: ${out.rgbDecoded}`);
  console.log(`  total file: ${(out.totalBytes/1024).toFixed(1)} KiB  (${(out.totalBytes*8/(out.W*out.H*out.N)).toFixed(3)} bpp all-in)`);
  console.log('\n  track  name        codec   dims        frames    bytes      bpp');
  console.log('  ' + '─'.repeat(64));
  for (const t of out.trackInfo)
    console.log(`  ${String(t.n).padEnd(6)} ${(t.name||'').padEnd(11)} ${t.codec.padEnd(7)} ` +
      `${(t.w+'×'+t.h).padEnd(11)} ${String(t.frames).padStart(4)}   ${String(t.bytes).padStart(8)}   ` +
      `${(t.bytes*8/(out.W*out.H*out.N)).toFixed(3)}`);
  console.log(`\n  metadata signals: ${JSON.stringify(out.metadata.signals?.map(s=>s.id))}`);
  const [b64, depthB64] = await page.evaluate(() => [window.__lastWebM, window.__lastDepth]);
  fs.writeFileSync(path.join(dir, 'sample.webm'), Buffer.from(b64, 'base64'));
  fs.writeFileSync(path.join(dir, 'sample.u16'), Buffer.from(depthB64, 'base64'));
  console.log(`\n  wrote sample.webm + sample.u16 (raw input depth) for cross-impl checks`);
} else if (MODE === 'jsdecode') {
  // node run.mjs jsdecode <file.webm> [ref.u16]  — decode in-browser, optionally verify vs reference
  const webmB64 = fs.readFileSync(process.argv[3]).toString('base64');
  const refB64 = process.argv[4] ? fs.readFileSync(process.argv[4]).toString('base64') : null;
  const out = await page.evaluate(([w, r]) => window.__decodeWebMCompare(w, r), [webmB64, refB64]).catch(e => ({ error: String(e) }));
  if (out.error) { await browser.close(); server.close(); console.error('FATAL:', out.error); process.exit(1); }
  console.log(`\nBrowser decode of ${path.basename(process.argv[3])}: ${out.width}×${out.height} × ${out.N} frames, RGB=${out.rgbFrames}, levels=${out.levels}`);
  if (refB64) console.log(`  depth bit-exact vs reference: ${out.exact ? 'YES ✓' : 'NO ✗ (max Δ=' + out.dMax + ')'}`);
  if (out.sampleFloats) console.log(`  SAMPLEFLOATS ${JSON.stringify({ idx: out.idx, vals: out.sampleFloats })}`);
} else if (MODE === 'highdepth') {
  const out = await page.evaluate(([w, h]) => window.__probeHighDepth(w, h), [SIZE, SIZE]).catch(e => ({ error: String(e) }));
  if (out.error) { await browser.close(); server.close(); console.error('FATAL:', out.error); process.exit(1); }
  console.log('\nHigh-bit-depth capability (encode, quantizer mode):');
  for (const c of out.cfg) console.log(`  ${c.codec.padEnd(16)} supported=${c.supported}${c.err ? '  err=' + c.err : ''}`);
  console.log('\n10/12-bit input VideoFrame construction:');
  for (const f of out.fmtTries) console.log(`  ${f.format.padEnd(10)} ok=${f.ok}${f.err ? '  ' + f.err : ''}`);
}
await browser.close();
server.close();
console.log('');
