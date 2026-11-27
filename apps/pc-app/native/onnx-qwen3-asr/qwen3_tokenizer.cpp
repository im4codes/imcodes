#include "qwen3_tokenizer.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <fstream>
#include <limits>
#include <sstream>
#include <utility>

namespace imcodes::qwen3 {

namespace {

std::string read_file_bytes(const std::filesystem::path& path, bool& out_ok) {
  out_ok = false;
  std::ifstream ifs(path, std::ios::binary | std::ios::ate);
  if (!ifs.is_open()) return {};
  const std::streamsize size = ifs.tellg();
  if (size < 0) return {};
  ifs.seekg(0, std::ios::beg);
  std::string data(static_cast<size_t>(size), '\0');
  if (size > 0 && !ifs.read(data.data(), size)) return {};
  out_ok = true;
  return data;
}

void append_utf8(std::string& out, uint32_t cp) {
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
  } else {
    out += "\xEF\xBF\xBD";
  }
}

struct ByteToUnicodeTables {
  std::array<std::string, 256> b2u;
  std::unordered_map<uint32_t, uint8_t> u2b;

  ByteToUnicodeTables() {
    std::array<bool, 256> direct{};
    for (int b = '!'; b <= '~'; ++b) direct[static_cast<size_t>(b)] = true;
    for (int b = 0xA1; b <= 0xAC; ++b) direct[static_cast<size_t>(b)] = true;
    for (int b = 0xAE; b <= 0xFF; ++b) direct[static_cast<size_t>(b)] = true;

    uint32_t extra = 0;
    for (int b = 0; b < 256; ++b) {
      const uint32_t cp = direct[static_cast<size_t>(b)] ? static_cast<uint32_t>(b) : (0x100u + extra++);
      append_utf8(b2u[static_cast<size_t>(b)], cp);
      u2b[cp] = static_cast<uint8_t>(b);
    }
  }
};

const ByteToUnicodeTables& byte_unicode_tables() {
  static const ByteToUnicodeTables tables;
  return tables;
}

// Minimal strict JSON cursor for parsing vocab.json and tokenizer_config.json without external deps.
class JsonCursor {
 public:
  explicit JsonCursor(const std::string& src) : s_(src) {}

  void skip_ws() {
    while (p_ < s_.size()) {
      const char c = s_[p_];
      if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
        ++p_;
      } else {
        break;
      }
    }
  }

  bool eof() const { return p_ >= s_.size(); }
  char peek() const { return p_ < s_.size() ? s_[p_] : '\0'; }
  bool consume(char expected) {
    skip_ws();
    if (p_ < s_.size() && s_[p_] == expected) {
      ++p_;
      return true;
    }
    return false;
  }

