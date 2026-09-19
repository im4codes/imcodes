// Signed active-user worker entry point.
//
// Three responsibilities, in admission order:
//   1. Serve the daemon's exact non-interactive readiness/cleanup commands and
//      the separate user-invoked TCC registration command.
//   2. On an ordinary launch, read the fixed LaunchAgent environment, connect
//      to the protected Unix socket, send the exact hello, and run a bounded
//      newline frame loop driving MacosRemoteDesktopSession.
//   3. Supervise the separate signed disclosure component and refuse route
//      admission whenever it is not showing a visible window.
//
// This process never receives, reads or persists a controlled-node credential.
// Its only inputs are argv, the fixed environment the plist installs, and
// frames from the socket the host already protected.

#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <IOKit/pwr_mgt/IOPMLib.h>

#include <fcntl.h>
#include <mach-o/dyld.h>
#include <poll.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sysexits.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <iostream>
#include <memory>
#include <map>
#include <mutex>
#include <optional>
#include <thread>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "../remote-desktop-common/data_channel_payload.h"
#include "../remote-desktop-common/json_protocol.h"
#include "macos_authenticated_session_readiness.h"
#include "macos_disclosure_control.h"
#include "cg_display_stream_backend.h"
#include "macos_host_command_dispatch.h"
#include "macos_login_window_capture.h"
#include "macos_session_identity.h"
#include "macos_media_sender_binder.h"
#include "macos_native_command_v1.h"
#include "macos_permission_onboarding.h"
#include "macos_permission_readiness.h"
#include "macos_remote_desktop_session.h"
#include "macos_session_monitor.h"
#include "macos_transport_session_adapter.h"
#include "macos_virtual_display_adapter.h"
#include "macos_virtual_display_daemon_backend.h"
#include "macos_virtual_display_helper_backend.h"
#include "macos_virtual_display_helper_binding.h"
#include "macos_virtual_display_skylight.h"
#include "macos_virtual_display_version_gate.h"
#include "macos_worker_control.h"
#include "macos_worker_ipc_client.h"
#include "ns_pasteboard_clipboard_adapter.h"
#include "pinned_libwebrtc_transport_backend.h"
#include "video_toolbox_h264_encoder.h"

namespace {

namespace rd = imcodes::remote_desktop;
namespace macos = imcodes::remote_desktop::macos;

// One definition, in the header that also owns the dispatch reading it.
constexpr const char* kLaunchAgentArgument = macos::kAiDeskLaunchAgentArgument;
constexpr std::size_t kReadChunkBytes = 8 * 1024;
// Matches MACOS_VIRTUAL_DISPLAY_PROXY_TIMEOUT_MS on the daemon side. A silent
// agent is a false answer, so the wait is bounded on both ends.
constexpr std::uint32_t kDaemonDisplayTimeoutMs = 5'000;
// A graphical bootstrap is not authority until the daemon has authenticated
// the exact socket peer. Waiting is bounded so a silent or partially writing
// daemon cannot keep a LoginWindow worker resident indefinitely.
constexpr std::uint32_t kGraphicalAuthenticationTimeoutMs = 5'000;
constexpr char kDisclosureFileName[] = "imcodes-remote-desktop-disclosure";
constexpr char kVirtualDisplayHelperFileName[] = "imcodes-virtual-display-helper";
// The component manifest name and the executable-directory lookup were the
// last users of the removed self-attestation path: a worker reading its own
// sibling manifest to vouch for the helper it was about to trust. Nothing
// references them now, and the authority tests pin that the path stays gone.


// MacosPermissionReadiness deliberately rejects generation zero before
// touching its backend. A standalone readiness command is not session-bound,
// but it still needs a nonzero local observation generation or both TCC fields
// would be permanently reported unavailable on every machine.
constexpr rd::common::WorkerGeneration kReadinessProbeGeneration = 1;

// Mirrored from shared/remote-desktop.ts REMOTE_DESKTOP_MSG. The cross-layer
// guard test compares each of these against that file byte-for-byte.

const char* ProcessEnvironmentLookup(const char* name) {
  return std::getenv(name);
}

int ConnectUnixSocket(const std::string& path);

rd::common::TransportTime SampleNow() noexcept {
  // Both clocks are sampled at the same boundary: authority deadlines are
  // wall-clock while watchdogs are monotonic, and mixing samples taken at
  // different instants would let one drift past the other.
  rd::common::TransportTime now;
  now.unix_ms = static_cast<std::int64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch())
          .count());
  now.monotonic_ms = static_cast<std::int64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now().time_since_epoch())
          .count());
  return now;
}

rd::common::RouteAuthority CommonAuthority(
    const imcodes::rd::Authority& authority) {
  return {
      .identity =
          {
              .request_id = authority.request_id,
              .session_id = authority.session_id,
              .negotiated_capability_binding = authority.capability,
              .daemon_generation = static_cast<rd::common::WorkerGeneration>(
                  authority.daemon_generation),
              .route_generation = static_cast<std::uint64_t>(
                  authority.route_generation.value_or(1)),
          },
      .expires_at_unix_ms = authority.expires_at_ms,
      .lease_expires_at_unix_ms = authority.lease_expires_at_ms,
      .mode = authority.mode == imcodes::rd::kControlMode
                  ? rd::common::TransportSessionMode::kControl
                  : rd::common::TransportSessionMode::kView,
      .input_epoch = static_cast<std::uint64_t>(authority.input_epoch),
      .relay_bitrate_cap_bps = authority.relay_bitrate_cap_bps,
  };
}

