#include "native/remote-desktop-common/audio_loopback_buffer.h"

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
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

void DisabledIgnoresAndClearsBuffer() {
  rd::AudioLoopbackBuffer buffer;
  Check(!buffer.enabled(), "buffer starts disabled by default");

  std::vector<std::int16_t> samples(rd::kAudioFrameSamples, 1234);
  buffer.PushInt16Interleaved(samples.data(), rd::kAudioFrameSamplesPerChannel,
                              rd::kAudioSampleRateHz, 2);
  Check(buffer.BufferedFrames() == 0,
        "pushes while disabled are ignored");

  std::int16_t out[rd::kAudioFrameSamples];
  std::fill_n(out, rd::kAudioFrameSamples, static_cast<std::int16_t>(77));
  Check(!buffer.Pop10msFrame(out), "pop while disabled returns false");
  bool all_zero = true;
  for (std::int16_t v : out) {
    if (v != 0) all_zero = false;
  }
  Check(all_zero, "pop while disabled fills output with zeros");

  buffer.SetEnabled(true);
  buffer.PushInt16Interleaved(samples.data(), rd::kAudioFrameSamplesPerChannel,
                              rd::kAudioSampleRateHz, 2);
  Check(buffer.BufferedFrames() == rd::kAudioFrameSamplesPerChannel,
        "enabled buffer records pushed frames");

  buffer.SetEnabled(false);
  Check(buffer.BufferedFrames() == 0,
        "disabling buffer clears previously buffered stale audio");
}

void Int16StereoMonoAndMultichannel() {
  rd::AudioLoopbackBuffer buffer;
  buffer.SetEnabled(true);

  // Zero / invalid inputs must be harmless no-ops.
  buffer.PushInt16Interleaved(nullptr, 480, 48000, 2);
  buffer.PushInt16Interleaved(nullptr, 0, 48000, 2);
  std::int16_t tiny[2] = {100, -100};
  buffer.PushInt16Interleaved(tiny, 0, 48000, 2);
  buffer.PushInt16Interleaved(tiny, 1, 0, 2);
  buffer.PushInt16Interleaved(tiny, 1, 48000, 0);
  Check(buffer.BufferedFrames() == 0, "invalid pushes leave buffer empty");

  // Mono -> stereo duplication.
  std::vector<std::int16_t> mono(rd::kAudioFrameSamplesPerChannel, 5432);
  buffer.PushInt16Interleaved(mono.data(), rd::kAudioFrameSamplesPerChannel,
                              rd::kAudioSampleRateHz, 1);
  std::int16_t out[rd::kAudioFrameSamples] = {};
  Check(buffer.Pop10msFrame(out), "mono 10ms frame pops cleanly");
  bool mono_ok = true;
  for (std::size_t i = 0; i < rd::kAudioFrameSamples; ++i) {
    if (out[i] != 5432) mono_ok = false;
  }
  Check(mono_ok, "mono sample duplicates into both L and R");

  // 6-channel surround downmix -> takes first 2 channels cleanly.
  std::vector<std::int16_t> six_ch(rd::kAudioFrameSamplesPerChannel * 6, 0);
  for (std::size_t i = 0; i < rd::kAudioFrameSamplesPerChannel; ++i) {
    six_ch[i * 6 + 0] = 111;
    six_ch[i * 6 + 1] = -222;
    six_ch[i * 6 + 2] = 9999;
    six_ch[i * 6 + 3] = 8888;
  }
  buffer.PushInt16Interleaved(six_ch.data(), rd::kAudioFrameSamplesPerChannel,
                              rd::kAudioSampleRateHz, 6);
  Check(buffer.Pop10msFrame(out), "6ch 10ms frame pops cleanly");
  bool six_ok = true;
  for (std::size_t i = 0; i < rd::kAudioFrameSamplesPerChannel; ++i) {
    if (out[i * 2] != 111 || out[i * 2 + 1] != -222) six_ok = false;
  }
  Check(six_ok, "6ch downmix preserves L/R channels cleanly");
}

