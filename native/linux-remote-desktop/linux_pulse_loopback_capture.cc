#include "linux_pulse_loopback_capture.h"

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <poll.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include <array>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

extern char** environ;

namespace imcodes::remote_desktop::linux_platform {
namespace {

std::mutex& SelfHelperMutex() {
  static std::mutex* mu = new std::mutex();
  return *mu;
}

std::string& SelfHelperExecutableStorage() {
  static std::string* path = new std::string();
  return *path;
}

volatile sig_atomic_t g_helper_stop = 0;

void OnHelperStopSignal(int) { g_helper_stop = 1; }

bool ParseStrictPositiveUint(const char* raw, unsigned long* out) {
  if (raw == nullptr || raw[0] == '\0') return false;
  for (const unsigned char* p = reinterpret_cast<const unsigned char*>(raw);
       *p != '\0'; ++p) {
    if (!std::isdigit(*p)) return false;
  }
  errno = 0;
  char* end = nullptr;
  unsigned long val = std::strtoul(raw, &end, 10);
  if (errno != 0 || end == raw || *end != '\0' || val == 0) return false;
  *out = val;
  return true;
}

bool ValidateAudioIdentityEnv(bool* out_has_identity,
                              uid_t* out_uid,
                              gid_t* out_gid) {
  *out_has_identity = false;
  const char* uid_env = std::getenv(kEnvAudioUid);
  const char* gid_env = std::getenv(kEnvAudioGid);
  const bool has_uid = uid_env != nullptr && uid_env[0] != '\0';
  const bool has_gid = gid_env != nullptr && gid_env[0] != '\0';
  if (!has_uid && !has_gid) {
    return true;
  }
  if (!has_uid || !has_gid) {
    return false;
  }
  unsigned long uid_val = 0;
  unsigned long gid_val = 0;
  if (!ParseStrictPositiveUint(uid_env, &uid_val) ||
      !ParseStrictPositiveUint(gid_env, &gid_val)) {
    return false;
  }
  const uid_t target_uid = static_cast<uid_t>(uid_val);
  const gid_t target_gid = static_cast<gid_t>(gid_val);
  const uid_t euid = ::geteuid();
  if (euid != 0 && euid != target_uid) {
    return false;
  }
  *out_has_identity = true;
  *out_uid = target_uid;
  *out_gid = target_gid;
  return true;
}

bool DropToTargetIdentityIfNeeded(bool* out_has_identity,
                                  uid_t* out_uid) {
  bool has_identity = false;
  uid_t target_uid = 0;
  gid_t target_gid = 0;
  if (!ValidateAudioIdentityEnv(&has_identity, &target_uid, &target_gid)) {
    return false;
  }
  *out_has_identity = has_identity;
  *out_uid = target_uid;
  if (!has_identity) {
    return true;
  }
  const char* home_env = std::getenv(kEnvAudioHome);
  if (home_env != nullptr && home_env[0] != '\0') {
    ::setenv("HOME", home_env, 1);
  }
  if (::geteuid() == 0) {
    if (::setgroups(0, nullptr) != 0) return false;
    if (::setgid(target_gid) != 0) return false;
    if (::setuid(target_uid) != 0) return false;
  }
  return ::getuid() == target_uid && ::geteuid() == target_uid &&
         ::getgid() == target_gid && ::getegid() == target_gid;
}

bool NonEmptyEnv(const char* name, std::string* out) {
  const char* val = std::getenv(name);
  if (val == nullptr || val[0] == '\0') return false;
  if (out != nullptr) *out = val;
  return true;
}

enum class RuntimeAuthCheckResult {
  kAuthorized,
  kNotReadyRetry,
  kUnauthorized,
  kDisabled,
};

std::string JoinPulseNativeSocket(std::string runtime_dir) {
  while (runtime_dir.size() > 1 && runtime_dir.back() == '/') {
    runtime_dir.pop_back();
  }
  return runtime_dir == "/" ? "/pulse/native"
                            : runtime_dir + "/pulse/native";
}

RuntimeAuthCheckResult CheckDirAndSocket(const std::string& runtime_dir,
                                           const std::string& socket_path,
                                           uid_t expected_uid) {
  struct stat st{};
  if (::lstat(runtime_dir.c_str(), &st) != 0) {
    if (errno == ENOENT || errno == ENOTDIR) {
      return RuntimeAuthCheckResult::kNotReadyRetry;
    }
    return RuntimeAuthCheckResult::kUnauthorized;
  }
  if (!S_ISDIR(st.st_mode) || st.st_uid != expected_uid) {
    return RuntimeAuthCheckResult::kUnauthorized;
  }

  struct stat sock_st{};
  if (::lstat(socket_path.c_str(), &sock_st) != 0) {
    if (errno == ENOENT || errno == ENOTDIR) {
      return RuntimeAuthCheckResult::kNotReadyRetry;
    }
    return RuntimeAuthCheckResult::kUnauthorized;
  }
  if (!S_ISSOCK(sock_st.st_mode) || sock_st.st_uid != expected_uid) {
    return RuntimeAuthCheckResult::kUnauthorized;
  }
  return RuntimeAuthCheckResult::kAuthorized;
}

RuntimeAuthCheckResult VerifyAuthorizedAudioEndpoint(
    bool has_identity,
    uid_t target_uid,
    std::string* out_explicit_server) {
  out_explicit_server->clear();

  std::string policy;
  const bool has_policy = NonEmptyEnv(kEnvAudioPolicy, &policy);
  if (has_policy && policy == kAudioPolicyDisabled) {
    return RuntimeAuthCheckResult::kDisabled;
  }

  std::string pulse_server;
  std::string xdg_runtime;
  std::string expected_runtime_dir;
  std::string expected_socket;
  const bool has_pulse_server = NonEmptyEnv("PULSE_SERVER", &pulse_server);
  const bool has_xdg = NonEmptyEnv("XDG_RUNTIME_DIR", &xdg_runtime);
  const bool has_runtime_dir = NonEmptyEnv(kEnvAudioRuntimeDir, &expected_runtime_dir);
  const bool has_socket = NonEmptyEnv(kEnvAudioSocket, &expected_socket);
  const bool has_any_internal =
      has_policy || has_identity || has_runtime_dir || has_socket;

  const uid_t expected_uid = has_identity ? target_uid : ::geteuid();

  if (has_any_internal) {
    if (policy == kAudioPolicyManaged) {
      if (!has_identity || !has_runtime_dir || !has_socket) {
        return RuntimeAuthCheckResult::kUnauthorized;
      }
      const RuntimeAuthCheckResult res =
          CheckDirAndSocket(expected_runtime_dir, expected_socket, expected_uid);
      if (res != RuntimeAuthCheckResult::kAuthorized) {
        return res;
      }
      *out_explicit_server = std::string("unix:") + expected_socket;
      return RuntimeAuthCheckResult::kAuthorized;
    }
    if (policy == kAudioPolicyUser) {
      if (!has_runtime_dir || !has_socket) {
        return RuntimeAuthCheckResult::kUnauthorized;
      }
      const RuntimeAuthCheckResult res =
          CheckDirAndSocket(expected_runtime_dir, expected_socket, expected_uid);
      if (res != RuntimeAuthCheckResult::kAuthorized) {
        return res;
      }
      *out_explicit_server = std::string("unix:") + expected_socket;
      return RuntimeAuthCheckResult::kAuthorized;
    }
    // Any incomplete or unknown internal authorization state must fail closed
    // instead of falling back to XDG_RUNTIME_DIR or Pulse default discovery.
    return RuntimeAuthCheckResult::kUnauthorized;
  }

  if (has_pulse_server) {
    *out_explicit_server = pulse_server;
    return RuntimeAuthCheckResult::kAuthorized;
  }

  if (has_xdg) {
    const std::string derived_socket = JoinPulseNativeSocket(xdg_runtime);
    const RuntimeAuthCheckResult res =
        CheckDirAndSocket(xdg_runtime, derived_socket, expected_uid);
    if (res != RuntimeAuthCheckResult::kAuthorized) {
      return res;
    }
    *out_explicit_server = std::string("unix:") + derived_socket;
    return RuntimeAuthCheckResult::kAuthorized;
  }

  return RuntimeAuthCheckResult::kDisabled;
}

bool WriteAllFd(int fd, const void* data, std::size_t size) {
  const auto* cursor = static_cast<const std::uint8_t*>(data);
  std::size_t remaining = size;
  while (remaining > 0) {
    if (g_helper_stop) return false;
    const ssize_t written = ::write(fd, cursor, remaining);
    if (written > 0) {
      cursor += written;
      remaining -= static_cast<std::size_t>(written);
      continue;
    }
    if (written < 0 && errno == EINTR) continue;
    return false;
  }
  return true;
}

int TerminateAndReapChild(pid_t pid, std::chrono::milliseconds grace) {
  if (pid <= 0) return -1;
  int status = 0;
  pid_t waited = ::waitpid(pid, &status, WNOHANG);
  if (waited == pid) return status;

  ::kill(pid, SIGTERM);
  const auto deadline = std::chrono::steady_clock::now() + grace;
  while (std::chrono::steady_clock::now() < deadline) {
    waited = ::waitpid(pid, &status, WNOHANG);
    if (waited == pid) return status;
    if (waited < 0 && errno != EINTR) return -1;
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  ::kill(pid, SIGKILL);
  for (;;) {
    waited = ::waitpid(pid, &status, 0);
    if (waited == pid) return status;
    if (waited < 0 && errno != EINTR) return -1;
  }
}

void CloseFdIfOpen(int* fd) {
  if (*fd >= 0) {
    ::close(*fd);
    *fd = -1;
  }
}

bool WaitWakeOrTimeout(int wake_rd_fd, std::chrono::milliseconds duration) {
  if (wake_rd_fd < 0) return true;
  struct pollfd pfd{wake_rd_fd, POLLIN, 0};
  const auto deadline = std::chrono::steady_clock::now() + duration;
  for (;;) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) return false;
    const int rem_ms = static_cast<int>(
        std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now)
            .count());
    const int wait_ms = rem_ms > 0 ? rem_ms : 1;
    const int rc = ::poll(&pfd, 1, wait_ms);
    if (rc > 0) return true;
    if (rc == 0) return false;
    if (errno != EINTR) return true;
  }
}

}  // namespace

