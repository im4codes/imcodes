#ifndef IMCODES_REMOTE_DESKTOP_LINUX_LINUX_PULSE_LOOPBACK_CAPTURE_H_
#define IMCODES_REMOTE_DESKTOP_LINUX_LINUX_PULSE_LOOPBACK_CAPTURE_H_

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../remote-desktop-common/audio_loopback_buffer.h"

namespace imcodes::remote_desktop::linux_platform {

struct PulseSimpleHandle;

// Stable PulseAudio / pipewire-pulse C ABI subset (avoids a hard build-time
// dependency on libpulse-dev headers inside the pinned Chromium sysroot).
inline constexpr std::int32_t kPulseSampleS16Le = 3;  // PA_SAMPLE_S16LE
inline constexpr std::int32_t kPulseStreamRecord = 2;  // PA_STREAM_RECORD
inline constexpr char kPulseDefaultMonitorDevice[] = "@DEFAULT_MONITOR@";
inline constexpr std::size_t kPulseChunkFrames =
    imcodes::rd::kAudioFrameSamplesPerChannel;  // 480 frames = 10 ms @ 48 kHz
inline constexpr std::size_t kPulseChunkBytes =
    kPulseChunkFrames * imcodes::rd::kAudioChannels * sizeof(std::int16_t);

// Controlled same-binary subprocess entrypoint & identity handoff env keys.
inline constexpr char kAudioCaptureHelperArg[] = "--audio-capture-helper";
inline constexpr char kEnvAudioPolicy[] = "IMCODES_RD_AUDIO_POLICY";
inline constexpr char kAudioPolicyDisabled[] = "disabled";
inline constexpr char kAudioPolicyManaged[] = "managed";
inline constexpr char kAudioPolicyUser[] = "user";
inline constexpr char kEnvAudioUid[] = "IMCODES_RD_AUDIO_UID";
inline constexpr char kEnvAudioGid[] = "IMCODES_RD_AUDIO_GID";
inline constexpr char kEnvAudioHome[] = "IMCODES_RD_AUDIO_HOME";
inline constexpr char kEnvAudioRuntimeDir[] = "IMCODES_RD_AUDIO_RUNTIME_DIR";
inline constexpr char kEnvAudioSocket[] = "IMCODES_RD_AUDIO_SOCKET";
inline constexpr char kEnvAudioPpid[] = "IMCODES_RD_AUDIO_PPID";
inline constexpr int kHelperExitMissingPulseLibrary = 78;
inline constexpr int kHelperExitConnectOrReadFailed = 79;
inline constexpr int kHelperExitDisabled = 80;
inline constexpr int kHelperExitUnauthorized = 126;

struct PulseSampleSpec {
  std::int32_t format;
  std::uint32_t rate;
  std::uint8_t channels;
};

struct PulseBufferAttr {
  std::uint32_t maxlength;
  std::uint32_t tlength;
  std::uint32_t prebuf;
  std::uint32_t minreq;
  std::uint32_t fragsize;
};

struct PulseSimpleApi {
  using NewFn = PulseSimpleHandle* (*)(const char* server,
                                       const char* name,
                                       std::int32_t dir,
                                       const char* dev,
                                       const char* stream_name,
                                       const PulseSampleSpec* ss,
                                       const void* map,
                                       const PulseBufferAttr* attr,
                                       int* error);
  using ReadFn = int (*)(PulseSimpleHandle* s,
                         void* data,
                         std::size_t bytes,
                         int* error);
  using FreeFn = void (*)(PulseSimpleHandle* s);

  NewFn pa_simple_new = nullptr;
  ReadFn pa_simple_read = nullptr;
  FreeFn pa_simple_free = nullptr;
  std::function<void()> release_library;

