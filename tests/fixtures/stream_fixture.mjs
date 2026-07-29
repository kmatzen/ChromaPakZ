/** Single source of truth for the streaming-interop golden fixture.
 *
 *  Both the regenerator (regen_stream.mjs) and the staleness tripwire
 *  (tests/js_fixture_stream.test.mjs) import this, so the committed stream.webm /
 *  stream_depth.u16 can never silently drift away from the values they are supposed to hold.
 *  tests/test_stream_interop.py consumes the same fixture from the native side. */

export const W = 40, H = 24, N = 5;

/** The exact uint16 field each frame carries — deterministic, no RNG. */
export function makeSequence() {
  const seq = [];
  for (let f = 0; f < N; f++) {
    const u = new Uint16Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++)
      u[r * W + c] = (c * 131 + r * 517 + f * 7919) & 0xffff;
    seq.push(u);
  }
  return seq;
}

/** The sequence flattened exactly as stream_depth.u16 stores it (little-endian uint16). */
export function flatSequence() {
  const seq = makeSequence();
  const flat = new Uint16Array(N * W * H);
  let o = 0;
  for (const u of seq) { flat.set(u, o); o += u.length; }
  return flat;
}
