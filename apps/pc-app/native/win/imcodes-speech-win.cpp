#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#ifdef _WIN32
#include <windows.h>
#include <winnls.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <propsys.h>
#include <audioclient.h>
#include <avrt.h>
#include <dxgi.h>
#include <functiondiscoverykeys_devpkey.h>
#endif

#if defined(__APPLE__) && defined(IMCODES_USE_COREFOUNDATION)
#include <CoreFoundation/CoreFoundation.h>
#endif

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#ifdef IMCODES_HAS_SHERPA_ONNX
#include "sherpa-onnx/c-api/c-api.h"
#endif

namespace {

constexpr uint64_t kDirectMlMinVramMb = 4096;
constexpr int kTargetSampleRate = 16000;
constexpr size_t kInitialPartialSamples = 12800;   // 0.8s @ 16kHz
constexpr size_t kStepPartialSamples = 12800;      // 0.8s stride
constexpr size_t kMaxSegmentSamples = 216000;      // 13.5s segment cap
constexpr size_t kMaxFinalReDecodeSamples = 480000;  // 30s full-utterance final re-decode cap
constexpr size_t kMinPauseSplitSamples = 96000;    // 6.0s before natural pause split
constexpr size_t kPauseWindowSamples = 6400;       // 400ms trailing silence window
constexpr size_t kPauseScanStrideSamples = 800;    // 50ms scan stride for pause boundary
constexpr float kPauseRmsThreshold = 0.012f;
constexpr float kSpeechPeakThreshold = 0.02f;

std::mutex g_output_mutex;

std::string json_escape(const std::string& input) {
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

void emit_json_line(const std::string& line) {
  std::lock_guard<std::mutex> lock(g_output_mutex);
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

void emit_error(const std::string& code, const std::string& target, const std::string& message) {
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

std::vector<uint32_t> utf8_to_codepoints(const std::string& s) {
  std::vector<uint32_t> cps;
  cps.reserve(s.size());
  size_t i = 0;
  const size_t n = s.size();
  while (i < n) {
    const unsigned char b = static_cast<unsigned char>(s[i]);
    if (b < 0x80) {
      cps.push_back(b);
      i += 1;
    } else if ((b & 0xE0) == 0xC0 && i + 1 < n) {
      cps.push_back((static_cast<uint32_t>(b & 0x1F) << 6) |
                    static_cast<uint32_t>(static_cast<unsigned char>(s[i + 1]) & 0x3F));
      i += 2;
    } else if ((b & 0xF0) == 0xE0 && i + 2 < n) {
      cps.push_back((static_cast<uint32_t>(b & 0x0F) << 12) |
                    (static_cast<uint32_t>(static_cast<unsigned char>(s[i + 1]) & 0x3F) << 6) |
                    static_cast<uint32_t>(static_cast<unsigned char>(s[i + 2]) & 0x3F));
      i += 3;
    } else if ((b & 0xF8) == 0xF0 && i + 3 < n) {
      cps.push_back((static_cast<uint32_t>(b & 0x07) << 18) |
                    (static_cast<uint32_t>(static_cast<unsigned char>(s[i + 1]) & 0x3F) << 12) |
                    (static_cast<uint32_t>(static_cast<unsigned char>(s[i + 2]) & 0x3F) << 6) |
                    static_cast<uint32_t>(static_cast<unsigned char>(s[i + 3]) & 0x3F));
      i += 4;
    } else {
      cps.push_back(b);
      i += 1;
    }
  }
  return cps;
}

std::string codepoints_to_utf8(const std::vector<uint32_t>& cps) {
  std::string out;
  out.reserve(cps.size() * 2);
  for (uint32_t cp : cps) {
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
  return out;
}

bool is_meaningful_codepoint(uint32_t cp) {
  if (cp < 0x80) {
    return (cp >= '0' && cp <= '9') || (cp >= 'A' && cp <= 'Z') || (cp >= 'a' && cp <= 'z');
  }
  if (cp >= 0x2000 && cp <= 0x206F) return false; // General punctuation
  if (cp >= 0x3000 && cp <= 0x303F) return false; // CJK symbols and punctuation
  if (cp >= 0xFF01 && cp <= 0xFF0F) return false; // Fullwidth ASCII punctuation
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

bool is_ascii_ws(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

bool is_ascii_alnum(unsigned char c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

bool is_lang_token_char(unsigned char c) {
  return is_ascii_alnum(c) || c == '_' || c == '-';
}

std::string trim_ascii_ws(const std::string& input) {
  size_t start = 0;
  while (start < input.size() && is_ascii_ws(input[start])) ++start;
  size_t end = input.size();
  while (end > start && is_ascii_ws(input[end - 1])) --end;
  return input.substr(start, end - start);
}

/**
 * Strip Qwen3-ASR control prefixes/tags (e.g. `language None<asr_text>`,
 * `language Chinese<asr_text>`, `<asr_text>`, `<|endoftext|>`) without touching
 * normal sentences that merely contain `"language"`.
 */
std::string strip_asr_control_tags(const std::string& input) {
  if (input.empty()) return {};
  std::string out;
  out.reserve(input.size());
  size_t i = 0;
  const std::string kAsrTag = "<asr_text>";
  const std::string kLangPrefix = "language";
  while (i < input.size()) {
    // Match `[word boundary]language <lang>[ws]*<asr_text>`
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

/**
 * Join committed and active transcript segments, inserting a single ASCII space
 * only between adjacent ASCII alphanumeric characters (matching macOS).
 */
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

  std::string cleaned = codepoints_to_utf8(cps);
  while (!cleaned.empty() && (cleaned.front() == ' ' || cleaned.front() == '\t' || cleaned.front() == '\r' || cleaned.front() == '\n')) {
    cleaned.erase(cleaned.begin());
  }
  while (!cleaned.empty() && (cleaned.back() == ' ' || cleaned.back() == '\t' || cleaned.back() == '\r' || cleaned.back() == '\n')) {
    cleaned.pop_back();
  }
  if (cleaned.empty()) return {};
  const auto cleaned_cps = utf8_to_codepoints(cleaned);
  bool has_meaningful = false;
  for (uint32_t cp : cleaned_cps) {
    if (is_meaningful_codepoint(cp)) {
      has_meaningful = true;
      break;
    }
  }
  return has_meaningful ? cleaned : std::string{};
}

std::string wide_to_utf8(const std::wstring& w) {
  if (w.empty()) return {};
  int needed = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return {};
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), out.data(), needed, nullptr, nullptr);
  return out;
}

std::wstring utf8_to_wide(const std::string& s) {
  if (s.empty()) return {};
  int needed = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (needed <= 0) return {};
  std::wstring out(static_cast<size_t>(needed), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), needed);
  return out;
}

std::string to_lower_ascii(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return s;
}

struct ScopedComInit {
  HRESULT hr{E_FAIL};
  explicit ScopedComInit(DWORD model = COINIT_MULTITHREADED) {
    hr = CoInitializeEx(nullptr, model);
  }
  ~ScopedComInit() {
    if (SUCCEEDED(hr)) {
      CoUninitialize();
    }
  }
};

struct GpuProbeInfo {
  bool ok{true};
  std::string gpu_name;
  uint64_t vram_mb{0};
  int adapter_index{-1};
  std::string provider{"cpu"};
  bool directml_eligible{false};
};

GpuProbeInfo probe_best_gpu() {
  GpuProbeInfo result;
  IDXGIFactory1* factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory))) || !factory) {
    return result;
  }

  uint64_t best_vram_bytes = 0;
  int best_rank = -1;
  IDXGIAdapter1* adapter = nullptr;
  for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i) {
    DXGI_ADAPTER_DESC1 desc{};
    if (SUCCEEDED(adapter->GetDesc1(&desc))) {
      const bool is_software = (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0;
      if (!is_software) {
        const uint64_t dedicated = static_cast<uint64_t>(desc.DedicatedVideoMemory);
        const bool is_discrete_vendor = (desc.VendorId == 0x10DE || desc.VendorId == 0x1002);
        const int rank = is_discrete_vendor ? 1 : 0;
        if (result.adapter_index < 0 || dedicated > best_vram_bytes ||
            (dedicated == best_vram_bytes && rank > best_rank)) {
          best_vram_bytes = dedicated;
          best_rank = rank;
          result.adapter_index = static_cast<int>(i);
          result.gpu_name = wide_to_utf8(desc.Description);
        }
      }
    }
    adapter->Release();
    adapter = nullptr;
  }
  factory->Release();

  result.vram_mb = best_vram_bytes / (1024ULL * 1024ULL);
  result.directml_eligible = result.vram_mb >= kDirectMlMinVramMb;
  // DirectML is enabled ONLY for GPUs with >= 4 GB dedicated VRAM.
  // Smaller GPUs (e.g. GT 1030 2 GB) default to CPU because DirectML saturates VRAM and stalls.
  result.provider = result.directml_eligible ? "directml" : "cpu";
  return result;
}

int run_probe_command() {
  const GpuProbeInfo info = probe_best_gpu();
  std::ostringstream oss;
  oss << "{\"ok\":" << (info.ok ? "true" : "false");
  if (info.gpu_name.empty()) {
    oss << ",\"gpuName\":null";
  } else {
    oss << ",\"gpuName\":\"" << json_escape(info.gpu_name) << "\"";
  }
  oss << ",\"vramMb\":" << info.vram_mb
      << ",\"adapterIndex\":" << info.adapter_index
      << ",\"provider\":\"" << json_escape(info.provider) << "\""
      << ",\"directmlEligible\":" << (info.directml_eligible ? "true" : "false")
#ifdef IMCODES_HAS_SHERPA_ONNX
      << ",\"localAsrSupported\":true}";
#else
      << ",\"localAsrSupported\":false}";
#endif
  emit_json_line(oss.str());
  return 0;
}

struct InputDeviceInfo {
  std::string uid;
  std::string name;
  std::string transport;
  bool is_default{false};
  bool is_physical{true};
};

std::string classify_transport(const std::string& name_lower, const std::string& uid_lower) {
  if (name_lower.find("bluetooth") != std::string::npos ||
      name_lower.find("airpods") != std::string::npos ||
      name_lower.find("hands-free") != std::string::npos ||
      uid_lower.find("bth") != std::string::npos) {
    return "bluetooth";
  }
  if (name_lower.find("vb-audio") != std::string::npos ||
      name_lower.find("virtual") != std::string::npos ||
      name_lower.find("cable") != std::string::npos ||
      name_lower.find("voicemeeter") != std::string::npos ||
      name_lower.find("steam streaming") != std::string::npos ||
      name_lower.find("stereo mix") != std::string::npos) {
    return "virtual";
  }
  if (name_lower.find("usb") != std::string::npos || uid_lower.find("usb") != std::string::npos) {
    return "usb";
  }
  if (name_lower.find("realtek") != std::string::npos ||
      name_lower.find("microphone array") != std::string::npos ||
      name_lower.find("high definition audio") != std::string::npos) {
    return "builtin";
  }
  return "other";
}

std::vector<InputDeviceInfo> enumerate_input_devices() {
  ScopedComInit com;
  std::vector<InputDeviceInfo> devices;
  IMMDeviceEnumerator* enumerator = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              reinterpret_cast<void**>(&enumerator))) || !enumerator) {
    return devices;
  }

  std::string default_id;
  IMMDevice* default_dev = nullptr;
  if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &default_dev)) && default_dev) {
    LPWSTR raw_id = nullptr;
    if (SUCCEEDED(default_dev->GetId(&raw_id)) && raw_id) {
      default_id = wide_to_utf8(raw_id);
      CoTaskMemFree(raw_id);
    }
    default_dev->Release();
  }

  IMMDeviceCollection* collection = nullptr;
  if (SUCCEEDED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection)) && collection) {
    UINT count = 0;
    collection->GetCount(&count);
    for (UINT i = 0; i < count; ++i) {
      IMMDevice* dev = nullptr;
      if (FAILED(collection->Item(i, &dev)) || !dev) continue;

      LPWSTR raw_id = nullptr;
      std::string uid;
      if (SUCCEEDED(dev->GetId(&raw_id)) && raw_id) {
        uid = wide_to_utf8(raw_id);
        CoTaskMemFree(raw_id);
      }

      std::string name = uid;
      IPropertyStore* props = nullptr;
      if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props)) && props) {
        PROPVARIANT var_name;
        PropVariantInit(&var_name);
        if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &var_name)) &&
            var_name.vt == VT_LPWSTR && var_name.pwszVal) {
          name = wide_to_utf8(var_name.pwszVal);
        }
        PropVariantClear(&var_name);
        props->Release();
      }

      if (!uid.empty()) {
        const std::string lower_name = to_lower_ascii(name);
        const std::string lower_uid = to_lower_ascii(uid);
        const std::string transport = classify_transport(lower_name, lower_uid);
        const bool is_physical = (transport != "virtual" && transport != "bluetooth");
        devices.push_back(InputDeviceInfo{
            uid,
            name,
            transport,
            (!default_id.empty() && uid == default_id),
            is_physical,
        });
      }
      dev->Release();
    }
    collection->Release();
  }

  enumerator->Release();
  return devices;
}

