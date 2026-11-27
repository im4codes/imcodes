#include "text_guards.hpp"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <winnls.h>
#elif defined(__APPLE__) && defined(IMCODES_USE_COREFOUNDATION)
#include <CoreFoundation/CoreFoundation.h>
#else
#include "qwen3_unicode_data.hpp"
#include "qwen3_unicode_nfkc_data.hpp"
#endif

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

inline bool is_hotword_combining_mark_cp(uint32_t cp) {
  return (cp >= 0x0300 && cp <= 0x036F)
      || (cp >= 0x0483 && cp <= 0x0489)
      || (cp >= 0x0591 && cp <= 0x05BD)
      || (cp >= 0x064B && cp <= 0x065F)
      || (cp >= 0x1AB0 && cp <= 0x1AFF)
      || (cp >= 0x1DC0 && cp <= 0x1DFF)
      || (cp >= 0x20D0 && cp <= 0x20FF)
      || (cp >= 0xFE00 && cp <= 0xFE0F)
      || (cp >= 0xFE20 && cp <= 0xFE2F)
      || (cp >= 0x1F3FB && cp <= 0x1F3FF);
}

inline bool is_hotword_ascii_alnum_cp(uint32_t cp) {
  return (cp >= '0' && cp <= '9')
      || (cp >= 'A' && cp <= 'Z')
      || (cp >= 'a' && cp <= 'z')
      || cp == '_';
}

struct HotwordCpRange {
  uint32_t start;
  uint32_t end;
};

// Exact sorted Unicode range table matching TS /^[\s\p{P}\p{Z}\u2026\u2022\u00B7~`+=|<>$¥€£°^]$/u.
// Excludes ordinary letters/numerals (e.g. 0x3007 '〇') and general symbols/emoji (e.g. '👍').
inline bool is_hotword_sep_cp(uint32_t cp) {
  static constexpr HotwordCpRange kRanges[] = {
      {0x9, 0xd}, {0x20, 0x2f}, {0x3a, 0x40}, {0x5b, 0x60},
      {0x7b, 0x7e}, {0xa0, 0xa1}, {0xa3, 0xa3}, {0xa5, 0xa5},
      {0xa7, 0xa7}, {0xab, 0xab}, {0xb0, 0xb0}, {0xb6, 0xb7},
      {0xbb, 0xbb}, {0xbf, 0xbf}, {0x37e, 0x37e}, {0x387, 0x387},
      {0x55a, 0x55f}, {0x589, 0x58a}, {0x5be, 0x5be}, {0x5c0, 0x5c0},
      {0x5c3, 0x5c3}, {0x5c6, 0x5c6}, {0x5f3, 0x5f4}, {0x609, 0x60a},
      {0x60c, 0x60d}, {0x61b, 0x61b}, {0x61d, 0x61f}, {0x66a, 0x66d},
      {0x6d4, 0x6d4}, {0x700, 0x70d}, {0x7f7, 0x7f9}, {0x830, 0x83e},
      {0x85e, 0x85e}, {0x964, 0x965}, {0x970, 0x970}, {0x9fd, 0x9fd},
      {0xa76, 0xa76}, {0xaf0, 0xaf0}, {0xc77, 0xc77}, {0xc84, 0xc84},
      {0xdf4, 0xdf4}, {0xe4f, 0xe4f}, {0xe5a, 0xe5b}, {0xf04, 0xf12},
      {0xf14, 0xf14}, {0xf3a, 0xf3d}, {0xf85, 0xf85}, {0xfd0, 0xfd4},
      {0xfd9, 0xfda}, {0x104a, 0x104f}, {0x10fb, 0x10fb}, {0x1360, 0x1368},
      {0x1400, 0x1400}, {0x166e, 0x166e}, {0x1680, 0x1680}, {0x169b, 0x169c},
      {0x16eb, 0x16ed}, {0x1735, 0x1736}, {0x17d4, 0x17d6}, {0x17d8, 0x17da},
      {0x1800, 0x180a}, {0x1944, 0x1945}, {0x1a1e, 0x1a1f}, {0x1aa0, 0x1aa6},
      {0x1aa8, 0x1aad}, {0x1b4e, 0x1b4f}, {0x1b5a, 0x1b60}, {0x1b7d, 0x1b7f},
      {0x1bfc, 0x1bff}, {0x1c3b, 0x1c3f}, {0x1c7e, 0x1c7f}, {0x1cc0, 0x1cc7},
      {0x1cd3, 0x1cd3}, {0x2000, 0x200a}, {0x2010, 0x2029}, {0x202f, 0x2043},
      {0x2045, 0x2051}, {0x2053, 0x205f}, {0x207d, 0x207e}, {0x208d, 0x208e},
      {0x20ac, 0x20ac}, {0x2308, 0x230b}, {0x2329, 0x232a}, {0x2768, 0x2775},
      {0x27c5, 0x27c6}, {0x27e6, 0x27ef}, {0x2983, 0x2998}, {0x29d8, 0x29db},
      {0x29fc, 0x29fd}, {0x2cf9, 0x2cfc}, {0x2cfe, 0x2cff}, {0x2d70, 0x2d70},
      {0x2e00, 0x2e2e}, {0x2e30, 0x2e4f}, {0x2e52, 0x2e5d}, {0x3000, 0x3003},
      {0x3008, 0x3011}, {0x3014, 0x301f}, {0x3030, 0x3030}, {0x303d, 0x303d},
      {0x30a0, 0x30a0}, {0x30fb, 0x30fb}, {0xa4fe, 0xa4ff}, {0xa60d, 0xa60f},
      {0xa673, 0xa673}, {0xa67e, 0xa67e}, {0xa6f2, 0xa6f7}, {0xa874, 0xa877},
      {0xa8ce, 0xa8cf}, {0xa8f8, 0xa8fa}, {0xa8fc, 0xa8fc}, {0xa92e, 0xa92f},
      {0xa95f, 0xa95f}, {0xa9c1, 0xa9cd}, {0xa9de, 0xa9df}, {0xaa5c, 0xaa5f},
      {0xaade, 0xaadf}, {0xaaf0, 0xaaf1}, {0xabeb, 0xabeb}, {0xfd3e, 0xfd3f},
      {0xfe10, 0xfe19}, {0xfe30, 0xfe52}, {0xfe54, 0xfe61}, {0xfe63, 0xfe63},
      {0xfe68, 0xfe68}, {0xfe6a, 0xfe6b}, {0xfeff, 0xfeff}, {0xff01, 0xff03},
      {0xff05, 0xff0a}, {0xff0c, 0xff0f}, {0xff1a, 0xff1b}, {0xff1f, 0xff20},
      {0xff3b, 0xff3d}, {0xff3f, 0xff3f}, {0xff5b, 0xff5b}, {0xff5d, 0xff5d},
      {0xff5f, 0xff65}, {0x10100, 0x10102}, {0x1039f, 0x1039f}, {0x103d0, 0x103d0},
      {0x1056f, 0x1056f}, {0x10857, 0x10857}, {0x1091f, 0x1091f}, {0x1093f, 0x1093f},
      {0x10a50, 0x10a58}, {0x10a7f, 0x10a7f}, {0x10af0, 0x10af6}, {0x10b39, 0x10b3f},
      {0x10b99, 0x10b9c}, {0x10d6e, 0x10d6e}, {0x10ead, 0x10ead}, {0x10ed0, 0x10ed0},
      {0x10f55, 0x10f59}, {0x10f86, 0x10f89}, {0x11047, 0x1104d}, {0x110bb, 0x110bc},
      {0x110be, 0x110c1}, {0x11140, 0x11143}, {0x11174, 0x11175}, {0x111c5, 0x111c8},
      {0x111cd, 0x111cd}, {0x111db, 0x111db}, {0x111dd, 0x111df}, {0x11238, 0x1123d},
      {0x112a9, 0x112a9}, {0x113d4, 0x113d5}, {0x113d7, 0x113d8}, {0x1144b, 0x1144f},
      {0x1145a, 0x1145b}, {0x1145d, 0x1145d}, {0x114c6, 0x114c6}, {0x115c1, 0x115d7},
      {0x11641, 0x11643}, {0x11660, 0x1166c}, {0x116b9, 0x116b9}, {0x1173c, 0x1173e},
      {0x1183b, 0x1183b}, {0x11944, 0x11946}, {0x119e2, 0x119e2}, {0x11a3f, 0x11a46},
      {0x11a9a, 0x11a9c}, {0x11a9e, 0x11aa2}, {0x11b00, 0x11b09}, {0x11be1, 0x11be1},
      {0x11c41, 0x11c45}, {0x11c70, 0x11c71}, {0x11ef7, 0x11ef8}, {0x11f43, 0x11f4f},
      {0x11fff, 0x11fff}, {0x12470, 0x12474}, {0x12ff1, 0x12ff2}, {0x16a6e, 0x16a6f},
      {0x16af5, 0x16af5}, {0x16b37, 0x16b3b}, {0x16b44, 0x16b44}, {0x16d6d, 0x16d6f},
      {0x16e97, 0x16e9a}, {0x16fe2, 0x16fe2}, {0x1bc9f, 0x1bc9f}, {0x1da87, 0x1da8b},
      {0x1e5ff, 0x1e5ff}, {0x1e95e, 0x1e95f},
  };
  const auto* begin = std::begin(kRanges);
  const auto* end = std::end(kRanges);
  const auto* it = std::upper_bound(
      begin, end, cp, [](uint32_t value, const HotwordCpRange& r) { return value < r.start; });
  if (it == begin) return false;
  --it;
  return cp <= it->end;
}