std::vector<macos::MacosTransportIceServer> TransportIceServers(
    const imcodes::rd::Authority& authority) {
  std::vector<macos::MacosTransportIceServer> result;
  for (const auto& server : authority.ice_servers) {
    for (const std::string& uri : server.urls) {
      result.push_back({uri, server.username, server.credential});
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Command mode
// ---------------------------------------------------------------------------

// Reaches the long-lived worker over the per-user control socket.
//
// The daemon runs these commands as a *fresh* sibling process with an empty
// environment, so this object owns no session and must not answer from its own
// state. Answering locally would make every cleanup either always fail or —
// far worse — report success while releasing nothing. The socket path is
// derived from the compile-time runtime root and this process's own uid,
// because the environment carries nothing to derive it from.
class ControlSocketCleanupTarget final : public macos::NativeCleanupTarget {
 public:
  // Shared with the server side so both ends frame lines identically.
  static bool WriteLine(int descriptor, const std::string& line) noexcept;
  static bool ReadLine(int descriptor, std::string* out) noexcept;

  bool ReleaseAllInput(std::uint64_t generation) noexcept override {
    return Request(macos::ControlVerb::kReleaseInput, generation);
  }
  bool StopCapture(std::uint64_t generation) noexcept override {
    return Request(macos::ControlVerb::kStopCapture, generation);
  }

  [[nodiscard]] const std::string& last_error() const noexcept {
    return last_error_;
  }
  [[nodiscard]] std::uint64_t acted_generation() const noexcept {
    return acted_generation_;
  }

 private:
  bool Request(macos::ControlVerb verb, std::uint64_t generation) noexcept {
    last_error_.clear();
    acted_generation_ = 0;
    std::string path;
    if (!macos::BuildControlSocketPath(static_cast<std::uint32_t>(::geteuid()),
                                       &path)) {
      last_error_ = "socket_path";
      return false;
    }
    const int descriptor = ConnectUnixSocket(path);
    if (descriptor < 0) {
      // No listener means no live worker, which is exactly the case the daemon
      // must be able to distinguish from a successful cleanup.
      last_error_ = macos::kControlErrorNoActiveSession;
      return false;
    }
    std::string request;
    bool ok = macos::SerializeControlRequest(verb, generation, &request) &&
              WriteLine(descriptor, request);
    std::string reply;
    if (ok)
      ok = ReadLine(descriptor, &reply);
    ::close(descriptor);
    if (!ok) {
      last_error_ = "transport";
      return false;
    }
    macos::ControlResponse response;
    if (!macos::ParseControlResponse(reply, &response)) {
      last_error_ = "malformed_response";
      return false;
    }
    if (!response.ok) {
      last_error_ = response.error;
      return false;
    }
    // Success names the generation that acted, so an exit status can never
    // mean "something, somewhere, was cleaned up".
    acted_generation_ = response.generation;
    return true;
  }

  std::string last_error_;
  std::uint64_t acted_generation_ = 0;
};

// Non-interactive readiness probe. Every field is an observation of current
// state; nothing here requests a TCC grant or opens System Settings.
class WorkerReadinessProbe final : public macos::NativeReadinessProbe {
 public:
  bool Collect(macos::NativeReadinessV1* out) noexcept override {
    if (out == nullptr)
      return false;
    const uid_t uid = geteuid();
    if (uid == 0)
      return false;
    out->active_aqua_user_uids.assign(1, static_cast<std::uint32_t>(uid));

    // This fixed local generation exists only inside the point-in-time
    // permission observer. It is not serialized as route/session authority.
    macos::MacosPermissionReadiness readiness(kReadinessProbeGeneration);
    const auto snapshot = readiness.Probe();
    out->screen_recording =
        snapshot.screen_recording == rd::common::ReadinessState::kReady;
    out->accessibility =
        snapshot.accessibility == rd::common::ReadinessState::kReady;

    // Real graphical-session evidence. Screen Recording being granted says
    // nothing about whether the console is on this session, locked or asleep;
    // inferring active_unlocked from it would advertise a usable desktop while
    // the machine sits at the lock screen.
    out->session_state = ProbeConsoleSessionState();

    // Lifecycle observation is a runtime capability, not a compile-time one:
    // outside an Aqua session the notification centres this component observes
    // are unavailable, and claiming otherwise would promise events that can
    // never arrive.
    macos::MacosSessionMonitor monitor;
    out->lifecycle_observation =
        monitor.ProbeReadiness() == rd::common::ReadinessState::kReady;

    // Encoder availability is a hardware/qualified-software property, not a
    // build property. A VideoToolbox session can fail to open on a machine
    // whose binary contains the encoder, and advertising it anyway would let
    // the daemon admit a route that can never produce a frame.
    macos::VideoToolboxH264Encoder encoder;
    out->encoder =
        encoder.ProbeReadiness() == rd::common::ReadinessState::kReady;

    // Same rule for the clipboard: NSPasteboard is unavailable outside an Aqua
    // session, and View-only must stay distinguishable from unavailable. The
    // false actions are never invoked by this cold capability probe; real
    // copy/paste routes receive explicit callbacks when StartSession begins.
    macos::NSPasteboardClipboardAdapter clipboard(
        [](std::uint64_t) { return false; },
        [](std::uint64_t) { return false; });
    // Cold admission asks only whether this Aqua process can reach the
    // pasteboard backend. ProbeReadiness is route-liveness and intentionally
    // remains false until StartSession has admitted real copy/paste callbacks;
    // using it here made clipboard permanently unavailable. Operations still
    // require StartSession, a live generation and explicit consent callbacks.
    out->clipboard =
        clipboard.ProbeCapability() == rd::common::ReadinessState::kReady;

    // release_input / stop_capture are NOT set here, on purpose.
    //
    // This probe is a short-lived process that runs BEFORE any worker exists,
    // so it can observe neither a live generation nor socket reachability, and
    // it must not invent either. An earlier shape answered
    // `BuildControlSocketPath(...) == true`, i.e. "a string could be
    // assembled" -- true on every machine, running worker or not. Replacing
    // that with a hard false was equally wrong in the other direction: the
    // daemon gate maps either false to UNAVAILABLE, so nothing could ever
    // start, and no generation could ever exist to make it true.
    //
    // The field the daemon actually needs is CAPABILITY: can this build service
    // a cleanup command once a generation exists. Only RunNativeCommandV1 holds
    // the cleanup target, so it answers via NativeCleanupCapabilityV1 and
    // overwrites both fields after this returns. Liveness stays where it can be
    // observed for real -- the generation-bound cleanup command itself, which
    // reports failure when it cannot act.

    // Display control readiness is a SIDE-EFFECT-FREE query, and it asks the
    // HELPER, not the filesystem.
    //
    // Two earlier shapes were both wrong. The first created a real display and
    // released it, which stranded one per invocation because release-to-remove
    // does not remove on macOS 26.x. The second replaced that with "helper file
    // exists && version gate passes && seam resolves" -- which proves only that
    // a file and some selectors exist. It does not prove the helper is running,
    // that it was ever bound, or that it holds anything. Advertising display
    // control on that basis is advertising a capability we cannot deliver.
    //
    // So sibling presence, the version gate and seam resolution are
    // PREREQUISITES only: if any fails there is nothing to ask. The answer
    // itself comes from an authenticated status round trip whose reply must be
    // bound to this exact request, under this exact generation, reporting an
    // ACTIVE display. Anything else, including no answer at all, is false.
    // Display control is NOT advertised by this probe, and that is the
    // truthful answer today rather than a placeholder.
    //
    // Readiness runs as its own short-lived process. The helper is owned by a
    // route worker and reached over an anonymous socketpair that only that
    // worker holds, so this process has no way to ask it anything. An earlier
    // version read IMCODES_VIRTUAL_DISPLAY_BIND_FD / _SOCKET from the
    // environment -- but nothing in production ever writes them, so the branch
    // was unreachable and the answer was false anyway, while the code implied a
    // mechanism that does not exist.
    //
    // Advertising display control honestly requires a RESIDENT supervisor that
    // outlives any single route and exposes a bounded query surface -- i.e. the
    // LaunchAgent owning the helper rather than the worker. Until that exists,
    // the correct answer is false, and it is stated here rather than inferred
    // from a dead branch.
    out->virtual_display = false;

    // Disclosure is a separate signed component. This binary must not claim it
    // on the strength of its own in-process AppKit code, so the claim is tied
    // to the sibling executable actually being present.
    out->disclosure = DisclosureSiblingPresent();
    return true;
  }

  /** Point-in-time console state: `locked`, `active_unlocked`, ... */
  static const char* ProbeConsoleSessionState() noexcept;

 private:
  static bool DisclosureSiblingPresent() noexcept;
  static bool VirtualDisplayHelperSiblingPresent() noexcept;
};

// Point-in-time console-session observation. CGSessionCopyCurrentDictionary is
// the synchronous view the notification-based MacosSessionMonitor cannot give a
// one-shot command.
const char* WorkerReadinessProbe::ProbeConsoleSessionState() noexcept {
  CFDictionaryRef session = CGSessionCopyCurrentDictionary();
  if (session == nullptr) {
    // No Aqua session at all.
    return macos::kNativeSessionStateInactive;
  }
  const char* state = macos::kNativeSessionStateInactive;
  const void* on_console =
      CFDictionaryGetValue(session, kCGSessionOnConsoleKey);
  const void* locked =
      CFDictionaryGetValue(session, CFSTR("CGSSessionScreenIsLocked"));
  const bool is_on_console =
      on_console != nullptr &&
      CFGetTypeID(on_console) == CFBooleanGetTypeID() &&
      CFBooleanGetValue(static_cast<CFBooleanRef>(on_console));
  const bool is_locked = locked != nullptr &&
                         CFGetTypeID(locked) == CFBooleanGetTypeID() &&
                         CFBooleanGetValue(static_cast<CFBooleanRef>(locked));
  if (!is_on_console) {
    // Another user holds the console: this session exists but is not the one
    // a viewer would see.
    state = macos::kNativeSessionStateInactive;
  } else if (is_locked) {
    state = macos::kNativeSessionStateLocked;
  } else {
    state = macos::kNativeSessionStateActiveUnlocked;
  }
  CFRelease(session);
  return state;
}

// Resolves the disclosure executable next to this binary. Presence of the
// sibling is what backs the `disclosure` advertisement: the worker's own
// in-process AppKit code must never satisfy a contract that code identity
// says belongs to a separately signed component.
bool SiblingExecutablePresent(const char* file_name) noexcept;

// The LaunchAgent that owns the resident helper passes the binding descriptor
// number here. Absent means "this probe does not own a helper", which is a
// refusal, not a reason to invent one.
bool WorkerReadinessProbe::VirtualDisplayHelperSiblingPresent() noexcept {
  return SiblingExecutablePresent(kVirtualDisplayHelperFileName);
}

bool WorkerReadinessProbe::DisclosureSiblingPresent() noexcept {
  return SiblingExecutablePresent(kDisclosureFileName);
}

bool SiblingExecutablePresent(const char* file_name) noexcept {
  uint32_t size = 0;
  if (_NSGetExecutablePath(nullptr, &size) != -1 || size == 0 ||
      size > 64 * 1024) {
    return false;
  }
  std::vector<char> executable(size);
  if (_NSGetExecutablePath(executable.data(), &size) != 0)
    return false;
  const std::string current(executable.data());
  const std::string::size_type slash = current.find_last_of('/');
  if (slash == std::string::npos)
    return false;
  std::string sibling = current.substr(0, slash + 1);
  sibling.append(file_name);
  return ::access(sibling.c_str(), X_OK) == 0;
}

// ---------------------------------------------------------------------------
// Ordinary launch-agent mode
// ---------------------------------------------------------------------------

// Launches and supervises the separate signed disclosure executable, and
// consumes its bounded control stream.
//
// Without this the worker would construct a DisclosureAdmission that nothing
// ever satisfies, leaving route_admissible() false forever — a session that
// can never be admitted is just as broken as one admitted without disclosure.
class DisclosureSupervisor {
 public:
  bool Launch(std::uint64_t generation,
              std::uint32_t viewers,
              std::uint32_t controllers) noexcept;
  void Terminate() noexcept;
  [[nodiscard]] int descriptor() const noexcept { return stdout_read_; }

  // Drains available bytes and applies every complete event line. Returns
  // false on EOF or overflow, which the caller must treat as a lost
  // disclosure.
  bool Drain(macos::DisclosureAdmission* admission) noexcept;
  bool EnsureVisible(std::uint64_t generation,
                     std::uint32_t viewers,
                     std::uint32_t controllers,
                     macos::DisclosureAdmission* admission) noexcept;

 private:
  static bool ResolveSibling(const char* file_name, std::string* out) noexcept;

  pid_t child_ = -1;
  int stdout_read_ = -1;
  std::string buffer_;
  std::uint64_t generation_ = 0;
  std::uint32_t viewers_ = 0;
  std::uint32_t controllers_ = 0;
};

// The one on-screen disclosure, shared by every viewer of this worker. Each
// route reports its own viewer/controller counts; the separately signed
// disclosure process shows their total, and goes away with the last route.
// Count changes replace the child and synchronously wait for a freshly
// visible window, so the displayed state is current before control is
// admitted.
class DisclosureRoster {
 public:
  DisclosureRoster(DisclosureSupervisor* supervisor,
                   macos::DisclosureAdmission* admission,
                   std::uint64_t generation) noexcept
      : supervisor_(supervisor),
        admission_(admission),
        generation_(generation) {}

  bool BeginGeneration(std::uint64_t generation) const noexcept {
    return generation == generation_ && admission_ != nullptr &&
           admission_->route_admissible();
  }
  rd::common::ReadinessState ProbeReadiness() const noexcept {
    return admission_ != nullptr && admission_->route_admissible()
               ? rd::common::ReadinessState::kReady
               : rd::common::ReadinessState::kUnavailable;
  }
  bool Show(const void* route, std::uint32_t viewers,
            std::uint32_t controllers) {
    std::lock_guard lock(mutex_);
    counts_[route] = {viewers, controllers};
    return PublishLocked();
  }
  void Hide(const void* route) noexcept {
    std::lock_guard lock(mutex_);
    if (counts_.erase(route) == 0)
      return;
    if (!counts_.empty()) {
      (void)PublishLocked();
      return;
    }
    if (supervisor_ != nullptr)
      supervisor_->Terminate();
    if (admission_ != nullptr) {
      (void)admission_->Apply(macos::DisclosureEvent::kClosed, generation_);
    }
  }

 private:
  bool PublishLocked() {
    std::uint32_t viewers = 0;
    std::uint32_t controllers = 0;
    for (const auto& [route, count] : counts_) {
      viewers += count.first;
      controllers += count.second;
    }
    return supervisor_ != nullptr && admission_ != nullptr &&
           supervisor_->EnsureVisible(generation_, viewers, controllers,
                                      admission_);
  }

  DisclosureSupervisor* supervisor_;
  macos::DisclosureAdmission* admission_;
  std::uint64_t generation_;
  std::mutex mutex_;
  std::map<const void*, std::pair<std::uint32_t, std::uint32_t>> counts_;
};

// One route's view of the shared disclosure.
class RouteDisclosure final : public rd::common::DisclosureAdapter {
 public:
  explicit RouteDisclosure(DisclosureRoster* roster) noexcept
      : roster_(roster) {}
  ~RouteDisclosure() override { roster_->Hide(this); }
  rd::common::ReadinessState ProbeReadiness() override {
    return roster_->ProbeReadiness();
  }
  bool Show(std::uint32_t viewers, std::uint32_t controllers) override {
    return roster_->Show(this, viewers, controllers);
  }
  void Hide() noexcept override { roster_->Hide(this); }

 private:
  DisclosureRoster* roster_;
};

// Serves cleanup requests for the generation this process actually owns.
class SessionControlServer {
 public:
  bool Listen(std::uint32_t uid) noexcept;
  void Close() noexcept;
  [[nodiscard]] int descriptor() const noexcept { return listener_; }

  // Accepts one request, acts on it, and answers. Every reply is either a
  // generation-stamped OK or a closed-set error reason.
  void ServeOnce(
      const std::vector<macos::MacosRemoteDesktopSession*>& sessions,
      std::uint64_t active_generation) noexcept;

 private:
  int listener_ = -1;
  std::string path_;
};

// Types the stored sign-in secret into the lock screen, then Return.
//
// Keystrokes carry the characters themselves (CGEventKeyboardSetUnicodeString),
// so no keyboard layout is assumed and any character a password may contain
// arrives as typed. A modifier tap first raises the password field on a lock
// screen that is only showing the clock. Every copy is wiped by the caller.
void TypeSignIn(const std::string& utf8) {
  @autoreleasepool {
    NSString* value = [[NSString alloc] initWithBytes:utf8.data()
                                               length:utf8.size()
                                             encoding:NSUTF8StringEncoding];
    if (value == nil || value.length == 0)
      return;
    const auto post = [](CGEventRef event) {
      if (event == nullptr)
        return;
      CGEventPost(kCGHIDEventTap, event);
      CFRelease(event);
    };
    constexpr CGKeyCode kShift = 56;
    constexpr CGKeyCode kReturn = 36;
    post(CGEventCreateKeyboardEvent(nullptr, kShift, true));
    post(CGEventCreateKeyboardEvent(nullptr, kShift, false));
    ::usleep(400'000);
    const NSUInteger length = value.length;
    for (NSUInteger index = 0; index < length; ++index) {
      UniChar unit = [value characterAtIndex:index];
      for (const bool down : {true, false}) {
        CGEventRef event = CGEventCreateKeyboardEvent(nullptr, 0, down);
        if (event != nullptr)
          CGEventKeyboardSetUnicodeString(event, 1, &unit);
        post(event);
      }
      unit = 0;
      ::usleep(12'000);
    }
    post(CGEventCreateKeyboardEvent(nullptr, kReturn, true));
    post(CGEventCreateKeyboardEvent(nullptr, kReturn, false));
  }
}

void WipeString(std::string* value) noexcept {
  if (value == nullptr)
    return;
  if (!value->empty())
    std::fill(value->begin(), value->end(), '\0');
  value->clear();
}

class WorkerTransportSink final : public macos::MacosTransportCallbackSink {
 public:
  void Bind(macos::MacosRemoteDesktopSession* session,
            macos::MacosTransportSessionAdapter* transport,
            class WorkerSocketEmitter* emitter) noexcept;

  WorkerTransportSink();
  ~WorkerTransportSink();
  WorkerTransportSink(const WorkerTransportSink&) = delete;
  WorkerTransportSink& operator=(const WorkerTransportSink&) = delete;

  // libwebrtc delivers these on its signaling and network threads. They are
  // queued, never applied in place: the worker loop may be holding the session
  // lock while it waits synchronously on that same signaling thread (every
  // PeerConnection proxy call does), so touching the session from the callback
  // deadlocks both threads. The loop drains the queue on its own thread.
  void OnPeerConnectionState(const rd::common::TransportCallbackStamp& stamp,
                             rd::common::PeerConnectionState state) override {
    Post([this, stamp, state] { HandlePeerConnectionState(stamp, state); });
  }
  void OnDataChannelState(const rd::common::TransportCallbackStamp& stamp,
                          rd::common::DataChannelKind channel,
                          rd::common::DataChannelState state) override {
    Post([this, stamp, channel, state] {
      HandleDataChannelState(stamp, channel, state);
    });
  }
  void OnDataChannelMessage(const rd::common::TransportCallbackStamp& stamp,
                            rd::common::DataChannelKind channel,
                            std::string payload) override {
    Post([this, stamp, channel, payload = std::move(payload)]() mutable {
      HandleDataChannelMessage(stamp, channel, std::move(payload));
    });
  }
  void OnLocalIceCandidate(const rd::common::TransportCallbackStamp& stamp,
                           rd::common::IceCandidate candidate) override {
    Post([this, stamp, candidate = std::move(candidate)]() mutable {
      if (session_ != nullptr)
        session_->OnLocalIceCandidate(stamp, std::move(candidate));
    });
  }
  void OnTransportPath(const rd::common::TransportCallbackStamp& stamp,
                       rd::common::TransportPath path) override {
    Post([this, stamp, path] {
      if (session_ != nullptr && session_->OnTransportPath(stamp, path))
        (void)EmitStatus();
    });
  }
  [[nodiscard]] bool RefreshStatus() { return EmitStatus(); }
  // Readable when queued transport events are waiting for DrainEvents().
  [[nodiscard]] int wake_descriptor() const noexcept { return wake_[0]; }
  [[nodiscard]] bool wake_ready() const noexcept { return wake_[0] >= 0; }
  void DrainEvents();
  void DrainQualityTarget();
  // Unlock: the loop owns the socket, so the sink only asks it to send.
  void SetUnlockRequester(std::function<bool(bool reveal)> requester) {
    unlock_requester_ = std::move(requester);
  }
  // A reply from the daemon. `secret` is revealed only for a requested unlock
  // and is wiped here after it has been typed.
  void OnUnlockReply(bool configured, std::string sign_in);
  // Worker-loop tick: after typing the stored sign-in secret, watch for the
  // lock to end within the success window and report it once.
  void ObserveTypedUnlock();
  void SignalTerminal(std::string_view reason);
  void OnSessionTerminal(const rd::common::TerminalError& error);
  void OnQualityTarget(const rd::common::TransportCallbackStamp& stamp,
                       rd::common::QualityTarget target) override;
  void OnTerminal(rd::common::TransportTerminalReason reason) override;
  [[nodiscard]] bool terminal() const noexcept { return terminal_.load(); }
  [[nodiscard]] bool unlock_pending() const noexcept { return unlock_pending_; }

 private:
  void Post(std::function<void()> event);
  void HandlePeerConnectionState(const rd::common::TransportCallbackStamp& stamp,
                                 rd::common::PeerConnectionState state);
  void HandleDataChannelState(const rd::common::TransportCallbackStamp& stamp,
                              rd::common::DataChannelKind channel,
                              rd::common::DataChannelState state);
  void HandleDataChannelMessage(const rd::common::TransportCallbackStamp& stamp,
                                rd::common::DataChannelKind channel,
                                std::string payload);
  [[nodiscard]] bool SendControl(Json::Value message);
  [[nodiscard]] bool SendTopology();
  [[nodiscard]] bool SendQuality();
  [[nodiscard]] bool SendInputAck(std::uint64_t sequence);
  [[nodiscard]] bool SendClipboard(std::string_view request_id,
                                   const std::optional<std::string>& text);
  [[nodiscard]] bool SendControlRejected(std::string_view kind,
                                         std::string_view reason,
                                         std::string_view display_id = {});
  [[nodiscard]] bool EmitStatus();
  [[nodiscard]] bool CorrelationMatches(
      const imcodes::rd::DataChannelMessage& message,
      const imcodes::rd::Authority& authority,
      const rd::common::TransportCallbackStamp& stamp) const;
  [[nodiscard]] rd::common::InputStamp InputStampFor(
      const imcodes::rd::DataChannelMessage& message,
      rd::common::DataChannelKind channel,
      bool position = false) const;

  macos::MacosRemoteDesktopSession* session_ = nullptr;
  macos::MacosTransportSessionAdapter* transport_ = nullptr;
  class WorkerSocketEmitter* emitter_ = nullptr;
  rd::common::TopologyRevision presented_layout_revision_ = 0;
  std::uint64_t outbound_sequence_ = 0;
  std::atomic_bool terminal_ = false;
  std::mutex events_mutex_;
  std::vector<std::function<void()>> events_;
  std::array<int, 2> wake_{-1, -1};
  std::mutex quality_mutex_;
  bool unlock_configured_ = false;
  bool unlock_pending_ = false;
  bool unlock_typed_ = false;
  std::int64_t unlock_typed_at_ms_ = 0;
  bool typed_unlock_succeeded_ = false;
  std::vector<std::int64_t> unlock_attempts_ms_;
  std::function<bool(bool)> unlock_requester_;
  std::optional<
      std::pair<rd::common::TransportCallbackStamp, rd::common::QualityTarget>>
      pending_quality_target_;
};

int ConnectProtectedSocket(const std::string& path) {
  if (path.empty() || path.size() >= sizeof(sockaddr_un{}.sun_path))
    return -1;
  const int descriptor = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor < 0)
    return -1;
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, path.c_str(), path.size());
  if (::connect(descriptor, reinterpret_cast<const sockaddr*>(&address),
                sizeof(address)) != 0) {
    ::close(descriptor);
    return -1;
  }
  return descriptor;
}

int ConnectUnixSocket(const std::string& path) {
  if (path.empty() || path.size() >= sizeof(sockaddr_un{}.sun_path))
    return -1;
  const int descriptor = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor < 0)
    return -1;
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, path.c_str(), path.size());
  if (::connect(descriptor, reinterpret_cast<const sockaddr*>(&address),
                sizeof(address)) != 0) {
    ::close(descriptor);
    return -1;
  }
  return descriptor;
}

bool ControlSocketCleanupTarget::WriteLine(int descriptor,
                                           const std::string& line) noexcept {
  std::string wire = line;
  wire.push_back('\n');
  std::size_t written = 0;
  while (written < wire.size()) {
    const ssize_t count =
        ::write(descriptor, wire.data() + written, wire.size() - written);
    if (count <= 0)
      return false;
    written += static_cast<std::size_t>(count);
  }
  return true;
}

bool ControlSocketCleanupTarget::ReadLine(int descriptor,
                                          std::string* out) noexcept {
  out->clear();
  char byte = 0;
  while (out->size() <= macos::kControlMaxLineBytes) {
    const ssize_t count = ::read(descriptor, &byte, 1);
    if (count <= 0)
      return false;
    if (byte == '\n')
      return true;
    out->push_back(byte);
  }
  // An unterminated over-long reply is refused rather than truncated.
  return false;
}

bool SessionControlServer::Listen(std::uint32_t uid) noexcept {
  if (!macos::BuildControlSocketPath(uid, &path_))
    return false;
  // Stale socket from a previous generation must go, or bind() fails and this
  // generation would silently run without a control seam.
  ::unlink(path_.c_str());
  listener_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener_ < 0)
    return false;
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, path_.c_str(), path_.size());
  const mode_t previous = ::umask(0777 & ~macos::kControlSocketMode);
  const bool bound =
      ::bind(listener_, reinterpret_cast<const sockaddr*>(&address),
             sizeof(address)) == 0;
  ::umask(previous);
  if (!bound || ::listen(listener_, 4) != 0) {
    Close();
    return false;
  }
  // Belt and braces: umask only removes bits, so set the mode explicitly.
  if (::chmod(path_.c_str(), macos::kControlSocketMode) != 0) {
    Close();
    return false;
  }
  return true;
}

