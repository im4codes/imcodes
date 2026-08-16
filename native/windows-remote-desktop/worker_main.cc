#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
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

#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/create_modular_peer_connection_factory.h"
#include "api/enable_media.h"
#include "api/environment/environment_factory.h"
#include "api/peer_connection_interface.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/thread.h"
#include "rtc_base/win32_socket_init.h"
#include "third_party/imcodes_remote_desktop/display_capture.h"
#include "third_party/imcodes_remote_desktop/input_injector.h"
#include "third_party/imcodes_remote_desktop/json_protocol.h"
#include "third_party/imcodes_remote_desktop/local_indicator.h"
#include "third_party/imcodes_remote_desktop/mf_h264_encoder.h"
#include "third_party/imcodes_remote_desktop/peer_session.h"
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

bool IsInteractiveDefaultDesktop() {
  HDESK desktop = OpenInputDesktop(
      0, FALSE, DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP);
  if (!desktop) return false;
  wchar_t name[64]{};
  DWORD needed = 0;
  const bool read = GetUserObjectInformationW(
      desktop, UOI_NAME, name, sizeof(name), &needed) != FALSE;
  CloseDesktop(desktop);
  return read && lstrcmpiW(name, L"Default") == 0;
}

class PipeWriter {
 public:
  explicit PipeWriter(HANDLE pipe) : pipe_(pipe) {}

  bool Emit(const Json::Value& value) {
    std::string line = WriteJson(value);
    line.push_back('\n');
    if (line.size() > kMaxIpcLineBytes) return false;
    std::lock_guard lock(mutex_);
    size_t offset = 0;
    while (offset < line.size()) {
      DWORD written = 0;
      const DWORD remaining = static_cast<DWORD>(
          std::min<size_t>(line.size() - offset, 64 * 1024));
      if (!WriteFile(pipe_, line.data() + offset, remaining, &written,
                     nullptr) || written == 0) {
        return false;
      }
      offset += written;
    }
    return true;
  }

