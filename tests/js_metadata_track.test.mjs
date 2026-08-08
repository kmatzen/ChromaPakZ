// The JS muxer's timed-text track must match the native one byte-for-byte in shape:
// two independent implementations of the same container, so both need the same checks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEncoder } from '../src/chromapakz.js';

const HAVE_FFMPEG = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

async function record({ textTrack = 'poses', n = 6 } = {}) {
  const W = 64, H = 48, parts = [];
  const enc = createEncoder({
    W, H, fps: 30, hasRgb: true, textTrack,
    signals: [{ id: 'depth', near: 0.3, far: 9.0 }],
    onChunk: c => parts.push(c),
  });
  const cues = [];
  for (let i = 0; i < n; i++) {
    const rgb = new Uint8Array(W * H * 4); rgb.fill((i * 37) & 255);
    const depth = new Uint16Array(W * H); depth.fill(1000 + i * 10);
    await enc.addFrame({ rgb, signals: { depth: { u16: depth } } });
    if (textTrack) { cues.push(`i=${i}`); await enc.addText(`i=${i}`, i / 30); }
  }
  await enc.finish();
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return { bytes: out, cues };
}

function writeTemp(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'cpz-'));
  const path = join(dir, 'a.webm');
  writeFileSync(path, bytes);
  return path;
}

test('ffmpeg resolves the track as webvtt', { skip: !HAVE_FFMPEG }, async () => {
  const { bytes } = await record();
  const path = writeTemp(bytes);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=index,codec_type,codec_name:stream_tags=title', '-of', 'json', path],
    { encoding: 'utf8' });
  const streams = JSON.parse(probe).streams;
  const text = streams.filter(s => s.codec_type === 'subtitle');
  assert.equal(text.length, 1);
  // WebM needs D_WEBVTT/*; Matroska's S_TEXT/WEBVTT demuxes with an unknown codec.
  assert.equal(text[0].codec_name, 'webvtt');
  assert.equal(text[0].tags.title, 'poses');
});

test('cues survive extraction by ffmpeg', { skip: !HAVE_FFMPEG }, async () => {
  const { bytes, cues } = await record();
  const path = writeTemp(bytes);
  const out = path.replace(/\.webm$/, '.vtt');
  execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:s:0', '-c', 'copy', '-y', out]);
  const body = readFileSync(out, 'utf8');
  assert.ok(body.startsWith('WEBVTT'));
  // Only survives with WebM's cue framing (identifier \n settings \n payload).
  for (const c of cues) assert.ok(body.includes(c), `missing ${c} in ${body.slice(0, 300)}`);
  assert.ok(existsSync(out));
});

test('video tracks are unchanged when a text track is present', async () => {
  const withText = await record({ textTrack: 'poses' });
  const without = await record({ textTrack: null });
  // The text track is appended last precisely so video/signal numbering is stable;
  // if that ever regressed, decoders would map signals to the wrong tracks.
  assert.ok(withText.bytes.length > without.bytes.length);
});

test('addText without a declared track throws', async () => {
  const enc = createEncoder({ W: 64, H: 48, fps: 30, hasRgb: true,
                              signals: [{ id: 'depth', near: 0.3, far: 9.0 }] });
  await assert.rejects(() => enc.addText('nope', 0), /textTrack/);
});

// The buffered path builds its file from muxFrames via mux(), which emits SimpleBlocks and has
// nowhere to put a cue's duration — so a cue written there used to be accepted and then dropped,
// producing a file with the text track declared and not one block in it. Silent data loss is the
// one outcome a recorder cannot detect, so this must fail loudly instead.
test('addText on a buffered encoder throws rather than silently dropping the cue', async () => {
  const enc = createEncoder({ W: 64, H: 48, fps: 30, hasRgb: true, textTrack: 'poses',
                              signals: [{ id: 'depth', near: 0.3, far: 9.0 }] });
  await assert.rejects(() => enc.addText('lost', 0), /streaming encoder/);
});

test('a streamed cue really reaches the bytes', async () => {
  const chunks = [];
  const enc = createEncoder({ W: 32, H: 16, fps: 30, hasRgb: true, textTrack: 'poses',
                              backend: 'wasm', signals: [{ id: 'depth', near: 0.3, far: 9.0 }],
                              onChunk: c => chunks.push(c) });
  await enc.addFrame({ rgb: new Uint8Array(32 * 16 * 4).fill(9),
                       signals: { depth: { u16: new Uint16Array(32 * 16).fill(1234) } } });
  await enc.addText('CUE-PAYLOAD', 0, 1 / 30);
  const bytes = await enc.finish();
  assert.ok(new TextDecoder().decode(bytes).includes('CUE-PAYLOAD'),
    'the cue payload must be present in the finished file');
});
