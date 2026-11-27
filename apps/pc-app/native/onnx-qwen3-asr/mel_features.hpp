#pragma once

#include <cstdint>
#include <vector>

namespace imcodes::qwen3 {

inline constexpr int kWhisperSampleRate = 16000;
inline constexpr int kWhisperNfft = 400;
inline constexpr int kWhisperHopLength = 160;
inline constexpr int kWhisperNumMels = 128;
inline constexpr int kWhisperNumBins = kWhisperNfft / 2 + 1;  // 201
inline constexpr int kWhisperMaxFrames = 1200 * kWhisperSampleRate / kWhisperHopLength;  // 120000

struct MelSpectrogram {
  // Row-major [num_frames, 128] float32 log-mel spectrogram ready for conv_frontend.onnx ([1, num_frames, 128]).
  std::vector<float> data;
  int64_t num_frames{0};
  int64_t num_mels{kWhisperNumMels};
};

/**
 * Compute valid audio token count produced by Qwen3-ASR conv_frontend for a given
 * number of spectrogram frames (mirrors sherpa-onnx FeatToAudioTokensLen).
 */
int64_t feat_to_audio_tokens_len(int64_t feat_frames, int64_t chunk_size = 100);

/**
 * 16kHz 128-bin centered-STFT log-Mel feature extractor matching HuggingFace
 * WhisperFeatureExtractor (periodic Hann window, reflect padding n_fft/2,
 * last-frame trim, Slaney 128-bin filterbank, log10 dynamic-range clamp, and
 * (x + 4) / 4 normalization).
 */
class WhisperMelExtractor {
 public:
  WhisperMelExtractor();

  /**
   * Extract normalized [num_frames, 128] features from 16kHz mono float samples.
   * Does not peak-normalize audio amplitude, matching HuggingFace WhisperFeatureExtractor.
   */
  MelSpectrogram extract(const std::vector<float>& samples_16k) const;

  /**
   * Expose unnormalized power spectrum for 400-sample windowed frame (testing/verification).
   * Writes 201 power bins |rfft(frame * hann)|^2 into out_power (must have size >= 201).
   */
  void compute_frame_power(const float* frame_400, float* out_power) const;

 private:
  void init_tables();

  std::vector<float> hann_window_;       // [400]
  std::vector<float> mel_filterbank_t_;  // [201, 128] row-major for fast bin->mel accumulation
  // Precomputed twiddle tables for 200-point complex FFT (8 x 25 mixed-radix) and 400-pt real unpack.
  std::vector<double> w200_cos_;         // [200]
  std::vector<double> w200_sin_;         // [200]
  std::vector<double> w400_cos_;         // [101]
  std::vector<double> w400_sin_;         // [101]
  std::vector<double> w5_cos_;           // [25]
  std::vector<double> w5_sin_;           // [25]
  std::vector<double> w25_cos_;          // [25]
  std::vector<double> w25_sin_;          // [25]
};

}  // namespace imcodes::qwen3
