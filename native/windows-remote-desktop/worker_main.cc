#include <windows.h>
#include <shellapi.h>
#include <wtsapi32.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <mfapi.h>
#include <objbase.h>

#include "api/audio/audio_device.h"
#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/create_modular_peer_connection_factory.h"
#include "api/enable_media.h"
#include "api/environment/environment_factory.h"
#include "api/make_ref_counted.h"
#include "api/peer_connection_interface.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "modules/audio_device/include/audio_device_default.h"
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/thread.h"
#include "rtc_base/win32_socket_init.h"
#include "third_party/imcodes_remote_desktop/display_capture.h"
#include "third_party/imcodes_remote_desktop/input_injector.h"
#include "third_party/imcodes_remote_desktop/json_protocol.h"
#include "third_party/imcodes_remote_desktop/local_indicator.h"
#include "third_party/imcodes_remote_desktop/mf_h264_encoder.h"
#include "third_party/imcodes_remote_desktop/peer_session.h"
#include "third_party/imcodes_remote_desktop/pipe_ipc.h"
#include "third_party/imcodes_remote_desktop/unlock_secret.h"
#include "third_party/imcodes_remote_desktop/worker_policy.h"
#include "third_party/imcodes_remote_desktop/virtual_display_controller.h"

namespace imcodes::rd {
namespace {

constexpr wchar_t kPipePrefix[] = L"\\\\.\\pipe\\imcodes-remote-desktop-";

HANDLE ConfigureResourceJob() {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return nullptr;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  limits.ProcessMemoryLimit = kMaxWorkerMemoryBytes;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits)) ||
      !AssignProcessToJobObject(job, GetCurrentProcess())) {
    CloseHandle(job);
    return nullptr;
  }
  // Intentionally retained for the lifetime of this process. Windows closes
  // the final handle after process teardown while enforcing the hard cap.
  return job;
}

int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
                                       value.data(), value.size(), nullptr, 0,
                                       nullptr, nullptr);
  if (size <= 0) return {};
  std::string output(static_cast<size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          value.size(), output.data(), size, nullptr,
                          nullptr) != size) {
    return {};
  }
  return output;
}

bool IsSafePipePath(const std::wstring& path) {
  return path.size() > std::size(kPipePrefix) - 1 && path.size() <= 240 &&
         path.starts_with(kPipePrefix) &&
         std::all_of(path.begin() + (std::size(kPipePrefix) - 1), path.end(),
                     [](wchar_t value) {
                       return (value >= L'a' && value <= L'z') ||
                              (value >= L'A' && value <= L'Z') ||
                              (value >= L'0' && value <= L'9') ||
                              value == L'-';
                     });
}

bool ConstantTimeEqual(const std::string& left, const std::string& right) {
  size_t difference = left.size() ^ right.size();
  const size_t count = std::max(left.size(), right.size());
  for (size_t index = 0; index < count; ++index) {
    const uint8_t a = index < left.size()
                          ? static_cast<uint8_t>(left[index]) : 0;
    const uint8_t b = index < right.size()
                          ? static_cast<uint8_t>(right[index]) : 0;
    difference |= static_cast<size_t>(a ^ b);
  }
  return difference == 0;
}

/**
 * Whether this session is locked, asked of Windows rather than guessed from the
 * desktop name: a locked machine rests on the lock curtain, which lives on the
 * user's own desktop and is indistinguishable from a signed-in screen by name
 * alone.
 */
bool CurrentSessionIsLocked() {
  WTSINFOEXW* info = nullptr;
  DWORD bytes = 0;
  if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE,
                                   WTS_CURRENT_SESSION, WTSSessionInfoEx,
                                   reinterpret_cast<LPWSTR*>(&info), &bytes) ||
      !info) {
    return false;
  }
  bool locked = false;
  if (info->Level == 1) {
    // WTS_SESSIONSTATE_LOCK is 0, so this is a comparison and never a mask
    // test: `flags & WTS_SESSIONSTATE_LOCK` is always zero and reports every
    // locked machine as unlocked. Measured on the node: 0x0 while at the lock
    // screen, 0x1 the instant it unlocks.
    locked = info->Data.WTSInfoExLevel1.SessionFlags == WTS_SESSIONSTATE_LOCK;
  }
  WTSFreeMemory(info);
  return locked;
}

std::wstring CurrentInputDesktopName() {
  HDESK desktop = OpenInputDesktop(0, FALSE, GENERIC_ALL);
  if (!desktop) return {};
  wchar_t name[64]{};
  DWORD needed = 0;
  const bool read = GetUserObjectInformationW(
      desktop, UOI_NAME, name, sizeof(name), &needed) != FALSE;
  CloseDesktop(desktop);
  return read ? std::wstring(name) : std::wstring();
}


bool IsLocalSystemProcess() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD needed = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &needed);
  std::vector<uint8_t> storage(needed);
  const bool read = needed > 0 &&
      GetTokenInformation(token, TokenUser, storage.data(), needed, &needed);
  CloseHandle(token);
  if (!read) return false;
  const auto* user = reinterpret_cast<const TOKEN_USER*>(storage.data());
  return IsWellKnownSid(user->User.Sid, WinLocalSystemSid) != FALSE;
}

// Remote desktop carries no audio. The media engine would otherwise build the
// platform Core Audio device, which opens the microphone stack this product
// never uses.
class SilentAudioDeviceModule
    : public webrtc::webrtc_impl::AudioDeviceModuleDefault<
          webrtc::AudioDeviceModule> {};

// Owner id for input the node types on its own behalf. It is separate from any
// session so a viewer disconnecting cannot release, replay, or inherit it.
constexpr char kAutoUnlockOwner[] = "imcodes-auto-unlock";
// The desktop Windows puts the credential box on. The lock curtain is not here
// — it lives on the user's own desktop until a keystroke arrives.
constexpr wchar_t kSignInDesktop[] = L"Winlogon";

