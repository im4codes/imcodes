#include "third_party/imcodes_remote_desktop/wasapi_loopback_capture.h"

#include <audioclient.h>
#include <mmdeviceapi.h>
#include <objbase.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstring>
#include <utility>

namespace imcodes::rd {
namespace {

using Microsoft::WRL::ComPtr;

constexpr REFERENCE_TIME kLoopbackBufferDuration100Ns = 400'000;  // 40 ms
constexpr DWORD kCapturePollMs = 5;
constexpr DWORD kMinRetryBackoffMs = 500;
constexpr DWORD kMaxRetryBackoffMs = 2000;
constexpr DWORD kDeviceReopenDebounceMs = 50;
constexpr std::uint32_t kWasapiSilentFlag = 0x2u;  // AUDCLNT_BUFFERFLAGS_SILENT

constexpr GUID kSubformatPcm = {
    0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
constexpr GUID kSubformatIeeeFloat = {
    0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

struct CoTaskMemFreeDeleter {
  void operator()(void* ptr) const noexcept {
    if (ptr != nullptr) CoTaskMemFree(ptr);
  }
};

template <typename T>
using UniqueCoTaskMem = std::unique_ptr<T, CoTaskMemFreeDeleter>;

enum class WaitOutcome {
  kTimeout,
  kWake,
  kStop,
  kFailed,
};

WaitOutcome WaitStopOrWake(HANDLE stop_event,
                           HANDLE wake_event,
                           DWORD timeout_ms,
                           std::uint32_t* failed_hr = nullptr) noexcept {
  if (stop_event == nullptr) {
    if (failed_hr != nullptr) *failed_hr = static_cast<std::uint32_t>(E_HANDLE);
    return WaitOutcome::kFailed;
  }
  DWORD rc = WAIT_FAILED;
  if (wake_event != nullptr) {
    const HANDLE handles[2] = {stop_event, wake_event};
    rc = WaitForMultipleObjects(2, handles, FALSE, timeout_ms);
    if (rc == WAIT_OBJECT_0) return WaitOutcome::kStop;
    if (rc == WAIT_OBJECT_0 + 1) return WaitOutcome::kWake;
  } else {
    rc = WaitForSingleObject(stop_event, timeout_ms);
    if (rc == WAIT_OBJECT_0) return WaitOutcome::kStop;
  }
  if (rc == WAIT_TIMEOUT) return WaitOutcome::kTimeout;
  if (failed_hr != nullptr) {
    const DWORD err = GetLastError();
    *failed_hr = static_cast<std::uint32_t>(
        err != 0 ? HRESULT_FROM_WIN32(err) : E_FAIL);
  }
  return WaitOutcome::kFailed;
}

class DefaultRenderDeviceNotificationClient final : public IMMNotificationClient {
 public:
  DefaultRenderDeviceNotificationClient(HANDLE wake_event,
                                        std::atomic<bool>* device_invalidated)
      : wake_event_(wake_event), device_invalidated_(device_invalidated) {}

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (ppv == nullptr) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
      *ppv = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override {
    return ref_count_.fetch_add(1, std::memory_order_relaxed) + 1;
  }

  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG next = ref_count_.fetch_sub(1, std::memory_order_acq_rel) - 1;
    if (next == 0) delete this;
    return next;
  }

  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR /*device_id*/,
                                                 DWORD new_state) override {
    if (new_state != DEVICE_STATE_ACTIVE ||
        !stream_active_.load(std::memory_order_acquire)) {
      NotifyChange();
    }
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR /*device_id*/) override {
    if (!stream_active_.load(std::memory_order_acquire)) {
      NotifyChange();
    }
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR /*device_id*/) override {
    NotifyChange();
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow,
                                                   ERole role,
                                                   LPCWSTR /*device_id*/) override {
    if (flow == eRender && role == eConsole) {
      NotifyChange();
    }
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR /*device_id*/,
                                                   const PROPERTYKEY /*key*/) override {
    return S_OK;
  }

  void SetStreamActive(bool active) noexcept {
    stream_active_.store(active, std::memory_order_release);
  }

 private:
  ~DefaultRenderDeviceNotificationClient() = default;

  void NotifyChange() noexcept {
    if (device_invalidated_ != nullptr) {
      device_invalidated_->store(true, std::memory_order_release);
    }
    if (wake_event_ != nullptr) {
      SetEvent(wake_event_);
    }
  }

  std::atomic<ULONG> ref_count_{1};
  std::atomic<bool> stream_active_{false};
  HANDLE const wake_event_;
  std::atomic<bool>* const device_invalidated_;
};

class ComWasapiLoopbackStream final : public WasapiLoopbackStream {
 public:
  ComWasapiLoopbackStream(ComPtr<IAudioClient> audio_client,
                          ComPtr<IAudioCaptureClient> capture_client,
                          ParsedWaveFormat format,
                          ComPtr<DefaultRenderDeviceNotificationClient> notify)
      : audio_client_(std::move(audio_client)),
        capture_client_(std::move(capture_client)),
        format_(format),
        notify_(std::move(notify)) {
    if (notify_) notify_->SetStreamActive(true);
  }

