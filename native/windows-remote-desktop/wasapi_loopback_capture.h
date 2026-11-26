#ifndef IMCODES_REMOTE_DESKTOP_WASAPI_LOOPBACK_CAPTURE_H_
#define IMCODES_REMOTE_DESKTOP_WASAPI_LOOPBACK_CAPTURE_H_

#include <windows.h>
#include <mmreg.h>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "third_party/imcodes_remote_desktop/common/audio_loopback_buffer.h"

namespace imcodes::rd {

enum class WasapiSampleFormat {
  kUnsupported,
  kInt16,
  kInt24,
  kInt32,
  kFloat32,
};

struct ParsedWaveFormat {
  WasapiSampleFormat format = WasapiSampleFormat::kUnsupported;
  int sample_rate_hz = 0;
  int channels = 0;
  int bits_per_sample = 0;
  int valid_bits_per_sample = 0;
  int block_align = 0;
};

struct WasapiLoopbackStats {
  bool enabled = false;
  bool stream_active = false;
  int sample_rate_hz = 0;
  int channels = 0;
  WasapiSampleFormat format = WasapiSampleFormat::kUnsupported;
  std::uint64_t packets_captured = 0;
  std::uint64_t frames_captured = 0;
  std::uint64_t silent_packets = 0;
  std::uint64_t device_reopens = 0;
  std::uint32_t last_error_hr = 0;
};

using LoopbackPacketSink = std::function<void(const float* float_interleaved,
                                              const std::int16_t* int16_interleaved,
                                              std::size_t frames,
                                              int sample_rate_hz,
                                              int channels,
                                              bool silent)>;

ParsedWaveFormat ParseWaveFormat(const WAVEFORMATEX* format) noexcept;

void ForwardWasapiPacket(const std::uint8_t* data,
                         std::size_t frames,
                         std::uint32_t flags,
                         const ParsedWaveFormat& format,
                         std::vector<float>* scratch_float,
                         std::vector<std::int16_t>* scratch_int16,
                         const LoopbackPacketSink& sink);

class WasapiLoopbackStream {
 public:
  virtual ~WasapiLoopbackStream() = default;
  virtual ParsedWaveFormat format() const noexcept = 0;
  virtual HRESULT NextPacket(const std::uint8_t** data,
                             std::size_t* frames,
                             std::uint32_t* flags) = 0;
  virtual HRESULT ReleasePacket(std::size_t frames) = 0;
  virtual void Stop() noexcept = 0;
};

class WasapiLoopbackBackend {
 public:
  virtual ~WasapiLoopbackBackend() = default;
  virtual HRESULT OpenSession(HANDLE wake_event,
                              std::atomic<bool>* device_invalidated) = 0;
  virtual HRESULT OpenDefaultRenderStream(
      std::unique_ptr<WasapiLoopbackStream>* out_stream) = 0;
  virtual void CloseSession() noexcept = 0;
  virtual void OnCaptureThreadEntered() noexcept {}
};

std::shared_ptr<WasapiLoopbackBackend> CreateDefaultWasapiLoopbackBackend();

/**
 * Captures system render audio via WASAPI shared loopback (`eRender` / `eConsole`
 * + `AUDCLNT_STREAMFLAGS_LOOPBACK`) without opening `eCapture` microphones.
 *
 * Handles default-device hot-swap (`IMMNotificationClient` +
 * `AUDCLNT_E_DEVICE_INVALIDATED`) and degrades silently with bounded backoff
 * on Session 0 / Winlogon / headless endpoints with no active audio device.
 */
class WasapiLoopbackCapture {
 public:
  explicit WasapiLoopbackCapture(
      LoopbackPacketSink sink,
      std::shared_ptr<WasapiLoopbackBackend> backend = nullptr);
  explicit WasapiLoopbackCapture(
      std::shared_ptr<AudioLoopbackBuffer> buffer,
      std::shared_ptr<WasapiLoopbackBackend> backend = nullptr);
  ~WasapiLoopbackCapture();

  WasapiLoopbackCapture(const WasapiLoopbackCapture&) = delete;
  WasapiLoopbackCapture& operator=(const WasapiLoopbackCapture&) = delete;

  void SetEnabled(bool enabled);
  bool enabled() const noexcept {
    return enabled_.load(std::memory_order_acquire);
  }
  WasapiLoopbackStats stats() const noexcept;

 private:
  void CaptureThreadMain(HANDLE stop_event, HANDLE wake_event);

  const LoopbackPacketSink sink_;
  const std::shared_ptr<WasapiLoopbackBackend> backend_;
  std::mutex state_mutex_;
  std::atomic<bool> enabled_{false};
  HANDLE active_stop_event_ = nullptr;
  HANDLE active_wake_event_ = nullptr;
  std::thread capture_thread_;

  mutable std::mutex stats_mutex_;
  WasapiLoopbackStats stats_;
};

/**
 * Reference-counts active audio-enabled remote desktop sessions and fans out
 * captured loopback PCM into per-session `AudioLoopbackBuffer` instances.
 */
class LoopbackAudioRouter {
 public:
  explicit LoopbackAudioRouter(
      bool enable_hardware_capture = true,
      std::shared_ptr<WasapiLoopbackBackend> backend = nullptr);
  ~LoopbackAudioRouter();

  LoopbackAudioRouter(const LoopbackAudioRouter&) = delete;
  LoopbackAudioRouter& operator=(const LoopbackAudioRouter&) = delete;

  std::shared_ptr<AudioLoopbackBuffer> RegisterSession(
      const std::string& session_id);
  void SetSessionAudioEnabled(const std::string& session_id, bool enabled);
  void UnregisterSession(const std::string& session_id);
  void Shutdown();

  // Entry point for both live WasapiLoopbackCapture packets and tests.
  void PushCapturedPacket(const float* float_interleaved,
                          const std::int16_t* int16_interleaved,
                          std::size_t frames,
                          int sample_rate_hz,
                          int channels,
                          bool silent);

  std::size_t EnabledSessionCount() const;
  bool CaptureEnabled() const noexcept;
  WasapiLoopbackStats CaptureStats() const noexcept;

 private:
  const bool enable_hardware_capture_;
  mutable std::mutex mutex_;
  std::map<std::string, std::shared_ptr<AudioLoopbackBuffer>> session_buffers_;
  std::set<std::string> enabled_sessions_;
  bool shutdown_ = false;
  std::atomic<bool> capture_desired_{false};
  WasapiLoopbackCapture capture_;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_WASAPI_LOOPBACK_CAPTURE_H_