int run_devices_command() {
  const auto devices = enumerate_input_devices();
  std::ostringstream oss;
  oss << "[";
  for (size_t i = 0; i < devices.size(); ++i) {
    if (i > 0) oss << ",";
    const auto& dev = devices[i];
    oss << "{\"uid\":\"" << json_escape(dev.uid) << "\""
        << ",\"name\":\"" << json_escape(dev.name) << "\""
        << ",\"transport\":\"" << json_escape(dev.transport) << "\""
        << ",\"isDefault\":" << (dev.is_default ? "true" : "false")
        << ",\"isPhysical\":" << (dev.is_physical ? "true" : "false") << "}";
  }
  oss << "]";
  emit_json_line(oss.str());
  return 0;
}

int run_status_command() {
  const GpuProbeInfo gpu = probe_best_gpu();
  std::ostringstream oss;
  oss << "{\"mic\":\"granted\",\"speech\":\"granted\",\"speechAvailable\":true"
      << ",\"provider\":\"" << json_escape(gpu.provider) << "\""
      << ",\"vramMb\":" << gpu.vram_mb << "}";
  emit_json_line(oss.str());
  return 0;
}

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
  } else {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

std::optional<std::string> parse_json_string_at(const std::string& json_line, size_t open_quote, size_t* out_next_pos) {
  if (open_quote >= json_line.size() || json_line[open_quote] != '"') return std::nullopt;
  std::string out;
  for (size_t i = open_quote + 1; i < json_line.size(); ++i) {
    char ch = json_line[i];
    if (ch == '\\' && i + 1 < json_line.size()) {
      char esc = json_line[++i];
      if (esc == 'n') out.push_back('\n');
      else if (esc == 'r') out.push_back('\r');
      else if (esc == 't') out.push_back('\t');
      else if (esc == 'u' && i + 4 < json_line.size()) {
        uint32_t hex_cp = 0;
        bool valid_hex = true;
        for (int k = 1; k <= 4; ++k) {
          char h = json_line[i + k];
          hex_cp <<= 4;
          if (h >= '0' && h <= '9') hex_cp |= static_cast<uint32_t>(h - '0');
          else if (h >= 'a' && h <= 'f') hex_cp |= static_cast<uint32_t>(h - 'a' + 10);
          else if (h >= 'A' && h <= 'F') hex_cp |= static_cast<uint32_t>(h - 'A' + 10);
          else { valid_hex = false; break; }
        }
        if (valid_hex) {
          i += 4;
          // Handle UTF-16 surrogate pair in \uD800..\uDBFF \uDC00..\uDFFF
          if (hex_cp >= 0xD800 && hex_cp <= 0xDBFF && i + 6 < json_line.size() &&
              json_line[i + 1] == '\\' && json_line[i + 2] == 'u') {
            uint32_t low = 0;
            bool valid_low = true;
            for (int k = 3; k <= 6; ++k) {
              char h = json_line[i + k];
              low <<= 4;
              if (h >= '0' && h <= '9') low |= static_cast<uint32_t>(h - '0');
              else if (h >= 'a' && h <= 'f') low |= static_cast<uint32_t>(h - 'a' + 10);
              else if (h >= 'A' && h <= 'F') low |= static_cast<uint32_t>(h - 'A' + 10);
              else { valid_low = false; break; }
            }
            if (valid_low && low >= 0xDC00 && low <= 0xDFFF) {
              hex_cp = 0x10000 + (((hex_cp - 0xD800) << 10) | (low - 0xDC00));
              i += 6;
            }
          }
          append_utf8_cp(out, hex_cp);
        } else {
          out.push_back(esc);
        }
      } else {
        out.push_back(esc);
      }
      continue;
    }
    if (ch == '"') {
      if (out_next_pos) *out_next_pos = i + 1;
      return out;
    }
    out.push_back(ch);
  }
  return std::nullopt;
}

std::optional<std::string> extract_json_string_field(const std::string& json_line, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  const size_t pos = json_line.find(needle);
  if (pos == std::string::npos) return std::nullopt;
  const size_t colon = json_line.find(':', pos + needle.size());
  if (colon == std::string::npos) return std::nullopt;
  size_t p = colon + 1;
  while (p < json_line.size() && is_ascii_ws(json_line[p])) ++p;
  if (p >= json_line.size() || json_line[p] != '"') return std::nullopt;
  return parse_json_string_at(json_line, p, nullptr);
}

std::vector<std::string> extract_json_string_array_field(const std::string& json_line, const std::string& key) {
  std::vector<std::string> items;
  const std::string needle = "\"" + key + "\"";
  const size_t pos = json_line.find(needle);
  if (pos == std::string::npos) return items;
  const size_t colon = json_line.find(':', pos + needle.size());
  if (colon == std::string::npos) return items;
  size_t p = colon + 1;
  while (p < json_line.size() && is_ascii_ws(json_line[p])) ++p;
  if (p >= json_line.size() || json_line[p] != '[') return items;
  ++p;
  while (p < json_line.size()) {
    while (p < json_line.size() && (is_ascii_ws(json_line[p]) || json_line[p] == ',')) ++p;
    if (p >= json_line.size() || json_line[p] == ']') break;
    if (json_line[p] == '"') {
      size_t next_p = p;
      auto val = parse_json_string_at(json_line, p, &next_p);
      if (!val.has_value()) break;
      std::string trimmed = trim_ascii_ws(*val);
      if (!trimmed.empty()) items.push_back(std::move(trimmed));
      p = next_p;
    } else {
      break;
    }
  }
  return items;
}

std::vector<std::string> split_hotwords_string(const std::string& raw) {
  std::vector<std::string> out;
  std::string cur;
  for (char ch : raw) {
    if (ch == ',' || ch == '\n' || ch == '\r') {
      std::string trimmed = trim_ascii_ws(cur);
      if (!trimmed.empty()) out.push_back(std::move(trimmed));
      cur.clear();
    } else {
      cur.push_back(ch);
    }
  }
  std::string trimmed = trim_ascii_ws(cur);
  if (!trimmed.empty()) out.push_back(std::move(trimmed));
  return out;
}

std::vector<std::string> merge_hotword_terms(
    const std::vector<std::string>& base,
    const std::vector<std::string>& extra) {
  std::vector<std::string> merged = base;
  merged.insert(merged.end(), extra.begin(), extra.end());
  return merged;
}

std::string resolve_target_capture_uid(const std::string& requested_uid) {
  if (!requested_uid.empty() && requested_uid != "auto") {
    return requested_uid;
  }
  const auto devices = enumerate_input_devices();
  for (const auto& d : devices) {
    if (d.is_default && d.is_physical) return d.uid;
  }
  for (const auto& d : devices) {
    if (d.is_physical) return d.uid;
  }
  for (const auto& d : devices) {
    if (d.is_default) return d.uid;
  }
  return devices.empty() ? std::string{} : devices.front().uid;
}

template <typename SampleAtFn>
float window_rms_indexed(SampleAtFn&& sample_at, size_t start, size_t count) {
  if (count == 0) return 0.0f;
  double sum_sq = 0.0;
  for (size_t i = 0; i < count; ++i) {
    const double s = static_cast<double>(sample_at(start + i));
    sum_sq += s * s;
  }
  return static_cast<float>(std::sqrt(sum_sq / static_cast<double>(count)));
}

template <typename SampleAtFn>
bool has_speech_energy_indexed(SampleAtFn&& sample_at, size_t end) {
  for (size_t i = 0; i < end; ++i) {
    if (std::fabs(sample_at(i)) >= kSpeechPeakThreshold) return true;
  }
  return false;
}

struct SpeechEnergyBounds {
  size_t first{0};
  size_t last{0};
  bool found{false};
};

// Conservative utterance silence scan: detects speech where peak >= 0.015 or 50ms RMS >= 0.005.
SpeechEnergyBounds scan_speech_energy_bounds(
    const std::vector<float>& samples,
    int sample_rate = kTargetSampleRate,
    bool stop_on_first = false) {
  SpeechEnergyBounds out;
  const size_t count = samples.size();
  if (count == 0) return out;
  constexpr float kUtterancePeakThreshold = 0.015f;
  constexpr double kUtteranceWindowRmsThreshold = 0.005;
  constexpr double kRmsSqThreshold = kUtteranceWindowRmsThreshold * kUtteranceWindowRmsThreshold;
  const int rate = sample_rate > 0 ? sample_rate : kTargetSampleRate;
  const size_t window_samples = std::max<size_t>(1, static_cast<size_t>(std::llround(static_cast<double>(rate) * 0.05)));

  constexpr float kRmsSampleThresh = static_cast<float>(kUtteranceWindowRmsThreshold);
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
    if (abs_s >= kUtterancePeakThreshold) {
      if (!out.found) out.first = i;
      out.last = i;
      out.found = true;
      if (stop_on_first) return out;
    }
    const double d = static_cast<double>(s);
    window_sum_sq += d * d;
    if (i >= window_samples) {
      const double old_d = static_cast<double>(samples[i - window_samples]);
      window_sum_sq -= old_d * old_d;
      if (window_sum_sq < 0.0) window_sum_sq = 0.0;
    }
    if (i + 1 >= window_samples && (window_sum_sq / static_cast<double>(window_samples)) >= kRmsSqThreshold) {
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
  if (count < window_samples && (window_sum_sq / static_cast<double>(count)) >= kRmsSqThreshold) {
    out.first = has_above_rms ? first_above_rms : 0;
    out.last = has_above_rms ? last_above_rms : (count - 1);
    out.found = true;
  }
  return out;
}

bool has_utterance_speech_energy(const std::vector<float>& samples, int sample_rate = kTargetSampleRate) {
  return scan_speech_energy_bounds(samples, sample_rate, true).found;
}

std::vector<float> trim_silence_edges(
    const std::vector<float>& samples,
    int sample_rate = kTargetSampleRate,
    int pad_ms = 250) {
  const size_t count = samples.size();
  const SpeechEnergyBounds bounds = scan_speech_energy_bounds(samples, sample_rate, false);
  if (!bounds.found || bounds.last < bounds.first) return {};
  const int rate = sample_rate > 0 ? sample_rate : kTargetSampleRate;
  const size_t pad_samples = pad_ms > 0
      ? static_cast<size_t>(std::llround(static_cast<double>(rate) * static_cast<double>(pad_ms) / 1000.0))
      : 0;
  const size_t start = bounds.first > pad_samples ? (bounds.first - pad_samples) : 0;
  const size_t end = std::min(count, bounds.last + 1 + pad_samples);
  if (start == 0 && end == count) return samples;
  return std::vector<float>(
      samples.begin() + static_cast<std::ptrdiff_t>(start),
      samples.begin() + static_cast<std::ptrdiff_t>(end));
}

bool has_trailing_silence_pause(const std::vector<float>& samples, const std::string& active_segment_text) {
  if (samples.size() < kMinPauseSplitSamples || samples.size() <= kPauseWindowSamples) {
    return false;
  }
  const auto at = [&](size_t idx) { return samples[idx]; };
  const size_t win_start = samples.size() - kPauseWindowSamples;
  if (active_segment_text.empty() && !has_speech_energy_indexed(at, win_start)) {
    return false;
  }
  return window_rms_indexed(at, win_start, kPauseWindowSamples) < kPauseRmsThreshold;
}

size_t find_pause_split_take_count(
    const std::vector<float>& segment_samples,
    const std::vector<float>& pending_samples,
    size_t pending_head,
    size_t max_take,
    const std::string& active_segment_text) {
  const size_t cur_len = segment_samples.size();
  const size_t total = cur_len + max_take;
  if (max_take == 0 || total < kMinPauseSplitSamples || total <= kPauseWindowSamples) {
    return max_take;
  }
  const auto at = [&](size_t idx) {
    return idx < cur_len ? segment_samples[idx] : pending_samples[pending_head + (idx - cur_len)];
  };
  const size_t min_cand = std::max(kMinPauseSplitSamples, cur_len + 1);
  const size_t first_aligned = ((min_cand + kPauseScanStrideSamples - 1) / kPauseScanStrideSamples) * kPauseScanStrideSamples;
  auto check_cand = [&](size_t cand_total) -> bool {
    if (cand_total <= kPauseWindowSamples || cand_total > total) return false;
    const size_t win_start = cand_total - kPauseWindowSamples;
    if (window_rms_indexed(at, win_start, kPauseWindowSamples) >= kPauseRmsThreshold) {
      return false;
    }
    return !active_segment_text.empty() || has_speech_energy_indexed(at, win_start);
  };
  for (size_t cand = first_aligned; cand <= total; cand += kPauseScanStrideSamples) {
    if (check_cand(cand)) {
      return cand - cur_len;
    }
  }
  if (total >= min_cand && check_cand(total)) {
    return max_take;
  }
  return max_take;
}

// MARK: - Voice Hotword Edge Hallucination Stripping

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

inline uint32_t normalize_hotword_cp(uint32_t cp) {
  if (cp >= 0xFF01 && cp <= 0xFF5E) {
    cp -= 0xFEE0;
  } else if (cp == 0x3000 || cp == 0x00A0 || (cp >= 0x2000 && cp <= 0x200B) || cp == 0xFEFF) {
    cp = ' ';
  } else if (cp == 0xFF61) {
    cp = '.';
  } else if ((cp >= 0x2010 && cp <= 0x2015) || cp == 0x2212 || cp == 0xFE58 || cp == 0xFE63) {
    cp = '-';
  } else if (cp >= 0x2018 && cp <= 0x201B) {
    cp = '\'';
  } else if (cp >= 0x201C && cp <= 0x201F) {
    cp = '"';
  }
  if (cp >= 'A' && cp <= 'Z') {
    cp += ('a' - 'A');
  }
  return cp;
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

inline void decode_next_utf8_cp(const std::string& s, size_t& i, uint32_t& out_cp) {
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

using HotwordNfkcNormalizerFn = std::string (*)(const std::string&);

inline HotwordNfkcNormalizerFn& hotword_nfkc_normalizer_override() {
  static HotwordNfkcNormalizerFn fn = nullptr;
  return fn;
}

inline void set_hotword_nfkc_normalizer_for_testing(HotwordNfkcNormalizerFn fn) {
  hotword_nfkc_normalizer_override() = fn;
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
  // Portable Hangul Jamo L+V[+T] canonical composition & combining-mark-preserving fallback.
  std::vector<uint32_t> raw_cps;
  size_t i = 0;
  while (i < input.size()) {
    uint32_t cp = 0;
    decode_next_utf8_cp(input, i, cp);
    if (!raw_cps.empty() && cp >= 0x1161 && cp <= 0x1175 && raw_cps.back() >= 0x1100 && raw_cps.back() <= 0x1112) {
      const uint32_t l_idx = raw_cps.back() - 0x1100;
      const uint32_t v_idx = cp - 0x1161;
      raw_cps.back() = 0xAC00 + (l_idx * 21 + v_idx) * 28;
    } else if (!raw_cps.empty() && cp >= 0x11A8 && cp <= 0x11C2 &&
               raw_cps.back() >= 0xAC00 && raw_cps.back() <= 0xD7A3 && ((raw_cps.back() - 0xAC00) % 28) == 0) {
      raw_cps.back() += (cp - 0x11A7);
    } else {
      raw_cps.push_back(cp);
    }
  }
  std::string out;
  out.reserve(input.size());
  for (uint32_t cp : raw_cps) {
    append_utf8_cp(out, cp);
  }
  return out;
#endif
}

std::vector<uint32_t> normalize_hotword_utf8_to_cps(const std::string& input) {
  if (input.empty()) return {};
  const HotwordNfkcNormalizerFn custom = hotword_nfkc_normalizer_override();
  const std::string nfkc = custom ? custom(input) : default_os_nfkc_lower_utf8(input);
  std::vector<uint32_t> out;
  out.reserve(nfkc.size());
  size_t i = 0;
  while (i < nfkc.size()) {
    uint32_t cp = 0;
    decode_next_utf8_cp(nfkc, i, cp);
    out.push_back(normalize_hotword_cp(cp));
  }
  return out;
}

inline size_t advance_next_grapheme_cluster(const std::string& text, size_t start) {
  const size_t bytes = text.size();
  if (start >= bytes) return bytes;
  size_t i = start;
  uint32_t first_cp = 0;
  decode_next_utf8_cp(text, i, first_cp);

  // Regional indicator pairs
  if (first_cp >= 0x1F1E6 && first_cp <= 0x1F1FF && i < bytes) {
    size_t peek = i;
    uint32_t next_cp = 0;
    decode_next_utf8_cp(text, peek, next_cp);
    if (next_cp >= 0x1F1E6 && next_cp <= 0x1F1FF) {
      i = peek;
    }
  }

  // Hangul Jamo L* V* T* sequence
  auto is_jamo_l = [](uint32_t c) { return (c >= 0x1100 && c <= 0x115F) || (c >= 0xA960 && c <= 0xA97C); };
  auto is_jamo_v = [](uint32_t c) { return (c >= 0x1160 && c <= 0x11A7) || (c >= 0xD7B0 && c <= 0xD7C6); };
  auto is_jamo_t = [](uint32_t c) { return (c >= 0x11A8 && c <= 0x11FF) || (c >= 0xD7CB && c <= 0xD7FB); };
  if (is_jamo_l(first_cp) || is_jamo_v(first_cp)) {
    uint32_t last_hangul = first_cp;
    while (i < bytes) {
      size_t peek = i;
      uint32_t next_cp = 0;
      decode_next_utf8_cp(text, peek, next_cp);
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

  // Combining marks, variation selectors, skin-tone modifiers, and ZWJ emoji joiners
  while (i < bytes) {
    size_t peek = i;
    uint32_t next_cp = 0;
    decode_next_utf8_cp(text, peek, next_cp);
    if (is_hotword_combining_mark_cp(next_cp)) {
      i = peek;
      continue;
    }
    if (next_cp == 0x200D && peek < bytes) {
      i = peek;
      uint32_t joined_cp = 0;
      decode_next_utf8_cp(text, i, joined_cp);
      continue;
    }
    break;
  }
  return i;
}

struct CppNormalizedClusterMap {
  std::vector<uint32_t> cps;
  std::vector<size_t> norm_to_raw_byte;
  std::vector<size_t> cluster_start;
  std::vector<uint8_t> is_sep;
  std::vector<uint8_t> is_sent_end;
  std::vector<uint8_t> is_weak_sep;
  std::vector<uint8_t> is_intra_punct;
  std::vector<uint8_t> is_ascii_alnum;
};

CppNormalizedClusterMap build_cpp_normalized_cluster_map(const std::string& text) {
  CppNormalizedClusterMap map;
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

struct CppTrieNode {
  std::unordered_map<uint32_t, int> children;
  int term_id{-1};
};

struct CppHallucinationMatcher {
  std::vector<CppTrieNode> fwd_nodes;
  std::vector<CppTrieNode> rev_nodes;
  std::vector<uint8_t> term_starts_ascii;
  std::vector<uint8_t> term_ends_ascii;
  std::vector<uint32_t> term_first_cp;
  std::vector<uint32_t> term_last_cp;
};

struct CppDistinct3State {
  int t1{-1};
  int t2{-1};
  int count{-1}; // -1 = unreachable, 0 = empty start/end, 1..3 = distinct term count (capped at 3)
};

inline CppDistinct3State advance_cpp_distinct3(const CppDistinct3State& st, int tid) {
  if (st.count < 0) return st;
  if (st.count >= 3) return st;
  if (st.count == 0) return {tid, -1, 1};
  if (st.count == 1) return st.t1 == tid ? st : CppDistinct3State{st.t1, tid, 2};
  if (tid == st.t1 || tid == st.t2) return st;
  return {st.t1, st.t2, 3};
}

inline bool has_valid_cpp_leading_sep(const CppNormalizedClusterMap& map, size_t pos) {
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

inline std::pair<bool, bool> is_valid_cpp_trailing_left_boundary(
    const CppNormalizedClusterMap& map,
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

size_t find_cpp_leading_rule_a_cut(
    const CppHallucinationMatcher& matcher,
    const CppNormalizedClusterMap& map) {
  const size_t n = map.cps.size();
  if (n == 0) return 0;

  std::vector<uint8_t> completed_sep(n + 1, 0);
  std::vector<std::unordered_map<int, int>> sep_run(n + 1);
  std::vector<std::unordered_map<int, int>> imm_same(n + 1);
  completed_sep[0] = 1;
  size_t best_cut = 0;

  auto record_run = [](std::unordered_map<int, int>& m, int tid, int len) {
    auto it = m.find(tid);
    if (it == m.end() || len > it->second) m[tid] = len;
  };

  for (size_t pos = 0; pos < n; ++pos) {
    const bool can_start_fresh = completed_sep[pos] == 1;
    auto& run_map = sep_run[pos];
    auto& imm_map = imm_same[pos];
    if (!can_start_fresh && run_map.empty() && imm_map.empty()) continue;

    if (pos > 0 && pos == map.cluster_start[pos] && map.is_sep[pos] == 0 && can_start_fresh) {
      if (has_valid_cpp_leading_sep(map, pos)) {
        best_cut = pos;
      }
    }

    if (map.is_sep[pos] == 1) {
      const bool is_sent_end = map.is_sent_end[pos] == 1;
      if (can_start_fresh) completed_sep[pos + 1] = 1;
      for (const auto& kv : run_map) {
        if (kv.second >= 2) completed_sep[pos + 1] = 1;
        if (!(kv.second >= 2 && is_sent_end)) {
          record_run(sep_run[pos + 1], kv.first, kv.second);
        }
      }
      for (const auto& kv : imm_map) {
        if (kv.second >= 2) completed_sep[pos + 1] = 1;
        if (!(kv.second >= 2 && is_sent_end)) {
          record_run(sep_run[pos + 1], kv.first, kv.second);
        }
      }
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

      int next_len = can_start_fresh ? 1 : 0;
      const auto rit = run_map.find(tid);
      if (rit != run_map.end() && rit->second >= 1) {
        next_len = std::max(next_len, rit->second >= 2 ? 2 : rit->second + 1);
      }
      const auto iit = imm_map.find(tid);
      if (iit != imm_map.end() && iit->second >= 1) {
        next_len = std::max(next_len, iit->second >= 2 ? 2 : iit->second + 1);
      }
      if (next_len == 0) continue;

      if (!matcher.term_ends_ascii[tid] || end_pos == n) {
        record_run(sep_run[end_pos], tid, next_len);
      } else {
        record_run(imm_same[end_pos], tid, next_len);
      }
    }
    run_map.clear();
    imm_map.clear();
  }
  return best_cut;
}

size_t find_cpp_leading_rule_b_cut(
    const CppHallucinationMatcher& matcher,
    const CppNormalizedClusterMap& map) {
  const size_t n = map.cps.size();
  if (n == 0) return 0;

  std::vector<CppDistinct3State> cleared_st(n + 1);
  std::vector<uint8_t> cleared_from_sep(n + 1, 0);
  std::vector<uint8_t> cleared_sep_end(n + 1, 0);
  std::vector<CppDistinct3State> ended_ascii_st(n + 1);
  std::vector<std::unordered_map<int, CppDistinct3State>> same_st(n + 1);

  cleared_st[0].count = 0;
  size_t best_cut = 0;

  for (size_t pos = 0; pos < n; ++pos) {
    const CppDistinct3State& c_st = cleared_st[pos];
    const CppDistinct3State& a_st = ended_ascii_st[pos];
    const bool has_c = c_st.count >= 0;
    auto& s_map = same_st[pos];
    if (!has_c && a_st.count < 0 && s_map.empty()) continue;

    bool has_best = has_c;
    CppDistinct3State best_st = c_st;
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
      if (has_valid_cpp_leading_sep(map, pos)) {
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
      CppDistinct3State start_st = matcher.term_starts_ascii[tid] ? c_st : best_st;
      const auto same_it = s_map.find(tid);
      if (same_it != s_map.end() && (!has_start || same_it->second.count > start_st.count)) {
        has_start = true;
        start_st = same_it->second;
      }
      if (!has_start) continue;

      const CppDistinct3State next_st = advance_cpp_distinct3(start_st, tid);
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

size_t find_cpp_leading_cut(
    const CppHallucinationMatcher& matcher,
    const CppNormalizedClusterMap& map) {
  return std::max(find_cpp_leading_rule_a_cut(matcher, map), find_cpp_leading_rule_b_cut(matcher, map));
}

size_t find_cpp_trailing_rule_a_cut(
    const CppHallucinationMatcher& matcher,
    const CppNormalizedClusterMap& map) {
  const size_t n = map.cps.size();
  if (n == 0) return n;

  std::vector<uint8_t> completed_sep(n + 1, 0);
  std::vector<std::unordered_map<int, int>> sep_run(n + 1);
  std::vector<std::unordered_map<int, int>> rev_same(n + 1);
  completed_sep[n] = 1;
  size_t best_term_start = n;

  auto record_run = [](std::unordered_map<int, int>& m, int tid, int len) {
    auto it = m.find(tid);
    if (it == m.end() || len > it->second) m[tid] = len;
  };

  for (size_t pos = n; pos > 0; --pos) {
    if (pos < n && pos != map.cluster_start[pos]) continue;
    const bool can_end_fresh = completed_sep[pos] == 1;
    auto& run_map = sep_run[pos];
    auto& imm_map = rev_same[pos];
    if (!can_end_fresh && run_map.empty() && imm_map.empty()) continue;

    const size_t prev_c = map.cluster_start[pos - 1];
    if (map.is_sep[prev_c] == 1) {
      bool sep_has_end = false;
      for (size_t k = prev_c; k < pos; ++k) {
        if (map.is_sent_end[k] == 1) {
          sep_has_end = true;
          break;
        }
      }
      if (can_end_fresh) completed_sep[prev_c] = 1;
      for (const auto& kv : run_map) {
        if (kv.second >= 2) completed_sep[prev_c] = 1;
        if (!(kv.second >= 2 && sep_has_end)) {
          record_run(sep_run[prev_c], kv.first, kv.second);
        }
      }
      for (const auto& kv : imm_map) {
        if (kv.second >= 2) completed_sep[prev_c] = 1;
        if (!(kv.second >= 2 && sep_has_end)) {
          record_run(sep_run[prev_c], kv.first, kv.second);
        }
      }
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

      int next_len = can_end_fresh ? 1 : 0;
      const auto rit = run_map.find(tid);
      if (rit != run_map.end() && rit->second >= 1) {
        next_len = std::max(next_len, rit->second >= 2 ? 2 : rit->second + 1);
      }
      const auto iit = imm_map.find(tid);
      if (iit != imm_map.end() && iit->second >= 1) {
        next_len = std::max(next_len, iit->second >= 2 ? 2 : iit->second + 1);
      }
      if (next_len == 0) continue;

      if (!matcher.term_starts_ascii[tid] || idx == 0) {
        record_run(sep_run[idx], tid, next_len);
      } else {
        record_run(rev_same[idx], tid, next_len);
      }

      if (next_len >= 2 && idx > 0) {
        const auto [valid, sent_end] = is_valid_cpp_trailing_left_boundary(map, idx, matcher.term_starts_ascii[tid] == 1);
        (void)sent_end;
        if (valid && idx < best_term_start) {
          best_term_start = idx;
        }
      }
    }
    run_map.clear();
    imm_map.clear();
  }
  return best_term_start;
}

size_t find_cpp_trailing_rule_b_cut(
    const CppHallucinationMatcher& matcher,
    const CppNormalizedClusterMap& map) {
  const size_t n = map.cps.size();
  if (n == 0) return n;

  std::vector<CppDistinct3State> rev_cleared(n + 1);
  std::vector<uint8_t> rev_cleared_locked(n + 1, 0);
  std::vector<CppDistinct3State> rev_ascii(n + 1);
  std::vector<std::unordered_map<int, CppDistinct3State>> rev_same(n + 1);

  rev_cleared[n].count = 0;
  size_t best_term_start = n;

  for (size_t pos = n; pos > 0; --pos) {
    if (pos < n && pos != map.cluster_start[pos]) continue;
    const CppDistinct3State& c_st = rev_cleared[pos];
    const CppDistinct3State& a_st = rev_ascii[pos];
    const bool has_c = c_st.count >= 0;
    auto& s_map = rev_same[pos];
    if (!has_c && a_st.count < 0 && s_map.empty()) continue;

    bool has_best = has_c;
    CppDistinct3State best_st = c_st;
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
      CppDistinct3State right_st = matcher.term_ends_ascii[tid] ? c_st : best_st;
      const auto same_it = s_map.find(tid);
      if (same_it != s_map.end() && (!has_right || same_it->second.count > right_st.count)) {
        has_right = true;
        right_st = same_it->second;
      }
      if (!has_right) continue;

      const CppDistinct3State next_st = advance_cpp_distinct3(right_st, tid);
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
        const auto [valid, sent_end] = is_valid_cpp_trailing_left_boundary(map, idx, matcher.term_starts_ascii[tid] == 1);
        if (valid && sent_end && idx < best_term_start) {
          best_term_start = idx;
        }
      }
    }
    s_map.clear();
  }
  return best_term_start;
}

size_t find_cpp_trailing_cut(
    const CppHallucinationMatcher& matcher,
    const CppNormalizedClusterMap& map) {
  const size_t n = map.cps.size();
  if (n == 0) return n;
  const size_t start_a = find_cpp_trailing_rule_a_cut(matcher, map);
  const size_t start_b = find_cpp_trailing_rule_b_cut(matcher, map);
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

std::string strip_voice_hotword_hallucination(
    const std::string& text,
    const std::vector<std::string>& hotword_terms,
    bool allow_single = false) {
  if (text.empty() || hotword_terms.empty()) return text;

  std::vector<std::vector<uint32_t>> unique_terms;
  for (const auto& raw : hotword_terms) {
    const std::string trimmed = trim_ascii_ws(raw);
    if (trimmed.empty()) continue;
    const std::vector<uint32_t> norm_cps = normalize_hotword_utf8_to_cps(trimmed);
    if (norm_cps.empty()) continue;
    bool dup = false;
    for (const auto& existing : unique_terms) {
      if (existing == norm_cps) {
        dup = true;
        break;
      }
    }
    if (!dup) unique_terms.push_back(norm_cps);
  }
  if (unique_terms.empty()) return text;

  CppHallucinationMatcher matcher;
  matcher.fwd_nodes.emplace_back();
  matcher.rev_nodes.emplace_back();
  matcher.term_starts_ascii.reserve(unique_terms.size());
  matcher.term_ends_ascii.reserve(unique_terms.size());
  matcher.term_first_cp.reserve(unique_terms.size());
  matcher.term_last_cp.reserve(unique_terms.size());

  for (int tid = 0; tid < static_cast<int>(unique_terms.size()); ++tid) {
    const auto& cps = unique_terms[tid];
    matcher.term_starts_ascii.push_back(is_hotword_ascii_alnum_cp(cps.front()) ? 1 : 0);
    matcher.term_ends_ascii.push_back(is_hotword_ascii_alnum_cp(cps.back()) ? 1 : 0);
    matcher.term_first_cp.push_back(cps.front());
    matcher.term_last_cp.push_back(cps.back());

    int cur = 0;
    for (uint32_t cp : cps) {
      auto it = matcher.fwd_nodes[cur].children.find(cp);
      if (it == matcher.fwd_nodes[cur].children.end()) {
        int next = static_cast<int>(matcher.fwd_nodes.size());
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
      uint32_t cp = cps[k - 1];
      auto it = matcher.rev_nodes[rcur].children.find(cp);
      if (it == matcher.rev_nodes[rcur].children.end()) {
        int next = static_cast<int>(matcher.rev_nodes.size());
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

  constexpr int kInf = 0x3FFF'FFFF;
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
      if (sep_min < cleared[pos + 1]) {
        cleared[pos + 1] = sep_min;
      }
    }

    int cur_idx = 0;
    for (size_t p = pos; p < n; ++p) {
      const auto it = matcher.fwd_nodes[cur_idx].children.find(cps[p]);
      if (it == matcher.fwd_nodes[cur_idx].children.end()) break;
      cur_idx = it->second;
      const int tid = matcher.fwd_nodes[cur_idx].term_id;
      if (tid < 0) continue;

      int start_cost = matcher.term_starts_ascii[tid] ? c_count : best_at_pos;
      const auto same_it = same_map.find(tid);
      if (same_it != same_map.end() && same_it->second < start_cost) {
        start_cost = same_it->second;
      }
      if (start_cost >= kInf) continue;

      const size_t end_pos = p + 1;
      const int next_cost = start_cost + 1;
      if (!matcher.term_ends_ascii[tid] || end_pos == n) {
        if (next_cost < cleared[end_pos]) cleared[end_pos] = next_cost;
      } else {
        if (next_cost < ended_ascii[end_pos]) ended_ascii[end_pos] = next_cost;
        if (matcher.term_starts_ascii[tid] && cps[end_pos] == matcher.term_first_cp[tid]) {
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

  std::string current = text;
  const auto whole_map = build_cpp_normalized_cluster_map(current);
  const size_t lead_cut = find_cpp_leading_cut(matcher, whole_map);
  if (lead_cut > 0 && lead_cut < whole_map.cps.size()) {
    current = current.substr(whole_map.norm_to_raw_byte[lead_cut]);
  }
  if (current.empty()) return {};

  const auto tail_map = lead_cut > 0 ? build_cpp_normalized_cluster_map(current) : whole_map;
  const size_t tail_cut = find_cpp_trailing_cut(matcher, tail_map);
  if (tail_cut < tail_map.cps.size()) {
    current = current.substr(0, tail_map.norm_to_raw_byte[tail_cut]);
  }
  return current;
}

template <typename DecodeFn, typename EmitFn>
class SegmentedUtterancePipeline {
 public:
  SegmentedUtterancePipeline(
      DecodeFn decode_fn,
      EmitFn emit_fn,
      size_t max_segment_samples = kMaxSegmentSamples,
      size_t max_final_redecode_samples = kMaxFinalReDecodeSamples,
      std::vector<std::string> hotword_terms = {})
      : decode_fn_(std::move(decode_fn)),
        emit_fn_(std::move(emit_fn)),
        max_segment_samples_(max_segment_samples),
        max_final_redecode_samples_(max_final_redecode_samples),
        hotword_terms_(std::move(hotword_terms)) {}

  void preload(std::vector<float> initial) {
    if (initial.empty()) return;
    {
      std::lock_guard<std::mutex> lock(mu_);
      if (producer_finished_ || aborted_) return;
      pending_samples_.insert(pending_samples_.end(), initial.begin(), initial.end());
    }
    cv_.notify_one();
  }

  void push(const float* data, size_t count) {
    if (!data || count == 0) return;
    {
      std::lock_guard<std::mutex> lock(mu_);
      if (producer_finished_ || aborted_) return;
      pending_samples_.insert(pending_samples_.end(), data, data + count);
    }
    cv_.notify_one();
  }

  void push(const std::vector<float>& samples) {
    push(samples.data(), samples.size());
  }

  void mark_producer_finished() {
    {
      std::lock_guard<std::mutex> lock(mu_);
      producer_finished_ = true;
    }
    cv_.notify_all();
  }

  void request_stop(bool abort_only, bool producer_also_finished) {
    {
      std::lock_guard<std::mutex> lock(mu_);
      if (abort_only) {
        aborted_ = true;
      }
      stop_requested_ = true;
      if (producer_also_finished) {
        producer_finished_ = true;
      }
    }
    cv_.notify_all();
  }

  void run_loop() {
    std::vector<float> segment_samples;
    segment_samples.reserve(max_segment_samples_ + 16000);
    std::vector<float> utterance_samples;
    bool utterance_exceeded_final_cap = false;
    std::string committed_text;
    bool committed_has_trusted_real_text = false;
    bool committed_pending_single_hotword = false;
    std::string active_segment_text;
    std::string active_trusted_real_text;
    bool active_pending_single_hotword = false;
    bool retracted_segment_single_hotword = false;
    bool pending_retraction_final = false;
    std::string last_emitted_text;
    size_t last_decoded_len = 0;

    auto sanitize_combined_text = [&](const std::string& raw_combined) -> std::string {
      if (hotword_terms_.empty() || raw_combined.empty()) return raw_combined;
      return strip_voice_hotword_hallucination(raw_combined, hotword_terms_, false);
    };

    auto text_has_real_non_hotword = [&](const std::string& t) -> bool {
      if (t.empty()) return false;
      if (hotword_terms_.empty()) return true;
      return !strip_voice_hotword_hallucination(t, hotword_terms_, true).empty();
    };

    auto sanitize_decoded = [&](const std::string& raw_decoded,
                                bool& out_hit_hallucination,
                                bool& out_has_real_non_hotword) -> std::string {
      const std::string raw_text = strip_asr_control_tags(raw_decoded);
      if (hotword_terms_.empty()) {
        out_hit_hallucination = false;
        out_has_real_non_hotword = !raw_text.empty();
        return raw_text;
      }
      const std::string pre_hallucination = strip_voice_hotword_hallucination(raw_text, hotword_terms_, false);
      const std::string after_rep = sanitize_asr_repetition_loop(pre_hallucination);
      const std::string text = strip_voice_hotword_hallucination(after_rep, hotword_terms_, false);
      out_hit_hallucination = !raw_text.empty() && text.empty() && (pre_hallucination.empty() || !after_rep.empty());
      out_has_real_non_hotword = !text.empty() && !strip_voice_hotword_hallucination(text, hotword_terms_, true).empty();
      return text;
    };

    while (true) {
      bool can_finish_now = false;
      bool is_aborted = false;
      bool has_remaining_pending = false;
      bool is_stop_requested = false;
      {
        std::unique_lock<std::mutex> lock(mu_);
        cv_.wait_for(lock, std::chrono::milliseconds(100), [this]() {
          return pending_head_ < pending_samples_.size() ||
                 stop_requested_ ||
                 producer_finished_ ||
                 aborted_;
        });
        if (aborted_) {
          is_aborted = true;
        } else {
          const size_t available = pending_samples_.size() - pending_head_;
          const size_t space = max_segment_samples_ > segment_samples.size()
              ? (max_segment_samples_ - segment_samples.size())
              : 0;
          const size_t max_take = std::min(space, available);
          const size_t take = find_pause_split_take_count(
              segment_samples,
              pending_samples_,
              pending_head_,
              max_take,
              active_segment_text);
          if (take > 0) {
            const auto take_begin = pending_samples_.begin() + static_cast<std::ptrdiff_t>(pending_head_);
            const auto take_end = take_begin + static_cast<std::ptrdiff_t>(take);
            segment_samples.insert(segment_samples.end(), take_begin, take_end);
            if (!utterance_exceeded_final_cap) {
              if (utterance_samples.size() + take > max_final_redecode_samples_) {
                utterance_exceeded_final_cap = true;
                std::vector<float>().swap(utterance_samples);
              } else {
                utterance_samples.insert(utterance_samples.end(), take_begin, take_end);
              }
            }
            pending_head_ += take;
            if (pending_head_ == pending_samples_.size()) {
              pending_samples_.clear();
              pending_head_ = 0;
            }
          }
          has_remaining_pending = (pending_head_ < pending_samples_.size());
          is_stop_requested = stop_requested_;
          can_finish_now = is_stop_requested && producer_finished_ && !has_remaining_pending;
        }
      }

      if (is_aborted) {
        std::vector<float>().swap(utterance_samples);
        break;
      }

      const bool reached_segment_cap = segment_samples.size() >= max_segment_samples_;
      const bool reached_pause_split =
          !reached_segment_cap && has_trailing_silence_pause(segment_samples, active_segment_text);
      const bool should_commit_segment = reached_segment_cap || reached_pause_split;
      const bool skip_trailing_segment_commit =
          can_finish_now && !utterance_exceeded_final_cap;
      const bool need_decode =
          segment_samples.size() >= kInitialPartialSamples &&
          (segment_samples.size() - last_decoded_len >= kStepPartialSamples ||
           (should_commit_segment && !skip_trailing_segment_commit));

      if (need_decode && !(can_finish_now && (!should_commit_segment || skip_trailing_segment_commit))) {
        last_decoded_len = segment_samples.size();
        const std::vector<float> trimmed_seg = trim_silence_edges(segment_samples);
        const bool segment_has_speech = !trimmed_seg.empty();
        bool hit_hallucination = false;
        bool has_real_non_hotword = false;
        const std::string seg_text = segment_has_speech
            ? sanitize_decoded(decode_fn_(trimmed_seg), hit_hallucination, has_real_non_hotword)
            : std::string{};
        {
          std::lock_guard<std::mutex> lock(mu_);
          if (aborted_) {
            is_aborted = true;
          }
        }
        if (is_aborted) {
          std::vector<float>().swap(utterance_samples);
          break;
        }
        if (!hotword_terms_.empty() && hit_hallucination) {
          if (active_pending_single_hotword) {
            retracted_segment_single_hotword = true;
          }
          active_pending_single_hotword = false;
          if (!active_trusted_real_text.empty()) {
            active_segment_text = active_trusted_real_text;
          } else {
            active_segment_text.clear();
          }
          const std::string fallback = join_transcript_segments(committed_text, active_segment_text);
          if (fallback != last_emitted_text && (!fallback.empty() || !last_emitted_text.empty())) {
            last_emitted_text = fallback;
            if (fallback.empty()) pending_retraction_final = true;
            if (!can_finish_now) {
              emit_fn_("{\"type\":\"result\",\"text\":\"" + json_escape(fallback) + "\",\"isFinal\":false}");
            }
          }
        } else if (!seg_text.empty()) {
          active_segment_text = seg_text;
          if (!hotword_terms_.empty()) {
            if (has_real_non_hotword) {
              active_trusted_real_text = seg_text;
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
        }
        const std::string& effective_seg = !active_segment_text.empty() ? active_segment_text : std::string{};
        const std::string combined_raw = join_transcript_segments(committed_text, effective_seg);
        const std::string combined = sanitize_combined_text(combined_raw);
        if (!hotword_terms_.empty() && !combined_raw.empty() && combined.empty()) {
          active_segment_text.clear();
          active_trusted_real_text.clear();
          active_pending_single_hotword = false;
          retracted_segment_single_hotword = true;
          if (!committed_has_trusted_real_text) {
            committed_text.clear();
            committed_pending_single_hotword = false;
          }
          if (should_commit_segment) {
            segment_samples.clear();
            last_decoded_len = 0;
          }
          if (!last_emitted_text.empty()) {
            last_emitted_text.clear();
            pending_retraction_final = true;
            if (!can_finish_now) {
              emit_fn_("{\"type\":\"result\",\"text\":\"\",\"isFinal\":false}");
            }
          }
          if (should_commit_segment && (has_remaining_pending || (is_stop_requested && !can_finish_now))) {
            continue;
          }
        } else if (should_commit_segment) {
          if (!effective_seg.empty()) {
            const bool combined_real = text_has_real_non_hotword(combined);
            if (!hotword_terms_.empty() && (!active_trusted_real_text.empty() || has_real_non_hotword || combined_real)) {
              committed_has_trusted_real_text = true;
              committed_pending_single_hotword = false;
            } else if (hotword_terms_.empty()) {
              committed_has_trusted_real_text = true;
            } else if (!committed_has_trusted_real_text && !combined.empty()) {
              committed_pending_single_hotword = true;
            }
            committed_text = combined;
          }
          active_segment_text.clear();
          active_trusted_real_text.clear();
          active_pending_single_hotword = false;
          segment_samples.clear();
          last_decoded_len = 0;
          if (!can_finish_now && !combined.empty() && combined != last_emitted_text) {
            last_emitted_text = combined;
            pending_retraction_final = false;
            emit_fn_("{\"type\":\"result\",\"text\":\"" + json_escape(combined) + "\",\"isFinal\":false}");
          }
          if (has_remaining_pending || (is_stop_requested && !can_finish_now)) {
            continue;
          }
        } else if (!seg_text.empty() && !combined.empty() && combined != last_emitted_text) {
          last_emitted_text = combined;
          pending_retraction_final = false;
          emit_fn_("{\"type\":\"result\",\"text\":\"" + json_escape(combined) + "\",\"isFinal\":false}");
        }
      }

      if (can_finish_now) {
        break;
      }
    }

    bool final_aborted = false;
    {
      std::lock_guard<std::mutex> lock(mu_);
      final_aborted = aborted_;
    }

    if (!final_aborted) {
      std::string final_text;
      if (!utterance_exceeded_final_cap && utterance_samples.size() >= 1600) {
        const std::vector<float> trimmed_utterance = trim_silence_edges(utterance_samples);
        std::vector<float>().swap(utterance_samples);
        if (!trimmed_utterance.empty()) {
          bool hit_hallucination = false;
          bool has_real_non_hotword = false;
          final_text = sanitize_decoded(decode_fn_(trimmed_utterance), hit_hallucination, has_real_non_hotword);
          if (!hotword_terms_.empty()) {
            const bool blocked_single_only = !final_text.empty() && !has_real_non_hotword &&
                (retracted_segment_single_hotword || pending_retraction_final ||
                 committed_has_trusted_real_text || !active_trusted_real_text.empty());
            if (hit_hallucination || blocked_single_only || final_text.empty()) {
              if (committed_has_trusted_real_text) {
                final_text = committed_text;
              } else if (!active_trusted_real_text.empty()) {
                final_text = active_trusted_real_text;
              } else {
                final_text.clear();
              }
            }
          } else if (final_text.empty()) {
            final_text = join_transcript_segments(committed_text, active_segment_text);
          }
        } else {
          if (hotword_terms_.empty()) {
            final_text = join_transcript_segments(committed_text, active_segment_text);
          } else if (committed_has_trusted_real_text) {
            final_text = join_transcript_segments(committed_text, active_trusted_real_text);
          } else {
            final_text.clear();
          }
        }
      } else {
        std::vector<float>().swap(utterance_samples);
        std::string final_seg = active_segment_text;
        const std::vector<float> trimmed_tail = trim_silence_edges(segment_samples);
        bool tail_has_real_non_hotword = false;
        if (segment_samples.size() >= 1600 && !trimmed_tail.empty()) {
          bool hit_hallucination = false;
          const std::string tail_text = sanitize_decoded(decode_fn_(trimmed_tail), hit_hallucination, tail_has_real_non_hotword);
          if (!hotword_terms_.empty()) {
            if (tail_has_real_non_hotword && !committed_text.empty()) {
              committed_has_trusted_real_text = true;
              committed_pending_single_hotword = false;
            }
            const bool blocked_single_only = !tail_text.empty() && !tail_has_real_non_hotword &&
                (retracted_segment_single_hotword || pending_retraction_final || !active_trusted_real_text.empty());
            if (hit_hallucination || blocked_single_only || tail_text.empty()) {
              final_seg = active_trusted_real_text;
            } else {
              final_seg = tail_text;
            }
          } else if (!tail_text.empty()) {
            final_seg = tail_text;
          }
        } else if (!hotword_terms_.empty()) {
          final_seg = active_trusted_real_text;
        }
        const bool drop_retracted_single_committed =
            !hotword_terms_.empty() &&
            committed_pending_single_hotword &&
            !committed_has_trusted_real_text &&
            (retracted_segment_single_hotword || pending_retraction_final);
        const std::string base_committed =
            drop_retracted_single_committed ? std::string{} : committed_text;
        const std::string raw_final = join_transcript_segments(base_committed, final_seg);
        final_text = sanitize_combined_text(raw_final);
        if (!hotword_terms_.empty() && final_text.empty() && !raw_final.empty() && committed_has_trusted_real_text) {
          final_text = committed_text;
        }
        if (!hotword_terms_.empty() &&
            retracted_segment_single_hotword &&
            !committed_has_trusted_real_text &&
            !final_text.empty() &&
            !text_has_real_non_hotword(final_text)) {
          final_text.clear();
        }
      }
      {
        std::lock_guard<std::mutex> lock(mu_);
        final_aborted = aborted_;
        if (!final_aborted) {
          emit_fn_("{\"type\":\"result\",\"text\":\"" + json_escape(final_text) + "\",\"isFinal\":true}");
        }
      }
    } else {
      std::vector<float>().swap(utterance_samples);
    }
    emit_fn_("{\"type\":\"end\"}");
  }

 private:
  DecodeFn decode_fn_;
  EmitFn emit_fn_;
  size_t max_segment_samples_;
  size_t max_final_redecode_samples_;
  std::vector<std::string> hotword_terms_;
  std::mutex mu_;
  std::condition_variable cv_;
  std::vector<float> pending_samples_;
  size_t pending_head_{0};
  bool producer_finished_{false};
  bool stop_requested_{false};
  bool aborted_{false};
};

std::vector<uint8_t> decode_base64_bytes(const std::string& input) {
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

std::vector<float> decode_base64_pcm16_samples(const std::string& b64) {
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

struct ActiveServeSessionHandle {
  virtual ~ActiveServeSessionHandle() = default;
  virtual void start() = 0;
  virtual void push_pcm_base64(const std::string& b64) {}
  virtual void request_stop(bool abort_only) = 0;
  virtual void wait_for_finish() = 0;
};

class PcmUtteranceDecoder : public ActiveServeSessionHandle {
 public:
  using DecodeFn = std::function<std::string(const std::vector<float>&)>;
  using EmitFn = std::function<void(const std::string&)>;

  PcmUtteranceDecoder(
      DecodeFn decode_fn,
      EmitFn emit_fn,
      size_t max_segment_samples = kMaxSegmentSamples,
      size_t max_final_redecode_samples = kMaxFinalReDecodeSamples,
      std::vector<std::string> hotword_terms = {})
      : emit_fn_(emit_fn),
        pipeline_(
            std::move(decode_fn),
            std::move(emit_fn),
            max_segment_samples,
            max_final_redecode_samples,
            std::move(hotword_terms)) {}

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
    pipeline_.push(samples);
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
  SegmentedUtterancePipeline<DecodeFn, EmitFn> pipeline_;
  std::thread worker_;
};

class ServeCommandLoop {
 public:
  using MicFactoryFn = std::function<std::unique_ptr<ActiveServeSessionHandle>(const std::string& dev, std::vector<float> initial)>;
  using PcmFactoryFn = std::function<std::unique_ptr<ActiveServeSessionHandle>()>;
  using MicWithHotwordsFactoryFn = std::function<std::unique_ptr<ActiveServeSessionHandle>(
      const std::string& dev, std::vector<float> initial, std::vector<std::string> hotwords)>;
  using PcmWithHotwordsFactoryFn = std::function<std::unique_ptr<ActiveServeSessionHandle>(std::vector<std::string> hotwords)>;

  ServeCommandLoop(MicFactoryFn mic_factory, PcmFactoryFn pcm_factory)
      : mic_factory_(std::move(mic_factory)), pcm_factory_(std::move(pcm_factory)) {}

  void set_hotword_factories(MicWithHotwordsFactoryFn mic_hw, PcmWithHotwordsFactoryFn pcm_hw) {
    mic_hw_factory_ = std::move(mic_hw);
    pcm_hw_factory_ = std::move(pcm_hw);
  }

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
      if (mic_hw_factory_ || mic_factory_) {
        const std::string dev = extract_json_string_field(line, "device").value_or("auto");
        std::vector<std::string> hotwords = extract_json_string_array_field(line, "hotwords");
        std::vector<float> initial = std::move(prefilled_pcm_);
        prefilled_pcm_.clear();
        active_session_ = mic_hw_factory_
            ? mic_hw_factory_(dev, std::move(initial), std::move(hotwords))
            : mic_factory_(dev, std::move(initial));
        if (active_session_) {
          active_session_->start();
        }
      }
    } else if (*cmd == "start_pcm") {
      prefilled_pcm_.clear();
      join_and_reset_active(true);
      if (pcm_hw_factory_ || pcm_factory_) {
        std::vector<std::string> hotwords = extract_json_string_array_field(line, "hotwords");
        active_session_ = pcm_hw_factory_
            ? pcm_hw_factory_(std::move(hotwords))
            : pcm_factory_();
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
  MicWithHotwordsFactoryFn mic_hw_factory_;
  PcmWithHotwordsFactoryFn pcm_hw_factory_;
  std::unique_ptr<ActiveServeSessionHandle> active_session_;
  std::vector<float> prefilled_pcm_;
};

#ifdef IMCODES_HAS_SHERPA_ONNX

class Qwen3OnnxEngine {
 public:
  Qwen3OnnxEngine() = default;
  ~Qwen3OnnxEngine() {
    if (recognizer_) {
      SherpaOnnxDestroyOfflineRecognizer(recognizer_);
      recognizer_ = nullptr;
    }
  }

  bool init(const std::string& model_dir, const std::string& requested_provider, std::string& out_error) {
    namespace fs = std::filesystem;
    const fs::path base(utf8_to_wide(model_dir));
    conv_frontend_ = wide_to_utf8((base / L"conv_frontend.onnx").wstring());
    encoder_ = wide_to_utf8((base / L"encoder.int8.onnx").wstring());
    decoder_ = wide_to_utf8((base / L"decoder.int8.onnx").wstring());
    tokenizer_ = wide_to_utf8((base / L"tokenizer").wstring());
    hotwords_ = load_hotwords_string(base / L"hotwords.txt");

    if (!fs::exists(base / L"conv_frontend.onnx") ||
        !fs::exists(base / L"encoder.int8.onnx") ||
        !fs::exists(base / L"decoder.int8.onnx") ||
        !fs::exists(base / L"tokenizer" / L"vocab.json")) {
      out_error = "Missing Qwen3-ASR ONNX model files in model directory";
      return false;
    }

    const int hw_threads = static_cast<int>(std::thread::hardware_concurrency());
    const int cpu_threads = std::clamp(hw_threads > 0 ? hw_threads / 2 : 4, 4, 14);

    std::vector<std::string> try_providers;
    if (requested_provider == "directml") {
      try_providers.push_back("directml");
      try_providers.push_back("cpu");
    } else if (requested_provider == "cpu") {
      try_providers.push_back("cpu");
    } else {
      const GpuProbeInfo gpu = probe_best_gpu();
      if (gpu.provider == "directml") {
        try_providers.push_back("directml");
      }
      try_providers.push_back("cpu");
    }

    for (const std::string& provider : try_providers) {
      SherpaOnnxOfflineRecognizerConfig cfg{};
      std::memset(&cfg, 0, sizeof(cfg));
      cfg.feat_config.sample_rate = kTargetSampleRate;
      cfg.feat_config.feature_dim = 128;

      cfg.model_config.qwen3_asr.conv_frontend = conv_frontend_.c_str();
      cfg.model_config.qwen3_asr.encoder = encoder_.c_str();
      cfg.model_config.qwen3_asr.decoder = decoder_.c_str();
      cfg.model_config.qwen3_asr.tokenizer = tokenizer_.c_str();
      cfg.model_config.qwen3_asr.max_total_len = 1024;
      cfg.model_config.qwen3_asr.max_new_tokens = 384;
      cfg.model_config.qwen3_asr.temperature = 1e-6f;
      cfg.model_config.qwen3_asr.top_p = 0.8f;
      cfg.model_config.qwen3_asr.seed = 42;
      cfg.model_config.qwen3_asr.hotwords = hotwords_.empty() ? nullptr : hotwords_.c_str();

      cfg.model_config.num_threads = (provider == "directml") ? 2 : cpu_threads;
      cfg.model_config.debug = 0;
      cfg.model_config.provider = provider.c_str();
      cfg.decoding_method = "greedy_search";

      recognizer_ = SherpaOnnxCreateOfflineRecognizer(&cfg);
      if (recognizer_) {
        active_provider_ = provider;
        return true;
      }
    }

    out_error = "Failed to initialize SherpaOnnxOfflineRecognizer for Qwen3-ASR";
    return false;
  }

  std::string decode(const std::vector<float>& samples_16k) {
    if (!recognizer_ || samples_16k.empty()) return {};
    std::lock_guard<std::mutex> lock(decode_mutex_);
    const SherpaOnnxOfflineStream* stream = SherpaOnnxCreateOfflineStream(recognizer_);
    if (!stream) return {};
    SherpaOnnxAcceptWaveformOffline(stream, kTargetSampleRate, samples_16k.data(),
                                    static_cast<int32_t>(samples_16k.size()));
    SherpaOnnxDecodeOfflineStream(recognizer_, stream);
    const SherpaOnnxOfflineRecognizerResult* res = SherpaOnnxGetOfflineStreamResult(stream);
    std::string text;
    if (res && res->text) {
      text = res->text;
    }
    if (res) {
      SherpaOnnxDestroyOfflineRecognizerResult(res);
    }
    SherpaOnnxDestroyOfflineStream(stream);
    return sanitize_asr_repetition_loop(strip_asr_control_tags(text));
  }

  const std::string& active_provider() const { return active_provider_; }
  std::vector<std::string> hotword_terms() const { return split_hotwords_string(hotwords_); }

 private:
  static std::string load_hotwords_string(const std::filesystem::path& p) {
    if (!std::filesystem::exists(p)) return {};
    FILE* f = _wfopen(p.c_str(), L"rb");
    if (!f) return {};
    std::string raw;
    char buf[1024];
    while (size_t n = std::fread(buf, 1, sizeof(buf), f)) {
      raw.append(buf, n);
    }
    std::fclose(f);
    std::string joined;
    std::istringstream iss(raw);
    std::string line;
    while (std::getline(iss, line)) {
      while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t')) {
        line.pop_back();
      }
      if (line.empty()) continue;
      if (!joined.empty()) joined.push_back(',');
      joined += line;
    }
    return joined;
  }

  const SherpaOnnxOfflineRecognizer* recognizer_{nullptr};
  std::mutex decode_mutex_;
  std::string conv_frontend_;
  std::string encoder_;
  std::string decoder_;
  std::string tokenizer_;
  std::string hotwords_;
  std::string active_provider_{"cpu"};
};

class WasapiUtteranceCapture : public ActiveServeSessionHandle {
 public:
  WasapiUtteranceCapture(
      Qwen3OnnxEngine& engine,
      std::string device_uid,
      std::vector<float> initial_samples = {},
      std::vector<std::string> hotword_terms = {})
      : engine_(engine),
        device_uid_(std::move(device_uid)),
        initial_samples_(std::move(initial_samples)),
        pipeline_(
            [this](const std::vector<float>& samples) { return engine_.decode(samples); },
            [](const std::string& line) { emit_json_line(line); },
            kMaxSegmentSamples,
            kMaxFinalReDecodeSamples,
            std::move(hotword_terms)) {}

  ~WasapiUtteranceCapture() override {
    stop(true);
  }

  void start() override {
    worker_ = std::thread([this]() { run_loop(); });
  }

  void request_stop(bool abort_only) override {
    if (abort_only) {
      aborted_.store(true);
    }
    stop_requested_.store(true);
    pipeline_.request_stop(abort_only, false);
    {
      std::lock_guard<std::mutex> lock(event_mu_);
      if (stop_event_) {
        SetEvent(stop_event_);
      }
    }
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
  void run_loop() {
    ScopedComInit com;
    HANDLE local_stop_event = CreateEventW(nullptr, TRUE, stop_requested_.load() ? TRUE : FALSE, nullptr);
    HANDLE capture_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    {
      std::lock_guard<std::mutex> lock(event_mu_);
      stop_event_ = local_stop_event;
    }
    if (!local_stop_event || !capture_event) {
      {
        std::lock_guard<std::mutex> lock(event_mu_);
        stop_event_ = nullptr;
      }
      if (local_stop_event) CloseHandle(local_stop_event);
      if (capture_event) CloseHandle(capture_event);
      emit_error("audio_init_failed", "mic", "Failed to create WASAPI wait events");
      emit_json_line("{\"type\":\"end\"}");
      return;
    }

    IMMDeviceEnumerator* enumerator = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* audio_client = nullptr;
    IAudioCaptureClient* capture_client = nullptr;
    WAVEFORMATEX* mix_fmt = nullptr;

    auto cleanup = [&]() {
      if (audio_client) audio_client->Stop();
      if (mix_fmt) CoTaskMemFree(mix_fmt);
      if (capture_client) capture_client->Release();
      if (audio_client) audio_client->Release();
      if (device) device->Release();
      if (enumerator) enumerator->Release();
      CloseHandle(capture_event);
      {
        std::lock_guard<std::mutex> lock(event_mu_);
        stop_event_ = nullptr;
      }
      CloseHandle(local_stop_event);
    };

    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator),
                                reinterpret_cast<void**>(&enumerator))) || !enumerator) {
      cleanup();
      emit_error("audio_init_failed", "mic", "MMDeviceEnumerator unavailable");
      emit_json_line("{\"type\":\"end\"}");
      return;
    }

    const std::string resolved_uid = resolve_target_capture_uid(device_uid_);
    HRESULT hr = E_FAIL;
    if (!resolved_uid.empty()) {
      const std::wstring wid = utf8_to_wide(resolved_uid);
      hr = enumerator->GetDevice(wid.c_str(), &device);
    } else {
      hr = enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &device);
    }
    if (FAILED(hr) || !device) {
      cleanup();
      emit_error("no_input_device", "mic", "No active WASAPI microphone found");
      emit_json_line("{\"type\":\"end\"}");
      return;
    }

    if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                reinterpret_cast<void**>(&audio_client))) || !audio_client) {
      cleanup();
      emit_error("permission_denied", "mic", "Failed to activate WASAPI audio client");
      emit_json_line("{\"type\":\"end\"}");
      return;
    }

    if (FAILED(audio_client->GetMixFormat(&mix_fmt)) || !mix_fmt) {
      cleanup();
      emit_error("audio_format_failed", "mic", "Failed to read WASAPI mix format");
      emit_json_line("{\"type\":\"end\"}");
      return;
    }

    const REFERENCE_TIME buffer_duration = 1000000;  // 100ms
    hr = audio_client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        buffer_duration,
        0,
        mix_fmt,
        nullptr);
    if (FAILED(hr)) {
      cleanup();
      emit_error("audio_init_failed", "mic", "WASAPI IAudioClient::Initialize failed");
      emit_json_line("{\"type\":\"end\"}");
      return;
    }

    if (FAILED(audio_client->SetEventHandle(capture_event)) ||
        FAILED(audio_client->GetService(__uuidof(IAudioCaptureClient),
                                        reinterpret_cast<void**>(&capture_client))) ||
        !capture_client) {
      cleanup();
      emit_error("audio_init_failed", "mic", "Failed to bind WASAPI capture client");
      emit_json_line("{\"type\":\"end\"}");
      return;
    }

    if (FAILED(audio_client->Start())) {
      cleanup();
      emit_error("audio_start_failed", "mic", "Failed to start WASAPI audio stream");
      emit_json_line("{\"type\":\"end\"}");
      return;
    }

    pipeline_.preload(std::move(initial_samples_));
    initial_samples_.clear();
    initial_samples_.shrink_to_fit();
    std::thread decode_thread([this]() { pipeline_.run_loop(); });

    emit_json_line("{\"type\":\"start\"}");

    const uint32_t in_rate = mix_fmt->nSamplesPerSec;
    const uint16_t channels = std::max<uint16_t>(1, mix_fmt->nChannels);
    bool is_float = (mix_fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
    if (mix_fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE && mix_fmt->cbSize >= 22) {
      const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(mix_fmt);
      static const GUID kSubFormatFloat = {
          0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
      is_float = (std::memcmp(&ext->SubFormat, &kSubFormatFloat, sizeof(GUID)) == 0);
    }

    double resample_pos = 0.0;
    std::vector<float> mono_chunk;
    std::vector<float> resampled_chunk;
    auto last_level_emit = std::chrono::steady_clock::now();

    auto drain_wasapi_packets = [&]() {
      UINT32 packet_len = 0;
      while (SUCCEEDED(capture_client->GetNextPacketSize(&packet_len)) && packet_len > 0) {
        BYTE* data = nullptr;
        UINT32 num_frames = 0;
        DWORD flags = 0;
        if (FAILED(capture_client->GetBuffer(&data, &num_frames, &flags, nullptr, nullptr))) {
          break;
        }
        mono_chunk.clear();
        mono_chunk.reserve(num_frames);

        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || !data) {
          mono_chunk.assign(num_frames, 0.0f);
        } else if (is_float && mix_fmt->wBitsPerSample == 32) {
          const float* fdata = reinterpret_cast<const float*>(data);
          for (UINT32 f = 0; f < num_frames; ++f) {
            double sum = 0.0;
            for (uint16_t c = 0; c < channels; ++c) {
              sum += fdata[f * channels + c];
            }
            mono_chunk.push_back(static_cast<float>(sum / channels));
          }
        } else if (mix_fmt->wBitsPerSample == 16) {
          const int16_t* sdata = reinterpret_cast<const int16_t*>(data);
          for (UINT32 f = 0; f < num_frames; ++f) {
            double sum = 0.0;
            for (uint16_t c = 0; c < channels; ++c) {
              sum += static_cast<double>(sdata[f * channels + c]) / 32768.0;
            }
            mono_chunk.push_back(static_cast<float>(sum / channels));
          }
        } else if (mix_fmt->wBitsPerSample == 32) {
          const int32_t* idata = reinterpret_cast<const int32_t*>(data);
          for (UINT32 f = 0; f < num_frames; ++f) {
            double sum = 0.0;
            for (uint16_t c = 0; c < channels; ++c) {
              sum += static_cast<double>(idata[f * channels + c]) / 2147483648.0;
            }
            mono_chunk.push_back(static_cast<float>(sum / channels));
          }
        }
        capture_client->ReleaseBuffer(num_frames);

        if (!mono_chunk.empty() && !aborted_.load()) {
          double sq_sum = 0.0;
          for (float v : mono_chunk) {
            sq_sum += static_cast<double>(v) * static_cast<double>(v);
          }
          const double rms = std::sqrt(sq_sum / mono_chunk.size());
          const auto now = std::chrono::steady_clock::now();
          if (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_level_emit).count() >= 90) {
            last_level_emit = now;
            const double normalized = std::min(1.0, rms * 4.0);
            char lvl_buf[64];
            std::snprintf(lvl_buf, sizeof(lvl_buf), "{\"type\":\"level\",\"value\":%.4f}", normalized);
            emit_json_line(lvl_buf);
          }

          if (in_rate == kTargetSampleRate) {
            pipeline_.push(mono_chunk);
          } else {
            resampled_chunk.clear();
            const double step = static_cast<double>(in_rate) / static_cast<double>(kTargetSampleRate);
            while (resample_pos + 1.0 < static_cast<double>(mono_chunk.size())) {
              const size_t idx0 = static_cast<size_t>(resample_pos);
              const double frac = resample_pos - static_cast<double>(idx0);
              const float s0 = mono_chunk[idx0];
              const float s1 = mono_chunk[idx0 + 1];
              resampled_chunk.push_back(static_cast<float>(s0 + (s1 - s0) * frac));
              resample_pos += step;
            }
            resample_pos -= static_cast<double>(mono_chunk.size());
            if (resample_pos < 0.0) resample_pos = 0.0;
            if (!resampled_chunk.empty()) {
              pipeline_.push(resampled_chunk);
            }
          }
        }
      }
    };

    HANDLE wait_handles[2] = {local_stop_event, capture_event};
    while (!stop_requested_.load()) {
      DWORD wait_res = WaitForMultipleObjects(2, wait_handles, FALSE, 100);
      if (wait_res == WAIT_OBJECT_0) {
        break;
      }
      drain_wasapi_packets();
    }

    if (!aborted_.load()) {
      drain_wasapi_packets();
    }
    pipeline_.mark_producer_finished();
    if (decode_thread.joinable()) {
      decode_thread.join();
    }
    cleanup();
  }

  Qwen3OnnxEngine& engine_;
  std::string device_uid_;
  std::vector<float> initial_samples_;
  SegmentedUtterancePipeline<
      std::function<std::string(const std::vector<float>&)>,
      std::function<void(const std::string&)>> pipeline_;
  std::mutex event_mu_;
  HANDLE stop_event_{nullptr};
  std::atomic<bool> stop_requested_{false};
  std::atomic<bool> aborted_{false};
  std::thread worker_;
};

int run_serve_command(const std::string& model_dir, const std::string& variant, const std::string& provider) {
  emit_json_line("{\"type\":\"loading\",\"variant\":\"" + json_escape(variant) + "\"}");
  Qwen3OnnxEngine engine;
  std::string init_err;
  if (!engine.init(model_dir, provider, init_err)) {
    emit_error("model_load_failed", "speech", init_err);
    return 1;
  }
  emit_json_line("{\"type\":\"ready\",\"variant\":\"" + json_escape(variant) +
                 "\",\"provider\":\"" + json_escape(engine.active_provider()) + "\"}");

  ServeCommandLoop loop(nullptr, nullptr);
  loop.set_hotword_factories(
      [&](const std::string& dev, std::vector<float> initial, std::vector<std::string> req_hotwords) {
        return std::make_unique<WasapiUtteranceCapture>(
            engine, dev, std::move(initial), merge_hotword_terms(engine.hotword_terms(), req_hotwords));
      },
      [&](std::vector<std::string> req_hotwords) {
        return std::make_unique<PcmUtteranceDecoder>(
            [&engine](const std::vector<float>& samples) { return engine.decode(samples); },
            [](const std::string& json_line) { emit_json_line(json_line); },
            kMaxSegmentSamples,
            kMaxFinalReDecodeSamples,
            merge_hotword_terms(engine.hotword_terms(), req_hotwords));
      });

  std::string line;
  while (std::getline(std::cin, line)) {
    if (!loop.handle_line(line)) {
      break;
    }
  }
  return 0;
}

int run_listen_command(const std::string& model_dir, const std::string& variant,
                       const std::string& provider, const std::string& device_uid) {
  emit_json_line("{\"type\":\"loading\",\"variant\":\"" + json_escape(variant) + "\"}");
  Qwen3OnnxEngine engine;
  std::string init_err;
  if (!engine.init(model_dir, provider, init_err)) {
    emit_error("model_load_failed", "speech", init_err);
    return 1;
  }
  auto capture = std::make_shared<WasapiUtteranceCapture>(engine, device_uid, std::vector<float>{}, engine.hotword_terms());
  capture->start();
  std::weak_ptr<WasapiUtteranceCapture> weak_capture = capture;
  std::thread([weak_capture]() {
    std::string line;
    while (std::getline(std::cin, line)) {
      while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
      auto cap = weak_capture.lock();
      if (!cap) return;
      if (line == "abort") {
        cap->request_stop(true);
        return;
      }
      if (line == "stop") {
        cap->request_stop(false);
      }
    }
    if (auto cap = weak_capture.lock()) {
      cap->request_stop(false);
    }
  }).detach();
  capture->wait_for_finish();
  return 0;
}

#else

int run_serve_command(const std::string&, const std::string&, const std::string&) {
  emit_error("sherpa_onnx_unavailable", "speech", "Built without sherpa-onnx C API support");
  return 1;
}

int run_listen_command(const std::string&, const std::string&, const std::string&, const std::string&) {
  emit_error("sherpa_onnx_unavailable", "speech", "Built without sherpa-onnx C API support");
  return 1;
}

#endif

// MARK: - Global Shift Single/Double-Tap Hook (WH_KEYBOARD_LL)

constexpr UINT WM_IMCODES_HOOK_EVENT = WM_APP + 101;
constexpr auto kShiftTapWindow = std::chrono::milliseconds(280);
constexpr auto kShiftMaxHold = std::chrono::milliseconds(600);
constexpr auto kShiftDebounce = std::chrono::milliseconds(250);

struct HookEventPayload {
  WPARAM wparam;
  DWORD vk_code;
  DWORD flags;
};

static DWORD g_detector_thread_id = 0;
static HHOOK g_keyboard_hook = nullptr;

LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
  if (nCode == HC_ACTION && lParam != 0) {
    const auto* kb = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lParam);
    const bool injected = (kb->flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) != 0;
    if (!injected && g_detector_thread_id != 0) {
      auto* payload = new HookEventPayload{wParam, kb->vkCode, kb->flags};
      if (!PostThreadMessageW(g_detector_thread_id, WM_IMCODES_HOOK_EVENT,
                              reinterpret_cast<WPARAM>(payload), 0)) {
        delete payload;
      }
    }
  }
  return CallNextHookEx(nullptr, nCode, wParam, lParam);
}

int run_hotkey_command() {
  struct DetectorState {
    bool shift_down{false};
    std::chrono::steady_clock::time_point shift_down_at{};
    bool other_key_pressed{false};
    std::optional<std::chrono::steady_clock::time_point> last_tap_up_at;
    bool second_tap_in_window{false};
    std::chrono::steady_clock::time_point last_double_emit{
        std::chrono::steady_clock::now() - std::chrono::seconds(10)};
    std::optional<std::chrono::steady_clock::time_point> pending_single_deadline;
  } state;

  std::atomic<bool> quit_flag{false};
  std::atomic<DWORD> hook_tid{0};
  std::thread hook_thread([&]() {
    hook_tid.store(GetCurrentThreadId());
    g_keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc, GetModuleHandleW(nullptr), 0);
    if (!g_keyboard_hook) {
      emit_error("hook_failed", "", "SetWindowsHookExW(WH_KEYBOARD_LL) failed");
      quit_flag.store(true);
      return;
    }
    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    if (g_keyboard_hook) {
      UnhookWindowsHookEx(g_keyboard_hook);
      g_keyboard_hook = nullptr;
    }
  });

  g_detector_thread_id = GetCurrentThreadId();
  // Ensure Windows creates a message queue for PostThreadMessageW before events arrive.
  MSG dummy{};
  PeekMessageW(&dummy, nullptr, WM_USER, WM_USER, PM_NOREMOVE);

  // Close monitor cleanly when parent closes stdin.
  std::thread stdin_watch([&]() {
    std::string tmp;
    while (std::getline(std::cin, tmp)) {
      if (tmp == "shutdown") break;
    }
    quit_flag.store(true);
    PostThreadMessageW(g_detector_thread_id, WM_QUIT, 0, 0);
  });
  stdin_watch.detach();

  auto is_shift_vk = [](DWORD vk) {
    return vk == VK_SHIFT || vk == VK_LSHIFT || vk == VK_RSHIFT;
  };
  auto is_key_down = [](WPARAM wp) {
    return wp == WM_KEYDOWN || wp == WM_SYSKEYDOWN;
  };
  auto is_key_up = [](WPARAM wp) {
    return wp == WM_KEYUP || wp == WM_SYSKEYUP;
  };
  auto other_modifiers_held = []() {
    const int mods[] = {VK_CONTROL, VK_LCONTROL, VK_RCONTROL, VK_MENU, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN};
    for (int vk : mods) {
      if ((GetAsyncKeyState(vk) & 0x8000) != 0) return true;
    }
    return false;
  };

  while (!quit_flag.load()) {
    DWORD wait_ms = INFINITE;
    if (state.pending_single_deadline.has_value()) {
      const auto now = std::chrono::steady_clock::now();
      if (now >= *state.pending_single_deadline) {
        state.pending_single_deadline.reset();
        state.last_tap_up_at.reset();
        state.second_tap_in_window = false;
        if (!state.shift_down) {
          emit_json_line("{\"type\":\"single_tap\"}");
        }
        continue;
      }
      auto diff = std::chrono::duration_cast<std::chrono::milliseconds>(*state.pending_single_deadline - now).count();
      wait_ms = static_cast<DWORD>(std::max<long long>(1, diff));
    }

    MsgWaitForMultipleObjects(0, nullptr, FALSE, wait_ms, QS_ALLINPUT);
    MSG msg{};
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_QUIT) {
        quit_flag.store(true);
        break;
      }
      if (msg.message != WM_IMCODES_HOOK_EVENT) continue;
      std::unique_ptr<HookEventPayload> ev(reinterpret_cast<HookEventPayload*>(msg.lParam));
      // Notice payload pointer was stored in WPARAM in LowLevelKeyboardProc:
      if (!ev) {
        ev.reset(reinterpret_cast<HookEventPayload*>(msg.wParam));
      }
      if (!ev) continue;

      const auto now = std::chrono::steady_clock::now();
      if (!is_shift_vk(ev->vk_code)) {
        state.pending_single_deadline.reset();
        if (state.shift_down || state.last_tap_up_at.has_value()) {
          state.other_key_pressed = true;
          state.last_tap_up_at.reset();
          state.second_tap_in_window = false;
        }
        continue;
      }

      if (other_modifiers_held()) {
        state.other_key_pressed = true;
        state.last_tap_up_at.reset();
        state.second_tap_in_window = false;
        state.pending_single_deadline.reset();
      }

      if (is_key_down(ev->wparam)) {
        if (!state.shift_down) {
          state.shift_down = true;
          state.shift_down_at = now;
          state.other_key_pressed = other_modifiers_held();
          if (!state.other_key_pressed && state.last_tap_up_at.has_value() &&
              (now - *state.last_tap_up_at) <= kShiftTapWindow) {
            state.second_tap_in_window = true;
          } else {
            state.second_tap_in_window = false;
            state.last_tap_up_at.reset();
          }
          state.pending_single_deadline.reset();
        }
      } else if (is_key_up(ev->wparam)) {
        if (state.shift_down) {
          state.shift_down = false;
          const auto held = now - state.shift_down_at;
          const bool clean_tap = !state.other_key_pressed && held <= kShiftMaxHold;
          const bool was_second = state.second_tap_in_window;
          state.other_key_pressed = false;
          state.second_tap_in_window = false;

          if (!clean_tap) {
            state.last_tap_up_at.reset();
            continue;
          }
          if (was_second) {
            state.last_tap_up_at.reset();
            if ((now - state.last_double_emit) >= kShiftDebounce) {
              state.last_double_emit = now;
              emit_json_line("{\"type\":\"double_tap\"}");
            }
            continue;
          }
          state.last_tap_up_at = now;
          state.pending_single_deadline = now + kShiftTapWindow;
        }
      }
    }
  }

  if (hook_thread.joinable()) {
    const DWORD tid = hook_tid.load();
    if (tid != 0) PostThreadMessageW(tid, WM_QUIT, 0, 0);
    hook_thread.join();
  }
  return 0;
}

// MARK: - Direct Unicode SendInput Paste

bool get_process_integrity_rid(HANDLE proc, DWORD& out_rid) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(proc, TOKEN_QUERY, &token) || !token) {
    return false;
  }
  DWORD len = 0;
  GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &len);
  if (len == 0) {
    CloseHandle(token);
    return false;
  }
  std::vector<BYTE> buf(len);
  bool ok = false;
  if (GetTokenInformation(token, TokenIntegrityLevel, buf.data(), len, &len)) {
    const auto* tml = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(buf.data());
    const UCHAR count = *GetSidSubAuthorityCount(tml->Label.Sid);
    out_rid = *GetSidSubAuthority(tml->Label.Sid, count - 1);
    ok = true;
  }
  CloseHandle(token);
  return ok;
}

bool is_foreground_window_uipi_blocked() {
  HWND fg = GetForegroundWindow();
  if (!fg) return false;
  DWORD fg_pid = 0;
  GetWindowThreadProcessId(fg, &fg_pid);
  if (fg_pid == 0 || fg_pid == GetCurrentProcessId()) return false;

  DWORD self_rid = SECURITY_MANDATORY_MEDIUM_RID;
  get_process_integrity_rid(GetCurrentProcess(), self_rid);

  HANDLE fg_proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, fg_pid);
  if (!fg_proc) {
    // Access denied when opening foreground process usually indicates higher privilege (e.g. elevated / Protected).
    return GetLastError() == ERROR_ACCESS_DENIED;
  }
  DWORD fg_rid = SECURITY_MANDATORY_MEDIUM_RID;
  const bool got_fg = get_process_integrity_rid(fg_proc, fg_rid);
  CloseHandle(fg_proc);
  if (!got_fg) return false;
  return fg_rid > self_rid;
}

void wait_for_modifiers_release() {
  const int vks[] = {
      VK_SHIFT, VK_LSHIFT, VK_RSHIFT,
      VK_CONTROL, VK_LCONTROL, VK_RCONTROL,
      VK_MENU, VK_LMENU, VK_RMENU,
  };
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);
  while (std::chrono::steady_clock::now() < deadline) {
    bool any_down = false;
    for (int vk : vks) {
      if ((GetAsyncKeyState(vk) & 0x8000) != 0) {
        any_down = true;
        break;
      }
    }
    if (!any_down) break;
    Sleep(10);
  }
}

void send_vk_return() {
  INPUT inputs[2]{};
  inputs[0].type = INPUT_KEYBOARD;
  inputs[0].ki.wVk = VK_RETURN;
  inputs[1].type = INPUT_KEYBOARD;
  inputs[1].ki.wVk = VK_RETURN;
  inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
  SendInput(2, inputs, sizeof(INPUT));
}

int run_paste_command(bool use_stdin, bool send_enter, const std::string& arg_text) {
  std::string text;
  if (use_stdin) {
    std::ostringstream ss;
    ss << std::cin.rdbuf();
    text = ss.str();
  } else {
    text = arg_text;
  }

  if (is_foreground_window_uipi_blocked()) {
    emit_error("uipi_elevated_target", "", "Foreground window is elevated (UIPI blocked SendInput)");
    return 2;
  }

  wait_for_modifiers_release();

  const std::wstring utf16 = utf8_to_wide(text);
  constexpr size_t kChunkUnits = 32;
  std::vector<INPUT> batch;
  batch.reserve(kChunkUnits * 2);

  auto flush_batch = [&]() {
    if (batch.empty()) return;
    SendInput(static_cast<UINT>(batch.size()), batch.data(), sizeof(INPUT));
    batch.clear();
  };

  for (size_t i = 0; i < utf16.size(); ++i) {
    wchar_t ch = utf16[i];
    if (ch == L'\r') {
      if (i + 1 < utf16.size() && utf16[i + 1] == L'\n') {
        ++i;
      }
      flush_batch();
      send_vk_return();
      continue;
    }
    if (ch == L'\n') {
      flush_batch();
      send_vk_return();
      continue;
    }
    INPUT down{};
    down.type = INPUT_KEYBOARD;
    down.ki.wScan = static_cast<WORD>(ch);
    down.ki.dwFlags = KEYEVENTF_UNICODE;
    INPUT up{};
    up.type = INPUT_KEYBOARD;
    up.ki.wScan = static_cast<WORD>(ch);
    up.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    batch.push_back(down);
    batch.push_back(up);
    if (batch.size() >= kChunkUnits * 2) {
      flush_batch();
      Sleep(5);
    }
  }
  flush_batch();

  if (send_enter) {
    Sleep(15);
    send_vk_return();
  }

  std::ostringstream oss;
  oss << "{\"type\":\"ok\",\"length\":" << utf16.size() << ",\"enter\":" << (send_enter ? "true" : "false") << "}";
  emit_json_line(oss.str());
  return 0;
}

}  // namespace

#ifndef IMCODES_SPEECH_WIN_NO_MAIN
int wmain(int argc, wchar_t* argv[]) {
  if (argc < 2) {
    emit_error("missing_command", "", "Usage: imcodes-speech-win <probe|status|devices|serve|listen|hotkey|paste>");
    return 1;
  }

  const std::string cmd = wide_to_utf8(argv[1]);
  if (cmd == "probe") return run_probe_command();
  if (cmd == "status") return run_status_command();
  if (cmd == "devices") return run_devices_command();
  if (cmd == "hotkey") return run_hotkey_command();

  if (cmd == "paste") {
    bool use_stdin = false;
    bool send_enter = false;
    std::string text_arg;
    for (int i = 2; i < argc; ++i) {
      const std::string a = wide_to_utf8(argv[i]);
      if (a == "--stdin") use_stdin = true;
      else if (a == "--enter") send_enter = true;
      else if (text_arg.empty()) text_arg = a;
    }
    return run_paste_command(use_stdin, send_enter, text_arg);
  }

  if (cmd == "serve" || cmd == "listen") {
    std::string model_dir;
    std::string variant = "0.6b";
    std::string provider = "auto";
    std::string device_uid = "auto";
    for (int i = 2; i < argc; ++i) {
      const std::string a = wide_to_utf8(argv[i]);
      if (a == "--model-dir" && i + 1 < argc) model_dir = wide_to_utf8(argv[++i]);
      else if (a == "--variant" && i + 1 < argc) variant = wide_to_utf8(argv[++i]);
      else if (a == "--provider" && i + 1 < argc) provider = wide_to_utf8(argv[++i]);
      else if (a == "--device" && i + 1 < argc) device_uid = wide_to_utf8(argv[++i]);
    }
    if (model_dir.empty()) {
      emit_error("missing_model_dir", "speech", "--model-dir is required");
      return 1;
    }
    return cmd == "serve"
        ? run_serve_command(model_dir, variant, provider)
        : run_listen_command(model_dir, variant, provider, device_uid);
  }

  emit_error("unknown_command", "", "Unknown command: " + cmd);
  return 1;
}
#endif
