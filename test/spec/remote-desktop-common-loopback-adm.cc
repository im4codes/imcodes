#include "api/make_ref_counted.h"
#include "native/remote-desktop-common/loopback_audio_device_module.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <future>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace {

namespace rd = imcodes::rd;

int g_failures = 0;

void Check(bool condition, const char* label) {
  if (condition) return;
  ++g_failures;
  std::fprintf(stderr, "FAIL: %s\n", label);
}

class RecordingAudioTransport final : public webrtc::AudioTransport {
 public:
  int32_t RecordedDataIsAvailable(const void* audio_samples,
                                  const size_t n_samples,
                                  const size_t n_bytes_per_sample,
                                  const size_t n_channels,
                                  const uint32_t samples_per_sec,
                                  const uint32_t /*total_delay_ms*/,
                                  const int32_t /*clock_drift*/,
                                  const uint32_t /*current_mic_level*/,
                                  const bool /*key_pressed*/,
                                  uint32_t& new_mic_level) override {
    new_mic_level = 0;
    const std::int16_t* pcm = static_cast<const std::int16_t*>(audio_samples);
    std::lock_guard<std::mutex> lock(mu_);
    ++calls_;
    if (pcm != nullptr && n_samples * n_channels > 0 && last_first_sample_ == 0 &&
        pcm[0] != 0) {
      last_samples_ = n_samples;
      last_bytes_per_sample_ = n_bytes_per_sample;
      last_channels_ = n_channels;
      last_rate_hz_ = samples_per_sec;
      last_first_sample_ = pcm[0];
      last_second_sample_ = pcm[1];
    }
    cv_.notify_all();
    return 0;
  }

  int32_t NeedMorePlayData(const size_t /*n_samples*/,
                           const size_t /*n_bytes_per_sample*/,
                           const size_t /*n_channels*/,
                           const uint32_t /*samples_per_sec*/,
                           void* /*audio_samples*/,
                           size_t& n_samples_out,
                           int64_t* /*elapsed_time_ms*/,
                           int64_t* /*ntp_time_ms*/) override {
    n_samples_out = 0;
    return 0;
  }

  void PullRenderData(int /*bits_per_sample*/,
                      int /*sample_rate*/,
                      size_t /*number_of_channels*/,
                      size_t /*number_of_frames*/,
                      void* /*audio_data*/,
                      int64_t* /*elapsed_time_ms*/,
                      int64_t* /*ntp_time_ms*/) override {}

  bool WaitForNonZeroFrame(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mu_);
    return cv_.wait_for(lock, timeout,
                        [this] { return last_first_sample_ != 0; });
  }

  std::size_t calls() const {
    std::lock_guard<std::mutex> lock(mu_);
    return calls_;
  }

  void Snapshot(std::size_t& samples,
                std::size_t& bytes_per_sample,
                std::size_t& channels,
                uint32_t& rate_hz,
                std::int16_t& first,
                std::int16_t& second) const {
    std::lock_guard<std::mutex> lock(mu_);
    samples = last_samples_;
    bytes_per_sample = last_bytes_per_sample_;
    channels = last_channels_;
    rate_hz = last_rate_hz_;
    first = last_first_sample_;
    second = last_second_sample_;
  }

  void ResetCalls() {
    std::lock_guard<std::mutex> lock(mu_);
    calls_ = 0;
    last_first_sample_ = 0;
    last_second_sample_ = 0;
  }

 private:
  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::size_t calls_ = 0;
  std::size_t last_samples_ = 0;
  std::size_t last_bytes_per_sample_ = 0;
  std::size_t last_channels_ = 0;
  uint32_t last_rate_hz_ = 0;
  std::int16_t last_first_sample_ = 0;
  std::int16_t last_second_sample_ = 0;
};