  ~ComWasapiLoopbackStream() override { Stop(); }

  ParsedWaveFormat format() const noexcept override { return format_; }

  HRESULT NextPacket(const std::uint8_t** data,
                     std::size_t* frames,
                     std::uint32_t* flags) override {
    if (!capture_client_) return E_POINTER;
    UINT32 packet_frames = 0;
    HRESULT hr = capture_client_->GetNextPacketSize(&packet_frames);
    if (FAILED(hr)) return hr;
    if (packet_frames == 0) {
      *data = nullptr;
      *frames = 0;
      *flags = 0;
      return S_FALSE;
    }
    BYTE* raw_data = nullptr;
    UINT32 frames_read = 0;
    DWORD raw_flags = 0;
    hr = capture_client_->GetBuffer(&raw_data, &frames_read, &raw_flags,
                                    nullptr, nullptr);
    if (FAILED(hr)) return hr;
    *data = raw_data;
    *frames = frames_read;
    *flags = raw_flags;
    return S_OK;
  }

  HRESULT ReleasePacket(std::size_t frames) override {
    if (!capture_client_) return E_POINTER;
    return capture_client_->ReleaseBuffer(static_cast<UINT32>(frames));
  }

  void Stop() noexcept override {
    if (notify_) notify_->SetStreamActive(false);
    if (audio_client_ && !stopped_) {
      (void)audio_client_->Stop();
      stopped_ = true;
    }
    capture_client_.Reset();
    audio_client_.Reset();
  }

 private:
  ComPtr<IAudioClient> audio_client_;
  ComPtr<IAudioCaptureClient> capture_client_;
  const ParsedWaveFormat format_;
  ComPtr<DefaultRenderDeviceNotificationClient> notify_;
  bool stopped_ = false;
};

class ComWasapiLoopbackBackend final : public WasapiLoopbackBackend {
 public:
  HRESULT OpenSession(HANDLE wake_event,
                      std::atomic<bool>* device_invalidated) override {
    const HRESULT com_hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    com_owned_ = SUCCEEDED(com_hr);
    if (FAILED(com_hr) && com_hr != RPC_E_CHANGED_MODE) {
      return com_hr;
    }
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                  CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                  &enumerator_);
    if (FAILED(hr) || !enumerator_) {
      CloseSession();
      return FAILED(hr) ? hr : E_FAIL;
    }
    notify_client_.Attach(new DefaultRenderDeviceNotificationClient(
        wake_event, device_invalidated));
    const HRESULT reg_hr =
        enumerator_->RegisterEndpointNotificationCallback(notify_client_.Get());
    registered_notifications_ = SUCCEEDED(reg_hr);
    return S_OK;
  }

  HRESULT OpenDefaultRenderStream(
      std::unique_ptr<WasapiLoopbackStream>* out_stream) override {
    if (!enumerator_ || out_stream == nullptr) return E_POINTER;

    ComPtr<IMMDevice> device;
    HRESULT hr = enumerator_->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (FAILED(hr) || !device) return FAILED(hr) ? hr : E_NOTFOUND;

    ComPtr<IAudioClient> audio_client;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                          &audio_client);
    if (FAILED(hr) || !audio_client) return FAILED(hr) ? hr : E_FAIL;

    WAVEFORMATEX* raw_mix_format = nullptr;
    hr = audio_client->GetMixFormat(&raw_mix_format);
    UniqueCoTaskMem<WAVEFORMATEX> mix_format(raw_mix_format);
    if (FAILED(hr) || !mix_format) return FAILED(hr) ? hr : E_FAIL;

