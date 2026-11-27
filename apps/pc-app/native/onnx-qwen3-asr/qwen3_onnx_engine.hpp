#pragma once

#include "mel_features.hpp"
#include "qwen3_tokenizer.hpp"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace imcodes::qwen3 {

struct EngineConfig {
  std::filesystem::path model_dir;
  std::string requested_provider{"auto"};  // "auto" | "cpu" | "directml" | "cuda"
  int num_threads{0};                      // 0 = auto
  int64_t max_total_len{1024};
  int directml_device_id{0};
  int cuda_device_id{0};
};

struct DecodeOptions {
  std::string hotwords_context;
  std::string language;  // empty or "auto" for auto-detect
  std::vector<int64_t> prefix_tokens;
  int max_new_tokens{256};
  std::function<bool()> should_cancel;
};

struct DecodeResult {
  std::string text;                   // Clean transcript without `language <Lang><asr_text>` header
  std::vector<int64_t> raw_tokens;    // Complete non-EOS tokens (includes header in auto-detect mode)
  int generated_steps{0};
  int prefill_len{0};
  int64_t mel_ms{0};
  int64_t conv_ms{0};
  int64_t enc_ms{0};
  int64_t prefill_ms{0};
  int64_t decode_loop_ms{0};
  bool cancelled{false};
  std::string error;
};

/** Normalize BCP-47 tag or language name to Qwen3-ASR canonical name; returns empty string for auto-detect. */
std::string resolve_qwen3_language(const std::string& raw_language);

/**
 * Pure C++20 ONNX Runtime inference engine for Qwen3-ASR (conv_frontend + encoder.int8 + decoder.int8).
 * Supports single-shot prefill with prefix_tokens, incremental KV-cache decoding, dynamic per-utterance
 * hotwords injection, cooperative cancellation, fp32/fp16/uint16 tensors, and CPU/DirectML/CUDA EPs.
 */
class Qwen3OnnxEngine {
 public:
  Qwen3OnnxEngine();
  ~Qwen3OnnxEngine();

  Qwen3OnnxEngine(const Qwen3OnnxEngine&) = delete;
  Qwen3OnnxEngine& operator=(const Qwen3OnnxEngine&) = delete;

  bool init(const EngineConfig& config, std::string& out_error);
  bool is_initialized() const;

  DecodeResult decode(const std::vector<float>& samples_16k, const DecodeOptions& opts);

  const std::string& active_provider() const { return active_provider_; }
  const Qwen3Tokenizer& tokenizer() const { return tokenizer_; }
  int64_t max_total_len() const { return effective_max_total_len_; }
  int64_t kv_physical_len() const { return kv_physical_len_; }
  int num_layers() const { return num_layers_; }

  /**
   * Trim trailing near-zero encoder frames (abs <= threshold, default 1e-6f).
   * Returns count of leading effective frames (0 if all frames are near-zero).
   */
  static int64_t trim_audio_features_f32(
      const float* data,
      int64_t num_frames,
      int64_t hidden_dim,
      float threshold = 1e-6f);
  static int64_t trim_audio_features_f16(
      const uint16_t* data,
      int64_t num_frames,
      int64_t hidden_dim,
      float threshold = 1e-6f);

  /**
   * Pure helper exposed for testing prompt assembly & KV length clamping without requiring live ORT sessions.
   * Ensures total context_len stays strictly < max_total_len while preserving UTF-8 and header boundaries.
   */
  static void build_bounded_prompt_tokens(
      const Qwen3Tokenizer& tokenizer,
      const std::string& hotwords_context,
      const std::string& resolved_language,
      int64_t audio_token_count,
      const std::vector<int64_t>& requested_prefix_tokens,
      int64_t max_total_len,
      int max_new_tokens,
      std::vector<int64_t>& out_source_ids,
      std::vector<int64_t>& out_effective_prefix,
      int64_t& out_effective_audio_tokens);

 private:
  struct OrtState;

  Qwen3Tokenizer tokenizer_;
  WhisperMelExtractor mel_extractor_;
  EngineConfig config_;
  std::string active_provider_{"cpu"};
  [[maybe_unused]] int num_layers_{0};
  [[maybe_unused]] int64_t num_kv_heads_{0};
  [[maybe_unused]] int64_t head_dim_{0};
  [[maybe_unused]] int64_t audio_hidden_dim_{0};
  [[maybe_unused]] int64_t vocab_size_{0};
  [[maybe_unused]] int64_t kv_physical_len_{1024};
  [[maybe_unused]] int64_t effective_max_total_len_{1024};
  std::mutex decode_mutex_;
  std::unique_ptr<OrtState> ort_;
};

}  // namespace imcodes::qwen3