// Crash reporting. A structured exception inside libwebrtc or a platform
// subsystem would otherwise close the pipe and look exactly like an ordinary
// disconnect, which is how one Core Audio teardown fault stayed invisible for
// a full release. The filter allocates nothing, holds no lock the faulting
// thread may already own, writes one bounded frame that carries no session,
// capability, media or input data, and always terminates within a bounded
// wait so a wedged pipe can never keep a dead worker alive.
// True only while the indicator/input thread owns the desktop that currently
// receives input. Input during the brief follow is dropped rather than sent to
// the desktop being left behind.
std::atomic<bool> g_input_desktop_ready{false};
std::atomic<PipeChannel*> g_crash_pipe{nullptr};
char g_crash_nonce[64] = {};
char g_crash_line[512] = {};

DWORD WINAPI WriteCrashLine(LPVOID) {
  PipeChannel* pipe = g_crash_pipe.load();
  if (!pipe || !pipe->valid()) return 0;
  pipe->Write(std::string(g_crash_line, strlen(g_crash_line)));
  return 0;
}

void CrashModuleForAddress(const void* address,
                           char (&name)[64],
                           unsigned long long* offset) {
  lstrcpynA(name, "unknown", static_cast<int>(sizeof(name)));
  *offset = 0;
  HMODULE module = nullptr;
  if (!address ||
      !GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          static_cast<LPCWSTR>(address), &module) ||
      !module) {
    return;
  }
  *offset = static_cast<unsigned long long>(
      reinterpret_cast<uintptr_t>(address) -
      reinterpret_cast<uintptr_t>(module));
  wchar_t path[MAX_PATH] = {};
  const DWORD length = GetModuleFileNameW(module, path, MAX_PATH);
  if (length == 0 || length >= MAX_PATH) return;
  const wchar_t* base = path;
  for (const wchar_t* cursor = path; *cursor; ++cursor) {
    if (*cursor == L'\\' || *cursor == L'/') base = cursor + 1;
  }
  size_t out = 0;
  for (; base[out] && out + 1 < sizeof(name); ++out) {
    const wchar_t value = base[out];
    const bool safe = (value >= L'a' && value <= L'z') ||
                      (value >= L'A' && value <= L'Z') ||
                      (value >= L'0' && value <= L'9') || value == L'.' ||
                      value == L'_' || value == L'-';
    name[out] = safe ? static_cast<char>(value) : '_';
  }
  name[out] = '\0';
  if (out == 0) lstrcpynA(name, "unknown", static_cast<int>(sizeof(name)));
}

LONG WINAPI ReportCrashToDaemon(EXCEPTION_POINTERS* pointers) {
  if (pointers && pointers->ExceptionRecord &&
      g_crash_pipe.load() != nullptr) {
    char module[64] = {};
    unsigned long long offset = 0;
    CrashModuleForAddress(pointers->ExceptionRecord->ExceptionAddress, module,
                          &offset);
    snprintf(g_crash_line, sizeof(g_crash_line),
             "\n{\"type\":\"%s\",\"ipcVersion\":%d,\"nonce\":\"%s\","
             "\"pid\":%lu,\"exceptionCode\":%lu,\"module\":\"%s\","
             "\"moduleOffset\":%llu}\n",
             kWorkerCrashType, kIpcVersion, g_crash_nonce,
             GetCurrentProcessId(),
             static_cast<unsigned long>(
                 pointers->ExceptionRecord->ExceptionCode),
             module, offset);
    // The pipe handle is synchronous, so a daemon that stopped reading could
    // block this write forever. Bound it on a helper thread and terminate
    // either way.
    const HANDLE writer =
        CreateThread(nullptr, 0, WriteCrashLine, nullptr, 0, nullptr);
    if (writer) {
      WaitForSingleObject(writer, 2000);
      CloseHandle(writer);
    }
  }
  TerminateProcess(GetCurrentProcess(), 20);
  return EXCEPTION_EXECUTE_HANDLER;
}

// Read one UTF-8 line from stdin as the sign-in secret. Bounded, never echoed,
// and wiped by the caller. Using stdin keeps it out of argv, which any local
// process can read through WMI.
bool ReadSecretFromStdin(std::wstring* secret) {
  if (!secret) return false;
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input == INVALID_HANDLE_VALUE || input == nullptr) return false;
  std::string utf8;
  char buffer[512];
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(input, buffer, sizeof(buffer), &read, nullptr) || read == 0) {
      break;
    }
    utf8.append(buffer, read);
    SecureZeroMemory(buffer, sizeof(buffer));
    if (utf8.size() > 4096) {
      SecureZeroMemory(utf8.data(), utf8.size());
      return false;
    }
  }
  while (!utf8.empty() && (utf8.back() == '\n' || utf8.back() == '\r')) {
    utf8.pop_back();
  }
  if (utf8.empty()) return false;
  const int wide_size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                            utf8.data(),
                                            static_cast<int>(utf8.size()),
                                            nullptr, 0);
  if (wide_size <= 0) {
    SecureZeroMemory(utf8.data(), utf8.size());
    return false;
  }
  secret->resize(static_cast<size_t>(wide_size));
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(),
                      static_cast<int>(utf8.size()), secret->data(),
                      wide_size);
  SecureZeroMemory(utf8.data(), utf8.size());
  return !secret->empty();
}

class PipeWriter {
 public:
  explicit PipeWriter(PipeChannel* pipe) : pipe_(pipe) {}

  bool Emit(const Json::Value& value) {
    std::string line = WriteJson(value);
    line.push_back('\n');
    if (line.size() > kMaxIpcLineBytes) return false;
    return pipe_->Write(line);
  }

 private:
  PipeChannel* const pipe_;
};