PulseSimpleApi LoadPulseSimpleApi() {
  void* handle = dlopen("libpulse-simple.so.0", RTLD_LAZY | RTLD_LOCAL);
  if (handle == nullptr) {
    return {};
  }
  auto new_fn = reinterpret_cast<PulseSimpleApi::NewFn>(
      dlsym(handle, "pa_simple_new"));
  auto read_fn = reinterpret_cast<PulseSimpleApi::ReadFn>(
      dlsym(handle, "pa_simple_read"));
  auto free_fn = reinterpret_cast<PulseSimpleApi::FreeFn>(
      dlsym(handle, "pa_simple_free"));
  if (new_fn == nullptr || read_fn == nullptr || free_fn == nullptr) {
    dlclose(handle);
    return {};
  }
  PulseSimpleApi api;
  api.pa_simple_new = new_fn;
  api.pa_simple_read = read_fn;
  api.pa_simple_free = free_fn;
  api.release_library = [handle]() { dlclose(handle); };
  return api;
}

void EnableSelfAudioCaptureHelper(std::string executable_path) {
  std::lock_guard<std::mutex> lock(SelfHelperMutex());
  SelfHelperExecutableStorage() = std::move(executable_path);
}

int RunPulseCaptureHelperMain(int, char**, PulseApiLoader api_loader) {
  ::signal(SIGPIPE, SIG_IGN);
  struct sigaction sa{};
  sa.sa_handler = OnHelperStopSignal;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = 0;  // Do not set SA_RESTART so stop signals interrupt cleanly.
  ::sigaction(SIGTERM, &sa, nullptr);
  ::sigaction(SIGINT, &sa, nullptr);

  bool has_identity = false;
  uid_t target_uid = 0;
  if (!DropToTargetIdentityIfNeeded(&has_identity, &target_uid)) {
    return kHelperExitUnauthorized;
  }
  // Arm PR_SET_PDEATHSIG *after* setgid/setuid because Linux clears pdeathsig
  // on credential changes.
  ::prctl(PR_SET_PDEATHSIG, SIGKILL);
  const char* ppid_env = std::getenv(kEnvAudioPpid);
  unsigned long expected_ppid = 0;
  if (ppid_env != nullptr && ppid_env[0] != '\0' &&
      ParseStrictPositiveUint(ppid_env, &expected_ppid) &&
      static_cast<pid_t>(expected_ppid) != ::getppid()) {
    return 0;
  }

  std::string explicit_server;
  const RuntimeAuthCheckResult auth_res = VerifyAuthorizedAudioEndpoint(
      has_identity, target_uid, &explicit_server);
  if (auth_res == RuntimeAuthCheckResult::kDisabled) {
    return kHelperExitDisabled;
  }
  if (auth_res == RuntimeAuthCheckResult::kNotReadyRetry) {
    return kHelperExitConnectOrReadFailed;
  }
  if (auth_res != RuntimeAuthCheckResult::kAuthorized ||
      explicit_server.empty()) {
    return kHelperExitUnauthorized;
  }

  PulseSimpleApi api = api_loader ? api_loader() : LoadPulseSimpleApi();
  if (!api.valid()) {
    return kHelperExitMissingPulseLibrary;
  }
  struct ApiGuard {
    PulseSimpleApi* api;
    ~ApiGuard() {
      if (api->release_library) {
        api->release_library();
      }
    }
  } api_guard{&api};

  const PulseSampleSpec sample_spec{
      kPulseSampleS16Le,
      static_cast<std::uint32_t>(imcodes::rd::kAudioSampleRateHz),
      static_cast<std::uint8_t>(imcodes::rd::kAudioChannels),
  };
  const PulseBufferAttr buffer_attr{
      static_cast<std::uint32_t>(-1),
      static_cast<std::uint32_t>(-1),
      static_cast<std::uint32_t>(-1),
      static_cast<std::uint32_t>(-1),
      static_cast<std::uint32_t>(kPulseChunkBytes),
  };

  int pa_error = 0;
  PulseSimpleHandle* handle = api.pa_simple_new(
      explicit_server.c_str(), "imcodes-rd", kPulseStreamRecord,
      kPulseDefaultMonitorDevice, "system-audio", &sample_spec, nullptr,
      &buffer_attr, &pa_error);
  if (handle == nullptr) {
    return kHelperExitConnectOrReadFailed;
  }

  std::array<std::int16_t, imcodes::rd::kAudioFrameSamples> pcm{};
  int exit_code = 0;
  while (!g_helper_stop) {
    int read_error = 0;
    const int rc =
        api.pa_simple_read(handle, pcm.data(), kPulseChunkBytes, &read_error);
    if (rc < 0) {
      if (!g_helper_stop) {
        exit_code = kHelperExitConnectOrReadFailed;
      }
      break;
    }
    if (g_helper_stop) break;
    if (!WriteAllFd(STDOUT_FILENO, pcm.data(), kPulseChunkBytes)) {
      break;
    }
  }

  api.pa_simple_free(handle);
  return exit_code;
}