  [[nodiscard]] bool valid() const noexcept {
    return pa_simple_new != nullptr && pa_simple_read != nullptr &&
           pa_simple_free != nullptr;
  }
};

using PulseApiLoader = std::function<PulseSimpleApi()>;

struct CaptureSubprocessSpec {
  std::string executable_path;
  std::vector<std::string> args;
  std::chrono::milliseconds stop_grace = std::chrono::milliseconds(50);
};

// Dynamically loads `libpulse-simple.so.0` via dlopen/dlsym (returns invalid
// api without crashing if unavailable on headless hosts).
PulseSimpleApi LoadPulseSimpleApi();

// Opts the current binary into controlled same-binary subprocess capture
// (`kAudioCaptureHelperArg`). Binaries calling this must dispatch
// `RunPulseCaptureHelperMain(argc, argv)` at the very start of `main()`.
void EnableSelfAudioCaptureHelper(std::string executable_path = "/proc/self/exe");

// Helper subprocess entry point: drops to requested desktop UID/GID when
// authorized, binds parent-death signal, opens `@DEFAULT_MONITOR@` via
// `LoadPulseSimpleApi()`, and streams raw 48 kHz stereo S16LE PCM to stdout.
int RunPulseCaptureHelperMain(int argc, char** argv,
                              PulseApiLoader api_loader = {});

/**
 * Pure interface for session-level refcounted audio capture leases so
 * `LinuxRemoteDesktopSession` can control capture without adding hard link
 * dependencies on `dlopen` when unit-tested standalone.
 */
class LinuxAudioCaptureLeaseTarget {
 public:
  virtual ~LinuxAudioCaptureLeaseTarget() = default;
  virtual void AcquireSessionAudio() = 0;
  virtual void ReleaseSessionAudio() = 0;
};

/**
 * Captures system output monitor audio (`@DEFAULT_MONITOR@`, never microphone)
 * via dynamically loaded `libpulse-simple.so.0` (PulseAudio or pipewire-pulse)
 * into `AudioLoopbackBuffer` at 48 kHz stereo Int16 (10 ms chunks).
 *
 * When subprocess mode is active (default for worker/qualification binaries),
 * blocking `pa_simple_new` / `pa_simple_read` calls run inside a dedicated,
 * privilege-matched child process while the parent reads PCM non-blockingly and
 * enforces bounded SIGTERM -> SIGKILL + waitpid teardown.
 */
class LinuxPulseLoopbackCapture {
 public:
  explicit LinuxPulseLoopbackCapture(
      std::shared_ptr<imcodes::rd::AudioLoopbackBuffer> buffer,
      PulseApiLoader api_loader = {},
      std::chrono::milliseconds retry_backoff = std::chrono::milliseconds(2000),
      CaptureSubprocessSpec subprocess_spec = {});
  ~LinuxPulseLoopbackCapture();

  LinuxPulseLoopbackCapture(const LinuxPulseLoopbackCapture&) = delete;
  LinuxPulseLoopbackCapture& operator=(const LinuxPulseLoopbackCapture&) =
      delete;

  void SetEnabled(bool enabled);
  [[nodiscard]] bool enabled() const noexcept {
    return enabled_.load(std::memory_order_acquire);
  }
  [[nodiscard]] std::uint64_t frames_captured() const noexcept {
    return frames_captured_.load(std::memory_order_relaxed);
  }
  [[nodiscard]] std::uint64_t open_attempts() const noexcept {
    return open_attempts_.load(std::memory_order_relaxed);
  }

 private:
  struct RunState {
    std::mutex mu;
    std::condition_variable cv;
    bool stop = false;
    int wake_rd_fd = -1;
    int wake_wr_fd = -1;
  };

  void CaptureLoop(std::shared_ptr<RunState> state);
  void SubprocessCaptureLoop(std::shared_ptr<RunState> state,
                             CaptureSubprocessSpec spec);

  std::shared_ptr<imcodes::rd::AudioLoopbackBuffer> buffer_;
  PulseApiLoader api_loader_;
  std::chrono::milliseconds retry_backoff_;
  CaptureSubprocessSpec subprocess_spec_;

  mutable std::mutex lifecycle_mu_;
  std::shared_ptr<RunState> active_run_;
  std::thread capture_thread_;
  std::atomic<bool> enabled_{false};
  std::atomic<std::uint64_t> frames_captured_{0};
  std::atomic<std::uint64_t> open_attempts_{0};
};

/**
 * Process-wide coordinator owning a shared `AudioLoopbackBuffer` and
 * `LinuxPulseLoopbackCapture`, starting capture when the first session enables
 * audio and stopping buffer + capture cleanly when the last enabled session
 * stops or disables.
 */
class LinuxAudioCaptureCoordinator final : public LinuxAudioCaptureLeaseTarget {
 public:
  explicit LinuxAudioCaptureCoordinator(
      std::shared_ptr<imcodes::rd::AudioLoopbackBuffer> buffer =
          std::make_shared<imcodes::rd::AudioLoopbackBuffer>(),
      PulseApiLoader api_loader = {},
      std::chrono::milliseconds retry_backoff = std::chrono::milliseconds(2000),
      CaptureSubprocessSpec subprocess_spec = {});
  ~LinuxAudioCaptureCoordinator() override = default;

  LinuxAudioCaptureCoordinator(const LinuxAudioCaptureCoordinator&) = delete;
  LinuxAudioCaptureCoordinator& operator=(const LinuxAudioCaptureCoordinator&) =
      delete;

  [[nodiscard]] std::shared_ptr<imcodes::rd::AudioLoopbackBuffer> buffer()
      const noexcept {
    return buffer_;
  }
  [[nodiscard]] std::size_t active_sessions() const noexcept {
    std::lock_guard<std::mutex> lock(mu_);
    return active_sessions_;
  }
  [[nodiscard]] const LinuxPulseLoopbackCapture& capture() const noexcept {
    return capture_;
  }

  void AcquireSessionAudio() override;
  void ReleaseSessionAudio() override;

 private:
  mutable std::mutex mu_;
  std::shared_ptr<imcodes::rd::AudioLoopbackBuffer> buffer_;
  LinuxPulseLoopbackCapture capture_;
  std::size_t active_sessions_ = 0;
};

}  // namespace imcodes::remote_desktop::linux_platform

#endif  // IMCODES_REMOTE_DESKTOP_LINUX_LINUX_PULSE_LOOPBACK_CAPTURE_H_