inline bool is_hotword_sentence_end_cp(uint32_t cp) {
  return cp == '.' || cp == '!' || cp == '?' || cp == ';'
      || cp == '\n' || cp == '\r'
      || cp == 0x3002 || cp == 0xFF01 || cp == 0xFF1F || cp == 0xFF1B;
}

inline bool is_hotword_weak_trailing_sep_cp(uint32_t cp) {
  return cp == ' ' || cp == '\t' || cp == '\r' || cp == '\n'
      || cp == ',' || cp == ':' || cp == '-'
      || cp == 0x3001 || cp == 0x2013 || cp == 0x2014 || cp == 0x00B7 || cp == 0x2022;
}

inline bool is_hotword_intra_word_punct_cp(uint32_t cp) {
  return cp == '.' || cp == '-' || cp == '_' || cp == '\'' || cp == '/' || cp == '+';
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

inline HotwordNfkcNormalizerFn& hotword_nfkc_normalizer_override() {
  static HotwordNfkcNormalizerFn fn = nullptr;
  return fn;
}

std::string default_os_nfkc_lower_utf8(const std::string& input) {
  if (input.empty()) return {};
#ifdef _WIN32
  const int wlen = MultiByteToWideChar(CP_UTF8, 0, input.data(), static_cast<int>(input.size()), nullptr, 0);
  if (wlen <= 0) return input;
  std::wstring wsrc(static_cast<size_t>(wlen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, input.data(), static_cast<int>(input.size()), wsrc.data(), wlen);

  int kclen = NormalizeString(NormalizationKC, wsrc.data(), wlen, nullptr, 0);
  std::wstring wnfkc;
  if (kclen > 0) {
    wnfkc.resize(static_cast<size_t>(kclen), L'\0');
    const int actual = NormalizeString(NormalizationKC, wsrc.data(), wlen, wnfkc.data(), kclen);
    if (actual > 0) {
      wnfkc.resize(static_cast<size_t>(actual));
    } else {
      wnfkc = wsrc;
    }
  } else {
    wnfkc = wsrc;
  }

  std::wstring wlower = wnfkc;
  if (!wnfkc.empty()) {
    const int lclen = LCMapStringEx(
        LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, wnfkc.data(), static_cast<int>(wnfkc.size()), nullptr, 0, nullptr, nullptr, 0);
    if (lclen > 0) {
      std::wstring tmp(static_cast<size_t>(lclen), L'\0');
      const int actual = LCMapStringEx(
          LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, wnfkc.data(), static_cast<int>(wnfkc.size()), tmp.data(), lclen, nullptr, nullptr, 0);
      if (actual > 0) {
        tmp.resize(static_cast<size_t>(actual));
        wlower = std::move(tmp);
      }
    }
  }

  const int u8len = WideCharToMultiByte(
      CP_UTF8, 0, wlower.data(), static_cast<int>(wlower.size()), nullptr, 0, nullptr, nullptr);
  if (u8len <= 0) return input;
  std::string out(static_cast<size_t>(u8len), '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, wlower.data(), static_cast<int>(wlower.size()), out.data(), u8len, nullptr, nullptr);
  return out;
#elif defined(__APPLE__) && defined(IMCODES_USE_COREFOUNDATION)
  CFStringRef src = CFStringCreateWithBytes(
      kCFAllocatorDefault,
      reinterpret_cast<const UInt8*>(input.data()),
      static_cast<CFIndex>(input.size()),
      kCFStringEncodingUTF8,
      false);
  if (!src) return input;
  CFMutableStringRef mut = CFStringCreateMutableCopy(kCFAllocatorDefault, 0, src);
  CFRelease(src);
  if (!mut) return input;
  CFStringNormalize(mut, kCFStringNormalizationFormKC);
  CFStringLowercase(mut, nullptr);
  const CFIndex len = CFStringGetLength(mut);
  const CFIndex max_bytes = CFStringGetMaximumSizeForEncoding(len, kCFStringEncodingUTF8) + 1;
  std::string out(static_cast<size_t>(max_bytes), '\0');
  CFIndex used = 0;
  CFStringGetBytes(
      mut,
      CFRangeMake(0, len),
      kCFStringEncodingUTF8,
      0,
      false,
      reinterpret_cast<UInt8*>(out.data()),
      max_bytes,
      &used);
  CFRelease(mut);
  out.resize(static_cast<size_t>(used));
  return out;
#else
  // Full Unicode 16.0 NFKC + Unicode lowercase fallback (used on Linux and any non-Win/macOS target).
  auto lookup_ccc = [](uint32_t cp) -> uint8_t {
    if (cp < 0x0300u) return 0;
    constexpr size_t kCount = sizeof(unicode_detail::kCccTable) / sizeof(unicode_detail::kCccTable[0]);
    auto it = std::lower_bound(
        unicode_detail::kCccTable,
        unicode_detail::kCccTable + kCount,
        cp,
        [](const unicode_detail::CccEntry& e, uint32_t key) { return e.cp < key; });
    if (it != unicode_detail::kCccTable + kCount && it->cp == cp) {
      return it->ccc;
    }
    return 0;
  };
  auto lookup_composite = [](uint32_t first, uint32_t second) -> uint32_t {
    const uint64_t key = (static_cast<uint64_t>(first) << 21) | (static_cast<uint64_t>(second) & 0x1FFFFFu);
    constexpr size_t kCount = sizeof(unicode_detail::kCompTable) / sizeof(unicode_detail::kCompTable[0]);
    auto it = std::lower_bound(
        unicode_detail::kCompTable,
        unicode_detail::kCompTable + kCount,
        key,
        [](const unicode_detail::CompEntry& e, uint64_t k) { return e.key < k; });
    if (it != unicode_detail::kCompTable + kCount && it->key == key) {
      return it->composed;
    }
    return 0;
  };

  const std::vector<uint32_t> cps_in = utf8_to_codepoints(input);
  std::vector<uint32_t> nfkd;
  nfkd.reserve(cps_in.size() * 2);
  constexpr size_t kNfkdCount = sizeof(unicode_detail::kNfkdTable) / sizeof(unicode_detail::kNfkdTable[0]);
  for (uint32_t cp : cps_in) {
    if (cp >= 0xAC00u && cp <= 0xD7A3u) {
      const uint32_t s_index = cp - 0xAC00u;
      nfkd.push_back(0x1100u + s_index / 588u);
      nfkd.push_back(0x1161u + (s_index % 588u) / 28u);
      const uint32_t t_index = s_index % 28u;
      if (t_index > 0) nfkd.push_back(0x11A7u + t_index);
      continue;
    }
    auto it = std::lower_bound(
        unicode_detail::kNfkdTable,
        unicode_detail::kNfkdTable + kNfkdCount,
        cp,
        [](const unicode_detail::NfkdEntry& e, uint32_t key) { return e.cp < key; });
    if (it != unicode_detail::kNfkdTable + kNfkdCount && it->cp == cp) {
      const uint32_t off = it->offset_len >> 5;
      const uint32_t len = it->offset_len & 0x1Fu;
      for (uint32_t k = 0; k < len; ++k) {
        nfkd.push_back(unicode_detail::kNfkdPool[off + k]);
      }
    } else {
      nfkd.push_back(cp);
    }
  }

  for (size_t i = 0; i < nfkd.size();) {
    if (lookup_ccc(nfkd[i]) == 0) {
      ++i;
      continue;
    }
    size_t j = i + 1;
    while (j < nfkd.size() && lookup_ccc(nfkd[j]) != 0) ++j;
    for (size_t a = i + 1; a < j; ++a) {
      const uint32_t key_cp = nfkd[a];
      const uint8_t key_ccc = lookup_ccc(key_cp);
      size_t b = a;
      while (b > i && lookup_ccc(nfkd[b - 1]) > key_ccc) {
        nfkd[b] = nfkd[b - 1];
        --b;
      }
      nfkd[b] = key_cp;
    }
    i = j;
  }

  std::vector<uint32_t> composed;
  composed.reserve(nfkd.size());
  size_t starter_idx = std::string::npos;
  uint8_t last_ccc = 0;
  for (uint32_t cp : nfkd) {
    const uint8_t ccc = lookup_ccc(cp);
    if (starter_idx != std::string::npos && (last_ccc == 0 || last_ccc < ccc)) {
      const uint32_t starter = composed[starter_idx];
      uint32_t merged = 0;
      if (last_ccc == 0) {
        if (starter >= 0x1100u && starter <= 0x1112u && cp >= 0x1161u && cp <= 0x1175u) {
          merged = 0xAC00u + ((starter - 0x1100u) * 21u + (cp - 0x1161u)) * 28u;
        } else if (starter >= 0xAC00u && starter <= 0xD7A3u && ((starter - 0xAC00u) % 28u) == 0 &&
                   cp >= 0x11A8u && cp <= 0x11C2u) {
          merged = starter + (cp - 0x11A7u);
        }
      }
      if (merged == 0) {
        merged = lookup_composite(starter, cp);
      }
      if (merged != 0) {
        composed[starter_idx] = merged;
        continue;
      }
    }
    if (ccc == 0) {
      starter_idx = composed.size();
      last_ccc = 0;
    } else {
      last_ccc = ccc;
    }
    composed.push_back(cp);
  }

  std::vector<uint32_t> lowered;
  lowered.reserve(composed.size());
  constexpr size_t kLowerCount = sizeof(unicode_detail::kLowerTable) / sizeof(unicode_detail::kLowerTable[0]);
  for (uint32_t cp : composed) {
    auto it = std::lower_bound(
        unicode_detail::kLowerTable,
        unicode_detail::kLowerTable + kLowerCount,
        cp,
        [](const unicode_detail::NfkdEntry& e, uint32_t key) { return e.cp < key; });
    if (it != unicode_detail::kLowerTable + kLowerCount && it->cp == cp) {
      const uint32_t off = it->offset_len >> 5;
      const uint32_t len = it->offset_len & 0x1Fu;
      for (uint32_t k = 0; k < len; ++k) {
        lowered.push_back(unicode_detail::kLowerPool[off + k]);
      }
    } else {
      lowered.push_back(cp);
    }
  }
  return codepoints_to_utf8(lowered);
#endif
}

std::vector<uint32_t> normalize_hotword_utf8_to_cps(const std::string& input) {
  if (input.empty()) return {};
  const HotwordNfkcNormalizerFn custom = hotword_nfkc_normalizer_override();
  const std::string nfkc = custom ? custom(input) : default_os_nfkc_lower_utf8(input);
  std::vector<uint32_t> out = utf8_to_codepoints(nfkc);
  for (uint32_t& cp : out) {
    cp = normalize_hotword_cp(cp);
  }
  return out;
}

inline void decode_next_utf8_raw(const std::string& s, size_t& i, uint32_t& out_cp) {
  const size_t n = s.size();
  const unsigned char b = static_cast<unsigned char>(s[i]);
  if (b < 0x80) {
    out_cp = b;
    i += 1;
  } else if ((b & 0xE0) == 0xC0 && i + 1 < n) {
    out_cp = (static_cast<uint32_t>(b & 0x1F) << 6) |
             static_cast<uint32_t>(static_cast<unsigned char>(s[i + 1]) & 0x3F);
    i += 2;
  } else if ((b & 0xF0) == 0xE0 && i + 2 < n) {
    out_cp = (static_cast<uint32_t>(b & 0x0F) << 12) |
             (static_cast<uint32_t>(static_cast<unsigned char>(s[i + 1]) & 0x3F) << 6) |
             static_cast<uint32_t>(static_cast<unsigned char>(s[i + 2]) & 0x3F);
    i += 3;
  } else if ((b & 0xF8) == 0xF0 && i + 3 < n) {
    out_cp = (static_cast<uint32_t>(b & 0x07) << 18) |
             (static_cast<uint32_t>(static_cast<unsigned char>(s[i + 1]) & 0x3F) << 12) |
             (static_cast<uint32_t>(static_cast<unsigned char>(s[i + 2]) & 0x3F) << 6) |
             static_cast<uint32_t>(static_cast<unsigned char>(s[i + 3]) & 0x3F);
    i += 4;
  } else {
    out_cp = b;
    i += 1;
  }
}

inline size_t advance_next_grapheme_cluster(const std::string& text, size_t start) {
  const size_t bytes = text.size();
  if (start >= bytes) return bytes;
  size_t i = start;
  uint32_t first_cp = 0;
  decode_next_utf8_raw(text, i, first_cp);

  if (first_cp >= 0x1F1E6 && first_cp <= 0x1F1FF && i < bytes) {
    size_t peek = i;
    uint32_t next_cp = 0;
    decode_next_utf8_raw(text, peek, next_cp);
    if (next_cp >= 0x1F1E6 && next_cp <= 0x1F1FF) {
      i = peek;
    }
  }

  auto is_jamo_l = [](uint32_t c) { return (c >= 0x1100 && c <= 0x115F) || (c >= 0xA960 && c <= 0xA97C); };
  auto is_jamo_v = [](uint32_t c) { return (c >= 0x1160 && c <= 0x11A7) || (c >= 0xD7B0 && c <= 0xD7C6); };
  auto is_jamo_t = [](uint32_t c) { return (c >= 0x11A8 && c <= 0x11FF) || (c >= 0xD7CB && c <= 0xD7FB); };
  if (is_jamo_l(first_cp) || is_jamo_v(first_cp)) {
    uint32_t last_hangul = first_cp;
    while (i < bytes) {
      size_t peek = i;
      uint32_t next_cp = 0;
      decode_next_utf8_raw(text, peek, next_cp);
      if ((is_jamo_l(last_hangul) && (is_jamo_l(next_cp) || is_jamo_v(next_cp))) ||
          (is_jamo_v(last_hangul) && (is_jamo_v(next_cp) || is_jamo_t(next_cp))) ||
          (is_jamo_t(last_hangul) && is_jamo_t(next_cp))) {
        i = peek;
        last_hangul = next_cp;
      } else {
        break;
      }
    }
  }

  while (i < bytes) {
    size_t peek = i;
    uint32_t next_cp = 0;
    decode_next_utf8_raw(text, peek, next_cp);
    if (is_hotword_combining_mark_cp(next_cp)) {
      i = peek;
      continue;
    }
    if (next_cp == 0x200D && peek < bytes) {
      i = peek;
      uint32_t joined_cp = 0;
      decode_next_utf8_raw(text, i, joined_cp);
      continue;
    }
    break;
  }
  return i;
}

struct NormalizedClusterMap {
  std::vector<uint32_t> cps;
  std::vector<size_t> norm_to_raw_byte;
  std::vector<size_t> cluster_start;
  std::vector<uint8_t> is_sep;
  std::vector<uint8_t> is_sent_end;
  std::vector<uint8_t> is_weak_sep;
  std::vector<uint8_t> is_intra_punct;
  std::vector<uint8_t> is_ascii_alnum;
};

NormalizedClusterMap build_normalized_cluster_map(const std::string& text) {
  NormalizedClusterMap map;
  size_t i = 0;
  const size_t bytes = text.size();
  while (i < bytes) {
    const size_t raw_start = i;
    const size_t raw_end = advance_next_grapheme_cluster(text, i);
    i = raw_end;
    const std::string raw_cluster = text.substr(raw_start, raw_end - raw_start);
    const std::vector<uint32_t> norm_cps = normalize_hotword_utf8_to_cps(raw_cluster);
    if (norm_cps.empty()) continue;
    const size_t c_start = map.cps.size();
    for (uint32_t norm_cp : norm_cps) {
      map.cps.push_back(norm_cp);
      map.norm_to_raw_byte.push_back(raw_start);
      map.cluster_start.push_back(c_start);
      map.is_sep.push_back(is_hotword_sep_cp(norm_cp) ? 1 : 0);
      map.is_sent_end.push_back(is_hotword_sentence_end_cp(norm_cp) ? 1 : 0);
      map.is_weak_sep.push_back(is_hotword_weak_trailing_sep_cp(norm_cp) ? 1 : 0);
      map.is_intra_punct.push_back(is_hotword_intra_word_punct_cp(norm_cp) ? 1 : 0);
      map.is_ascii_alnum.push_back(is_hotword_ascii_alnum_cp(norm_cp) ? 1 : 0);
    }
  }
  map.norm_to_raw_byte.push_back(bytes);
  map.cluster_start.push_back(map.cps.size());
  return map;
}

struct HallucinationTrieNode {
  std::unordered_map<uint32_t, int> children;
  int term_id{-1};
};

struct HallucinationMatcher {
  std::vector<HallucinationTrieNode> fwd_nodes;
  std::vector<HallucinationTrieNode> rev_nodes;
  std::vector<uint8_t> term_starts_ascii;
  std::vector<uint8_t> term_ends_ascii;
  std::vector<uint32_t> term_first_cp;
  std::vector<uint32_t> term_last_cp;
};

struct Distinct3State {
  int t1{-1};
  int t2{-1};
  int count{-1};
};

inline Distinct3State advance_distinct3(const Distinct3State& st, int tid) {
  if (st.count < 0 || st.count >= 3) return st;
  if (st.count == 0) return {tid, -1, 1};
  if (st.count == 1) return st.t1 == tid ? st : Distinct3State{st.t1, tid, 2};
  if (tid == st.t1 || tid == st.t2) return st;
  return {st.t1, st.t2, 3};
}

inline bool has_valid_leading_sep(const NormalizedClusterMap& map, size_t pos) {
  if (map.is_ascii_alnum[pos] == 0) return true;
  size_t scan = pos;
  while (scan > 0) {
    const size_t c = map.cluster_start[scan - 1];
    if (map.is_sep[c] == 0) break;
    for (size_t k = c; k < scan; ++k) {
      if (map.is_intra_punct[k] == 0) return true;
    }
    scan = c;
  }
  return false;
}

inline std::pair<bool, bool> is_valid_trailing_left_boundary(
    const NormalizedClusterMap& map,
    size_t p,
    bool term_starts_ascii) {
  size_t scan = p;
  bool sent_end = false;
  bool has_real_sep = false;
  while (scan > 0) {
    const size_t c = map.cluster_start[scan - 1];
    if (map.is_sep[c] == 0) break;
    for (size_t k = c; k < scan; ++k) {
      if (map.is_sent_end[k] == 1) sent_end = true;
      if (map.is_intra_punct[k] == 0) has_real_sep = true;
    }
    scan = c;
  }
  const bool has_sep_before = scan < p;
  const bool before_sep_ascii = scan > 0 ? (map.is_ascii_alnum[scan - 1] == 1) : false;
  const bool valid = has_sep_before
      ? !(term_starts_ascii && !has_real_sep && before_sep_ascii)
      : (term_starts_ascii && !before_sep_ascii);
  return {valid, sent_end};
}

constexpr int kRuleASingleCrossedEnd = 1;
constexpr int kRuleASingleClean = 2;
constexpr int kRuleAQualCrossedEnd = 3;
constexpr int kRuleAQualInternal = 4;

inline int advance_rule_a(int prev_state) {
  return (prev_state == kRuleASingleClean || prev_state >= kRuleAQualCrossedEnd)
      ? kRuleAQualInternal
      : kRuleAQualCrossedEnd;
}

size_t find_leading_rule_a_cut(
    const HallucinationMatcher& matcher,
    const NormalizedClusterMap& map) {
  const size_t n = map.cps.size();
  if (n == 0) return 0;

  std::vector<uint8_t> completed_sep(n + 1, 0);
  std::vector<uint8_t> pending_cross_end_sep(n + 1, 0);
  std::vector<std::unordered_map<int, int>> sep_run(n + 1);
  std::vector<std::unordered_map<int, int>> imm_same(n + 1);
  completed_sep[0] = 1;
  size_t best_cut = 0;

  auto record_run = [](std::unordered_map<int, int>& m, int tid, int st) {
    auto it = m.find(tid);
    if (it == m.end() || st > it->second) m[tid] = st;
  };

  for (size_t pos = 0; pos < n; ++pos) {
    const bool can_start_fresh = completed_sep[pos] == 1;
    const bool is_pending_cross_end = pending_cross_end_sep[pos] == 1;
    auto& run_map = sep_run[pos];
    auto& imm_map = imm_same[pos];
    if (!can_start_fresh && !is_pending_cross_end && run_map.empty() && imm_map.empty()) continue;

    if (pos > 0 && pos == map.cluster_start[pos] && map.is_sep[pos] == 0 && can_start_fresh) {
      if (has_valid_leading_sep(map, pos)) {
        best_cut = pos;
      }
    }

    if (map.is_sep[pos] == 1) {
      const bool is_sent_end = map.is_sent_end[pos] == 1;
      if (can_start_fresh || (is_pending_cross_end && is_sent_end)) {
        completed_sep[pos + 1] = 1;
      } else if (is_pending_cross_end) {
        pending_cross_end_sep[pos + 1] = 1;
      }
      auto step_map = [&](const std::unordered_map<int, int>& src) {
        for (const auto& kv : src) {
          if (kv.second == kRuleAQualInternal) {
            completed_sep[pos + 1] = 1;
            if (!is_sent_end) record_run(sep_run[pos + 1], kv.first, kv.second);
          } else if (kv.second == kRuleAQualCrossedEnd) {
            if (is_sent_end) {
              completed_sep[pos + 1] = 1;
            } else {
              pending_cross_end_sep[pos + 1] = 1;
              record_run(sep_run[pos + 1], kv.first, kv.second);
            }
          } else {
            const int next_st = is_sent_end ? kRuleASingleCrossedEnd : kv.second;
            record_run(sep_run[pos + 1], kv.first, next_st);
          }
        }
      };
      step_map(run_map);
      step_map(imm_map);
    }

    if (pos != map.cluster_start[pos]) {
      run_map.clear();
      imm_map.clear();
      continue;
    }

    int cur_node_idx = 0;
    for (size_t p = pos; p < n; ++p) {
      const auto it = matcher.fwd_nodes[cur_node_idx].children.find(map.cps[p]);
      if (it == matcher.fwd_nodes[cur_node_idx].children.end()) break;
      cur_node_idx = it->second;
      const int tid = matcher.fwd_nodes[cur_node_idx].term_id;
      if (tid < 0) continue;

      const size_t end_pos = p + 1;
      if (end_pos < n && end_pos != map.cluster_start[end_pos]) continue;

      int next_state = can_start_fresh ? kRuleASingleClean : 0;
      const auto rit = run_map.find(tid);
      if (rit != run_map.end() && rit->second > 0) {
        next_state = std::max(next_state, advance_rule_a(rit->second));
      }
      const auto iit = imm_map.find(tid);
      if (iit != imm_map.end() && iit->second > 0) {
        next_state = std::max(next_state, advance_rule_a(iit->second));
      }
      if (next_state == 0) continue;

      if (!matcher.term_ends_ascii[tid] || end_pos == n) {
        record_run(sep_run[end_pos], tid, next_state);
      } else {
        record_run(imm_same[end_pos], tid, next_state);
      }
    }
    run_map.clear();
    imm_map.clear();
  }
  return best_cut;
}

size_t find_leading_rule_b_cut(
    const HallucinationMatcher& matcher,
    const NormalizedClusterMap& map) {
  const size_t n = map.cps.size();
  if (n == 0) return 0;

  std::vector<Distinct3State> cleared_st(n + 1);
  std::vector<uint8_t> cleared_from_sep(n + 1, 0);
  std::vector<uint8_t> cleared_sep_end(n + 1, 0);
  std::vector<Distinct3State> ended_ascii_st(n + 1);
  std::vector<std::unordered_map<int, Distinct3State>> same_st(n + 1);

  cleared_st[0].count = 0;
  size_t best_cut = 0;

  for (size_t pos = 0; pos < n; ++pos) {
    const Distinct3State& c_st = cleared_st[pos];
    const Distinct3State& a_st = ended_ascii_st[pos];
    const bool has_c = c_st.count >= 0;
    auto& s_map = same_st[pos];
    if (!has_c && a_st.count < 0 && s_map.empty()) continue;

    bool has_best = has_c;
    Distinct3State best_st = c_st;
    if (a_st.count >= 0 && (!has_best || a_st.count > best_st.count)) {
      has_best = true;
      best_st = a_st;
    }
    for (const auto& kv : s_map) {
      if (kv.second.count >= 0 && (!has_best || kv.second.count > best_st.count)) {
        has_best = true;
        best_st = kv.second;
      }
    }
    if (!has_best) {
      s_map.clear();
      continue;
    }

    if (pos > 0 && pos == map.cluster_start[pos] && map.is_sep[pos] == 0 &&
        cleared_from_sep[pos] == 1 && cleared_sep_end[pos] == 1 && has_c && c_st.count >= 3) {
      if (has_valid_leading_sep(map, pos)) {
        best_cut = pos;
      }
    }

    if (map.is_sep[pos] == 1) {
      const bool propagated_from_cleared = has_c && best_st.count == c_st.count;
      const uint8_t next_end = ((propagated_from_cleared && cleared_from_sep[pos] == 1 && cleared_sep_end[pos] == 1) || map.is_sent_end[pos] == 1) ? 1 : 0;
      if (!(best_st.count >= 3 && map.is_sent_end[pos] == 1 && cleared_from_sep[pos] == 1 && cleared_sep_end[pos] == 1)) {
        auto& dst = cleared_st[pos + 1];
        if (best_st.count > dst.count || (best_st.count == dst.count && next_end > cleared_sep_end[pos + 1])) {
          dst = best_st;
          cleared_from_sep[pos + 1] = 1;
          cleared_sep_end[pos + 1] = next_end;
        }
      }
    }

    if (pos != map.cluster_start[pos] || (cleared_from_sep[pos] == 1 && cleared_sep_end[pos] == 1 && has_c && c_st.count >= 3)) {
      s_map.clear();
      continue;
    }

    int cur_node_idx = 0;
    for (size_t p = pos; p < n; ++p) {
      const auto it = matcher.fwd_nodes[cur_node_idx].children.find(map.cps[p]);
      if (it == matcher.fwd_nodes[cur_node_idx].children.end()) break;
      cur_node_idx = it->second;
      const int tid = matcher.fwd_nodes[cur_node_idx].term_id;
      if (tid < 0) continue;

      const size_t end_pos = p + 1;
      if (end_pos < n && end_pos != map.cluster_start[end_pos]) continue;

      bool has_start = matcher.term_starts_ascii[tid] ? has_c : has_best;
      Distinct3State start_st = matcher.term_starts_ascii[tid] ? c_st : best_st;
      const auto same_it = s_map.find(tid);
      if (same_it != s_map.end() && (!has_start || same_it->second.count > start_st.count)) {
        has_start = true;
        start_st = same_it->second;
      }
      if (!has_start) continue;

      const Distinct3State next_st = advance_distinct3(start_st, tid);
      if (!matcher.term_ends_ascii[tid] || end_pos == n) {
        if (next_st.count > cleared_st[end_pos].count) {
          cleared_st[end_pos] = next_st;
          cleared_from_sep[end_pos] = 0;
          cleared_sep_end[end_pos] = 0;
        }
      } else {
        if (next_st.count > ended_ascii_st[end_pos].count) {
          ended_ascii_st[end_pos] = next_st;
        }
        if (matcher.term_starts_ascii[tid] && map.cps[end_pos] == matcher.term_first_cp[tid]) {
          auto& dst = same_st[end_pos][tid];
          if (next_st.count > dst.count) dst = next_st;
        }
      }
    }
    s_map.clear();
  }
  return best_cut;
}

size_t find_leading_cut(
    const HallucinationMatcher& matcher,
    const NormalizedClusterMap& map) {
  return std::max(find_leading_rule_a_cut(matcher, map), find_leading_rule_b_cut(matcher, map));
}

size_t find_trailing_rule_a_cut(
    const HallucinationMatcher& matcher,
    const NormalizedClusterMap& map) {
  const size_t n = map.cps.size();
  if (n == 0) return n;

  std::vector<uint8_t> completed_sep(n + 1, 0);
  std::vector<uint8_t> pending_cross_end_sep(n + 1, 0);
  std::vector<std::unordered_map<int, int>> sep_run(n + 1);
  std::vector<std::unordered_map<int, int>> rev_same(n + 1);
  completed_sep[n] = 1;
  size_t best_term_start = n;

  auto record_run = [](std::unordered_map<int, int>& m, int tid, int st) {
    auto it = m.find(tid);
    if (it == m.end() || st > it->second) m[tid] = st;
  };

  for (size_t pos = n; pos > 0; --pos) {
    if (pos < n && pos != map.cluster_start[pos]) continue;
    const bool can_end_fresh = completed_sep[pos] == 1;
    const bool is_pending_cross_end = pending_cross_end_sep[pos] == 1;
    auto& run_map = sep_run[pos];
    auto& imm_map = rev_same[pos];
    if (!can_end_fresh && !is_pending_cross_end && run_map.empty() && imm_map.empty()) continue;

    const size_t prev_c = map.cluster_start[pos - 1];
    if (map.is_sep[prev_c] == 1) {
      bool sep_has_end = false;
      for (size_t k = prev_c; k < pos; ++k) {
        if (map.is_sent_end[k] == 1) {
          sep_has_end = true;
          break;
        }
      }
      if (can_end_fresh || (is_pending_cross_end && sep_has_end)) {
        completed_sep[prev_c] = 1;
      } else if (is_pending_cross_end) {
        pending_cross_end_sep[prev_c] = 1;
      }
      auto step_map = [&](const std::unordered_map<int, int>& src) {
        for (const auto& kv : src) {
          if (kv.second == kRuleAQualInternal) {
            completed_sep[prev_c] = 1;
            if (!sep_has_end) record_run(sep_run[prev_c], kv.first, kv.second);
          } else if (kv.second == kRuleAQualCrossedEnd) {
            if (sep_has_end) {
              completed_sep[prev_c] = 1;
            } else {
              pending_cross_end_sep[prev_c] = 1;
              record_run(sep_run[prev_c], kv.first, kv.second);
            }
          } else {
            const int next_st = sep_has_end ? kRuleASingleCrossedEnd : kv.second;
            record_run(sep_run[prev_c], kv.first, next_st);
          }
        }
      };
      step_map(run_map);
      step_map(imm_map);
    }

    int cur_rev_idx = 0;
    for (size_t p = pos; p > 0; --p) {
      const size_t idx = p - 1;
      const auto it = matcher.rev_nodes[cur_rev_idx].children.find(map.cps[idx]);
      if (it == matcher.rev_nodes[cur_rev_idx].children.end()) break;
      cur_rev_idx = it->second;
      const int tid = matcher.rev_nodes[cur_rev_idx].term_id;
      if (tid < 0) continue;
      if (idx != map.cluster_start[idx]) continue;

      int next_state = can_end_fresh ? kRuleASingleClean : 0;
      const auto rit = run_map.find(tid);
      if (rit != run_map.end() && rit->second > 0) {
        next_state = std::max(next_state, advance_rule_a(rit->second));
      }
      const auto iit = imm_map.find(tid);
      if (iit != imm_map.end() && iit->second > 0) {
        next_state = std::max(next_state, advance_rule_a(iit->second));
      }
      if (next_state == 0) continue;

      if (!matcher.term_starts_ascii[tid] || idx == 0) {
        record_run(sep_run[idx], tid, next_state);
      } else {
        record_run(rev_same[idx], tid, next_state);
      }

      if (next_state >= kRuleAQualCrossedEnd && idx > 0) {
        const auto [valid, sent_end] = is_valid_trailing_left_boundary(map, idx, matcher.term_starts_ascii[tid] == 1);
        const bool allows_cut = (next_state == kRuleAQualInternal) || sent_end;
        if (valid && allows_cut && idx < best_term_start) {
          best_term_start = idx;
        }
      }
    }
    run_map.clear();
    imm_map.clear();
  }
  return best_term_start;
}

size_t find_trailing_rule_b_cut(
    const HallucinationMatcher& matcher,
    const NormalizedClusterMap& map) {
  const size_t n = map.cps.size();
  if (n == 0) return n;

  std::vector<Distinct3State> rev_cleared(n + 1);
  std::vector<uint8_t> rev_cleared_locked(n + 1, 0);
  std::vector<Distinct3State> rev_ascii(n + 1);
  std::vector<std::unordered_map<int, Distinct3State>> rev_same(n + 1);

  rev_cleared[n].count = 0;
  size_t best_term_start = n;

  for (size_t pos = n; pos > 0; --pos) {
    if (pos < n && pos != map.cluster_start[pos]) continue;
    const Distinct3State& c_st = rev_cleared[pos];
    const Distinct3State& a_st = rev_ascii[pos];
    const bool has_c = c_st.count >= 0;
    auto& s_map = rev_same[pos];
    if (!has_c && a_st.count < 0 && s_map.empty()) continue;

    bool has_best = has_c;
    Distinct3State best_st = c_st;
    if (a_st.count >= 0 && (!has_best || a_st.count > best_st.count)) {
      has_best = true;
      best_st = a_st;
    }
    for (const auto& kv : s_map) {
      if (kv.second.count >= 0 && (!has_best || kv.second.count > best_st.count)) {
        has_best = true;
        best_st = kv.second;
      }
    }
    if (!has_best) {
      s_map.clear();
      continue;
    }

    const size_t prev_c = map.cluster_start[pos - 1];
    if (map.is_sep[prev_c] == 1) {
      bool sep_has_end = false;
      for (size_t k = prev_c; k < pos; ++k) {
        if (map.is_sent_end[k] == 1) {
          sep_has_end = true;
          break;
        }
      }
      const bool crossed_after_valid = best_st.count >= 3 && sep_has_end;
      if (!(best_st.count >= 3 && rev_cleared_locked[pos] == 1)) {
        if (best_st.count > rev_cleared[prev_c].count) {
          rev_cleared[prev_c] = best_st;
          rev_cleared_locked[prev_c] = (rev_cleared_locked[pos] == 1 || crossed_after_valid) ? 1 : 0;
        }
      }
    }

    if (rev_cleared_locked[pos] == 1) {
      s_map.clear();
      continue;
    }

    int cur_rev_idx = 0;
    for (size_t p = pos; p > 0; --p) {
      const size_t idx = p - 1;
      const auto it = matcher.rev_nodes[cur_rev_idx].children.find(map.cps[idx]);
      if (it == matcher.rev_nodes[cur_rev_idx].children.end()) break;
      cur_rev_idx = it->second;
      const int tid = matcher.rev_nodes[cur_rev_idx].term_id;
      if (tid < 0) continue;
      if (idx != map.cluster_start[idx]) continue;

      bool has_right = matcher.term_ends_ascii[tid] ? has_c : has_best;
      Distinct3State right_st = matcher.term_ends_ascii[tid] ? c_st : best_st;
      const auto same_it = s_map.find(tid);
      if (same_it != s_map.end() && (!has_right || same_it->second.count > right_st.count)) {
        has_right = true;
        right_st = same_it->second;
      }
      if (!has_right) continue;

      const Distinct3State next_st = advance_distinct3(right_st, tid);
      if (!matcher.term_starts_ascii[tid] || idx == 0) {
        if (next_st.count > rev_cleared[idx].count) rev_cleared[idx] = next_st;
      } else {
        if (next_st.count > rev_ascii[idx].count) rev_ascii[idx] = next_st;
        if (matcher.term_ends_ascii[tid] && idx > 0 && map.cps[idx - 1] == matcher.term_last_cp[tid]) {
          auto& dst = rev_same[idx][tid];
          if (next_st.count > dst.count) dst = next_st;
        }
      }

      if (next_st.count >= 3 && idx > 0) {
        const auto [valid, sent_end] = is_valid_trailing_left_boundary(map, idx, matcher.term_starts_ascii[tid] == 1);
        if (valid && sent_end && idx < best_term_start) {
          best_term_start = idx;
        }
      }
    }
    s_map.clear();
  }
  return best_term_start;
}

size_t find_trailing_cut(
    const HallucinationMatcher& matcher,
    const NormalizedClusterMap& map) {
  const size_t n = map.cps.size();
  if (n == 0) return n;
  const size_t start_a = find_trailing_rule_a_cut(matcher, map);
  const size_t start_b = find_trailing_rule_b_cut(matcher, map);
  const size_t best_term_start = std::min(start_a, start_b);
  if (best_term_start >= n) return n;
  size_t cut = best_term_start;
  while (cut > 0) {
    const size_t c = map.cluster_start[cut - 1];
    bool all_weak = true;
    for (size_t k = c; k < cut; ++k) {
      if (map.is_weak_sep[k] == 0) {
        all_weak = false;
        break;
      }
    }
    if (!all_weak) break;
    cut = c;
  }
  return cut;
}

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

SpeechEnergyBounds scan_speech_energy_bounds(
    const std::vector<float>& samples,
    int sample_rate,
    bool stop_on_first) {
  SpeechEnergyBounds out;
  const size_t count = samples.size();
  if (count == 0) return out;
  const int rate = sample_rate > 0 ? sample_rate : 16000;
  const size_t window_samples = std::max<size_t>(1, static_cast<size_t>(std::llround(static_cast<double>(rate) * 0.05)));
  const double rms_sq_threshold =
      static_cast<double>(kSpeechEnergyWindowRmsThreshold) * static_cast<double>(kSpeechEnergyWindowRmsThreshold);
  constexpr float kRmsSampleThresh = kSpeechEnergyWindowRmsThreshold;

  double window_sum_sq = 0.0;
  bool has_above_rms = false;
  size_t first_above_rms = 0;
  size_t last_above_rms = 0;
  for (size_t i = 0; i < count; ++i) {
    const float s = samples[i];
    const float abs_s = std::fabs(s);
    if (abs_s >= kRmsSampleThresh) {
      if (!has_above_rms) {
        has_above_rms = true;
        first_above_rms = i;
      }
      last_above_rms = i;
    }
    if (abs_s >= kSpeechEnergyPeakThreshold) {
      if (!out.found) out.first = i;
      out.last = i;
      out.found = true;
      if (stop_on_first) return out;
    }
    const double d = static_cast<double>(s);
    window_sum_sq += d * d;
    if (i >= window_samples) {
      const double old = static_cast<double>(samples[i - window_samples]);
      window_sum_sq -= old * old;
      if (window_sum_sq < 0.0) window_sum_sq = 0.0;
    }
    if (i + 1 >= window_samples && (window_sum_sq / static_cast<double>(window_samples)) >= rms_sq_threshold) {
      const size_t win_start = i + 1 - window_samples;
      if (!out.found) {
        size_t tightened = win_start;
        if (has_above_rms && first_above_rms >= win_start) {
          tightened = first_above_rms;
        } else {
          for (size_t j = win_start; j <= i; ++j) {
            if (std::fabs(samples[j]) >= kRmsSampleThresh) {
              tightened = j;
              break;
            }
          }
        }
        out.first = tightened;
        out.last = tightened;
        out.found = true;
      }
      if (has_above_rms && last_above_rms >= win_start && last_above_rms > out.last) {
        out.last = last_above_rms;
      }
      if (stop_on_first) return out;
    }
  }
  if (count < window_samples && (window_sum_sq / static_cast<double>(count)) >= rms_sq_threshold) {
    out.first = has_above_rms ? first_above_rms : 0;
    out.last = has_above_rms ? last_above_rms : (count - 1);
    out.found = true;
  }
  return out;
}

bool has_utterance_speech_energy(const std::vector<float>& samples, int sample_rate) {
  return scan_speech_energy_bounds(samples, sample_rate, true).found;
}

std::vector<float> trim_silence_edges(
    const std::vector<float>& samples,
    int sample_rate,
    int pad_ms,
    size_t* out_start_sample) {
  if (out_start_sample) *out_start_sample = 0;
  const size_t count = samples.size();
  const SpeechEnergyBounds bounds = scan_speech_energy_bounds(samples, sample_rate, false);
  if (!bounds.found || bounds.last < bounds.first) return {};
  const int rate = sample_rate > 0 ? sample_rate : 16000;
  const size_t pad_samples = pad_ms > 0
      ? static_cast<size_t>(std::llround(static_cast<double>(rate) * static_cast<double>(pad_ms) / 1000.0))
      : 0;
  const size_t start = bounds.first > pad_samples ? (bounds.first - pad_samples) : 0;
  const size_t end = std::min(count, bounds.last + 1 + pad_samples);
  if (out_start_sample) *out_start_sample = start;
  if (start == 0 && end == count) return samples;
  return std::vector<float>(
      samples.begin() + static_cast<std::ptrdiff_t>(start),
      samples.begin() + static_cast<std::ptrdiff_t>(end));
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

void set_hotword_nfkc_normalizer_for_testing(HotwordNfkcNormalizerFn fn) {
  hotword_nfkc_normalizer_override() = fn;
}

std::string strip_voice_hotword_hallucination(
    const std::string& text,
    const std::vector<std::string>& hotword_terms,
    bool allow_single,
    bool whole_only) {
  if (text.empty() || hotword_terms.empty()) return text;

  std::vector<std::vector<uint32_t>> unique_terms;
  for (const std::string& raw : hotword_terms) {
    const std::string trimmed = trim_ascii_ws(raw);
    if (trimmed.empty()) continue;
    std::vector<uint32_t> norm_cps = normalize_hotword_utf8_to_cps(trimmed);
    if (norm_cps.empty()) continue;
    bool dup = false;
    for (const auto& existing : unique_terms) {
      if (existing == norm_cps) {
        dup = true;
        break;
      }
    }
    if (!dup) unique_terms.push_back(std::move(norm_cps));
  }
  if (unique_terms.empty()) return text;

  HallucinationMatcher matcher;
  matcher.fwd_nodes.emplace_back();
  matcher.rev_nodes.emplace_back();
  matcher.term_starts_ascii.reserve(unique_terms.size());
  matcher.term_ends_ascii.reserve(unique_terms.size());
  matcher.term_first_cp.reserve(unique_terms.size());
  matcher.term_last_cp.reserve(unique_terms.size());

  for (int tid = 0; tid < static_cast<int>(unique_terms.size()); ++tid) {
    const auto& cps = unique_terms[static_cast<size_t>(tid)];
    matcher.term_starts_ascii.push_back(is_hotword_ascii_alnum_cp(cps.front()) ? 1 : 0);
    matcher.term_ends_ascii.push_back(is_hotword_ascii_alnum_cp(cps.back()) ? 1 : 0);
    matcher.term_first_cp.push_back(cps.front());
    matcher.term_last_cp.push_back(cps.back());

    int cur = 0;
    for (uint32_t cp : cps) {
      auto it = matcher.fwd_nodes[cur].children.find(cp);
      if (it == matcher.fwd_nodes[cur].children.end()) {
        const int next = static_cast<int>(matcher.fwd_nodes.size());
        matcher.fwd_nodes.emplace_back();
        matcher.fwd_nodes[cur].children[cp] = next;
        cur = next;
      } else {
        cur = it->second;
      }
    }
    matcher.fwd_nodes[cur].term_id = tid;

    int rcur = 0;
    for (size_t k = cps.size(); k > 0; --k) {
      const uint32_t cp = cps[k - 1];
      auto it = matcher.rev_nodes[rcur].children.find(cp);
      if (it == matcher.rev_nodes[rcur].children.end()) {
        const int next = static_cast<int>(matcher.rev_nodes.size());
        matcher.rev_nodes.emplace_back();
        matcher.rev_nodes[rcur].children[cp] = next;
        rcur = next;
      } else {
        rcur = it->second;
      }
    }
    matcher.rev_nodes[rcur].term_id = tid;
  }

  // Whole-string check normalizes the full UTF-8 string via Unicode NFKC directly (preserving Hangul Jamo & combining composition).
  const std::vector<uint32_t> cps = normalize_hotword_utf8_to_cps(text);
  const size_t n = cps.size();
  if (n == 0) return text;

  constexpr int kInf = 0x3FFFFFFF;
  std::vector<int> cleared(n + 1, kInf);
  std::vector<int> ended_ascii(n + 1, kInf);
  std::vector<std::unordered_map<int, int>> same_states(n + 1);
  cleared[0] = 0;

  for (size_t pos = 0; pos < n; ++pos) {
    const int c_count = cleared[pos];
    const int a_count = ended_ascii[pos];
    auto& same_map = same_states[pos];
    if (c_count == kInf && a_count == kInf && same_map.empty()) continue;
    const int best_at_pos = std::min(c_count, a_count);

    if (is_hotword_sep_cp(cps[pos])) {
      int sep_min = best_at_pos;
      for (const auto& kv : same_map) {
        if (kv.second < sep_min) sep_min = kv.second;
      }
      if (sep_min < cleared[pos + 1]) cleared[pos + 1] = sep_min;
    }

    int cur_idx = 0;
    for (size_t p = pos; p < n; ++p) {
      const auto it = matcher.fwd_nodes[cur_idx].children.find(cps[p]);
      if (it == matcher.fwd_nodes[cur_idx].children.end()) break;
      cur_idx = it->second;
      const int tid = matcher.fwd_nodes[cur_idx].term_id;
      if (tid < 0) continue;

      int start_cost = matcher.term_starts_ascii[static_cast<size_t>(tid)] ? c_count : best_at_pos;
      const auto same_it = same_map.find(tid);
      if (same_it != same_map.end() && same_it->second < start_cost) {
        start_cost = same_it->second;
      }
      if (start_cost >= kInf) continue;

      const size_t end_pos = p + 1;
      const int next_cost = start_cost + 1;
      if (!matcher.term_ends_ascii[static_cast<size_t>(tid)] || end_pos == n) {
        if (next_cost < cleared[end_pos]) cleared[end_pos] = next_cost;
      } else {
        if (next_cost < ended_ascii[end_pos]) ended_ascii[end_pos] = next_cost;
        if (matcher.term_starts_ascii[static_cast<size_t>(tid)] &&
            cps[end_pos] == matcher.term_first_cp[static_cast<size_t>(tid)]) {
          auto& target = same_states[end_pos];
          const auto prev = target.find(tid);
          if (prev == target.end() || next_cost < prev->second) {
            target[tid] = next_cost;
          }
        }
      }
    }
    same_map.clear();
  }

  const int min_matches = std::min(cleared[n], ended_ascii[n]);
  if (min_matches < kInf) {
    if (min_matches >= 2) return {};
    if (allow_single && min_matches == 1) return {};
    return text;
  }
  if (whole_only) return text;

  std::string current = text;
  const auto whole_map = build_normalized_cluster_map(current);
  const size_t lead_cut = find_leading_cut(matcher, whole_map);
  if (lead_cut > 0 && lead_cut < whole_map.cps.size()) {
    current = current.substr(whole_map.norm_to_raw_byte[lead_cut]);
  }
  if (current.empty()) return {};

  const auto tail_map = lead_cut > 0 ? build_normalized_cluster_map(current) : whole_map;
  const size_t tail_cut = find_trailing_cut(matcher, tail_map);
  if (tail_cut < tail_map.cps.size()) {
    current = current.substr(0, tail_map.norm_to_raw_byte[tail_cut]);
  }
  return current;
}

std::string strip_voice_hotword_hallucination_csv(
    const std::string& text,
    const std::string& hotwords_context,
    bool allow_single,
    bool whole_only) {
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
  return strip_voice_hotword_hallucination(text, terms, allow_single, whole_only);
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