LinuxPulseLoopbackCapture::LinuxPulseLoopbackCapture(
    std::shared_ptr<imcodes::rd::AudioLoopbackBuffer> buffer,
    PulseApiLoader api_loader,
    std::chrono::milliseconds retry_backoff,
    CaptureSubprocessSpec subprocess_spec)
    : buffer_(std::move(buffer)),
      api_loader_(std::move(api_loader)),
      retry_backoff_(retry_backoff.count() > 0
                         ? retry_backoff
                         : std::chrono::milliseconds(1)),
      subprocess_spec_(std::move(subprocess_spec)) {
  if (!buffer_) {
    buffer_ = std::make_shared<imcodes::rd::AudioLoopbackBuffer>();
  }
  if (!api_loader_ && subprocess_spec_.executable_path.empty()) {
    std::lock_guard<std::mutex> lock(SelfHelperMutex());
    const std::string& self_exe = SelfHelperExecutableStorage();
    if (!self_exe.empty()) {
      subprocess_spec_.executable_path = self_exe;
      subprocess_spec_.args = {kAudioCaptureHelperArg};
    }
  }
  if (!api_loader_ && subprocess_spec_.executable_path.empty()) {
    api_loader_ = LoadPulseSimpleApi;
  }
}

LinuxPulseLoopbackCapture::~LinuxPulseLoopbackCapture() { SetEnabled(false); }

