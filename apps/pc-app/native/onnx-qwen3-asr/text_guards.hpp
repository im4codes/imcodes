#pragma once

#include "qwen3_tokenizer.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace imcodes::qwen3 {

inline constexpr float kSpeechEnergyPeakThreshold = 0.015f;
inline constexpr float kSpeechEnergyWindowRmsThreshold = 0.005f;
inline constexpr size_t kMinPauseSplitSamples = 96000;   // 6.0s @ 16kHz
inline constexpr size_t kPauseWindowSamples = 6400;      // 400ms trailing silence window
inline constexpr size_t kPauseScanStrideSamples = 800;   // 50ms scan stride
inline constexpr float kPauseRmsThreshold = 0.012f;
inline constexpr float kSpeechPeakPauseThreshold = 0.02f;

struct SpeechEnergyBounds {
  bool found{false};
  size_t first{0};
  size_t last{0};
};

/** Locate first and last speech-energy sample bounds in audio. */
SpeechEnergyBounds scan_speech_energy_bounds(
    const std::vector<float>& samples,
    int sample_rate = 16000,
    bool stop_on_first = false);

/**
 * Returns true if audio contains speech above energy floor (peak >= 0.015 or
 * 50ms sliding window RMS >= 0.005).
 */
bool has_utterance_speech_energy(const std::vector<float>& samples, int sample_rate = 16000);

/**
 * Trim leading and trailing sub-threshold silence while preserving `pad_ms` of acoustic context
 * around speech bounds. Optionally outputs exact `out_start_sample` in the source buffer.
 */
std::vector<float> trim_silence_edges(
    const std::vector<float>& samples,
    int sample_rate = 16000,
    int pad_ms = 250,
    size_t* out_start_sample = nullptr);

/** Compute how many pending samples to append into active segment before hitting a natural 400ms pause after >=6s. */
size_t find_pause_split_take_count(
    const std::vector<float>& current_segment,
    const std::vector<float>& pending_samples,
    size_t pending_head,
    size_t max_take,
    const std::string& active_segment_text);

bool has_trailing_silence_pause(
    const std::vector<float>& segment_samples,
    const std::string& active_segment_text);

/** Strip `language <Lang><asr_text>`, `<asr_text>`, and `<|...|>` control tags without corrupting normal text. */
std::string strip_asr_control_tags(const std::string& input);

/** Extract user-facing transcript from decoded text, hiding partial `language ...` headers before `<asr_text>`. */
std::string extract_asr_transcript_after_header(const std::string& raw_text, bool expect_language_header);

/** Collapse single-char (>=8, digits >=16) and multi-codepoint (period 2..24 >=4x) repetition loops. */
std::string sanitize_asr_repetition_loop(const std::string& raw_input);

/** Join committed and active transcript segments, inserting a space only between adjacent ASCII alnum characters. */
std::string join_transcript_segments(const std::string& committed, const std::string& active);

struct HotwordMergeResult {
  std::string context;               // Comma+space joined string for prompt injection, empty if none
  std::vector<std::string> terms;    // Normalized deduped term list (max 60 terms, <=64 chars each, <=1000 total)
};

/**
 * Merge dynamic per-utterance hotwords ahead of static base hotwords (matching macOS mergeSessionHotwords):
 * max 60 terms, max 64 codepoints per term, max 1000 chars joined, case-insensitive dedup, strip controls.
 */
HotwordMergeResult merge_session_hotwords(
    const std::vector<std::string>& base_terms,
    const std::vector<std::string>& request_terms);

HotwordMergeResult merge_session_hotwords_raw(
    const std::vector<std::string>& base_terms,
    const std::string& request_hotwords_csv_or_lines);

using HotwordNfkcNormalizerFn = std::string (*)(const std::string&);

/** Override NFKC lowercase normalizer in unit tests; pass nullptr to restore OS default. */
void set_hotword_nfkc_normalizer_for_testing(HotwordNfkcNormalizerFn fn);

/**
 * Unified Rule A (same-hotword adjacent/cross-sentence repeat) + Rule B (>=3 distinct hotwords)
 * Trie-based hallucination filter matching shared/voice-hotwords.ts & macOS Swift & Win C++.
 * When `whole_only` is true, runs only the full-string check (used for >30s cross-segment merges).
 */
std::string strip_voice_hotword_hallucination(
    const std::string& text,
    const std::vector<std::string>& hotword_terms,
    bool allow_single = false,
    bool whole_only = false);

std::string strip_voice_hotword_hallucination_csv(
    const std::string& text,
    const std::string& hotwords_context,
    bool allow_single = false,
    bool whole_only = false);

/**
 * Compute prefix continuation tokens by keeping any `language <Lang><asr_text>` header intact,
 * trimming trailing EOS/PAD, rolling back `rollback_count` tokens, and backing off across any
 * incomplete multi-byte UTF-8 boundary (trailing U+FFFD).
 */
std::vector<int64_t> rollback_prefix_tokens(
    const std::vector<int64_t>& raw_tokens,
    const Qwen3Tokenizer& tokenizer,
    int rollback_count = 5,
    bool expect_language_header = false);

/** Check whether trailing decoder tokens exhibit degenerate repetition (64-token window <= 3 distinct tokens). */
bool is_degenerate_token_repetition(const std::vector<int64_t>& tokens, size_t window_size = 64, size_t min_unique = 3);

/** Trim degenerate repeated suffix if triggered. */
void trim_degenerate_token_tail(std::vector<int64_t>& tokens, size_t window_size = 64, size_t min_unique = 3);

}  // namespace imcodes::qwen3
