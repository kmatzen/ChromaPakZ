// chromapakz native C ABI — VP9-lossless RGB + lossless signals in WebM.
// All functions return 0 on success, nonzero on error. Buffers returned via out-params are
// malloc'd and must be released with dc_free().
//
// The dc_decode_* entry points consume untrusted input. A file's metadata, its bitstream and
// whatever dc_probe reported can all disagree — a header may declare one frame while the
// clusters hold a hundred, a single VP9 superframe packet decodes to several images, and a
// 16x16 bitstream may sit under a header claiming 4096x4096. So each decode takes the capacity
// of the caller's buffer and refuses to write past it, and validates every decoded image's
// geometry against the metadata before copying it out.
//
// General contract
// ----------------
//  * No function throws. C++ exceptions raised internally (notably std::bad_alloc, reachable
//    with crafted dimensions) are caught at the ABI boundary and reported as DC_ERR_INTERNAL.
//  * On any nonzero return, out-params are unspecified: caller-owned buffers may be partially
//    written, and pointer out-params are not set (nothing needs freeing).
//
// Return codes
// ------------
// 0 is success everywhere. Codes 1-8 are per-function — their meaning depends on which call
// returned them, so see each declaration below. 9-12 mean the same thing in every function.
#ifndef CHROMAPAKZ_H
#define CHROMAPAKZ_H
#include <stddef.h>
#include <stdint.h>

// The core is built with -fvisibility=hidden and links libvpx statically, so that the only
// symbols it exports are these dc_* entry points — no vpx_* symbol is imported or exported.
// That keeps us immune to ELF symbol interposition from other extensions that publish their
// own libvpx into the global namespace (e.g. decord, which dlopens with RTLD_GLOBAL).
#if defined(_WIN32)
#  define DC_API __declspec(dllexport)
#else
#  define DC_API __attribute__((visibility("default")))
#endif

// Error codes shared by the decode entry points (each also has its own; see below).
#define DC_OK              0
#define DC_ERR_CAPACITY    9   // the stream holds more frames than the output buffer can take
#define DC_ERR_GEOMETRY   10   // a decoded frame is not the 8-bit I420 W*H the metadata promised
#define DC_ERR_INTERNAL   11   // unexpected internal failure — out of memory, or a caught exception
#define DC_ERR_CODEC      12   // libvpx rejected a configuration required for correctness (lossless)