void LinuxPulseLoopbackCapture::SetEnabled(bool enabled) {
  std::shared_ptr<RunState> prev_run;
  std::thread prev_thread;
  {
    std::lock_guard<std::mutex> lock(lifecycle_mu_);
    if (enabled_.load(std::memory_order_acquire) == enabled) {
      return;
    }
    enabled_.store(enabled, std::memory_order_release);
    if (!enabled) {
      prev_run = std::move(active_run_);
      prev_thread = std::move(capture_thread_);
    } else {
      auto state = std::make_shared<RunState>();
      if (!subprocess_spec_.executable_path.empty()) {
        int wake_fds[2] = {-1, -1};
        if (::pipe2(wake_fds, O_NONBLOCK | O_CLOEXEC) != 0) {
          enabled_.store(false, std::memory_order_release);
          return;
        }
        state->wake_rd_fd = wake_fds[0];
        state->wake_wr_fd = wake_fds[1];
        active_run_ = state;
        capture_thread_ = std::thread(&LinuxPulseLoopbackCapture::SubprocessCaptureLoop,
                                      this, std::move(state), subprocess_spec_);
      } else {
        active_run_ = state;
        capture_thread_ = std::thread(&LinuxPulseLoopbackCapture::CaptureLoop,
                                      this, std::move(state));
      }
      return;
    }
  }
  if (prev_run) {
    {
      std::lock_guard<std::mutex> run_lock(prev_run->mu);
      prev_run->stop = true;
    }
    if (prev_run->wake_wr_fd >= 0) {
      const char byte = 1;
      (void)::write(prev_run->wake_wr_fd, &byte, 1);
    }
    prev_run->cv.notify_all();
  }
  if (prev_thread.joinable()) {
    prev_thread.join();
  }
  if (prev_run) {
    CloseFdIfOpen(&prev_run->wake_rd_fd);
    CloseFdIfOpen(&prev_run->wake_wr_fd);
  }
}