    const ParsedWaveFormat parsed = ParseWaveFormat(mix_format.get());
    if (parsed.format == WasapiSampleFormat::kUnsupported) {
      return AUDCLNT_E_UNSUPPORTED_FORMAT;
    }

    hr = audio_client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                  AUDCLNT_STREAMFLAGS_LOOPBACK,
                                  kLoopbackBufferDuration100Ns, 0,
                                  mix_format.get(), nullptr);
    if (FAILED(hr)) return hr;

    ComPtr<IAudioCaptureClient> capture_client;
    hr = audio_client->GetService(__uuidof(IAudioCaptureClient),
                                  &capture_client);
    if (FAILED(hr) || !capture_client) return FAILED(hr) ? hr : E_FAIL;

    hr = audio_client->Start();
    if (FAILED(hr)) return hr;

    *out_stream = std::make_unique<ComWasapiLoopbackStream>(
        std::move(audio_client), std::move(capture_client), parsed,
        notify_client_);
    return S_OK;
  }

  void CloseSession() noexcept override {
    if (registered_notifications_ && enumerator_ && notify_client_) {
      (void)enumerator_->UnregisterEndpointNotificationCallback(
          notify_client_.Get());
    }
    registered_notifications_ = false;
    notify_client_.Reset();
    enumerator_.Reset();
    if (com_owned_) {
      CoUninitialize();
      com_owned_ = false;
    }
  }

 private:
  bool com_owned_ = false;
  bool registered_notifications_ = false;
  ComPtr<IMMDeviceEnumerator> enumerator_;
  ComPtr<DefaultRenderDeviceNotificationClient> notify_client_;
};

LoopbackPacketSink MakeBufferSink(std::shared_ptr<AudioLoopbackBuffer> buffer) {
  return [buffer = std::move(buffer)](const float* float_interleaved,
                                      const std::int16_t* int16_interleaved,
                                      std::size_t frames,
                                      int sample_rate_hz,
                                      int channels,
                                      bool silent) {
    if (!buffer || silent || frames == 0) return;
    if (float_interleaved != nullptr) {
      buffer->PushFloat32Interleaved(float_interleaved, frames, sample_rate_hz,
                                     channels);
    } else if (int16_interleaved != nullptr) {
      buffer->PushInt16Interleaved(int16_interleaved, frames, sample_rate_hz,
                                   channels);
    }
  };
}

}  // namespace

std::shared_ptr<WasapiLoopbackBackend> CreateDefaultWasapiLoopbackBackend() {
  return std::make_shared<ComWasapiLoopbackBackend>();
}

ParsedWaveFormat ParseWaveFormat(const WAVEFORMATEX* format) noexcept {
  ParsedWaveFormat parsed;
  if (format == nullptr || format->nChannels == 0 ||
      format->nSamplesPerSec == 0 || format->nBlockAlign == 0) {
    return parsed;
  }

  const int channels = static_cast<int>(format->nChannels);
  const int sample_rate = static_cast<int>(format->nSamplesPerSec);
  const int bits = static_cast<int>(format->wBitsPerSample);
  const int block_align = static_cast<int>(format->nBlockAlign);

  if (format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
    if (bits == 32 && block_align >= channels * 4) {
      parsed.format = WasapiSampleFormat::kFloat32;
      parsed.sample_rate_hz = sample_rate;
      parsed.channels = channels;
      parsed.bits_per_sample = bits;
      parsed.valid_bits_per_sample = 32;
      parsed.block_align = block_align;
    }
    return parsed;
  }

  if (format->wFormatTag == WAVE_FORMAT_PCM) {
    if (bits == 16 && block_align >= channels * 2) {
      parsed.format = WasapiSampleFormat::kInt16;
    } else if (bits == 24 && block_align >= channels * 3) {
      parsed.format = WasapiSampleFormat::kInt24;
    } else if (bits == 32 && block_align >= channels * 4) {
      parsed.format = WasapiSampleFormat::kInt32;
    } else {
      return parsed;
    }
    parsed.sample_rate_hz = sample_rate;
    parsed.channels = channels;
    parsed.bits_per_sample = bits;
    parsed.valid_bits_per_sample = bits;
    parsed.block_align = block_align;
    return parsed;
  }

  if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
      format->cbSize >= sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
    WAVEFORMATEXTENSIBLE ext{};
    std::memcpy(&ext, format, sizeof(WAVEFORMATEXTENSIBLE));
    if (IsEqualGUID(ext.SubFormat, kSubformatIeeeFloat)) {
      if (bits == 32 && block_align >= channels * 4) {
        parsed.format = WasapiSampleFormat::kFloat32;
        parsed.sample_rate_hz = sample_rate;
        parsed.channels = channels;
        parsed.bits_per_sample = bits;
        parsed.valid_bits_per_sample =
            ext.Samples.wValidBitsPerSample > 0
                ? static_cast<int>(ext.Samples.wValidBitsPerSample)
                : 32;
        parsed.block_align = block_align;
      }
      return parsed;
    }
    if (IsEqualGUID(ext.SubFormat, kSubformatPcm)) {
      if (bits == 16 && block_align >= channels * 2) {
        parsed.format = WasapiSampleFormat::kInt16;
      } else if (bits == 24 && block_align >= channels * 3) {
        parsed.format = WasapiSampleFormat::kInt24;
      } else if (bits == 32 && block_align >= channels * 4) {
        parsed.format = WasapiSampleFormat::kInt32;
      } else {
        return parsed;
      }
      parsed.sample_rate_hz = sample_rate;
      parsed.channels = channels;
      parsed.bits_per_sample = bits;
      parsed.valid_bits_per_sample =
          ext.Samples.wValidBitsPerSample > 0
              ? static_cast<int>(ext.Samples.wValidBitsPerSample)
              : bits;
      parsed.block_align = block_align;
      return parsed;
    }
  }

  return parsed;
}

