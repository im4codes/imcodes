#include "streaming_pipeline.hpp"

#include "text_guards.hpp"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <limits>

namespace imcodes::qwen3 {

namespace {

inline bool is_ws_char(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

std::string trim_copy(const std::string& s) {
  size_t b = 0;
  while (b < s.size() && is_ws_char(s[b])) ++b;
  size_t e = s.size();
  while (e > b && is_ws_char(s[e - 1])) --e;
  return s.substr(b, e - b);
}

}  // namespace

Qwen3StreamingPipeline::Qwen3StreamingPipeline(
    StreamingPipelineConfig config,
    const Qwen3Tokenizer& tokenizer,
    DecodeFn decode_fn,
    EmitResultFn emit_result_fn,
    EmitEndFn emit_end_fn)
    : config_(std::move(config)),
      tokenizer_(tokenizer),
      decode_fn_(std::move(decode_fn)),
      emit_result_fn_(std::move(emit_result_fn)),
      emit_end_fn_(std::move(emit_end_fn)) {}

void Qwen3StreamingPipeline::preload(const std::vector<float>& initial_samples) {
  if (initial_samples.empty()) return;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (producer_finished_ || aborted_) return;
    pending_samples_.insert(pending_samples_.end(), initial_samples.begin(), initial_samples.end());
  }
  cv_.notify_one();
}

bool Qwen3StreamingPipeline::push_samples(const float* data, size_t count) {
  if (!data || count == 0) return false;
  bool active = false;
  {
    std::lock_guard<std::mutex> lock(mu_);
    active = !producer_finished_ && !aborted_;
    if (active) {
      pending_samples_.insert(pending_samples_.end(), data, data + count);
    }
  }
  if (active) cv_.notify_one();
  return active;
}

bool Qwen3StreamingPipeline::push_samples(const std::vector<float>& samples) {
  return push_samples(samples.data(), samples.size());
}

bool Qwen3StreamingPipeline::can_accept_samples() const {
  std::lock_guard<std::mutex> lock(mu_);
  return !producer_finished_ && !aborted_;
}

void Qwen3StreamingPipeline::mark_producer_finished() {
  {
    std::lock_guard<std::mutex> lock(mu_);
    producer_finished_ = true;
  }
  cv_.notify_all();
}

void Qwen3StreamingPipeline::request_stop(bool abort_only, bool producer_also_finished) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    stop_requested_ = true;
    if (abort_only) {
      aborted_ = true;
      producer_finished_ = true;
    } else if (producer_also_finished) {
      producer_finished_ = true;
    }
  }
  cv_.notify_all();
}

bool Qwen3StreamingPipeline::is_aborted() const {
  std::lock_guard<std::mutex> lock(mu_);
  return aborted_;
}

