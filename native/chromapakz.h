// chromapakz native C ABI — VP9-lossless RGB + lossless signals in WebM.
// All functions return 0 on success, nonzero on error. Buffers returned via out-params are
// malloc'd and must be released with dc_free().
#ifndef CHROMAPAKZ_H
#define CHROMAPAKZ_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int dc_probe(const uint8_t* webm, size_t len, int* W, int* H, int* N, int* fps,
             double* near_, double* far_, int* levels, int* has_rgb);

int dc_decode_rgb(const uint8_t* webm, size_t len, uint8_t* rgba_out);

void dc_quantize_inverse(const float* z, int n, double near_, double far_, int levels, uint16_t* out);
void dc_dequantize_inverse(const uint16_t* d, int n, double near_, double far_, int levels, float* out);

typedef struct {
  const char* id;
  const uint16_t* data;
  int inverse_depth;
  double near_, far_;
  int levels;
} dc_signal_spec_t;

int dc_encode_multi(const uint8_t* rgba, int rgb_kbps,
                    const dc_signal_spec_t* signals, int num_signals,
                    int W, int H, int N, int fps,
                    uint8_t** out, size_t* out_len);

int dc_get_metadata(const uint8_t* webm, size_t len, char** json_out, size_t* json_len);

int dc_decode_signal(const uint8_t* webm, size_t len, const char* signal_id, uint16_t* out);

void dc_free(uint8_t* p);

#ifdef __cplusplus
}
#endif
#endif