void LinuxPulseLoopbackCapture::SubprocessCaptureLoop(
    std::shared_ptr<RunState> state,
    CaptureSubprocessSpec spec) {
  std::string policy;
  if (NonEmptyEnv(kEnvAudioPolicy, &policy) &&
      policy == kAudioPolicyDisabled) {
    return;
  }
  bool dummy_has_id = false;
  uid_t dummy_uid = 0;
  gid_t dummy_gid = 0;
  if (!ValidateAudioIdentityEnv(&dummy_has_id, &dummy_uid, &dummy_gid)) {
    return;
  }

  std::vector<std::string> env_storage;
  const std::string ppid_entry =
      std::string(kEnvAudioPpid) + "=" + std::to_string(::getpid());
  const std::string ppid_prefix = std::string(kEnvAudioPpid) + "=";
  for (char** envp = environ; envp != nullptr && *envp != nullptr; ++envp) {
    std::string entry(*envp);
    if (entry.rfind(ppid_prefix, 0) == 0) continue;
    env_storage.push_back(std::move(entry));
  }
  env_storage.push_back(ppid_entry);

  std::vector<char*> child_env;
  child_env.reserve(env_storage.size() + 1);
  for (std::string& s : env_storage) {
    child_env.push_back(s.data());
  }
  child_env.push_back(nullptr);

  std::vector<std::string> argv_storage;
  argv_storage.push_back(spec.executable_path);
  for (const std::string& arg : spec.args) {
    argv_storage.push_back(arg);
  }
  std::vector<char*> child_argv;
  child_argv.reserve(argv_storage.size() + 1);
  for (std::string& s : argv_storage) {
    child_argv.push_back(s.data());
  }
  child_argv.push_back(nullptr);

  std::array<std::uint8_t, kPulseChunkBytes> partial{};
  std::size_t partial_bytes = 0;

  while (true) {
    {
      std::lock_guard<std::mutex> lock(state->mu);
      if (state->stop) break;
    }

    int out_fds[2] = {-1, -1};
    if (::pipe2(out_fds, O_CLOEXEC) != 0) {
      if (WaitWakeOrTimeout(state->wake_rd_fd, retry_backoff_)) break;
      continue;
    }
    const int flags = ::fcntl(out_fds[0], F_GETFL, 0);
    if (flags >= 0) {
      (void)::fcntl(out_fds[0], F_SETFL, flags | O_NONBLOCK);
    }

    open_attempts_.fetch_add(1, std::memory_order_relaxed);
    const pid_t pid = ::fork();
    if (pid < 0) {
      ::close(out_fds[0]);
      ::close(out_fds[1]);
      if (WaitWakeOrTimeout(state->wake_rd_fd, retry_backoff_)) break;
      continue;
    }
    if (pid == 0) {
      ::prctl(PR_SET_PDEATHSIG, SIGKILL);
      ::dup2(out_fds[1], STDOUT_FILENO);
      ::close(out_fds[0]);
      ::close(out_fds[1]);
      ::execve(spec.executable_path.c_str(), child_argv.data(),
               child_env.data());
      ::_exit(127);
    }

    ::close(out_fds[1]);
    int read_fd = out_fds[0];
    partial_bytes = 0;

    bool stop_requested = false;
    bool missing_lib_or_unauth = false;

    while (true) {
      {
        std::lock_guard<std::mutex> lock(state->mu);
        if (state->stop) {
          stop_requested = true;
          break;
        }
      }

      struct pollfd pfds[2] = {
          {read_fd, POLLIN, 0},
          {state->wake_rd_fd, POLLIN, 0},
      };
      const int prc = ::poll(pfds, 2, -1);
      if (prc < 0) {
        if (errno == EINTR) continue;
        stop_requested = true;
        break;
      }
      if (pfds[1].revents & (POLLIN | POLLERR | POLLHUP)) {
        stop_requested = true;
        break;
      }
      if (pfds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
        bool eof = false;
        while (true) {
          const ssize_t got =
              ::read(read_fd, partial.data() + partial_bytes,
                     kPulseChunkBytes - partial_bytes);
          if (got > 0) {
            partial_bytes += static_cast<std::size_t>(got);
            if (partial_bytes == kPulseChunkBytes) {
              buffer_->PushInt16Interleaved(
                  reinterpret_cast<const std::int16_t*>(partial.data()),
                  kPulseChunkFrames, imcodes::rd::kAudioSampleRateHz,
                  static_cast<int>(imcodes::rd::kAudioChannels));
              frames_captured_.fetch_add(kPulseChunkFrames,
                                         std::memory_order_relaxed);
              partial_bytes = 0;
            }
            continue;
          }
          if (got == 0) {
            eof = true;
            break;
          }
          if (errno == EINTR) continue;
          if (errno == EAGAIN || errno == EWOULDBLOCK) break;
          eof = true;
          break;
        }
        if (eof) break;
      }
    }

    ::close(read_fd);
    const int status =
        TerminateAndReapChild(pid, spec.stop_grace);
    if (stop_requested) break;
    {
      std::lock_guard<std::mutex> lock(state->mu);
      if (state->stop) break;
    }
    if (WIFEXITED(status)) {
      const int code = WEXITSTATUS(status);
      if (code == kHelperExitMissingPulseLibrary ||
          code == kHelperExitDisabled ||
          code == kHelperExitUnauthorized) {
        missing_lib_or_unauth = true;
      }
    }
    if (missing_lib_or_unauth) break;
    if (WaitWakeOrTimeout(state->wake_rd_fd, retry_backoff_)) break;
  }
}

