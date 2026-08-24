// Type declarations for the chromapakz browser/Node library (src/chromapakz.js).
// Mirrors docs/API.md; see that file for the narrative version of everything typed here.

/** Inverse-depth quantization range, applied to a signal's `float` payload. */
export interface InverseDepthQuant {
  type: 'inverse-depth';
  near: number;
  far: number;
  levels?: number;
}

/** One signal track declared to `createEncoder`/`encode`. */
export interface SignalSpec {
  /** Track id, e.g. 'depth' or 'objectId'. */
  id: string;
  /** Inverse-depth range; presence implies quant:{type:'inverse-depth',...}. */
  near?: number;
  far?: number;
  levels?: number;
  quant?: InverseDepthQuant | null;
  /** Id of the RGB stream whose camera frame this signal lives in (recorded verbatim, never interpreted). */
  view?: string | null;
  /** Per-signal geometry (format v4): give both, or neither for the encoder's W/H. */
  width?: number;
  height?: number;
}

/** One RGB stream declared to `createEncoder`'s `rgbs`. A bare string is sugar for `{ id }`. */
export type RgbSpec = string | {
  id: string;
  kbps?: number | null;
  width?: number;
  height?: number;
};

/** The `float`/`u16` payload for one signal on one frame. */
export interface SignalPayload {
  u16?: Uint16Array;
  float?: Float32Array | number[];
}

/** One frame handed to `addFrame()` / carried in `encode()`'s `frames[]`. */
export interface EncodeFrame {
  /** RGBA, W*H*4 bytes — sugar for the primary (first-declared) RGB stream. */
  rgb?: Uint8Array | Uint8ClampedArray | null;
  /** Named RGB streams (stereo / multi-camera), keyed by stream id. */
  rgbs?: Record<string, Uint8Array | Uint8ClampedArray | null | undefined>;
  signals?: Record<string, SignalPayload | null | undefined>;
}

export interface HdrMastering {
  rx: number; ry: number; gx: number; gy: number; bx: number; by: number;
  wx: number; wy: number;
  luminanceMax: number; luminanceMin: number;
}

/** HDR10/HLG display-track description. Encoder-side only; write, not read. */
export interface HdrMeta {
  /** WebM TransferCharacteristics: 16 = PQ (HDR10), 18 = HLG. */
  transfer: 16 | 18;
  maxCll?: number;
  maxFall?: number;
  mastering?: HdrMastering;
}

export interface CreateEncoderOptions {
  W: number;
  H: number;
  fps?: number;
  /** Signal tracks (depth, object IDs, normals, …); at least one is required. */
  signals: SignalSpec[];
  /** Bits per second for the (single, default-id) RGB track; per-stream via `rgbs[].kbps`. */
  rgbKbps?: number;
  /** Called with each WebM chunk as it becomes final — network/streaming mode. Omit to buffer. */
  onChunk?: ((chunk: Uint8Array) => void) | null;
  backend?: 'auto' | 'webcodecs' | 'wasm';
  /** Reserve a single default RGB track up front. Mutually exclusive with `rgbs`. */
  hasRgb?: boolean | null;
  /** Declare multiple/named RGB streams up front. Mutually exclusive with `hasRgb`. */
  rgbs?: RgbSpec[] | null;
  /** Name of an optional WebVTT metadata track; use with `addText()`. Streaming (`onChunk`) only. */
  textTrack?: string | null;
  /** HDR10/HLG display track description. Not supported by this (browser) encoder. */
  hdr?: HdrMeta | null;
  /**
   * Encode every track with the REALTIME deadline at the fastest speed step (the profile the
   * live-capture streaming encoders use) instead of the default GOOD_QUALITY archival profile.
   * Signal tracks stay bit-exact either way; an RGB track loses picture quality at a given
   * bitrate — raise `rgbKbps` to compensate. Default false. See docs/API.md.
   */
  realtime?: boolean;
}

export interface DepthQuant {
  near: number;
  far: number;
}

export interface Encoder {
  readonly signalPlan: unknown[];
  readonly near: number | undefined;
  readonly far: number | undefined;
  readonly frameCount: number;
  /** Must be called before the first addFrame(); only valid when a 'depth' signal was declared. */
  setNearFar(near: number, far: number): void;
  addFrame(frame: EncodeFrame): Promise<void>;
  /** Append a timed-text cue (seconds). Streaming (`onChunk`) encoders only. */
  addText(text: string, timestamp: number, duration?: number | null): Promise<Uint8Array>;
  /** Buffered mode: resolves the whole file. Streaming mode: resolves the tail bytes. */
  finish(): Promise<Uint8Array>;
}

export function createEncoder(options: CreateEncoderOptions): Encoder;

export interface EncodeOptions {
  W: number;
  H: number;
  fps?: number;
  signals: SignalSpec[];
  frames: EncodeFrame[];
  rgbKbps?: number;
  rgbs?: RgbSpec[] | null;
  onChunk?: ((chunk: Uint8Array) => void) | null;
  /** See CreateEncoderOptions.realtime. */
  realtime?: boolean;
}

/** Batch helper: encode every frame in one call. Requires explicit `signals` and `frames`. */
export function encode(options: EncodeOptions): Promise<Uint8Array>;

export interface DecodedSignal {
  u16: Uint16Array;
  /** Present only for signals with inverse-depth quant. */
  float?: Float32Array;
}

