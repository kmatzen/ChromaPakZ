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

#ifdef __cplusplus
extern "C" {
#endif

DC_API int dc_probe(const uint8_t* webm, size_t len, int* W, int* H, int* N, int* fps,
                    double* near_, double* far_, int* levels, int* has_rgb);

// Decode the RGB track into `rgba_out`, which holds `rgba_cap` bytes (frames * W*H*4).
// Writes only as many whole frames as the capacity allows; a stream with more returns
// DC_ERR_CAPACITY and leaves the buffer's contents unspecified. Frames the file does not
// contain are left untouched, so pass a zeroed buffer if you read the whole of it back.
DC_API int dc_decode_rgb(const uint8_t* webm, size_t len, uint8_t* rgba_out, size_t rgba_cap);

DC_API void dc_quantize_inverse(const float* z, int n, double near_, double far_, int levels, uint16_t* out);
DC_API void dc_dequantize_inverse(const uint16_t* d, int n, double near_, double far_, int levels, float* out);

typedef struct {
  const char* id;
  const uint16_t* data;
  int inverse_depth;
  double near_, far_;
  int levels;
} dc_signal_spec_t;

DC_API int dc_encode_multi(const uint8_t* rgba, int rgb_kbps,
                           const dc_signal_spec_t* signals, int num_signals,
                           int W, int H, int N, int fps,
                           uint8_t** out, size_t* out_len);

DC_API int dc_get_metadata(const uint8_t* webm, size_t len, char** json_out, size_t* json_len);

// Decode one signal by id into `out`, which holds `out_cap` uint16 elements (frames * W*H).
// Same capacity and geometry contract as dc_decode_rgb above.
DC_API int dc_decode_signal(const uint8_t* webm, size_t len, const char* signal_id,
                            uint16_t* out, size_t out_cap);

DC_API void dc_free(uint8_t* p);

#ifdef __cplusplus
}
#endif
#endif