class WorkerRuntime {
 public:
  WorkerRuntime(webrtc::Thread* signaling_thread,
                webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface>
                    factory,
                PipeWriter* writer,
                LocalIndicator* indicator)
      : signaling_thread_(signaling_thread),
        factory_(std::move(factory)),
        writer_(writer),
        indicator_(indicator),
        input_(
            [indicator](UINT count, LPINPUT inputs, int size) {
              if (!g_input_desktop_ready.load()) return static_cast<UINT>(0);
              return indicator ? indicator->DispatchInput(count, inputs, size)
                               : 0;
            },
            [indicator] {
              return g_input_desktop_ready.load() && indicator &&
                     indicator->InputAvailable();
            },
            [indicator](int x, int y) {
              return g_input_desktop_ready.load() && indicator &&
                     indicator->MovePointer(x, y);
            }),
        dwm_process_id_(CurrentDwmProcessIdForCurrentSession()) {}

  bool Handle(const Json::Value& root) {
    const int64_t now_ms = NowMs();
    const std::optional<Signal> signal = ParseServiceSignal(root, now_ms);
    if (!signal) return false;
    return signaling_thread_->BlockingCall(
        [this, signal = *signal, now_ms] { return HandleOnSignaling(signal, now_ms); });
  }

  void Maintenance() {
    bool compositor_restarted = false;
    if (++compositor_scan_ticks_ >= 4) {
      compositor_scan_ticks_ = 0;
      compositor_restarted = AdvanceCompositorProcessGeneration(
          CurrentDwmProcessIdForCurrentSession(), &dwm_process_id_);
      if (compositor_restarted) {
        environment_events_.fetch_or(kEnvironmentCompositionChanged);
      }
    }

    // A DWM crash can poison a DXGI or WebRTC call deeply enough that even
    // signaling-thread cleanup never returns. Once the compositor pid changes,
    // give the reset a bounded window and let the node relaunch this verified
    // worker if recovery cannot complete.
    HANDLE recovery_complete = nullptr;
    std::thread recovery_watchdog;
    if (compositor_restarted) {
      recovery_complete = CreateEventW(nullptr, TRUE, FALSE, nullptr);
      if (!recovery_complete) {
        TerminateProcess(GetCurrentProcess(), 16);
        return;
      }
      recovery_watchdog = std::thread([recovery_complete] {
        if (WaitForSingleObject(recovery_complete, kWorkerShutdownGraceMs) ==
            WAIT_TIMEOUT) {
          TerminateProcess(GetCurrentProcess(), 16);
        }
      });
    }
    signaling_thread_->BlockingCall([this] {
      if (local_stop_requested_.exchange(false))
        StopAllOnSignaling("stopped_by_local_user", true);
      const uint32_t environment_mask = environment_events_.exchange(0);
      const WorkerEnvironmentAction environment_action =
          SelectWorkerEnvironmentAction(environment_mask);
      const bool topology_refresh_requested =
          environment_action == WorkerEnvironmentAction::kRefreshTopology;
      if (environment_action == WorkerEnvironmentAction::kFollowDesktop) {
        // Deliberately not followed here. A lock notification arrives while
        // Windows is still moving input around — measured on real hardware it
        // reports the sign-in desktop, then the curtain on the user's own
        // desktop again, inside a single poll period. The tick below runs in
        // this same call: it reconciles capture immediately and moves the
        // indicator once the desktop has actually settled.
        desktop_follow_candidate_.clear();
      } else if (environment_action == WorkerEnvironmentAction::kStopProtected) {
        StopAllOnSignaling("protected_desktop", true);
        ResetCaptureSourcesOnSignaling();
      } else if (environment_action ==
                 WorkerEnvironmentAction::kStopAndReinitialize) {
        StopAllOnSignaling("media_unavailable", true);
        ResetCaptureSourcesOnSignaling();
      } else if (environment_action ==
                 WorkerEnvironmentAction::kRefreshTopology) {
        topology_scan_ticks_ = 0;
      }
      if (AdvanceTopologyRefreshDebounce(topology_refresh_requested,
                                         &topology_refresh_debounce_ticks_)) {
        RefreshTopologyOnSignaling();
      }
      if (!sessions_.empty()) {
        // Windows moves input between the user's desktop and the sign-in/lock
        // desktop; the lock screen even lives on both at once (the curtain on
        // Default, the credential box on Winlogon). Follow it in place so the
        // peer, encoder and grant all survive a sign-in and the viewer just
        // sees the picture change.
        const std::wstring input_desktop = CurrentInputDesktopName();
        const DesktopFollowAction follow = SelectDesktopFollowAction(
            input_desktop, indicator_->BoundDesktop(),
            &desktop_follow_failures_);
        // Evaluated every tick, including the ticks that stay put, so the
        // candidate never carries a desktop from before an unreadable sample.
        const bool settled =
            DesktopFollowSettled(input_desktop, &desktop_follow_candidate_);
        // Capture is reconciled first and on every tick: it must sit on the
        // desktop Windows is displaying even when the indicator is already
        // there, because a rebind Windows refused mid-switch would otherwise
        // never be retried.
        ReconcileCaptureDesktopOnSignaling(input_desktop);
        UpdateSignInStateOnSignaling(input_desktop);
        MaybeAutoUnlockOnSignaling(input_desktop);
        if (follow == DesktopFollowAction::kFollow && settled) {
          FollowDesktopsOnSignaling();
        } else if (follow == DesktopFollowAction::kUnavailable) {
          // The input desktop stayed unreadable for long enough that this
          // worker cannot know where it is. Hand the session back rather than
          // streaming a desktop nobody asked for.
          StopAllOnSignaling("protected_desktop", true);
        }
        g_input_desktop_ready.store(!input_desktop.empty() &&
                                    input_desktop == indicator_->BoundDesktop());
        const bool expected_desktop = follow != DesktopFollowAction::kUnavailable;
        if (expected_desktop) {
          if (topology_refresh_debounce_ticks_ == 0 &&
              ++topology_scan_ticks_ >= 8) {
            topology_scan_ticks_ = 0;
            std::vector<DisplayInfo> displays = EnumerateDisplays();
            if (displays.empty()) {
              if (AdvanceEmptyTopologyConsecutive(&empty_topology_ticks_)) {
                StopAllOnSignaling("media_unavailable", true);
                ResetCaptureSourcesOnSignaling();
              }
            } else {
              empty_topology_ticks_ = 0;
              for (auto& [id, session] : sessions_) {
                if (!session->closed() && !session->RefreshDisplays(displays))
                  session->Close("media_unavailable");
              }
            }
          }
        }
      }
      const int64_t now_ms = NowMs();
      for (auto& [id, session] : sessions_) {
        if (!session->closed()) {
          // Input readiness changes on its own schedule — a layout
          // acknowledged, a desktop followed — and the viewer used to learn
          // about it only on the next lease renewal, which is why a fresh
          // connection ignored clicks for seconds.
          session->PublishInputReadinessIfChanged();
          session->CheckMediaProgress();
        }
        if (!session->closed() && session->protected_content_masked()) {
          session->Close("protected_desktop");
        } else if (!session->closed() && session->Expired(now_ms)) {
          const char* reason = SessionExpiryReason(
              now_ms, session->authority().expires_at_ms,
              session->authority().lease_expires_at_ms,
              session->IdleExpired());
          session->Close(reason);
        }
      }
      RemoveClosedOnSignaling();
      input_.RetryPendingReleases();
    });
    if (recovery_complete) {
      SetEvent(recovery_complete);
      recovery_watchdog.join();
      CloseHandle(recovery_complete);
    }
  }

