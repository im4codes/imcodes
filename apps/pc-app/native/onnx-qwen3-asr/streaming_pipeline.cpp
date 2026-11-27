#include "streaming_pipeline.hpp"

#include "text_guards.hpp"

#include <algorithm>
#include <chrono>
#include <cstddef>

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

void Qwen3StreamingPipeline::append_utterance_samples_locked(const float* data, size_t count) {
  if (count == 0 || exceeded_final_cap_) return;
  if (config_.max_final_redecode_samples == 0 ||
      full_utterance_samples_.size() + count > config_.max_final_redecode_samples) {
    exceeded_final_cap_ = true;
    std::vector<float>().swap(full_utterance_samples_);
    return;
  }
  full_utterance_samples_.insert(full_utterance_samples_.end(), data, data + count);
}

void Qwen3StreamingPipeline::preload(const std::vector<float>& initial_samples) {
  if (initial_samples.empty()) return;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (producer_finished_ || aborted_) return;
    pending_samples_.insert(pending_samples_.end(), initial_samples.begin(), initial_samples.end());
    append_utterance_samples_locked(initial_samples.data(), initial_samples.size());
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
      append_utterance_samples_locked(data, count);
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
  std::string active_text;
  std::string active_trusted_real_text;
  bool active_pending_single_hotword = false;
  bool pending_retraction_final = false;
  std::vector<int64_t> confirmed_prefix_tokens;
  std::string last_emitted_text;
  bool skip_next_wait = false;

  auto apply_guards_and_update = [&](
      const DecodeResult& decode_res,
      bool is_final_pass,
      const std::string& committed_base) {
    // DecodeFn (e.g. Qwen3OnnxEngine::decode) already enforces expect_language_header and returns
    // stripped text, while mocks/raw decoders may still include `<asr_text>`. Passing `false` here
    // strips any remaining `<asr_text>` header without wiping already-extracted clean text.
    const std::string raw_text = trim_copy(
        extract_asr_transcript_after_header(decode_res.text, false));
    const bool has_hotwords = !config_.hotword_terms.empty();

    if (!has_hotwords) {
      const std::string text = sanitize_asr_repetition_loop(raw_text);
      const bool hit_repetition_loop = (text != raw_text);
      active_text = text;
      if (hit_repetition_loop || is_final_pass) {
        confirmed_prefix_tokens.clear();
      } else {
        confirmed_prefix_tokens = rollback_prefix_tokens(
            decode_res.raw_tokens, tokenizer_, config_.rollback_token_count, config_.expect_language_header);
      }
      const std::string combined = join_transcript_segments(committed_base, active_text);
      if (is_final_pass || (!combined.empty() && combined != last_emitted_text)) {
        last_emitted_text = combined;
        emit_result_fn_({combined, is_final_pass, {}});
      }
      return;
    }

    const std::string pre_hallucination =
        strip_voice_hotword_hallucination(raw_text, config_.hotword_terms, false);
    const std::string after_repetition = sanitize_asr_repetition_loop(pre_hallucination);
    const std::string text =
        strip_voice_hotword_hallucination(after_repetition, config_.hotword_terms, false);
    const bool hit_hotword_hallucination =
        !raw_text.empty() && text.empty() && (pre_hallucination.empty() || !after_repetition.empty());
    const bool hit_any_guard = (text != raw_text);

    if (hit_hotword_hallucination ||
        (text.empty() && (active_pending_single_hotword || !active_trusted_real_text.empty()))) {
      confirmed_prefix_tokens.clear();
      if (!active_trusted_real_text.empty()) {
        active_text = active_trusted_real_text;
        const std::string combined = join_transcript_segments(committed_base, active_text);
        if (is_final_pass || (!combined.empty() && combined != last_emitted_text)) {
          last_emitted_text = combined;
          pending_retraction_final = false;
          emit_result_fn_({combined, is_final_pass, {}});
        }
      } else if (active_pending_single_hotword) {
        active_text.clear();
        active_pending_single_hotword = false;
        const std::string& combined = committed_base;
        if (!combined.empty()) {
          if (is_final_pass || combined != last_emitted_text) {
            last_emitted_text = combined;
            pending_retraction_final = false;
            emit_result_fn_({combined, is_final_pass, {}});
          }
        } else if (!last_emitted_text.empty() || is_final_pass || pending_retraction_final) {
          last_emitted_text.clear();
          pending_retraction_final = !is_final_pass;
          emit_result_fn_({"", is_final_pass, {}});
        }
      } else {
        active_text.clear();
        if (is_final_pass) {
          const std::string& combined = committed_base;
          last_emitted_text = combined;
          emit_result_fn_({combined, true, {}});
        }
      }
      return;
    }

    active_text = text;
    if (!text.empty()) {
      const bool has_real_non_hotword =
          !strip_voice_hotword_hallucination(text, config_.hotword_terms, true).empty();
      if (has_real_non_hotword) {
        active_trusted_real_text = text;
        active_pending_single_hotword = false;
      } else if (active_trusted_real_text.empty()) {
        active_pending_single_hotword = true;
      }
    }
    if (hit_any_guard || is_final_pass) {
      confirmed_prefix_tokens.clear();
    } else {
      confirmed_prefix_tokens = rollback_prefix_tokens(
          decode_res.raw_tokens, tokenizer_, config_.rollback_token_count, config_.expect_language_header);
    }
    const std::string combined = join_transcript_segments(committed_base, active_text);
    if (is_final_pass || (!combined.empty() && combined != last_emitted_text)) {
      last_emitted_text = combined;
      pending_retraction_final = false;
      emit_result_fn_({combined, is_final_pass, {}});
    }
  };

  auto best_retained_text = [&]() -> std::string {
    if (!committed_text.empty() && !active_text.empty()) {
      return join_transcript_segments(committed_text, active_text);
    }
    if (!last_emitted_text.empty()) {
      return last_emitted_text;
    }
    if (!committed_text.empty()) {
      return committed_text;
    }
    return active_text;
  };

  while (true) {
    bool abort_now = false;
    bool is_stop = false;
    bool is_producer_finished = false;
    bool has_remaining_pending = false;
    bool exceeded_cap = false;
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
        exceeded_cap = exceeded_final_cap_;
        current_len = active_segment_.size();
      }
    }

    if (abort_now) {
      break;
    }

    const bool is_final_pass = is_stop && is_producer_finished && !has_remaining_pending;

    if (is_final_pass) {
      if (!exceeded_cap) {
        std::vector<float> full_copy;
        {
          std::lock_guard<std::mutex> lock(mu_);
          full_copy = full_utterance_samples_;
        }
        const bool has_energy =
            !last_emitted_text.empty() || has_utterance_speech_energy(full_copy);
        if (full_copy.size() >= config_.min_final_samples && has_energy) {
          DecodeOptions opts;
          opts.hotwords_context = config_.hotwords_context;
          opts.language = config_.language;
          opts.prefix_tokens.clear();  // Always unprefixed full-utterance redecode <= 30s
          opts.max_new_tokens = config_.final_max_new_tokens;
          opts.should_cancel = [this]() { return is_aborted(); };
          const DecodeResult final_res = decode_fn_(full_copy, opts);
          if (is_aborted()) break;
          if (!final_res.cancelled && final_res.error.empty()) {
            committed_text.clear();
            active_trusted_real_text.clear();
            active_pending_single_hotword = false;
            apply_guards_and_update(final_res, true, "");
            break;
          }
          if (!final_res.error.empty()) {
            pending_retraction_final = false;
            emit_result_fn_({best_retained_text(), true, final_res.error});
            break;
          }
        }
        pending_retraction_final = false;
        emit_result_fn_({best_retained_text(), true, {}});
        break;
      }

      // > 30s: preserve committed segments and run one unprefixed final decode on active tail segment.
      std::vector<float> seg_copy;
      {
        std::lock_guard<std::mutex> lock(mu_);
        seg_copy = active_segment_;
      }
      const bool has_tail_energy =
          !active_text.empty() || has_utterance_speech_energy(seg_copy);
      if (seg_copy.size() >= config_.min_final_samples && has_tail_energy) {
        DecodeOptions opts;
        opts.hotwords_context = config_.hotwords_context;
        opts.language = config_.language;
        opts.prefix_tokens.clear();  // Unprefixed tail redecode
        opts.max_new_tokens = config_.final_max_new_tokens;
        opts.should_cancel = [this]() { return is_aborted(); };
        const DecodeResult final_res = decode_fn_(seg_copy, opts);
        if (is_aborted()) break;
        if (!final_res.cancelled && final_res.error.empty()) {
          apply_guards_and_update(final_res, true, committed_text);
          break;
        }
        if (!final_res.error.empty()) {
          pending_retraction_final = false;
          emit_result_fn_({best_retained_text(), true, final_res.error});
          break;
        }
      }
      pending_retraction_final = false;
      emit_result_fn_({best_retained_text(), true, {}});
      break;
    }

    const size_t new_count = current_len - last_decoded_count;
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

      if (active_text.empty() && !has_utterance_speech_energy(seg_copy)) {
        // Silent chunk: skip decode so hotwords cannot hallucinate.
      } else {
        DecodeOptions opts;
        opts.hotwords_context = config_.hotwords_context;
        opts.language = config_.language;
        opts.prefix_tokens = confirmed_prefix_tokens;
        opts.max_new_tokens = config_.streaming_max_new_tokens;
        opts.should_cancel = [this]() { return is_aborted(); };
        const DecodeResult res = decode_fn_(seg_copy, opts);
        if (is_aborted()) break;
        if (!res.cancelled && res.error.empty()) {
          apply_guards_and_update(res, false, committed_text);
        }
      }

      if (should_commit_segment) {
        committed_text = join_transcript_segments(committed_text, active_text);
        active_text.clear();
        active_trusted_real_text.clear();
        active_pending_single_hotword = false;
        confirmed_prefix_tokens.clear();
        {
          std::lock_guard<std::mutex> lock(mu_);
          active_segment_.clear();
          last_decoded_count = 0;
        }
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
