#include "qwen3_onnx_engine.hpp"
#include "speech_serve_common.hpp"
#include "streaming_pipeline.hpp"
#include "text_guards.hpp"

#include <dlfcn.h>
#include <unistd.h>
#if defined(IMCODES_HAS_ONNXRUNTIME) && defined(IMCODES_ORT_HAS_CUDA)
#include <onnxruntime_cxx_api.h>
#endif

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
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

using imcodes::speech::ActiveServeSessionHandle;
using imcodes::speech::emit_error;
using imcodes::speech::emit_json_line;
using imcodes::speech::emit_transcript_update;
using imcodes::speech::json_escape;
using imcodes::speech::load_hotwords_terms;
using imcodes::speech::make_streaming_pipeline_config;
using imcodes::speech::PcmUtteranceDecoder;
using imcodes::speech::ServeCommandLoop;
using imcodes::speech::ServeStartParams;
using imcodes::speech::to_lower_ascii;

constexpr int kTargetSampleRate = 16000;

struct GpuProbeInfo {
  bool ok{true};
  std::string gpu_name;
  uint64_t vram_mb{0};
  int adapter_index{-1};
  std::string provider{"cpu"};
  bool cuda_eligible{false};
};

// Runtime NVML + ORT CUDA shared-library probe with zero compile-time CUDA dependency.
GpuProbeInfo probe_best_gpu() {
  GpuProbeInfo result;
  void* nvml = ::dlopen("libnvidia-ml.so.1", RTLD_LAZY | RTLD_LOCAL);
  if (!nvml) {
    return result;
  }

  using nvmlReturn_t = int;
  using nvmlDevice_t = void*;
  struct nvmlMemory_t {
    unsigned long long total;
    unsigned long long free;
    unsigned long long used;
  };

  auto p_init = reinterpret_cast<nvmlReturn_t (*)()>(::dlsym(nvml, "nvmlInit_v2"));
  auto p_shutdown = reinterpret_cast<nvmlReturn_t (*)()>(::dlsym(nvml, "nvmlShutdown"));
  auto p_count = reinterpret_cast<nvmlReturn_t (*)(unsigned int*)>(::dlsym(nvml, "nvmlDeviceGetCount_v2"));
  auto p_handle = reinterpret_cast<nvmlReturn_t (*)(unsigned int, nvmlDevice_t*)>(
      ::dlsym(nvml, "nvmlDeviceGetHandleByIndex_v2"));
  auto p_name = reinterpret_cast<nvmlReturn_t (*)(nvmlDevice_t, char*, unsigned int)>(
      ::dlsym(nvml, "nvmlDeviceGetName"));
  auto p_mem = reinterpret_cast<nvmlReturn_t (*)(nvmlDevice_t, nvmlMemory_t*)>(
      ::dlsym(nvml, "nvmlDeviceGetMemoryInfo"));

  if (!p_init || !p_shutdown || !p_count || !p_handle || !p_name || !p_mem || p_init() != 0) {
    ::dlclose(nvml);
    return result;
  }

  unsigned int count = 0;
  uint64_t best_vram_bytes = 0;
  if (p_count(&count) == 0 && count > 0) {
    for (unsigned int i = 0; i < count; ++i) {
      nvmlDevice_t dev = nullptr;
      if (p_handle(i, &dev) != 0 || !dev) continue;
      char name_buf[128] = {};
      nvmlMemory_t mem{};
      p_name(dev, name_buf, sizeof(name_buf));
      if (p_mem(dev, &mem) == 0) {
        if (result.adapter_index < 0 || mem.total > best_vram_bytes) {
          best_vram_bytes = mem.total;
          result.adapter_index = static_cast<int>(i);
          result.gpu_name = name_buf;
        }
      }
    }
  }
  p_shutdown();
  ::dlclose(nvml);

  result.vram_mb = best_vram_bytes / (1024ULL * 1024ULL);

#if defined(IMCODES_HAS_ONNXRUNTIME) && defined(IMCODES_ORT_HAS_CUDA)
  if (result.adapter_index >= 0) {
    try {
      Ort::Env env(ORT_LOGGING_LEVEL_FATAL, "imcodes-cuda-probe");
      const OrtApi& api = Ort::GetApi();
      OrtCUDAProviderOptionsV2* cuda_opts = nullptr;
      if (OrtStatus* st = api.CreateCUDAProviderOptions(&cuda_opts)) {
        api.ReleaseStatus(st);
      } else if (cuda_opts) {
        Ort::SessionOptions so;
        if (OrtStatus* st2 = api.SessionOptionsAppendExecutionProvider_CUDA_V2(so, cuda_opts)) {
          api.ReleaseStatus(st2);
        } else {
          result.cuda_eligible = true;
          result.provider = "cuda";
        }
        api.ReleaseCUDAProviderOptions(cuda_opts);
      }
    } catch (...) {
      result.cuda_eligible = false;
      result.provider = "cpu";
    }
  }
#endif
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
      << ",\"cudaEligible\":" << (info.cuda_eligible ? "true" : "false")
#ifdef IMCODES_HAS_ONNXRUNTIME
      << ",\"localAsrSupported\":true}";
#else
      << ",\"localAsrSupported\":false}";
#endif
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

struct InputDeviceInfo {
  std::string uid;
  std::string name;
  std::string transport;
  bool is_default{false};
  bool is_physical{true};
};

std::string classify_transport(const std::string& name_lower, const std::string& uid_lower) {
  if (name_lower.find("bluetooth") != std::string::npos ||
      name_lower.find("bluez") != std::string::npos ||
      uid_lower.find("bluez") != std::string::npos) {
    return "bluetooth";
  }
  if (uid_lower == "pulse" || uid_lower == "pipewire" || uid_lower == "null" ||
      name_lower.find("virtual") != std::string::npos ||
      name_lower.find("null") != std::string::npos) {
    return "virtual";
  }
  if (name_lower.find("usb") != std::string::npos || uid_lower.find("usb") != std::string::npos) {
    return "usb";
  }
  if (name_lower.find("hda") != std::string::npos || name_lower.find("analog") != std::string::npos) {
    return "builtin";
  }
  return "other";
}

// Enumerate ALSA PCM capture devices at runtime without compile-time ALSA headers.
std::vector<InputDeviceInfo> enumerate_input_devices() {
  std::vector<InputDeviceInfo> devices;
  void* asound = ::dlopen("libasound.so.2", RTLD_LAZY | RTLD_LOCAL);
  if (!asound) return devices;

  auto p_hint = reinterpret_cast<int (*)(int, const char*, void***)>(
      ::dlsym(asound, "snd_device_name_hint"));
  auto p_get_hint = reinterpret_cast<char* (*)(const void*, const char*)>(
      ::dlsym(asound, "snd_device_name_get_hint"));
  auto p_free_hint = reinterpret_cast<int (*)(void**)>(
      ::dlsym(asound, "snd_device_name_free_hint"));
  if (!p_hint || !p_get_hint || !p_free_hint) {
    ::dlclose(asound);
    return devices;
  }

  void** hints = nullptr;
  if (p_hint(-1, "pcm", &hints) == 0 && hints) {
    for (void** n = hints; *n != nullptr; ++n) {
      char* ioid = p_get_hint(*n, "IOID");
      if (ioid && std::strcmp(ioid, "Output") == 0) {
        std::free(ioid);
        continue;
      }
      if (ioid) std::free(ioid);

      char* raw_name = p_get_hint(*n, "NAME");
      char* raw_desc = p_get_hint(*n, "DESC");
      std::string uid = raw_name ? raw_name : "";
      std::string desc = raw_desc ? raw_desc : uid;
      if (raw_name) std::free(raw_name);
      if (raw_desc) std::free(raw_desc);
      if (uid.empty() || uid == "null") continue;
      for (char& ch : desc) {
        if (ch == '\n' || ch == '\r') ch = ' ';
      }
      const std::string transport = classify_transport(to_lower_ascii(desc), to_lower_ascii(uid));
      const bool is_default = (uid == "default");
      const bool is_physical = (transport != "virtual" && transport != "bluetooth");
      devices.push_back(InputDeviceInfo{uid, desc, transport, is_default, is_physical});
    }
    p_free_hint(hints);
  }
  ::dlclose(asound);
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

#ifdef IMCODES_HAS_ONNXRUNTIME

class LinuxQwen3AsrRunner {
 public:
  bool init(const std::string& model_dir, const std::string& requested_provider, std::string& out_error) {
    const std::filesystem::path base(model_dir);
    base_hotwords_ = load_hotwords_terms(base / "hotwords.txt");

    imcodes::qwen3::EngineConfig cfg;
    cfg.model_dir = base;
    if (requested_provider == "cuda" || requested_provider == "cpu") {
      cfg.requested_provider = requested_provider;
    } else {
      const GpuProbeInfo gpu = probe_best_gpu();
      cfg.requested_provider = gpu.provider;
      if (gpu.adapter_index >= 0) {
        cfg.cuda_device_id = gpu.adapter_index;
      }
    }
    return engine_.init(cfg, out_error);
  }

  imcodes::qwen3::DecodeResult decode(
      const std::vector<float>& samples_16k,
      const imcodes::qwen3::DecodeOptions& opts) {
    return engine_.decode(samples_16k, opts);
  }

  const std::string& active_provider() const { return engine_.active_provider(); }
  const imcodes::qwen3::Qwen3Tokenizer& tokenizer() const { return engine_.tokenizer(); }
  const std::vector<std::string>& base_hotwords() const { return base_hotwords_; }

 private:
  imcodes::qwen3::Qwen3OnnxEngine engine_;
  std::vector<std::string> base_hotwords_;
};

// Runtime PulseAudio (`libpulse-simple.so.0`) + ALSA (`libasound.so.2`) 16kHz mono reader via `dlopen`.
class LinuxAudioSource {
 public:
  ~LinuxAudioSource() { close(); }

  bool open(const std::string& device_uid, std::string& out_error) {
    // 1. Try PulseAudio / PipeWire-Pulse first (matches desktop user sessions)
    if (open_pulse(device_uid)) {
      return true;
    }
    // 2. Fall back to ALSA PCM
    if (open_alsa(device_uid, out_error)) {
      return true;
    }
    if (out_error.empty()) {
      out_error = "No PulseAudio or ALSA microphone capture device available";
    }
    return false;
  }

  // Returns sample count read (>0), 0 on transient wait, or <0 on fatal error.
  int read_16k_mono(std::vector<int16_t>& out_buf) {
    if (pa_conn_) {
      int pa_err = 0;
      const size_t bytes = out_buf.size() * sizeof(int16_t);
      if (pa_read_(pa_conn_, out_buf.data(), bytes, &pa_err) < 0) {
        return -1;
      }
      return static_cast<int>(out_buf.size());
    }
    if (alsa_pcm_) {
      const long frames = snd_readi_(alsa_pcm_, out_buf.data(), static_cast<unsigned long>(out_buf.size()));
      if (frames < 0) {
        if (snd_recover_(alsa_pcm_, static_cast<int>(frames), 1) < 0) {
          return -1;
        }
        return 0;
      }
      return static_cast<int>(frames);
    }
    return -1;
  }

  void close() {
    if (pa_conn_ && pa_free_) {
      pa_free_(pa_conn_);
      pa_conn_ = nullptr;
    }
    if (pa_lib_) {
      ::dlclose(pa_lib_);
      pa_lib_ = nullptr;
    }
    if (alsa_pcm_ && snd_close_) {
      snd_close_(alsa_pcm_);
      alsa_pcm_ = nullptr;
    }
    if (alsa_lib_) {
      ::dlclose(alsa_lib_);
      alsa_lib_ = nullptr;
    }
  }

 private:
  struct PaSampleSpec {
    int32_t format;
    uint32_t rate;
    uint8_t channels;
  };
  struct PaBufferAttr {
    uint32_t maxlength;
    uint32_t tlength;
    uint32_t prebuf;
    uint32_t minreq;
    uint32_t fragsize;
  };

  bool open_pulse(const std::string& device_uid) {
    pa_lib_ = ::dlopen("libpulse-simple.so.0", RTLD_LAZY | RTLD_LOCAL);
    if (!pa_lib_) return false;
    auto pa_new = reinterpret_cast<void* (*)(
        const char*, const char*, int, const char*, const char*,
        const PaSampleSpec*, const void*, const PaBufferAttr*, int*)>(
        ::dlsym(pa_lib_, "pa_simple_new"));
    pa_read_ = reinterpret_cast<int (*)(void*, void*, size_t, int*)>(
        ::dlsym(pa_lib_, "pa_simple_read"));
    pa_free_ = reinterpret_cast<void (*)(void*)>(
        ::dlsym(pa_lib_, "pa_simple_free"));
    if (!pa_new || !pa_read_ || !pa_free_) {
      close();
      return false;
    }

    const PaSampleSpec ss{3 /*PA_SAMPLE_S16LE*/, static_cast<uint32_t>(kTargetSampleRate), 1};
    const PaBufferAttr attr{
        static_cast<uint32_t>(-1),
        static_cast<uint32_t>(-1),
        static_cast<uint32_t>(-1),
        static_cast<uint32_t>(-1),
        3200 /* 100ms @ 16kHz S16LE */
    };
    const char* dev = (device_uid.empty() || device_uid == "auto" || device_uid == "default")
        ? nullptr
        : device_uid.c_str();
    int err = 0;
    pa_conn_ = pa_new(nullptr, "imcodes-speech", 2 /*PA_STREAM_RECORD*/, dev, "voice", &ss, nullptr, &attr, &err);
    if (!pa_conn_) {
      close();
      return false;
    }
    return true;
  }

  bool open_alsa(const std::string& device_uid, std::string& out_error) {
    alsa_lib_ = ::dlopen("libasound.so.2", RTLD_LAZY | RTLD_LOCAL);
    if (!alsa_lib_) return false;
    auto snd_open = reinterpret_cast<int (*)(void**, const char*, int, int)>(
        ::dlsym(alsa_lib_, "snd_pcm_open"));
    auto snd_set_params = reinterpret_cast<int (*)(void*, int, int, unsigned int, unsigned int, int, unsigned int)>(
        ::dlsym(alsa_lib_, "snd_pcm_set_params"));
    snd_readi_ = reinterpret_cast<long (*)(void*, void*, unsigned long)>(
        ::dlsym(alsa_lib_, "snd_pcm_readi"));
    snd_recover_ = reinterpret_cast<int (*)(void*, int, int)>(
        ::dlsym(alsa_lib_, "snd_pcm_recover"));
    snd_close_ = reinterpret_cast<int (*)(void*)>(
        ::dlsym(alsa_lib_, "snd_pcm_close"));
    if (!snd_open || !snd_set_params || !snd_readi_ || !snd_recover_ || !snd_close_) {
      close();
      return false;
    }

    const char* dev = (device_uid.empty() || device_uid == "auto") ? "default" : device_uid.c_str();
    if (snd_open(&alsa_pcm_, dev, 1 /*SND_PCM_STREAM_CAPTURE*/, 0) < 0 || !alsa_pcm_) {
      alsa_pcm_ = nullptr;
      out_error = "No active ALSA/PulseAudio microphone found";
      close();
      return false;
    }
    // SND_PCM_FORMAT_S16_LE = 2, SND_PCM_ACCESS_RW_INTERLEAVED = 3
    if (snd_set_params(alsa_pcm_, 2, 3, 1, static_cast<unsigned int>(kTargetSampleRate), 1, 100000) < 0) {
      out_error = "Failed to configure ALSA 16kHz mono capture parameters";
      close();
      return false;
    }
    return true;
  }

  void* pa_lib_{nullptr};
  void* pa_conn_{nullptr};
  int (*pa_read_)(void*, void*, size_t, int*){nullptr};
  void (*pa_free_)(void*){nullptr};

  void* alsa_lib_{nullptr};
  void* alsa_pcm_{nullptr};
  long (*snd_readi_)(void*, void*, unsigned long){nullptr};
  int (*snd_recover_)(void*, int, int){nullptr};
  int (*snd_close_)(void*){nullptr};
};

class LinuxAudioCapture : public ActiveServeSessionHandle {
 public:
  LinuxAudioCapture(LinuxQwen3AsrRunner& runner, ServeStartParams params)
      : device_uid_(std::move(params.device)),
        initial_samples_(std::move(params.initial_samples)),
        pipeline_(
            make_streaming_pipeline_config(runner.base_hotwords(), params),
            runner.tokenizer(),
            [&runner](const std::vector<float>& samples, const imcodes::qwen3::DecodeOptions& opts) {
              return runner.decode(samples, opts);
            },
            [](const imcodes::qwen3::TranscriptUpdate& upd) {
              emit_transcript_update([](const std::string& line) { emit_json_line(line); }, upd);
            },
            []() {
              emit_json_line("{\"type\":\"end\"}");
            }) {}

  ~LinuxAudioCapture() override {
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
    LinuxAudioSource audio;
    std::string audio_err;
    if (!audio.open(device_uid_, audio_err)) {
      emit_error("no_input_device", "mic", audio_err);
      emit_json_line("{\"type\":\"end\"}");
      return;
    }

    pipeline_.preload(initial_samples_);
    std::vector<float>().swap(initial_samples_);
    std::thread decode_thread([this]() { pipeline_.run_loop(); });

    emit_json_line("{\"type\":\"start\"}");

    std::vector<int16_t> s16_buf(1600, 0);  // 100ms @ 16kHz
    std::vector<float> f32_buf;
    f32_buf.reserve(s16_buf.size());
    auto last_level_emit = std::chrono::steady_clock::now();

    while (!stop_requested_.load() && !aborted_.load()) {
      const int frames = audio.read_16k_mono(s16_buf);
      if (frames < 0) {
        break;
      }
      if (frames == 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        continue;
      }
      f32_buf.clear();
      double sq_sum = 0.0;
      for (int i = 0; i < frames; ++i) {
        const float sample = static_cast<float>(s16_buf[static_cast<size_t>(i)]) / 32768.0f;
        f32_buf.push_back(sample);
        sq_sum += static_cast<double>(sample) * static_cast<double>(sample);
      }
      const double rms = std::sqrt(sq_sum / static_cast<double>(frames));
      const auto now = std::chrono::steady_clock::now();
      if (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_level_emit).count() >= 90) {
        last_level_emit = now;
        const double normalized = std::min(1.0, rms * 4.0);
        char lvl_buf[64];
        std::snprintf(lvl_buf, sizeof(lvl_buf), "{\"type\":\"level\",\"value\":%.4f}", normalized);
        emit_json_line(lvl_buf);
      }
      if (!aborted_.load()) {
        pipeline_.push_samples(f32_buf);
      }
    }

    audio.close();
    pipeline_.mark_producer_finished();
    if (decode_thread.joinable()) {
      decode_thread.join();
    }
  }

  std::string device_uid_;
  std::vector<float> initial_samples_;
  imcodes::qwen3::Qwen3StreamingPipeline pipeline_;
  std::atomic<bool> stop_requested_{false};
  std::atomic<bool> aborted_{false};
  std::thread worker_;
};

int run_serve_command(const std::string& model_dir, const std::string& variant, const std::string& provider) {
  emit_json_line("{\"type\":\"loading\",\"variant\":\"" + json_escape(variant) + "\"}");
  LinuxQwen3AsrRunner runner;
  std::string init_err;
  if (!runner.init(model_dir, provider, init_err)) {
    emit_error("model_load_failed", "speech", init_err);
    return 1;
  }
  emit_json_line("{\"type\":\"ready\",\"variant\":\"" + json_escape(variant) +
                 "\",\"provider\":\"" + json_escape(runner.active_provider()) + "\"}");

  ServeCommandLoop loop(
      [&runner](ServeStartParams params) {
        return std::make_unique<LinuxAudioCapture>(runner, std::move(params));
      },
      [&runner](ServeStartParams params) {
        return std::make_unique<PcmUtteranceDecoder>(
            make_streaming_pipeline_config(runner.base_hotwords(), params),
            runner.tokenizer(),
            [&runner](const std::vector<float>& samples, const imcodes::qwen3::DecodeOptions& opts) {
              return runner.decode(samples, opts);
            },
            [](const std::string& json_line) { emit_json_line(json_line); });
      });

  std::string line;
  while (std::getline(std::cin, line)) {
    if (!loop.handle_line(line)) {
      break;
    }
  }
  return 0;
}

int run_listen_command(
    const std::string& model_dir,
    const std::string& variant,
    const std::string& provider,
    const std::string& device_uid,
    const std::string& locale,
    const std::string& hotwords_csv) {
  emit_json_line("{\"type\":\"loading\",\"variant\":\"" + json_escape(variant) + "\"}");
  LinuxQwen3AsrRunner runner;
  std::string init_err;
  if (!runner.init(model_dir, provider, init_err)) {
    emit_error("model_load_failed", "speech", init_err);
    return 1;
  }
  ServeStartParams params;
  params.device = device_uid;
  params.locale = locale;
  if (!hotwords_csv.empty()) {
    params.hotwords = imcodes::qwen3::merge_session_hotwords_raw({}, hotwords_csv).terms;
  }
  auto capture = std::make_shared<LinuxAudioCapture>(runner, std::move(params));
  capture->start();
  std::weak_ptr<LinuxAudioCapture> weak_capture = capture;
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
  emit_error("onnxruntime_unavailable", "speech", "Built without ONNX Runtime support");
  return 1;
}

int run_listen_command(
    const std::string&,
    const std::string&,
    const std::string&,
    const std::string&,
    const std::string&,
    const std::string&) {
  emit_error("onnxruntime_unavailable", "speech", "Built without ONNX Runtime support");
  return 1;
}

#endif

}  // namespace

