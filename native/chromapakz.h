// chromapakz native C ABI — VP9-lossless RGB + lossless signals in WebM.
// All functions return 0 on success, nonzero on error. Buffers returned via out-params are
// malloc'd and must be released with dc_free().
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

#ifdef __cplusplus
extern "C" {
#endif

DC_API int dc_probe(const uint8_t* webm, size_t len, int* W, int* H, int* N, int* fps,
                    double* near_, double* far_, int* levels, int* has_rgb);

DC_API int dc_decode_rgb(const uint8_t* webm, size_t len, uint8_t* rgba_out);

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

DC_API int dc_decode_signal(const uint8_t* webm, size_t len, const char* signal_id, uint16_t* out);

DC_API void dc_free(uint8_t* p);

#ifdef __cplusplus
}
#endif
#endif