void Float32PlanarInterleavedNanAndClipping() {
  rd::AudioLoopbackBuffer buffer;
  buffer.SetEnabled(true);

  const float nan = std::numeric_limits<float>::quiet_NaN();
  const float pos_inf = std::numeric_limits<float>::infinity();
  const float neg_inf = -std::numeric_limits<float>::infinity();

  std::vector<float> interleaved(rd::kAudioFrameSamples, 0.0f);
  interleaved[0] = nan;
  interleaved[1] = pos_inf;
  interleaved[2] = neg_inf;
  interleaved[3] = 2.5f;   // clamp -> +32767
  interleaved[4] = -2.5f;  // clamp -> -32767
  interleaved[5] = 0.5f;   // ~16384
  buffer.PushFloat32Interleaved(interleaved.data(),
                                rd::kAudioFrameSamplesPerChannel,
                                rd::kAudioSampleRateHz, 2);

  std::int16_t out[rd::kAudioFrameSamples] = {};
  Check(buffer.Pop10msFrame(out), "float32 interleaved pops cleanly");
  Check(out[0] == 0 && out[1] == 0 && out[2] == 0,
        "NaN and +/-Inf sanitize to 0");
  Check(out[3] == 32767 && out[4] == -32767,
        "out-of-range float32 samples clamp safely");
  Check(out[5] >= 16383 && out[5] <= 16384,
        "in-range float32 sample scales accurately");

  // Planar mono (right == nullptr) and planar stereo.
  std::vector<float> left(rd::kAudioFrameSamplesPerChannel, 0.25f);
  std::vector<float> right(rd::kAudioFrameSamplesPerChannel, -0.25f);
  buffer.PushFloat32Planar(left.data(), nullptr,
                           rd::kAudioFrameSamplesPerChannel,
                           rd::kAudioSampleRateHz);
  Check(buffer.Pop10msFrame(out), "planar mono pops cleanly");
  Check(out[0] == out[1] && out[0] >= 8191 && out[0] <= 8192,
        "planar mono duplicates left into right");

  buffer.PushFloat32Planar(left.data(), right.data(),
                           rd::kAudioFrameSamplesPerChannel,
                           rd::kAudioSampleRateHz);
  Check(buffer.Pop10msFrame(out), "planar stereo pops cleanly");
  Check(out[0] >= 8191 && out[1] <= -8191,
        "planar stereo preserves distinct L/R");
}

void Resamples44100And96000To48000() {
  rd::AudioLoopbackBuffer buffer(48000);
  buffer.SetEnabled(true);

  // Push 100 ms of 44100 Hz stereo ramp in 10 ms (441-frame) chunks -> ~4800 output frames.
  std::vector<std::int16_t> chunk44(441 * 2);
  for (int c = 0; c < 10; ++c) {
    for (int i = 0; i < 441; ++i) {
      const auto val = static_cast<std::int16_t>((c * 441 + i) * 5);
      chunk44[static_cast<std::size_t>(i) * 2] = val;
      chunk44[static_cast<std::size_t>(i) * 2 + 1] = static_cast<std::int16_t>(-val);
    }
    buffer.PushInt16Interleaved(chunk44.data(), 441, 44100, 2);
  }
  const std::size_t buffered44 = buffer.BufferedFrames();
  Check(buffered44 >= 4790 && buffered44 <= 4802,
        "44100Hz 100ms produces ~4800 frames at 48000Hz");

  std::int16_t out[rd::kAudioFrameSamples] = {};
  int popped_chunks = 0;
  std::int16_t prev_l = -1;
  bool monotonic = true;
  while (buffer.Pop10msFrame(out)) {
    ++popped_chunks;
    for (std::size_t i = 0; i < rd::kAudioFrameSamplesPerChannel; ++i) {
      if (out[i * 2] < prev_l || out[i * 2] != static_cast<std::int16_t>(-out[i * 2 + 1])) {
        monotonic = false;
      }
      prev_l = out[i * 2];
    }
  }
  Check(popped_chunks >= 9 && popped_chunks <= 10,
        "44100Hz 100ms pops 9-10 10ms frames cleanly");
  Check(monotonic, "44100Hz->48000Hz resampled ramp stays monotonic and stereo-symmetric");

  // Push 20 ms at 96000 Hz (1920 frames) -> ~960 frames at 48000 Hz.
  buffer.SetEnabled(false);
  buffer.SetEnabled(true);
  std::vector<float> chunk96(1920 * 2, 0.5f);
  buffer.PushFloat32Interleaved(chunk96.data(), 1920, 96000, 2);
  const std::size_t buffered96 = buffer.BufferedFrames();
  Check(buffered96 >= 958 && buffered96 <= 961,
        "96000Hz 20ms downsamples to ~960 frames at 48000Hz");
}

