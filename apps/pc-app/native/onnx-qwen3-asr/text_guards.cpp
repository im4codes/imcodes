#include "text_guards.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <unordered_map>
#include <unordered_set>

namespace imcodes::qwen3 {

namespace {

inline bool is_ascii_ws(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

inline bool is_ascii_alnum(unsigned char c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

inline bool is_lang_token_char(unsigned char c) {
  return is_ascii_alnum(c) || c == '_' || c == '-';
}

std::string trim_ascii_ws(const std::string& input) {
  size_t start = 0;
  while (start < input.size() && is_ascii_ws(input[start])) ++start;
  size_t end = input.size();
  while (end > start && is_ascii_ws(input[end - 1])) --end;
  return input.substr(start, end - start);
}

std::vector<uint32_t> utf8_to_codepoints(const std::string& s) {
  std::vector<uint32_t> cps;
  cps.reserve(s.size());
  size_t i = 0;
  const size_t n = s.size();
  while (i < n) {
    const auto b = static_cast<unsigned char>(s[i]);
    if (b < 0x80) {
      cps.push_back(b);
      i += 1;
    } else if ((b & 0xE0) == 0xC0 && i + 1 < n) {
      const auto b1 = static_cast<unsigned char>(s[i + 1]);
      if ((b1 & 0xC0) == 0x80) {
        cps.push_back((static_cast<uint32_t>(b & 0x1F) << 6) | static_cast<uint32_t>(b1 & 0x3F));
        i += 2;
      } else {
        cps.push_back(0xFFFD);
        i += 1;
      }
    } else if ((b & 0xF0) == 0xE0 && i + 2 < n) {
      const auto b1 = static_cast<unsigned char>(s[i + 1]);
      const auto b2 = static_cast<unsigned char>(s[i + 2]);
      if ((b1 & 0xC0) == 0x80 && (b2 & 0xC0) == 0x80) {
        cps.push_back((static_cast<uint32_t>(b & 0x0F) << 12) |
                      (static_cast<uint32_t>(b1 & 0x3F) << 6) |
                      static_cast<uint32_t>(b2 & 0x3F));
        i += 3;
      } else {
        cps.push_back(0xFFFD);
        i += 1;
      }
    } else if ((b & 0xF8) == 0xF0 && i + 3 < n) {
      const auto b1 = static_cast<unsigned char>(s[i + 1]);
      const auto b2 = static_cast<unsigned char>(s[i + 2]);
      const auto b3 = static_cast<unsigned char>(s[i + 3]);
      if ((b1 & 0xC0) == 0x80 && (b2 & 0xC0) == 0x80 && (b3 & 0xC0) == 0x80) {
        cps.push_back((static_cast<uint32_t>(b & 0x07) << 18) |
                      (static_cast<uint32_t>(b1 & 0x3F) << 12) |
                      (static_cast<uint32_t>(b2 & 0x3F) << 6) |
                      static_cast<uint32_t>(b3 & 0x3F));
        i += 4;
      } else {
        cps.push_back(0xFFFD);
        i += 1;
      }
    } else {
      cps.push_back(0xFFFD);
      i += 1;
    }
  }
  return cps;
}

void append_codepoint_utf8(std::string& out, uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

std::string codepoints_to_utf8(const std::vector<uint32_t>& cps) {
  std::string out;
  out.reserve(cps.size() * 2);
  for (uint32_t cp : cps) {
    append_codepoint_utf8(out, cp);
  }
  return out;
}

bool is_meaningful_codepoint(uint32_t cp) {
  if (cp < 0x80) {
    return (cp >= '0' && cp <= '9') || (cp >= 'A' && cp <= 'Z') || (cp >= 'a' && cp <= 'z');
  }
  if (cp >= 0x2000 && cp <= 0x206F) return false;
  if (cp >= 0x3000 && cp <= 0x303F) return false;
  if (cp >= 0xFF01 && cp <= 0xFF0F) return false;
  if (cp >= 0xFF1A && cp <= 0xFF20) return false;
  if (cp >= 0xFF3B && cp <= 0xFF40) return false;
  if (cp >= 0xFF5B && cp <= 0xFF65) return false;
  return true;
}

bool collapse_cp_runs_for_period(std::vector<uint32_t>& cps, size_t period) {
  const size_t n = cps.size();
  if (n < period * 2) return false;
  std::vector<std::pair<size_t, size_t>> remove_ranges;
  if (period == 1) {
    size_t run_start = 0;
    for (size_t i = 1; i <= n; ++i) {
      if (i < n && cps[i] == cps[run_start]) continue;
      const size_t run_len = i - run_start;
      const size_t threshold = (cps[run_start] >= '0' && cps[run_start] <= '9') ? 16 : 8;
      if (run_len >= threshold) {
        remove_ranges.emplace_back(run_start, i);
      }
      run_start = i;
    }
  } else {
    const size_t min_match_len = period * 4;
    size_t match_len = 0;
    for (size_t i = period; i <= n; ++i) {
      if (i < n && cps[i] == cps[i - period]) {
        match_len += 1;
        continue;
      }
      if (match_len >= min_match_len) {
        const size_t run_end = i;
        const size_t run_start = run_end - match_len - period;
        bool uniform = true;
        for (size_t k = 1; k < period; ++k) {
          if (cps[run_start + k] != cps[run_start]) {
            uniform = false;
            break;
          }
        }
        if (!uniform) {
          if (!remove_ranges.empty() && run_start < remove_ranges.back().second) {
            if (run_end > remove_ranges.back().second) {
              remove_ranges.back().second = run_end;
            }
          } else {
            remove_ranges.emplace_back(run_start, run_end);
          }
        }
      }
      match_len = 0;
    }
  }
  if (remove_ranges.empty()) return false;
  std::vector<uint32_t> out;
  out.reserve(n);
  size_t cursor = 0;
  for (const auto& r : remove_ranges) {
    for (size_t j = cursor; j < r.first; ++j) out.push_back(cps[j]);
    cursor = r.second;
  }
  for (size_t j = cursor; j < n; ++j) out.push_back(cps[j]);
  cps = std::move(out);
  return true;
}

inline bool is_ascii_alnum_or_underscore(uint32_t cp) {
  return (cp >= '0' && cp <= '9') || (cp >= 'A' && cp <= 'Z') ||
         (cp >= 'a' && cp <= 'z') || cp == '_';
}

inline bool is_hotword_separator(uint32_t cp) {
  if (cp == ' ' || cp == '\t' || cp == '\r' || cp == '\n' || cp == '\f' || cp == '\v') return true;
  if (cp == 0x00A0 || cp == 0x200B || cp == 0x3000) return true;
  if (cp < 0x80) {
    return !is_ascii_alnum(static_cast<unsigned char>(cp));
  }
  if (cp >= 0x2000 && cp <= 0x206F) return true;
  if (cp >= 0x3000 && cp <= 0x303F) return true;
  if (cp >= 0xFF01 && cp <= 0xFF0F) return true;
  if (cp >= 0xFF1A && cp <= 0xFF20) return true;
  if (cp >= 0xFF3B && cp <= 0xFF40) return true;
  if (cp >= 0xFF5B && cp <= 0xFF65) return true;
  return false;
}

inline uint32_t normalize_hotword_cp(uint32_t cp) {
  if (cp >= 'A' && cp <= 'Z') return cp + ('a' - 'A');
  // Fullwidth ASCII variants U+FF01..U+FF5E -> U+0021..U+007E
  if (cp >= 0xFF01 && cp <= 0xFF5E) {
    uint32_t mapped = cp - 0xFEE0;
    if (mapped >= 'A' && mapped <= 'Z') mapped += ('a' - 'A');
    return mapped;
  }
  switch (cp) {
    case 0x2010:
    case 0x2011:
    case 0x2012:
    case 0x2013:
    case 0x2014:
    case 0x2015:
    case 0x2212:
    case 0xFE58:
    case 0xFE63:
      return '-';
    case 0x2018:
    case 0x2019:
    case 0x201A:
    case 0x201B:
      return '\'';
    case 0x201C:
    case 0x201D:
    case 0x201E:
    case 0x201F:
      return '"';
    case 0xFF61:
      return '.';
    default:
      return cp;
  }
}

std::vector<uint32_t> normalize_hotword_cps(const std::string& raw) {
  std::vector<uint32_t> cps = utf8_to_codepoints(raw);
  for (uint32_t& cp : cps) {
    cp = normalize_hotword_cp(cp);
  }
  return cps;
}

struct HotwordTrieNode {
  std::unordered_map<uint32_t, std::unique_ptr<HotwordTrieNode>> children;
  int term_id{-1};
};

std::string strip_control_and_trim_utf8(const std::string& raw, size_t max_codepoints) {
  const std::vector<uint32_t> cps = utf8_to_codepoints(raw);
  std::vector<uint32_t> cleaned;
  cleaned.reserve(cps.size());
  for (uint32_t cp : cps) {
    if (cp < 0x20 || cp == 0x7F || (cp >= 0x80 && cp <= 0x9F)) continue;
    cleaned.push_back(cp);
  }
  auto is_ws = [](uint32_t cp) {
    return cp == ' ' || cp == '\t' || cp == '\r' || cp == '\n' || cp == 0x00A0 || cp == 0x3000;
  };
  size_t s = 0;
  while (s < cleaned.size() && is_ws(cleaned[s])) ++s;
  size_t e = cleaned.size();
  while (e > s && is_ws(cleaned[e - 1])) --e;
  if (max_codepoints > 0 && e - s > max_codepoints) {
    e = s + max_codepoints;
    while (e > s && is_ws(cleaned[e - 1])) --e;
  }
  std::string out;
  for (size_t i = s; i < e; ++i) {
    append_codepoint_utf8(out, cleaned[i]);
  }
  return out;
}

std::string ascii_lowercase(const std::string& s) {
  std::string out = s;
  for (char& ch : out) {
    if (ch >= 'A' && ch <= 'Z') {
      ch = static_cast<char>(ch - 'A' + 'a');
    }
  }
  return out;
}

}  // namespace

bool has_utterance_speech_energy(const std::vector<float>& samples, int sample_rate) {
  const size_t count = samples.size();
  if (count == 0) return false;
  const int rate = sample_rate > 0 ? sample_rate : 16000;
  const size_t window_samples = std::max<size_t>(1, static_cast<size_t>(std::llround(static_cast<double>(rate) * 0.05)));
  const double rms_sq_threshold =
      static_cast<double>(kSpeechEnergyWindowRmsThreshold) * static_cast<double>(kSpeechEnergyWindowRmsThreshold);

  double window_sum_sq = 0.0;
  for (size_t i = 0; i < count; ++i) {
    const float s = samples[i];
    if (std::fabs(s) >= kSpeechEnergyPeakThreshold) {
      return true;
    }
    const double d = static_cast<double>(s);
    window_sum_sq += d * d;
    if (i >= window_samples) {
      const double old = static_cast<double>(samples[i - window_samples]);
      window_sum_sq -= old * old;
      if (window_sum_sq < 0.0) window_sum_sq = 0.0;
    }
    if (i + 1 >= window_samples && (window_sum_sq / static_cast<double>(window_samples)) >= rms_sq_threshold) {
      return true;
    }
  }
  if (count < window_samples && (window_sum_sq / static_cast<double>(count)) >= rms_sq_threshold) {
    return true;
  }
  return false;
}

namespace {

inline float window_rms_span(const std::vector<float>& a, const std::vector<float>& b, size_t b_head, size_t start, size_t count) {
  if (count == 0) return 0.0f;
  double sum_sq = 0.0;
  const size_t a_len = a.size();
  for (size_t i = 0; i < count; ++i) {
    const size_t pos = start + i;
    const float v = (pos < a_len) ? a[pos] : b[b_head + (pos - a_len)];
    sum_sq += static_cast<double>(v) * static_cast<double>(v);
  }
  return static_cast<float>(std::sqrt(sum_sq / static_cast<double>(count)));
}

inline float window_peak_span(const std::vector<float>& a, const std::vector<float>& b, size_t b_head, size_t start, size_t count) {
  float peak = 0.0f;
  const size_t a_len = a.size();
  for (size_t i = 0; i < count; ++i) {
    const size_t pos = start + i;
    const float v = std::fabs((pos < a_len) ? a[pos] : b[b_head + (pos - a_len)]);
    if (v > peak) peak = v;
  }
  return peak;
}

}  // namespace

size_t find_pause_split_take_count(
    const std::vector<float>& current_segment,
    const std::vector<float>& pending_samples,
    size_t pending_head,
    size_t max_take,
    const std::string& active_segment_text) {
  if (max_take == 0) return 0;
  if (active_segment_text.empty()) return max_take;
  const size_t cur_len = current_segment.size();
  const size_t total_avail = cur_len + max_take;
  if (total_avail < kMinPauseSplitSamples || total_avail < kPauseWindowSamples) {
    return max_take;
  }
  const size_t first_end = std::max(cur_len + 1, kMinPauseSplitSamples);
  for (size_t end_pos = first_end; end_pos <= total_avail; end_pos += kPauseScanStrideSamples) {
    const size_t win_start = end_pos - kPauseWindowSamples;
    const float rms = window_rms_span(current_segment, pending_samples, pending_head, win_start, kPauseWindowSamples);
    const float peak = window_peak_span(current_segment, pending_samples, pending_head, win_start, kPauseWindowSamples);
    if (rms < kPauseRmsThreshold && peak < kSpeechPeakPauseThreshold) {
      return end_pos - cur_len;
    }
  }
  const float tail_rms = window_rms_span(current_segment, pending_samples, pending_head,
                                         total_avail - kPauseWindowSamples, kPauseWindowSamples);
  const float tail_peak = window_peak_span(current_segment, pending_samples, pending_head,
                                           total_avail - kPauseWindowSamples, kPauseWindowSamples);
  if (tail_rms < kPauseRmsThreshold && tail_peak < kSpeechPeakPauseThreshold) {
    return max_take;
  }
  return max_take;
}

bool has_trailing_silence_pause(const std::vector<float>& segment_samples, const std::string& active_segment_text) {
  if (active_segment_text.empty()) return false;
  if (segment_samples.size() < kMinPauseSplitSamples || segment_samples.size() < kPauseWindowSamples) {
    return false;
  }
  const size_t start = segment_samples.size() - kPauseWindowSamples;
  double sum_sq = 0.0;
  float peak = 0.0f;
  for (size_t i = start; i < segment_samples.size(); ++i) {
    const float v = segment_samples[i];
    const float av = std::fabs(v);
    if (av > peak) peak = av;
    sum_sq += static_cast<double>(v) * static_cast<double>(v);
  }
  const float rms = static_cast<float>(std::sqrt(sum_sq / static_cast<double>(kPauseWindowSamples)));
  return rms < kPauseRmsThreshold && peak < kSpeechPeakPauseThreshold;
}

std::string strip_asr_control_tags(const std::string& input) {
  if (input.empty()) return {};
  std::string out;
  out.reserve(input.size());
  size_t i = 0;
  const std::string kAsrTag = "<asr_text>";
  const std::string kLangPrefix = "language";
  while (i < input.size()) {
    if (i + kLangPrefix.size() < input.size() &&
        input.compare(i, kLangPrefix.size(), kLangPrefix) == 0 &&
        (i == 0 || (!is_ascii_alnum(static_cast<unsigned char>(input[i - 1])) && input[i - 1] != '_'))) {
      size_t p = i + kLangPrefix.size();
      if (p < input.size() && is_ascii_ws(input[p])) {
        while (p < input.size() && is_ascii_ws(input[p])) ++p;
        const size_t lang_start = p;
        while (p < input.size() && is_lang_token_char(static_cast<unsigned char>(input[p]))) ++p;
        if (p > lang_start) {
          while (p < input.size() && is_ascii_ws(input[p])) ++p;
          if (p + kAsrTag.size() <= input.size() && input.compare(p, kAsrTag.size(), kAsrTag) == 0) {
            i = p + kAsrTag.size();
            continue;
          }
        }
      }
    }
    if (i + kAsrTag.size() <= input.size() && input.compare(i, kAsrTag.size(), kAsrTag) == 0) {
      i += kAsrTag.size();
      continue;
    }
    if (i + 2 < input.size() && input[i] == '<' && input[i + 1] == '|') {
      size_t p = i + 2;
      while (p < input.size() && (p - (i + 2)) <= 48 &&
             input[p] != '|' && input[p] != '>' && input[p] != '\r' && input[p] != '\n') {
        ++p;
      }
      const size_t body_len = p - (i + 2);
      if (body_len >= 1 && body_len <= 48 && p + 1 < input.size() &&
          input[p] == '|' && input[p + 1] == '>') {
        i = p + 2;
        continue;
      }
    }
    out.push_back(input[i]);
    ++i;
  }
  return trim_ascii_ws(out);
}

std::string extract_asr_transcript_after_header(const std::string& raw_text, bool expect_language_header) {
  const std::string kAsrTag = "<asr_text>";
  const size_t pos = raw_text.rfind(kAsrTag);
  if (pos != std::string::npos) {
    return strip_asr_control_tags(raw_text.substr(pos + kAsrTag.size()));
  }
  if (expect_language_header) {
    // Auto-detect mode must finish emitting `language <Lang><asr_text>` before leaking transcript.
    return {};
  }
  return strip_asr_control_tags(raw_text);
}

std::string sanitize_asr_repetition_loop(const std::string& raw_input) {
  const std::string input = strip_asr_control_tags(raw_input);
  if (input.empty()) return {};
  std::vector<uint32_t> cps = utf8_to_codepoints(input);
  if (cps.size() < 8) return input;

  bool removed_any = false;
  for (int round = 0; round < 2; ++round) {
    bool changed = false;
    if (collapse_cp_runs_for_period(cps, 1)) {
      changed = true;
      removed_any = true;
    }
    for (size_t period = 2; period <= 24; ++period) {
      if (cps.size() < period * 5) break;
      if (collapse_cp_runs_for_period(cps, period)) {
        changed = true;
        removed_any = true;
      }
    }
    if (!changed) break;
  }
  if (!removed_any) return input;

  std::string cleaned = trim_ascii_ws(codepoints_to_utf8(cps));
  if (cleaned.empty()) return {};
  const auto cleaned_cps = utf8_to_codepoints(cleaned);
  for (uint32_t cp : cleaned_cps) {
    if (is_meaningful_codepoint(cp)) {
      return cleaned;
    }
  }
  return {};
}

std::string join_transcript_segments(const std::string& committed, const std::string& active) {
  const std::string lhs = trim_ascii_ws(committed);
  const std::string rhs = trim_ascii_ws(active);
  if (lhs.empty()) return rhs;
  if (rhs.empty()) return lhs;
  const bool needs_space =
      is_ascii_alnum(static_cast<unsigned char>(lhs.back())) &&
      is_ascii_alnum(static_cast<unsigned char>(rhs.front()));
  return needs_space ? (lhs + " " + rhs) : (lhs + rhs);
}

HotwordMergeResult merge_session_hotwords(
    const std::vector<std::string>& base_terms,
    const std::vector<std::string>& request_terms) {
  HotwordMergeResult result;
  std::unordered_set<std::string> seen;
  size_t total_chars = 0;

  auto append_term = [&](const std::string& raw) {
    if (result.terms.size() >= 60) return;
    const std::string cleaned = strip_control_and_trim_utf8(raw, 64);
    if (cleaned.empty()) return;
    const std::string key = ascii_lowercase(cleaned);
    if (seen.count(key)) return;
    const size_t sep_len = result.terms.empty() ? 0 : 2;
    const size_t cp_count = utf8_to_codepoints(cleaned).size();
    if (total_chars + sep_len + cp_count > 1000) return;
    seen.insert(key);
    result.terms.push_back(cleaned);
    total_chars += sep_len + cp_count;
  };

  for (const auto& t : request_terms) {
    append_term(t);
  }

  if (result.terms.empty()) {
    for (const auto& b : base_terms) {
      const std::string trimmed = trim_ascii_ws(b);
      if (!trimmed.empty()) {
        if (!result.context.empty()) result.context += ", ";
        result.context += trimmed;
        result.terms.push_back(trimmed);
      }
    }
    return result;
  }

  for (const auto& b : base_terms) {
    append_term(b);
  }

  for (size_t i = 0; i < result.terms.size(); ++i) {
    if (i > 0) result.context += ", ";
    result.context += result.terms[i];
  }
  return result;
}

HotwordMergeResult merge_session_hotwords_raw(
    const std::vector<std::string>& base_terms,
    const std::string& request_hotwords_csv_or_lines) {
  std::vector<std::string> parsed;
  std::string current;
  for (char c : request_hotwords_csv_or_lines) {
    if (c == ',' || c == '\n' || c == '\r') {
      if (!current.empty()) {
        parsed.push_back(current);
        current.clear();
      }
    } else {
      current.push_back(c);
    }
  }
  if (!current.empty()) parsed.push_back(current);
  return merge_session_hotwords(base_terms, parsed);
}

std::string strip_voice_hotword_hallucination(
    const std::string& text,
    const std::vector<std::string>& hotword_terms,
    bool allow_single) {
  if (text.empty() || hotword_terms.empty()) return text;

  std::set<std::vector<uint32_t>> seen;
  std::vector<std::vector<uint32_t>> normalized_terms;
  for (const std::string& raw : hotword_terms) {
    const std::string trimmed = trim_ascii_ws(raw);
    if (trimmed.empty()) continue;
    std::vector<uint32_t> norm = normalize_hotword_cps(trimmed);
    if (norm.empty() || seen.count(norm)) continue;
    seen.insert(norm);
    normalized_terms.push_back(std::move(norm));
  }
  if (normalized_terms.empty()) return text;

  auto root = std::make_unique<HotwordTrieNode>();
  std::vector<bool> term_starts_ascii(normalized_terms.size(), false);
  std::vector<bool> term_ends_ascii(normalized_terms.size(), false);
  std::vector<uint32_t> term_first_cp(normalized_terms.size(), 0);

  for (size_t term_id = 0; term_id < normalized_terms.size(); ++term_id) {
    const auto& norm = normalized_terms[term_id];
    term_starts_ascii[term_id] = is_ascii_alnum_or_underscore(norm.front());
    term_ends_ascii[term_id] = is_ascii_alnum_or_underscore(norm.back());
    term_first_cp[term_id] = norm.front();

    HotwordTrieNode* node = root.get();
    for (uint32_t cp : norm) {
      auto& child = node->children[cp];
      if (!child) child = std::make_unique<HotwordTrieNode>();
      node = child.get();
    }
    node->term_id = static_cast<int>(term_id);
  }

  const std::vector<uint32_t> cps = normalize_hotword_cps(text);
  const size_t n = cps.size();
  if (n == 0) return text;

  constexpr int kInf = 0x3FFFFFFF;
  std::vector<int> cleared(n + 1, kInf);
  std::vector<int> ended_ascii(n + 1, kInf);
  std::vector<std::unordered_map<int, int>> same_term_states(n + 1);
  cleared[0] = 0;

  for (size_t pos = 0; pos < n; ++pos) {
    const int c_count = cleared[pos];
    const int a_count = ended_ascii[pos];
    auto& same_map = same_term_states[pos];
    if (c_count == kInf && a_count == kInf && same_map.empty()) {
      continue;
    }
    const int best_at_pos = std::min(c_count, a_count);

    if (is_hotword_separator(cps[pos])) {
      int sep_min = best_at_pos;
      for (const auto& kv : same_map) {
        if (kv.second < sep_min) sep_min = kv.second;
      }
      if (sep_min < cleared[pos + 1]) {
        cleared[pos + 1] = sep_min;
      }
    }

    const HotwordTrieNode* node = root.get();
    for (size_t p = pos; p < n; ++p) {
      auto it = node->children.find(cps[p]);
      if (it == node->children.end()) break;
      node = it->second.get();
      if (node->term_id < 0) continue;

      const int term_id = node->term_id;
      int start_cost = term_starts_ascii[static_cast<size_t>(term_id)] ? c_count : best_at_pos;
      auto same_it = same_map.find(term_id);
      if (same_it != same_map.end() && same_it->second < start_cost) {
        start_cost = same_it->second;
      }
      if (start_cost >= kInf) continue;

      const size_t end_pos = p + 1;
      const int next_cost = start_cost + 1;
      if (!term_ends_ascii[static_cast<size_t>(term_id)] || end_pos == n) {
        if (next_cost < cleared[end_pos]) {
          cleared[end_pos] = next_cost;
        }
      } else {
        if (next_cost < ended_ascii[end_pos]) {
          ended_ascii[end_pos] = next_cost;
        }
        if (term_starts_ascii[static_cast<size_t>(term_id)] &&
            cps[end_pos] == term_first_cp[static_cast<size_t>(term_id)]) {
          auto& target_map = same_term_states[end_pos];
          auto prev_it = target_map.find(term_id);
          if (prev_it == target_map.end() || next_cost < prev_it->second) {
            target_map[term_id] = next_cost;
          }
        }
      }
    }
    same_map.clear();
  }

  const int min_matches = std::min(cleared[n], ended_ascii[n]);
  if (min_matches >= kInf) return text;
  if (min_matches >= 2) return {};
  if (allow_single && min_matches == 1) return {};
  return text;
}

std::string strip_voice_hotword_hallucination_csv(
    const std::string& text,
    const std::string& hotwords_context,
    bool allow_single) {
  if (text.empty() || hotwords_context.empty()) return text;
  std::vector<std::string> terms;
  std::string cur;
  for (char c : hotwords_context) {
    if (c == ',' || c == '\n' || c == '\r') {
      if (!cur.empty()) {
        terms.push_back(cur);
        cur.clear();
      }
    } else {
      cur.push_back(c);
    }
  }
  if (!cur.empty()) terms.push_back(cur);
  return strip_voice_hotword_hallucination(text, terms, allow_single);
}

std::vector<int64_t> rollback_prefix_tokens(
    const std::vector<int64_t>& raw_tokens,
    const Qwen3Tokenizer& tokenizer,
    int rollback_count,
    bool expect_language_header) {
  const int64_t eos = tokenizer.eos_token_id();
  const int64_t pad = tokenizer.pad_token_id();
  const int64_t asr_tag = tokenizer.asr_text_token_id();

  size_t end = raw_tokens.size();
  while (end > 0 && (raw_tokens[end - 1] == eos || raw_tokens[end - 1] == pad)) {
    --end;
  }

  size_t header_end = 0;
  bool found_asr_tag = false;
  for (size_t i = end; i > 0; --i) {
    if (raw_tokens[i - 1] == asr_tag) {
      header_end = i;
      found_asr_tag = true;
      break;
    }
  }
  if (!found_asr_tag && expect_language_header) {
    return {};
  }

  const size_t trim = static_cast<size_t>(std::max(0, rollback_count));
  if (end <= header_end || end - header_end <= trim) {
    return {};
  }
  end -= trim;

  // Back off across incomplete UTF-8 sequences (trailing U+FFFD = \xEF\xBF\xBD)
  while (end > header_end) {
    std::vector<int64_t> slice(raw_tokens.begin() + static_cast<std::ptrdiff_t>(header_end),
                               raw_tokens.begin() + static_cast<std::ptrdiff_t>(end));
    const std::string decoded = trim_ascii_ws(tokenizer.decode(slice, true));
    const std::string kReplacement = "\xEF\xBF\xBD";
    if (decoded.size() >= kReplacement.size() &&
        decoded.compare(decoded.size() - kReplacement.size(), kReplacement.size(), kReplacement) == 0) {
      --end;
    } else {
      break;
    }
  }

  if (end <= header_end) return {};
  return std::vector<int64_t>(raw_tokens.begin(), raw_tokens.begin() + static_cast<std::ptrdiff_t>(end));
}

bool is_degenerate_token_repetition(const std::vector<int64_t>& tokens, size_t window_size, size_t min_unique) {
  if (tokens.size() < window_size || window_size == 0) return false;
  std::unordered_set<int64_t> uniq;
  const size_t start = tokens.size() - window_size;
  for (size_t i = start; i < tokens.size(); ++i) {
    uniq.insert(tokens[i]);
    if (uniq.size() > min_unique) return false;
  }
  return uniq.size() <= min_unique;
}

void trim_degenerate_token_tail(std::vector<int64_t>& tokens, size_t window_size, size_t min_unique) {
  if (!is_degenerate_token_repetition(tokens, window_size, min_unique)) return;
  if (tokens.size() >= window_size) {
    // Drop the trailing repeated window while preserving earlier clean content.
    tokens.resize(tokens.size() - window_size);
  }
}

}  // namespace imcodes::qwen3