  void RequestLocalStopAll() { local_stop_requested_ = true; }
  void RequestEnvironmentChange(uint32_t event_mask) {
    environment_events_.fetch_or(event_mask);
  }

  void Shutdown() {
    signaling_thread_->BlockingCall([this] {
      StopAllOnSignaling("worker_failed", false);
      for (int attempt = 0; attempt < 4 && !input_.RetryPendingReleases();
           ++attempt) {
        Sleep(10);
      }
      for (auto& [id, source] : sources_) source.source->Stop();
      sources_.clear();
    });
  }

 private:
  struct SourceEntry {
    webrtc::scoped_refptr<DxgiDesktopSource> source;
    size_t references = 0;
  };

  bool Matches(const Authority& expected, const Authority& received) const {
    return expected.request_id == received.request_id &&
           expected.session_id == received.session_id &&
           ConstantTimeEqual(expected.capability, received.capability);
  }

  bool HandleOnSignaling(const Signal& signal, int64_t now_ms) {
    if (signal.kind == Signal::Kind::kPrepare) {
      RemoveClosedOnSignaling();
      if (sessions_.contains(signal.authority.session_id)) return false;
      if (sessions_.size() >= kMaxSessions) {
        writer_->Emit(TerminalEnvelope(signal.authority, "session_limit"));
        return true;
      }
      const bool valid_initial_mode =
          (signal.authority.mode == kViewMode &&
           signal.authority.input_epoch == 0) ||
          (signal.authority.mode == kControlMode &&
           signal.authority.input_epoch == 1);
      if (!valid_initial_mode ||
          signal.authority.expires_at_ms <
              signal.authority.lease_expires_at_ms) {
        writer_->Emit(TerminalEnvelope(signal.authority, "protocol_error"));
        return true;
      }
      if (signal.authority.reconnect_attempt > 0) {
        // A bounded browser reconnect follows a receive-progress failure. Keep
        // healthy existing peers intact, but prevent the replacement encoder
        // from selecting the same process-local hardware path again.
        DisqualifyHardwareEncoderForProcess();
      }
      // The desktop can already have moved since this worker launched — a
      // session locked, or the sign-in screen came up. Move to the one that
      // receives input now instead of refusing the session; only a desktop
      // this worker cannot read at all is reported back.
      const std::wstring prepare_desktop = CurrentInputDesktopName();
      if (prepare_desktop.empty()) {
        writer_->Emit(TerminalEnvelope(signal.authority, "protected_desktop"));
        return true;
      }
      FollowDesktopsOnSignaling();
      std::vector<DisplayInfo> displays = EnumerateDisplays();
      if (displays.empty()) {
        writer_->Emit(TerminalEnvelope(signal.authority,
                                       kHeadlessDisplayReason));
        return true;
      }
      int pending_controllers =
          signal.authority.mode == kControlMode ? 1 : 0;
      for (const auto& [id, existing] : sessions_) {
        if (!existing->closed() && existing->controlling())
          ++pending_controllers;
      }
      // Show the native disclosure synchronously before AcquireSource starts
      // DXGI.  A failed initialization immediately restores the actual count.
      indicator_->Update(static_cast<int>(sessions_.size()) + 1,
                         pending_controllers);
      auto session = PeerSession::Create(
          signal.authority, factory_, std::move(displays),
          [this](const DisplayInfo& display) { return AcquireSource(display); },
          [this](const DisplayInfo& display) { ReleaseSource(display); },
          &input_,
          [this] {
            return ClipboardAllowedOnDesktop(indicator_->BoundDesktop())
                       ? indicator_->ClipboardSequence()
                       : static_cast<DWORD>(0);
          },
          [this](DWORD previous_sequence) {
            return ClipboardAllowedOnDesktop(indicator_->BoundDesktop())
                       ? indicator_->ReadClipboardText(previous_sequence)
                       : std::optional<std::u16string>();
          },
          [this] { return RequestUnlockOnSignaling(); },
          signaling_thread_,
          [this](const Json::Value& value) { writer_->Emit(value); });
      if (!session->Initialize()) {
        session->Close("media_unavailable", false);
        UpdateIndicatorOnSignaling();
        writer_->Emit(TerminalEnvelope(signal.authority,
                                       "media_unavailable"));
        return true;
      }
      sessions_.emplace(signal.authority.session_id, std::move(session));
      UpdateIndicatorOnSignaling();
      return true;
    }

    const auto found = sessions_.find(signal.authority.session_id);
    if (found == sessions_.end() || found->second->closed() ||
        !Matches(found->second->authority(), signal.authority)) {
      return false;
    }
    std::shared_ptr<PeerSession> session = found->second;
    bool accepted = false;
    switch (signal.kind) {
      case Signal::Kind::kOffer:
        accepted = session->ApplyOffer(signal.sdp);
        break;
      case Signal::Kind::kIce:
        accepted = session->AddIce(signal.mid, signal.candidate);
        break;
      case Signal::Kind::kLease:
        accepted = session->Renew(signal.authority);
        break;
      case Signal::Kind::kMode:
        accepted = session->SetMode(signal.authority, signal.reason);
        if (accepted) UpdateIndicatorOnSignaling();
        break;
      case Signal::Kind::kStop:
        session->Close("stopped_by_controller");
        accepted = true;
        RemoveClosedOnSignaling();
        break;
      case Signal::Kind::kPrepare:
        break;
    }
    if (!accepted && !session->closed() &&
        (signal.kind == Signal::Kind::kOffer ||
         signal.kind == Signal::Kind::kLease ||
         signal.kind == Signal::Kind::kMode)) {
      session->Close("protocol_error");
      RemoveClosedOnSignaling();
    }
    return accepted;
  }

