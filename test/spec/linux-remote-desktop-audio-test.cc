#include "native/linux-remote-desktop/linux_pulse_loopback_capture.h"
#include "native/remote-desktop-common/data_channel_payload.h"

#include <errno.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace {

namespace lp = imcodes::remote_desktop::linux_platform;
namespace rd = imcodes::rd;

int g_failures = 0;

void Check(bool condition, const char* label) {
  if (condition) return;
  ++g_failures;
  std::fprintf(stderr, "FAIL: %s\n", label);
}

struct MockPulseState {
  std::atomic<bool> allow_open{true};
  std::atomic<int> read_rc{0};
  std::atomic<int> new_calls{0};
  std::atomic<int> read_calls{0};
  std::atomic<int> free_calls{0};
  std::atomic<bool> saw_non_monitor_dev{false};
  std::atomic<bool> saw_bad_format{false};
  std::atomic<bool> release_called{false};
  std::string last_server;
  std::int16_t fill_sample = 1234;
  std::chrono::milliseconds read_delay{2};
};

MockPulseState* g_mock = nullptr;
lp::PulseSimpleHandle* kFakeHandle =
    reinterpret_cast<lp::PulseSimpleHandle*>(static_cast<std::uintptr_t>(0x1234));

lp::PulseSimpleHandle* MockNew(const char* server,
                               const char* /* name */,
                               std::int32_t dir,
                               const char* dev,
                               const char* /* stream_name */,
                               const lp::PulseSampleSpec* ss,
                               const void* /* map */,
                               const lp::PulseBufferAttr* attr,
                               int* error) {
  g_mock->new_calls.fetch_add(1, std::memory_order_relaxed);
  g_mock->last_server = server != nullptr ? server : "";
  if (dev == nullptr || std::strcmp(dev, lp::kPulseDefaultMonitorDevice) != 0) {
    g_mock->saw_non_monitor_dev.store(true);
  }
  if (dir != lp::kPulseStreamRecord || ss == nullptr ||
      ss->format != lp::kPulseSampleS16Le ||
      ss->rate != static_cast<std::uint32_t>(rd::kAudioSampleRateHz) ||
      ss->channels != static_cast<std::uint8_t>(rd::kAudioChannels) ||
      attr == nullptr ||
      attr->fragsize != static_cast<std::uint32_t>(lp::kPulseChunkBytes)) {
    g_mock->saw_bad_format.store(true);
  }
  if (!g_mock->allow_open.load(std::memory_order_acquire)) {
    if (error != nullptr) *error = 111;
    return nullptr;
  }
  return kFakeHandle;
}

int MockRead(lp::PulseSimpleHandle* /* s */,
             void* data,
             std::size_t bytes,
             int* error) {
  g_mock->read_calls.fetch_add(1, std::memory_order_relaxed);
  if (g_mock->read_delay.count() > 0) {
    std::this_thread::sleep_for(g_mock->read_delay);
  }
  const int rc = g_mock->read_rc.load(std::memory_order_acquire);
  if (rc < 0) {
    if (error != nullptr) *error = 5;
    return rc;
  }
  auto* samples = static_cast<std::int16_t*>(data);
  const std::size_t count = bytes / sizeof(std::int16_t);
  for (std::size_t i = 0; i < count; ++i) {
    samples[i] = g_mock->fill_sample;
  }
  return 0;
}

void MockFree(lp::PulseSimpleHandle* s) {
  Check(s == kFakeHandle, "pa_simple_free receives opened handle");
  g_mock->free_calls.fetch_add(1, std::memory_order_relaxed);
}

lp::PulseSimpleApi MakeMockApi() {
  lp::PulseSimpleApi api;
  api.pa_simple_new = &MockNew;
  api.pa_simple_read = &MockRead;
  api.pa_simple_free = &MockFree;
  api.release_library = []() { g_mock->release_called.store(true); };
  return api;
}

void TestMissingPulseLibraryGracefulFallback() {
  auto buffer = std::make_shared<rd::AudioLoopbackBuffer>();
  lp::LinuxPulseLoopbackCapture capture(
      buffer, []() { return lp::PulseSimpleApi{}; },
      std::chrono::milliseconds(10));
  buffer->SetEnabled(true);
  capture.SetEnabled(true);
  std::this_thread::sleep_for(std::chrono::milliseconds(30));
  Check(capture.enabled(), "capture reports enabled even without library");
  std::int16_t out[rd::kAudioFrameSamples];
  Check(!buffer->Pop10msFrame(out), "missing library keeps buffer empty/silent");
  capture.SetEnabled(false);
  buffer->SetEnabled(false);
  Check(!capture.enabled(), "capture stops cleanly after missing library");
}

