#include "mel_features.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>

namespace imcodes::qwen3 {

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;

inline float hz_to_mel_slaney(float hz) {
  constexpr float kMinLogHertz = 1000.0f;
  constexpr float kMinLogMel = 15.0f;
  const float logstep = 27.0f / std::log(6.4f);
  if (hz < kMinLogHertz) {
    return 3.0f * hz / 200.0f;
  }
  return kMinLogMel + std::log(hz / kMinLogHertz) * logstep;
}

inline float mel_to_hz_slaney(float mel) {
  constexpr float kMinLogHertz = 1000.0f;
  constexpr float kMinLogMel = 15.0f;
  const float logstep = std::log(6.4f) / 27.0f;
  if (mel < kMinLogMel) {
    return 200.0f * mel / 3.0f;
  }
  return kMinLogHertz * std::exp((mel - kMinLogMel) * logstep);
}

struct Complex {
  double re{0.0};
  double im{0.0};
};

inline Complex cmul(const Complex& a, const Complex& b) {
  return {a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re};
}

inline void dft5(const Complex* in, size_t in_stride, Complex* out, size_t out_stride,
                 const double* w5_cos, const double* w5_sin) {
  // 5-point DFT using precomputed cos/sin(-2*pi*k*n/5)
  for (size_t k = 0; k < 5; ++k) {
    double sr = in[0].re;
    double si = in[0].im;
    const size_t base = k * 5;
    for (size_t n = 1; n < 5; ++n) {
      const double wr = w5_cos[base + n];
      const double wi = w5_sin[base + n];
      const Complex& v = in[n * in_stride];
      sr += v.re * wr - v.im * wi;
      si += v.re * wi + v.im * wr;
    }
    out[k * out_stride] = {sr, si};
  }
}

inline void fft25(const Complex* in, size_t in_stride, Complex* out, size_t out_stride,
                  const double* w5_cos, const double* w5_sin,
                  const double* w25_cos, const double* w25_sin) {
  // 25 = 5 x 5 Cooley-Tukey:
  // n = 5*n1 + n0, k = k0 + 5*k1 (0 <= n0, n1, k0, k1 < 5)
  Complex tmp[25];
  for (size_t n0 = 0; n0 < 5; ++n0) {
    dft5(in + n0 * in_stride, 5 * in_stride, tmp + n0 * 5, 1, w5_cos, w5_sin);
  }
  for (size_t k0 = 0; k0 < 5; ++k0) {
    Complex twiddled[5];
    for (size_t n0 = 0; n0 < 5; ++n0) {
      const Complex v = tmp[n0 * 5 + k0];
      const size_t idx = (k0 * n0) % 25;
      twiddled[n0] = cmul(v, {w25_cos[idx], w25_sin[idx]});
    }
    dft5(twiddled, 1, out + k0 * out_stride, 5 * out_stride, w5_cos, w5_sin);
  }
}

inline void fft8(const Complex* in, size_t in_stride, Complex* out, size_t out_stride) {
  // Decimation-in-time radix-8 DFT: bit-reversed 8 inputs
  // Permuted order of n: 0, 4, 2, 6, 1, 5, 3, 7
  Complex a[8] = {
      in[0 * in_stride], in[4 * in_stride], in[2 * in_stride], in[6 * in_stride],
      in[1 * in_stride], in[5 * in_stride], in[3 * in_stride], in[7 * in_stride],
  };
  // Stage 1: radix-2
  for (int i = 0; i < 8; i += 2) {
    const Complex u = a[i];
    const Complex v = a[i + 1];
    a[i] = {u.re + v.re, u.im + v.im};
    a[i + 1] = {u.re - v.re, u.im - v.im};
  }
  // Stage 2: radix-4 twiddles: W_4^0 = 1, W_4^1 = -i
  for (int i = 0; i < 8; i += 4) {
    const Complex u0 = a[i + 0];
    const Complex v0 = a[i + 2];
    const Complex u1 = a[i + 1];
    const Complex v1 = {a[i + 3].im, -a[i + 3].re};  // * (-i)
    a[i + 0] = {u0.re + v0.re, u0.im + v0.im};
    a[i + 2] = {u0.re - v0.re, u0.im - v0.im};
    a[i + 1] = {u1.re + v1.re, u1.im + v1.im};
    a[i + 3] = {u1.re - v1.re, u1.im - v1.im};
  }
  // Stage 3: radix-8 twiddles: W_8^k = exp(-i * pi * k / 4) for k=0..3
  constexpr double kInvSqrt2 = 0.70710678118654752440;
  const Complex w[4] = {
      {1.0, 0.0},
      {kInvSqrt2, -kInvSqrt2},
      {0.0, -1.0},
      {-kInvSqrt2, -kInvSqrt2},
  };
  for (int k = 0; k < 4; ++k) {
    const Complex u = a[k];
    const Complex v = cmul(a[k + 4], w[k]);
    out[static_cast<size_t>(k) * out_stride] = {u.re + v.re, u.im + v.im};
    out[static_cast<size_t>(k + 4) * out_stride] = {u.re - v.re, u.im - v.im};
  }
}

}  // namespace

