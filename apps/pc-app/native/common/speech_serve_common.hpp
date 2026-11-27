#pragma once

#include "qwen3_onnx_engine.hpp"
#include "streaming_pipeline.hpp"
#include "text_guards.hpp"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace imcodes::speech {

inline std::mutex& output_mutex() {
  static std::mutex mu;
  return mu;
}

inline std::string json_escape(const std::string& input) {
  std::string out;
  out.reserve(input.size() + 8);
  for (unsigned char c : input) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(c));
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
        break;
    }
  }
  return out;
}

inline void emit_json_line(const std::string& line) {
  std::lock_guard<std::mutex> lock(output_mutex());
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

inline void emit_error(const std::string& code, const std::string& target, const std::string& message) {
  std::ostringstream oss;
  oss << "{\"type\":\"error\",\"code\":\"" << json_escape(code) << "\"";
  if (!target.empty()) {
    oss << ",\"target\":\"" << json_escape(target) << "\"";
  }
  if (!message.empty()) {
    oss << ",\"message\":\"" << json_escape(message) << "\"";
  }
  oss << "}";
  emit_json_line(oss.str());
}

inline std::string to_lower_ascii(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return s;
}

namespace detail {

inline void append_utf8_cp(std::string& out, uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp <= 0x10FFFF) {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

inline bool parse_hex4(const std::string& s, size_t pos, uint32_t& out_val) {
  if (pos + 4 > s.size()) return false;
  uint32_t v = 0;
  for (size_t i = 0; i < 4; ++i) {
    const char ch = s[pos + i];
    v <<= 4;
    if (ch >= '0' && ch <= '9') v |= static_cast<uint32_t>(ch - '0');
    else if (ch >= 'a' && ch <= 'f') v |= static_cast<uint32_t>(10 + ch - 'a');
    else if (ch >= 'A' && ch <= 'F') v |= static_cast<uint32_t>(10 + ch - 'A');
    else return false;
  }
  out_val = v;
  return true;
}

inline std::optional<std::string> parse_json_string_at(const std::string& s, size_t& cursor) {
  if (cursor >= s.size() || s[cursor] != '"') return std::nullopt;
  ++cursor;
  std::string out;
  while (cursor < s.size()) {
    const char ch = s[cursor++];
    if (ch == '"') {
      return out;
    }
    if (ch == '\\' && cursor < s.size()) {
      const char esc = s[cursor++];
      switch (esc) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          uint32_t cp = 0;
          if (parse_hex4(s, cursor, cp)) {
            cursor += 4;
            if (cp >= 0xD800 && cp <= 0xDBFF && cursor + 6 <= s.size() &&
                s[cursor] == '\\' && s[cursor + 1] == 'u') {
              uint32_t low = 0;
              if (parse_hex4(s, cursor + 2, low) && low >= 0xDC00 && low <= 0xDFFF) {
                cursor += 6;
                cp = 0x10000 + (((cp - 0xD800) << 10) | (low - 0xDC00));
              }
            }
            append_utf8_cp(out, cp);
          }
          break;
        }
        default: out.push_back(esc); break;
      }
      continue;
    }
    out.push_back(ch);
  }
  return std::nullopt;
}

inline size_t find_json_value_start(const std::string& json_line, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  size_t search_from = 0;
  while (search_from < json_line.size()) {
    const size_t pos = json_line.find(needle, search_from);
    if (pos == std::string::npos) return std::string::npos;
    // Skip key matches inside string escapes (`\"key\"`)
    if (pos > 0 && json_line[pos - 1] == '\\') {
      search_from = pos + needle.size();
      continue;
    }
    size_t cur = pos + needle.size();
    while (cur < json_line.size() && (json_line[cur] == ' ' || json_line[cur] == '\t')) ++cur;
    if (cur < json_line.size() && json_line[cur] == ':') {
      ++cur;
      while (cur < json_line.size() && (json_line[cur] == ' ' || json_line[cur] == '\t')) ++cur;
      return cur;
    }
    search_from = pos + needle.size();
  }
  return std::string::npos;
}

}  // namespace detail

inline std::optional<std::string> extract_json_string_field(
    const std::string& json_line,
    const std::string& key) {
  size_t cur = detail::find_json_value_start(json_line, key);
  if (cur == std::string::npos || cur >= json_line.size() || json_line[cur] != '"') {
    return std::nullopt;
  }
  return detail::parse_json_string_at(json_line, cur);
}

inline std::vector<std::string> extract_json_string_array_field(
    const std::string& json_line,
    const std::string& key) {
  std::vector<std::string> out;
  size_t cur = detail::find_json_value_start(json_line, key);
  if (cur == std::string::npos || cur >= json_line.size() || json_line[cur] != '[') {
    return out;
  }
  ++cur;
  while (cur < json_line.size()) {
    while (cur < json_line.size() &&
           (json_line[cur] == ' ' || json_line[cur] == '\t' || json_line[cur] == ',' ||
            json_line[cur] == '\r' || json_line[cur] == '\n')) {
      ++cur;
    }
    if (cur >= json_line.size() || json_line[cur] == ']') break;
    if (json_line[cur] == '"') {
      auto parsed = detail::parse_json_string_at(json_line, cur);
      if (!parsed.has_value()) break;
      out.push_back(std::move(*parsed));
      continue;
    }
    // Skip unexpected non-string element until comma or closing bracket
    while (cur < json_line.size() && json_line[cur] != ',' && json_line[cur] != ']') {
      ++cur;
    }
  }
  return out;
}