  bool parse_string(std::string& out) {
    skip_ws();
    if (p_ >= s_.size() || s_[p_] != '"') return false;
    ++p_;
    out.clear();
    while (p_ < s_.size()) {
      const char c = s_[p_++];
      if (c == '"') return true;
      if (c != '\\') {
        out.push_back(c);
        continue;
      }
      if (p_ >= s_.size()) return false;
      const char esc = s_[p_++];
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
          if (!parse_hex4(cp)) return false;
          if (cp >= 0xD800 && cp <= 0xDBFF && p_ + 6 <= s_.size() && s_[p_] == '\\' && s_[p_ + 1] == 'u') {
            const size_t saved = p_;
            p_ += 2;
            uint32_t low = 0;
            if (parse_hex4(low) && low >= 0xDC00 && low <= 0xDFFF) {
              cp = 0x10000 + (((cp - 0xD800) << 10) | (low - 0xDC00));
            } else {
              p_ = saved;
              cp = 0xFFFD;
            }
          }
          append_utf8(out, cp);
          break;
        }
        default:
          return false;
      }
    }
    return false;
  }

  bool parse_int64(int64_t& out) {
    skip_ws();
    if (p_ >= s_.size()) return false;
    bool neg = false;
    if (s_[p_] == '-') {
      neg = true;
      ++p_;
    }
    if (p_ >= s_.size() || !std::isdigit(static_cast<unsigned char>(s_[p_]))) return false;
    uint64_t acc = 0;
    while (p_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[p_]))) {
      acc = acc * 10 + static_cast<uint64_t>(s_[p_] - '0');
      ++p_;
    }
    if (p_ < s_.size() && (s_[p_] == '.' || s_[p_] == 'e' || s_[p_] == 'E')) {
      return false;
    }
    out = neg ? -static_cast<int64_t>(acc) : static_cast<int64_t>(acc);
    return true;
  }

  bool skip_value() {
    skip_ws();
    if (p_ >= s_.size()) return false;
    const char c = s_[p_];
    if (c == '"') {
      std::string dummy;
      return parse_string(dummy);
    }
    if (c == '{') {
      ++p_;
      skip_ws();
      if (peek() == '}') {
        ++p_;
        return true;
      }
      while (true) {
        std::string key;
        if (!parse_string(key) || !consume(':') || !skip_value()) return false;
        skip_ws();
        if (consume(',')) continue;
        return consume('}');
      }
    }
    if (c == '[') {
      ++p_;
      skip_ws();
      if (peek() == ']') {
        ++p_;
        return true;
      }
      while (true) {
        if (!skip_value()) return false;
        skip_ws();
        if (consume(',')) continue;
        return consume(']');
      }
    }
    if (s_.compare(p_, 4, "true") == 0) {
      p_ += 4;
      return true;
    }
    if (s_.compare(p_, 5, "false") == 0) {
      p_ += 5;
      return true;
    }
    if (s_.compare(p_, 4, "null") == 0) {
      p_ += 4;
      return true;
    }
    // Number
    if (c == '-' || std::isdigit(static_cast<unsigned char>(c))) {
      if (s_[p_] == '-') ++p_;
      if (p_ >= s_.size() || !std::isdigit(static_cast<unsigned char>(s_[p_]))) return false;
      while (p_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[p_]))) ++p_;
      if (p_ < s_.size() && s_[p_] == '.') {
        ++p_;
        while (p_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[p_]))) ++p_;
      }
      if (p_ < s_.size() && (s_[p_] == 'e' || s_[p_] == 'E')) {
        ++p_;
        if (p_ < s_.size() && (s_[p_] == '+' || s_[p_] == '-')) ++p_;
        while (p_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[p_]))) ++p_;
      }
      return true;
    }
    return false;
  }

 private:
  bool parse_hex4(uint32_t& out) {
    if (p_ + 4 > s_.size()) return false;
    uint32_t v = 0;
    for (int i = 0; i < 4; ++i) {
      const char c = s_[p_++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= static_cast<uint32_t>(c - '0');
      else if (c >= 'a' && c <= 'f') v |= static_cast<uint32_t>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= static_cast<uint32_t>(c - 'A' + 10);
      else return false;
    }
    out = v;
    return true;
  }

  const std::string& s_;
  size_t p_{0};
};

bool parse_vocab_json(const std::string& json_text, std::unordered_map<std::string, int64_t>& out_vocab) {
  JsonCursor cur(json_text);
  if (!cur.consume('{')) return false;
  cur.skip_ws();
  if (cur.peek() == '}') return true;
  std::string key;
  int64_t id = 0;
  while (true) {
    if (!cur.parse_string(key) || !cur.consume(':') || !cur.parse_int64(id)) return false;
    out_vocab[key] = id;
    cur.skip_ws();
    if (cur.consume(',')) continue;
    return cur.consume('}');
  }
}

