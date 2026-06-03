// Headless smoke test for demo/index.html: generate → encode → decode → assert bit-exact.
// Run from this dir (where playwright resolves): node smoke-demo.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const f = path.join(root, req.url === '/' ? '/demo/index.html' : req.url.split('?')[0]);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(d); });
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({ args: ['--disable-gpu', '--use-gl=disabled'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('[pageerror]', e.message));
await page.goto(`http://localhost:${port}/demo/index.html`);
await page.waitForFunction('window.__demoReady === true', { timeout: 10000 });

// shrink to 12 frames for speed
await page.evaluate(() => { const r = document.querySelector('#frames'); r.value = 12; r.dispatchEvent(new Event('input')); });

await page.click('#gen');
await page.click('#encode');
await page.waitForFunction('!document.querySelector("#decode").disabled', { timeout: 30000 });
await page.click('#decode');
await page.waitForFunction('/bit-exact|Δ=/.test(document.querySelector("#sVerify").textContent)', { timeout: 30000 });

const r = await page.evaluate(() => ({
  verify: document.querySelector('#sVerify').textContent.trim(),
  size: document.querySelector('#sSize').textContent.trim(),
  bpp: document.querySelector('#sBpp').textContent.trim(),
  enc: document.querySelector('#sEnc').textContent.trim(),
  dec: document.querySelector('#sDec').textContent.trim(),
  rows: [...document.querySelectorAll('#trackTable tbody tr')].map(t => t.textContent.replace(/\s+/g, ' ').trim()),
}));
await page.locator('#viewerCard').screenshot({ path: path.join(root, 'demo', 'preview.png') });
await browser.close(); server.close();

console.log('\ndemo smoke test:');
console.log('  integrity:', r.verify);
console.log(`  size ${r.size} · ${r.bpp} · encode ${r.enc} · decode ${r.dec}`);
r.rows.forEach(x => console.log('  track:', x));
console.log('  screenshot → demo/preview.png');
process.exit(/bit-exact/.test(r.verify) ? 0 : 1);
