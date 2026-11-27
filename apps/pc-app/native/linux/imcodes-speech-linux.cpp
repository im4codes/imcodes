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
#include <cstdlib>
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
using imcodes::speech::parse_cli_hotwords_arg;
using imcodes::speech::PcmUtteranceDecoder;
using imcodes::speech::ServeCommandLoop;
using imcodes::speech::ServeStartParams;
using imcodes::speech::to_lower_ascii;

constexpr int kTargetSampleRate = 16000;
constexpr uint32_t kPaInvalidIndex = 0xFFFFFFFFu;
constexpr int kPaSampleS16Le = 3;
constexpr int kPaContextFlagNoAutospawn = 0x0001;
constexpr int kPaContextReady = 4;
constexpr int kPaContextFailed = 5;
constexpr int kPaContextTerminated = 6;
constexpr int kPaStreamReady = 2;
constexpr int kPaStreamFailed = 3;
constexpr int kPaStreamTerminated = 4;
constexpr int kPaStreamDontMove = 0x0200;
constexpr int kPaStreamAdjustLatency = 0x2000;
constexpr int kPaOperationRunning = 0;

struct GpuProbeInfo {
  bool ok{true};
  std::string gpu_name;
  uint64_t vram_mb{0};
  int adapter_index{-1};  // CUDA visible device index when libcuda is available
  std::string provider{"cpu"};
  bool cuda_eligible{false};
};

