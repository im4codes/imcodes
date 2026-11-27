#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <propsys.h>
#include <audioclient.h>
#include <avrt.h>
#include <dxgi.h>
#include <functiondiscoverykeys_devpkey.h>

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

std::optional<std::string> extract_json_string_field(const std::string& json_line, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  const size_t pos = json_line.find(needle);
  if (pos == std::string::npos) return std::nullopt;
  const size_t colon = json_line.find(':', pos + needle.size());
  if (colon == std::string::npos) return std::nullopt;
  const size_t q1 = json_line.find('"', colon + 1);
  if (q1 == std::string::npos) return std::nullopt;
  std::string out;
  for (size_t i = q1 + 1; i < json_line.size(); ++i) {
    char ch = json_line[i];
    if (ch == '\\' && i + 1 < json_line.size()) {
      out.push_back(json_line[++i]);
      continue;
    }
    if (ch == '"') {
      return out;
    }
    out.push_back(ch);
  }
  return std::nullopt;
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

// Conservative utterance silence gate: skips pure silence / faint noise floor before feeding
// ONNX Qwen3-ASR (with hotwords context), while keeping quiet speech (peak >= 0.015 or 50ms RMS >= 0.005).
bool has_utterance_speech_energy(const std::vector<float>& samples, int sample_rate = kTargetSampleRate) {
  const size_t count = samples.size();
  if (count == 0) return false;
  constexpr float kUtterancePeakThreshold = 0.015f;
  constexpr double kUtteranceWindowRmsThreshold = 0.005;
  constexpr double kRmsSqThreshold = kUtteranceWindowRmsThreshold * kUtteranceWindowRmsThreshold;
  const int rate = sample_rate > 0 ? sample_rate : kTargetSampleRate;
  const size_t window_samples = std::max<size_t>(1, static_cast<size_t>(std::llround(static_cast<double>(rate) * 0.05)));

  double window_sum_sq = 0.0;
  for (size_t i = 0; i < count; ++i) {
    const float s = samples[i];
    if (std::fabs(s) >= kUtterancePeakThreshold) return true;
    const double d = static_cast<double>(s);
    window_sum_sq += d * d;
    if (i >= window_samples) {
      const double old_d = static_cast<double>(samples[i - window_samples]);
      window_sum_sq -= old_d * old_d;
      if (window_sum_sq < 0.0) window_sum_sq = 0.0;
    }
    if (i + 1 >= window_samples && (window_sum_sq / static_cast<double>(window_samples)) >= kRmsSqThreshold) {
      return true;
    }
  }
  if (count < window_samples && (window_sum_sq / static_cast<double>(count)) >= kRmsSqThreshold) {
    return true;
  }
  return false;
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

template <typename DecodeFn, typename EmitFn>
class SegmentedUtterancePipeline {
 public:
  SegmentedUtterancePipeline(
      DecodeFn decode_fn,
      EmitFn emit_fn,
      size_t max_segment_samples = kMaxSegmentSamples,
      size_t max_final_redecode_samples = kMaxFinalReDecodeSamples)
      : decode_fn_(std::move(decode_fn)),
        emit_fn_(std::move(emit_fn)),
        max_segment_samples_(max_segment_samples),
        max_final_redecode_samples_(max_final_redecode_samples) {}

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
    std::string active_segment_text;
    std::string last_emitted_text;
    size_t last_decoded_len = 0;

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
        const bool segment_has_speech =
            !active_segment_text.empty() || has_utterance_speech_energy(segment_samples);
        const std::string seg_text = segment_has_speech
            ? strip_asr_control_tags(decode_fn_(segment_samples))
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
        if (!seg_text.empty()) {
          active_segment_text = seg_text;
        }
        const std::string& effective_seg = !seg_text.empty() ? seg_text : active_segment_text;
        const std::string combined = join_transcript_segments(committed_text, effective_seg);
        if (should_commit_segment) {
          if (!effective_seg.empty()) {
            committed_text = combined;
          }
          active_segment_text.clear();
          segment_samples.clear();
          last_decoded_len = 0;
          if (!can_finish_now && !combined.empty() && combined != last_emitted_text) {
            last_emitted_text = combined;
            emit_fn_("{\"type\":\"result\",\"text\":\"" + json_escape(combined) + "\",\"isFinal\":false}");
          }
          if (has_remaining_pending || (is_stop_requested && !can_finish_now)) {
            continue;
          }
        } else if (!seg_text.empty() && !combined.empty() && combined != last_emitted_text) {
          last_emitted_text = combined;
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
        const bool utterance_has_speech =
            !committed_text.empty() ||
            !active_segment_text.empty() ||
            has_utterance_speech_energy(utterance_samples);
        if (utterance_has_speech) {
          final_text = strip_asr_control_tags(decode_fn_(utterance_samples));
          std::vector<float>().swap(utterance_samples);
          {
            std::lock_guard<std::mutex> lock(mu_);
            final_aborted = aborted_;
          }
          if (final_aborted) {
            emit_fn_("{\"type\":\"end\"}");
            return;
          }
          if (final_text.empty()) {
            final_text = join_transcript_segments(committed_text, active_segment_text);
          }
        } else {
          std::vector<float>().swap(utterance_samples);
          final_text = join_transcript_segments(committed_text, active_segment_text);
        }
      } else {
        std::vector<float>().swap(utterance_samples);
        std::string final_seg = active_segment_text;
        if (segment_samples.size() >= 1600 &&
            (!active_segment_text.empty() || has_utterance_speech_energy(segment_samples))) {
          const std::string tail_text = strip_asr_control_tags(decode_fn_(segment_samples));
          {
            std::lock_guard<std::mutex> lock(mu_);
            final_aborted = aborted_;
          }
          if (final_aborted) {
            emit_fn_("{\"type\":\"end\"}");
            return;
          }
          if (!tail_text.empty()) {
            final_seg = tail_text;
          }
        }
        final_text = join_transcript_segments(committed_text, final_seg);
      }
      emit_fn_("{\"type\":\"result\",\"text\":\"" + json_escape(final_text) + "\",\"isFinal\":true}");
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
  std::mutex mu_;
  std::condition_variable cv_;
  std::vector<float> pending_samples_;
  size_t pending_head_{0};
  bool producer_finished_{false};
  bool stop_requested_{false};
  bool aborted_{false};
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

class WasapiUtteranceCapture {
 public:
  WasapiUtteranceCapture(
      Qwen3OnnxEngine& engine,
      std::string device_uid,
      std::vector<float> initial_samples = {})
      : engine_(engine),
        device_uid_(std::move(device_uid)),
        initial_samples_(std::move(initial_samples)),
        pipeline_(
            [this](const std::vector<float>& samples) { return engine_.decode(samples); },
            [](const std::string& line) { emit_json_line(line); }) {}

  ~WasapiUtteranceCapture() {
    stop(true);
  }

  void start() {
    worker_ = std::thread([this]() { run_loop(); });
  }

  void stop(bool abort_only) {
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
    if (worker_.joinable()) {
      worker_.join();
    }
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

class PcmUtteranceDecoder {
 public:
  explicit PcmUtteranceDecoder(Qwen3OnnxEngine& engine)
      : engine_(engine),
        pipeline_(
            [this](const std::vector<float>& samples) { return engine_.decode(samples); },
            [](const std::string& line) { emit_json_line(line); }) {}

  ~PcmUtteranceDecoder() {
    stop(true);
  }

  void start() {
    emit_json_line("{\"type\":\"start\"}");
    worker_ = std::thread([this]() { pipeline_.run_loop(); });
  }

  void push_pcm_base64(const std::string& b64) {
    const std::vector<float> samples = decode_base64_pcm16_samples(b64);
    if (samples.empty()) return;
    pipeline_.push(samples);
  }

  void stop(bool abort_only) {
    pipeline_.request_stop(abort_only, true);
    if (worker_.joinable()) {
      worker_.join();
    }
  }

 private:
  Qwen3OnnxEngine& engine_;
  SegmentedUtterancePipeline<
      std::function<std::string(const std::vector<float>&)>,
      std::function<void(const std::string&)>> pipeline_;
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

  std::unique_ptr<WasapiUtteranceCapture> active_mic;
  std::unique_ptr<PcmUtteranceDecoder> active_pcm;
  std::vector<float> prefilled_pcm;
  static constexpr size_t kMaxPrefillSamples = 16000 * 30;
  auto stop_active = [&](bool abort_only) {
    if (active_mic) {
      active_mic->stop(abort_only);
      active_mic.reset();
    }
    if (active_pcm) {
      active_pcm->stop(abort_only);
      active_pcm.reset();
    }
  };

  std::string line;
  while (std::getline(std::cin, line)) {
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
    if (line.empty()) continue;

    const auto cmd = extract_json_string_field(line, "cmd");
    if (!cmd.has_value()) continue;

    if (*cmd == "prefill_reset") {
      prefilled_pcm.clear();
    } else if (*cmd == "prefill_pcm") {
      const auto data = extract_json_string_field(line, "data");
      if (data.has_value()) {
        const std::vector<float> samples = decode_base64_pcm16_samples(*data);
        if (!samples.empty()) {
          prefilled_pcm.insert(prefilled_pcm.end(), samples.begin(), samples.end());
          if (prefilled_pcm.size() > kMaxPrefillSamples) {
            prefilled_pcm.erase(
                prefilled_pcm.begin(),
                prefilled_pcm.begin() + static_cast<std::ptrdiff_t>(prefilled_pcm.size() - kMaxPrefillSamples));
          }
        }
      }
    } else if (*cmd == "start") {
      stop_active(true);
      const std::string dev = extract_json_string_field(line, "device").value_or("auto");
      std::vector<float> initial = std::move(prefilled_pcm);
      prefilled_pcm.clear();
      active_mic = std::make_unique<WasapiUtteranceCapture>(engine, dev, std::move(initial));
      active_mic->start();
    } else if (*cmd == "start_pcm") {
      prefilled_pcm.clear();
      stop_active(true);
      active_pcm = std::make_unique<PcmUtteranceDecoder>(engine);
      active_pcm->start();
    } else if (*cmd == "pcm") {
      if (active_pcm) {
        const auto data = extract_json_string_field(line, "data");
        if (data.has_value()) {
          active_pcm->push_pcm_base64(*data);
        }
      }
    } else if (*cmd == "stop") {
      stop_active(false);
    } else if (*cmd == "abort") {
      prefilled_pcm.clear();
      stop_active(true);
    } else if (*cmd == "shutdown") {
      prefilled_pcm.clear();
      stop_active(true);
      break;
    }
  }
  stop_active(true);
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
  WasapiUtteranceCapture capture(engine, device_uid);
  capture.start();
  std::string line;
  bool abort_mode = false;
  while (std::getline(std::cin, line)) {
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
    if (line == "abort") {
      abort_mode = true;
      break;
    }
    if (line == "stop") {
      abort_mode = false;
      break;
    }
  }
  capture.stop(abort_mode);
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
