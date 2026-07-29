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
// Errors: 1 = webm is NULL, len is 0, or the bytes carry no chromapakz metadata.
DC_API int dc_probe(const uint8_t* webm, size_t len, int* W, int* H, int* N, int* fps,
                    double* near_, double* far_, int* levels, int* has_rgb);

// Decode the RGB track into `rgba_out`, which holds `rgba_cap` bytes (frames * W*H*4).
// Writes only as many whole frames as the capacity allows; a stream with more returns
// DC_ERR_CAPACITY and leaves the buffer's contents unspecified. Frames the file does not
// contain are left untouched, so pass a zeroed buffer if you read the whole of it back.
// Errors: 1 = NULL argument or no metadata; 2 = the file declares unusable dimensions;
//         3 = VP9 decode failed; 6 = the file has no RGB track.
DC_API int dc_decode_rgb(const uint8_t* webm, size_t len, uint8_t* rgba_out, size_t rgba_cap);

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
