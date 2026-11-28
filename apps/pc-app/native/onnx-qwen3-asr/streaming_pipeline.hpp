#pragma once

#include "qwen3_onnx_engine.hpp"
#include "qwen3_tokenizer.hpp"

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

namespace imcodes::qwen3 {

struct StreamingPipelineConfig {
  size_t initial_stride_samples{12800};        // 0.8s @ 16kHz
  size_t step_stride_samples{12800};           // 0.8s stride @ 16kHz
  size_t max_segment_samples{216000};          // 13.5s active segment cap
  size_t min_final_samples{1600};              // 100ms minimum audio for trailing segment finalization
  int rollback_token_count{5};
  int streaming_max_new_tokens{192};
  int final_max_new_tokens{384};
  bool expect_language_header{true};
  std::string hotwords_context;
  std::vector<std::string> hotword_terms;
  std::string language;
};

struct TranscriptUpdate {
  std::string text;
  bool is_final{false};
  std::string error;
};

/**
 * Thread-safe segmented streaming pipeline.
 * Matches macOS MLX `QwenSegmentedDecodeEngine` segmented streaming, pause-split/segment
 * rollover, silence-edge trimming, and hotword hallucination debounce/retraction.
 */
class Qwen3StreamingPipeline {
 public:
  using DecodeFn = std::function<DecodeResult(
      const std::vector<float>& samples_16k,
      const DecodeOptions& opts)>;
  using EmitResultFn = std::function<void(const TranscriptUpdate& update)>;
  using EmitEndFn = std::function<void()>;

  Qwen3StreamingPipeline(
      StreamingPipelineConfig config,
      const Qwen3Tokenizer& tokenizer,
      DecodeFn decode_fn,
      EmitResultFn emit_result_fn,
      EmitEndFn emit_end_fn = {});

  void preload(const std::vector<float>& initial_samples);
  bool push_samples(const float* data, size_t count);
  bool push_samples(const std::vector<float>& samples);
  bool can_accept_samples() const;

  void mark_producer_finished();
  void request_stop(bool abort_only, bool producer_also_finished);

  /** Blocking worker loop; returns once final result (or abort) finishes and emits end. */
  void run_loop();

 private:
  bool is_aborted() const;

  StreamingPipelineConfig config_;
  const Qwen3Tokenizer& tokenizer_;
  DecodeFn decode_fn_;
  EmitResultFn emit_result_fn_;
  EmitEndFn emit_end_fn_;

  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::vector<float> pending_samples_;
  size_t pending_head_{0};
  std::vector<float> active_segment_;
  bool producer_finished_{false};
  bool stop_requested_{false};
  bool aborted_{false};
};

}  // namespace imcodes::qwen3