void LinuxPulseLoopbackCapture::CaptureLoop(std::shared_ptr<RunState> state) {
  PulseSimpleApi api = api_loader_ ? api_loader_() : LoadPulseSimpleApi();
  if (!api.valid()) {
    return;
  }
  struct ApiGuard {
    PulseSimpleApi* api;
    ~ApiGuard() {
      if (api->release_library) {
        api->release_library();
      }
    }
  } api_guard{&api};

  const PulseSampleSpec sample_spec{
      kPulseSampleS16Le,
      static_cast<std::uint32_t>(imcodes::rd::kAudioSampleRateHz),
      static_cast<std::uint8_t>(imcodes::rd::kAudioChannels),
  };
  const PulseBufferAttr buffer_attr{
      static_cast<std::uint32_t>(-1),
      static_cast<std::uint32_t>(-1),
      static_cast<std::uint32_t>(-1),
      static_cast<std::uint32_t>(-1),
      static_cast<std::uint32_t>(kPulseChunkBytes),
  };
  std::array<std::int16_t, imcodes::rd::kAudioFrameSamples> pcm{};

  const auto wait_backoff = [&]() {
    std::unique_lock<std::mutex> lock(state->mu);
    state->cv.wait_for(lock, retry_backoff_,
                       [&state] { return state->stop; });
  };

  while (true) {
    {
      std::lock_guard<std::mutex> lock(state->mu);
      if (state->stop) break;
    }

    open_attempts_.fetch_add(1, std::memory_order_relaxed);
    int pa_error = 0;
    PulseSimpleHandle* handle = api.pa_simple_new(
        nullptr, "imcodes-rd", kPulseStreamRecord, kPulseDefaultMonitorDevice,
        "system-audio", &sample_spec, nullptr, &buffer_attr, &pa_error);
    if (handle == nullptr) {
      wait_backoff();
      continue;
    }

    while (true) {
      {
        std::lock_guard<std::mutex> lock(state->mu);
        if (state->stop) break;
      }
      int read_error = 0;
      const int rc =
          api.pa_simple_read(handle, pcm.data(), kPulseChunkBytes, &read_error);
      if (rc < 0) {
        break;
      }
      {
        std::lock_guard<std::mutex> lock(state->mu);
        if (state->stop) break;
      }
      buffer_->PushInt16Interleaved(
          pcm.data(), kPulseChunkFrames, imcodes::rd::kAudioSampleRateHz,
          static_cast<int>(imcodes::rd::kAudioChannels));
      frames_captured_.fetch_add(kPulseChunkFrames, std::memory_order_relaxed);
    }

    api.pa_simple_free(handle);

    {
      std::lock_guard<std::mutex> lock(state->mu);
      if (state->stop) break;
    }
    wait_backoff();
  }
}