void SessionControlServer::Close() noexcept {
  if (listener_ >= 0) {
    ::close(listener_);
    listener_ = -1;
  }
  if (!path_.empty()) {
    ::unlink(path_.c_str());
    path_.clear();
  }
}

void SessionControlServer::ServeOnce(
    const std::vector<macos::MacosRemoteDesktopSession*>& sessions,
    std::uint64_t active_generation) noexcept {
  const int peer = ::accept(listener_, nullptr, nullptr);
  if (peer < 0)
    return;
  // Only this user may drive cleanup. The socket mode already restricts it;
  // checking the peer's effective uid closes the case where the directory was
  // widened out from under us.
  uid_t peer_uid = 0;
  gid_t peer_gid = 0;
  if (::getpeereid(peer, &peer_uid, &peer_gid) != 0 ||
      peer_uid != ::geteuid()) {
    ::close(peer);
    return;
  }

  std::string request;
  if (!ControlSocketCleanupTarget::ReadLine(peer, &request)) {
    ::close(peer);
    return;
  }
  macos::ControlVerb verb = macos::ControlVerb::kReleaseInput;
  std::uint64_t requested = 0;
  std::string reply;
  if (!macos::ParseControlRequest(request, &verb, &requested)) {
    (void)macos::SerializeControlError(macos::kControlErrorUnsupported, &reply);
  } else {
    std::string reason;
    if (!macos::ControlRequestMayAct(requested, active_generation, &reason)) {
      (void)macos::SerializeControlError(reason, &reply);
    } else {
      if (verb == macos::ControlVerb::kReleaseInput) {
        // Not ReleaseController(""): InputLedger looks that id up, misses, and
        // returns kApplied — a generation-stamped success that released
        // nothing while real controllers still hold keys and buttons down.
        bool released = !sessions.empty();
        for (macos::MacosRemoteDesktopSession* session : sessions)
          released = session->ReleaseAllControllers() && released;
        if (!released) {
          // The session could not act (terminal, or view not ready). Reporting
          // OK here would claim a release that never happened.
          (void)macos::SerializeControlError(
              macos::kControlErrorNoActiveSession, &reply);
          (void)ControlSocketCleanupTarget::WriteLine(peer, reply);
          ::close(peer);
          return;
        }
      } else {
        for (macos::MacosRemoteDesktopSession* session : sessions)
          session->Stop();
      }
      (void)macos::SerializeControlOk(active_generation, &reply);
    }
  }
  (void)ControlSocketCleanupTarget::WriteLine(peer, reply);
  ::close(peer);
}

bool DisclosureSupervisor::ResolveSibling(const char* file_name,
                                          std::string* out) noexcept {
  uint32_t size = 0;
  if (_NSGetExecutablePath(nullptr, &size) != -1 || size == 0 ||
      size > 64 * 1024) {
    return false;
  }
  std::vector<char> executable(size);
  if (_NSGetExecutablePath(executable.data(), &size) != 0)
    return false;
  const std::string current(executable.data());
  const std::string::size_type slash = current.find_last_of('/');
  if (slash == std::string::npos)
    return false;
  out->assign(current.substr(0, slash + 1));
  out->append(file_name);
  return true;
}

bool DisclosureSupervisor::Launch(std::uint64_t generation,
                                  std::uint32_t viewers,
                                  std::uint32_t controllers) noexcept {
  std::string path;
  if (!ResolveSibling(kDisclosureFileName, &path))
    return false;
  if (::access(path.c_str(), X_OK) != 0)
    return false;

  int pipe_fds[2] = {-1, -1};
  if (::pipe(pipe_fds) != 0)
    return false;

  const std::string generation_text = std::to_string(generation);
  const std::string viewers_text = std::to_string(viewers);
  const std::string controllers_text = std::to_string(controllers);
  std::vector<char*> argv;
  argv.push_back(const_cast<char*>(path.c_str()));
  argv.push_back(const_cast<char*>("--generation"));
  argv.push_back(const_cast<char*>(generation_text.c_str()));
  argv.push_back(const_cast<char*>("--viewers"));
  argv.push_back(const_cast<char*>(viewers_text.c_str()));
  argv.push_back(const_cast<char*>("--controllers"));
  argv.push_back(const_cast<char*>(controllers_text.c_str()));
  argv.push_back(nullptr);

  posix_spawn_file_actions_t actions;
  if (posix_spawn_file_actions_init(&actions) != 0) {
    ::close(pipe_fds[0]);
    ::close(pipe_fds[1]);
    return false;
  }
  posix_spawn_file_actions_adddup2(&actions, pipe_fds[1], STDOUT_FILENO);
  posix_spawn_file_actions_addclose(&actions, pipe_fds[0]);
  posix_spawn_file_actions_addclose(&actions, pipe_fds[1]);

  // The child inherits no environment. It needs none, and an inherited one
  // would be a channel this component has no reason to have.
  char* empty_environment[] = {nullptr};
  pid_t child = -1;
  const int spawned = posix_spawn(&child, path.c_str(), &actions, nullptr,
                                  argv.data(), empty_environment);
  posix_spawn_file_actions_destroy(&actions);
  ::close(pipe_fds[1]);
  if (spawned != 0) {
    ::close(pipe_fds[0]);
    return false;
  }
  child_ = child;
  stdout_read_ = pipe_fds[0];
  generation_ = generation;
  viewers_ = viewers;
  controllers_ = controllers;
  return true;
}

void DisclosureSupervisor::Terminate() noexcept {
  if (stdout_read_ >= 0) {
    ::close(stdout_read_);
    stdout_read_ = -1;
  }
  if (child_ > 0) {
    ::kill(child_, SIGTERM);
    int status = 0;
    ::waitpid(child_, &status, 0);
    child_ = -1;
  }
  buffer_.clear();
  generation_ = 0;
  viewers_ = 0;
  controllers_ = 0;
}

bool DisclosureSupervisor::Drain(
    macos::DisclosureAdmission* admission) noexcept {
  if (stdout_read_ < 0)
    return false;
  std::array<char, 512> chunk{};
  const ssize_t count = ::read(stdout_read_, chunk.data(), chunk.size());
  if (count <= 0)
    return false;
  for (ssize_t index = 0; index < count; ++index) {
    const char character = chunk[static_cast<std::size_t>(index)];
    if (character != '\n') {
      if (buffer_.size() >= macos::kDisclosureEventMaxLineBytes) {
        // An over-long line means this is not the fixed seam; do not
        // resynchronize.
        return false;
      }
      buffer_.push_back(character);
      continue;
    }
    macos::DisclosureEvent event = macos::DisclosureEvent::kFailed;
    std::uint64_t generation = 0;
    const bool parsed =
        macos::ParseDisclosureEvent(buffer_, &event, &generation);
    buffer_.clear();
    if (!parsed)
      return false;
    // Apply returning false means the event was for another generation, which
    // is ignored rather than fatal: a replaced disclosure must not disturb the
    // live one.
    (void)admission->Apply(event, generation);
  }
  return true;
}

bool DisclosureSupervisor::EnsureVisible(
    std::uint64_t generation,
    std::uint32_t viewers,
    std::uint32_t controllers,
    macos::DisclosureAdmission* admission) noexcept {
  if (admission == nullptr || generation == 0 || viewers == 0 ||
      controllers > viewers) {
    return false;
  }
  if (child_ > 0 && generation_ == generation && viewers_ == viewers &&
      controllers_ == controllers && admission->route_admissible()) {
    return true;
  }

  Terminate();
  *admission = macos::DisclosureAdmission(generation);
  if (!Launch(generation, viewers, controllers))
    return false;

  constexpr int kVisibleTimeoutMs = 5'000;
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(kVisibleTimeoutMs);
  while (std::chrono::steady_clock::now() < deadline) {
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - std::chrono::steady_clock::now());
    pollfd descriptor{stdout_read_, POLLIN, 0};
    const int ready =
        ::poll(&descriptor, 1,
               static_cast<int>(std::max<std::int64_t>(1, remaining.count())));
    if (ready < 0 && errno == EINTR)
      continue;
    if (ready <= 0 ||
        (descriptor.revents & (POLLIN | POLLHUP | POLLERR)) == 0 ||
        !Drain(admission)) {
      break;
    }
    if (admission->route_admissible())
      return true;
    if (admission->terminated())
      break;
  }
  Terminate();
  return false;
}

bool WriteFrame(int descriptor, const std::string& frame) {
  std::string wire = frame;
  wire.push_back('\n');
  std::size_t written = 0;
  while (written < wire.size()) {
    const ssize_t count =
        ::write(descriptor, wire.data() + written, wire.size() - written);
    if (count <= 0)
      return false;
    written += static_cast<std::size_t>(count);
  }
  return true;
}

// Reads exactly one newline-delimited frame without consuming any byte of the
// following command. A local FrameReader would have to hand its buffered tail
// to DaemonDisplayChannel; reading one byte at a time keeps one authoritative
// reader boundary instead. Timeout, EOF, an empty frame, or an oversized frame
// are all terminal authentication failures.
bool ReadAuthenticationFrame(int descriptor, std::string* out) {
  if (descriptor < 0 || out == nullptr) return false;
  std::string frame;
  frame.reserve(512);
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(
                            kGraphicalAuthenticationTimeoutMs);
  while (frame.size() < macos::kIpcMaxFrameBytes) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) return false;
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
        deadline - now);
    pollfd pending{descriptor, POLLIN, 0};
    const int ready = ::poll(
        &pending, 1,
        static_cast<int>(std::max<std::int64_t>(1, remaining.count())));
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 ||
        (pending.revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
      return false;
    }
    char byte = 0;
    const ssize_t count = ::recv(descriptor, &byte, 1, 0);
    if (count < 0 && errno == EINTR) continue;
    if (count != 1) return false;
    if (byte == '\n') {
      if (frame.empty()) return false;
      *out = std::move(frame);
      return true;
    }
    frame.push_back(byte);
  }
  return false;
}

// Emits one WORKER_MESSAGE envelope. A message that cannot be framed is a
// local fault, so it terminates the loop rather than being dropped silently.
bool EmitWorkerMessage(int descriptor,
                       std::uint64_t generation,
                       std::string_view message_json) {
  std::string frame;
  if (!macos::BuildWorkerMessageFrame(generation, message_json, &frame)) {
    std::cerr << "macos_remote_desktop_worker_message_unframable\n";
    return false;
  }
  return WriteFrame(descriptor, frame);
}

class WorkerSocketEmitter final {
 public:
  // Every route's emitter writes to the same socket; `write_mutex` is shared
  // by all of them so frames from different viewers never interleave.
  WorkerSocketEmitter(int descriptor, std::uint64_t generation,
                      std::mutex* write_mutex) noexcept
      : descriptor_(descriptor),
        generation_(generation),
        write_mutex_(write_mutex) {}

  void BindAuthority(const imcodes::rd::Authority& authority) {
    std::lock_guard lock(mutex_);
    authority_ = authority;
  }
  void ClearAuthority() {
    std::lock_guard lock(mutex_);
    authority_.reset();
  }
  [[nodiscard]] std::optional<imcodes::rd::Authority> SnapshotAuthority() {
    std::lock_guard lock(mutex_);
    return authority_;
  }
  bool Emit(const Json::Value& message) {
    std::lock_guard lock(*write_mutex_);
    return EmitWorkerMessage(descriptor_, generation_,
                             imcodes::rd::WriteJson(message));
  }
  // A pre-built frame on the same serialized writer, so it can never interleave
  // with a worker message written from another thread.
  bool WriteRaw(const std::string& frame) {
    std::lock_guard lock(*write_mutex_);
    return WriteFrame(descriptor_, frame);
  }
  bool EmitLocalIce(const rd::common::IceCandidate& candidate) {
    const std::optional<imcodes::rd::Authority> authority = SnapshotAuthority();
    if (!authority.has_value())
      return false;
    Json::Value message =
        imcodes::rd::BaseEnvelope(imcodes::rd::kIceType, *authority);
    message["candidate"] = candidate.candidate;
    message["mid"] = candidate.media_id;
    return Emit(message);
  }

 private:
  int descriptor_;
  std::uint64_t generation_;
  std::mutex* write_mutex_;
  std::mutex mutex_;
  std::optional<imcodes::rd::Authority> authority_;
};

void WorkerTransportSink::OnTerminal(
    rd::common::TransportTerminalReason reason) {
  // A controller STOP is answered by the host-command dispatcher after the
  // session has been torn down. Emitting here as well would produce two
  // terminal frames for one request.
  if (reason == rd::common::TransportTerminalReason::kStopped)
    return;
  const char* wire_reason = "peer_failed";
  switch (reason) {
    case rd::common::TransportTerminalReason::kStopped:
      break;
    case rd::common::TransportTerminalReason::kRouteExpired:
      wire_reason = "authority_expired";
      break;
    case rd::common::TransportTerminalReason::kLeaseExpired:
      wire_reason = "lease_expired";
      break;
    case rd::common::TransportTerminalReason::kIdleTimeout:
      wire_reason = "idle_timeout";
      break;
    case rd::common::TransportTerminalReason::kProtocolViolation:
    case rd::common::TransportTerminalReason::kCandidateOverflow:
      wire_reason = "protocol_error";
      break;
    case rd::common::TransportTerminalReason::kMediaStalled:
      wire_reason = "media_unavailable";
      break;
    case rd::common::TransportTerminalReason::kNone:
    case rd::common::TransportTerminalReason::kPeerFailed:
    case rd::common::TransportTerminalReason::kChannelFailed:
    case rd::common::TransportTerminalReason::kAdapterFailure:
      break;
  }
  SignalTerminal(wire_reason);
}

void WorkerTransportSink::SignalTerminal(std::string_view reason) {
  if (terminal_.exchange(true))
    return;
  if (emitter_ == nullptr)
    return;
  const auto authority = emitter_->SnapshotAuthority();
  if (authority.has_value()) {
    (void)emitter_->Emit(
        imcodes::rd::TerminalEnvelope(*authority, std::string(reason).c_str()));
  }
  // The route's last frame: the node retires the route on it, and a later
  // frame for a retired route would end the whole worker -- every other
  // viewer included.
  emitter_->ClearAuthority();
}