  webrtc::scoped_refptr<DxgiDesktopSource> AcquireSource(
      const DisplayInfo& display) {
    const std::string key = DisplaySourceKey(display);
    auto found = sources_.find(key);
    if (found != sources_.end()) {
      ++found->second.references;
      return found->second.source;
    }
    if (sources_.size() >= kMaxCaptureSources ||
        sources_.size() >= kMaxGpuCaptureSurfaces) {
      return nullptr;
    }
    // Both desktops need the same rescue: DXGI enumerates the output and
    // opens a duplication, then never presents a first frame on an idle,
    // monitor-less machine. Without the fallback that surfaces as
    // media_unavailable and no session can ever start on such a node.
    auto source =
        DxgiDesktopSource::Create(display, CaptureFallback::kDesktopGdi);
    if (!source) return nullptr;
    // The tick reconciler corrects this the moment Windows disagrees; an
    // empty name simply means "whatever receives input right now".
    source->RequestDesktopRebind(CurrentInputDesktopName());
    source->Start();
    sources_.emplace(key, SourceEntry{source, 1});
    return source;
  }

  void ReleaseSource(const DisplayInfo& display) {
    const auto found = sources_.find(DisplaySourceKey(display));
    if (found == sources_.end()) return;
    if (found->second.references > 0) --found->second.references;
    if (found->second.references == 0) {
      found->second.source->Stop();
      sources_.erase(found);
    }
  }

  void RemoveClosedOnSignaling() {
    for (auto current = sessions_.begin(); current != sessions_.end();) {
      if (current->second->closed()) current = sessions_.erase(current);
      else ++current;
    }
    UpdateIndicatorOnSignaling();
  }

  void StopAllOnSignaling(const char* reason, bool emit_terminal) {
    for (auto& [id, session] : sessions_)
      session->Close(reason, emit_terminal);
    sessions_.clear();
    UpdateIndicatorOnSignaling();
  }

  // Move this worker to the desktop that now receives input. The peer, the
  // encoder and every authority stay exactly as they are: only the capture
  // thread and the indicator/input thread change desktops. Held keys and
  // buttons are released first, because an input ledger must never survive the
  // boundary it was pressed on.
  // Input follows the desktop that receives it; capture follows the one that
  // can be read. They are the same desktop most of the time, but a locked
  // session keeps the curtain (and input) on Default while refusing screen
  // reads there, so capture has to sit on Winlogon until it unlocks.
  void FollowDesktopsOnSignaling() {
    const std::wstring input_desktop = CurrentInputDesktopName();
    if (input_desktop != indicator_->BoundDesktop()) {
      g_input_desktop_ready.store(false);
      for (const auto& [id, session] : sessions_) input_.ReleaseOwner(id);
      indicator_->Stop();
      if (!indicator_->Start([this] { RequestLocalStopAll(); },
                             [this](uint32_t event_mask) {
                               RequestEnvironmentChange(event_mask);
                             })) {
        // Without the disclosure indicator there is no visible sign that the
        // desktop is being streamed, so stop rather than capture silently.
        StopAllOnSignaling("protected_desktop", true);
        return;
      }
      UpdateIndicatorOnSignaling();
      g_input_desktop_ready.store(indicator_->BoundDesktop() == input_desktop);
    }
    ReconcileCaptureDesktopOnSignaling(input_desktop);
  }

  // Capture goes where input goes: Windows refuses a screen read from any
  // desktop other than the one it is displaying, so there is exactly one valid
  // target at a time. Locking moves that target twice — briefly to the sign-in
  // desktop, back to the curtain on the user's own desktop, then to the
  // credential box when a key arrives — so the target is re-checked against
  // what each source reports it is actually reading, never against what was
  // last asked for.
  void ReconcileCaptureDesktopOnSignaling(const std::wstring& input_desktop) {
    if (input_desktop.empty()) return;
    for (auto& [id, source] : sources_) {
      if (ShouldRebindCapture(input_desktop, source.source->BoundDesktop())) {
        source.source->RequestDesktopRebind(input_desktop);
      }
    }
  }