void Qwen3StreamingPipeline::run_loop() {
  size_t last_decoded_count = 0;
  std::string committed_text;
  bool committed_has_trusted_real_text = false;
  bool committed_pending_single_hotword = false;
  std::string active_text;
  std::string active_trusted_real_text;
  bool active_pending_single_hotword = false;
  bool retracted_segment_single_hotword = false;
  bool pending_retraction_final = false;
  std::vector<int64_t> confirmed_prefix_tokens;
  size_t last_prefix_trim_start = std::numeric_limits<size_t>::max();
  std::string last_emitted_text;
  bool skip_next_wait = false;

  const bool has_hotwords = !config_.hotword_terms.empty();

  auto sanitize_combined_text = [&](const std::string& raw_combined) -> std::string {
    if (!has_hotwords || raw_combined.empty()) return raw_combined;
    return strip_voice_hotword_hallucination(raw_combined, config_.hotword_terms, false, true);
  };

  auto text_has_real_non_hotword = [&](const std::string& t) -> bool {
    if (t.empty()) return false;
    if (!has_hotwords) return true;
    return !strip_voice_hotword_hallucination(t, config_.hotword_terms, true).empty();
  };

  struct SanitizeDecodedResult {
    std::string text;
    bool hit_hallucination{false};
    bool hit_any_guard{false};
    bool has_real_non_hotword{false};
  };

  auto sanitize_decoded = [&](const DecodeResult& decode_res) -> SanitizeDecodedResult {
    SanitizeDecodedResult r;
    const std::string raw_text = trim_copy(
        extract_asr_transcript_after_header(decode_res.text, false));
    if (!has_hotwords) {
      r.text = sanitize_asr_repetition_loop(raw_text);
      r.hit_any_guard = (r.text != raw_text);
      r.has_real_non_hotword = !r.text.empty();
      return r;
    }
    const std::string pre_hallucination =
        strip_voice_hotword_hallucination(raw_text, config_.hotword_terms, false);
    const std::string after_repetition = sanitize_asr_repetition_loop(pre_hallucination);
    r.text = strip_voice_hotword_hallucination(after_repetition, config_.hotword_terms, false);
    r.hit_hallucination =
        !raw_text.empty() && r.text.empty() && (pre_hallucination.empty() || !after_repetition.empty());
    r.hit_any_guard = (r.text != raw_text);
    r.has_real_non_hotword = text_has_real_non_hotword(r.text);
    return r;
  };

  auto best_retained_text = [&]() -> std::string {
    std::string candidate;
    if (!committed_text.empty() && !active_text.empty()) {
      candidate = join_transcript_segments(committed_text, active_text);
    } else if (!last_emitted_text.empty()) {
      candidate = last_emitted_text;
    } else if (!committed_text.empty()) {
      candidate = committed_text;
    } else {
      candidate = active_text;
    }
    if (has_hotwords && !candidate.empty()) {
      const std::string sanitized = sanitize_combined_text(candidate);
      if (sanitized.empty() && !committed_has_trusted_real_text) {
        return {};
      }
      if (!sanitized.empty()) return sanitized;
    }
    return candidate;
  };

  while (true) {
    bool abort_now = false;
    bool is_stop = false;
    bool is_producer_finished = false;
    bool has_remaining_pending = false;
    size_t current_len = 0;

    {
      std::unique_lock<std::mutex> lock(mu_);
      if (!skip_next_wait) {
        cv_.wait_for(lock, std::chrono::milliseconds(150), [this]() {
          return aborted_ ||
                 pending_head_ < pending_samples_.size() ||
                 (stop_requested_ && producer_finished_);
        });
      }
      skip_next_wait = false;

      if (aborted_) {
        abort_now = true;
      } else {
        const size_t available = pending_samples_.size() - pending_head_;
        const size_t space = config_.max_segment_samples > active_segment_.size()
            ? (config_.max_segment_samples - active_segment_.size())
            : 0;
        const size_t max_take = std::min(space, available);
        const size_t take = find_pause_split_take_count(
            active_segment_, pending_samples_, pending_head_, max_take, active_text);
        if (take > 0) {
          active_segment_.insert(
              active_segment_.end(),
              pending_samples_.begin() + static_cast<std::ptrdiff_t>(pending_head_),
              pending_samples_.begin() + static_cast<std::ptrdiff_t>(pending_head_ + take));
          pending_head_ += take;
          if (pending_head_ == pending_samples_.size()) {
            pending_samples_.clear();
            pending_head_ = 0;
          }
        }
        has_remaining_pending = (pending_head_ < pending_samples_.size());
        is_stop = stop_requested_;
        is_producer_finished = producer_finished_;
        current_len = active_segment_.size();
      }
    }

    if (abort_now) {
      break;
    }

    const size_t new_count = current_len - last_decoded_count;
    const bool is_final_pass = is_stop && is_producer_finished && !has_remaining_pending;

    if (is_final_pass) {
      // Segmented finalization: if no new undecoded samples arrived since the last pass
      // (new_count == 0), emit finalized text with zero extra decode calls; otherwise decode
      // only active_segment_ while preserving confirmed_prefix_tokens and committed_text.
      std::string final_seg = active_text;
      if (new_count > 0) {
        std::vector<float> seg_copy;
        {
          std::lock_guard<std::mutex> lock(mu_);
          seg_copy = active_segment_;
          last_decoded_count = current_len;
        }
        if (seg_copy.size() >= config_.min_final_samples) {
          size_t trim_start = 0;
          const std::vector<float> trimmed_tail =
              trim_silence_edges(seg_copy, 16000, 250, &trim_start);
          if (trimmed_tail.empty()) {
            confirmed_prefix_tokens.clear();
            last_prefix_trim_start = std::numeric_limits<size_t>::max();
            if (has_hotwords) {
              final_seg = active_trusted_real_text;
            }
          } else {
            if (last_prefix_trim_start != std::numeric_limits<size_t>::max() &&
                trim_start != last_prefix_trim_start) {
              confirmed_prefix_tokens.clear();
            }
            last_prefix_trim_start = trim_start;

            DecodeOptions opts;
            opts.hotwords_context = config_.hotwords_context;
            opts.language = config_.language;
            opts.prefix_tokens = confirmed_prefix_tokens;
            opts.max_new_tokens = config_.final_max_new_tokens;
            opts.should_cancel = [this]() { return is_aborted(); };
            const DecodeResult final_res = decode_fn_(trimmed_tail, opts);
            if (is_aborted()) break;
            if (!final_res.error.empty()) {
              emit_result_fn_({best_retained_text(), true, final_res.error});
              break;
            }
            if (!final_res.cancelled) {
              const auto san = sanitize_decoded(final_res);
              if (has_hotwords) {
                if (san.has_real_non_hotword && !committed_text.empty()) {
                  committed_has_trusted_real_text = true;
                  committed_pending_single_hotword = false;
                }
                const bool blocked_single_only = !san.text.empty() && !san.has_real_non_hotword &&
                    (retracted_segment_single_hotword || pending_retraction_final || !active_trusted_real_text.empty());
                if (san.hit_hallucination || blocked_single_only || san.text.empty()) {
                  if (active_pending_single_hotword && san.hit_hallucination) {
                    retracted_segment_single_hotword = true;
                  }
                  final_seg = active_trusted_real_text;
                } else {
                  final_seg = san.text;
                }
              } else if (!san.text.empty()) {
                final_seg = san.text;
              }
            }
          }
        } else if (has_hotwords) {
          final_seg = active_trusted_real_text;
        }
      }

      const bool drop_retracted_single_committed =
          has_hotwords &&
          committed_pending_single_hotword &&
          !committed_has_trusted_real_text &&
          (retracted_segment_single_hotword || pending_retraction_final);
      const std::string base_committed =
          drop_retracted_single_committed ? std::string{} : committed_text;
      const std::string raw_final = join_transcript_segments(base_committed, final_seg);
      std::string final_text = sanitize_combined_text(raw_final);
      if (has_hotwords && final_text.empty() && !raw_final.empty() && committed_has_trusted_real_text) {
        final_text = committed_text;
      }
      if (has_hotwords &&
          retracted_segment_single_hotword &&
          !committed_has_trusted_real_text &&
          !final_text.empty() &&
          !text_has_real_non_hotword(final_text)) {
        final_text.clear();
      }
      emit_result_fn_({final_text, true, {}});
      break;
    }

    const size_t threshold = (last_decoded_count == 0) ? config_.initial_stride_samples : config_.step_stride_samples;
    const bool reached_segment_cap = (current_len >= config_.max_segment_samples);
    const bool reached_pause_split =
        !reached_segment_cap && has_trailing_silence_pause(active_segment_, active_text);
    const bool should_commit_segment = reached_segment_cap || reached_pause_split;

    if (new_count >= threshold || (reached_segment_cap && has_remaining_pending) || reached_pause_split) {
      std::vector<float> seg_copy;
      {
        std::lock_guard<std::mutex> lock(mu_);
        seg_copy = active_segment_;
        last_decoded_count = current_len;
      }

      size_t trim_start = 0;
      const std::vector<float> trimmed_seg = trim_silence_edges(seg_copy, 16000, 250, &trim_start);
      if (trimmed_seg.empty()) {
        // Sub-threshold silence chunk: skip decode so hotwords cannot hallucinate.
        confirmed_prefix_tokens.clear();
        last_prefix_trim_start = std::numeric_limits<size_t>::max();
      } else {
        // Anchor prefix continuation to the exact trimmed audio origin; clear if leading trim boundary shifted.
        if (last_prefix_trim_start != std::numeric_limits<size_t>::max() && trim_start != last_prefix_trim_start) {
          confirmed_prefix_tokens.clear();
        }
        last_prefix_trim_start = trim_start;

        DecodeOptions opts;
        opts.hotwords_context = config_.hotwords_context;
        opts.language = config_.language;
        opts.prefix_tokens = confirmed_prefix_tokens;
        opts.max_new_tokens = config_.streaming_max_new_tokens;
        opts.should_cancel = [this]() { return is_aborted(); };
        const DecodeResult res = decode_fn_(trimmed_seg, opts);
        if (is_aborted()) break;
        if (!res.cancelled && res.error.empty()) {
          const auto san = sanitize_decoded(res);
          if (has_hotwords && san.hit_hallucination) {
            confirmed_prefix_tokens.clear();
            if (active_pending_single_hotword) {
              retracted_segment_single_hotword = true;
            }
            active_pending_single_hotword = false;
            if (!active_trusted_real_text.empty()) {
              active_text = active_trusted_real_text;
            } else {
              active_text.clear();
            }
            const std::string fallback = join_transcript_segments(committed_text, active_text);
            if (fallback != last_emitted_text && (!fallback.empty() || !last_emitted_text.empty())) {
              last_emitted_text = fallback;
              if (fallback.empty()) pending_retraction_final = true;
              emit_result_fn_({fallback, false, {}});
            }
          } else if (!san.text.empty()) {
            active_text = san.text;
            if (has_hotwords) {
              if (san.has_real_non_hotword) {
                active_trusted_real_text = san.text;
                active_pending_single_hotword = false;
                retracted_segment_single_hotword = false;
                if (!committed_text.empty()) {
                  committed_has_trusted_real_text = true;
                  committed_pending_single_hotword = false;
                }
              } else if (active_trusted_real_text.empty()) {
                active_pending_single_hotword = true;
              }
            }
            if (san.hit_any_guard) {
              confirmed_prefix_tokens.clear();
            } else {
              confirmed_prefix_tokens = rollback_prefix_tokens(
                  res.raw_tokens, tokenizer_, config_.rollback_token_count, config_.expect_language_header);
            }
          } else if (san.hit_any_guard) {
            confirmed_prefix_tokens.clear();
          }
        }
      }

      const std::string& effective_seg = active_text;
      const std::string combined_raw = join_transcript_segments(committed_text, effective_seg);
      const std::string combined = sanitize_combined_text(combined_raw);
      if (has_hotwords && !combined_raw.empty() && combined.empty()) {
        active_text.clear();
        active_trusted_real_text.clear();
        active_pending_single_hotword = false;
        retracted_segment_single_hotword = true;
        confirmed_prefix_tokens.clear();
        if (!committed_has_trusted_real_text) {
          committed_text.clear();
          committed_pending_single_hotword = false;
        }
        if (should_commit_segment) {
          std::lock_guard<std::mutex> lock(mu_);
          active_segment_.clear();
          last_decoded_count = 0;
          last_prefix_trim_start = std::numeric_limits<size_t>::max();
        }
        if (!last_emitted_text.empty()) {
          last_emitted_text.clear();
          pending_retraction_final = true;
          emit_result_fn_({"", false, {}});
        }
        if (should_commit_segment && has_remaining_pending) {
          skip_next_wait = true;
          continue;
        }
      } else if (should_commit_segment) {
        if (!effective_seg.empty()) {
          const bool combined_real = text_has_real_non_hotword(combined);
          if (has_hotwords && (!active_trusted_real_text.empty() || combined_real)) {
            committed_has_trusted_real_text = true;
            committed_pending_single_hotword = false;
          } else if (!has_hotwords) {
            committed_has_trusted_real_text = true;
          } else if (!committed_has_trusted_real_text && !combined.empty()) {
            committed_pending_single_hotword = true;
          }
          committed_text = combined;
        }
        active_text.clear();
        active_trusted_real_text.clear();
        active_pending_single_hotword = false;
        confirmed_prefix_tokens.clear();
        last_prefix_trim_start = std::numeric_limits<size_t>::max();
        {
          std::lock_guard<std::mutex> lock(mu_);
          active_segment_.clear();
          last_decoded_count = 0;
        }
        if (!combined.empty() && combined != last_emitted_text) {
          last_emitted_text = combined;
          pending_retraction_final = false;
          emit_result_fn_({combined, false, {}});
        }
      } else if (!combined.empty() && combined != last_emitted_text) {
        last_emitted_text = combined;
        pending_retraction_final = false;
        emit_result_fn_({combined, false, {}});
      }
    }

    if (has_remaining_pending || (is_stop && is_producer_finished)) {
      skip_next_wait = true;
    }
  }

  if (emit_end_fn_) {
    emit_end_fn_();
  }
}

}  // namespace imcodes::qwen3