void WorkerTransportSink::OnSessionTerminal(
    const rd::common::TerminalError& error) {
  const char* reason = "worker_failed";
  switch (error.code) {
    case rd::common::TerminalErrorCode::kProtocolViolation:
      reason = "protocol_error";
      break;
    case rd::common::TerminalErrorCode::kCaptureUnavailable:
    case rd::common::TerminalErrorCode::kEncoderUnavailable:
      reason = "media_unavailable";
      break;
    case rd::common::TerminalErrorCode::kDisclosureUnavailable:
    case rd::common::TerminalErrorCode::kInputUnavailable:
    case rd::common::TerminalErrorCode::kGraphicalSessionEnded:
      reason = "capability_unavailable";
      break;
    case rd::common::TerminalErrorCode::kStopped:
      reason = "worker_failed";
      break;
    case rd::common::TerminalErrorCode::kNone:
    case rd::common::TerminalErrorCode::kAdapterFailure:
      break;
  }
  SignalTerminal(reason);
}

WorkerTransportSink::WorkerTransportSink() {
  if (::pipe(wake_.data()) != 0) {
    wake_ = {-1, -1};
    return;
  }
  for (const int descriptor : wake_) {
    (void)::fcntl(descriptor, F_SETFD, FD_CLOEXEC);
    (void)::fcntl(descriptor, F_SETFL,
                  ::fcntl(descriptor, F_GETFL) | O_NONBLOCK);
  }
}

WorkerTransportSink::~WorkerTransportSink() {
  for (const int descriptor : wake_) {
    if (descriptor >= 0)
      ::close(descriptor);
  }
}

void WorkerTransportSink::Post(std::function<void()> event) {
  {
    std::lock_guard lock(events_mutex_);
    events_.push_back(std::move(event));
  }
  // One byte per event at most; a full pipe already guarantees a wake-up.
  if (wake_[1] >= 0) {
    const char byte = 1;
    (void)::write(wake_[1], &byte, 1);
  }
}

void WorkerTransportSink::DrainEvents() {
  if (wake_[0] >= 0) {
    char buffer[256];
    while (::read(wake_[0], buffer, sizeof(buffer)) > 0) {
    }
  }
  std::vector<std::function<void()>> events;
  {
    std::lock_guard lock(events_mutex_);
    events.swap(events_);
  }
  for (auto& event : events)
    event();
}

void WorkerTransportSink::Bind(macos::MacosRemoteDesktopSession* session,
                               macos::MacosTransportSessionAdapter* transport,
                               WorkerSocketEmitter* emitter) noexcept {
  session_ = session;
  transport_ = transport;
  emitter_ = emitter;
}

bool WorkerTransportSink::SendControl(Json::Value message) {
  return transport_ != nullptr &&
         transport_->SendDataChannel(rd::common::DataChannelKind::kControl,
                                     imcodes::rd::WriteJson(message));
}

bool WorkerTransportSink::SendTopology() {
  if (session_ == nullptr || emitter_ == nullptr)
    return false;
  const auto authority = emitter_->SnapshotAuthority();
  const auto topology = session_->topology();
  if (!authority.has_value() || !topology.has_value() || !topology->IsValid()) {
    return false;
  }
  Json::Value root(Json::objectValue);
  root["type"] = imcodes::rd::kTopologyType;
  root["protocolVersion"] = imcodes::rd::kProtocolVersion;
  root["sessionId"] = authority->session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["layoutRevision"] = Json::UInt64(topology->revision);
  Json::Value displays(Json::arrayValue);
  for (std::size_t index = 0; index < topology->displays.size(); ++index) {
    const rd::common::DisplayTopology& display = topology->displays[index];
    Json::Value encoded(Json::objectValue);
    encoded["id"] = display.display_id;
    encoded["label"] = display.display_id;
    encoded["primary"] = index == 0;
    encoded["available"] = true;
    encoded["width"] = display.encoded_pixels.width;
    encoded["height"] = display.encoded_pixels.height;
    encoded["dpiScale"] = display.scale;
    encoded["rotation"] = static_cast<unsigned int>(display.rotation);
    Json::Value bounds(Json::objectValue);
    bounds["x"] = display.logical_input_bounds.x;
    bounds["y"] = display.logical_input_bounds.y;
    bounds["width"] = display.logical_input_bounds.width;
    bounds["height"] = display.logical_input_bounds.height;
    encoded["inputBounds"] = std::move(bounds);
    Json::Value operations(Json::objectValue);
    operations["setMode"] = false;
    operations["setScale"] = false;
    encoded["operations"] = std::move(operations);
    displays.append(std::move(encoded));
  }
  root["displays"] = std::move(displays);
  const std::string selected = session_->selected_display_id();
  if (!selected.empty())
    root["selectedDisplayId"] = selected;
  return SendControl(std::move(root));
}

bool WorkerTransportSink::SendInputAck(std::uint64_t sequence) {
  if (session_ == nullptr || emitter_ == nullptr)
    return false;
  const auto authority = emitter_->SnapshotAuthority();
  const auto topology = session_->topology();
  if (!authority.has_value() || !topology.has_value())
    return false;
  Json::Value root(Json::objectValue);
  root["type"] = imcodes::rd::kControlType;
  root["protocolVersion"] = imcodes::rd::kProtocolVersion;
  root["sessionId"] = authority->session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["layoutRevision"] = Json::UInt64(topology->revision);
  root["inputEpoch"] = Json::UInt64(authority->input_epoch);
  root["kind"] = "input_ack";
  root["acknowledgedSequence"] = Json::UInt64(sequence);
  return SendControl(std::move(root));
}

bool WorkerTransportSink::SendQuality() {
  if (session_ == nullptr || emitter_ == nullptr)
    return false;
  const auto authority = emitter_->SnapshotAuthority();
  const rd::common::TransportDiagnostics diagnostics =
      session_->transport_diagnostics();
  if (!authority.has_value())
    return false;
  // Before congestion control has issued a target, describe what is actually
  // being sent: the selected display at the encoder's cadence. The viewer's
  // status bar (resolution, fps, bitrate, latency) only fills in once it has
  // a quality report to extend with its own stats.
  rd::common::QualitySelection fallback;
  if (!diagnostics.quality.has_value()) {
    const auto topology = session_->topology();
    const rd::common::DisplayTopology* display =
        topology ? topology->FindDisplay(session_->selected_display_id())
                 : nullptr;
    if (display == nullptr)
      return false;
    fallback.preset_id = "macos-videotoolbox";
    fallback.encoded_pixels = display->encoded_pixels;
    fallback.frame_rate = 30;
    fallback.bitrate_bps = 1'500'000;
  }
  const rd::common::QualitySelection& quality =
      diagnostics.quality.has_value() ? *diagnostics.quality : fallback;
  Json::Value root(Json::objectValue);
  root["type"] = imcodes::rd::kQualityType;
  root["protocolVersion"] = imcodes::rd::kProtocolVersion;
  root["sessionId"] = authority->session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["preset"] = quality.preset_id;
  root["encoderClass"] = "hardware";
  root["width"] = quality.encoded_pixels.width;
  root["height"] = quality.encoded_pixels.height;
  root["fps"] = quality.frame_rate;
  root["bitrateBps"] = quality.bitrate_bps;
  root["droppedFrames"] = Json::UInt64(0);
  root["rttMs"] = 0;
  return SendControl(std::move(root));
}

bool WorkerTransportSink::SendClipboard(
    std::string_view request_id,
    const std::optional<std::string>& text) {
  if (emitter_ == nullptr)
    return false;
  const auto authority = emitter_->SnapshotAuthority();
  if (!authority.has_value())
    return false;
  Json::Value root(Json::objectValue);
  root["type"] = imcodes::rd::kClipboardType;
  root["protocolVersion"] = imcodes::rd::kProtocolVersion;
  root["sessionId"] = authority->session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["requestId"] = std::string(request_id);
  const bool available = text.has_value() && !text->empty() &&
                         text->size() <= imcodes::rd::kMaxClipboardTextBytes;
  root["available"] = available;
  if (available)
    root["text"] = *text;
  return SendControl(std::move(root));
}

bool WorkerTransportSink::SendControlRejected(std::string_view kind,
                                              std::string_view reason,
                                              std::string_view display_id) {
  if (emitter_ == nullptr)
    return false;
  const auto authority = emitter_->SnapshotAuthority();
  if (!authority.has_value())
    return false;
  Json::Value root(Json::objectValue);
  root["type"] = imcodes::rd::kControlRejectedType;
  root["protocolVersion"] = imcodes::rd::kProtocolVersion;
  root["sessionId"] = authority->session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["kind"] = std::string(kind);
  root["reason"] = std::string(reason);
  if (!display_id.empty())
    root["displayId"] = std::string(display_id);
  return SendControl(std::move(root));
}

bool WorkerTransportSink::EmitStatus() {
  if (session_ == nullptr || emitter_ == nullptr)
    return false;
  const auto authority = emitter_->SnapshotAuthority();
  const auto topology = session_->topology();
  if (!authority.has_value())
    return false;
  const rd::common::TransportDiagnostics diagnostics =
      session_->transport_diagnostics();
  Json::Value root =
      imcodes::rd::BaseEnvelope(imcodes::rd::kStatusType, *authority);
  root["mode"] = authority->mode;
  root["inputEpoch"] = Json::UInt64(authority->input_epoch);
  const bool connected =
      diagnostics.peer_state == rd::common::PeerConnectionState::kConnected;
  const char* state = "connecting";
  if (connected && diagnostics.path == rd::common::TransportPath::kRelay)
    state = "relayed";
  else if (connected)
    state = "direct";
  root["state"] = state;
  if (diagnostics.path == rd::common::TransportPath::kRelay)
    root["route"] = "relay";
  else if (diagnostics.path == rd::common::TransportPath::kDirect)
    root["route"] = "direct";
  const bool channels_ready = diagnostics.required_channels_ready;
  const bool frame_ready =
      topology.has_value() && presented_layout_revision_ == topology->revision;
  const bool input_enabled =
      authority->mode == imcodes::rd::kControlMode && channels_ready &&
      frame_ready &&
      session_->state() == rd::common::SessionState::kControlling;
  // The four facts the Server requires before it calls the session connected
  // and disarms its negotiation timeout. None were sent, so every macOS session
  // was ended as negotiation_timeout 45 s in, even with video on screen.
  // The lock screen is part of the session now: say when the Mac is on it, so
  // the browser can show that state. Unlocking is typing the password through
  // ordinary input, or -- when the owner configured one -- the stored sign-in
  // secret the node keeps root-only and releases for one requested unlock.
  const bool on_lock_screen =
      std::strcmp(WorkerReadinessProbe::ProbeConsoleSessionState(),
                  macos::kNativeSessionStateLocked) == 0;
  root["signInScreen"] = on_lock_screen;
  root["unlockAvailable"] = on_lock_screen && unlock_configured_;
  root["peerConnected"] = connected;
  root["dataChannelsReady"] = channels_ready;
  root["mediaStarted"] = diagnostics.last_outbound_video_bytes > 0;
  root["firstFramePresented"] = frame_ready;
  root["inputEnabled"] = input_enabled;
  root["atomicButtonClick"] = true;
  // Honours set_quality_preference; the browser sends it only when true.
  root["qualityPreference"] = true;
  // ...including Ultra: maxHeight 2160 and a raised bitrate ceiling.
  root["qualityUltra"] = true;
  root["viewerCount"] = 1;
  root["controllerCount"] =
      session_->state() == rd::common::SessionState::kControlling ? 1 : 0;
  if (topology.has_value()) {
    const std::string selected = session_->selected_display_id();
    if (!selected.empty()) {
      root["selectedDisplayId"] = selected;
      root["layoutRevision"] = Json::UInt64(topology->revision);
    }
  }
  if (!input_enabled) {
    if (authority->mode != imcodes::rd::kControlMode)
      root["inputBlocked"] = imcodes::rd::kInputBlockedNoControl;
    else if (!channels_ready)
      root["inputBlocked"] = imcodes::rd::kInputBlockedChannels;
    else if (!frame_ready)
      root["inputBlocked"] = imcodes::rd::kInputBlockedAwaitingFrame;
    else
      root["inputBlocked"] = imcodes::rd::kInputBlockedInputUnavailable;
  }
  if (typed_unlock_succeeded_)
    root["autoUnlockSucceeded"] = true;
  return emitter_->Emit(root);
}

void WorkerTransportSink::ObserveTypedUnlock() {
  if (!unlock_typed_)
    return;
  const std::int64_t now_ms = SampleNow().monotonic_ms;
  // Only a signed-in console counts as unlocked; an inactive console (another
  // user switched in) is not this unlock succeeding.
  const bool locked =
      std::strcmp(WorkerReadinessProbe::ProbeConsoleSessionState(),
                  macos::kNativeSessionStateActiveUnlocked) != 0;
  if (imcodes::rd::IsTypedUnlockSuccess(true, locked, true, unlock_typed_at_ms_,
                                       now_ms)) {
    unlock_typed_ = false;
    if (!typed_unlock_succeeded_) {
      typed_unlock_succeeded_ = true;
      (void)EmitStatus();
    }
  } else if (now_ms - unlock_typed_at_ms_ >
             imcodes::rd::kTypedUnlockWindowMs) {
    unlock_typed_ = false;
  }
}

bool WorkerTransportSink::CorrelationMatches(
    const imcodes::rd::DataChannelMessage& message,
    const imcodes::rd::Authority& authority,
    const rd::common::TransportCallbackStamp& stamp) const {
  const auto topology =
      session_ == nullptr ? std::nullopt : session_->topology();
  return topology.has_value() &&
         message.correlation.session_id == authority.session_id &&
         authority.input_epoch >= 0 &&
         message.correlation.input_epoch ==
             static_cast<std::uint64_t>(authority.input_epoch) &&
         message.correlation.layout_revision == topology->revision &&
         authority.daemon_generation >= 0 &&
         stamp.daemon_generation ==
             static_cast<std::uint64_t>(authority.daemon_generation) &&
         stamp.route_generation == authority.route_generation;
}

rd::common::InputStamp WorkerTransportSink::InputStampFor(
    const imcodes::rd::DataChannelMessage& message,
    rd::common::DataChannelKind channel,
    bool position) const {
  const char* controller = "control";
  if (channel == rd::common::DataChannelKind::kKeyboard)
    controller = "keyboard";
  else if (channel == rd::common::DataChannelKind::kPointer)
    controller = "pointer";
  return {
      .controller_id = position ? std::string(controller) + ":position"
                                : std::string(controller),
      .epoch = message.correlation.input_epoch,
      .sequence = message.correlation.sequence,
      .topology_revision = message.correlation.layout_revision,
  };
}

void WorkerTransportSink::HandlePeerConnectionState(
    const rd::common::TransportCallbackStamp& stamp,
    rd::common::PeerConnectionState state) {
  if (session_ != nullptr &&
      session_->OnPeerConnectionState(stamp, state, SampleNow())) {
    (void)EmitStatus();
  }
}

void WorkerTransportSink::HandleDataChannelState(
    const rd::common::TransportCallbackStamp& stamp,
    rd::common::DataChannelKind channel,
    rd::common::DataChannelState state) {
  if (session_ == nullptr ||
      !session_->OnDataChannelState(stamp, channel, state)) {
    return;
  }
  if (channel == rd::common::DataChannelKind::kControl &&
      state == rd::common::DataChannelState::kOpen) {
    (void)SendTopology();
    (void)SendQuality();
  }
  (void)EmitStatus();
}

void WorkerTransportSink::OnQualityTarget(
    const rd::common::TransportCallbackStamp& stamp,
    rd::common::QualityTarget target) {
  // SetRates is an upstream encoder callback. Reconfiguring VideoToolbox or
  // calling PeerConnection::SetBitrate from that stack frame can re-enter the
  // encoder. Hand the latest target to the worker loop instead.
  std::lock_guard lock(quality_mutex_);
  pending_quality_target_ = std::make_pair(stamp, target);
}