void ForwardWasapiPacket(const std::uint8_t* data,
                         std::size_t frames,
                         std::uint32_t flags,
                         const ParsedWaveFormat& format,
                         std::vector<float>* scratch_float,
                         std::vector<std::int16_t>* scratch_int16,
                         const LoopbackPacketSink& sink) {
  if (frames == 0 || format.format == WasapiSampleFormat::kUnsupported ||
      format.sample_rate_hz <= 0 || format.channels <= 0 || !sink) {
    return;
  }

  if ((flags & kWasapiSilentFlag) != 0 || data == nullptr) {
    sink(nullptr, nullptr, frames, format.sample_rate_hz, format.channels,
         /*silent=*/true);
    return;
  }

  const std::size_t channels = static_cast<std::size_t>(format.channels);
  const std::size_t total_samples = frames * channels;

  if (format.format == WasapiSampleFormat::kInt16) {
    if (scratch_int16 != nullptr) {
      scratch_int16->resize(total_samples);
      std::memcpy(scratch_int16->data(), data,
                  total_samples * sizeof(std::int16_t));
      sink(nullptr, scratch_int16->data(), frames, format.sample_rate_hz,
           format.channels, false);
    } else {
      std::vector<std::int16_t> temp(total_samples);
      std::memcpy(temp.data(), data, total_samples * sizeof(std::int16_t));
      sink(nullptr, temp.data(), frames, format.sample_rate_hz,
           format.channels, false);
    }
    return;
  }

  std::vector<float> local_float;
  std::vector<float>* float_out =
      scratch_float != nullptr ? scratch_float : &local_float;
  float_out->resize(total_samples);

  if (format.format == WasapiSampleFormat::kFloat32) {
    std::memcpy(float_out->data(), data, total_samples * sizeof(float));
  } else if (format.format == WasapiSampleFormat::kInt32) {
    constexpr float kScale = 1.0f / 2147483648.0f;
    for (std::size_t i = 0; i < total_samples; ++i) {
      std::int32_t sample = 0;
      std::memcpy(&sample, data + i * sizeof(std::int32_t),
                  sizeof(std::int32_t));
      (*float_out)[i] = static_cast<float>(sample) * kScale;
    }
  } else if (format.format == WasapiSampleFormat::kInt24) {
    constexpr float kScale = 1.0f / 8388608.0f;
    for (std::size_t i = 0; i < total_samples; ++i) {
      const std::size_t offset = i * 3;
      std::int32_t sample = static_cast<std::int32_t>(data[offset]) |
                            (static_cast<std::int32_t>(data[offset + 1]) << 8) |
                            (static_cast<std::int32_t>(data[offset + 2]) << 16);
      if ((sample & 0x00800000) != 0) {
        sample |= static_cast<std::int32_t>(0xff000000u);
      }
      (*float_out)[i] = static_cast<float>(sample) * kScale;
    }
  } else {
    return;
  }

  sink(float_out->data(), nullptr, frames, format.sample_rate_hz,
       format.channels, false);
}

