// Browser verification of the per-operation WASM fallback. Serves the repo, loads the built
// bundle in a real engine under Playwright, and checks two things:
//   1. Correctness — a forced-WASM round-trip is bit-exact in the actual browser.
//   2. Granularity — across a full encode+decode, only the .wasm files an operation actually
//      falls back to are ever fetched; a decode-only run never pulls vp9-encode.wasm.
//
// Usage: node tests/browser/run.mjs [chromium|firefox|webkit]   (default: chromium)
// Requires `npm run build` (dist/) and Playwright browsers. Run from the experiments harness
// which has playwright installed, or `npx playwright install <engine>`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const PAGE = '/tests/browser/fallback.html';
const ENGINE = process.argv[2] || process.env.BROWSER || 'chromium';

if (!fs.existsSync(path.join(root, 'dist/chromapakz.js'))) {
  console.error('dist/ missing — run `npm run build` first.');
  process.exit(2);
}

let playwright;
try { playwright = await import('playwright'); }
catch { console.error('playwright not installed — `npm i -D playwright && npx playwright install`'); process.exit(2); }

const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.wasm':'application/wasm' };
const server = http.createServer((req, res) => {
  const f = path.join(root, req.url.split('?')[0]);
  fs.readFile(f, (e, data) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(0);
const port = server.address().port;

const launcher = playwright[ENGINE];
if (!launcher) { console.error(`unknown engine: ${ENGINE}`); process.exit(2); }
const browser = await launcher.launch();

function fetchedWasm(page){
  const seen = new Set();
  page.on('request', r => { const u = r.url(); const m = u.match(/(vp9-(?:encode|decode))\.wasm/); if (m) seen.add(m[1]); });
  return seen;
}

let failures = 0;
const must = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

async function load(){
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('  [pageerror]', e.message));
  const wasm = fetchedWasm(page);
  await page.goto(`http://localhost:${port}${PAGE}`);
  await page.waitForFunction('window.__ready === true', { timeout: 15000 });
  return { page, wasm };
}

console.log(`\n[${ENGINE}] forced-wasm round-trip`);
{
  const { page, wasm } = await load();
  const r = await page.evaluate(() => window.runRoundTrip({ backend: 'wasm' }));
  must(r.ok, `bit-exact (${r.frames} frames, ${r.bytes} B)`);
  must(wasm.has('vp9-encode') && wasm.has('vp9-decode'), `both wasm fetched: [${[...wasm].sort().join(', ')}]`);
  await page.close();
}

console.log(`\n[${ENGINE}] auto backend (observe per-op selection + granularity)`);
{
  const { page, wasm } = await load();
  const r = await page.evaluate(() => window.runRoundTrip({ backend: 'auto' }));
  must(r.ok, `bit-exact (${r.frames} frames)`);
  console.log(`  observed: wasm fetched under 'auto' = [${[...wasm].sort().join(', ') || 'none (fully native)'}]`);
}

await browser.close();
server.close();
console.log(`\n[${ENGINE}] ${failures ? failures + ' failure(s)' : 'all passed'}`);
process.exit(failures ? 1 : 0);