void WorkerTransportSink::OnUnlockReply(bool configured, std::string sign_in) {
  const bool changed = configured != unlock_configured_;
  unlock_configured_ = configured;
  if (!sign_in.empty()) {
    std::string decoded;
    const bool pending = unlock_pending_;
    unlock_pending_ = false;
    const bool on_lock_screen =
        std::strcmp(WorkerReadinessProbe::ProbeConsoleSessionState(),
                    macos::kNativeSessionStateLocked) == 0;
    // Typed only for an unlock this worker asked for, and only if the Mac is
    // still locked: a secret typed into an unlocked desktop would land in
    // whatever window has focus.
    if (pending && on_lock_screen && macos::DecodeBase64Url(sign_in, &decoded)) {
      TypeSignIn(decoded);
      std::cerr << "macos_remote_desktop_worker_unlock_typed\n";
      unlock_typed_ = true;
      unlock_typed_at_ms_ = SampleNow().monotonic_ms;
    }
    WipeString(&decoded);
    WipeString(&sign_in);
  } else if (unlock_pending_) {
    unlock_pending_ = false;
  }
  if (changed)
    (void)EmitStatus();
}

void WorkerTransportSink::DrainQualityTarget() {
  std::optional<
      std::pair<rd::common::TransportCallbackStamp, rd::common::QualityTarget>>
      target;
  {
    std::lock_guard lock(quality_mutex_);
    target.swap(pending_quality_target_);
  }
  if (session_ != nullptr && target.has_value() &&
      session_->UpdateTransportQuality(target->first, target->second)) {
    (void)SendQuality();
  }
}

void WorkerTransportSink::HandleDataChannelMessage(
    const rd::common::TransportCallbackStamp& stamp,
    rd::common::DataChannelKind channel,
    std::string payload) {
  if (session_ == nullptr || emitter_ == nullptr)
    return;
  imcodes::rd::DataChannelMessage message;
  const auto authority = emitter_->SnapshotAuthority();
  if (!authority.has_value() ||
      !imcodes::rd::ParseDataChannelMessage(payload, &message) ||
      !CorrelationMatches(message, *authority, stamp)) {
    return;
  }
  // While the privacy shield is up no viewer input may reach this Mac: the
  // owner is typing a secret here and the viewer cannot see where it lands.
  if (session_->privacy_shielded() &&
      (message.kind == imcodes::rd::DataChannelMessageKind::kPointer ||
       message.kind == imcodes::rd::DataChannelMessageKind::kKeyboard)) {
    return;
  }
  const auto activity = [&]() {
    return session_->RecordRouteActivity(CommonAuthority(*authority).identity,
                                         SampleNow());
  };
  const auto applied = [](rd::common::InputResult result) {
    return result == rd::common::InputResult::kApplied;
  };
  bool accepted = false;
  bool acknowledge = false;

  if (message.kind == imcodes::rd::DataChannelMessageKind::kPointer &&
      (channel == rd::common::DataChannelKind::kPointer ||
       channel == rd::common::DataChannelKind::kControl)) {
    const std::string selected = session_->selected_display_id();
    if (selected.empty())
      return;
    if (message.pointer.x.has_value() && message.pointer.y.has_value() &&
        message.pointer.kind != imcodes::rd::PointerKind::kMove) {
      accepted = applied(session_->ApplyPointerMove({
          .stamp = InputStampFor(message, channel, true),
          .display_id = selected,
          .normalized_x = *message.pointer.x,
          .normalized_y = *message.pointer.y,
      }));
      if (!accepted)
        return;
    }
    switch (message.pointer.kind) {
      case imcodes::rd::PointerKind::kMove:
        accepted = applied(session_->ApplyPointerMove({
            .stamp = InputStampFor(message, channel, true),
            .display_id = selected,
            .normalized_x = *message.pointer.x,
            .normalized_y = *message.pointer.y,
        }));
        break;
      case imcodes::rd::PointerKind::kButtonDown:
      case imcodes::rd::PointerKind::kButtonUp:
      case imcodes::rd::PointerKind::kButtonClick: {
        static constexpr const char* kButtons[] = {"left", "middle", "right",
                                                   "back", "forward"};
        const std::size_t index =
            static_cast<std::size_t>(*message.pointer.button);
        if (index >= std::size(kButtons))
          return;
        rd::common::ButtonTransition transition{
            .stamp = InputStampFor(message, channel),
            .button = kButtons[index],
            .pressed =
                message.pointer.kind == imcodes::rd::PointerKind::kButtonDown,
        };
        accepted = applied(message.pointer.kind ==
                                   imcodes::rd::PointerKind::kButtonClick
                               ? session_->ClickButton(transition)
                               : session_->ApplyButton(transition));
        acknowledge = channel == rd::common::DataChannelKind::kControl;
        break;
      }
      case imcodes::rd::PointerKind::kWheel:
        accepted = applied(session_->ApplyWheel({
            .stamp = InputStampFor(message, channel),
            .delta_x = *message.pointer.delta_x,
            .delta_y = *message.pointer.delta_y,
        }));
        break;
    }
  } else if (message.kind == imcodes::rd::DataChannelMessageKind::kKeyboard &&
             channel == rd::common::DataChannelKind::kKeyboard) {
    if (message.keyboard.kind == imcodes::rd::KeyboardKind::kText) {
      accepted = applied(session_->ApplyText({
          .stamp = InputStampFor(message, channel),
          .text = *message.keyboard.text,
      }));
    } else {
      accepted = applied(session_->ApplyKey({
          .stamp = InputStampFor(message, channel),
          .key = *message.keyboard.code,
          .pressed =
              message.keyboard.kind == imcodes::rd::KeyboardKind::kKeyDown,
      }));
    }
    acknowledge = true;
  } else if (message.kind == imcodes::rd::DataChannelMessageKind::kReleaseAll &&
             channel == rd::common::DataChannelKind::kControl) {
    session_->ReleaseController("control");
    session_->ReleaseController("control:position");
    session_->ReleaseController("keyboard");
    session_->ReleaseController("pointer");
    session_->ReleaseController("pointer:position");
    accepted = true;
    acknowledge = true;
  } else if (message.kind == imcodes::rd::DataChannelMessageKind::kControl &&
             channel == rd::common::DataChannelKind::kControl) {
    const std::string& kind = message.control.kind;
    if (kind == "hello" || kind == "keepalive") {
      accepted = true;
    } else if (kind == "set_quality_preference") {
      // Per viewer; needs no control authority -- it only shapes this
      // viewer's own encoder.
      const std::optional<imcodes::rd::QualityPreference> preference =
          imcodes::rd::QualityPreferenceFromControl(message.control);
      accepted = preference.has_value() &&
                 session_->SetQualityPreference(*preference);
    } else if (kind == "frame_presented") {
      const auto topology = session_->topology();
      const rd::common::DisplayTopology* display =
          topology ? topology->FindDisplay(*message.control.display_id)
                   : nullptr;
      if (display == nullptr ||
          display->display_id != session_->selected_display_id() ||
          *message.control.frame_width == 0 || *message.control.frame_height == 0 ||
          *message.control.frame_width > 16'384 || *message.control.frame_height > 16'384 ||
          !rd::common::PresentedFrameCompatibleWithDisplay(
              {static_cast<std::uint32_t>(*message.control.frame_width),
               static_cast<std::uint32_t>(*message.control.frame_height)},
              display->encoded_pixels)) {
        return;
      }
      presented_layout_revision_ = topology->revision;
      accepted = true;
      (void)EmitStatus();
    } else if (kind == "select_display") {
      accepted = session_->SelectDisplay(*message.control.display_id);
      if (accepted) {
        presented_layout_revision_ = 0;
        (void)SendTopology();
        (void)EmitStatus();
      } else {
        (void)SendControlRejected(kind, imcodes::rd::kRejectDisplayUnavailable,
                                  *message.control.display_id);
      }
    } else if (kind == "copy_selection") {
      std::string text;
      const bool copied = session_->CopySelection(&text);
      accepted = SendClipboard(
          *message.control.request_id,
          copied ? std::optional<std::string>(text) : std::nullopt);
    } else if (kind == "set_display_mode") {
      accepted = session_->SetDisplayMode(
          *message.control.display_id,
          {static_cast<std::uint32_t>(*message.control.width),
           static_cast<std::uint32_t>(*message.control.height)});
      if (accepted) {
        presented_layout_revision_ = 0;
        (void)SendTopology();
        (void)EmitStatus();
      } else {
        (void)SendControlRejected(kind, imcodes::rd::kRejectModeUnsupported,
                                  *message.control.display_id);
      }
    } else if (kind == "set_display_scale") {
      accepted = session_->SetDisplayScale(
          *message.control.display_id,
          static_cast<double>(*message.control.dpi_scale_percent) / 100.0);
      if (accepted) {
        presented_layout_revision_ = 0;
        (void)SendTopology();
        (void)EmitStatus();
      } else {
        (void)SendControlRejected(kind,
                                  imcodes::rd::kRejectScaleChangeFailed,
                                  *message.control.display_id);
      }
    } else if (kind == "unlock") {
      // Same bounds as Windows: only on the lock screen, only with a stored
      // secret, one attempt in flight, at most ten a minute.
      const std::int64_t now_ms = SampleNow().monotonic_ms;
      std::erase_if(unlock_attempts_ms_, [now_ms](std::int64_t at) {
        return now_ms - at >= 60'000;
      });
      const bool on_lock_screen =
          std::strcmp(WorkerReadinessProbe::ProbeConsoleSessionState(),
                      macos::kNativeSessionStateLocked) == 0;
      if (!on_lock_screen || !unlock_configured_ || unlock_pending_ ||
          unlock_attempts_ms_.size() >= 10 || !unlock_requester_ ||
          !unlock_requester_(true)) {
        (void)SendControlRejected(kind, imcodes::rd::kRejectUnlockUnavailable);
      } else {
        unlock_attempts_ms_.push_back(now_ms);
        unlock_pending_ = true;
      }
      accepted = true;
    }
  }

  if (!accepted || !activity())
    return;
  if (acknowledge)
    (void)SendInputAck(message.correlation.sequence);
}

// Bridges the live session/disclosure/socket onto the abstract seams the
// dispatcher is written against. The dispatcher itself is compiled and
// exercised by the standalone native test binary, which cannot link
// ScreenCaptureKit or libwebrtc.
class SessionSeamAdapter final : public macos::HostCommandSessionSeam {
 public:
  using ReadinessAttestor =
      std::function<bool(const rd::common::CapabilityReadiness&)>;

  SessionSeamAdapter(macos::MacosRemoteDesktopSession* session,
                     macos::MacosTransportSessionAdapter* transport,
                     std::uint64_t worker_generation,
                     WorkerSocketEmitter* emitter,
                     WorkerTransportSink* transport_sink,
                     ReadinessAttestor readiness_attestor = {}) noexcept
      : session_(session),
        transport_(transport),
        worker_generation_(worker_generation),
        emitter_(emitter),
        transport_sink_(transport_sink),
        readiness_attestor_(std::move(readiness_attestor)) {}

  bool Prepare(const imcodes::rd::Authority& authority,
               std::int64_t now_unix_ms,
               std::int64_t now_monotonic_ms) override {
    if (session_ == nullptr || transport_ == nullptr || active_)
      return false;
    std::vector<macos::MacosTransportIceServer> ice_servers =
        TransportIceServers(authority);
    if (!transport_->ConfigureIceServers(std::move(ice_servers)))
      return false;
    macos::MacosRemoteDesktopStartRequest request;
    request.worker_generation = worker_generation_;
    request.viewers = 1;
    request.controllers = authority.mode == imcodes::rd::kControlMode ? 1 : 0;
    request.route_authority = CommonAuthority(authority);
    request.authority_now = {now_unix_ms, now_monotonic_ms};
    if (!session_->Start(request))
      return false;
    // Start is the production composition boundary: it probes the owned
    // capture/encoder/input/display/disclosure/session-monitor adapters and
    // commits that observation to session->readiness(). LoginWindow readiness
    // cannot be authored before this point or inferred by the daemon.
    if (readiness_attestor_ &&
        !readiness_attestor_(session_->readiness())) {
      session_->Stop();
      return false;
    }
    authority_ = authority;
    active_ = true;
    if (emitter_ != nullptr)
      emitter_->BindAuthority(authority_);
    if (transport_sink_ != nullptr)
      (void)transport_sink_->RefreshStatus();
    return true;
  }

  // OFFER, ICE and STOP carry only request, session and capability on the
  // wire -- generations are omitted by protocol. Comparing them raw against the
  // bound authority compared 0 and nullopt with the prepared values, so the
  // first OFFER was refused, no ANSWER was ever sent, and every macOS session
  // stalled on "connecting". They are bound from the prepared authority first,
  // exactly as LEASE and MODE already were.
  bool NegotiateOffer(const imcodes::rd::Authority& authority,
                      std::string_view offer_sdp,
                      std::string* answer_sdp) override {
    const imcodes::rd::Authority bound =
        imcodes::rd::BindOmittedAuthorityFields(authority_, authority);
    return Matches(bound) && session_ != nullptr && answer_sdp != nullptr &&
           session_->NegotiateOffer(offer_sdp, answer_sdp);
  }

  bool AddRemoteIce(const imcodes::rd::Authority& authority,
                    std::string_view media_id,
                    std::string_view candidate) override {
    const imcodes::rd::Authority bound =
        imcodes::rd::BindOmittedAuthorityFields(authority_, authority);
    return Matches(bound) && session_ != nullptr &&
           session_->AddRemoteIceCandidate(
               CommonAuthority(bound).identity,
               rd::common::IceCandidate{std::string(media_id),
                                        std::string(candidate)});
  }

  bool RenewLease(const imcodes::rd::Authority& authority,
                  std::int64_t now_unix_ms,
                  std::int64_t now_monotonic_ms) override {
    const imcodes::rd::Authority bound =
        imcodes::rd::BindOmittedAuthorityFields(authority_, authority);
    if (!Matches(bound) || session_ == nullptr ||
        !session_->RenewRouteAuthority(CommonAuthority(bound),
                                       {now_unix_ms, now_monotonic_ms})) {
      return false;
    }
    authority_ = bound;
    if (emitter_ != nullptr)
      emitter_->BindAuthority(authority_);
    return true;
  }

  bool SetMode(const imcodes::rd::Authority& authority,
               std::string_view /*reason*/,
               std::int64_t now_unix_ms,
               std::int64_t now_monotonic_ms) override {
    const imcodes::rd::Authority bound =
        imcodes::rd::BindOmittedAuthorityFields(authority_, authority);
    if (!Matches(bound) || session_ == nullptr ||
        !session_->ApplyModeAuthority(CommonAuthority(bound),
                                      {now_unix_ms, now_monotonic_ms})) {
      return false;
    }
    authority_ = bound;
    if (emitter_ != nullptr)
      emitter_->BindAuthority(authority_);
    if (transport_sink_ != nullptr)
      (void)transport_sink_->RefreshStatus();
    return true;
  }

  bool Stop(const imcodes::rd::Authority& authority) override {
    if (!Matches(imcodes::rd::BindOmittedAuthorityFields(authority_, authority))
        || session_ == nullptr)
      return false;
    session_->Stop();
    active_ = false;
    if (emitter_ != nullptr)
      emitter_->ClearAuthority();
    return true;
  }

  // The route table routes by these; this adapter is one route.
  bool Serves(const imcodes::rd::Authority& authority) const override {
    return active_ && authority.request_id == authority_.request_id &&
           authority.session_id == authority_.session_id;
  }
  std::size_t live_routes() const override { return active_ ? 1 : 0; }
  std::size_t max_routes() const override { return 1; }