// Enumerate CUDA-visible GPUs via libcuda.so.1 so adapter_index matches OrtCUDAProviderOptions::device_id
// even with CUDA_VISIBLE_DEVICES or CUDA_DEVICE_ORDER=FASTEST_FIRST; fall back to NVML only for advisory metadata.
GpuProbeInfo probe_best_gpu() {
  GpuProbeInfo result;
  bool used_libcuda = false;

  if (void* cuda_lib = ::dlopen("libcuda.so.1", RTLD_LAZY | RTLD_LOCAL)) {
    using CUresult = int;
    using CUdevice = int;
    auto cu_init = reinterpret_cast<CUresult (*)(unsigned int)>(::dlsym(cuda_lib, "cuInit"));
    auto cu_count = reinterpret_cast<CUresult (*)(int*)>(::dlsym(cuda_lib, "cuDeviceGetCount"));
    auto cu_get = reinterpret_cast<CUresult (*)(CUdevice*, int)>(::dlsym(cuda_lib, "cuDeviceGet"));
    auto cu_name = reinterpret_cast<CUresult (*)(char*, int, CUdevice)>(::dlsym(cuda_lib, "cuDeviceGetName"));
    auto cu_mem = reinterpret_cast<CUresult (*)(size_t*, CUdevice)>(::dlsym(cuda_lib, "cuDeviceTotalMem_v2"));
    if (!cu_mem) {
      cu_mem = reinterpret_cast<CUresult (*)(size_t*, CUdevice)>(::dlsym(cuda_lib, "cuDeviceTotalMem"));
    }

    if (cu_init && cu_count && cu_get && cu_name && cu_mem && cu_init(0) == 0) {
      int count = 0;
      if (cu_count(&count) == 0 && count > 0) {
        used_libcuda = true;
        uint64_t best_vram_bytes = 0;
        for (int i = 0; i < count; ++i) {
          CUdevice dev = 0;
          if (cu_get(&dev, i) != 0) continue;
          char name_buf[128] = {};
          cu_name(name_buf, static_cast<int>(sizeof(name_buf)), dev);
          size_t mem_bytes = 0;
          if (cu_mem(&mem_bytes, dev) == 0) {
            if (result.adapter_index < 0 || static_cast<uint64_t>(mem_bytes) > best_vram_bytes) {
              best_vram_bytes = static_cast<uint64_t>(mem_bytes);
              result.adapter_index = i;
              result.gpu_name = name_buf;
            }
          }
        }
        result.vram_mb = best_vram_bytes / (1024ULL * 1024ULL);
      }
    }
    ::dlclose(cuda_lib);
  }

  if (!used_libcuda) {
    void* nvml = ::dlopen("libnvidia-ml.so.1", RTLD_LAZY | RTLD_LOCAL);
    if (!nvml) return result;
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
    if (p_init && p_shutdown && p_count && p_handle && p_name && p_mem && p_init() == 0) {
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
      result.vram_mb = best_vram_bytes / (1024ULL * 1024ULL);
    }
    ::dlclose(nvml);
    return result;
  }

#if defined(IMCODES_HAS_ONNXRUNTIME) && defined(IMCODES_ORT_HAS_CUDA)
  if (used_libcuda && result.adapter_index >= 0) {
    try {
      Ort::Env env(ORT_LOGGING_LEVEL_FATAL, "imcodes-cuda-probe");
      const OrtApi& api = Ort::GetApi();
      OrtCUDAProviderOptionsV2* cuda_opts = nullptr;
      if (OrtStatus* st = api.CreateCUDAProviderOptions(&cuda_opts)) {
        api.ReleaseStatus(st);
      } else if (cuda_opts) {
        const std::string dev_id_str = std::to_string(result.adapter_index);
        const char* keys[] = {"device_id"};
        const char* vals[] = {dev_id_str.c_str()};
        OrtStatus* st_upd = api.UpdateCUDAProviderOptions(cuda_opts, keys, vals, 1);
        if (st_upd) {
          api.ReleaseStatus(st_upd);
        } else {
          Ort::SessionOptions so;
          if (OrtStatus* st_app = api.SessionOptionsAppendExecutionProvider_CUDA_V2(so, cuda_opts)) {
            api.ReleaseStatus(st_app);
          } else {
            result.cuda_eligible = true;
            result.provider = "cuda";
          }
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
      uid_lower.find("pipe") != std::string::npos ||
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

struct PaSampleSpec {
  int32_t format;
  uint32_t rate;
  uint8_t channels;
};

struct PaChannelMap {
  uint8_t channels;
  int32_t map[32];
};

struct PaCVolume {
  uint8_t channels;
  uint32_t values[32];
};

struct PaBufferAttr {
  uint32_t maxlength;
  uint32_t tlength;
  uint32_t prebuf;
  uint32_t minreq;
  uint32_t fragsize;
};

struct PaServerInfo {
  const char* user_name;
  const char* host_name;
  const char* server_version;
  const char* server_name;
  PaSampleSpec sample_spec;
  const char* default_sink_name;
  const char* default_source_name;
};

struct PaSourceInfo {
  const char* name;
  uint32_t index;
  const char* description;
  PaSampleSpec sample_spec;
  PaChannelMap channel_map;
  uint32_t owner_module;
  PaCVolume volume;
  int mute;
  uint32_t monitor_of_sink;
  const char* monitor_of_sink_name;
};

struct PaEnumState {
  std::string default_source_name;
  bool server_info_done{false};
  bool sources_done{false};
  std::vector<InputDeviceInfo> sources;
};

void pa_server_info_cb(void*, const PaServerInfo* i, void* userdata) {
  auto* state = static_cast<PaEnumState*>(userdata);
  if (i && i->default_source_name) {
    state->default_source_name = i->default_source_name;
  }
  state->server_info_done = true;
}

void pa_source_info_cb(void*, const PaSourceInfo* i, int eol, void* userdata) {
  auto* state = static_cast<PaEnumState*>(userdata);
  if (eol != 0 || !i) {
    state->sources_done = true;
    return;
  }
  // Skip output-sink monitor sources from microphone picker.
  if (i->monitor_of_sink != kPaInvalidIndex || !i->name || !i->name[0]) {
    return;
  }
  const std::string raw_name = i->name;
  const std::string desc = (i->description && i->description[0]) ? i->description : raw_name;
  const std::string transport = classify_transport(to_lower_ascii(desc), to_lower_ascii(raw_name));
  const bool is_physical = (transport != "virtual" && transport != "bluetooth");
  InputDeviceInfo dev;
  dev.uid = "pulse:" + raw_name;
  dev.name = desc;
  dev.transport = transport;
  dev.is_physical = is_physical;
  state->sources.push_back(std::move(dev));
}

bool enumerate_pulse_input_devices(std::vector<InputDeviceInfo>& out_devices) {
  void* lib = ::dlopen("libpulse.so.0", RTLD_LAZY | RTLD_LOCAL);
  if (!lib) return false;

  auto ml_new = reinterpret_cast<void* (*)()>(::dlsym(lib, "pa_mainloop_new"));
  auto ml_free = reinterpret_cast<void (*)(void*)>(::dlsym(lib, "pa_mainloop_free"));
  auto ml_get_api = reinterpret_cast<void* (*)(void*)>(::dlsym(lib, "pa_mainloop_get_api"));
  auto ml_prepare = reinterpret_cast<int (*)(void*, int)>(::dlsym(lib, "pa_mainloop_prepare"));
  auto ml_poll = reinterpret_cast<int (*)(void*)>(::dlsym(lib, "pa_mainloop_poll"));
  auto ml_dispatch = reinterpret_cast<int (*)(void*)>(::dlsym(lib, "pa_mainloop_dispatch"));
  auto ctx_new = reinterpret_cast<void* (*)(void*, const char*)>(::dlsym(lib, "pa_context_new"));
  auto ctx_unref = reinterpret_cast<void (*)(void*)>(::dlsym(lib, "pa_context_unref"));
  auto ctx_connect = reinterpret_cast<int (*)(void*, const char*, int, const void*)>(
      ::dlsym(lib, "pa_context_connect"));
  auto ctx_disconnect = reinterpret_cast<void (*)(void*)>(::dlsym(lib, "pa_context_disconnect"));
  auto ctx_get_state = reinterpret_cast<int (*)(void*)>(::dlsym(lib, "pa_context_get_state"));
  auto ctx_get_server = reinterpret_cast<void* (*)(void*, void (*)(void*, const PaServerInfo*, void*), void*)>(
      ::dlsym(lib, "pa_context_get_server_info"));
  auto ctx_get_sources = reinterpret_cast<void* (*)(void*, void (*)(void*, const PaSourceInfo*, int, void*), void*)>(
      ::dlsym(lib, "pa_context_get_source_info_list"));
  auto op_get_state = reinterpret_cast<int (*)(void*)>(::dlsym(lib, "pa_operation_get_state"));
  auto op_unref = reinterpret_cast<void (*)(void*)>(::dlsym(lib, "pa_operation_unref"));

  if (!ml_new || !ml_free || !ml_get_api || !ml_prepare || !ml_poll || !ml_dispatch ||
      !ctx_new || !ctx_unref || !ctx_connect || !ctx_disconnect || !ctx_get_state ||
      !ctx_get_server || !ctx_get_sources || !op_get_state || !op_unref) {
    ::dlclose(lib);
    return false;
  }

  void* ml = ml_new();
  if (!ml) {
    ::dlclose(lib);
    return false;
  }
  void* ctx = ctx_new(ml_get_api(ml), "imcodes-speech-devices");
  if (!ctx) {
    ml_free(ml);
    ::dlclose(lib);
    return false;
  }

  bool ok = false;
  if (ctx_connect(ctx, nullptr, kPaContextFlagNoAutospawn, nullptr) >= 0) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2000);
    while (std::chrono::steady_clock::now() < deadline) {
      const int st = ctx_get_state(ctx);
      if (st == kPaContextReady) {
        ok = true;
        break;
      }
      if (st == kPaContextFailed || st == kPaContextTerminated) {
        break;
      }
      if (ml_prepare(ml, 20000) < 0 || ml_poll(ml) < 0 || ml_dispatch(ml) < 0) {
        break;
      }
    }
  }

  PaEnumState state;
  if (ok) {
    void* srv_op = ctx_get_server(ctx, pa_server_info_cb, &state);
    if (srv_op) {
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);
      while (!state.server_info_done &&
             op_get_state(srv_op) == kPaOperationRunning &&
             std::chrono::steady_clock::now() < deadline) {
        if (ml_prepare(ml, 20000) < 0 || ml_poll(ml) < 0 || ml_dispatch(ml) < 0) break;
      }
      op_unref(srv_op);
    }

    void* src_op = ctx_get_sources(ctx, pa_source_info_cb, &state);
    if (src_op) {
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);
      while (!state.sources_done &&
             op_get_state(src_op) == kPaOperationRunning &&
             std::chrono::steady_clock::now() < deadline) {
        if (ml_prepare(ml, 20000) < 0 || ml_poll(ml) < 0 || ml_dispatch(ml) < 0) break;
      }
      op_unref(src_op);
    }
  }

  ctx_disconnect(ctx);
  ctx_unref(ctx);
  ml_free(ml);
  ::dlclose(lib);

  if (!ok || state.sources.empty()) {
    return false;
  }
  for (auto& src : state.sources) {
    const std::string bare = src.uid.substr(6);  // strip "pulse:"
    src.is_default = (!state.default_source_name.empty() && bare == state.default_source_name);
    out_devices.push_back(std::move(src));
  }
  return true;
}

std::vector<InputDeviceInfo> enumerate_alsa_input_devices() {
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
      devices.push_back(InputDeviceInfo{"alsa:" + uid, desc, transport, is_default, is_physical});
    }
    p_free_hint(hints);
  }
  ::dlclose(asound);
  return devices;
}

