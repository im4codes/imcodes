#ifndef IMCODES_REMOTE_DESKTOP_COMMON_LOOPBACK_AUDIO_DEVICE_MODULE_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_LOOPBACK_AUDIO_DEVICE_MODULE_H_

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <thread>
#include <utility>

#include "api/audio/audio_device.h"
#include "api/audio/audio_device_defines.h"
#include "api/audio_options.h"
#include "audio_loopback_buffer.h"
#include "modules/audio_device/include/audio_device_default.h"

namespace imcodes::rd {

/**
 * Desktop playback audio options: disable voice-processing filters (AEC, AGC,
 * noise suppression, high-pass filter) that degrade music/system audio and
 * favor low-latency jitter buffer acceleration.
 */
inline webrtc::AudioOptions MakeDesktopAudioOptions() {
  webrtc::AudioOptions options;
  options.echo_cancellation = false;
  options.auto_gain_control = false;
  options.noise_suppression = false;
  options.highpass_filter = false;
  options.stereo_swapping = false;
  options.audio_jitter_buffer_fast_accelerate = true;
  return options;
}

/**
 * Cross-platform WebRTC AudioDeviceModule feeding captured OS loopback audio
 * from `AudioLoopbackBuffer` into `AudioTransport::RecordedDataIsAvailable` on
 * a steady 10 ms pacing thread without touching physical microphone hardware.
 */
class LoopbackAudioDeviceModule
    : public webrtc::webrtc_impl::AudioDeviceModuleDefault<
          webrtc::AudioDeviceModule> {
 public:
  explicit LoopbackAudioDeviceModule(
      std::shared_ptr<AudioLoopbackBuffer> buffer =
          std::make_shared<AudioLoopbackBuffer>())
      : buffer_(std::move(buffer)) {
    if (!buffer_) {
      buffer_ = std::make_shared<AudioLoopbackBuffer>();
    }
  }

  ~LoopbackAudioDeviceModule() override { Terminate(); }

  LoopbackAudioDeviceModule(const LoopbackAudioDeviceModule&) = delete;
  LoopbackAudioDeviceModule& operator=(const LoopbackAudioDeviceModule&) = delete;

  std::shared_ptr<AudioLoopbackBuffer> buffer() const noexcept {
    return buffer_;
  }

  int32_t RegisterAudioCallback(webrtc::AudioTransport* audio_callback) override {
    std::lock_guard<std::mutex> lock(callback_mutex_);
    audio_callback_ = audio_callback;
    return 0;
  }

  int32_t Init() override {
    std::lock_guard<std::mutex> lock(lifecycle_mutex_);
    initialized_.store(true, std::memory_order_release);
    return 0;
  }

  int32_t Terminate() override {
    std::lock_guard<std::mutex> lock(lifecycle_mutex_);
    StopRecordingLocked();
    initialized_.store(false, std::memory_order_release);
    recording_initialized_.store(false, std::memory_order_release);
    std::lock_guard<std::mutex> cb_lock(callback_mutex_);
    audio_callback_ = nullptr;
    return 0;
  }

  bool Initialized() const override {
    return initialized_.load(std::memory_order_acquire);
  }

  int16_t RecordingDevices() override { return 1; }

  int32_t RecordingDeviceName(uint16_t index,
                              char name[webrtc::kAdmMaxDeviceNameSize],
                              char guid[webrtc::kAdmMaxGuidSize]) override {
    if (index != 0) return -1;
    if (name != nullptr) {
      std::snprintf(name, webrtc::kAdmMaxDeviceNameSize,
                    "Remote Desktop Loopback");
    }
    if (guid != nullptr) {
      std::snprintf(guid, webrtc::kAdmMaxGuidSize, "imcodes-rd-loopback");
    }
    return 0;
  }

  int32_t SetRecordingDevice(uint16_t index) override {
    return index == 0 ? 0 : -1;
  }

  int32_t SetRecordingDevice(
      webrtc::AudioDeviceModule::WindowsDeviceType /* device */) override {
    return 0;
  }

  int32_t RecordingIsAvailable(bool* available) override {
    if (available != nullptr) *available = true;
    return 0;
  }

  int32_t InitRecording() override {
    std::lock_guard<std::mutex> lock(lifecycle_mutex_);
    recording_initialized_.store(true, std::memory_order_release);
    return 0;
  }

  bool RecordingIsInitialized() const override {
    return recording_initialized_.load(std::memory_order_acquire);
  }

  int32_t StartRecording() override {
    std::lock_guard<std::mutex> lock(lifecycle_mutex_);
    recording_initialized_.store(true, std::memory_order_release);
    if (active_run_ != nullptr && pump_thread_.joinable()) {
      return 0;
    }
    auto run = std::make_shared<PumpRun>();
    active_run_ = run;
    recording_.store(true, std::memory_order_release);
    pump_thread_ = std::thread(&LoopbackAudioDeviceModule::PumpLoop, this,
                               std::move(run));
    return 0;
  }

  int32_t StopRecording() override {
    std::lock_guard<std::mutex> lock(lifecycle_mutex_);
    StopRecordingLocked();
    return 0;
  }

  bool Recording() const override {
    return recording_.load(std::memory_order_acquire);
  }

  int32_t StereoRecordingIsAvailable(bool* available) const override {
    if (available != nullptr) *available = true;
    return 0;
  }

  int32_t SetStereoRecording(bool enable) override {
    stereo_recording_.store(enable, std::memory_order_release);
    return 0;
  }

  int32_t StereoRecording(bool* enabled) const override {
    if (enabled != nullptr) {
      *enabled = stereo_recording_.load(std::memory_order_acquire);
    }
    return 0;
  }

  int32_t MicrophoneVolumeIsAvailable(bool* available) override {
    if (available != nullptr) *available = false;
    return 0;
  }

  int32_t MicrophoneMuteIsAvailable(bool* available) override {
    if (available != nullptr) *available = false;
    return 0;
  }

 private:
  struct PumpRun {
    std::mutex mu;
    std::condition_variable cv;
    bool stop = false;
  };

  void StopRecordingLocked() {
    std::shared_ptr<PumpRun> run = std::move(active_run_);
    std::thread thread_to_join = std::move(pump_thread_);
    recording_.store(false, std::memory_order_release);
    if (run != nullptr) {
      {
        std::lock_guard<std::mutex> run_lock(run->mu);
        run->stop = true;
      }
      run->cv.notify_all();
    }
    if (thread_to_join.joinable()) {
      thread_to_join.join();
    }
  }

  void PumpLoop(std::shared_ptr<PumpRun> run) {
    using clock = std::chrono::steady_clock;
    constexpr auto kInterval = std::chrono::milliseconds(10);
    constexpr auto kMaxDrift = std::chrono::milliseconds(50);

    auto next_tick = clock::now() + kInterval;
    std::int16_t pcm[kAudioFrameSamples] = {};

    while (true) {
      {
        std::unique_lock<std::mutex> run_lock(run->mu);
        run->cv.wait_until(run_lock, next_tick,
                           [&run] { return run->stop; });
        if (run->stop) {
          break;
        }
      }

      const auto now = clock::now();
      next_tick += kInterval;
      if (now - next_tick > kMaxDrift) {
        next_tick = now + kInterval;
      }

      if (!buffer_->enabled()) {
        continue;
      }

      buffer_->Pop10msFrame(pcm);
      std::lock_guard<std::mutex> cb_lock(callback_mutex_);
      if (audio_callback_ != nullptr) {
        uint32_t new_mic_level = 0;
        audio_callback_->RecordedDataIsAvailable(
            pcm,
            kAudioFrameSamplesPerChannel,
            kAudioChannels * sizeof(std::int16_t),
            kAudioChannels,
            static_cast<uint32_t>(kAudioSampleRateHz),
            0,
            0,
            0,
            false,
            new_mic_level);
      }
    }
  }

  std::shared_ptr<AudioLoopbackBuffer> buffer_;
  std::mutex lifecycle_mutex_;
  std::shared_ptr<PumpRun> active_run_;
  std::mutex callback_mutex_;
  webrtc::AudioTransport* audio_callback_ = nullptr;
  std::atomic<bool> initialized_{false};
  std::atomic<bool> recording_initialized_{false};
  std::atomic<bool> recording_{false};
  std::atomic<bool> stereo_recording_{true};
  std::thread pump_thread_;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_LOOPBACK_AUDIO_DEVICE_MODULE_H_
