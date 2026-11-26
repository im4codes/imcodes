#include "r2t2_text.h"

#include <cstdint>
#include <vector>

namespace r2t2 {

namespace {

constexpr char32_t kReplacement = 0xFFFD;

// Python str.isspace(): Unicode White_Space-ish set used by str.strip() and
// by `\s` in `re` patterns on str.
bool py_isspace(char32_t c) {
    switch (c) {
        case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D:
        case 0x1C: case 0x1D: case 0x1E: case 0x1F: case 0x20:
        case 0x85: case 0xA0: case 0x1680:
        case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000:
            return true;
        default:
            return c >= 0x2000 && c <= 0x200A;
    }
}

bool is_han(char32_t c) { return c >= 0x4E00 && c <= 0x9FFF; }

bool is_ascii_alnum(char32_t c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

// Decode with the "maximal subpart" replacement policy CPython uses.
std::u32string decode(const std::string & s, bool * had_error) {
    std::u32string out;
    out.reserve(s.size());
    const auto * b = reinterpret_cast<const unsigned char *>(s.data());
    const size_t n = s.size();
    size_t i = 0;
    while (i < n) {
        const unsigned char c = b[i];
        if (c < 0x80) {
            out.push_back(c);
            ++i;
            continue;
        }
        int len = 0;
        char32_t cp = 0;
        unsigned char lo = 0x80, hi = 0xBF;
        if (c >= 0xC2 && c <= 0xDF) { len = 2; cp = c & 0x1F; }
        else if (c >= 0xE0 && c <= 0xEF) {
            len = 3; cp = c & 0x0F;
            if (c == 0xE0) lo = 0xA0;
            if (c == 0xED) hi = 0x9F;
        } else if (c >= 0xF0 && c <= 0xF4) {
            len = 4; cp = c & 0x07;
            if (c == 0xF0) lo = 0x90;
            if (c == 0xF4) hi = 0x8F;
        } else {
            if (had_error) *had_error = true;
            out.push_back(kReplacement);
            ++i;
            continue;
        }
        size_t j = i + 1;
        bool ok = true;
        for (int k = 1; k < len; ++k, ++j) {
            if (j >= n) { ok = false; break; }
            const unsigned char cc = b[j];
            const unsigned char l = (k == 1) ? lo : 0x80;
            const unsigned char h = (k == 1) ? hi : 0xBF;
            if (cc < l || cc > h) { ok = false; break; }
            cp = (cp << 6) | (cc & 0x3F);
        }
        if (!ok) {
            if (had_error) *had_error = true;
            out.push_back(kReplacement);
            i = j;  // skip the maximal valid subpart only
            continue;
        }
        out.push_back(cp);
        i = j;
    }
    return out;
}

void append_utf8(std::string & out, char32_t c) {
    if (c < 0x80) {
        out.push_back(static_cast<char>(c));
    } else if (c < 0x800) {
        out.push_back(static_cast<char>(0xC0 | (c >> 6)));
        out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
    } else if (c < 0x10000) {
        out.push_back(static_cast<char>(0xE0 | (c >> 12)));
        out.push_back(static_cast<char>(0x80 | ((c >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (c >> 18)));
        out.push_back(static_cast<char>(0x80 | ((c >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((c >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
    }
}

char32_t en2zh(char32_t c) {
    switch (c) {
        case ',': return U'，';
        case '.': return U'。';
        case '!': return U'！';
        case '?': return U'？';
        case ';': return U'；';
        case ':': return U'：';
        case '(': return U'（';
        case ')': return U'）';
        default: return c;
    }
}

char32_t zh2en(char32_t c) {
    switch (c) {
        case U'，': return ',';
        case U'。': return '.';
        case U'！': return '!';
        case U'？': return '?';
        case U'；': return ';';
        case U'：': return ':';
        case U'（': return '(';
        case U'）': return ')';
        default: return c;
    }
}

bool is_normalized_punct(char32_t c) {
    return c == ',' || c == '.' || c == '!' || c == '?' || c == ';' || c == ':' || c == '(' || c == ')'
        || c == U'，' || c == U'。' || c == U'！' || c == U'？'
        || c == U'；' || c == U'：' || c == U'（' || c == U'）';
}

std::u32string fix_char_repeats(const std::u32string & s, int thresh) {
    std::u32string res;
    size_t i = 0;
    const size_t n = s.size();
    while (i < n) {
        size_t count = 1;
        while (i + count < n && s[i + count] == s[i]) ++count;
        if (count > static_cast<size_t>(thresh)) {
            res.push_back(s[i]);
        } else {
            res.append(s, i, count);
        }
        i += count;
    }
    return res;
}

std::u32string fix_pattern_repeats(const std::u32string & s, int thresh, int max_len = 20) {
    const size_t n = s.size();
    const size_t min_repeat_chars = static_cast<size_t>(thresh) * 2;
    if (n < min_repeat_chars) return s;
    size_t i = 0;
    std::u32string result;
    bool found = false;
    while (i + min_repeat_chars <= n) {
        found = false;
        for (int k = 1; k <= max_len; ++k) {
            if (i + static_cast<size_t>(k) * thresh > n) break;
            const std::u32string pattern = s.substr(i, k);
            bool valid = true;
            for (int rep = 1; rep < thresh; ++rep) {
                const size_t start = i + static_cast<size_t>(rep) * k;
                if (s.compare(start, k, pattern) != 0) { valid = false; break; }
            }
            if (valid) {
                size_t end_index = i + static_cast<size_t>(thresh) * k;
                while (end_index + k <= n && s.compare(end_index, k, pattern) == 0) end_index += k;
                result += pattern;
                result += fix_pattern_repeats(s.substr(end_index), thresh, max_len);
                i = n;
                found = true;
                break;
            }
        }
        if (found) break;
        result.push_back(s[i]);
        ++i;
    }
    if (!found) result += s.substr(i < n ? i : n);
    return result;
}

std::string ascii_lower(std::string s) {
    for (auto & c : s) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return s;
}

// qwen_asr normalize_language_name: first char upper, rest lower.
std::string normalize_language_name(const std::string & v) {
    std::u32string u = py_strip(utf8_to_u32(v));
    if (u.empty()) return {};
    std::string s = u32_to_utf8(u);
    std::string out = ascii_lower(s);
    if (out[0] >= 'a' && out[0] <= 'z') out[0] = static_cast<char>(out[0] - 'a' + 'A');
    return out;
}

} // namespace

std::u32string utf8_to_u32(const std::string & s) { return decode(s, nullptr); }

std::string u32_to_utf8(const std::u32string & s) {
    std::string out;
    out.reserve(s.size() * 3);
    for (char32_t c : s) append_utf8(out, c);
    return out;
}

bool contains_replacement_char(const std::string & s) {
    bool err = false;
    const std::u32string u = decode(s, &err);
    if (err) return true;
    for (char32_t c : u) if (c == kReplacement) return true;
    return false;
}

std::string sanitize_utf8(const std::string & s) { return u32_to_utf8(decode(s, nullptr)); }

std::string remove_replacement_chars(const std::string & s) {
    std::u32string u = decode(s, nullptr);
    std::u32string out;
    out.reserve(u.size());
    for (char32_t c : u) if (c != kReplacement) out.push_back(c);
    return u32_to_utf8(out);
}

std::u32string py_strip(const std::u32string & s) {
    size_t b = 0, e = s.size();
    while (b < e && py_isspace(s[b])) ++b;
    while (e > b && py_isspace(s[e - 1])) --e;
    return s.substr(b, e - b);
}

std::string split_first(const std::string & s, char sep) {
    const size_t p = s.find(sep);
    return p == std::string::npos ? s : s.substr(0, p);
}

std::string normalize_punct_by_context(const std::string & text) {
    const std::u32string t = utf8_to_u32(text);
    std::u32string out = t;
    for (size_t pos = 0; pos < t.size(); ++pos) {
        const char32_t p = t[pos];
        if (!is_normalized_punct(p)) continue;
        char32_t prev = 0;
        bool have_prev = false;
        for (size_t i = pos; i-- > 0;) {
            if (!py_isspace(t[i])) { prev = t[i]; have_prev = true; break; }
        }
        if (!have_prev) continue;
        if (is_han(prev)) {
            out[pos] = en2zh(p);
        } else if (prev < 0x80 && (is_ascii_alnum(prev) || prev == '"' || prev == '\'')) {
            out[pos] = zh2en(p);
        }
    }
    return u32_to_utf8(out);
}

std::string remove_spaces_between_han(const std::string & text) {
    const std::u32string t = utf8_to_u32(text);
    std::u32string out;
    out.reserve(t.size());
    size_t i = 0;
    while (i < t.size()) {
        if (py_isspace(t[i]) && !out.empty() && is_han(out.back())) {
            size_t j = i;
            while (j < t.size() && py_isspace(t[j])) ++j;
            if (j < t.size() && is_han(t[j])) { i = j; continue; }
            out.append(t, i, j - i);
            i = j;
            continue;
        }
        out.push_back(t[i]);
        ++i;
    }
    return u32_to_utf8(out);
}

std::string detect_and_fix_repetitions(const std::string & text, int threshold) {
    std::u32string t = utf8_to_u32(text);
    t = fix_char_repeats(t, threshold);
    t = fix_pattern_repeats(t, threshold);
    return u32_to_utf8(t);
}

std::pair<std::string, std::string> parse_asr_output(const std::string & raw, const std::string & user_language) {
    const std::u32string stripped = py_strip(utf8_to_u32(raw));
    if (stripped.empty()) return {"", ""};
    const std::string s = detect_and_fix_repetitions(u32_to_utf8(stripped));
    if (!user_language.empty()) return {user_language, s};

    static const std::string kTag = "<asr_text>";
    const size_t tag = s.find(kTag);
    if (tag == std::string::npos) return {"", u32_to_utf8(py_strip(utf8_to_u32(s)))};
    const std::string meta = s.substr(0, tag);
    const std::string text_part = s.substr(tag + kTag.size());
    const std::string text_stripped = u32_to_utf8(py_strip(utf8_to_u32(text_part)));

    if (ascii_lower(meta).find("language none") != std::string::npos) {
        return {"", text_stripped};
    }
    std::string lang;
    size_t start = 0;
    while (start <= meta.size()) {
        size_t end = meta.find('\n', start);
        if (end == std::string::npos) end = meta.size();
        const std::string line = u32_to_utf8(py_strip(utf8_to_u32(meta.substr(start, end - start))));
        start = end + 1;
        if (line.empty()) {
            if (end == meta.size()) break;
            continue;
        }
        if (ascii_lower(line).rfind("language ", 0) == 0) {
            lang = normalize_language_name(line.substr(9));
        }
        break;
    }
    return {lang, text_stripped};
}

size_t py_len(const std::string & s) { return utf8_to_u32(s).size(); }

} // namespace r2t2