  /**
   * Track the lock state and tell every session what it is looking at, so a
   * viewer sees "sign-in screen" and gets the unlock control instead of
   * wondering why the desktop it expected is a password box.
   */
  void UpdateSignInStateOnSignaling(const std::wstring& input_desktop) {
    const bool locked = CurrentSessionIsLocked();
    if (!locked && session_locked_) {
      // Unlocked: both budgets belong to the lock that just ended.
      auto_unlock_attempts_ = 0;
      auto_unlock_raise_attempts_ = 0;
    }
    session_locked_ = locked;
    const bool sign_in_screen = locked || input_desktop == kSignInDesktop;
    const bool unlock_available = sign_in_screen && UnlockSecret::Configured();
    for (const auto& [id, session] : sessions_) {
      session->SetSignInState(sign_in_screen, unlock_available);
    }
  }

  bool ControllerPresentOnSignaling() const {
    return std::any_of(sessions_.begin(), sessions_.end(),
                       [](const auto& entry) {
                         return !entry.second->closed() &&
                                entry.second->controlling();
                       });
  }

  // Answer the sign-in screen on behalf of a watching controller. Evaluated on
  // every tick, not only when the desktop changes: a session that connects to
  // an already-locked machine never sees a transition, and the machine rests on
  // the lock curtain — a screen with no password box — so the credential UI has
  // to be woken before there is anywhere to type.
  void MaybeAutoUnlockOnSignaling(const std::wstring& input_desktop) {
    const AutoUnlockStep step = SelectAutoUnlockStep(
        UnlockSecret::Configured(), ControllerPresentOnSignaling(),
        g_input_desktop_ready.load(), session_locked_,
        input_desktop == kSignInDesktop, auto_unlock_raise_attempts_,
        auto_unlock_attempts_);
    if (step == AutoUnlockStep::kRaiseCredentialUi) {
      ++auto_unlock_raise_attempts_;
      RaiseCredentialUiOnSignaling();
      return;
    }
    if (step != AutoUnlockStep::kTypeSecret) return;
    ++auto_unlock_attempts_;
    TypeStoredSecretOnSignaling();
  }

  /**
   * Run the controller's explicit unlock request. Unlike the automatic path it
   * is not once-per-lock: the operator asked for it, and the sign-in UI is
   * exactly the place where one attempt can silently do nothing. It still needs
   * a stored secret, control of this session and a locked screen, and it types
   * only when the credential box is actually up.
   */
  bool RequestUnlockOnSignaling() {
    if (!ShouldAcceptUnlockRequest(UnlockSecret::Configured(),
                                   ControllerPresentOnSignaling(),
                                   g_input_desktop_ready.load(),
                                   session_locked_)) {
      return false;
    }
    if (CurrentInputDesktopName() != kSignInDesktop) {
      // No password box yet: wake the curtain and let the next tick type.
      RaiseCredentialUiOnSignaling();
      return true;
    }
    return TypeStoredSecretOnSignaling();
  }

  void RaiseCredentialUiOnSignaling() {
    input_.KeyDown(kAutoUnlockOwner, "Space", false);
    input_.KeyUp(kAutoUnlockOwner, "Space");
  }

  // The secret is decrypted for the length of this call and wiped immediately;
  // it is never logged, echoed, or sent anywhere.
  bool TypeStoredSecretOnSignaling() {
    std::wstring secret;
    if (!UnlockSecret::Load(&secret)) return false;
    std::u16string typed(secret.begin(), secret.end());
    SecureZeroMemory(secret.data(), secret.size() * sizeof(wchar_t));
    secret.clear();
    const bool typed_ok = input_.Text(typed);
    SecureZeroMemory(typed.data(), typed.size() * sizeof(char16_t));
    typed.clear();
    if (!typed_ok) return false;
    input_.KeyDown(kAutoUnlockOwner, "Enter", false);
    input_.KeyUp(kAutoUnlockOwner, "Enter");
    writer_->Emit(AutoUnlockAttemptEnvelope());
    return true;
  }

  Json::Value AutoUnlockAttemptEnvelope() const {
    // Auditable, and deliberately content-free: an operator can see that the
    // node answered its own lock screen, never what it typed.
    Json::Value root(Json::objectValue);
    root["type"] = kAutoUnlockAttemptType;
    return root;
  }

  void ResetCaptureSourcesOnSignaling() {
    for (auto& [id, source] : sources_) source.source->Stop();
    sources_.clear();
    protected_desktop_checks_ = 0;
    topology_scan_ticks_ = 0;
  }

  void RefreshTopologyOnSignaling() {
    if (sessions_.empty()) return;
    std::vector<DisplayInfo> displays = EnumerateDisplays();
    if (displays.empty()) {
      // RefreshTopologyOnSignaling() runs on the same signaling thread as the
      // Maintenance() empty-scan. Reuse the same bounded grace counter so a
      // single transient DXGI / DWM dip does not terminate every peer.
      if (AdvanceEmptyTopologyConsecutive(&empty_topology_ticks_)) {
        StopAllOnSignaling("media_unavailable", true);
        ResetCaptureSourcesOnSignaling();
      }
      return;
    }
    empty_topology_ticks_ = 0;
    for (auto& [id, session] : sessions_) {
      if (!session->closed() && !session->RefreshDisplays(displays))
        session->Close("media_unavailable");
    }
    RemoveClosedOnSignaling();
  }

  void UpdateIndicatorOnSignaling() {
    int controllers = 0;
    for (const auto& [id, session] : sessions_) {
      if (!session->closed() && session->controlling()) ++controllers;
    }
    indicator_->Update(static_cast<int>(sessions_.size()), controllers);
  }