 private:
  const HANDLE pipe_;
  std::mutex mutex_;
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
              return indicator ? indicator->DispatchInput(count, inputs, size)
                               : 0;
            },
            [indicator] {
              return indicator && indicator->InputAvailable();
            },
            [indicator](int x, int y) {
              return indicator && indicator->MovePointer(x, y);
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
      const WorkerEnvironmentAction environment_action =
          SelectWorkerEnvironmentAction(environment_events_.exchange(0));
      const bool topology_refresh_requested =
          environment_action == WorkerEnvironmentAction::kRefreshTopology;
      if (environment_action == WorkerEnvironmentAction::kStopProtected) {
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
        if (!IsInteractiveDefaultDesktop()) {
          if (++protected_desktop_checks_ >= 3) {
            StopAllOnSignaling("protected_desktop", true);
            protected_desktop_checks_ = 0;
          }
        } else {
          protected_desktop_checks_ = 0;
          if (topology_refresh_debounce_ticks_ == 0 &&
              ++topology_scan_ticks_ >= 8) {
            topology_scan_ticks_ = 0;
            std::vector<DisplayInfo> displays = EnumerateDisplays();
            if (displays.empty()) {
              StopAllOnSignaling("media_unavailable", true);
            } else {
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
        if (!session->closed()) session->CheckMediaProgress();
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
          [this] { return indicator_->ClipboardSequence(); },
          [this](DWORD previous_sequence) {
            return indicator_->ReadClipboardText(previous_sequence);
          },
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
    auto source = DxgiDesktopSource::Create(display);
    if (!source) return nullptr;
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
      StopAllOnSignaling("media_unavailable", true);
      return;
    }
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
  int compositor_scan_ticks_ = 0;
  int topology_scan_ticks_ = 0;
  int topology_refresh_debounce_ticks_ = 0;
};

std::optional<std::pair<std::wstring, std::string>> ParseArguments() {
  int count = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &count);
  if (!arguments) return std::nullopt;
  std::optional<std::wstring> pipe;
  std::optional<std::string> nonce;
  for (int index = 1; index + 1 < count; index += 2) {
    const std::wstring key = arguments[index];
    if (key == L"--pipe" && !pipe) pipe = arguments[index + 1];
    else if (key == L"--nonce" && !nonce)
      nonce = WideToUtf8(arguments[index + 1]);
    else {
      LocalFree(arguments);
      return std::nullopt;
    }
  }
  LocalFree(arguments);
  if (count != 5 || !pipe || !nonce || !IsSafePipePath(*pipe) ||
      !IsSafeCapability(*nonce)) {
    return std::nullopt;
  }
  return std::make_pair(std::move(*pipe), std::move(*nonce));
}

HANDLE ConnectPipe(const std::wstring& path) {
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::seconds(10);
  do {
    HANDLE pipe = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                              nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) return pipe;
    if (GetLastError() != ERROR_PIPE_BUSY) return INVALID_HANDLE_VALUE;
    WaitNamedPipeW(path.c_str(), 250);
  } while (std::chrono::steady_clock::now() < deadline);
  return INVALID_HANDLE_VALUE;
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
  if (raw_arguments) LocalFree(raw_arguments);
  if (release_only) {
    return ReleaseAllSupportedInput() ? 0 : 13;
  }
  if (virtual_display_controller) return RunVirtualDisplayController();
  if (activate_virtual_display) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    return ActivateVirtualDisplayForCurrentUser();
  }
  const auto arguments = ParseArguments();
  if (!arguments) return 2;
  if (!ConfigureResourceJob()) return 12;

  // Native libwebrtc embedders own Winsock lifetime. Without this, ICE can
  // expose TCP-active placeholders but cannot bind a real UDP host/STUN/TURN
  // socket, leaving every browser peer permanently in `new`.
  webrtc::WinsockInitializer winsock;
  if (winsock.error() != 0) return 14;

  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 3;
  if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_FULL))) {
    CoUninitialize();
    return 4;
  }
  if (!webrtc::InitializeSSL()) {
    MFShutdown();
    CoUninitialize();
    return 5;
  }

  HANDLE pipe = ConnectPipe(arguments->first);
  if (pipe == INVALID_HANDLE_VALUE) {
    webrtc::CleanupSSL();
    MFShutdown();
    CoUninitialize();
    return 6;
  }
  PipeWriter writer(pipe);
  Json::Value hello(Json::objectValue);
  hello["type"] = kWorkerHelloType;
  hello["ipcVersion"] = kIpcVersion;
  hello["nonce"] = arguments->second;
  hello["pid"] = static_cast<Json::UInt>(GetCurrentProcessId());
  if (!writer.Emit(hello)) {
    CloseHandle(pipe);
    webrtc::CleanupSSL();
    MFShutdown();
    CoUninitialize();
    return 7;
  }

  auto network_thread = webrtc::Thread::CreateWithSocketServer();
  auto worker_thread = webrtc::Thread::Create();
  auto signaling_thread = webrtc::Thread::Create();
  network_thread->SetName("imcodes-rd-network", nullptr);
  worker_thread->SetName("imcodes-rd-worker", nullptr);
  signaling_thread->SetName("imcodes-rd-signaling", nullptr);
  if (!network_thread->Start() || !worker_thread->Start() ||
      !signaling_thread->Start()) {
    CloseHandle(pipe);
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
    CloseHandle(pipe);
    webrtc::CleanupSSL();
    MFShutdown();
    CoUninitialize();
    return 9;
  }

  LocalIndicator indicator;
  WorkerRuntime runtime(signaling_thread.get(), factory, &writer, &indicator);
  if (!indicator.Start(
          [&runtime] { runtime.RequestLocalStopAll(); },
          [&runtime](uint32_t event_mask) {
            runtime.RequestEnvironmentChange(event_mask);
          })) {
    runtime.Shutdown();
    factory = nullptr;
    CloseHandle(pipe);
    webrtc::CleanupSSL();
    MFShutdown();
    CoUninitialize();
    return 10;
  }

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
    DWORD read = 0;
    if (!ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size()),
                  &read, nullptr) || read == 0) {
      break;
    }
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
  CloseHandle(pipe);
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