export interface DecodedFrame {
  /** RGBA, W*H*4 bytes — the primary RGB stream, or null if this frame carries none. */
  rgb: Uint8Array | null;
  rgbs: Record<string, Uint8Array>;
  signals: Record<string, DecodedSignal>;
}

/** Metadata as read back from a file/stream (see docs/FORMAT.md for the raw JSON shape). */
export interface Metadata {
  version: number;
  width: number;
  height: number;
  fps: number;
  frames: number | null;
  streaming?: boolean;
  rgbs: Array<{ id: string; track: number; codec: string; width?: number; height?: number; hdr?: unknown }>;
  signals: Array<{
    id: string;
    tracks: { hi: number; lo: number };
    codec: string;
    lossless: boolean;
    scheme: string;
    dtype: string;
    invalidCode: number;
    quant: InverseDepthQuant | null;
    view?: string | null;
    width?: number;
    height?: number;
  }>;
  [key: string]: unknown;
}

export interface Decoder extends AsyncIterable<DecodedFrame> {
  readonly metadata: Metadata | null;
  readonly signals: Metadata['signals'];
  readonly width: number;
  readonly height: number;
  readonly near: number | undefined;
  readonly far: number | undefined;
  readonly levels: number;
  readonly frameCount: number;
  readFrame(): Promise<DecodedFrame | null>;
  close(): Promise<void>;
  /** Network decoder only: feed bytes as they arrive. */
  push(chunk: Uint8Array): void;
  /** Network decoder only: signal no more bytes are coming. */
  finish(): void;
}

export interface CreateDecoderOptions {
  backend?: 'auto' | 'webcodecs' | 'wasm';
}

/** `bytes` omitted ⇒ a network decoder: push() bytes as they arrive, then finish(). */
export function createDecoder(bytes?: Uint8Array, opts?: CreateDecoderOptions): Decoder;

export interface DecodeResult {
  metadata: Metadata | null;
  width: number;
  height: number;
  signals: Metadata['signals'];
  rgb: Uint8Array[] | null;
  rgbs: Record<string, Uint8Array[]> | null;
  signalSeries: Record<string, DecodedSignal[]> | null;
}

/** Batch helper: decode every frame in one call. */
export function decode(bytes: Uint8Array, opts?: CreateDecoderOptions): Promise<DecodeResult>;

// ── quantization + triangle-fold packing (re-exported from chromapakz-core.js) ──

export const LEVELS_FULL: number;
export function quantizeInverseDepth(z: Float32Array | number[], near: number, far: number, levels?: number): Uint16Array;
export function dequantizeInverseDepth(d: Uint16Array, near: number, far: number, levels?: number): Float32Array;
export function autoNearFar(depthFrames: Iterable<Float32Array | number[]>, lo?: number, hi?: number): DepthQuant;
export function triFoldPack(d: Uint16Array): { hi: Uint8Array; lo: Uint8Array };
export function triFoldUnpack(hi: Uint8Array, lo: Uint8Array): Uint16Array;

// ── signal spec constants ──

export const SIGNAL_DEPTH: SignalSpec & { scheme: string; dtype: 'uint16'; invalidCode: 0; quant: { type: 'inverse-depth' } };
export const SIGNAL_RAW_U16: SignalSpec & { scheme: string; dtype: 'uint16'; invalidCode: 0; quant: null };

// ── lower-level WebM stream helpers (re-exported from webm.js) ──

export interface Track {
  number: number;
  codecID: string;
  name: string;
  width: number;
  height: number;
  colour?: unknown;
  type?: number;
}

export interface StreamMux {
  readonly header: Uint8Array;
  writeFrame(frame: { track: number; key: boolean; timeMs: number; data: Uint8Array }): Uint8Array | null;
  writeText(track: number, timestampMs: number, durationMs: number, text: string): Uint8Array | null;
  finish(durationMs: number): Uint8Array;
}

export function createStreamMux(opts: {
  tracks: Track[];
  metadata: Record<string, unknown>;
  durationMs?: number;
  timestampScaleNs?: number;
  clusterSpanMs?: number;
}): StreamMux;

export type DemuxEvent =
  | { type: 'metadata'; metadata: Record<string, unknown> }
  | { type: 'block'; block: { track: number; key: boolean; timeMs: number; data: Uint8Array } }
  | { type: 'end' };

export interface StreamDemux {
  push(chunk: Uint8Array): DemuxEvent[];
  finish(): DemuxEvent[];
}

export function createStreamDemux(): StreamDemux;
export function concatChunks(chunks: Uint8Array[]): Uint8Array;

export class WebMCorruptError extends Error {}

// ── track-planning helpers (re-exported from signals.js) ──

export function normalizeMetadata(meta: Record<string, unknown>): Metadata;

export interface RgbPlanEntry {
  id: string;
  track: number;
  codec: string;
  kbps: number | null;
  width: number | null;
  height: number | null;
  trackName: string;
}

export interface SignalPlanEntry {
  id: string;
  scheme: string;
  dtype: string;
  invalidCode: number;
  codec: string;
  lossless: true;
  tracks: { hi: number; lo: number };
  trackNames: { hi: string; lo: string };
  quant: InverseDepthQuant | null;
  view: string | null;
  width?: number;
  height?: number;
}

export function planSignals(specs: SignalSpec[], rgbCount: number | boolean): SignalPlanEntry[];
export function planRgbs(specs: ReturnType<typeof normalizeRgbSpecs>): RgbPlanEntry[];
export function normalizeRgbSpecs(rgbs: RgbSpec[]): Array<{ id: string; kbps: number | null; width: number | null; height: number | null }>;