  webrtc::Thread* const signaling_thread_;
  const webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  PipeWriter* const writer_;
  LocalIndicator* const indicator_;
  InputArbiter input_;
  std::map<std::string, std::shared_ptr<PeerSession>> sessions_;
  std::map<std::string, SourceEntry> sources_;
  std::atomic<bool> local_stop_requested_{false};
  std::atomic<uint32_t> environment_events_{0};
  DWORD dwm_process_id_ = 0;
  int protected_desktop_checks_ = 0;
  int desktop_follow_failures_ = 0;
  std::wstring desktop_follow_candidate_;
  bool session_locked_ = false;
  int auto_unlock_raise_attempts_ = 0;
  int auto_unlock_attempts_ = 0;
  int compositor_scan_ticks_ = 0;
  int topology_scan_ticks_ = 0;
  int topology_refresh_debounce_ticks_ = 0;
  int empty_topology_ticks_ = 0;
};

struct WorkerArguments {
  std::wstring pipe;
  std::string nonce;
  bool secure_console = false;
};

std::optional<WorkerArguments> ParseArguments() {
  int count = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &count);
  if (!arguments) return std::nullopt;
  std::optional<std::wstring> pipe;
  std::optional<std::string> nonce;
  bool secure_console = false;
  for (int index = 1; index < count;) {
    const std::wstring key = arguments[index];
    if (key == L"--secure-console" && !secure_console) {
      secure_console = true;
      ++index;
      continue;
    }
    if (index + 1 >= count) {
      LocalFree(arguments);
      return std::nullopt;
    }
    if (key == L"--pipe" && !pipe) pipe = arguments[index + 1];
    else if (key == L"--nonce" && !nonce)
      nonce = WideToUtf8(arguments[index + 1]);
    else {
      LocalFree(arguments);
      return std::nullopt;
    }
    index += 2;
  }
  LocalFree(arguments);
  if (!pipe || !nonce || !IsSafePipePath(*pipe) ||
      !IsSafeCapability(*nonce)) {
    return std::nullopt;
  }
  return WorkerArguments{
      std::move(*pipe), std::move(*nonce), secure_console};
}

}  // namespace
}  // namespace imcodes::rd

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  using namespace imcodes::rd;
  int raw_count = 0;
  LPWSTR* raw_arguments = CommandLineToArgvW(GetCommandLineW(), &raw_count);
  const bool release_only = raw_arguments && raw_count == 2 &&
                            lstrcmpW(raw_arguments[1],
                                    L"--release-all-input") == 0;
  const bool virtual_display_controller =
      raw_arguments && raw_count == 2 &&
      lstrcmpW(raw_arguments[1], L"--virtual-display-controller") == 0;
  const bool activate_virtual_display =
      raw_arguments && raw_count == 2 &&
      lstrcmpW(raw_arguments[1], L"--activate-virtual-display") == 0;
  const bool set_unlock_secret =
      raw_arguments && raw_count == 2 &&
      lstrcmpW(raw_arguments[1], L"--set-unlock-secret") == 0;
  const bool clear_unlock_secret =
      raw_arguments && raw_count == 2 &&
      lstrcmpW(raw_arguments[1], L"--clear-unlock-secret") == 0;
  const bool report_unlock_secret =
      raw_arguments && raw_count == 2 &&
      lstrcmpW(raw_arguments[1], L"--unlock-secret-state") == 0;
  if (raw_arguments) LocalFree(raw_arguments);
  if (release_only) {
    return ReleaseAllSupportedInput() ? 0 : 13;
  }
  if (set_unlock_secret) {
    if (!IsLocalSystemProcess()) return 18;
    std::wstring secret;
    const bool read = ReadSecretFromStdin(&secret);
    const bool stored = read && UnlockSecret::Store(secret);
    SecureZeroMemory(secret.data(), secret.size() * sizeof(wchar_t));
    secret.clear();
    return stored ? 0 : 21;
  }
  if (clear_unlock_secret) {
    if (!IsLocalSystemProcess()) return 18;
    return UnlockSecret::Clear() ? 0 : 21;
  }
  if (report_unlock_secret) {
    // Exit code only: the secret itself is never readable, not even by the
    // service that stored it.
    return UnlockSecret::Configured() ? 0 : 22;
  }
  if (virtual_display_controller) return RunVirtualDisplayController();
  if (activate_virtual_display) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    return ActivateVirtualDisplayForCurrentUser();
  }
  const auto arguments = ParseArguments();
  if (!arguments) return 2;
  if (arguments->secure_console && !IsLocalSystemProcess()) return 18;
  if (!ConfigureResourceJob()) return 12;

  // Authenticate the worker and publish its PID before initializing platform
  // media. MFStartup and graphics/media providers are third-party OS code and
  // can block indefinitely on a damaged per-session stack. If that happens
  // before HELLO, the service cannot identify the launched process and its
  // PREPARE watchdog can neither observe nor recycle it. Once HELLO is sent,
  // the already-queued PREPARE arms that watchdog while initialization below
  // proceeds; a stall is therefore bounded to this authenticated process.
  PipeChannel pipe_channel;
  if (!pipe_channel.Connect(arguments->pipe, std::chrono::seconds(10))) {
    return 6;
  }
  PipeWriter writer(&pipe_channel);
  lstrcpynA(g_crash_nonce, arguments->nonce.c_str(),
            static_cast<int>(sizeof(g_crash_nonce)));
  g_crash_pipe.store(&pipe_channel);
  SetUnhandledExceptionFilter(ReportCrashToDaemon);
  Json::Value hello(Json::objectValue);
  hello["type"] = kWorkerHelloType;
  hello["ipcVersion"] = kIpcVersion;
  hello["nonce"] = arguments->nonce;
  hello["pid"] = static_cast<Json::UInt>(GetCurrentProcessId());
  // The service has to know which desktop this process actually owns: its own
  // launch decision can already be stale, and the replacement after a desktop
  // switch belongs on the other one.
  hello["secureConsole"] = arguments->secure_console;
  if (!writer.Emit(hello)) {
    pipe_channel.Close();
    return 7;
  }

  // Native libwebrtc embedders own Winsock lifetime. Without this, ICE can
  // expose TCP-active placeholders but cannot bind a real UDP host/STUN/TURN
  // socket, leaving every browser peer permanently in `new`.
  webrtc::WinsockInitializer winsock;
  if (winsock.error() != 0) return 14;

  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
    pipe_channel.Close();
    return 3;
  }
  if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_FULL))) {
    pipe_channel.Close();
    CoUninitialize();
    return 4;
  }
  if (!webrtc::InitializeSSL()) {
    pipe_channel.Close();
    MFShutdown();
    CoUninitialize();
    return 5;
  }

  auto network_thread = webrtc::Thread::CreateWithSocketServer();
  auto worker_thread = webrtc::Thread::Create();
  auto signaling_thread = webrtc::Thread::Create();
  network_thread->SetName("imcodes-rd-network", nullptr);
  worker_thread->SetName("imcodes-rd-worker", nullptr);
  signaling_thread->SetName("imcodes-rd-signaling", nullptr);
  if (!network_thread->Start() || !worker_thread->Start() ||
      !signaling_thread->Start()) {
    pipe_channel.Close();
    webrtc::CleanupSSL();
    MFShutdown();
    CoUninitialize();
    return 8;
  }

  webrtc::PeerConnectionFactoryDependencies dependencies;
  dependencies.network_thread = network_thread.get();
  dependencies.worker_thread = worker_thread.get();
  dependencies.signaling_thread = signaling_thread.get();
  dependencies.env = webrtc::CreateEnvironment();
  // Remote desktop is video only. Without an explicit module the media engine
  // builds the platform Core Audio device, which opens the microphone stack
  // this product never uses and destructs through a dangling COM interface
  // once the audio endpoints are unavailable, taking the worker down with an
  // access violation at the sign-in desktop and across a logon transition.
  dependencies.adm = webrtc::make_ref_counted<SilentAudioDeviceModule>();
  if (!dependencies.adm) {
    pipe_channel.Close();
    webrtc::CleanupSSL();
    MFShutdown();
    CoUninitialize();
    return 19;
  }
  dependencies.audio_encoder_factory =
      webrtc::CreateBuiltinAudioEncoderFactory();
  dependencies.audio_decoder_factory =
      webrtc::CreateBuiltinAudioDecoderFactory();
  dependencies.video_encoder_factory =
      std::make_unique<MfH264EncoderFactory>();
  dependencies.video_decoder_factory =
      webrtc::CreateBuiltinVideoDecoderFactory();
  webrtc::EnableMedia(dependencies);
  auto factory =
      webrtc::CreateModularPeerConnectionFactory(std::move(dependencies));
  if (!factory) {
    pipe_channel.Close();
    webrtc::CleanupSSL();
    MFShutdown();
    CoUninitialize();
    return 9;
  }

  LocalIndicator indicator;
  // `--secure-console` is still accepted and echoed back for older services,
  // but it no longer selects behaviour: this worker follows whichever desktop
  // Windows is showing.
  WorkerRuntime runtime(signaling_thread.get(), factory, &writer, &indicator);
  if (!indicator.Start(
          [&runtime] { runtime.RequestLocalStopAll(); },
          [&runtime](uint32_t event_mask) {
            runtime.RequestEnvironmentChange(event_mask);
          })) {
    runtime.Shutdown();
    factory = nullptr;
    pipe_channel.Close();
    webrtc::CleanupSSL();
    MFShutdown();
    CoUninitialize();
    return 10;
  }

  g_input_desktop_ready.store(!indicator.BoundDesktop().empty() &&
                              indicator.BoundDesktop() ==
                                  CurrentInputDesktopName());

  std::atomic<bool> running{true};
  std::thread maintenance([&] {
    while (running.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      if (running.load()) runtime.Maintenance();
    }
  });

  bool protocol_ok = true;
  std::string pending;
  std::vector<char> buffer(8192);
  while (protocol_ok) {
    const size_t read = pipe_channel.Read(buffer.data(), buffer.size());
    if (read == 0) break;
    pending.append(buffer.data(), read);
    if (pending.size() > kMaxIpcLineBytes) {
      protocol_ok = false;
      break;
    }
    for (;;) {
      const size_t newline = pending.find('\n');
      if (newline == std::string::npos) break;
      std::string line = pending.substr(0, newline);
      pending.erase(0, newline + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.empty()) continue;
      Json::Value root;
      if (!ParseJson(line, &root) || !runtime.Handle(root)) {
        // Reject this bounded message but keep the authenticated IPC alive;
        // a stale ICE candidate must not terminate unrelated sessions.
        continue;
      }
    }
  }

  // A display-driver or DWM reset can leave a DXGI call permanently blocked.
  // Once the authenticated pipe is gone there is no authority left to serve,
  // so bound the entire graceful teardown, including the maintenance join,
  // and let the next verified launch start clean.
  HANDLE shutdown_complete = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::thread shutdown_watchdog;
  if (shutdown_complete) {
    shutdown_watchdog = std::thread([shutdown_complete] {
      if (WaitForSingleObject(shutdown_complete, kWorkerShutdownGraceMs) ==
          WAIT_TIMEOUT) {
        TerminateProcess(GetCurrentProcess(), 15);
      }
    });
  }
  running = false;
  maintenance.join();
  runtime.Shutdown();
  indicator.Stop();
  factory = nullptr;
  signaling_thread->Stop();
  worker_thread->Stop();
  network_thread->Stop();
  // The filter must not reach a channel that is about to go out of scope.
  g_crash_pipe.store(nullptr);
  pipe_channel.Close();
  webrtc::CleanupSSL();
  MFShutdown();
  CoUninitialize();
  if (shutdown_complete) {
    SetEvent(shutdown_complete);
    shutdown_watchdog.join();
    CloseHandle(shutdown_complete);
  }
  return protocol_ok ? 0 : 11;
}