int64_t feat_to_audio_tokens_len(int64_t feat_frames, int64_t chunk_size) {
  if (feat_frames <= 0 || chunk_size <= 0) return 0;
  auto conv_out = [](int64_t len) -> int64_t {
    if (len <= 0) return 0;
    int64_t t = (len - 1) / 2 + 1;
    t = (t - 1) / 2 + 1;
    t = (t - 1) / 2 + 1;
    return t;
  };
  const int64_t num_chunks = feat_frames / chunk_size;
  const int64_t rem = feat_frames % chunk_size;
  return num_chunks * conv_out(chunk_size) + (rem > 0 ? conv_out(rem) : 0);
}

WhisperMelExtractor::WhisperMelExtractor() {
  init_tables();
}

void WhisperMelExtractor::init_tables() {
  // Periodic Hann window matching HuggingFace window_function(400, "hann")
  hann_window_.resize(kWhisperNfft);
  for (int n = 0; n < kWhisperNfft; ++n) {
    hann_window_[static_cast<size_t>(n)] =
        static_cast<float>(0.5 * (1.0 - std::cos(2.0 * kPi * static_cast<double>(n) / kWhisperNfft)));
  }

  // FFT twiddle tables
  w200_cos_.resize(200);
  w200_sin_.resize(200);
  for (int i = 0; i < 200; ++i) {
    const double angle = -2.0 * kPi * static_cast<double>(i) / 200.0;
    w200_cos_[static_cast<size_t>(i)] = std::cos(angle);
    w200_sin_[static_cast<size_t>(i)] = std::sin(angle);
  }

  w400_cos_.resize(101);
  w400_sin_.resize(101);
  for (int k = 0; k <= 100; ++k) {
    const double angle = -2.0 * kPi * static_cast<double>(k) / 400.0;
    w400_cos_[static_cast<size_t>(k)] = std::cos(angle);
    w400_sin_[static_cast<size_t>(k)] = std::sin(angle);
  }

  w5_cos_.resize(25);
  w5_sin_.resize(25);
  for (int k = 0; k < 5; ++k) {
    for (int n = 0; n < 5; ++n) {
      const double angle = -2.0 * kPi * static_cast<double>(k * n) / 5.0;
      w5_cos_[static_cast<size_t>(k * 5 + n)] = std::cos(angle);
      w5_sin_[static_cast<size_t>(k * 5 + n)] = std::sin(angle);
    }
  }

  w25_cos_.resize(25);
  w25_sin_.resize(25);
  for (int i = 0; i < 25; ++i) {
    const double angle = -2.0 * kPi * static_cast<double>(i) / 25.0;
    w25_cos_[static_cast<size_t>(i)] = std::cos(angle);
    w25_sin_[static_cast<size_t>(i)] = std::sin(angle);
  }

  // 128-bin Slaney Mel filterbank matching HuggingFace audio_utils.mel_filter_bank
  const float f_min = 0.0f;
  const float f_max = static_cast<float>(kWhisperSampleRate) / 2.0f;  // 8000 Hz
  const float mel_min = hz_to_mel_slaney(f_min);
  const float mel_max = hz_to_mel_slaney(f_max);
  constexpr int kNumMelPoints = kWhisperNumMels + 2;  // 130

  std::vector<float> filter_freqs(kNumMelPoints);
  for (int i = 0; i < kNumMelPoints; ++i) {
    const float m = mel_min + static_cast<float>(i) * (mel_max - mel_min) / static_cast<float>(kNumMelPoints - 1);
    filter_freqs[static_cast<size_t>(i)] = mel_to_hz_slaney(m);
  }

  std::vector<float> filter_diff(kNumMelPoints - 1);
  for (int i = 0; i < kNumMelPoints - 1; ++i) {
    filter_diff[static_cast<size_t>(i)] = filter_freqs[static_cast<size_t>(i + 1)] - filter_freqs[static_cast<size_t>(i)];
  }

  mel_filterbank_t_.assign(static_cast<size_t>(kWhisperNumBins) * kWhisperNumMels, 0.0f);
  for (int bin = 0; bin < kWhisperNumBins; ++bin) {
    const float fft_freq = static_cast<float>(bin) * static_cast<float>(kWhisperSampleRate) / static_cast<float>(kWhisperNfft);
    for (int mel = 0; mel < kWhisperNumMels; ++mel) {
      const float low_freq = filter_freqs[static_cast<size_t>(mel)];
      const float high_freq = filter_freqs[static_cast<size_t>(mel + 2)];
      const float down_slope = (fft_freq - low_freq) / filter_diff[static_cast<size_t>(mel)];
      const float up_slope = (high_freq - fft_freq) / filter_diff[static_cast<size_t>(mel + 1)];
      const float val = std::max(0.0f, std::min(down_slope, up_slope));
      const float enorm = 2.0f / (high_freq - low_freq);
      mel_filterbank_t_[static_cast<size_t>(bin) * kWhisperNumMels + static_cast<size_t>(mel)] = val * enorm;
    }
  }
}