#ifdef __cplusplus
extern "C" {
#endif

// Read W/H/N/fps + inverse-depth params + RGB presence from a file's metadata. Any out-param
// may be NULL. N is a hint for sizing decode buffers, not a guarantee — see the note on frame
// counting in the implementation; the dc_decode_* capacity arguments are what bound the writes.
// `has_rgb` receives the number of RGB streams the file carries (0 or 1 before multi-RGB, so
// existing truthiness checks keep working; N for a v3 multi-camera file).
// Errors: 1 = webm is NULL, len is 0, or the bytes carry no chromapakz metadata.
DC_API int dc_probe(const uint8_t* webm, size_t len, int* W, int* H, int* N, int* fps,
                    double* near_, double* far_, int* levels, int* has_rgb);

// Decode the primary RGB track into `rgba_out`, which holds `rgba_cap` bytes (frames * W*H*4).
// Writes only as many whole frames as the capacity allows; a stream with more returns
// DC_ERR_CAPACITY and leaves the buffer's contents unspecified. Frames the file does not
// contain are left untouched, so pass a zeroed buffer if you read the whole of it back.
// Errors: 1 = NULL argument or no metadata; 2 = the file declares unusable dimensions;
//         3 = VP9 decode failed; 6 = the file has no RGB track.
DC_API int dc_decode_rgb(const uint8_t* webm, size_t len, uint8_t* rgba_out, size_t rgba_cap);

// As dc_decode_rgb, addressing one RGB stream of a multi-camera (v3) file by its metadata id.
// `rgb_id` NULL means the primary stream — then this is exactly dc_decode_rgb.
// Errors: as dc_decode_rgb, plus 8 = no RGB stream with that id in this file.
DC_API int dc_decode_rgb_id(const uint8_t* webm, size_t len, const char* rgb_id,
                            uint8_t* rgba_out, size_t rgba_cap);

// Quantization helpers. Both are no-ops when n <= 0 or either pointer is NULL. An unusable range
// (near_/far_ non-positive or equal, levels < 3) writes the invalid code 0 / NaN rather than
// dividing by zero — the higher-level wrappers reject such ranges up front.
DC_API void dc_quantize_inverse(const float* z, int n, double near_, double far_, int levels, uint16_t* out);
DC_API void dc_dequantize_inverse(const uint16_t* d, int n, double near_, double far_, int levels, float* out);

typedef struct {
  const char* id;
  const uint16_t* data;
  int inverse_depth;
  double near_, far_;
  int levels;
} dc_signal_spec_t;

// One RGB stream of a multi-camera (v3) file. Streams are numbered in the order given —
// the first is the primary (track 1, container name "rgb", the one legacy readers decode).
typedef struct {
  const char* id;   // stream id recorded in the metadata; NULL only for a single stream = "rgb"
  int kbps;         // per-stream bitrate; 0 = the 2000 default
} dc_rgb_spec_t;

// dc_signal_spec_t plus the optional `view` hint (the id of the RGB stream whose camera frame
// this signal lives in). The hint is recorded in the metadata verbatim and never interpreted —
// association semantics belong to the wrapper format. NULL = unspecified.
typedef struct {
  const char* id;
  const uint16_t* data;
  int inverse_depth;
  double near_, far_;
  int levels;
  const char* view;
} dc_signal_spec2_t;

// Encode optional RGB plus zero or more lossless uint16 signals (each N*W*H samples).
// On success *out is a malloc'd WebM file of *out_len bytes; release it with dc_free().
// Errors: 1 = invalid argument: NULL out-params, N/fps <= 0, no inputs, a spec with a NULL
//             id/data, or dimensions the decoders could never handle (the same 0 < W,H <= 65536
//             with W*H <= 2^28 bound they enforce — the encoder's plane arithmetic is done in
//             int, so a wider product would wrap before anything is allocated);
//         2 = RGB encode failed; 3 = signal hi-plane encode failed;
//         4 = signal lo-plane encode failed; 5 = output allocation failed;
//         6 = RGB encoder returned a frame count != N; 7 = a signal encoder returned != N.
DC_API int dc_encode_multi(const uint8_t* rgba, int rgb_kbps,
                           const dc_signal_spec_t* signals, int num_signals,
                           int W, int H, int N, int fps,
                           uint8_t** out, size_t* out_len);

// As dc_encode_multi, with any number of RGB streams: `rgbas` is `num_rgbs` pointers, each to
// N*W*H*4 bytes, described by `rgbs` in the same order. All streams share W/H and the frame
// grid — every stream carries all N frames. num_rgbs may be 0 (signals only).
// Errors: as dc_encode_multi; a NULL/duplicate/empty stream id (NULL is allowed only when
// num_rgbs == 1) or a NULL rgbas entry is error 1.
DC_API int dc_encode_multi2(const uint8_t* const* rgbas,
                            const dc_rgb_spec_t* rgbs, int num_rgbs,
                            const dc_signal_spec2_t* signals, int num_signals,
                            int W, int H, int N, int fps,
                            uint8_t** out, size_t* out_len);

// ── streaming (live-recording) encode ──
// dc_encode_multi needs the whole take up front. These entry points encode it frame by frame and
// hand back the bytes as they become final, so a recorder can write (or transmit) a growing file
// and lose at most the tail if it crashes. What is retained is the encoder state, the cluster
// currently open (at most a second of media) and — only when one was asked for — the cue index,
// about a dozen bytes per second. Never the frames already written.
//
// The chunks are *element-aligned*: dc_stream_header returns the whole file prefix (EBML header,
// an unknown-size Segment, Info/Tracks/Tags), and every later chunk is a whole number of complete
// Cluster elements. A wrapper format can therefore interleave its own Matroska elements between
// chunks without re-parsing byte boundaries. The Segment size is written "unknown", so the file is
// valid WebM — playable and decodable — from the first chunk onward, and stays valid if the
// recording is cut short. The metadata carries "frames":null; readers recover the count by
// counting blocks, exactly as they do for a browser-streamed file.
//
// Concatenating header + every chunk + the finish() bytes yields a file byte-identical to what a
// reader would have received over the wire, and one the dc_decode_* entry points read normally.
typedef struct dc_stream_encoder dc_stream_encoder_t;

// Open a streaming encoder for a W*H, `fps` recording of `num_signals` lossless uint16 signals
// plus, when has_rgb is nonzero, a lossy RGB track. The specs' `data` fields are ignored — planes
// arrive per frame — but their ids and quantization are recorded in the header, so they must be
// final here. Track numbering matches dc_encode_multi: RGB is 1 when present, then hi/lo per
// signal in the order given. Release the handle with dc_stream_destroy(), always: a failed
// add_frame does not free it.
//
// `emit_cues` decides up front whether the recording is given a seek index at finish(). Say no
// when something else will insert bytes between the chunks: cue positions are byte offsets into
// the Segment, and injected elements move every cluster out from under them. Declining also means
// no index is accumulated, which is what leaves memory flat over a long take.
// Errors: 1 = invalid argument: NULL out/handle, no inputs at all, a spec with a NULL id, N/A
//             dimensions (same bound as dc_encode_multi) or fps <= 0;
//         2 = the RGB encoder could not be opened; 3 = a signal encoder could not be opened;
//         11 = internal failure; 12 = this libvpx cannot do lossless VP9.
DC_API int dc_stream_create(int W, int H, int fps, int rgb_kbps, int has_rgb, int emit_cues,
                            const dc_signal_spec_t* signals, int num_signals,
                            dc_stream_encoder_t** out);

// Copy out the file prefix. Valid — and worth writing to disk — before any frame is encoded.
// Errors: 1 = NULL argument; 5 = allocation failed.
// As dc_stream_create, plus an optional timed-text track named `text_track_name`
// (NULL or empty for none), carrying S_TEXT/WEBVTT cues written with
// dc_stream_add_text. The header is emitted at create time, so the track cannot be
// declared later. Track numbering of the video/signal tracks is unchanged.
DC_API int dc_stream_create_ex(int W, int H, int fps, int rgb_kbps, int has_rgb, int emit_cues,
                               const dc_signal_spec_t* signals, int num_signals,
                               const char* text_track_name,
                               dc_stream_encoder_t** out);

// As dc_stream_create_ex, with any number of RGB streams (see dc_rgb_spec_t): streams take
// tracks 1..num_rgbs in the order given, signals follow. Frames are then added with
// dc_stream_add_frame2. Same errors as dc_stream_create_ex; invalid stream ids are error 1.
DC_API int dc_stream_create2(int W, int H, int fps,
                             const dc_rgb_spec_t* rgbs, int num_rgbs, int emit_cues,
                             const dc_signal_spec2_t* signals, int num_signals,
                             const char* text_track_name,
                             dc_stream_encoder_t** out);

// Append one timed-text cue to the metadata track. Cues ride inside the cluster the
// surrounding frames are already filling and never drive cluster boundaries, so this
// usually returns an empty chunk. Fails if no text track was declared.
DC_API int dc_stream_add_text(dc_stream_encoder_t* enc, int timestamp_ms, int duration_ms,
                              const uint8_t* utf8, size_t len, uint8_t** out, size_t* out_len);

DC_API int dc_stream_header(dc_stream_encoder_t* enc, uint8_t** out, size_t* out_len);

// Encode one frame. `rgba` is W*H*4 bytes and required exactly when the stream declared RGB;
// `signal_planes` is an array of num_signals pointers to W*H uint16 samples, in the order given
// at create time. Every declared stream must be present on every frame — a track that stops and
// resumes cannot be realigned, since each carries its own frame counter.
// *out receives whatever became final (zero or more whole Cluster elements) and may come back
// NULL with *out_len 0, which is normal: most frames only extend the open cluster. Release a
// non-NULL *out with dc_free().
// Errors: 1 = NULL argument or a missing plane; 2 = RGB encode failed; 3 = a signal encode
//         failed; 5 = allocation failed; 6 = the stream is already finished.
DC_API int dc_stream_add_frame(dc_stream_encoder_t* enc, const uint8_t* rgba,
                               const uint16_t* const* signal_planes,
                               uint8_t** out, size_t* out_len);

// As dc_stream_add_frame for an encoder opened with dc_stream_create2: `rgbas` is an array of
// num_rgbs pointers (each W*H*4 bytes) in create-time order, required exactly when the stream
// declared any RGB. Every declared stream must be present on every frame.
DC_API int dc_stream_add_frame2(dc_stream_encoder_t* enc, const uint8_t* const* rgbas,
                                const uint16_t* const* signal_planes,
                                uint8_t** out, size_t* out_len);

// Flush the codecs, close the last cluster and append the Cues index if one was asked for at
// create time. The handle is spent afterwards — destroy it. Same out-param contract as
// dc_stream_add_frame.
// Errors: 1 = NULL argument; 2/3 = a codec flush failed; 5 = allocation failed;
//         6 = already finished.
DC_API int dc_stream_finish(dc_stream_encoder_t* enc, uint8_t** out, size_t* out_len);

// Release the handle and its codec state. NULL is a no-op; a finished stream still needs this.
DC_API void dc_stream_destroy(dc_stream_encoder_t* enc);

// Copy the raw metadata JSON out as a NUL-terminated malloc'd string (*json_len excludes the NUL).
// Release with dc_free(). Errors: 1 = NULL argument or no metadata; 5 = allocation failed.
DC_API int dc_get_metadata(const uint8_t* webm, size_t len, char** json_out, size_t* json_len);

// Decode one signal by id into `out`, which holds `out_cap` uint16 elements (frames * W*H).
// Same capacity and geometry contract as dc_decode_rgb above.
// Errors: 1 = NULL argument or no metadata; 2 = the file declares unusable dimensions;
//         3 = hi-plane decode failed; 4 = lo-plane decode failed;
//         5 = the hi and lo tracks decoded to different frame counts;
//         8 = no signal with that id in this file.
DC_API int dc_decode_signal(const uint8_t* webm, size_t len, const char* signal_id,
                            uint16_t* out, size_t out_cap);

DC_API void dc_free(uint8_t* p);

#ifdef __cplusplus
}
#endif
#endif
