/** HDR10 container signalling in the JS muxer (issue #51).
 *
 *  The browser encoder itself stays SDR — HDR encode is the native path's job, and browsers
 *  play the result in <video> — but the JS muxer must write the same Colour element the C
 *  muxer does, the demuxer must parse it back, and the decoder must survive HDR files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mux, demux } from '../src/webm.js';
import { createEncoder } from '../src/chromapakz.js';
import { normalizeMetadata } from '../src/signals.js';

const COLOUR = {
  matrix: 9, bits: 10, range: 1, transfer: 16, primaries: 9,
  maxCLL: 1000, maxFALL: 400,
  mastering: { rx: 0.708, ry: 0.292, gx: 0.170, gy: 0.797, bx: 0.131, by: 0.046,
               wx: 0.3127, wy: 0.3290, maxLum: 1000, minLum: 0.005 },
};

test('Colour element round-trips through mux → demux', () => {
  const bytes = mux({ tracks: [{ number: 1, codecID: 'V_VP9', name: 'rgb', width: 32, height: 24, colour: COLOUR }],
    frames: [], metadata: null, durationMs: 0 });
  const { tracks } = demux(bytes);
  assert.deepEqual(tracks[1].colour, COLOUR);
});

test('optional fields are omitted, not written as zero', () => {
  const bytes = mux({ tracks: [{ number: 1, codecID: 'V_VP9', name: 'rgb', width: 32, height: 24,
    colour: { matrix: 9, bits: 10, range: 1, transfer: 18, primaries: 9 } }],
    frames: [], metadata: null, durationMs: 0 });
  const c = demux(bytes).tracks[1].colour;
  assert.equal(c.transfer, 18);
  assert.ok(!('maxCLL' in c) && !('maxFALL' in c) && !('mastering' in c));
});

test('a track without colour writes no Colour element', () => {
  const bytes = mux({ tracks: [{ number: 1, codecID: 'V_VP9', name: 'rgb', width: 32, height: 24 }],
    frames: [], metadata: null, durationMs: 0 });
  assert.equal(demux(bytes).tracks[1].colour, undefined);
});

test('the browser encoder refuses hdr rather than writing 8-bit data under an HDR label', () => {
  assert.throws(() => createEncoder({ W: 32, H: 24, signals: [{ id: 'd' }], hasRgb: true, hdr: { transfer: 'pq' } }),
    /not supported by the browser encoder/);
});

test('normalizeMetadata carries the hdr entry through for readers', () => {
  const meta = normalizeMetadata({
    version: 3, width: 32, height: 24,
    rgb: { track: 1, codec: 'vp09.02.10.10.01.09.16.09' },
    rgbs: [{ id: 'rgb', track: 1, codec: 'vp09.02.10.10.01.09.16.09', hdr: { bits: 10, transfer: 'pq' } }],
    signals: [{ id: 'd', tracks: { hi: 2, lo: 3 }, quant: null }],
  });
  assert.equal(meta.rgbs[0].hdr.transfer, 'pq');
  const sdr = normalizeMetadata({ version: 2, width: 32, height: 24,
    rgb: { track: 1 }, signals: [{ id: 'd', tracks: { hi: 2, lo: 3 }, quant: null }] });
  assert.ok(!('hdr' in sdr.rgbs[0]), 'SDR entries carry no hdr key');
});