bool parse_added_tokens_from_config(
    const std::string& json_text,
    std::unordered_map<int64_t, std::string>& out_added,
    std::string& out_eos_token,
    std::string& out_pad_token) {
  JsonCursor cur(json_text);
  if (!cur.consume('{')) return false;
  cur.skip_ws();
  if (cur.peek() == '}') return true;
  std::string key;
  while (true) {
    if (!cur.parse_string(key) || !cur.consume(':')) return false;
    if (key == "eos_token") {
      cur.skip_ws();
      if (cur.peek() == '"') {
        cur.parse_string(out_eos_token);
      } else if (!cur.skip_value()) {
        return false;
      }
    } else if (key == "pad_token") {
      cur.skip_ws();
      if (cur.peek() == '"') {
        cur.parse_string(out_pad_token);
      } else if (!cur.skip_value()) {
        return false;
      }
    } else if (key == "added_tokens_decoder") {
      if (!cur.consume('{')) return false;
      cur.skip_ws();
      if (!cur.consume('}')) {
        std::string id_str;
        while (true) {
          if (!cur.parse_string(id_str) || !cur.consume(':') || !cur.consume('{')) return false;
          std::string content;
          std::string inner_key;
          cur.skip_ws();
          if (!cur.consume('}')) {
            while (true) {
              if (!cur.parse_string(inner_key) || !cur.consume(':')) return false;
              if (inner_key == "content") {
                if (!cur.parse_string(content)) return false;
              } else {
                if (!cur.skip_value()) return false;
              }
              cur.skip_ws();
              if (cur.consume(',')) continue;
              if (!cur.consume('}')) return false;
              break;
            }
          }
          if (!id_str.empty() && !content.empty()) {
            try {
              const int64_t id = std::stoll(id_str);
              out_added[id] = content;
            } catch (...) {
              // Ignore non-numeric keys
            }
          }
          cur.skip_ws();
          if (cur.consume(',')) continue;
          if (!cur.consume('}')) return false;
          break;
        }
      }
    } else {
      if (!cur.skip_value()) return false;
    }
    cur.skip_ws();
    if (cur.consume(',')) continue;
    return cur.consume('}');
  }
}

std::vector<std::string> split_utf8_chars(const std::string& s) {
  std::vector<std::string> out;
  size_t i = 0;
  while (i < s.size()) {
    const auto b = static_cast<unsigned char>(s[i]);
    size_t len = 1;
    if ((b & 0x80) == 0) len = 1;
    else if ((b & 0xE0) == 0xC0) len = 2;
    else if ((b & 0xF0) == 0xE0) len = 3;
    else if ((b & 0xF8) == 0xF0) len = 4;
    if (i + len > s.size()) len = s.size() - i;
    out.push_back(s.substr(i, len));
    i += len;
  }
  return out;
}

std::string to_byte_level_utf8(const std::string& raw_utf8) {
  const auto& tables = byte_unicode_tables();
  std::string out;
  out.reserve(raw_utf8.size() * 2);
  for (unsigned char b : raw_utf8) {
    out += tables.b2u[b];
  }
  return out;
}