 private:
  bool Matches(const imcodes::rd::Authority& authority) const noexcept {
    return active_ && authority.request_id == authority_.request_id &&
           authority.session_id == authority_.session_id &&
           authority.capability == authority_.capability &&
           authority.daemon_generation == authority_.daemon_generation &&
           authority.route_generation == authority_.route_generation;
  }

  macos::MacosRemoteDesktopSession* session_;
  macos::MacosTransportSessionAdapter* transport_;
  std::uint64_t worker_generation_;
  WorkerSocketEmitter* emitter_;
  WorkerTransportSink* transport_sink_;
  ReadinessAttestor readiness_attestor_;
  imcodes::rd::Authority authority_;
  bool active_ = false;
};

// One viewer's composition. Members are declared in dependency order, so
// they are destroyed in the order the single-viewer worker always tore down:
// the command seam and session first, then the transport, then the sink and
// the socket emitter the transport reports through.
struct WorkerRoute {
  std::unique_ptr<WorkerSocketEmitter> emitter;
  std::unique_ptr<WorkerTransportSink> sink;
  std::unique_ptr<macos::MacosTransportSessionAdapter> adapter;
  std::unique_ptr<RouteDisclosure> disclosure;
  std::unique_ptr<macos::MacosRemoteDesktopSession> session;
  // Owned by the session; sampled for media progress.
  const macos::MacosMediaSenderBinder* media_binder = nullptr;
  std::unique_ptr<SessionSeamAdapter> seam;
  std::int64_t negotiation_started_ms = 0;
  std::int64_t last_media_sample_ms = 0;
  bool media_status_sent = false;
};

// Every viewer of this worker, each on its own route, up to the cap every
// worker shares (kMaxSessions). Host commands reach the route their authority
// names; a PREPARE for a new session opens one.
class WorkerRouteTable final : public macos::HostCommandSessionSeam {
 public:
  using Compose = std::function<std::unique_ptr<WorkerRoute>()>;
  using Admitted = std::function<void(WorkerRoute&)>;

  WorkerRouteTable(Compose compose, Admitted admitted)
      : compose_(std::move(compose)), admitted_(std::move(admitted)) {}
  ~WorkerRouteTable() override { StopAll(); }
  WorkerRouteTable(const WorkerRouteTable&) = delete;
  WorkerRouteTable& operator=(const WorkerRouteTable&) = delete;

  // Composes the next route ahead of its PREPARE.
  bool Warm() {
    if (spare_ == nullptr)
      spare_ = compose_();
    return spare_ != nullptr;
  }

  bool Prepare(const imcodes::rd::Authority& authority,
               std::int64_t now_unix_ms,
               std::int64_t now_monotonic_ms) override {
    if (Find(authority) != nullptr || routes_.size() >= max_routes())
      return false;
    std::unique_ptr<WorkerRoute> route =
        spare_ != nullptr ? std::move(spare_) : compose_();
    if (route == nullptr ||
        !route->seam->Prepare(authority, now_unix_ms, now_monotonic_ms)) {
      return false;
    }
    if (admitted_)
      admitted_(*route);
    routes_.push_back(std::move(route));
    return true;
  }
  bool NegotiateOffer(const imcodes::rd::Authority& authority,
                      std::string_view offer_sdp,
                      std::string* answer_sdp) override {
    WorkerRoute* route = Find(authority);
    return route != nullptr &&
           route->seam->NegotiateOffer(authority, offer_sdp, answer_sdp);
  }
  bool AddRemoteIce(const imcodes::rd::Authority& authority,
                    std::string_view media_id,
                    std::string_view candidate) override {
    WorkerRoute* route = Find(authority);
    return route != nullptr &&
           route->seam->AddRemoteIce(authority, media_id, candidate);
  }
  bool RenewLease(const imcodes::rd::Authority& authority,
                  std::int64_t now_unix_ms,
                  std::int64_t now_monotonic_ms) override {
    WorkerRoute* route = Find(authority);
    return route != nullptr &&
           route->seam->RenewLease(authority, now_unix_ms, now_monotonic_ms);
  }
  bool SetMode(const imcodes::rd::Authority& authority,
               std::string_view reason,
               std::int64_t now_unix_ms,
               std::int64_t now_monotonic_ms) override {
    WorkerRoute* route = Find(authority);
    return route != nullptr && route->seam->SetMode(authority, reason,
                                                    now_unix_ms,
                                                    now_monotonic_ms);
  }
  bool Stop(const imcodes::rd::Authority& authority) override {
    WorkerRoute* route = Find(authority);
    if (route == nullptr)
      return false;
    const bool stopped = route->seam->Stop(authority);
    Remove(route);
    return stopped;
  }
  bool Serves(const imcodes::rd::Authority& authority) const override {
    return Find(authority) != nullptr;
  }
  std::size_t live_routes() const override { return routes_.size(); }
  std::size_t max_routes() const override {
    return imcodes::rd::kMaxSessions;
  }

  // A route whose transport already ended (and said so) leaves the table.
  void Retire(WorkerRoute* route) {
    if (route->session != nullptr)
      route->session->Stop();
    Remove(route);
  }
  void StopAll() {
    for (const auto& route : routes_) {
      if (route->session != nullptr)
        route->session->Stop();
    }
    routes_.clear();
    spare_.reset();
  }

  // Snapshots, so a route may be retired while iterating.
  [[nodiscard]] std::vector<WorkerRoute*> live() const {
    std::vector<WorkerRoute*> out;
    for (const auto& route : routes_)
      out.push_back(route.get());
    return out;
  }
  [[nodiscard]] std::vector<macos::MacosRemoteDesktopSession*> sessions()
      const {
    std::vector<macos::MacosRemoteDesktopSession*> out;
    for (const auto& route : routes_)
      out.push_back(route->session.get());
    return out;
  }
  [[nodiscard]] std::uint64_t real_frames_encoded() const {
    std::uint64_t total = 0;
    for (const auto& route : routes_)
      total += route->session->real_frames_encoded();
    return total;
  }
  [[nodiscard]] bool media_active() const {
    for (const auto& route : routes_) {
      if (route->session->media_active())
        return true;
    }
    return false;
  }

 private:
  WorkerRoute* Find(const imcodes::rd::Authority& authority) const {
    for (const auto& route : routes_) {
      if (route->seam->Serves(authority))
        return route.get();
    }
    return nullptr;
  }
  void Remove(WorkerRoute* route) {
    for (auto it = routes_.begin(); it != routes_.end(); ++it) {
      if (it->get() == route) {
        routes_.erase(it);
        return;
      }
    }
  }

  Compose compose_;
  Admitted admitted_;
  std::unique_ptr<WorkerRoute> spare_;
  std::vector<std::unique_ptr<WorkerRoute>> routes_;
};

class DisclosureSeamAdapter final : public macos::HostCommandDisclosureSeam {
 public:
  explicit DisclosureSeamAdapter(
      macos::DisclosureAdmission* disclosure) noexcept
      : disclosure_(disclosure) {}
  [[nodiscard]] bool route_admissible() const override {
    return disclosure_ != nullptr && disclosure_->route_admissible();
  }

 private:
  macos::DisclosureAdmission* disclosure_;
};

class SocketMessageSink final : public macos::HostCommandMessageSink {
 public:
  explicit SocketMessageSink(WorkerSocketEmitter* emitter) noexcept
      : emitter_(emitter) {}
  [[nodiscard]] bool EmitInitialMode(
      const imcodes::rd::Authority& authority) override {
    return EmitModeState(authority, "initial");
  }
  [[nodiscard]] bool EmitAnswer(const imcodes::rd::Authority& authority,
                                std::string_view answer_sdp) override {
    Json::Value message =
        imcodes::rd::BaseEnvelope(imcodes::rd::kAnswerType, authority);
    message["sdp"] = std::string(answer_sdp);
    return Emit(message);
  }
  [[nodiscard]] bool EmitModeState(const imcodes::rd::Authority& authority,
                                   std::string_view reason) override {
    Json::Value message =
        imcodes::rd::BaseEnvelope(imcodes::rd::kModeStateType, authority);
    message["mode"] = authority.mode;
    message["inputEpoch"] = authority.input_epoch;
    message["reason"] = std::string(reason);
    return Emit(message);
  }
  [[nodiscard]] bool EmitTerminal(const imcodes::rd::Authority& authority,
                                  std::string_view reason,
                                  std::string_view detail) override {
    Json::Value message =
        imcodes::rd::TerminalEnvelope(authority, std::string(reason).c_str());
    if (!detail.empty())
      message["detail"] = std::string(detail);
    return Emit(message);
  }

 private:
  bool Emit(const Json::Value& message) {
    return emitter_ != nullptr && emitter_->Emit(message);
  }

  WorkerSocketEmitter* emitter_;
};

// Applies one accepted HOST_COMMAND. Returns false to terminate the loop.
bool HandleHostCommand(const macos::HostCommandFrame& frame,
                       macos::HostCommandSessionSeam* session,
                       macos::DisclosureAdmission* disclosure,
                       WorkerSocketEmitter* emitter) {
  DisclosureSeamAdapter disclosure_seam(disclosure);
  SocketMessageSink sink(emitter);
  Json::Value command;
  const rd::common::TransportTime now = SampleNow();
  if (!imcodes::rd::ParseJson(frame.command_json, &command)) {
    std::cerr << macos::kDiagMalformedCommand << "\n";
    return false;
  }
  const std::optional<imcodes::rd::Signal> signal =
      imcodes::rd::ParseServiceSignal(command, now.unix_ms);
  if (!signal.has_value()) {
    std::cerr << macos::kDiagMalformedCommand << "\n";
    return false;
  }
  const macos::HostCommandResult result = macos::DispatchHostCommand(
      *signal, now.unix_ms, now.monotonic_ms, session, &disclosure_seam, &sink);
  if (!result.diagnostic.empty()) {
    std::cerr << result.diagnostic << "\n";
  }
  return result.disposition == macos::HostCommandDisposition::kContinue;
}

/**
 * The worker's one reader of the daemon socket.
 *
 * Host commands and virtual-display replies share this stream. The display
 * backend needs a SYNCHRONOUS answer, and the only process that may read this
 * descriptor is this loop -- so the exchange re-enters the same reader rather
 * than starting a second one. Frames that are not the awaited reply are
 * queued in arrival order and handed back to the loop afterwards.
 *
 * That distinction matters: a second concurrent reader would consume half a
 * frame from the shared accumulator and the two readers would disagree about
 * where the next frame begins. One reader, re-entered, cannot.
 *
 * Exactly one request may be outstanding. A reply that does not match the
 * outstanding id is not a late answer to be matched later -- it is refused and
 * the channel goes terminal, because a stream whose correlation has slipped
 * cannot be resynchronized by guessing.
 */
// Keeps the physical display awake for the life of this worker (one session).
//
// A Mac left at the lock screen turns its display off after the idle timeout,
// and every capture API then delivers a dark display: the viewer connected to a
// black picture until some other tool woke the screen. UU Remote does exactly
// this on connect -- a "UserIsActive" declaration to turn the display on, plus
// an idle-sleep assertion while it is attached -- and so does this, released
// with the session. Declaring activity is a documented power-management call;
// it neither unlocks the Mac nor bypasses anything the lock screen enforces.
class DisplayWakeGuard {
 public:
  DisplayWakeGuard() {
    DeclareActivity();
    (void)IOPMAssertionCreateWithName(
        kIOPMAssertPreventUserIdleDisplaySleep, kIOPMAssertionLevelOn,
        CFSTR("aiDesk.to remote desktop session"), &display_assertion_);
  }
  ~DisplayWakeGuard() {
    if (display_assertion_ != kIOPMNullAssertionID)
      (void)IOPMAssertionRelease(display_assertion_);
    if (activity_assertion_ != kIOPMNullAssertionID)
      (void)IOPMAssertionRelease(activity_assertion_);
  }
  DisplayWakeGuard(const DisplayWakeGuard&) = delete;
  DisplayWakeGuard& operator=(const DisplayWakeGuard&) = delete;

  // Re-declared periodically: the lock screen dims on its own idle timer even
  // while display sleep is prevented.
  void Refresh(std::int64_t monotonic_ms) {
    if (monotonic_ms - last_declared_ms_ < kRedeclareIntervalMs)
      return;
    last_declared_ms_ = monotonic_ms;
    DeclareActivity();
  }

 private:
  static constexpr std::int64_t kRedeclareIntervalMs = 20'000;

  void DeclareActivity() {
    (void)IOPMAssertionDeclareUserActivity(
        CFSTR("aiDesk.to remote desktop viewer attached"),
        kIOPMUserActiveLocal, &activity_assertion_);
  }

  IOPMAssertionID display_assertion_ = kIOPMNullAssertionID;
  IOPMAssertionID activity_assertion_ = kIOPMNullAssertionID;
  std::int64_t last_declared_ms_ = 0;
};

class DaemonDisplayChannel {
 public:
  DaemonDisplayChannel(int descriptor, std::uint64_t worker_generation,
                       std::uint32_t timeout_ms)
      : descriptor_(descriptor),
        worker_generation_(worker_generation),
        timeout_ms_(timeout_ms),
        owner_(std::this_thread::get_id()) {}

  /** Reads whatever is available, returning only the non-reply frames. */
  [[nodiscard]] bool ReadFrames(std::vector<std::string>* out) {
    out->clear();
    if (!deferred_.empty()) {
      out->swap(deferred_);
      return true;
    }
    std::vector<std::string> frames;
    if (!ReadOnce(&frames)) return false;
    for (std::string& frame : frames) Route(std::move(frame), out);
    return true;
  }

  [[nodiscard]] bool terminal() const noexcept { return terminal_; }
  [[nodiscard]] bool eof() const noexcept { return eof_; }
  void GoTerminal() noexcept { terminal_ = true; }

  /**
   * One bounded, serial round trip.
   *
   * Refuses outright when called from any thread but the loop's. A display
   * teardown can arrive on a dispatch queue, and reading this descriptor from
   * there would be the concurrent read this class exists to prevent. Refusing
   * is fail-closed: the agent reaps the route when the generation ends.
   */
  [[nodiscard]] bool Exchange(std::string_view request_json,
                              macos::VirtualDisplayReplyShape shape,
                              macos::VirtualDisplayProxyReply* reply) {
    if (reply == nullptr || terminal_ || eof_) return false;
    if (std::this_thread::get_id() != owner_) return false;
    if (outstanding_ != 0) return false;  // serial, by construction

    ++next_request_id_;
    std::string frame;
    if (!macos::BuildVirtualDisplayRequestFrame(
            worker_generation_, next_request_id_, request_json, &frame)) {
      return false;
    }
    if (!WriteFrame(descriptor_, frame)) {
      terminal_ = true;
      return false;
    }
    outstanding_ = next_request_id_;
    expected_shape_ = shape;
    answered_ = false;

    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(timeout_ms_);
    while (!answered_ && !terminal_ && !eof_) {
      const auto now = std::chrono::steady_clock::now();
      if (now >= deadline) break;
      const auto remaining =
          std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
      pollfd descriptor{descriptor_, POLLIN, 0};
      const int ready = ::poll(&descriptor, 1, static_cast<int>(remaining.count()));
      if (ready < 0) {
        if (errno == EINTR) continue;
        terminal_ = true;
        break;
      }
      if (ready == 0) break;
      std::vector<std::string> frames;
      if (!ReadOnce(&frames)) break;
      for (std::string& read : frames) Route(std::move(read), &deferred_);
    }

    const bool answered = answered_;
    // Spent either way. A timed-out id is never revived: the late answer to it
    // would otherwise correlate against a later request.
    outstanding_ = 0;
    answered_ = false;
    if (!answered) return false;
    *reply = answer_;
    return true;
  }

