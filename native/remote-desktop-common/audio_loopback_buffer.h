#ifndef IMCODES_REMOTE_DESKTOP_COMMON_AUDIO_LOOPBACK_BUFFER_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_AUDIO_LOOPBACK_BUFFER_H_

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

namespace imcodes::rd {

inline constexpr int kAudioSampleRateHz = 48000;
inline constexpr std::size_t kAudioChannels = 2;
inline constexpr std::size_t kAudioFrameSamplesPerChannel = 480;  // 10 ms @ 48 kHz
inline constexpr std::size_t kAudioFrameSamples =
    kAudioFrameSamplesPerChannel * kAudioChannels;  // 960 int16 samples
inline constexpr std::size_t kDefaultAudioRingCapacityFrames = 9600;  // 200 ms

/**
 * Thread-safe bounded ring buffer normalizing OS loopback PCM feeds into
 * interleaved 48 kHz stereo Int16 frames for WebRTC AudioTransport::RecordedDataIsAvailable.
 *
 * Overruns drop oldest frames so end-to-end audio latency remains bounded;
 * underruns and disabled state output clean zero-filled silence.
 */
class AudioLoopbackBuffer {
 public:
  explicit AudioLoopbackBuffer(
      std::size_t capacity_frames = kDefaultAudioRingCapacityFrames)
      : capacity_frames_(
            std::max(capacity_frames, kAudioFrameSamplesPerChannel)),
        ring_(capacity_frames_ * kAudioChannels, 0) {}

  AudioLoopbackBuffer(const AudioLoopbackBuffer&) = delete;
  AudioLoopbackBuffer& operator=(const AudioLoopbackBuffer&) = delete;

  void SetEnabled(bool enabled) {
    std::lock_guard<std::mutex> lock(mutex_);
    head_ = 0;
    tail_ = 0;
    count_ = 0;
    ResetResamplerLocked();
    enabled_.store(enabled, std::memory_order_release);
  }

  // Drains buffered samples and fences any in-flight guarded pushes under
  // mutex_ without altering transport-owned enabled state.
  void Clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    head_ = 0;
    tail_ = 0;
    count_ = 0;
    ResetResamplerLocked();
  }

  bool enabled() const noexcept {
    return enabled_.load(std::memory_order_acquire);
  }

  std::size_t capacity_frames() const noexcept { return capacity_frames_; }