inline std::vector<uint8_t> decode_base64_bytes(const std::string& input) {
  static constexpr int kInvalid = -1;
  int table[256];
  std::fill(std::begin(table), std::end(table), kInvalid);
  for (int i = 0; i < 26; ++i) {
    table[static_cast<unsigned char>('A' + i)] = i;
    table[static_cast<unsigned char>('a' + i)] = 26 + i;
  }
  for (int i = 0; i < 10; ++i) {
    table[static_cast<unsigned char>('0' + i)] = 52 + i;
  }
  table[static_cast<unsigned char>('+')] = 62;
  table[static_cast<unsigned char>('/')] = 63;

  std::vector<uint8_t> out;
  out.reserve((input.size() * 3) / 4);
  uint32_t val = 0;
  int valb = -8;
  for (unsigned char ch : input) {
    if (ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n') continue;
    if (ch == '=') break;
    const int d = table[ch];
    if (d == kInvalid) return {};
    val = (val << 6) + static_cast<uint32_t>(d);
    valb += 6;
    if (valb >= 0) {
      out.push_back(static_cast<uint8_t>((val >> valb) & 0xFF));
      valb -= 8;
    }
  }
  return out;
}

inline std::vector<float> decode_base64_pcm16_samples(const std::string& b64) {
  const std::vector<uint8_t> bytes = decode_base64_bytes(b64);
  const size_t sample_count = bytes.size() / 2;
  std::vector<float> samples;
  if (sample_count == 0) return samples;
  samples.reserve(sample_count);
  for (size_t i = 0; i < sample_count; ++i) {
    const uint16_t raw = static_cast<uint16_t>(bytes[i * 2]) |
                         (static_cast<uint16_t>(bytes[i * 2 + 1]) << 8);
    const int16_t signed_sample = static_cast<int16_t>(raw);
    samples.push_back(static_cast<float>(signed_sample) / 32768.0f);
  }
  return samples;
}

inline std::vector<std::string> load_hotwords_terms(const std::filesystem::path& path) {
  std::error_code ec;
  if (!std::filesystem::exists(path, ec)) return {};
  std::ifstream ifs(path, std::ios::binary);
  if (!ifs.is_open()) return {};
  std::string raw((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
  return imcodes::qwen3::merge_session_hotwords_raw({}, raw).terms;
}

struct ServeStartParams {
  std::string device{"auto"};
  std::string locale;
  std::vector<std::string> hotwords;
  std::vector<float> initial_samples;
};

inline imcodes::qwen3::StreamingPipelineConfig make_streaming_pipeline_config(
    const std::vector<std::string>& base_hotwords,
    const ServeStartParams& params) {
  imcodes::qwen3::StreamingPipelineConfig cfg;
  const auto merged = imcodes::qwen3::merge_session_hotwords(base_hotwords, params.hotwords);
  cfg.hotwords_context = merged.context;
  cfg.hotword_terms = merged.terms;
  cfg.language = imcodes::qwen3::resolve_qwen3_language(params.locale);
  cfg.expect_language_header = cfg.language.empty();
  return cfg;
}

inline void emit_transcript_update(
    const std::function<void(const std::string&)>& emit_fn,
    const imcodes::qwen3::TranscriptUpdate& upd) {
  if (!upd.error.empty()) {
    std::ostringstream oss;
    oss << "{\"type\":\"error\",\"code\":\"decode_failed\",\"target\":\"speech\",\"message\":\""
        << json_escape(upd.error) << "\"}";
    emit_fn(oss.str());
  }
  std::ostringstream res;
  res << "{\"type\":\"result\",\"text\":\"" << json_escape(upd.text)
      << "\",\"isFinal\":" << (upd.is_final ? "true" : "false") << "}";
  emit_fn(res.str());
}

struct ActiveServeSessionHandle {
  virtual ~ActiveServeSessionHandle() = default;
  virtual void start() = 0;
  virtual void push_pcm_base64(const std::string& b64) { (void)b64; }
  virtual void request_stop(bool abort_only) = 0;
  virtual void wait_for_finish() = 0;
};

class PcmUtteranceDecoder : public ActiveServeSessionHandle {
 public:
  using DecodeFn = imcodes::qwen3::Qwen3StreamingPipeline::DecodeFn;
  using EmitFn = std::function<void(const std::string&)>;

  PcmUtteranceDecoder(
      imcodes::qwen3::StreamingPipelineConfig config,
      const imcodes::qwen3::Qwen3Tokenizer& tokenizer,
      DecodeFn decode_fn,
      EmitFn emit_fn)
      : emit_fn_(emit_fn),
        pipeline_(
            std::move(config),
            tokenizer,
            std::move(decode_fn),
            [emit_fn](const imcodes::qwen3::TranscriptUpdate& upd) {
              emit_transcript_update(emit_fn, upd);
            },
            [emit_fn]() {
              emit_fn("{\"type\":\"end\"}");
            }) {}

  ~PcmUtteranceDecoder() override {
    stop(true);
  }

  void start() override {
    emit_fn_("{\"type\":\"start\"}");
    worker_ = std::thread([this]() { pipeline_.run_loop(); });
  }

  void push_pcm_base64(const std::string& b64) override {
    const std::vector<float> samples = decode_base64_pcm16_samples(b64);
    if (samples.empty()) return;
    pipeline_.push_samples(samples);
  }

  void request_stop(bool abort_only) override {
    pipeline_.request_stop(abort_only, true);
  }

  void wait_for_finish() override {
    if (worker_.joinable()) {
      worker_.join();
    }
  }

  void stop(bool abort_only) {
    request_stop(abort_only);
    wait_for_finish();
  }

 private:
  EmitFn emit_fn_;
  imcodes::qwen3::Qwen3StreamingPipeline pipeline_;
  std::thread worker_;
};

class ServeCommandLoop {
 public:
  using MicFactoryFn = std::function<std::unique_ptr<ActiveServeSessionHandle>(ServeStartParams)>;
  using PcmFactoryFn = std::function<std::unique_ptr<ActiveServeSessionHandle>(ServeStartParams)>;

  ServeCommandLoop(MicFactoryFn mic_factory, PcmFactoryFn pcm_factory)
      : mic_factory_(std::move(mic_factory)), pcm_factory_(std::move(pcm_factory)) {}

  ~ServeCommandLoop() {
    join_and_reset_active(true);
  }

  void request_stop_active(bool abort_only) {
    if (active_session_) {
      active_session_->request_stop(abort_only);
    }
  }

  void join_and_reset_active(bool abort_only) {
    request_stop_active(abort_only);
    if (active_session_) {
      active_session_->wait_for_finish();
      active_session_.reset();
    }
  }

  // Returns false when `shutdown` is received.
  bool handle_line(const std::string& raw_line) {
    std::string line = raw_line;
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
    if (line.empty()) return true;

    const auto cmd = extract_json_string_field(line, "cmd");
    if (!cmd.has_value()) return true;

    if (*cmd == "prefill_reset") {
      prefilled_pcm_.clear();
    } else if (*cmd == "prefill_pcm") {
      const auto data = extract_json_string_field(line, "data");
      if (data.has_value()) {
        const std::vector<float> samples = decode_base64_pcm16_samples(*data);
        if (!samples.empty()) {
          prefilled_pcm_.insert(prefilled_pcm_.end(), samples.begin(), samples.end());
          if (prefilled_pcm_.size() > kMaxPrefillSamples) {
            prefilled_pcm_.erase(
                prefilled_pcm_.begin(),
                prefilled_pcm_.begin() + static_cast<std::ptrdiff_t>(prefilled_pcm_.size() - kMaxPrefillSamples));
          }
        }
      }
    } else if (*cmd == "start") {
      join_and_reset_active(true);
      if (mic_factory_) {
        ServeStartParams params;
        params.device = extract_json_string_field(line, "device").value_or("auto");
        params.locale = extract_json_string_field(line, "locale").value_or("");
        params.hotwords = extract_json_string_array_field(line, "hotwords");
        params.initial_samples = std::move(prefilled_pcm_);
        prefilled_pcm_.clear();
        active_session_ = mic_factory_(std::move(params));
        if (active_session_) {
          active_session_->start();
        }
      }
    } else if (*cmd == "start_pcm") {
      prefilled_pcm_.clear();
      join_and_reset_active(true);
      if (pcm_factory_) {
        ServeStartParams params;
        params.locale = extract_json_string_field(line, "locale").value_or("");
        params.hotwords = extract_json_string_array_field(line, "hotwords");
        active_session_ = pcm_factory_(std::move(params));
        if (active_session_) {
          active_session_->start();
        }
      }
    } else if (*cmd == "pcm") {
      if (active_session_) {
        const auto data = extract_json_string_field(line, "data");
        if (data.has_value()) {
          active_session_->push_pcm_base64(*data);
        }
      }
    } else if (*cmd == "stop") {
      // Non-blocking: signal final re-decode so stdin remains responsive to abort/shutdown.
      request_stop_active(false);
    } else if (*cmd == "abort") {
      prefilled_pcm_.clear();
      request_stop_active(true);
    } else if (*cmd == "shutdown") {
      prefilled_pcm_.clear();
      join_and_reset_active(true);
      return false;
    }
    return true;
  }

 private:
  static constexpr size_t kMaxPrefillSamples = 16000 * 30;
  MicFactoryFn mic_factory_;
  PcmFactoryFn pcm_factory_;
  std::unique_ptr<ActiveServeSessionHandle> active_session_;
  std::vector<float> prefilled_pcm_;
};

}  // namespace imcodes::speech