LinuxAudioCaptureCoordinator::LinuxAudioCaptureCoordinator(
    std::shared_ptr<imcodes::rd::AudioLoopbackBuffer> buffer,
    PulseApiLoader api_loader,
    std::chrono::milliseconds retry_backoff,
    CaptureSubprocessSpec subprocess_spec)
    : buffer_(buffer ? std::move(buffer)
                     : std::make_shared<imcodes::rd::AudioLoopbackBuffer>()),
      capture_(buffer_, std::move(api_loader), retry_backoff,
               std::move(subprocess_spec)) {}

void LinuxAudioCaptureCoordinator::AcquireSessionAudio() {
  bool start = false;
  {
    std::lock_guard<std::mutex> lock(mu_);
    start = (active_sessions_ == 0);
    ++active_sessions_;
  }
  if (start) {
    buffer_->SetEnabled(true);
    capture_.SetEnabled(true);
  }
}

void LinuxAudioCaptureCoordinator::ReleaseSessionAudio() {
  bool stop = false;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (active_sessions_ == 0) return;
    --active_sessions_;
    stop = (active_sessions_ == 0);
  }
  if (stop) {
    // Disable consumer buffer first so playback/WebRTC sees immediate silence
    // regardless of subprocess teardown timing.
    buffer_->SetEnabled(false);
    capture_.SetEnabled(false);
  }
}

}  // namespace imcodes::remote_desktop::linux_platform