WasapiLoopbackCapture::WasapiLoopbackCapture(
    LoopbackPacketSink sink,
    std::shared_ptr<WasapiLoopbackBackend> backend)
    : sink_(std::move(sink)),
      backend_(backend ? std::move(backend)
                       : CreateDefaultWasapiLoopbackBackend()) {}

WasapiLoopbackCapture::WasapiLoopbackCapture(
    std::shared_ptr<AudioLoopbackBuffer> buffer,
    std::shared_ptr<WasapiLoopbackBackend> backend)
    : WasapiLoopbackCapture(MakeBufferSink(std::move(buffer)),
                            std::move(backend)) {}

WasapiLoopbackCapture::~WasapiLoopbackCapture() { SetEnabled(false); }

void WasapiLoopbackCapture::SetEnabled(bool enabled) {
  std::lock_guard<std::mutex> lock(state_mutex_);
  if (enabled == enabled_.load(std::memory_order_acquire)) {
    return;
  }

  if (enabled) {
    HANDLE stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HANDLE wake_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (stop_event == nullptr || wake_event == nullptr) {
      const DWORD err = GetLastError();
      if (stop_event != nullptr) CloseHandle(stop_event);
      if (wake_event != nullptr) CloseHandle(wake_event);
      std::lock_guard<std::mutex> stats_lock(stats_mutex_);
      stats_.last_error_hr = static_cast<std::uint32_t>(
          err != 0 ? HRESULT_FROM_WIN32(err) : E_FAIL);
      return;
    }
    active_stop_event_ = stop_event;
    active_wake_event_ = wake_event;
    enabled_.store(true, std::memory_order_release);
    {
      std::lock_guard<std::mutex> stats_lock(stats_mutex_);
      stats_.enabled = true;
    }
    // Pass per-generation immutable handles by value so the capture thread never
    // reads mutable members and handles outlive the thread + COM callbacks.
    capture_thread_ = std::thread(&WasapiLoopbackCapture::CaptureThreadMain,
                                  this, stop_event, wake_event);
    return;
  }

  enabled_.store(false, std::memory_order_release);
  if (active_stop_event_ != nullptr) {
    SetEvent(active_stop_event_);
  }
  if (capture_thread_.joinable()) {
    capture_thread_.join();
  }
  if (active_stop_event_ != nullptr) {
    CloseHandle(active_stop_event_);
    active_stop_event_ = nullptr;
  }
  if (active_wake_event_ != nullptr) {
    CloseHandle(active_wake_event_);
    active_wake_event_ = nullptr;
  }

  std::lock_guard<std::mutex> stats_lock(stats_mutex_);
  stats_.enabled = false;
  stats_.stream_active = false;
}

WasapiLoopbackStats WasapiLoopbackCapture::stats() const noexcept {
  std::lock_guard<std::mutex> lock(stats_mutex_);
  return stats_;
}

