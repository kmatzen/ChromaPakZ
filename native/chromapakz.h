// chromapakz native C ABI — VP9-lossless RGBD-in-WebM, shared by C++ and Python (ctypes).
// All functions return 0 on success, nonzero on error. Buffers returned via out-params are
// malloc'd and must be released with dc_free().
#ifndef CHROMAPAKZ_H
#define CHROMAPAKZ_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Encode a uint16 depth sequence (row-major, W*H per frame, N frames) into a chromapakz .webm.
// Depth codes are carried bit-exactly (triangle-fold 8+8 → two VP9 lossless inter tracks).
// near/far/levels are stored as the inverse-depth quantization contract (metadata only).
// levels is the number of quantization steps (65536 == full 16-bit; pass 0 for the default).
int dc_encode_depth(const uint16_t* depth, int W, int H, int N, int fps,
                    double near_, double far_, int levels, uint8_t** out, size_t* out_len);

// Read the chromapakz header from a .webm (works on files made by any chromapakz impl).
int dc_probe(const uint8_t* webm, size_t len, int* W, int* H, int* N, int* fps,
             double* near_, double* far_, int* levels, int* has_rgb);

// Decode the depth track into caller-provided buffer sized W*H*N uint16 (call dc_probe first).
int dc_decode_depth(const uint8_t* webm, size_t len, uint16_t* depth_out);

// Encode a full RGBD clip: RGBA frames (W*H*4 per frame, 8-bit) as a normal VP9 track (track 1,
// legacy fallback) + bit-exact depth tracks. Either pointer may be null (then it's omitted).
// rgb_kbps is the lossy RGB target bitrate (e.g. 2000).
int dc_encode_rgbd(const uint8_t* rgba, const uint16_t* depth, int W, int H, int N, int fps,
                   int rgb_kbps, double near_, double far_, int levels, uint8_t** out, size_t* out_len);

// Decode the RGB track to caller-provided RGBA buffer sized W*H*4*N. Returns nonzero if no RGB.
int dc_decode_rgb(const uint8_t* webm, size_t len, uint8_t* rgba_out);

// Convenience quantization (matches the JS implementation exactly). Code 0 == invalid.
// levels = number of quantization steps (65536 == full 16-bit; pass 0 for the default).
void dc_quantize_inverse(const float* z, int n, double near_, double far_, int levels, uint16_t* out);
void dc_dequantize_inverse(const uint16_t* d, int n, double near_, double far_, int levels, float* out);

// One lossless uint16 plane per frame (row-major W*H, N frames). inverse_depth=1 stores
// inverse-depth quant in metadata (near/far/levels); 0 = raw pass-through uint16.
typedef struct {
  const char* id;
  const uint16_t* data;
  int inverse_depth;
  double near_, far_;
  int levels;
} dc_signal_spec_t;

// Encode RGB (optional) + any number of lossless signals. rgba may be null (no RGB track).
int dc_encode_multi(const uint8_t* rgba, int rgb_kbps,
                    const dc_signal_spec_t* signals, int num_signals,
                    int W, int H, int N, int fps,
                    uint8_t** out, size_t* out_len);

// Return the CHROMAPAKZ metadata JSON (malloc'd; free with dc_free).
int dc_get_metadata(const uint8_t* webm, size_t len, char** json_out, size_t* json_len);

// Decode one signal by id (e.g. "depth", "objectId") into caller buffer W*H*N uint16.
int dc_decode_signal(const uint8_t* webm, size_t len, const char* signal_id, uint16_t* out);

void dc_free(uint8_t* p);

#ifdef __cplusplus
}
#endif
#endif