void OverrunDropsOldestAndUnderrunZeroFills() {
  // Capacity 960 frames (20 ms = two 10 ms frames).
  rd::AudioLoopbackBuffer buffer(960);
  buffer.SetEnabled(true);

  auto push_tagged = [&buffer](std::int16_t tag) {
    std::vector<std::int16_t> f(rd::kAudioFrameSamples, tag);
    buffer.PushInt16Interleaved(f.data(), rd::kAudioFrameSamplesPerChannel,
                                rd::kAudioSampleRateHz, 2);
  };
  push_tagged(1);
  push_tagged(2);
  push_tagged(3);  // overruns: drops frame 1, retains 2 and 3

  Check(buffer.BufferedFrames() == 960,
        "overrun caps buffered frames at capacity");

  std::int16_t out[rd::kAudioFrameSamples] = {};
  Check(buffer.Pop10msFrame(out) && out[0] == 2,
        "first popped frame after overrun is newest-minus-one (2)");
  Check(buffer.Pop10msFrame(out) && out[0] == 3,
        "second popped frame after overrun is newest (3)");

  // Now empty: underrun must return false and fill zeros.
  out[0] = 999;
  out[rd::kAudioFrameSamples - 1] = -999;
  Check(!buffer.Pop10msFrame(out), "empty buffer pop returns false");
  bool zeroed = true;
  for (std::int16_t v : out) {
    if (v != 0) zeroed = false;
  }
  Check(zeroed, "underrun fills entire frame with zeros");
}

void ConcurrentProducerConsumerSafety() {
  rd::AudioLoopbackBuffer buffer;
  buffer.SetEnabled(true);
  std::atomic<bool> stop{false};

  std::thread producer([&]() {
    std::vector<float> frame(rd::kAudioFrameSamples, 0.1f);
    for (int i = 0; i < 400; ++i) {
      buffer.PushFloat32Interleaved(frame.data(),
                                    rd::kAudioFrameSamplesPerChannel,
                                    rd::kAudioSampleRateHz, 2);
      if (i == 200) buffer.SetEnabled(false);
      if (i == 220) buffer.SetEnabled(true);
    }
    stop.store(true, std::memory_order_release);
  });

  std::thread consumer([&]() {
    std::int16_t out[rd::kAudioFrameSamples];
    while (!stop.load(std::memory_order_acquire)) {
      buffer.Pop10msFrame(out);
    }
  });

  producer.join();
  consumer.join();
  Check(buffer.enabled(), "concurrent producer/consumer completes without deadlock");
}

void SetEnabledSynchronizedZeroStaleFramesCounterexample() {
  rd::AudioLoopbackBuffer buffer;
  std::vector<std::int16_t> stale(rd::kAudioFrameSamples, 0x1234);
  std::atomic<bool> leaked_stale{false};

  for (int round = 0; round < 200 && !leaked_stale.load(); ++round) {
    buffer.SetEnabled(true);
    buffer.PushInt16Interleaved(stale.data(), rd::kAudioFrameSamplesPerChannel,
                                rd::kAudioSampleRateHz, 2);

    std::atomic<bool> go{false};
    std::thread pusher([&]() {
      while (!go.load(std::memory_order_acquire)) {}
      for (int i = 0; i < 8; ++i) {
        buffer.PushInt16Interleaved(stale.data(),
                                    rd::kAudioFrameSamplesPerChannel,
                                    rd::kAudioSampleRateHz, 2);
      }
    });
    std::thread cycler([&]() {
      while (!go.load(std::memory_order_acquire)) {}
      buffer.SetEnabled(false);
    });
    go.store(true, std::memory_order_release);
    pusher.join();
    cycler.join();

    // After disabling + draining any concurrent pusher, re-enabling under lock
    // must guarantee an empty buffer with zero leftover stale 0x1234 frames.
    buffer.SetEnabled(true);
    std::int16_t out[rd::kAudioFrameSamples] = {};
    if (buffer.Pop10msFrame(out)) {
      leaked_stale.store(true, std::memory_order_relaxed);
    }
    buffer.SetEnabled(false);
  }
  Check(!leaked_stale.load(),
        "SetEnabled clears ring synchronously without stale-frame leak");
}

}  // namespace

int main() {
  DisabledIgnoresAndClearsBuffer();
  Int16StereoMonoAndMultichannel();
  Float32PlanarInterleavedNanAndClipping();
  Resamples44100And96000To48000();
  OverrunDropsOldestAndUnderrunZeroFills();
  ConcurrentProducerConsumerSafety();
  SetEnabledSynchronizedZeroStaleFramesCounterexample();

  if (g_failures != 0) {
    std::fprintf(stderr, "%d audio loopback buffer failure(s)\n", g_failures);
    return EXIT_FAILURE;
  }
  std::printf("remote-desktop common audio loopback buffer ok\n");
  return EXIT_SUCCESS;
}
