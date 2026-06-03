// Does a browser preserve 16-bit PNG precision through the canvas/getImageData path?
// Loads a 16-bit PNG with 65536 distinct values, draws to canvas, reads it back, counts
// surviving distinct values. Run: node png16-test.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PAGE = `<!doctype html><meta charset=utf-8><script>
window.__run = async () => {
  const img = new Image(); img.src = '/_png16.png'; await img.decode();
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d', { colorSpace: 'srgb' });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;   // Uint8ClampedArray
  const distinct = new Set(); let max = 0;
  for (let i = 0; i < d.length; i += 4) { distinct.add(d[i]); if (d[i] > max) max = d[i]; }
  return { type: d.constructor.name, bitsPerChannel: 8, distinctR: distinct.size, maxR: max,
           sourceDistinct: 65536 };
};</script>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/_png16.png')) {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(fs.readFileSync(path.join(dir, '_png16.png'))); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({ args: ['--disable-gpu'] });
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/`);
const r = await page.evaluate(() => window.__run());
await browser.close(); server.close();

console.log('\n16-bit PNG through canvas getImageData:');
console.log(`  readback buffer type : ${r.type} (${r.bitsPerChannel}-bit/channel)`);
console.log(`  source distinct vals : ${r.sourceDistinct}`);
console.log(`  surviving distinct   : ${r.distinctR}`);
console.log(`  max value recovered  : ${r.maxR}`);
console.log(`  verdict: ${r.distinctR <= 256 ? '16-bit depth is LOST — canvas truncates to 8-bit ✗' : 'preserved ✓'}`);