void PinnedSdkConstructionAndSingleFrameDelivery() {
  const webrtc::AudioOptions opts = rd::MakeDesktopAudioOptions();
  Check(opts.echo_cancellation == false, "AEC disabled");
  Check(opts.auto_gain_control == false, "AGC disabled");
  Check(opts.noise_suppression == false, "NS disabled");
  Check(opts.highpass_filter == false, "HPF disabled");
  Check(opts.stereo_swapping == false, "stereo_swapping disabled");
  Check(opts.audio_jitter_buffer_fast_accelerate == true,
        "fast accelerate enabled");

  auto buffer = std::make_shared<rd::AudioLoopbackBuffer>();
  // Mirrors worker construction path: webrtc::make_ref_counted<...>.
  webrtc::scoped_refptr<rd::LoopbackAudioDeviceModule> adm =
      webrtc::make_ref_counted<rd::LoopbackAudioDeviceModule>(buffer);
  Check(adm != nullptr, "make_ref_counted<LoopbackAudioDeviceModule> succeeds");

  RecordingAudioTransport transport;
  Check(adm->Init() == 0 && adm->Initialized(), "Init succeeds");
  Check(adm->RecordingDevices() == 1, "one loopback recording device");
  bool rec_avail = false;
  bool stereo_avail = false;
  Check(adm->RecordingIsAvailable(&rec_avail) == 0 && rec_avail,
        "recording available");
  Check(adm->StereoRecordingIsAvailable(&stereo_avail) == 0 && stereo_avail,
        "stereo recording available");
  Check(adm->InitRecording() == 0 && adm->RecordingIsInitialized(),
        "InitRecording succeeds");
  Check(adm->RegisterAudioCallback(&transport) == 0,
        "RegisterAudioCallback succeeds");

  Check(adm->StartRecording() == 0 && adm->Recording(),
        "StartRecording succeeds");

  buffer->SetEnabled(true);
  std::vector<std::int16_t> frame(rd::kAudioFrameSamples);
  for (std::size_t i = 0; i < rd::kAudioFrameSamplesPerChannel; ++i) {
    frame[i * 2 + 0] = 4321;
    frame[i * 2 + 1] = -1234;
  }
  buffer->PushInt16Interleaved(frame.data(), rd::kAudioFrameSamplesPerChannel,
                               rd::kAudioSampleRateHz, 2);

  Check(transport.WaitForNonZeroFrame(std::chrono::milliseconds(500)),
        "pump thread delivers pushed 480-sample 48kHz stereo frame");

  std::size_t n_samples = 0;
  std::size_t n_bytes = 0;
  std::size_t n_channels = 0;
  uint32_t rate_hz = 0;
  std::int16_t l = 0;
  std::int16_t r = 0;
  transport.Snapshot(n_samples, n_bytes, n_channels, rate_hz, l, r);
  Check(n_samples == rd::kAudioFrameSamplesPerChannel,
        "delivered nSamples == 480");
  Check(n_channels == rd::kAudioChannels, "delivered nChannels == 2");
  Check(n_bytes == rd::kAudioChannels * sizeof(std::int16_t),
        "delivered nBytesPerSample == 4");
  Check(rate_hz == rd::kAudioSampleRateHz, "delivered samplesPerSec == 48000");
  Check(l == 4321 && r == -1234, "delivered PCM matches pushed stereo samples");

  Check(adm->StopRecording() == 0 && !adm->Recording(),
        "StopRecording succeeds cleanly");
  const std::size_t calls_after_stop = transport.calls();
  std::this_thread::sleep_for(std::chrono::milliseconds(40));
  Check(transport.calls() == calls_after_stop,
        "zero callbacks fire after StopRecording returns");

  Check(adm->Terminate() == 0 && !adm->Initialized(),
        "Terminate succeeds cleanly");
}

void ConcurrentLifecycleAndTerminateCounterexample() {
  auto buffer = std::make_shared<rd::AudioLoopbackBuffer>();
  auto adm = webrtc::make_ref_counted<rd::LoopbackAudioDeviceModule>(buffer);
  RecordingAudioTransport transport;
  adm->Init();
  adm->RegisterAudioCallback(&transport);
  buffer->SetEnabled(true);

  std::future<bool> done = std::async(std::launch::async, [&]() {
    for (int round = 0; round < 35; ++round) {
      std::atomic<bool> go{false};
      std::thread starter([&]() {
        while (!go.load(std::memory_order_acquire)) {}
        adm->StartRecording();
        buffer->SetEnabled(true);
      });
      std::thread stopper([&]() {
        while (!go.load(std::memory_order_acquire)) {}
        if (round % 5 == 4) {
          adm->Terminate();
          adm->Init();
          adm->RegisterAudioCallback(&transport);
        } else {
          adm->StopRecording();
        }
      });
      go.store(true, std::memory_order_release);
      starter.join();
      stopper.join();
    }
    adm->StopRecording();
    adm->Terminate();
    return true;
  });

  const auto status = done.wait_for(std::chrono::seconds(5));
  Check(status == std::future_status::ready && done.get(),
        "concurrent StartRecording/StopRecording/Terminate never hangs");

  const std::size_t calls_after_terminate = transport.calls();
  std::this_thread::sleep_for(std::chrono::milliseconds(40));
  Check(transport.calls() == calls_after_terminate,
        "zero callbacks after concurrent StopRecording/Terminate");
}

}  // namespace

int main() {
  PinnedSdkConstructionAndSingleFrameDelivery();
  ConcurrentLifecycleAndTerminateCounterexample();

  if (g_failures != 0) {
    std::fprintf(stderr, "%d loopback ADM failure(s)\n", g_failures);
    return EXIT_FAILURE;
  }
  std::printf("remote-desktop common loopback ADM ok\n");
  return EXIT_SUCCESS;
}