void WasapiLoopbackCapture::CaptureThreadMain(const HANDLE stop_event,
                                              const HANDLE wake_event) {
  backend_->OnCaptureThreadEntered();

  std::atomic<bool> device_invalidated{false};
  DWORD backoff_ms = kMinRetryBackoffMs;
  std::vector<float> scratch_float;
  std::vector<std::int16_t> scratch_int16;
  std::uint32_t wait_error_hr = 0;

  while (WaitStopOrWake(stop_event, nullptr, 0, &wait_error_hr) ==
         WaitOutcome::kTimeout) {
    const HRESULT session_hr =
        backend_->OpenSession(wake_event, &device_invalidated);
    if (FAILED(session_hr)) {
      {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        stats_.stream_active = false;
        stats_.last_error_hr = static_cast<std::uint32_t>(session_hr);
      }
      const WaitOutcome wait =
          WaitStopOrWake(stop_event, nullptr, backoff_ms, &wait_error_hr);
      if (wait == WaitOutcome::kFailed) {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        stats_.last_error_hr = wait_error_hr;
        break;
      }
      if (wait == WaitOutcome::kStop) break;
      backoff_ms = std::min(backoff_ms * 2, kMaxRetryBackoffMs);
      continue;
    }

    bool abort_loop = false;
    while (!abort_loop) {
      const WaitOutcome pre_check =
          WaitStopOrWake(stop_event, nullptr, 0, &wait_error_hr);
      if (pre_check == WaitOutcome::kFailed) {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        stats_.last_error_hr = wait_error_hr;
        abort_loop = true;
        break;
      }
      if (pre_check == WaitOutcome::kStop) {
        abort_loop = true;
        break;
      }

      device_invalidated.store(false, std::memory_order_release);
      std::unique_ptr<WasapiLoopbackStream> stream;
      const HRESULT open_hr = backend_->OpenDefaultRenderStream(&stream);
      if (FAILED(open_hr) || !stream) {
        {
          std::lock_guard<std::mutex> lock(stats_mutex_);
          stats_.stream_active = false;
          stats_.last_error_hr = static_cast<std::uint32_t>(
              FAILED(open_hr) ? open_hr : E_FAIL);
        }
        const WaitOutcome wait = WaitStopOrWake(stop_event, wake_event,
                                                backoff_ms, &wait_error_hr);
        if (wait == WaitOutcome::kFailed) {
          std::lock_guard<std::mutex> lock(stats_mutex_);
          stats_.last_error_hr = wait_error_hr;
          abort_loop = true;
          break;
        }
        if (wait == WaitOutcome::kStop) {
          abort_loop = true;
          break;
        }
        if (wait == WaitOutcome::kWake) {
          backoff_ms = kMinRetryBackoffMs;
        } else {
          backoff_ms = std::min(backoff_ms * 2, kMaxRetryBackoffMs);
        }
        continue;
      }

      const ParsedWaveFormat parsed = stream->format();
      backoff_ms = kMinRetryBackoffMs;
      {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        stats_.stream_active = true;
        stats_.sample_rate_hz = parsed.sample_rate_hz;
        stats_.channels = parsed.channels;
        stats_.format = parsed.format;
        stats_.last_error_hr = 0;
      }

      bool reopen_requested = false;
      for (;;) {
        const WaitOutcome wait = WaitStopOrWake(stop_event, wake_event,
                                                kCapturePollMs, &wait_error_hr);
        if (wait == WaitOutcome::kFailed) {
          std::lock_guard<std::mutex> lock(stats_mutex_);
          stats_.last_error_hr = wait_error_hr;
          abort_loop = true;
          break;
        }
        if (wait == WaitOutcome::kStop) {
          abort_loop = true;
          break;
        }
        if (wait == WaitOutcome::kWake ||
            device_invalidated.exchange(false, std::memory_order_acq_rel)) {
          reopen_requested = true;
          break;
        }

        HRESULT drain_hr = S_OK;
        for (;;) {
          const std::uint8_t* data = nullptr;
          std::size_t frames_read = 0;
          std::uint32_t flags = 0;
          drain_hr = stream->NextPacket(&data, &frames_read, &flags);
          if (FAILED(drain_hr) || drain_hr == S_FALSE) break;

          const bool silent =
              ((flags & kWasapiSilentFlag) != 0) || (data == nullptr);
          ForwardWasapiPacket(data, frames_read, flags, parsed, &scratch_float,
                              &scratch_int16, sink_);

          const HRESULT rel_hr = stream->ReleasePacket(frames_read);
          {
            std::lock_guard<std::mutex> lock(stats_mutex_);
            ++stats_.packets_captured;
            stats_.frames_captured += frames_read;
            if (silent) ++stats_.silent_packets;
          }
          if (FAILED(rel_hr)) {
            drain_hr = rel_hr;
            break;
          }
        }

        if (FAILED(drain_hr)) {
          std::lock_guard<std::mutex> lock(stats_mutex_);
          stats_.last_error_hr = static_cast<std::uint32_t>(drain_hr);
          reopen_requested = true;
          break;
        }
      }

      stream->Stop();
      stream.reset();
      {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        stats_.stream_active = false;
        if (reopen_requested) ++stats_.device_reopens;
      }
      if (abort_loop || !reopen_requested) break;
      const WaitOutcome debounce = WaitStopOrWake(
          stop_event, nullptr, kDeviceReopenDebounceMs, &wait_error_hr);
      if (debounce == WaitOutcome::kFailed) {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        stats_.last_error_hr = wait_error_hr;
        break;
      }
      if (debounce == WaitOutcome::kStop) break;
    }

    backend_->CloseSession();
    break;
  }

  if (wait_error_hr != 0) {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    if (stats_.last_error_hr == 0) stats_.last_error_hr = wait_error_hr;
  }
  {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    stats_.stream_active = false;
  }
}

