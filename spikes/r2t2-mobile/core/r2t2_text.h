// Text helpers ported 1:1 from the pinned upstream Python so the C++ stream
// loop produces byte-identical strings:
//   - r2t2/r2t2_asr.py            (_normalize_punct_by_context, CJK space strip)
//   - qwen_asr/inference/utils.py (parse_asr_output, detect_and_fix_repetitions)
// All functions take and return UTF-8. Invalid UTF-8 is decoded as U+FFFD,
// matching HF tokenizer.decode(errors="replace") / Python str semantics.
#pragma once

#include <string>
#include <utility>

namespace r2t2 {

std::u32string utf8_to_u32(const std::string & s);
std::string u32_to_utf8(const std::u32string & s);

// True when `s` would decode to text containing U+FFFD (invalid or truncated
// UTF-8, or a literal U+FFFD). Mirrors the upstream `'�' in text` check.
bool contains_replacement_char(const std::string & s);

// Replace invalid sequences with U+FFFD (what Python sees after decoding).
std::string sanitize_utf8(const std::string & s);

// `text.replace('�', '')` after decoding.
std::string remove_replacement_chars(const std::string & s);

// Python str.strip()/rstrip() with str.isspace() semantics.
std::u32string py_strip(const std::u32string & s);

// `s.split(sep)[0]` for a single ASCII separator.
std::string split_first(const std::string & s, char sep);

// r2t2_asr._normalize_punct_by_context
std::string normalize_punct_by_context(const std::string & text);

// re.sub(r'(?<=[一-鿿])\s+(?=[一-鿿])', '', text)
std::string remove_spaces_between_han(const std::string & text);

// qwen_asr.inference.utils.detect_and_fix_repetitions(text, threshold=20)
std::string detect_and_fix_repetitions(const std::string & text, int threshold = 20);

// qwen_asr.inference.utils.parse_asr_output -> (language, text)
std::pair<std::string, std::string> parse_asr_output(const std::string & raw, const std::string & user_language);

// Number of Unicode code points (Python len()).
size_t py_len(const std::string & s);

} // namespace r2t2