 private:
  [[nodiscard]] bool ReadOnce(std::vector<std::string>* frames) {
    std::vector<char> chunk(kReadChunkBytes);
    const ssize_t count = ::read(descriptor_, chunk.data(), chunk.size());
    if (count == 0) { eof_ = true; return false; }
    if (count < 0) {
      if (errno == EINTR) return true;
      terminal_ = true;
      return false;
    }
    if (!reader_.Feed(
            std::string_view(chunk.data(), static_cast<std::size_t>(count)),
            frames)) {
      terminal_ = true;
      return false;
    }
    return true;
  }

  void Route(std::string frame, std::vector<std::string>* out) {
    if (macos::ClassifyHostFrame(frame) !=
        macos::HostFrameKind::kVirtualDisplayReply) {
      out->push_back(std::move(frame));
      return;
    }
    macos::VirtualDisplayReplyFrame parsed;
    const auto outcome = macos::ParseVirtualDisplayReplyFrame(
        frame, worker_generation_, expected_shape_, &parsed);
    // A malformed or stale reply is not something to skip past. Both mean this
    // stream is being written by something that does not agree with us about
    // which session this is.
    if (outcome != macos::HostFrameOutcome::kAccepted
        || outstanding_ == 0 || parsed.request_id != outstanding_ || answered_) {
      terminal_ = true;
      return;
    }
    answer_ = std::move(parsed.reply);
    answered_ = true;
  }

  int descriptor_ = -1;
  std::uint64_t worker_generation_ = 0;
  std::uint32_t timeout_ms_ = 5'000;
  std::thread::id owner_;
  macos::FrameReader reader_;
  std::vector<std::string> deferred_;
  std::uint64_t next_request_id_ = 0;
  std::uint64_t outstanding_ = 0;
  macos::VirtualDisplayReplyShape expected_shape_ =
      macos::VirtualDisplayReplyShape::kReadiness;
  bool answered_ = false;
  bool terminal_ = false;
  bool eof_ = false;
  macos::VirtualDisplayProxyReply answer_;
};

// Running macOS version, read from the OS rather than the build SDK: one
// signed artifact ships to every supported release and the login-window
// capture backend is chosen from what is actually running.
void RunningMacosVersion(std::uint32_t* major, std::uint32_t* minor) {
  const NSOperatingSystemVersion version =
      [[NSProcessInfo processInfo] operatingSystemVersion];
  if (major != nullptr) *major = static_cast<std::uint32_t>(version.majorVersion);
  if (minor != nullptr) *minor = static_cast<std::uint32_t>(version.minorVersion);
}