LoopbackAudioRouter::LoopbackAudioRouter(
    bool enable_hardware_capture,
    std::shared_ptr<WasapiLoopbackBackend> backend)
    : enable_hardware_capture_(enable_hardware_capture),
      capture_(
          [this](const float* float_interleaved,
                 const std::int16_t* int16_interleaved,
                 std::size_t frames,
                 int sample_rate_hz,
                 int channels,
                 bool silent) {
            PushCapturedPacket(float_interleaved, int16_interleaved, frames,
                               sample_rate_hz, channels, silent);
          },
          std::move(backend)) {}

LoopbackAudioRouter::~LoopbackAudioRouter() { Shutdown(); }

std::shared_ptr<AudioLoopbackBuffer> LoopbackAudioRouter::RegisterSession(
    const std::string& session_id) {
  auto buffer = std::make_shared<AudioLoopbackBuffer>();
  std::lock_guard<std::mutex> lock(mutex_);
  if (shutdown_) return buffer;
  session_buffers_[session_id] = buffer;
  return buffer;
}

void LoopbackAudioRouter::SetSessionAudioEnabled(const std::string& session_id,
                                                 bool enabled) {
  bool should_capture = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (shutdown_) return;
    auto found = session_buffers_.find(session_id);
    if (enabled) {
      if (found == session_buffers_.end()) {
        found = session_buffers_
                    .emplace(session_id, std::make_shared<AudioLoopbackBuffer>())
                    .first;
      }
      found->second->SetEnabled(true);
      enabled_sessions_.insert(session_id);
    } else {
      enabled_sessions_.erase(session_id);
      if (found != session_buffers_.end() && found->second) {
        found->second->SetEnabled(false);
      }
    }
    should_capture = !enabled_sessions_.empty();
    capture_desired_.store(should_capture, std::memory_order_release);
  }
  if (enable_hardware_capture_) {
    capture_.SetEnabled(should_capture);
  }
}

void LoopbackAudioRouter::UnregisterSession(const std::string& session_id) {
  bool should_capture = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    enabled_sessions_.erase(session_id);
    const auto found = session_buffers_.find(session_id);
    if (found != session_buffers_.end()) {
      if (found->second) found->second->SetEnabled(false);
      session_buffers_.erase(found);
    }
    should_capture = !shutdown_ && !enabled_sessions_.empty();
    capture_desired_.store(should_capture, std::memory_order_release);
  }
  if (enable_hardware_capture_) {
    capture_.SetEnabled(should_capture);
  }
}

void LoopbackAudioRouter::Shutdown() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    shutdown_ = true;
    enabled_sessions_.clear();
    for (auto& [id, buffer] : session_buffers_) {
      if (buffer) buffer->SetEnabled(false);
    }
    session_buffers_.clear();
    capture_desired_.store(false, std::memory_order_release);
  }
  capture_.SetEnabled(false);
}

void LoopbackAudioRouter::PushCapturedPacket(
    const float* float_interleaved,
    const std::int16_t* int16_interleaved,
    std::size_t frames,
    int sample_rate_hz,
    int channels,
    bool silent) {
  if (silent || frames == 0 ||
      (float_interleaved == nullptr && int16_interleaved == nullptr)) {
    return;
  }

  std::vector<std::shared_ptr<AudioLoopbackBuffer>> targets;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (shutdown_ || enabled_sessions_.empty()) return;
    targets.reserve(enabled_sessions_.size());
    for (const std::string& session_id : enabled_sessions_) {
      const auto found = session_buffers_.find(session_id);
      if (found != session_buffers_.end() && found->second &&
          found->second->enabled()) {
        targets.push_back(found->second);
      }
    }
  }

  for (const auto& buffer : targets) {
    if (float_interleaved != nullptr) {
      buffer->PushFloat32Interleaved(float_interleaved, frames, sample_rate_hz,
                                     channels);
    } else {
      buffer->PushInt16Interleaved(int16_interleaved, frames, sample_rate_hz,
                                   channels);
    }
  }
}

std::size_t LoopbackAudioRouter::EnabledSessionCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return enabled_sessions_.size();
}

bool LoopbackAudioRouter::CaptureEnabled() const noexcept {
  return enable_hardware_capture_
             ? capture_.enabled()
             : capture_desired_.load(std::memory_order_acquire);
}

WasapiLoopbackStats LoopbackAudioRouter::CaptureStats() const noexcept {
  return capture_.stats();
}

}  // namespace imcodes::rd