void WhisperMelExtractor::compute_frame_power(const float* frame_400, float* out_power) const {
  // Pack 400 real windowed samples into 200 complex samples: z[n] = w[2n] + i*w[2n+1]
  Complex z_in[200];
  for (int n = 0; n < 200; ++n) {
    const float w0 = frame_400[2 * n] * hann_window_[static_cast<size_t>(2 * n)];
    const float w1 = frame_400[2 * n + 1] * hann_window_[static_cast<size_t>(2 * n + 1)];
    z_in[n] = {static_cast<double>(w0), static_cast<double>(w1)};
  }

  // 200 = 8 * 25 mixed-radix FFT:
  // n = 8*n1 + n0 (0 <= n0 < 8, 0 <= n1 < 25)
  // k = k0 + 8*k1 (0 <= k0 < 8, 0 <= k1 < 25)
  Complex stage1[200];
  for (size_t n0 = 0; n0 < 8; ++n0) {
    fft25(z_in + n0, 8, stage1 + n0 * 25, 1,
          w5_cos_.data(), w5_sin_.data(), w25_cos_.data(), w25_sin_.data());
  }

  Complex z_out[200];
  for (size_t k1 = 0; k1 < 25; ++k1) {
    Complex twiddled[8];
    for (size_t n0 = 0; n0 < 8; ++n0) {
      const size_t idx = (k1 * n0) % 200;
      twiddled[n0] = cmul(stage1[n0 * 25 + k1], {w200_cos_[idx], w200_sin_[idx]});
    }
    fft8(twiddled, 1, z_out + k1, 25);
  }
  // Index k = k1 + 25 * k0 is stored at z_out[k0 * 25 + k1] = z_out[k].
  // Unpack Z[0..199] into 400-point real DFT bins 0..200:
  const double re0 = z_out[0].re;
  const double im0 = z_out[0].im;
  const double x0 = re0 + im0;
  const double x200 = re0 - im0;
  out_power[0] = static_cast<float>(x0 * x0);
  out_power[200] = static_cast<float>(x200 * x200);

  for (int k = 1; k < 100; ++k) {
    const Complex zk = z_out[k];
    const Complex zmk = z_out[200 - k];  // Z[M - k]
    const Complex conj_zmk = {zmk.re, -zmk.im};
    const Complex even_k = {0.5 * (zk.re + conj_zmk.re), 0.5 * (zk.im + conj_zmk.im)};
    // Odd[k] = -0.5 * i * (Z[k] - conj(Z[M-k])) = { 0.5*(zk.im - conj_zmk.im), -0.5*(zk.re - conj_zmk.re) }
    const Complex odd_k = {0.5 * (zk.im - conj_zmk.im), -0.5 * (zk.re - conj_zmk.re)};
    const Complex wk = {w400_cos_[static_cast<size_t>(k)], w400_sin_[static_cast<size_t>(k)]};
    const Complex tw_odd = cmul(wk, odd_k);

    const double xr = even_k.re + tw_odd.re;
    const double xi = even_k.im + tw_odd.im;
    out_power[k] = static_cast<float>(xr * xr + xi * xi);

    const double x2r = even_k.re - tw_odd.re;
    const double x2i = even_k.im - tw_odd.im;
    out_power[200 - k] = static_cast<float>(x2r * x2r + x2i * x2i);
  }

  // k = 100
  {
    const Complex z100 = z_out[100];
    // For k = 100: conj(Z[100]), Even = Re(Z[100]), Odd = Im(Z[100]), W_400^100 = -i => X[100] = conj(Z[100])
    out_power[100] = static_cast<float>(z100.re * z100.re + z100.im * z100.im);
  }
}

