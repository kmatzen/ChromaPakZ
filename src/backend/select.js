// Backend selection. Picks the native WebCodecs backend when a runtime probe confirms it's
// trustworthy for the operation, otherwise lazy-imports the matching WASM module. The
// dynamic import()s are the code-split points: a bundler emits ./wasm/encode.js and
// ./wasm/decode.js as separate chunks pulling their own .wasm, so a decode-only session
// never downloads the (heavier) encode artifact, and vice-versa.
import * as webcodecs from './webcodecs.js';
import { probeEncode, probeDecode } from './probe.js';

// `force`: 'auto' (default — probe), 'webcodecs', or 'wasm'. Used by tests/power users.
export async function pickEncoderBackend({ lossless=true, force='auto' }={}){
  if(force==='webcodecs') return webcodecs;
  if(force==='wasm') return import('./wasm/encode.js');
  return (await probeEncode({ lossless })) ? webcodecs : import('./wasm/encode.js');
}

export async function pickDecoderBackend({ force='auto' }={}){
  if(force==='webcodecs') return webcodecs;
  if(force==='wasm') return import('./wasm/decode.js');
  return (await probeDecode()) ? webcodecs : import('./wasm/decode.js');
}