inline bool is_ascii_letter(unsigned char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

inline bool is_ascii_digit(unsigned char c) {
  return c >= '0' && c <= '9';
}

inline bool is_ws_byte(unsigned char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

inline size_t utf8_char_len(const std::string& s, size_t i) {
  const auto b = static_cast<unsigned char>(s[i]);
  size_t len = 1;
  if ((b & 0x80) == 0) len = 1;
  else if ((b & 0xE0) == 0xC0) len = 2;
  else if ((b & 0xF0) == 0xE0) len = 3;
  else if ((b & 0xF8) == 0xF0) len = 4;
  return std::min(len, s.size() - i);
}

/**
 * Qwen2/Qwen3 compatible pre-tokenization:
 * - Splits contractions ('s, 't, 're, 've, 'm, 'll, 'd)
 * - Keeps optional single leading space attached to letters or non-ASCII word/symbol chunks
 * - Isolates individual digits [0-9] (Qwen2 regex `\p{N}`)
 * - Isolates newlines cleanly
 */
std::vector<std::string> qwen_pre_tokenize(const std::string& text) {
  std::vector<std::string> chunks;
  size_t i = 0;
  const size_t n = text.size();

  auto match_contraction = [&](size_t pos) -> size_t {
    if (pos >= n || text[pos] != '\'') return 0;
    if (pos + 2 <= n) {
      const char c1 = static_cast<char>(std::tolower(static_cast<unsigned char>(text[pos + 1])));
      if (pos + 3 <= n) {
        const char c2 = static_cast<char>(std::tolower(static_cast<unsigned char>(text[pos + 2])));
        if ((c1 == 'r' && c2 == 'e') || (c1 == 'v' && c2 == 'e') || (c1 == 'l' && c2 == 'l')) {
          return 3;
        }
      }
      if (c1 == 's' || c1 == 't' || c1 == 'm' || c1 == 'd') return 2;
    }
    return 0;
  };

  while (i < n) {
    if (const size_t clen = match_contraction(i)) {
      chunks.push_back(text.substr(i, clen));
      i += clen;
      continue;
    }

    const auto b = static_cast<unsigned char>(text[i]);
    if (b == '\r' || b == '\n') {
      const size_t start = i;
      while (i < n && (text[i] == '\r' || text[i] == '\n')) ++i;
      chunks.push_back(text.substr(start, i - start));
      continue;
    }

    if (is_ascii_digit(b)) {
      chunks.push_back(text.substr(i, 1));
      ++i;
      continue;
    }

    // Optional single leading space attached to letters or punctuation/non-ASCII token
    if (b == ' ' && i + 1 < n && !is_ws_byte(static_cast<unsigned char>(text[i + 1])) &&
        !is_ascii_digit(static_cast<unsigned char>(text[i + 1]))) {
      const size_t start = i;
      ++i;
      const auto b2 = static_cast<unsigned char>(text[i]);
      if (is_ascii_letter(b2)) {
        while (i < n && is_ascii_letter(static_cast<unsigned char>(text[i]))) ++i;
        chunks.push_back(text.substr(start, i - start));
        continue;
      }
      if (b2 >= 0x80) {
        while (i < n && static_cast<unsigned char>(text[i]) >= 0x80) {
          i += utf8_char_len(text, i);
        }
        chunks.push_back(text.substr(start, i - start));
        continue;
      }
      // Punctuation with leading space
      while (i < n) {
        const auto bp = static_cast<unsigned char>(text[i]);
        if (is_ws_byte(bp) || is_ascii_letter(bp) || is_ascii_digit(bp) || bp >= 0x80) break;
        ++i;
      }
      chunks.push_back(text.substr(start, i - start));
      continue;
    }

    if (is_ascii_letter(b)) {
      const size_t start = i;
      while (i < n && is_ascii_letter(static_cast<unsigned char>(text[i]))) ++i;
      chunks.push_back(text.substr(start, i - start));
      continue;
    }

    if (b >= 0x80) {
      const size_t start = i;
      while (i < n && static_cast<unsigned char>(text[i]) >= 0x80) {
        i += utf8_char_len(text, i);
      }
      chunks.push_back(text.substr(start, i - start));
      continue;
    }

    if (is_ws_byte(b)) {
      const size_t start = i;
      while (i < n && (text[i] == ' ' || text[i] == '\t')) ++i;
      chunks.push_back(text.substr(start, i - start));
      continue;
    }

    // ASCII punctuation run
    const size_t start = i;
    while (i < n) {
      const auto bp = static_cast<unsigned char>(text[i]);
      if (is_ws_byte(bp) || is_ascii_letter(bp) || is_ascii_digit(bp) || bp >= 0x80 || match_contraction(i)) break;
      ++i;
    }
    if (i == start) ++i;
    chunks.push_back(text.substr(start, i - start));
  }

  return chunks;
}

std::string decode_utf8_lenient(const std::vector<uint8_t>& bytes) {
  std::string out;
  out.reserve(bytes.size());
  size_t i = 0;
  const size_t n = bytes.size();
  while (i < n) {
    const uint8_t b0 = bytes[i];
    if (b0 < 0x80) {
      out.push_back(static_cast<char>(b0));
      i += 1;
    } else if ((b0 & 0xE0) == 0xC0) {
      if (i + 1 < n && (bytes[i + 1] & 0xC0) == 0x80) {
        const uint32_t cp = (static_cast<uint32_t>(b0 & 0x1F) << 6) | static_cast<uint32_t>(bytes[i + 1] & 0x3F);
        if (cp >= 0x80) {
          out.push_back(static_cast<char>(b0));
          out.push_back(static_cast<char>(bytes[i + 1]));
          i += 2;
          continue;
        }
      }
      out += "\xEF\xBF\xBD";
      i += 1;
    } else if ((b0 & 0xF0) == 0xE0) {
      if (i + 2 < n && (bytes[i + 1] & 0xC0) == 0x80 && (bytes[i + 2] & 0xC0) == 0x80) {
        const uint32_t cp = (static_cast<uint32_t>(b0 & 0x0F) << 12) |
                            (static_cast<uint32_t>(bytes[i + 1] & 0x3F) << 6) |
                            static_cast<uint32_t>(bytes[i + 2] & 0x3F);
        if (cp >= 0x800 && !(cp >= 0xD800 && cp <= 0xDFFF)) {
          out.push_back(static_cast<char>(b0));
          out.push_back(static_cast<char>(bytes[i + 1]));
          out.push_back(static_cast<char>(bytes[i + 2]));
          i += 3;
          continue;
        }
      }
      out += "\xEF\xBF\xBD";
      i += (i + 1 < n && (bytes[i + 1] & 0xC0) == 0x80) ? 2 : 1;
    } else if ((b0 & 0xF8) == 0xF0) {
      if (i + 3 < n && (bytes[i + 1] & 0xC0) == 0x80 && (bytes[i + 2] & 0xC0) == 0x80 &&
          (bytes[i + 3] & 0xC0) == 0x80) {
        const uint32_t cp = (static_cast<uint32_t>(b0 & 0x07) << 18) |
                            (static_cast<uint32_t>(bytes[i + 1] & 0x3F) << 12) |
                            (static_cast<uint32_t>(bytes[i + 2] & 0x3F) << 6) |
                            static_cast<uint32_t>(bytes[i + 3] & 0x3F);
        if (cp >= 0x10000 && cp <= 0x10FFFF) {
          out.push_back(static_cast<char>(b0));
          out.push_back(static_cast<char>(bytes[i + 1]));
          out.push_back(static_cast<char>(bytes[i + 2]));
          out.push_back(static_cast<char>(bytes[i + 3]));
          i += 4;
          continue;
        }
      }
      out += "\xEF\xBF\xBD";
      size_t adv = 1;
      while (i + adv < n && adv < 3 && (bytes[i + adv] & 0xC0) == 0x80) ++adv;
      i += adv;
    } else {
      out += "\xEF\xBF\xBD";
      i += 1;
    }
  }
  return out;
}

}  // namespace

bool Qwen3Tokenizer::load(const std::filesystem::path& tokenizer_dir, std::string& out_error) {
  id_to_token_.clear();
  token_to_id_.clear();
  special_token_to_id_.clear();
  special_tokens_sorted_.clear();
  bpe_ranks_.clear();

  bool ok = false;
  const std::string vocab_raw = read_file_bytes(tokenizer_dir / "vocab.json", ok);
  if (!ok) {
    out_error = "Failed to read vocab.json";
    return false;
  }

  std::unordered_map<std::string, int64_t> vocab;
  if (!parse_vocab_json(vocab_raw, vocab) || vocab.empty()) {
    out_error = "Failed to parse vocab.json";
    return false;
  }
  for (const auto& kv : vocab) {
    token_to_id_[kv.first] = kv.second;
    id_to_token_[kv.second] = kv.first;
  }

  std::unordered_map<int64_t, std::string> added_tokens;
  std::string cfg_eos_token;
  std::string cfg_pad_token;
  const std::filesystem::path cfg_path = tokenizer_dir / "tokenizer_config.json";
  if (std::filesystem::exists(cfg_path)) {
    const std::string cfg_raw = read_file_bytes(cfg_path, ok);
    if (!ok || !parse_added_tokens_from_config(cfg_raw, added_tokens, cfg_eos_token, cfg_pad_token)) {
      out_error = "Failed to parse tokenizer_config.json";
      return false;
    }
    for (const auto& kv : added_tokens) {
      id_to_token_[kv.first] = kv.second;
      token_to_id_[kv.second] = kv.first;
      special_token_to_id_[kv.second] = kv.first;
    }
  }

  const std::filesystem::path merges_path = tokenizer_dir / "merges.txt";
  if (std::filesystem::exists(merges_path)) {
    const std::string merges_raw = read_file_bytes(merges_path, ok);
    if (!ok) {
      out_error = "Failed to read merges.txt";
      return false;
    }
    std::istringstream iss(merges_raw);
    std::string line;
    int line_idx = 0;
    while (std::getline(iss, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (!line.empty() && line[0] != '#') {
        const size_t sp = line.find(' ');
        if (sp != std::string::npos && sp > 0 && sp + 1 < line.size()) {
          // Key by "first\x01second" or "first second" (space never appears inside byte-level BPE tokens)
          bpe_ranks_[line] = line_idx;
        }
      }
      ++line_idx;
    }
  }

  refresh_special_ids();
  if (!cfg_eos_token.empty()) {
    int64_t id = 0;
    if (try_get_token_id(cfg_eos_token, id)) special_.eos = id;
  }
  if (!cfg_pad_token.empty()) {
    int64_t id = 0;
    if (try_get_token_id(cfg_pad_token, id)) special_.pad = id;
  }
  return true;
}

bool Qwen3Tokenizer::load_from_memory(
    const std::unordered_map<std::string, int64_t>& vocab,
    const std::vector<std::string>& merges,
    const std::unordered_map<int64_t, std::string>& added_tokens) {
  id_to_token_.clear();
  token_to_id_.clear();
  special_token_to_id_.clear();
  special_tokens_sorted_.clear();
  bpe_ranks_.clear();

  for (const auto& kv : vocab) {
    token_to_id_[kv.first] = kv.second;
    id_to_token_[kv.second] = kv.first;
  }
  for (const auto& kv : added_tokens) {
    id_to_token_[kv.first] = kv.second;
    token_to_id_[kv.second] = kv.first;
    special_token_to_id_[kv.second] = kv.first;
  }
  for (size_t idx = 0; idx < merges.size(); ++idx) {
    if (!merges[idx].empty()) {
      bpe_ranks_[merges[idx]] = static_cast<int>(idx);
    }
  }
  refresh_special_ids();
  return !id_to_token_.empty();
}

void Qwen3Tokenizer::refresh_special_ids() {
  special_tokens_sorted_.clear();
  special_tokens_sorted_.reserve(special_token_to_id_.size());
  for (const auto& kv : special_token_to_id_) {
    special_tokens_sorted_.push_back(kv.first);
  }
  std::sort(special_tokens_sorted_.begin(), special_tokens_sorted_.end(),
            [](const std::string& a, const std::string& b) {
              if (a.size() != b.size()) return a.size() > b.size();
              return a < b;
            });

  auto update_if_present = [&](const std::string& tok, int64_t& dst) {
    auto it = token_to_id_.find(tok);
    if (it != token_to_id_.end()) dst = it->second;
  };
  update_if_present("<|im_start|>", special_.im_start);
  update_if_present("<|im_end|>", special_.im_end);
  update_if_present("<|im_end|>", special_.eos);
  update_if_present("<|endoftext|>", special_.endoftext);
  update_if_present("<|endoftext|>", special_.pad);
  update_if_present("<|audio_start|>", special_.audio_start);
  update_if_present("<|audio_end|>", special_.audio_end);
  update_if_present("<|audio_pad|>", special_.audio_pad);
  update_if_present("<asr_text>", special_.asr_text);
  update_if_present("\xC4\x8A", special_.newline);  // U+010A ('Ċ') for '\n'
  update_if_present("system", special_.system_id);
  update_if_present("user", special_.user_id);
  update_if_present("assistant", special_.assistant_id);
}

bool Qwen3Tokenizer::try_get_token_id(const std::string& token, int64_t& out_id) const {
  auto it = token_to_id_.find(token);
  if (it == token_to_id_.end()) return false;
  out_id = it->second;
  return true;
}

std::string Qwen3Tokenizer::get_token(int64_t id) const {
  auto it = id_to_token_.find(id);
  return it != id_to_token_.end() ? it->second : std::string{};
}

std::vector<std::string> Qwen3Tokenizer::bpe(const std::string& byte_level_token) const {
  if (byte_level_token.empty()) return {};
  if (token_to_id_.count(byte_level_token)) {
    return {byte_level_token};
  }
  std::vector<std::string> pieces = split_utf8_chars(byte_level_token);
  if (pieces.size() <= 1 || bpe_ranks_.empty()) return pieces;

  while (pieces.size() > 1) {
    int best_rank = std::numeric_limits<int>::max();
    std::string best_first;
    std::string best_second;
    for (size_t i = 0; i + 1 < pieces.size(); ++i) {
      std::string pair;
      pair.reserve(pieces[i].size() + 1 + pieces[i + 1].size());
      pair += pieces[i];
      pair.push_back(' ');
      pair += pieces[i + 1];
      auto it = bpe_ranks_.find(pair);
      if (it != bpe_ranks_.end() && it->second < best_rank) {
        best_rank = it->second;
        best_first = pieces[i];
        best_second = pieces[i + 1];
      }
    }
    if (best_rank == std::numeric_limits<int>::max()) break;

    std::vector<std::string> next_pieces;
    next_pieces.reserve(pieces.size());
    size_t i = 0;
    while (i < pieces.size()) {
      if (i + 1 < pieces.size() && pieces[i] == best_first && pieces[i + 1] == best_second) {
        next_pieces.push_back(best_first + best_second);
        i += 2;
      } else {
        next_pieces.push_back(pieces[i]);
        ++i;
      }
    }
    pieces = std::move(next_pieces);
  }
  return pieces;
}

void Qwen3Tokenizer::encode_plain_span(const std::string& text, std::vector<int64_t>& out_ids) const {
  if (text.empty()) return;
  const std::vector<std::string> chunks = qwen_pre_tokenize(text);
  for (const std::string& chunk : chunks) {
    const std::string byte_tok = to_byte_level_utf8(chunk);
    if (bpe_ranks_.empty()) {
      if (auto it = token_to_id_.find(byte_tok); it != token_to_id_.end()) {
        out_ids.push_back(it->second);
      } else {
        for (const std::string& ch : split_utf8_chars(byte_tok)) {
          if (auto cit = token_to_id_.find(ch); cit != token_to_id_.end()) {
            out_ids.push_back(cit->second);
          }
        }
      }
      continue;
    }
    for (const std::string& piece : bpe(byte_tok)) {
      auto it = token_to_id_.find(piece);
      if (it != token_to_id_.end()) {
        out_ids.push_back(it->second);
      } else {
        // Fallback byte-by-byte if an individual piece wasn't merged in vocab
        for (const std::string& ch : split_utf8_chars(piece)) {
          if (auto cit = token_to_id_.find(ch); cit != token_to_id_.end()) {
            out_ids.push_back(cit->second);
          }
        }
      }
    }
  }
}

std::vector<int64_t> Qwen3Tokenizer::encode(const std::string& text, bool parse_special) const {
  std::vector<int64_t> out;
  if (text.empty()) return out;
  if (!parse_special || special_tokens_sorted_.empty()) {
    encode_plain_span(text, out);
    return out;
  }

  size_t pos = 0;
  size_t plain_start = 0;
  while (pos < text.size()) {
    bool matched = false;
    if (text[pos] == '<') {
      for (const std::string& tok : special_tokens_sorted_) {
        if (pos + tok.size() <= text.size() && text.compare(pos, tok.size(), tok) == 0) {
          if (pos > plain_start) {
            encode_plain_span(text.substr(plain_start, pos - plain_start), out);
          }
          out.push_back(special_token_to_id_.at(tok));
          pos += tok.size();
          plain_start = pos;
          matched = true;
          break;
        }
      }
    }
    if (!matched) ++pos;
  }
  if (plain_start < text.size()) {
    encode_plain_span(text.substr(plain_start), out);
  }
  return out;
}

std::string Qwen3Tokenizer::decode(const std::vector<int64_t>& tokens, bool include_asr_tag) const {
  const auto& tables = byte_unicode_tables();
  std::vector<uint8_t> bytes;
  bytes.reserve(tokens.size() * 4);

  for (int64_t id : tokens) {
    auto it = id_to_token_.find(id);
    if (it == id_to_token_.end()) continue;
    const std::string& tok = it->second;

    if (tok.size() >= 4 && tok.compare(0, 2, "<|") == 0 && tok.compare(tok.size() - 2, 2, "|>") == 0) {
      continue;
    }
    if (tok == "<asr_text>" ||
        (tok.size() >= 3 && tok.front() == '<' && tok.back() == '>' && tok.find('|') == std::string::npos &&
         special_token_to_id_.count(tok))) {
      if (include_asr_tag || tok != "<asr_text>") {
        bytes.insert(bytes.end(), tok.begin(), tok.end());
      }
      continue;
    }

    size_t i = 0;
    while (i < tok.size()) {
      const auto b0 = static_cast<unsigned char>(tok[i]);
      uint32_t cp = 0;
      size_t len = 1;
      if (b0 < 0x80) {
        cp = b0;
        len = 1;
      } else if ((b0 & 0xE0) == 0xC0 && i + 1 < tok.size()) {
        cp = (static_cast<uint32_t>(b0 & 0x1F) << 6) |
             static_cast<uint32_t>(static_cast<unsigned char>(tok[i + 1]) & 0x3F);
        len = 2;
      } else if ((b0 & 0xF0) == 0xE0 && i + 2 < tok.size()) {
        cp = (static_cast<uint32_t>(b0 & 0x0F) << 12) |
             (static_cast<uint32_t>(static_cast<unsigned char>(tok[i + 1]) & 0x3F) << 6) |
             static_cast<uint32_t>(static_cast<unsigned char>(tok[i + 2]) & 0x3F);
        len = 3;
      } else if ((b0 & 0xF8) == 0xF0 && i + 3 < tok.size()) {
        cp = (static_cast<uint32_t>(b0 & 0x07) << 18) |
             (static_cast<uint32_t>(static_cast<unsigned char>(tok[i + 1]) & 0x3F) << 12) |
             (static_cast<uint32_t>(static_cast<unsigned char>(tok[i + 2]) & 0x3F) << 6) |
             static_cast<uint32_t>(static_cast<unsigned char>(tok[i + 3]) & 0x3F);
        len = 4;
      } else {
        cp = b0;
        len = 1;
      }
      if (auto uit = tables.u2b.find(cp); uit != tables.u2b.end()) {
        bytes.push_back(uit->second);
      } else {
        for (size_t k = 0; k < len; ++k) {
          bytes.push_back(static_cast<uint8_t>(tok[i + k]));
        }
      }
      i += len;
    }
  }

  return decode_utf8_lenient(bytes);
}

}  // namespace imcodes::qwen3