void TestUnreachableServerBoundedBackoffAndFastStop() {
  MockPulseState state;
  state.allow_open.store(false);
  g_mock = &state;

  auto buffer = std::make_shared<rd::AudioLoopbackBuffer>();
  lp::LinuxPulseLoopbackCapture capture(
      buffer, MakeMockApi, std::chrono::milliseconds(2000));
  buffer->SetEnabled(true);
  capture.SetEnabled(true);
  std::this_thread::sleep_for(std::chrono::milliseconds(80));
  Check(state.new_calls.load() == 1,
        "unreachable pulse daemon opens once then waits 2s backoff (no spin)");
  Check(!state.saw_non_monitor_dev.load(),
        "unreachable retry still specifies @DEFAULT_MONITOR@");

  const auto start = std::chrono::steady_clock::now();
  capture.SetEnabled(false);
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - start);
  Check(elapsed.count() < 500,
        "SetEnabled(false) interrupts 2s retry backoff cleanly");
  Check(state.release_called.load(), "library handle released on stop");
  g_mock = nullptr;
}

void TestCoordinatorRefcountingAndPcmFlow() {
  MockPulseState state;
  state.allow_open.store(true);
  state.fill_sample = 4321;
  g_mock = &state;

  lp::LinuxAudioCaptureCoordinator coord(
      std::make_shared<rd::AudioLoopbackBuffer>(), MakeMockApi,
      std::chrono::milliseconds(20));

  Check(coord.active_sessions() == 0, "coordinator starts with 0 leases");
  Check(!coord.buffer()->enabled(), "buffer starts disabled");

  coord.AcquireSessionAudio();
  Check(coord.active_sessions() == 1, "first acquire bumps active_sessions to 1");
  Check(coord.buffer()->enabled(), "first acquire enables buffer");

  const auto wait_for_frame = [&]() -> bool {
    for (int i = 0; i < 100; ++i) {
      std::int16_t out[rd::kAudioFrameSamples];
      if (coord.buffer()->Pop10msFrame(out)) {
        Check(out[0] == 4321 && out[rd::kAudioFrameSamples - 1] == 4321,
              "captured stereo PCM matches mock monitor samples");
        return true;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    return false;
  };
  Check(wait_for_frame(), "receives 10ms monitor PCM chunks when enabled");
  Check(!state.saw_non_monitor_dev.load(),
        "Capture always targets @DEFAULT_MONITOR@ and never nullptr/microphone");
  Check(!state.saw_bad_format.load(),
        "Capture uses 48kHz stereo S16LE with 1920-byte fragsize");

  // Second concurrent session acquires audio: refcount goes to 2; releasing one
  // keeps capture alive.
  coord.AcquireSessionAudio();
  Check(coord.active_sessions() == 2, "second acquire bumps active_sessions to 2");
  coord.ReleaseSessionAudio();
  Check(coord.active_sessions() == 1, "releasing one session keeps 1 lease");
  Check(coord.capture().enabled(), "capture remains enabled while 1 lease active");
  Check(wait_for_frame(), "second reader still receives monitor PCM after first leaves");

  // Releasing last session stops capture cleanly.
  coord.ReleaseSessionAudio();
  Check(coord.active_sessions() == 0, "final release drops active_sessions to 0");
  Check(!coord.capture().enabled(), "capture stops when active_sessions hits 0");
  Check(!coord.buffer()->enabled(), "buffer disabled when active_sessions hits 0");
  Check(state.free_calls.load() == 1, "pa_simple_free called once on final stop");

  // Extra defensive ReleaseSessionAudio stays clamped at 0.
  coord.ReleaseSessionAudio();
  Check(coord.active_sessions() == 0, "extra release stays clamped at 0");
  g_mock = nullptr;
}

void TestReadErrorRetriesAndRecovers() {
  MockPulseState state;
  state.allow_open.store(true);
  state.read_rc.store(-1);
  g_mock = &state;

  lp::LinuxAudioCaptureCoordinator coord(
      std::make_shared<rd::AudioLoopbackBuffer>(), MakeMockApi,
      std::chrono::milliseconds(15));
  coord.AcquireSessionAudio();
  for (int i = 0; i < 60 && state.free_calls.load() == 0; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  Check(state.free_calls.load() >= 1,
        "read error closes broken pa_simple handle before retry");

  state.read_rc.store(0);
  bool recovered = false;
  for (int i = 0; i < 80; ++i) {
    std::int16_t out[rd::kAudioFrameSamples];
    if (coord.buffer()->Pop10msFrame(out)) {
      recovered = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  Check(recovered, "capture recovers after backoff when server comes back");
  coord.ReleaseSessionAudio();
  g_mock = nullptr;
}

pid_t ReadPidFileWithRetry(const std::string& path) {
  for (int i = 0; i < 100; ++i) {
    FILE* f = std::fopen(path.c_str(), "r");
    if (f) {
      long pid = 0;
      const int n = std::fscanf(f, "%ld", &pid);
      std::fclose(f);
      if (n == 1 && pid > 0) return static_cast<pid_t>(pid);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return -1;
}

void TestSubprocessHungOpenAndReadCancelWithinDeadline() {
  for (const char* mode : {"--mock-hung-open", "--mock-hung-read"}) {
    char pid_tmpl[] = "/tmp/imcodes-audio-helper-pid-XXXXXX";
    const int fd = ::mkstemp(pid_tmpl);
    Check(fd >= 0, "mkstemp pid file succeeds");
    if (fd >= 0) ::close(fd);
    ::unlink(pid_tmpl);
    ::setenv("IMCODES_TEST_HELPER_PID_FILE", pid_tmpl, 1);

    lp::CaptureSubprocessSpec spec;
    spec.executable_path = "/proc/self/exe";
    spec.args = {lp::kAudioCaptureHelperArg, mode};
    spec.stop_grace = std::chrono::milliseconds(40);

    lp::LinuxAudioCaptureCoordinator coord(
        std::make_shared<rd::AudioLoopbackBuffer>(), {},
        std::chrono::milliseconds(2000), std::move(spec));

    coord.AcquireSessionAudio();
    const pid_t child_pid = ReadPidFileWithRetry(pid_tmpl);
    Check(child_pid > 0,
          "subprocess helper started and entered blocking pulse call");
    std::this_thread::sleep_for(std::chrono::milliseconds(60));

    const auto start = std::chrono::steady_clock::now();
    coord.ReleaseSessionAudio();
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start);

    Check(elapsed.count() < 350,
          "ReleaseSessionAudio cancels wedged pa_simple_new/read within bounded deadline");
    Check(coord.active_sessions() == 0,
          "active_sessions drops to 0 after wedged capture release");
    Check(!coord.buffer()->enabled(),
          "buffer is disabled immediately when wedged capture stops");
    Check(!coord.capture().enabled(),
          "capture is disabled after bounded teardown");
    if (child_pid > 0) {
      int status = 0;
      const pid_t wr = ::waitpid(child_pid, &status, WNOHANG);
      Check(wr == -1 && errno == ECHILD,
            "helper child process is terminated and reaped (no zombie)");
      Check(::kill(child_pid, 0) == -1 && errno == ESRCH,
            "helper child pid no longer exists in process table");
    }
    ::unsetenv("IMCODES_TEST_HELPER_PID_FILE");
    ::unlink(pid_tmpl);
  }
}

void TestSubprocessStreamsPcmAndReapsCleanly() {
  lp::CaptureSubprocessSpec spec;
  spec.executable_path = "/proc/self/exe";
  spec.args = {lp::kAudioCaptureHelperArg, "--mock-stream-pcm"};
  spec.stop_grace = std::chrono::milliseconds(40);

  lp::LinuxAudioCaptureCoordinator coord(
      std::make_shared<rd::AudioLoopbackBuffer>(), {},
      std::chrono::milliseconds(200), std::move(spec));
  coord.AcquireSessionAudio();

  bool got_pcm = false;
  for (int i = 0; i < 100; ++i) {
    std::int16_t out[rd::kAudioFrameSamples];
    if (coord.buffer()->Pop10msFrame(out)) {
      if (out[0] == 7777 && out[rd::kAudioFrameSamples - 1] == 7777) {
        got_pcm = true;
        break;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  Check(got_pcm, "subprocess helper streams 48kHz stereo PCM into AudioLoopbackBuffer");
  Check(coord.capture().frames_captured() >= lp::kPulseChunkFrames,
        "subprocess capture increments frames_captured");
  coord.ReleaseSessionAudio();
  Check(!coord.buffer()->enabled() && !coord.capture().enabled(),
        "subprocess streaming coordinator stops cleanly");
}

void TestUnauthorizedOrDisabledHelperRefusesImplicitPulse() {
  MockPulseState state;
  state.allow_open.store(true);
  g_mock = &state;

  // 1) Completely missing authorization (no PULSE_SERVER, XDG_RUNTIME_DIR, or managed socket)
  ::unsetenv(lp::kEnvAudioPolicy);
  ::unsetenv(lp::kEnvAudioUid);
  ::unsetenv(lp::kEnvAudioGid);
  ::unsetenv(lp::kEnvAudioHome);
  ::unsetenv(lp::kEnvAudioRuntimeDir);
  ::unsetenv(lp::kEnvAudioSocket);
  ::unsetenv("PULSE_SERVER");
  ::unsetenv("XDG_RUNTIME_DIR");
  char* argv_dummy[] = {const_cast<char*>("helper"),
                        const_cast<char*>(lp::kAudioCaptureHelperArg), nullptr};
  int rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
  Check(rc == lp::kHelperExitDisabled,
        "helper exits disabled when no authorization or runtime env is present");
  Check(state.new_calls.load() == 0,
        "helper never calls pa_simple_new(nullptr) without authorization");

  // 2) Explicit disabled policy blocks connection even when ambient PULSE_SERVER/XDG exists
  ::setenv("PULSE_SERVER", "unix:/tmp/ambient-pulse", 1);
  ::setenv("XDG_RUNTIME_DIR", "/tmp", 1);
  ::setenv(lp::kEnvAudioPolicy, lp::kAudioPolicyDisabled, 1);
  rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
  Check(rc == lp::kHelperExitDisabled,
        "explicit disabled policy stops helper even when ambient Pulse env is set");
  Check(state.new_calls.load() == 0,
        "explicit disabled policy never calls pa_simple_new");
  ::unsetenv(lp::kEnvAudioPolicy);
  ::unsetenv("PULSE_SERVER");
  ::unsetenv("XDG_RUNTIME_DIR");

  // 3) Managed policy: missing socket returns retryable (79) without connecting;
  //    wrong file type (regular file) returns unauthorized (126);
  //    real matching unix socket connects cleanly!
  char dir_tmpl[] = "/tmp/imcodes-audio-rt-XXXXXX";
  char* rt_dir = ::mkdtemp(dir_tmpl);
  Check(rt_dir != nullptr, "mkdtemp runtime dir succeeds");
  if (rt_dir != nullptr) {
    const std::string sock_path = std::string(rt_dir) + "/pulse-native";
    const std::string uid_str =
        std::to_string(::geteuid() == 0 ? 1000 : ::geteuid());
    const std::string gid_str =
        std::to_string(::getegid() == 0 ? 1000 : ::getegid());
    if (::geteuid() != 0) {
      ::setenv(lp::kEnvAudioPolicy, lp::kAudioPolicyManaged, 1);
      ::setenv(lp::kEnvAudioUid, uid_str.c_str(), 1);
      ::setenv(lp::kEnvAudioGid, gid_str.c_str(), 1);
      ::setenv(lp::kEnvAudioRuntimeDir, rt_dir, 1);
      ::setenv(lp::kEnvAudioSocket, sock_path.c_str(), 1);

      rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
      Check(rc == lp::kHelperExitConnectOrReadFailed,
            "managed policy returns retryable (79) before socket is created");
      Check(state.new_calls.load() == 0,
            "missing managed socket does not call pa_simple_new");

      // Non-socket file at socket path -> unauthorized (126)
      if (FILE* f = std::fopen(sock_path.c_str(), "w")) {
        std::fclose(f);
      }
      rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
      Check(rc == lp::kHelperExitUnauthorized,
            "non-socket path fails closed as unauthorized (126)");
      Check(state.new_calls.load() == 0,
            "non-socket path does not call pa_simple_new");
      ::unlink(sock_path.c_str());

      // Real AF_UNIX socket owned by matching uid -> authorized and connects
      const int sfd = ::socket(AF_UNIX, SOCK_STREAM, 0);
      struct sockaddr_un addr{};
      addr.sun_family = AF_UNIX;
      std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", sock_path.c_str());
      const int bind_rc = ::bind(sfd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr));
      Check(bind_rc == 0, "bind real unix socket succeeds");
      state.read_rc.store(-1);  // stop after 1 read so RunPulseCaptureHelperMain returns quickly
      rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
      Check(state.new_calls.load() == 1,
            "matching socket authorizes pa_simple_new");
      Check(state.last_server == std::string("unix:") + sock_path,
            "matching socket passes explicit unix: server rather than nullptr");
      if (sfd >= 0) ::close(sfd);
      ::unlink(sock_path.c_str());

      // Incomplete internal env (only IMCODES_RD_AUDIO_RUNTIME_DIR or missing socket):
      // fails closed as unauthorized with zero pa_simple_new calls.
      ::unsetenv(lp::kEnvAudioPolicy);
      ::unsetenv(lp::kEnvAudioUid);
      ::unsetenv(lp::kEnvAudioGid);
      ::unsetenv(lp::kEnvAudioSocket);
      ::setenv(lp::kEnvAudioRuntimeDir, rt_dir, 1);
      state.new_calls.store(0);
      rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
      Check(rc == lp::kHelperExitUnauthorized,
            "runtime-dir-only internal env without policy/socket fails closed (126)");
      Check(state.new_calls.load() == 0,
            "incomplete internal runtime-dir-only never calls pa_simple_new");

      ::setenv(lp::kEnvAudioPolicy, lp::kAudioPolicyManaged, 1);
      ::setenv(lp::kEnvAudioUid, uid_str.c_str(), 1);
      ::setenv(lp::kEnvAudioGid, gid_str.c_str(), 1);
      rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
      Check(rc == lp::kHelperExitUnauthorized,
            "managed policy missing socket fails closed (126)");
      Check(state.new_calls.load() == 0,
            "managed policy missing socket never calls pa_simple_new");

      ::unsetenv(lp::kEnvAudioUid);
      ::unsetenv(lp::kEnvAudioGid);
      ::setenv(lp::kEnvAudioPolicy, lp::kAudioPolicyUser, 1);
      rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
      Check(rc == lp::kHelperExitUnauthorized,
            "user policy missing socket fails closed (126)");
      Check(state.new_calls.load() == 0,
            "user policy missing socket never calls pa_simple_new");

      ::setenv(lp::kEnvAudioPolicy, "bogus", 1);
      rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
      Check(rc == lp::kHelperExitUnauthorized,
            "unknown policy fails closed (126)");
      Check(state.new_calls.load() == 0,
            "unknown policy never calls pa_simple_new");

      // Explicit complete user policy with real socket connects with unix:<socket>
      const int usfd = ::socket(AF_UNIX, SOCK_STREAM, 0);
      struct sockaddr_un uaddr{};
      uaddr.sun_family = AF_UNIX;
      std::snprintf(uaddr.sun_path, sizeof(uaddr.sun_path), "%s", sock_path.c_str());
      const int ubind_rc =
          ::bind(usfd, reinterpret_cast<struct sockaddr*>(&uaddr), sizeof(uaddr));
      Check(ubind_rc == 0, "bind user unix socket succeeds");
      ::setenv(lp::kEnvAudioPolicy, lp::kAudioPolicyUser, 1);
      ::setenv(lp::kEnvAudioSocket, sock_path.c_str(), 1);
      state.read_rc.store(-1);
      state.last_server.clear();
      rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
      Check(state.new_calls.load() == 1,
            "complete user policy with real socket calls pa_simple_new once");
      Check(state.last_server == std::string("unix:") + sock_path,
            "user policy passes explicit unix: server");
      if (usfd >= 0) ::close(usfd);
      ::unlink(sock_path.c_str());

      ::unsetenv(lp::kEnvAudioPolicy);
      ::unsetenv(lp::kEnvAudioRuntimeDir);
      ::unsetenv(lp::kEnvAudioSocket);
    }
    ::rmdir(rt_dir);
  }

  // Explicit PULSE_SERVER without internal policy preserves explicit server string
  ::setenv("PULSE_SERVER", "unix:/tmp/explicit-pulse-override", 1);
  state.new_calls.store(0);
  state.read_rc.store(-1);
  state.last_server.clear();
  rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
  Check(state.new_calls.load() == 1,
        "explicit PULSE_SERVER override authorizes pa_simple_new");
  Check(state.last_server == "unix:/tmp/explicit-pulse-override",
        "explicit PULSE_SERVER passes through verbatim");
  ::unsetenv("PULSE_SERVER");

  // 4) XDG_RUNTIME_DIR-only must validate dir + derive <xdg>/pulse/native and pass explicit unix:
  //    Never calls pa_simple_new(nullptr) when missing or wrong type/ownership!
  if (::geteuid() != 0) {
    ::setenv("XDG_RUNTIME_DIR", "/tmp/imcodes-nonexistent-xdg-runtime-dir", 1);
    state.new_calls.store(0);
    rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
    Check(rc == lp::kHelperExitConnectOrReadFailed,
          "XDG-only nonexistent runtime dir returns retryable (79) without connecting");
    Check(state.new_calls.load() == 0,
          "XDG-only nonexistent runtime dir never calls pa_simple_new(nullptr)");

    // Wrong owner directory (/tmp is owned by root uid 0, current euid != 0)
    ::setenv("XDG_RUNTIME_DIR", "/tmp", 1);
    rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
    Check(rc == lp::kHelperExitUnauthorized,
          "XDG-only wrong-owner runtime dir fails closed as unauthorized (126)");
    Check(state.new_calls.load() == 0,
          "XDG-only wrong-owner runtime dir never calls pa_simple_new");

    char xdg_tmpl[] = "/tmp/imcodes-audio-xdg-XXXXXX";
    char* xdg_dir = ::mkdtemp(xdg_tmpl);
    Check(xdg_dir != nullptr, "mkdtemp xdg runtime dir succeeds");
    if (xdg_dir != nullptr) {
      const std::string pulse_subdir = std::string(xdg_dir) + "/pulse";
      const std::string xdg_sock = pulse_subdir + "/native";
      Check(::mkdir(pulse_subdir.c_str(), 0700) == 0, "mkdir pulse subdir succeeds");
      ::setenv("XDG_RUNTIME_DIR", xdg_dir, 1);

      // Missing <xdg>/pulse/native -> retryable 79, 0 pa_simple_new
      rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
      Check(rc == lp::kHelperExitConnectOrReadFailed,
            "XDG-only without pulse/native returns retryable (79)");
      Check(state.new_calls.load() == 0,
            "XDG-only without pulse/native never calls pa_simple_new");

      // Non-socket <xdg>/pulse/native -> unauthorized 126, 0 pa_simple_new
      if (FILE* f = std::fopen(xdg_sock.c_str(), "w")) {
        std::fclose(f);
      }
      rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
      Check(rc == lp::kHelperExitUnauthorized,
            "XDG-only non-socket pulse/native fails closed (126)");
      Check(state.new_calls.load() == 0,
            "XDG-only non-socket pulse/native never calls pa_simple_new");
      ::unlink(xdg_sock.c_str());

      // Valid owned <xdg>/pulse/native unix socket -> connects with explicit unix:<xdg>/pulse/native
      const int xsfd = ::socket(AF_UNIX, SOCK_STREAM, 0);
      struct sockaddr_un xaddr{};
      xaddr.sun_family = AF_UNIX;
      std::snprintf(xaddr.sun_path, sizeof(xaddr.sun_path), "%s", xdg_sock.c_str());
      const int xbind_rc =
          ::bind(xsfd, reinterpret_cast<struct sockaddr*>(&xaddr), sizeof(xaddr));
      Check(xbind_rc == 0, "bind XDG unix socket succeeds");
      state.read_rc.store(-1);
      state.last_server.clear();
      rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
      Check(state.new_calls.load() == 1,
            "valid XDG-only socket authorizes exactly 1 pa_simple_new");
      Check(state.last_server == std::string("unix:") + xdg_sock,
            "valid XDG-only connects with explicit unix:<xdg>/pulse/native");
      if (xsfd >= 0) ::close(xsfd);
      ::unlink(xdg_sock.c_str());
      ::rmdir(pulse_subdir.c_str());
      ::rmdir(xdg_dir);
    }
    ::unsetenv("XDG_RUNTIME_DIR");
  }

  // 5) Wrong UID always fails closed
  if (::geteuid() != 0) {
    const std::string wrong_uid = std::to_string(::geteuid() + 1000);
    ::setenv(lp::kEnvAudioUid, wrong_uid.c_str(), 1);
    ::setenv(lp::kEnvAudioGid, wrong_uid.c_str(), 1);
    rc = lp::RunPulseCaptureHelperMain(2, argv_dummy, MakeMockApi);
    Check(rc == lp::kHelperExitUnauthorized,
          "non-matching IMCODES_RD_AUDIO_UID fails closed with unauthorized code");
  }
  ::unsetenv(lp::kEnvAudioPolicy);
  ::unsetenv(lp::kEnvAudioUid);
  ::unsetenv(lp::kEnvAudioGid);
  ::unsetenv(lp::kEnvAudioHome);
  ::unsetenv(lp::kEnvAudioRuntimeDir);
  ::unsetenv(lp::kEnvAudioSocket);
  g_mock = nullptr;
}

void TestSetAudioPayloadParses() {
  rd::DataChannelMessage msg;
  const std::string payload =
      R"({"protocolVersion":2,"sessionId":"s1","sequence":1,"layoutRevision":1,"inputEpoch":0,"type":"remote_desktop.data.control","kind":"set_audio","enabled":true})";
  Check(rd::ParseDataChannelMessage(payload, &msg), "set_audio true parses");
  Check(msg.kind == rd::DataChannelMessageKind::kControl &&
            msg.control.kind == rd::kSetAudioKind &&
            msg.control.enabled == true,
        "set_audio control fields decoded");
}

int RunMockSubprocessHelper(int argc, char** argv) {
  const std::string mode = argc >= 3 ? argv[2] : "";
  if (const char* pid_path = std::getenv("IMCODES_TEST_HELPER_PID_FILE")) {
    if (FILE* f = std::fopen(pid_path, "w")) {
      std::fprintf(f, "%ld\n", static_cast<long>(::getpid()));
      std::fclose(f);
    }
  }
  auto loader = [mode]() -> lp::PulseSimpleApi {
    lp::PulseSimpleApi api;
    api.pa_simple_new = [](const char*, const char*, std::int32_t, const char*,
                           const char*, const lp::PulseSampleSpec*, const void*,
                           const lp::PulseBufferAttr*, int*) -> lp::PulseSimpleHandle* {
      if (const char* env_mode = std::getenv("IMCODES_TEST_HELPER_MODE")) {
        if (std::strcmp(env_mode, "--mock-hung-open") == 0) {
          for (;;) {
            ::sleep(60);
          }
        }
      }
      return reinterpret_cast<lp::PulseSimpleHandle*>(
          static_cast<std::uintptr_t>(0x5678));
    };
    api.pa_simple_read = [](lp::PulseSimpleHandle*, void* data,
                            std::size_t bytes, int*) -> int {
      if (const char* env_mode = std::getenv("IMCODES_TEST_HELPER_MODE")) {
        if (std::strcmp(env_mode, "--mock-hung-read") == 0) {
          for (;;) {
            ::sleep(60);
          }
        }
      }
      auto* samples = static_cast<std::int16_t*>(data);
      const std::size_t n = bytes / sizeof(std::int16_t);
      for (std::size_t i = 0; i < n; ++i) samples[i] = 7777;
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      return 0;
    };
    api.pa_simple_free = [](lp::PulseSimpleHandle*) {};
    return api;
  };
  ::setenv("IMCODES_TEST_HELPER_MODE", mode.c_str(), 1);
  ::setenv("PULSE_SERVER", "unix:/tmp/imcodes-mock-pulse", 1);
  ::unsetenv("XDG_RUNTIME_DIR");
  ::unsetenv(lp::kEnvAudioPolicy);
  return lp::RunPulseCaptureHelperMain(argc, argv, loader);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc >= 2 && std::strcmp(argv[1], lp::kAudioCaptureHelperArg) == 0) {
    return RunMockSubprocessHelper(argc, argv);
  }
  ::signal(SIGPIPE, SIG_IGN);
  TestMissingPulseLibraryGracefulFallback();
  TestUnreachableServerBoundedBackoffAndFastStop();
  TestCoordinatorRefcountingAndPcmFlow();
  TestReadErrorRetriesAndRecovers();
  TestSubprocessHungOpenAndReadCancelWithinDeadline();
  TestSubprocessStreamsPcmAndReapsCleanly();
  TestUnauthorizedOrDisabledHelperRefusesImplicitPulse();
  TestSetAudioPayloadParses();
  if (g_failures > 0) {
    std::fprintf(stderr, "linux audio test failed: %d assertions\n", g_failures);
    return 1;
  }
  std::printf("linux remote desktop pulse loopback audio: ok\n");
  return 0;
}
