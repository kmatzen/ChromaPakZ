// dc_vp9: a thin, per-frame streaming VP9 codec over libvpx, for the browser WASM fallback.
//
// Unlike native/chromapakz.h (whole-file: it mux/demuxes WebM itself), this exposes just the
// frame codec so the pure-JS pipeline (webm.js mux/demux, triangle-fold, streaming) stays in
// charge — the WASM module is a drop-in replacement for one WebCodecs VideoEncoder/Decoder
// track. A "chunk" is a bare VP9 frame, byte-for-byte what WebCodecs produces/consumes.
//
// Encoders/decoders queue their outputs internally; pull them with *_next() until it returns
// NULL. The returned pointer aliases internal storage valid only until the next call on that
// handle — copy it out immediately. All sizes are bytes; lengths fit in int (< 2GiB).
#ifndef DC_VP9_H
#define DC_VP9_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ── Encoder ──
typedef struct dcvp9_enc dcvp9_enc;

// kind: 0 = luma (8-bit Y plane, lossless QP=0 — for signal tracks)
//       1 = rgba (RGBA in, lossy VP9 at `bitrate_kbps`, BT.709 full-range — for the RGB track)
// key_every: force a keyframe every N frames (lossy only; <=0 ⇒ keyframe on frame 0 only).
dcvp9_enc* dcvp9_enc_new(int W, int H, int fps, int kind, int bitrate_kbps, int key_every);

// Encode one frame (luma: W*H bytes; rgba: W*H*4 bytes). force_key requests a keyframe.
// Returns 0 on success. Resulting packet(s) are queued; pull with dcvp9_enc_next().
int dcvp9_enc_encode(dcvp9_enc*, const uint8_t* plane, int force_key);

// Flush the encoder (drain any buffered frames into the output queue). Returns 0 on success.
int dcvp9_enc_flush(dcvp9_enc*);

// Pop the next queued packet. Returns its pointer and writes *len/*key/*time_ms, or NULL if
// the queue is empty. The pointer is valid until the next call on this encoder.
const uint8_t* dcvp9_enc_next(dcvp9_enc*, int* len, int* key, int* time_ms);

void dcvp9_enc_free(dcvp9_enc*);

// ── Decoder ──
typedef struct dcvp9_dec dcvp9_dec;

// kind: 0 = luma (output Y plane, W*H bytes), 1 = rgba (output RGBA, W*H*4 bytes).
dcvp9_dec* dcvp9_dec_new(int W, int H, int kind);

// Decode one bare VP9 frame. Returns 0 on success. Output plane(s) are queued.
int dcvp9_dec_decode(dcvp9_dec*, const uint8_t* chunk, size_t len);

int dcvp9_dec_flush(dcvp9_dec*);

// Pop the next decoded plane. Returns its pointer and writes *len, or NULL if empty.
// The pointer is valid until the next call on this decoder.
const uint8_t* dcvp9_dec_next(dcvp9_dec*, int* len);

void dcvp9_dec_free(dcvp9_dec*);

#ifdef __cplusplus
}
#endif
#endif