// Drives one session for one generation. Returns the process exit status.
//
// Every exit path below is fail-closed: the session is stopped and the socket
// closed before returning, so no path leaves capture running or input held.
int RunLaunchAgentSession(const macos::WorkerLaunchContext& context) {
  const int descriptor = ConnectProtectedSocket(context.socket_path);
  if (descriptor < 0) {
    std::cerr << "macos_remote_desktop_worker_socket_connect_failed\n";
    return EX_UNAVAILABLE;
  }

  std::string hello;
  if (!macos::BuildHelloFrame(context, &hello) ||
      !WriteFrame(descriptor, hello)) {
    ::close(descriptor);
    std::cerr << "macos_remote_desktop_worker_hello_failed\n";
    return EX_PROTOCOL;
  }

  const bool graphical_bootstrap =
      macos::IsGraphicalBootstrapLaunchContext(context);
  if (context.session_type == macos::kSessionTypeLoginWindow &&
      !graphical_bootstrap) {
    ::close(descriptor);
    std::cerr << "macos_remote_desktop_worker_loginwindow_bootstrap_required\n";
    return EX_NOPERM;
  }
  std::optional<macos::IpcAuthenticationAcknowledgement> authenticated_peer;
  if (graphical_bootstrap) {
    std::string acknowledgement;
    macos::IpcAuthenticationAcknowledgement parsed;
    if (!ReadAuthenticationFrame(descriptor, &acknowledgement) ||
        !macos::ParseIpcAuthenticationAcknowledgement(
            acknowledgement, context, &parsed)) {
      ::close(descriptor);
      std::cerr << "macos_remote_desktop_worker_ipc_authentication_failed\n";
      return EX_NOPERM;
    }
    authenticated_peer = std::move(parsed);
  }

  // Every viewer's frames share this socket.
  std::mutex socket_write_mutex;
  WorkerSocketEmitter host_emitter(descriptor, context.worker_generation,
                                   &socket_write_mutex);

  macos::DisclosureAdmission disclosure(context.worker_generation);
  DisclosureSupervisor disclosure_process;
  if (!disclosure_process.EnsureVisible(context.worker_generation, 1, 0,
                                        &disclosure)) {
    ::close(descriptor);
    std::cerr << "macos_remote_desktop_worker_disclosure_launch_failed\n";
    return EX_UNAVAILABLE;
  }
  DisclosureRoster roster(&disclosure_process, &disclosure,
                          context.worker_generation);

  // Session-type admission, before anything is composed.
  //
  // The capability profile is derived from the authenticated session type the
  // LaunchAgent passed in, not from a probe of the current desktop: an Aqua
  // probe run at the login window would report a user's surface that does not
  // exist there. A worker that fell through to the ordinary Aqua composition
  // would hand the login window clipboard, files and shell.
  macos::CaptureSessionBinding session_binding;
  session_binding.session_type = context.session_type;
  session_binding.audit_session_id = context.audit_session_id;
  session_binding.uid = context.uid;
  session_binding.launch_challenge = context.challenge;
  session_binding.worker_generation = context.worker_generation;
  if (!session_binding.IsComplete()) {
    disclosure_process.Terminate();
    ::close(descriptor);
    std::cerr << "macos_remote_desktop_worker_session_binding_incomplete\n";
    return EX_USAGE;
  }
  // The launch context arrived through the environment, which whoever started
  // this process could have written. Re-derived from the kernel and the window
  // server and required to be identical, so a forged session type cannot buy
  // the Aqua profile at a login window -- or the reverse.
  if (!macos::MacosSessionIdentityMatches(
          macos::ObserveMacosSessionIdentity(), session_binding.session_type,
          session_binding.audit_session_id, session_binding.uid)) {
    disclosure_process.Terminate();
    ::close(descriptor);
    std::cerr << "macos_remote_desktop_worker_session_identity_mismatch\n";
    return EX_NOPERM;
  }

  const macos::SessionCapabilityProfile session_profile =
      macos::CapabilityProfileFor(session_binding.session_type);

  // Display control is UNAVAILABLE here by design.
  //
  // Ownership of the helper belongs to the RESIDENT LaunchAgent, not to this
  // per-route worker: a helper this process spawned would die with the route,
  // and any authority it minted would be one it invented rather than one the
  // Node selector granted.
  //
  // The complete-set authority previously travelled in the LaunchAgent plist
  // environment. That channel has been REMOVED, not kept alongside the
  // replacement -- two production authority channels is strictly worse than
  // one, because the weaker of the two is what an attacker uses.

  // The login window owns its own capture path: ScreenCaptureKit only serves
  // that surface from 14.4, so below it the real CGDisplayStream backend is
  // driven through the identical bounds.
  //
  // The session's own capture adapter owns the selected backend. Selection is
  // made here, from the running release, and handed to the composition: a
  // separate supervisor stream would be a second live stream on the same
  // display whose frames reach no encoder, which proves nothing about whether
  // the session can capture.
  DisplayWakeGuard display_wake;
  // One reader for this descriptor, shared by the loop below and by every
  // display exchange. Declared here so the session outlives neither.
  DaemonDisplayChannel display_channel(descriptor, context.worker_generation,
                                       kDaemonDisplayTimeoutMs);
  std::uint64_t display_nonce = 0;

  std::uint64_t unlock_request_id = 0;
  const auto send_unlock_request = [&](bool reveal) {
    std::string frame;
    if (!macos::BuildUnlockRequestFrame(context.worker_generation,
                                        ++unlock_request_id, reveal, &frame)) {
      return false;
    }
    return host_emitter.WriteRaw(frame);
  };

  // One viewer's own composition: its peer connection, capture stream,
  // encoder binding and status stream. Viewers share the worker, the
  // disclosure and the display channel, as on Windows and Linux.
  const auto compose_route = [&]() -> std::unique_ptr<WorkerRoute> {
    auto route = std::make_unique<WorkerRoute>();
    route->emitter = std::make_unique<WorkerSocketEmitter>(
        descriptor, context.worker_generation, &socket_write_mutex);
    route->sink = std::make_unique<WorkerTransportSink>();
    auto backend = macos::CreatePinnedLibwebrtcTransportBackend();
    if (backend == nullptr) {
      std::cerr << "macos_remote_desktop_worker_transport_absent\n";
      return nullptr;
    }
    WorkerSocketEmitter* emitter = route->emitter.get();
    macos::MacosPeerConnectionBackend* backend_view = backend.get();
    route->adapter = std::make_unique<macos::MacosTransportSessionAdapter>(
        std::move(backend), *route->sink,
        std::vector<macos::MacosTransportIceServer>{},
        [emitter](const rd::common::IceCandidate& candidate) {
          return emitter->EmitLocalIce(candidate);
        });
    backend_view->BindAdapter(route->adapter.get());
    // The binder IS the production sender for the route's whole life --
    // fail-closed until the transport binds libwebrtc's EncodedImageCallback
    // into it (after the track is added and negotiation settles), a straight
    // delegate afterwards.
    auto media_binder = std::make_unique<macos::MacosMediaSenderBinder>();
    backend_view->BindMediaSender(media_binder.get());
    route->media_binder = media_binder.get();
    route->disclosure = std::make_unique<RouteDisclosure>(&roster);

    // Wake the display before choosing and starting capture, so the first frames
    // are of a lit screen rather than a sleeping one.
    std::unique_ptr<macos::ScreenCaptureKitBackend> capture_backend;
    {
      macos::LoginWindowCaptureRequest capture_request;
      capture_request.binding = session_binding;
      RunningMacosVersion(&capture_request.os_major, &capture_request.os_minor);
      const macos::LoginWindowCaptureOutcome capture_outcome =
          macos::ComposeSessionCapture(
              capture_request, nullptr,
              [locked = std::string_view(
                            WorkerReadinessProbe::ProbeConsoleSessionState()) ==
                        macos::kNativeSessionStateLocked,
               aqua = session_binding.session_type == macos::kSessionTypeAqua](
                  macos::LoginWindowCaptureBackend selected)
                  -> std::unique_ptr<macos::ScreenCaptureKitBackend> {
                switch (selected) {
                  case macos::LoginWindowCaptureBackend::kScreenCaptureKit:
                    // ScreenCaptureKit never delivers the lock screen: the
                    // shield is excluded from every stream, so a locked Mac is
                    // a black picture with a cursor. CGDisplayStream composites
                    // the whole display, shield included -- the path other
                    // remote-desktop products use to show and unlock it.
                    if (aqua && locked) {
                      std::cerr << "macos_remote_desktop_worker_capture_locked_cgdisplaystream\n";
                      return macos::CreateCgDisplayStreamBackend();
                    }
                    return macos::CreateAppleScreenCaptureKitBackend();
                  case macos::LoginWindowCaptureBackend::kCgDisplayStream:
                    return macos::CreateCgDisplayStreamBackend();
                  case macos::LoginWindowCaptureBackend::kUnavailable:
                    break;
                }
                return nullptr;
              },
              &capture_backend);
      if (capture_outcome.status != macos::LoginWindowCaptureStatus::kOk ||
          capture_backend == nullptr) {
        // Fail closed. A login window that cannot be captured must not fall back
        // to the Aqua composition, which would serve a surface nobody is at.
        std::cerr << "macos_remote_desktop_worker_capture_backend_unavailable\n";
        return nullptr;
      }
    }


    macos::MacosRemoteDesktopProductionConfiguration configuration;
    configuration.worker_generation = context.worker_generation;
    configuration.session_type = session_binding.session_type;
    configuration.capture_backend = std::move(capture_backend);
    if (!session_profile.clipboard) {
      // Refused through the existing seam rather than by a new flag: the session
      // asks these callbacks for every copy/paste, so returning false here is the
      // enforcement, not a hint. There is no logged-in user at the login window,
      // so a copy would be reading whatever the previous session left behind.
      configuration.request_copy = [](std::uint64_t) { return false; };
      configuration.request_paste = [](std::uint64_t) { return false; };
    }
    // Display ownership is proxied through the daemon, never constructed here.
    // This process holds a ROUTE capability, not the helper's; a supervisor
    // failure makes every display request a refusal rather than a fallback to an
    // in-process CGVirtualDisplay owner.
    configuration.virtual_display_backend =
        std::make_unique<macos::DaemonProxyVirtualDisplayBackend>(
            [&display_channel](std::string_view request,
                               macos::VirtualDisplayReplyShape shape,
                               macos::VirtualDisplayProxyReply* reply) {
              return display_channel.Exchange(request, shape, reply);
            },
            [&display_nonce]() { return ++display_nonce; },
            context.worker_generation, session_binding.uid);
    configuration.transport = route->adapter.get();
    macos::MacosTransportSessionAdapter* adapter_view = route->adapter.get();
    configuration.negotiate_offer = [adapter_view](std::string_view offer_sdp,
                                                   std::string* answer_sdp) {
      return adapter_view != nullptr &&
             adapter_view->NegotiateOffer(offer_sdp, answer_sdp);
    };
    configuration.pinned_libwebrtc_sender_backend = std::move(media_binder);
    configuration.disclosure = route->disclosure.get();
    configuration.begin_disclosure =
        [&roster](rd::common::WorkerGeneration generation) {
          return roster.BeginGeneration(generation);
        };

    WorkerTransportSink* sink = route->sink.get();
    route->session =
        macos::MacosRemoteDesktopSession::CreateWithPinnedLibwebrtcSender(
            std::move(configuration),
            [sink](const macos::MacosRemoteDesktopSessionEvent& event) {
              if (event.type ==
                      macos::MacosRemoteDesktopSessionEventType::kTerminal &&
                  event.terminal_error.code !=
                      rd::common::TerminalErrorCode::kStopped) {
                sink->OnSessionTerminal(event.terminal_error);
              }
            });
    if (route->session == nullptr) {
      std::cerr << "macos_remote_desktop_worker_composition_unavailable\n";
      return nullptr;
    }
    route->sink->Bind(route->session.get(), route->adapter.get(), emitter);
    route->sink->SetUnlockRequester(send_unlock_request);
    SessionSeamAdapter::ReadinessAttestor readiness_attestor;
    if (session_binding.session_type == macos::kSessionTypeLoginWindow) {
      if (!authenticated_peer.has_value()) {
        std::cerr << "macos_remote_desktop_worker_readiness_authentication_missing\n";
        return nullptr;
      }
      const macos::AuthenticatedGraphicalPeer peer{
          .uid = authenticated_peer->uid,
          .audit_session_id = authenticated_peer->audit_session_id,
          .pid_version = authenticated_peer->pid_version,
          .worker_generation = authenticated_peer->worker_generation,
          .session_type = authenticated_peer->session_type,
          .launch_challenge = authenticated_peer->launch_challenge,
      };
      readiness_attestor =
          [descriptor, binding = session_binding, peer](
              const rd::common::CapabilityReadiness& observed) {
            std::string frame;
            return macos::BuildAuthenticatedGraphicalReadinessFrame(
                       binding, peer, observed, true, &frame) &&
                   WriteFrame(descriptor, frame);
          };
    }

    route->seam = std::make_unique<SessionSeamAdapter>(
        route->session.get(), route->adapter.get(), context.worker_generation,
        emitter, route->sink.get(), std::move(readiness_attestor));
    return route;
  };

  bool privacy_shielded = false;
  WorkerRouteTable routes(compose_route, [&](WorkerRoute& route) {
    // A viewer joining a shielded desktop is shielded too.
    route.negotiation_started_ms = SampleNow().monotonic_ms;
    if (privacy_shielded)
      route.session->SetPrivacyShield(true);
  });
  // The first route is composed now, before anyone asks, exactly as the
  // single-viewer worker always was: the first viewer waits for nothing.
  if (!routes.Warm()) {
    disclosure_process.Terminate();
    ::close(descriptor);
    return EX_UNAVAILABLE;
  }

  // Cleanup commands arrive as fresh sibling processes, so this generation
  // must be reachable over the per-user control socket for as long as it owns
  // the session.
  SessionControlServer control;
  if (!control.Listen(static_cast<std::uint32_t>(::geteuid()))) {
    routes.StopAll();
    disclosure_process.Terminate();
    ::close(descriptor);
    std::cerr << "macos_remote_desktop_worker_control_listen_failed\n";
    return EX_UNAVAILABLE;
  }

  std::vector<std::string> frames;
  int status = EX_OK;
  bool running = true;

  // Negotiations that hang instead of failing outright (peer never reaches
  // an ICE/DTLS terminal state, e.g. a dead network path) never trip any of
  // the callback-driven terminal checks below, and leave a worker plus its
  // disclosure overlay idling forever -- observed live as a stuck "1
  // viewing" indicator on a target that was never actually connected to.
  // `media_status_sent` latches true the first time real media has ever
  // flowed and never resets, so gating on it below cannot affect a
  // connection that did establish, however long it then sits idle.
  //
  // The clock starts at the first REAL host command (PREPARE/OFFER/ICE/STOP),
  // not at process start. This worker is routinely spawned pre-emptively by
  // the resident LaunchAgent, well before any daemon peer has a session to
  // route to it -- an idle standby worker with nobody addressing it yet is
  // not a hung negotiation, and timing it out was the real cause behind a
  // ~60s worker-spawn/self-terminate/relaunch cascade (RunResidentLoop's own
  // "the worker's exit ends the agent" rule treats ANY worker exit, including
  // this one, as the agent's job being done, so launchd's KeepAlive relaunched
  // it into an identical idle worker that timed out again 60s later, forever)
  // -- exactly the churn that starved real connection attempts of an
  // available worker, producing the reported worker_failed /
  // route_authority_rejected on a real prepare/offer/ice. Gating the clock on
  // a real command preserves the original fix's actual target (a negotiation
  // that DID start but got stuck) while never arming for a worker nothing has
  // ever addressed.
  constexpr std::int64_t kConnectionEstablishTimeoutMs = 60'000;
  std::int64_t last_unlock_query_ms = -60'000;
  // A lifted shield is proven by a real frame encoded after the lift; the
  // reply waits for it.
  struct PendingPrivacyRelease {
    std::uint64_t request_id = 0;
    std::uint64_t baseline = 0;
  };
  std::optional<PendingPrivacyRelease> pending_privacy_release;
  const auto send_privacy_reply = [&](std::uint64_t request_id, bool shielded,
                                      std::uint64_t real_frames) {
    std::string frame;
    return macos::BuildPrivacyReplyFrame(context.worker_generation, request_id,
                                         shielded, true, real_frames, &frame) &&
           host_emitter.WriteRaw(frame);
  };
  while (running) {
    std::vector<pollfd> poll_set;
    poll_set.push_back({descriptor, POLLIN, 0});
    poll_set.push_back({control.descriptor(), POLLIN, 0});
    poll_set.push_back({disclosure_process.descriptor(), POLLIN, 0});
    // A libwebrtc terminal callback can arrive on its own thread. A bounded
    // poll lets that one-way terminal wake this loop.
    for (WorkerRoute* route : routes.live())
      poll_set.push_back({route->sink->wake_descriptor(), POLLIN, 0});
    const int ready = ::poll(poll_set.data(), poll_set.size(), 250);
    if (ready < 0) {
      if (errno == EINTR)
        continue;
      std::cerr << "macos_remote_desktop_worker_poll_failed\n";
      status = EX_IOERR;
      break;
    }

    // A route whose transport ended leaves; the others keep streaming. The
    // worker ends with its last route, as the single-viewer worker did.
    const auto retire_ended_routes = [&]() {
      bool ended = false;
      for (WorkerRoute* route : routes.live()) {
        if (route->sink->terminal()) {
          routes.Retire(route);
          ended = true;
        }
      }
      return ended && routes.live_routes() == 0;
    };
    if (retire_ended_routes()) {
      std::cerr << "macos_remote_desktop_worker_transport_terminal\n";
      status = EX_UNAVAILABLE;
      break;
    }
    for (WorkerRoute* route : routes.live())
      route->sink->DrainEvents();
    if (retire_ended_routes()) {
      std::cerr << "macos_remote_desktop_worker_transport_terminal\n";
      status = EX_UNAVAILABLE;
      break;
    }
    for (WorkerRoute* route : routes.live()) {
      route->sink->ObserveTypedUnlock();
      route->sink->DrainQualityTarget();
    }

    // Outbound media progress, once a second per route -- the Windows
    // worker's stats cadence. It arms the stall watchdog and is the only
    // source of `mediaStarted`; without it the Server never considers a macOS
    // route connected and fails every session at its negotiation deadline.
    {
      const rd::common::TransportTime now = SampleNow();
      display_wake.Refresh(now.monotonic_ms);
      if (pending_privacy_release.has_value()) {
        // No media means no viewer can be shown anything; the lift is then
        // proven by the next generation number rather than a frame that will
        // never be captured.
        const std::uint64_t real = routes.real_frames_encoded();
        if (real > pending_privacy_release->baseline ||
            !routes.media_active()) {
          (void)send_privacy_reply(
              pending_privacy_release->request_id, false,
              std::max(real, pending_privacy_release->baseline + 1));
          pending_privacy_release.reset();
        }
      }
      // Whether a sign-in secret is configured changes only when the owner
      // sets or clears it; a slow poll keeps unlockAvailable honest.
      if (now.monotonic_ms - last_unlock_query_ms >= 15'000) {
        last_unlock_query_ms = now.monotonic_ms;
        (void)send_unlock_request(false);
      }
      for (WorkerRoute* route : routes.live()) {
        if (now.monotonic_ms - route->last_media_sample_ms < 1'000)
          continue;
        route->last_media_sample_ms = now.monotonic_ms;
        const std::uint64_t bytes = route->media_binder->accepted_bytes();
        (void)route->session->RecordMediaProgress(bytes, now);
        if (bytes > 0 && !route->media_status_sent) {
          route->media_status_sent = true;
          (void)route->sink->RefreshStatus();
        }
        // Auto-clean a route that never established: its negotiation started
        // (at its PREPARE) but no real media has ever flowed and the grace
        // window has elapsed. Routed through the same transport-terminal path
        // a live peer disconnect uses, so its teardown is the ordinary one.
        if (!route->media_status_sent &&
            now.monotonic_ms - route->negotiation_started_ms >=
                kConnectionEstablishTimeoutMs) {
          std::cerr << "macos_remote_desktop_worker_connection_never_established\n";
          route->sink->SignalTerminal("connection_never_established");
        }
      }
    }

    // Disclosure first: losing it must revoke admission before any queued host
    // frame gets a chance to be acted on.
    if ((poll_set[2].revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
      if (!disclosure_process.Drain(&disclosure)) {
        std::cerr << "macos_remote_desktop_worker_disclosure_lost\n";
        status = EX_UNAVAILABLE;
        break;
      }
      if (disclosure.terminated()) {
        for (WorkerRoute* route : routes.live()) {
          route->sink->SignalTerminal(disclosure.stop_requested()
                                          ? "stopped_by_local_user"
                                          : "capability_unavailable");
        }
        std::cerr << (disclosure.stop_requested()
                          ? "macos_remote_desktop_worker_local_stop\n"
                          : "macos_remote_desktop_worker_disclosure_lost\n");
        status = EX_OK;
        break;
      }
    }

    if ((poll_set[1].revents & POLLIN) != 0) {
      control.ServeOnce(routes.sessions(), context.worker_generation);
    }

    if ((poll_set[0].revents & (POLLIN | POLLHUP | POLLERR)) == 0)
      continue;
    // Read through the channel so display replies are correlated by the same
    // reader that framed them; only the remaining frames come back here.
    if (!display_channel.ReadFrames(&frames)) {
      if (display_channel.eof()) {
        // EOF is the host going away. Terminate rather than idling: a worker
        // that outlives its host holds capture and input with nobody to revoke
        // them.
        std::cerr << "macos_remote_desktop_worker_host_eof\n";
        status = EX_UNAVAILABLE;
        break;
      }
      std::cerr << "macos_remote_desktop_worker_frame_overflow\n";
      status = EX_PROTOCOL;
      break;
    }
    if (display_channel.terminal()) {
      // A reply that did not correlate means this stream is being written by
      // something that disagrees about which session this is.
      std::cerr << "macos_remote_desktop_worker_display_channel_terminal\n";
      status = EX_PROTOCOL;
      break;
    }
    for (const std::string& frame : frames) {
      if (macos::ClassifyHostFrame(frame) == macos::HostFrameKind::kPrivacyRequest) {
        macos::PrivacyRequestFrame request;
        if (macos::ParsePrivacyRequestFrame(frame, context.worker_generation,
                                            &request) !=
            macos::HostFrameOutcome::kAccepted) {
          std::cerr << "macos_remote_desktop_worker_malformed_host_frame\n";
          status = EX_PROTOCOL;
          running = false;
          break;
        }
        if (request.shield) {
          // Shield first, then release every held key and button, then say so.
          privacy_shielded = true;
          pending_privacy_release.reset();
          for (WorkerRoute* route : routes.live()) {
            route->session->SetPrivacyShield(true);
            for (const char* controller :
                 {"control", "control:position", "keyboard", "pointer",
                  "pointer:position"}) {
              route->session->ReleaseController(controller);
            }
          }
          if (!send_privacy_reply(request.request_id, true,
                                  routes.real_frames_encoded())) {
            status = EX_UNAVAILABLE;
            running = false;
            break;
          }
          std::cerr << "macos_remote_desktop_worker_privacy_shielded\n";
        } else {
          const std::uint64_t baseline = routes.real_frames_encoded();
          privacy_shielded = false;
          for (WorkerRoute* route : routes.live())
            route->session->SetPrivacyShield(false);
          pending_privacy_release =
              PendingPrivacyRelease{request.request_id, baseline};
          std::cerr << "macos_remote_desktop_worker_privacy_released\n";
        }
        continue;
      }
      if (macos::ClassifyHostFrame(frame) == macos::HostFrameKind::kUnlockReply) {
        macos::UnlockReplyFrame reply;
        const auto unlock_outcome = macos::ParseUnlockReplyFrame(
            frame, context.worker_generation, &reply);
        if (unlock_outcome != macos::HostFrameOutcome::kAccepted) {
          std::cerr << "macos_remote_desktop_worker_malformed_host_frame\n";
          status = EX_PROTOCOL;
          running = false;
          break;
        }
        // The stored sign-in goes to the one route that asked for it; the
        // others learn only whether one is configured.
        bool delivered = false;
        for (WorkerRoute* route : routes.live()) {
          if (!delivered && route->sink->unlock_pending()) {
            delivered = true;
            route->sink->OnUnlockReply(reply.configured,
                                       std::move(reply.sign_in_base64url));
          } else {
            route->sink->OnUnlockReply(reply.configured, std::string());
          }
        }
        WipeString(&reply.sign_in_base64url);
        continue;
      }
      macos::HostCommandFrame parsed;
      const auto outcome = macos::ParseHostCommandFrame(
          frame, context.worker_generation, &parsed);
      if (outcome == macos::HostFrameOutcome::kMalformed) {
        std::cerr << "macos_remote_desktop_worker_malformed_host_frame\n";
        status = EX_PROTOCOL;
        running = false;
        break;
      }
      if (outcome == macos::HostFrameOutcome::kStale) {
        // A frame for another generation is a hard stop: continuing would mean
        // this process is being addressed by a host that believes it owns a
        // different session.
        std::cerr << "macos_remote_desktop_worker_stale_generation\n";
        status = EX_PROTOCOL;
        running = false;
        break;
      }
      // Each route arms its own connection-establish watchdog at its PREPARE
      // (see the watchdog's comment above for why never at process start).
      if (!HandleHostCommand(parsed, &routes, &disclosure, &host_emitter)) {
        status = EX_PROTOCOL;
        running = false;
        break;
      }
    }
  }

  control.Close();
  routes.StopAll();
  disclosure_process.Terminate();
  ::close(descriptor);
  return status;
}

}  // namespace

int main(int argc, const char* argv[]) {
  // Refusing root is a hard admission gate: a root worker would hold TCC
  // grants and input-synthesis authority for the wrong principal.
  if (geteuid() == 0) {
    std::cerr << "macos_remote_desktop_worker_refuses_root\n";
    return EX_NOPERM;
  }

  if (macos::IsMacosPermissionResponsibleApplication()) {
    macos::PrepareMacosPermissionResponsibleApplication();
  }

  const bool local_onboarding = macos::IsLocalOnboardingAppLaunch(argc, argv);
  if (macos::IsAiDeskProductMainExecutable() && !local_onboarding) {
    // The same rule the bundle's main executable applies, from one definition.
    (void)macos::ExecAiDeskProductHelper(
        macos::SelectAiDeskProductHelper(argc, argv), argc, argv);
    std::cerr << "aidesk_product_helper_exec_failed\n";
    return EX_UNAVAILABLE;
  }

  WorkerReadinessProbe probe;
  ControlSocketCleanupTarget cleanup;
  auto onboarding = macos::CreateMacosPermissionOnboarding();
  const char* onboarding_argv[] = {
      argc > 0 && argv != nullptr
          ? argv[0]
          : macos::kMacosRemoteDesktopWorkerBundleIdentifier,
      macos::kNativeCommandRequestPermissionsV1,
  };
  if (local_onboarding) {
    argc = 2;
    argv = onboarding_argv;
  }
  const auto command =
      macos::RunNativeCommandV1(argc, argv, &probe, &cleanup, onboarding.get());
  if (command.outcome != macos::NativeCommandOutcome::kNotACommand) {
    if (!command.stdout_text.empty())
      std::cout << command.stdout_text;
    if (!command.stderr_text.empty())
      std::cerr << command.stderr_text;
    switch (command.outcome) {
      case macos::NativeCommandOutcome::kOk:
        return EX_OK;
      case macos::NativeCommandOutcome::kUsage:
        return EX_USAGE;
      default:
        return EX_UNAVAILABLE;
    }
  }

  bool launch_agent = false;
  for (int index = 1; index < argc; ++index) {
    if (argv[index] != nullptr &&
        std::strcmp(argv[index], kLaunchAgentArgument) == 0) {
      launch_agent = true;
    }
  }
  if (!launch_agent) {
    std::cerr << "macos_remote_desktop_worker_unknown_invocation\n";
    return EX_USAGE;
  }

  macos::WorkerLaunchContext context;
  if (!macos::ReadWorkerLaunchContext(&ProcessEnvironmentLookup, &context)) {
    // A missing or malformed launch environment must never be defaulted: a
    // defaulted generation or challenge would let this process attach to a
    // session it was not launched for.
    std::cerr << "macos_remote_desktop_worker_launch_context_invalid\n";
    return EX_CONFIG;
  }
  return RunLaunchAgentSession(context);
}