int main(int argc, char* argv[]) {
  if (argc < 2) {
    emit_error("missing_command", "", "Usage: imcodes-speech-linux <probe|status|devices|serve|listen>");
    return 1;
  }

  const std::string cmd = argv[1];
  if (cmd == "probe") return run_probe_command();
  if (cmd == "status") return run_status_command();
  if (cmd == "devices") return run_devices_command();

  if (cmd == "serve" || cmd == "listen") {
    std::string model_dir;
    std::string variant = "0.6b";
    std::string provider = "auto";
    std::string device_uid = "auto";
    std::string locale;
    std::string hotwords;
    for (int i = 2; i < argc; ++i) {
      const std::string a = argv[i];
      if (a == "--model-dir" && i + 1 < argc) model_dir = argv[++i];
      else if (a == "--variant" && i + 1 < argc) variant = argv[++i];
      else if (a == "--provider" && i + 1 < argc) provider = argv[++i];
      else if (a == "--device" && i + 1 < argc) device_uid = argv[++i];
      else if (a == "--locale" && i + 1 < argc) locale = argv[++i];
      else if (a == "--hotwords" && i + 1 < argc) hotwords = argv[++i];
    }
    if (model_dir.empty()) {
      emit_error("missing_model_dir", "speech", "--model-dir is required");
      return 1;
    }
    return cmd == "serve"
        ? run_serve_command(model_dir, variant, provider)
        : run_listen_command(model_dir, variant, provider, device_uid, locale, hotwords);
  }

  emit_error("unknown_command", "", "Unknown command: " + cmd);
  return 1;
}