std::vector<InputDeviceInfo> enumerate_input_devices() {
  std::vector<InputDeviceInfo> devices;
  if (enumerate_pulse_input_devices(devices) && !devices.empty()) {
    return devices;
  }
  return enumerate_alsa_input_devices();
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
  bool init(
      const std::string& model_dir,
      const std::string& requested_provider,
      int requested_device_id,
      std::string& out_error) {
    const std::filesystem::path base(model_dir);
    base_hotwords_ = load_hotwords_terms(base / "hotwords.txt");

    imcodes::qwen3::EngineConfig cfg;
    cfg.model_dir = base;
    if (requested_provider == "cpu") {
      cfg.requested_provider = "cpu";
    } else if (requested_provider == "cuda") {
      cfg.requested_provider = "cuda";
      if (requested_device_id >= 0) {
        cfg.cuda_device_id = requested_device_id;
      } else {
        const GpuProbeInfo gpu = probe_best_gpu();
        if (gpu.adapter_index >= 0) {
          cfg.cuda_device_id = gpu.adapter_index;
        }
      }
    } else {
      const GpuProbeInfo gpu = probe_best_gpu();
      cfg.requested_provider = gpu.provider;
      if (requested_device_id >= 0) {
        cfg.cuda_device_id = requested_device_id;
      } else if (gpu.adapter_index >= 0) {
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

bool looks_like_alsa_pcm_uid(const std::string& uid) {
  return uid.rfind("hw:", 0) == 0 || uid.rfind("plughw:", 0) == 0 ||
         uid.rfind("front:", 0) == 0 || uid.rfind("sysdefault:", 0) == 0 ||
         uid.rfind("dmix:", 0) == 0 || uid.rfind("dsnoop:", 0) == 0 ||
         uid.rfind("default:", 0) == 0 || uid == "pulse" || uid == "pipewire";
}

// Interruptible & drainable runtime PulseAudio async (`libpulse.so.0`) + ALSA non-blocking (`libasound.so.2`)
// 16kHz mono reader loaded solely via `dlopen`.
class LinuxAudioSource {
 public:
  ~LinuxAudioSource() { close(); }

  void request_interrupt() {
    interrupted_.store(true);
    std::lock_guard<std::mutex> lock(wakeup_mu_);
    if (pa_ml_ && pa_ml_wakeup_) {
      pa_ml_wakeup_(pa_ml_);
    }
  }

  bool open(const std::string& device_uid, std::string& out_error) {
    if (interrupted_.load()) {
      out_error = "Audio capture aborted before open";
      return false;
    }
    if (device_uid.rfind("pulse:", 0) == 0) {
      const std::string pa_dev = device_uid.substr(6);
      if (open_pulse_async(pa_dev, out_error)) return true;
      if (out_error.empty()) {
        out_error = "Requested PulseAudio/PipeWire capture device could not be opened";
      }
      return false;
    }
    if (device_uid.rfind("alsa:", 0) == 0) {
      const std::string alsa_dev = device_uid.substr(5);
      if (open_alsa_nonblock(alsa_dev.empty() ? "default" : alsa_dev, out_error)) return true;
      if (out_error.empty()) {
        out_error = "Requested ALSA capture device could not be opened";
      }
      return false;
    }
    if (!device_uid.empty() && device_uid != "auto" && device_uid != "default" &&
        looks_like_alsa_pcm_uid(device_uid)) {
      if (open_alsa_nonblock(device_uid, out_error)) return true;
      std::string pa_err;
      if ((device_uid == "pulse" || device_uid == "pipewire") && open_pulse_async("", pa_err)) {
        out_error.clear();
        return true;
      }
      return false;
    }

    std::string pa_err;
    if (open_pulse_async(device_uid, pa_err)) {
      return true;
    }
    if (interrupted_.load()) {
      out_error = "Audio capture interrupted during open";
      return false;
    }
    std::string alsa_dev = (device_uid.empty() || device_uid == "auto" || device_uid == "default")
        ? "default"
        : device_uid;
    if (open_alsa_nonblock(alsa_dev, out_error)) {
      return true;
    }
    if (out_error.empty()) {
      out_error = !pa_err.empty() ? pa_err : "No PulseAudio or ALSA microphone capture device available";
    }
    return false;
  }

  // Returns sample count read (>0), 0 on timeout/interrupted wait, or <0 on fatal backend error.
  int read_16k_mono(std::vector<int16_t>& out_buf) {
    out_buf.clear();
    if (pa_stream_) {
      if (!drain_pulse_readable(out_buf)) {
        return -1;
      }
      if (!out_buf.empty() || interrupted_.load()) {
        return static_cast<int>(out_buf.size());
      }
      if (pa_ml_prepare_(pa_ml_, 25000) < 0 || pa_ml_poll_(pa_ml_) < 0 || pa_ml_dispatch_(pa_ml_) < 0) {
        return -1;
      }
      if (!drain_pulse_readable(out_buf)) {
        return -1;
      }
      if (out_buf.empty() && is_pulse_dead()) {
        return -1;
      }
      return static_cast<int>(out_buf.size());
    }
    if (alsa_pcm_) {
      return read_alsa_nonblock(out_buf, true);
    }
    return -1;
  }

  // Non-blocking drain called on normal stop to preserve already-buffered tail frames.
  void drain_16k_mono(std::vector<int16_t>& out_buf) {
    out_buf.clear();
    if (pa_stream_) {
      if (pa_ml_prepare_(pa_ml_, 0) >= 0 && pa_ml_poll_(pa_ml_) >= 0) {
        pa_ml_dispatch_(pa_ml_);
      }
      drain_pulse_readable(out_buf);
      return;
    }
    if (alsa_pcm_) {
      std::vector<int16_t> chunk;
      for (int iter = 0; iter < 16; ++iter) {
        chunk.clear();
        const int n = read_alsa_nonblock(chunk, false);
        if (n <= 0) break;
        out_buf.insert(out_buf.end(), chunk.begin(), chunk.end());
      }
    }
  }

  void close() {
    if (pa_stream_) {
      if (pa_stream_disconnect_) pa_stream_disconnect_(pa_stream_);
      if (pa_stream_unref_) pa_stream_unref_(pa_stream_);
      pa_stream_ = nullptr;
    }
    if (pa_ctx_) {
      if (pa_ctx_disconnect_) pa_ctx_disconnect_(pa_ctx_);
      if (pa_ctx_unref_) pa_ctx_unref_(pa_ctx_);
      pa_ctx_ = nullptr;
    }
    void* ml_to_free = nullptr;
    {
      std::lock_guard<std::mutex> lock(wakeup_mu_);
      ml_to_free = pa_ml_;
      pa_ml_ = nullptr;
    }
    if (ml_to_free && pa_ml_free_) {
      pa_ml_free_(ml_to_free);
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
    odd_byte_pending_ = false;
  }

 private:
  bool is_pulse_dead() const {
    if (pa_ctx_ && pa_ctx_get_state_) {
      const int cst = pa_ctx_get_state_(pa_ctx_);
      if (cst == kPaContextFailed || cst == kPaContextTerminated) return true;
    }
    if (pa_stream_ && pa_stream_get_state_) {
      const int sst = pa_stream_get_state_(pa_stream_);
      if (sst == kPaStreamFailed || sst == kPaStreamTerminated) return true;
    }
    return false;
  }

  bool drain_pulse_readable(std::vector<int16_t>& out_buf) {
    if (!pa_stream_) return false;
    while (true) {
      const size_t avail = pa_stream_readable_size_(pa_stream_);
      if (avail == static_cast<size_t>(-1)) {
        return false;
      }
      if (avail == 0) {
        return true;
      }
      const void* data = nullptr;
      size_t nbytes = 0;
      if (pa_stream_peek_(pa_stream_, &data, &nbytes) < 0) {
        return false;
      }
      if (nbytes == 0) {
        return true;
      }
      if (data) {
        const auto* bytes = static_cast<const uint8_t*>(data);
        size_t off = 0;
        if (odd_byte_pending_ && nbytes > 0) {
          const uint16_t raw = static_cast<uint16_t>(odd_byte_) | (static_cast<uint16_t>(bytes[0]) << 8);
          out_buf.push_back(static_cast<int16_t>(raw));
          odd_byte_pending_ = false;
          off = 1;
        }
        while (off + 1 < nbytes) {
          const uint16_t raw = static_cast<uint16_t>(bytes[off]) | (static_cast<uint16_t>(bytes[off + 1]) << 8);
          out_buf.push_back(static_cast<int16_t>(raw));
          off += 2;
        }
        if (off < nbytes) {
          odd_byte_ = bytes[off];
          odd_byte_pending_ = true;
        }
      } else {
        // Server sent a silence hole of nbytes
        const size_t sample_hole = nbytes / 2;
        out_buf.insert(out_buf.end(), sample_hole, 0);
      }
      pa_stream_drop_(pa_stream_);
    }
  }

  bool open_pulse_async(const std::string& device_uid, std::string& out_error) {
    pa_lib_ = ::dlopen("libpulse.so.0", RTLD_LAZY | RTLD_LOCAL);
    if (!pa_lib_) return false;

    auto ml_new = reinterpret_cast<void* (*)()>(::dlsym(pa_lib_, "pa_mainloop_new"));
    pa_ml_free_ = reinterpret_cast<void (*)(void*)>(::dlsym(pa_lib_, "pa_mainloop_free"));
    auto ml_get_api = reinterpret_cast<void* (*)(void*)>(::dlsym(pa_lib_, "pa_mainloop_get_api"));
    pa_ml_prepare_ = reinterpret_cast<int (*)(void*, int)>(::dlsym(pa_lib_, "pa_mainloop_prepare"));
    pa_ml_poll_ = reinterpret_cast<int (*)(void*)>(::dlsym(pa_lib_, "pa_mainloop_poll"));
    pa_ml_dispatch_ = reinterpret_cast<int (*)(void*)>(::dlsym(pa_lib_, "pa_mainloop_dispatch"));
    pa_ml_wakeup_ = reinterpret_cast<void (*)(void*)>(::dlsym(pa_lib_, "pa_mainloop_wakeup"));

    auto ctx_new = reinterpret_cast<void* (*)(void*, const char*)>(::dlsym(pa_lib_, "pa_context_new"));
    pa_ctx_unref_ = reinterpret_cast<void (*)(void*)>(::dlsym(pa_lib_, "pa_context_unref"));
    auto ctx_connect = reinterpret_cast<int (*)(void*, const char*, int, const void*)>(
        ::dlsym(pa_lib_, "pa_context_connect"));
    pa_ctx_disconnect_ = reinterpret_cast<void (*)(void*)>(::dlsym(pa_lib_, "pa_context_disconnect"));
    pa_ctx_get_state_ = reinterpret_cast<int (*)(void*)>(::dlsym(pa_lib_, "pa_context_get_state"));

    auto stream_new = reinterpret_cast<void* (*)(void*, const char*, const PaSampleSpec*, const void*)>(
        ::dlsym(pa_lib_, "pa_stream_new"));
    pa_stream_unref_ = reinterpret_cast<void (*)(void*)>(::dlsym(pa_lib_, "pa_stream_unref"));
    auto stream_connect_record = reinterpret_cast<int (*)(
        void*, const char*, const PaBufferAttr*, int, const void*, const void*)>(
        ::dlsym(pa_lib_, "pa_stream_connect_record"));
    pa_stream_disconnect_ = reinterpret_cast<int (*)(void*)>(::dlsym(pa_lib_, "pa_stream_disconnect"));
    pa_stream_get_state_ = reinterpret_cast<int (*)(void*)>(::dlsym(pa_lib_, "pa_stream_get_state"));
    pa_stream_readable_size_ = reinterpret_cast<size_t (*)(void*)>(::dlsym(pa_lib_, "pa_stream_readable_size"));
    pa_stream_peek_ = reinterpret_cast<int (*)(void*, const void**, size_t*)>(::dlsym(pa_lib_, "pa_stream_peek"));
    pa_stream_drop_ = reinterpret_cast<int (*)(void*)>(::dlsym(pa_lib_, "pa_stream_drop"));

    if (!ml_new || !pa_ml_free_ || !ml_get_api || !pa_ml_prepare_ || !pa_ml_poll_ || !pa_ml_dispatch_ ||
        !pa_ml_wakeup_ || !ctx_new || !pa_ctx_unref_ || !ctx_connect || !pa_ctx_disconnect_ ||
        !pa_ctx_get_state_ || !stream_new || !pa_stream_unref_ || !stream_connect_record ||
        !pa_stream_disconnect_ || !pa_stream_get_state_ || !pa_stream_readable_size_ ||
        !pa_stream_peek_ || !pa_stream_drop_) {
      close();
      return false;
    }

    {
      std::lock_guard<std::mutex> lock(wakeup_mu_);
      pa_ml_ = ml_new();
    }
    if (!pa_ml_) {
      close();
      return false;
    }
    pa_ctx_ = ctx_new(ml_get_api(pa_ml_), "imcodes-speech");
    if (!pa_ctx_ || ctx_connect(pa_ctx_, nullptr, kPaContextFlagNoAutospawn, nullptr) < 0) {
      out_error = "Failed to connect to PulseAudio/PipeWire daemon";
      close();
      return false;
    }

    bool ctx_ready = false;
    const auto ctx_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2000);
    while (!interrupted_.load() && std::chrono::steady_clock::now() < ctx_deadline) {
      const int st = pa_ctx_get_state_(pa_ctx_);
      if (st == kPaContextReady) {
        ctx_ready = true;
        break;
      }
      if (st == kPaContextFailed || st == kPaContextTerminated) {
        break;
      }
      if (pa_ml_prepare_(pa_ml_, 20000) < 0 || pa_ml_poll_(pa_ml_) < 0 || pa_ml_dispatch_(pa_ml_) < 0) {
        break;
      }
    }
    if (!ctx_ready) {
      out_error = "PulseAudio/PipeWire context failed or timed out";
      close();
      return false;
    }

    const PaSampleSpec ss{kPaSampleS16Le, static_cast<uint32_t>(kTargetSampleRate), 1};
    const PaBufferAttr attr{
        static_cast<uint32_t>(-1),
        static_cast<uint32_t>(-1),
        static_cast<uint32_t>(-1),
        static_cast<uint32_t>(-1),
        1600 /* 50ms @ 16kHz S16LE */
    };
    pa_stream_ = stream_new(pa_ctx_, "voice", &ss, nullptr);
    if (!pa_stream_) {
      out_error = "Failed to create PulseAudio capture stream";
      close();
      return false;
    }

    const char* dev = (device_uid.empty() || device_uid == "auto" || device_uid == "default")
        ? nullptr
        : device_uid.c_str();
    // Prevent PulseAudio/PipeWire from silently migrating the stream to another source/monitor on unplug.
    if (stream_connect_record(
            pa_stream_, dev, &attr, kPaStreamDontMove | kPaStreamAdjustLatency, nullptr, nullptr) < 0) {
      out_error = "Failed to connect PulseAudio capture stream to requested device";
      close();
      return false;
    }

    bool stream_ready = false;
    const auto stream_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2000);
    while (!interrupted_.load() && std::chrono::steady_clock::now() < stream_deadline) {
      const int st = pa_stream_get_state_(pa_stream_);
      if (st == kPaStreamReady) {
        stream_ready = true;
        break;
      }
      if (st == kPaStreamFailed || st == kPaStreamTerminated) {
        break;
      }
      if (pa_ml_prepare_(pa_ml_, 20000) < 0 || pa_ml_poll_(pa_ml_) < 0 || pa_ml_dispatch_(pa_ml_) < 0) {
        break;
      }
    }
    if (!stream_ready) {
      out_error = "PulseAudio capture stream did not become ready for device";
      close();
      return false;
    }
    return true;
  }

  int read_alsa_nonblock(std::vector<int16_t>& out_buf, bool wait_if_empty) {
    out_buf.resize(1600, 0);
    for (int attempt = 0; attempt < 2; ++attempt) {
      const long frames = snd_readi_(alsa_pcm_, out_buf.data(), static_cast<unsigned long>(out_buf.size()));
      if (frames > 0) {
        out_buf.resize(static_cast<size_t>(frames));
        return static_cast<int>(frames);
      }
      if (frames == -11 /* -EAGAIN */) {
        out_buf.clear();
        if (!wait_if_empty || interrupted_.load() || !snd_wait_) {
          return 0;
        }
        const int w = snd_wait_(alsa_pcm_, 25);
        if (w < 0) {
          if (snd_recover_(alsa_pcm_, w, 1) < 0) return -1;
          return 0;
        }
        if (w == 0) return 0;
        out_buf.resize(1600, 0);
        continue;
      }
      if (frames == 0) {
        out_buf.clear();
        return 0;
      }
      out_buf.clear();
      if (snd_recover_(alsa_pcm_, static_cast<int>(frames), 1) < 0) {
        return -1;
      }
      return 0;
    }
    out_buf.clear();
    return 0;
  }

  bool open_alsa_nonblock(const std::string& device_uid, std::string& out_error) {
    alsa_lib_ = ::dlopen("libasound.so.2", RTLD_LAZY | RTLD_LOCAL);
    if (!alsa_lib_) return false;
    auto snd_open = reinterpret_cast<int (*)(void**, const char*, int, int)>(
        ::dlsym(alsa_lib_, "snd_pcm_open"));
    auto snd_set_params = reinterpret_cast<int (*)(void*, int, int, unsigned int, unsigned int, int, unsigned int)>(
        ::dlsym(alsa_lib_, "snd_pcm_set_params"));
    auto snd_start = reinterpret_cast<int (*)(void*)>(
        ::dlsym(alsa_lib_, "snd_pcm_start"));
    snd_wait_ = reinterpret_cast<int (*)(void*, int)>(
        ::dlsym(alsa_lib_, "snd_pcm_wait"));
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
    // SND_PCM_STREAM_CAPTURE = 1, SND_PCM_NONBLOCK = 1
    if (snd_open(&alsa_pcm_, dev, 1, 1) < 0 || !alsa_pcm_) {
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
    if (snd_start) {
      snd_start(alsa_pcm_);
    }
    return true;
  }

  std::atomic<bool> interrupted_{false};
  std::mutex wakeup_mu_;

  void* pa_lib_{nullptr};
  void* pa_ml_{nullptr};
  void* pa_ctx_{nullptr};
  void* pa_stream_{nullptr};
  void (*pa_ml_free_)(void*){nullptr};
  int (*pa_ml_prepare_)(void*, int){nullptr};
  int (*pa_ml_poll_)(void*){nullptr};
  int (*pa_ml_dispatch_)(void*){nullptr};
  void (*pa_ml_wakeup_)(void*){nullptr};
  void (*pa_ctx_unref_)(void*){nullptr};
  void (*pa_ctx_disconnect_)(void*){nullptr};
  int (*pa_ctx_get_state_)(void*){nullptr};
  void (*pa_stream_unref_)(void*){nullptr};
  int (*pa_stream_disconnect_)(void*){nullptr};
  int (*pa_stream_get_state_)(void*){nullptr};
  size_t (*pa_stream_readable_size_)(void*){nullptr};
  int (*pa_stream_peek_)(void*, const void**, size_t*){nullptr};
  int (*pa_stream_drop_)(void*){nullptr};
  uint8_t odd_byte_{0};
  bool odd_byte_pending_{false};

  void* alsa_lib_{nullptr};
  void* alsa_pcm_{nullptr};
  int (*snd_wait_)(void*, int){nullptr};
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
    audio_.request_interrupt();
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
  void push_pcm16_slice(const std::vector<int16_t>& s16, std::vector<float>& f32_buf) {
    if (s16.empty() || aborted_.load()) return;
    f32_buf.clear();
    double sq_sum = 0.0;
    for (int16_t raw : s16) {
      const float sample = static_cast<float>(raw) / 32768.0f;
      f32_buf.push_back(sample);
      sq_sum += static_cast<double>(sample) * static_cast<double>(sample);
    }
    const double rms = std::sqrt(sq_sum / static_cast<double>(s16.size()));
    const auto now = std::chrono::steady_clock::now();
    if (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_level_emit_).count() >= 90) {
      last_level_emit_ = now;
      const double normalized = std::min(1.0, rms * 4.0);
      char lvl_buf[64];
      std::snprintf(lvl_buf, sizeof(lvl_buf), "{\"type\":\"level\",\"value\":%.4f}", normalized);
      emit_json_line(lvl_buf);
    }
    if (!aborted_.load()) {
      pipeline_.push_samples(f32_buf);
    }
  }

  void run_loop() {
    if (aborted_.load() || stop_requested_.load()) {
      imcodes::speech::drain_prefill_or_end(aborted_.load(), initial_samples_, pipeline_);
      return;
    }
    std::string audio_err;
    if (!audio_.open(device_uid_, audio_err)) {
      if (aborted_.load() || stop_requested_.load()) {
        imcodes::speech::drain_prefill_or_end(aborted_.load(), initial_samples_, pipeline_);
        return;
      }
      std::vector<float>().swap(initial_samples_);
      emit_error("no_input_device", "mic", audio_err);
      emit_json_line("{\"type\":\"end\"}");
      return;
    }
    if (aborted_.load() || stop_requested_.load()) {
      audio_.close();
      imcodes::speech::drain_prefill_or_end(aborted_.load(), initial_samples_, pipeline_);
      return;
    }

    pipeline_.preload(initial_samples_);
    std::vector<float>().swap(initial_samples_);
    std::thread decode_thread([this]() { pipeline_.run_loop(); });

    emit_json_line("{\"type\":\"start\"}");

    std::vector<int16_t> s16_buf;
    s16_buf.reserve(1600);
    std::vector<float> f32_buf;
    f32_buf.reserve(1600);
    last_level_emit_ = std::chrono::steady_clock::now();

    bool capture_error = false;
    while (!stop_requested_.load() && !aborted_.load()) {
      const int frames = audio_.read_16k_mono(s16_buf);
      if (frames < 0) {
        capture_error = true;
        break;
      }
      if (frames == 0) {
        continue;
      }
      push_pcm16_slice(s16_buf, f32_buf);
    }

    if (capture_error && !stop_requested_.load() && !aborted_.load()) {
      emit_error("audio_capture_failed", "mic", "Audio input stream disconnected");
      audio_.close();
      pipeline_.request_stop(false, true);
    } else {
      if (!aborted_.load()) {
        audio_.drain_16k_mono(s16_buf);
        push_pcm16_slice(s16_buf, f32_buf);
      }
      audio_.close();
      pipeline_.mark_producer_finished();
    }
    if (decode_thread.joinable()) {
      decode_thread.join();
    }
  }

  std::string device_uid_;
  std::vector<float> initial_samples_;
  LinuxAudioSource audio_;
  imcodes::qwen3::Qwen3StreamingPipeline pipeline_;
  std::chrono::steady_clock::time_point last_level_emit_;
  std::atomic<bool> stop_requested_{false};
  std::atomic<bool> aborted_{false};
  std::thread worker_;
};

int run_serve_command(
    const std::string& model_dir,
    const std::string& variant,
    const std::string& provider,
    int device_id) {
  emit_json_line("{\"type\":\"loading\",\"variant\":\"" + json_escape(variant) + "\"}");
  LinuxQwen3AsrRunner runner;
  std::string init_err;
  if (!runner.init(model_dir, provider, device_id, init_err)) {
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
    int device_id,
    const std::string& device_uid,
    const std::string& locale,
    const std::string& hotwords_raw) {
  emit_json_line("{\"type\":\"loading\",\"variant\":\"" + json_escape(variant) + "\"}");
  LinuxQwen3AsrRunner runner;
  std::string init_err;
  if (!runner.init(model_dir, provider, device_id, init_err)) {
    emit_error("model_load_failed", "speech", init_err);
    return 1;
  }
  ServeStartParams params;
  params.device = device_uid;
  params.locale = locale;
  if (!hotwords_raw.empty()) {
    params.hotwords = parse_cli_hotwords_arg(hotwords_raw);
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

int run_serve_command(const std::string&, const std::string&, const std::string&, int) {
  emit_error("onnxruntime_unavailable", "speech", "Built without ONNX Runtime support");
  return 1;
}

int run_listen_command(
    const std::string&,
    const std::string&,
    const std::string&,
    int,
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
    int device_id = -1;
    std::string device_uid = "auto";
    std::string locale;
    std::string hotwords;
    for (int i = 2; i < argc; ++i) {
      const std::string a = argv[i];
      if (a == "--model-dir" && i + 1 < argc) model_dir = argv[++i];
      else if (a == "--variant" && i + 1 < argc) variant = argv[++i];
      else if (a == "--provider" && i + 1 < argc) provider = argv[++i];
      else if (a == "--device-id" && i + 1 < argc) {
        try {
          device_id = std::stoi(argv[++i]);
        } catch (...) {
          device_id = -1;
        }
      }
      else if (a == "--device" && i + 1 < argc) device_uid = argv[++i];
      else if (a == "--locale" && i + 1 < argc) locale = argv[++i];
      else if (a == "--hotwords" && i + 1 < argc) hotwords = argv[++i];
    }
    if (model_dir.empty()) {
      emit_error("missing_model_dir", "speech", "--model-dir is required");
      return 1;
    }
    return cmd == "serve"
        ? run_serve_command(model_dir, variant, provider, device_id)
        : run_listen_command(model_dir, variant, provider, device_id, device_uid, locale, hotwords);
  }

  emit_error("unknown_command", "", "Unknown command: " + cmd);
  return 1;
}