MelSpectrogram WhisperMelExtractor::extract(const std::vector<float>& samples_16k) const {
  MelSpectrogram result;
  if (samples_16k.empty()) return result;

  constexpr int kPadLen = kWhisperNfft / 2;  // 200
  const int input_len = static_cast<int>(samples_16k.size());
  std::vector<float> padded(static_cast<size_t>(kPadLen + input_len + kPadLen), 0.0f);

  // Reflect pad left side
  for (int i = 0; i < kPadLen; ++i) {
    const int src = std::max(0, std::min(kPadLen - i, input_len - 1));
    padded[static_cast<size_t>(i)] = samples_16k[static_cast<size_t>(src)];
  }
  // Center audio
  std::copy(samples_16k.begin(), samples_16k.end(), padded.begin() + kPadLen);
  // Reflect pad right side
  for (int i = 0; i < kPadLen; ++i) {
    const int src = std::max(0, std::min(input_len - 2 - i, input_len - 1));
    padded[static_cast<size_t>(kPadLen + input_len + i)] = samples_16k[static_cast<size_t>(src)];
  }

  const int total_frames = (static_cast<int>(padded.size()) - kWhisperNfft) / kWhisperHopLength + 1;
  // Drop the last frame to match HuggingFace WhisperFeatureExtractor (log_spec[:, :-1])
  int usable_frames = total_frames - 1;
  if (usable_frames <= 0) return result;
  if (usable_frames > kWhisperMaxFrames) {
    usable_frames = kWhisperMaxFrames;
  }

  result.num_frames = usable_frames;
  result.num_mels = kWhisperNumMels;
  result.data.assign(static_cast<size_t>(usable_frames) * kWhisperNumMels, 0.0f);

  float power[kWhisperNumBins];
  float max_log_val = -std::numeric_limits<float>::infinity();

  for (int f = 0; f < usable_frames; ++f) {
    const float* frame_ptr = padded.data() + static_cast<size_t>(f) * kWhisperHopLength;
    compute_frame_power(frame_ptr, power);

    float* out_row = result.data.data() + static_cast<size_t>(f) * kWhisperNumMels;
    for (int bin = 0; bin < kWhisperNumBins; ++bin) {
      const float p = power[bin];
      if (p == 0.0f) continue;
      const float* fb_row = mel_filterbank_t_.data() + static_cast<size_t>(bin) * kWhisperNumMels;
      for (int mel = 0; mel < kWhisperNumMels; ++mel) {
        out_row[mel] += p * fb_row[mel];
      }
    }

    for (int mel = 0; mel < kWhisperNumMels; ++mel) {
      const float clamped = std::max(out_row[mel], 1e-10f);
      const float lg = std::log10(clamped);
      out_row[mel] = lg;
      if (lg > max_log_val) {
        max_log_val = lg;
      }
    }
  }

  const float min_floor = max_log_val - 8.0f;
  for (float& val : result.data) {
    if (val < min_floor) val = min_floor;
    val = (val + 4.0f) * 0.25f;
  }

  return result;
}

}  // namespace imcodes::qwen3