  std::size_t BufferedFrames() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return count_;
  }

  void PushInt16Interleaved(const std::int16_t* data,
                            std::size_t frames,
                            int sample_rate,
                            int channels) {
    (void)PushInt16InterleavedGuarded(data, frames, sample_rate, channels,
                                      nullptr);
  }

  bool PushInt16InterleavedGuarded(const std::int16_t* data,
                                   std::size_t frames,
                                   int sample_rate,
                                   int channels,
                                   const std::atomic<bool>* gate) {
    if (!enabled() ||
        (gate != nullptr && !gate->load(std::memory_order_acquire)) ||
        data == nullptr || frames == 0 || sample_rate <= 0 || channels <= 0) {
      return false;
    }
    const std::size_t ch = static_cast<std::size_t>(channels);
    std::lock_guard<std::mutex> lock(mutex_);
    if (!enabled() ||
        (gate != nullptr && !gate->load(std::memory_order_acquire))) {
      return false;
    }

    if (sample_rate == kAudioSampleRateHz && ch == kAudioChannels) {
      ResetResamplerLocked();
      for (std::size_t i = 0; i < frames; ++i) {
        WriteFrameLocked(data[i * 2], data[i * 2 + 1]);
      }
      return true;
    }

    AppendStereoResampledLocked(
        sample_rate, frames,
        [data, ch](std::size_t idx, float& out_l, float& out_r) {
          const std::size_t base = idx * ch;
          out_l = static_cast<float>(data[base]);
          out_r = ch >= 2 ? static_cast<float>(data[base + 1]) : out_l;
        });
    return true;
  }

  void PushFloat32Interleaved(const float* data,
                              std::size_t frames,
                              int sample_rate,
                              int channels) {
    (void)PushFloat32InterleavedGuarded(data, frames, sample_rate, channels,
                                        nullptr);
  }

  bool PushFloat32InterleavedGuarded(const float* data,
                                     std::size_t frames,
                                     int sample_rate,
                                     int channels,
                                     const std::atomic<bool>* gate) {
    if (!enabled() ||
        (gate != nullptr && !gate->load(std::memory_order_acquire)) ||
        data == nullptr || frames == 0 || sample_rate <= 0 || channels <= 0) {
      return false;
    }
    const std::size_t ch = static_cast<std::size_t>(channels);
    std::lock_guard<std::mutex> lock(mutex_);
    if (!enabled() ||
        (gate != nullptr && !gate->load(std::memory_order_acquire))) {
      return false;
    }

    AppendStereoResampledLocked(
        sample_rate, frames,
        [data, ch](std::size_t idx, float& out_l, float& out_r) {
          const std::size_t base = idx * ch;
          out_l = ScaleFloatSample(data[base]);
          out_r = ch >= 2 ? ScaleFloatSample(data[base + 1]) : out_l;
        });
    return true;
  }

  void PushFloat32Planar(const float* left,
                         const float* right_or_null,
                         std::size_t frames,
                         int sample_rate) {
    (void)PushFloat32PlanarGuarded(left, right_or_null, frames, sample_rate,
                                   nullptr);
  }

  bool PushFloat32PlanarGuarded(const float* left,
                                const float* right_or_null,
                                std::size_t frames,
                                int sample_rate,
                                const std::atomic<bool>* gate) {
    if (!enabled() ||
        (gate != nullptr && !gate->load(std::memory_order_acquire)) ||
        left == nullptr || frames == 0 || sample_rate <= 0) {
      return false;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (!enabled() ||
        (gate != nullptr && !gate->load(std::memory_order_acquire))) {
      return false;
    }

    AppendStereoResampledLocked(
        sample_rate, frames,
        [left, right_or_null](std::size_t idx, float& out_l, float& out_r) {
          out_l = ScaleFloatSample(left[idx]);
          out_r =
              right_or_null != nullptr ? ScaleFloatSample(right_or_null[idx]) : out_l;
        });
    return true;
  }

  bool Pop10msFrame(std::int16_t out[kAudioFrameSamples]) {
    if (out == nullptr) return false;
    if (!enabled()) {
      std::fill_n(out, kAudioFrameSamples, 0);
      return false;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (!enabled() || count_ < kAudioFrameSamplesPerChannel) {
      std::fill_n(out, kAudioFrameSamples, 0);
      return false;
    }
    for (std::size_t i = 0; i < kAudioFrameSamplesPerChannel; ++i) {
      const std::size_t idx = head_ * kAudioChannels;
      out[i * 2] = ring_[idx];
      out[i * 2 + 1] = ring_[idx + 1];
      head_ = (head_ + 1) % capacity_frames_;
    }
    count_ -= kAudioFrameSamplesPerChannel;
    return true;
  }

 private:
  static float ScaleFloatSample(float sample) noexcept {
    if (!std::isfinite(sample)) return 0.0f;
    return std::clamp(sample, -1.0f, 1.0f) * 32767.0f;
  }

  static std::int16_t RoundToInt16(float sample) noexcept {
    if (!std::isfinite(sample)) return 0;
    const long rounded = std::lround(sample);
    return static_cast<std::int16_t>(
        std::clamp(rounded, -32768L, 32767L));
  }

  void ResetResamplerLocked() noexcept {
    resample_source_rate_ = 0;
    resample_phase_ = 0.0;
    has_prev_ = false;
    prev_l_ = 0.0f;
    prev_r_ = 0.0f;
  }

  void WriteFrameLocked(std::int16_t left, std::int16_t right) noexcept {
    const std::size_t idx = tail_ * kAudioChannels;
    ring_[idx] = left;
    ring_[idx + 1] = right;
    tail_ = (tail_ + 1) % capacity_frames_;
    if (count_ == capacity_frames_) {
      // Bounded latency: discard oldest frame instead of letting delay grow.
      head_ = (head_ + 1) % capacity_frames_;
    } else {
      ++count_;
    }
  }

  template <typename ReadStereoFn>
  void AppendStereoResampledLocked(int sample_rate,
                                   std::size_t frames,
                                   ReadStereoFn&& read_stereo) {
    if (sample_rate == kAudioSampleRateHz) {
      ResetResamplerLocked();
      for (std::size_t i = 0; i < frames; ++i) {
        float l = 0.0f;
        float r = 0.0f;
        read_stereo(i, l, r);
        WriteFrameLocked(RoundToInt16(l), RoundToInt16(r));
      }
      return;
    }

    if (resample_source_rate_ != sample_rate) {
      resample_source_rate_ = sample_rate;
      resample_phase_ = 0.0;
      has_prev_ = false;
    }

    const double step =
        static_cast<double>(sample_rate) / static_cast<double>(kAudioSampleRateHz);
    const double frames_d = static_cast<double>(frames);

    float first_l = 0.0f;
    float first_r = 0.0f;
    read_stereo(0, first_l, first_r);

    if (has_prev_) {
      while (resample_phase_ < 0.0) {
        const float t = static_cast<float>(resample_phase_ + 1.0);
        const float l = prev_l_ + (first_l - prev_l_) * t;
        const float r = prev_r_ + (first_r - prev_r_) * t;
        WriteFrameLocked(RoundToInt16(l), RoundToInt16(r));
        resample_phase_ += step;
      }
    } else if (resample_phase_ < 0.0) {
      resample_phase_ = 0.0;
    }

    while (resample_phase_ + 1.0 < frames_d) {
      const std::size_t idx = static_cast<std::size_t>(resample_phase_);
      const float t =
          static_cast<float>(resample_phase_ - static_cast<double>(idx));
      float l0 = 0.0f;
      float r0 = 0.0f;
      float l1 = 0.0f;
      float r1 = 0.0f;
      read_stereo(idx, l0, r0);
      read_stereo(idx + 1, l1, r1);
      WriteFrameLocked(RoundToInt16(l0 + (l1 - l0) * t),
                       RoundToInt16(r0 + (r1 - r0) * t));
      resample_phase_ += step;
    }

    read_stereo(frames - 1, prev_l_, prev_r_);
    has_prev_ = true;
    resample_phase_ -= frames_d;
  }

  const std::size_t capacity_frames_;
  std::atomic<bool> enabled_{false};
  mutable std::mutex mutex_;
  std::vector<std::int16_t> ring_;
  std::size_t head_ = 0;
  std::size_t tail_ = 0;
  std::size_t count_ = 0;
  int resample_source_rate_ = 0;
  double resample_phase_ = 0.0;
  bool has_prev_ = false;
  float prev_l_ = 0.0f;
  float prev_r_ = 0.0f;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_AUDIO_LOOPBACK_BUFFER_H_
