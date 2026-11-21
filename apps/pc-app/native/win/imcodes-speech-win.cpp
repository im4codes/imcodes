#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <audioclient.h>
#include <avrt.h>
#include <dxgi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <propsys.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
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
      << ",\"localAsrSupported\":true}";
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
      cfg.model_config.qwen3_asr.max_total_len = 512;
      cfg.model_config.qwen3_asr.max_new_tokens = 128;
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
    while (!text.empty() && (text.front() == ' ' || text.front() == '\t')) text.erase(text.begin());
    while (!text.empty() && (text.back() == ' ' || text.back() == '\t')) text.pop_back();
    return text;
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
  WasapiUtteranceCapture(Qwen3OnnxEngine& engine, std::string device_uid)
      : engine_(engine), device_uid_(std::move(device_uid)) {}

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
    if (stop_event_) {
      SetEvent(stop_event_);
    }
    if (worker_.joinable()) {
      worker_.join();
    }
  }

 private:
  void run_loop() {
    ScopedComInit com;
    stop_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HANDLE capture_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!stop_event_ || !capture_event) {
      if (stop_event_) CloseHandle(stop_event_);
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
      CloseHandle(stop_event_);
      stop_event_ = nullptr;
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

    std::vector<float> segment_samples;
    segment_samples.reserve(kMaxSegmentSamples + 16000);
    std::string committed_text;
    size_t last_decoded_len = 0;
    double resample_pos = 0.0;
    std::vector<float> mono_chunk;
    auto last_level_emit = std::chrono::steady_clock::now();

    HANDLE wait_handles[2] = {stop_event_, capture_event};
    while (!stop_requested_.load()) {
      DWORD wait_res = WaitForMultipleObjects(2, wait_handles, FALSE, 100);
      if (wait_res == WAIT_OBJECT_0) {
        break;
      }

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

        if (!mono_chunk.empty()) {
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
            segment_samples.insert(segment_samples.end(), mono_chunk.begin(), mono_chunk.end());
          } else {
            const double step = static_cast<double>(in_rate) / static_cast<double>(kTargetSampleRate);
            while (resample_pos + 1.0 < static_cast<double>(mono_chunk.size())) {
              const size_t idx0 = static_cast<size_t>(resample_pos);
              const double frac = resample_pos - static_cast<double>(idx0);
              const float s0 = mono_chunk[idx0];
              const float s1 = mono_chunk[idx0 + 1];
              segment_samples.push_back(static_cast<float>(s0 + (s1 - s0) * frac));
              resample_pos += step;
            }
            resample_pos -= static_cast<double>(mono_chunk.size());
            if (resample_pos < 0.0) resample_pos = 0.0;
          }
        }
      }

      if (!aborted_.load() && segment_samples.size() >= kInitialPartialSamples &&
          (segment_samples.size() - last_decoded_len >= kStepPartialSamples ||
           segment_samples.size() >= kMaxSegmentSamples)) {
        last_decoded_len = segment_samples.size();
        const std::string seg_text = engine_.decode(segment_samples);
        std::string combined = committed_text;
        if (!seg_text.empty()) {
          if (!combined.empty()) combined.push_back(' ');
          combined += seg_text;
        }
        if (!combined.empty()) {
          emit_json_line("{\"type\":\"result\",\"text\":\"" + json_escape(combined) + "\",\"isFinal\":false}");
        }
        if (segment_samples.size() >= kMaxSegmentSamples) {
          if (!seg_text.empty()) {
            committed_text = combined;
          }
          segment_samples.clear();
          last_decoded_len = 0;
        }
      }
    }

    cleanup();

    if (!aborted_.load()) {
      std::string final_text = committed_text;
      if (segment_samples.size() >= 1600) {
        const std::string tail_text = engine_.decode(segment_samples);
        if (!tail_text.empty()) {
          if (!final_text.empty()) final_text.push_back(' ');
          final_text += tail_text;
        }
      }
      emit_json_line("{\"type\":\"result\",\"text\":\"" + json_escape(final_text) + "\",\"isFinal\":true}");
    }
    emit_json_line("{\"type\":\"end\"}");
  }

  Qwen3OnnxEngine& engine_;
  std::string device_uid_;
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

  std::unique_ptr<WasapiUtteranceCapture> active;
  std::string line;
  while (std::getline(std::cin, line)) {
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
    if (line.empty()) continue;

    const auto cmd = extract_json_string_field(line, "cmd");
    if (!cmd.has_value()) continue;

    if (*cmd == "start") {
      if (active) {
        active->stop(true);
        active.reset();
      }
      const std::string dev = extract_json_string_field(line, "device").value_or("auto");
      active = std::make_unique<WasapiUtteranceCapture>(engine, dev);
      active->start();
    } else if (*cmd == "stop") {
      if (active) {
        active->stop(false);
        active.reset();
      }
    } else if (*cmd == "abort") {
      if (active) {
        active->stop(true);
        active.reset();
      }
    } else if (*cmd == "shutdown") {
      if (active) {
        active->stop(true);
        active.reset();
      }
      break;
    }
  }
  if (active) {
    active->stop(true);
    active.reset();
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
  std::thread hook_thread([&]() {
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
    DWORD hook_tid = GetThreadId(hook_thread.native_handle());
    if (hook_tid != 0) PostThreadMessageW(hook_tid, WM_QUIT, 0, 0);
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
