// The real Linux remote-desktop worker executable: a long-lived process a
// daemon or controlled node spawns, speaking the SAME newline-delimited
// JSON wire protocol over stdin/stdout that Windows' and macOS' native
// workers already speak (native/remote-desktop-common/json_protocol.h,
// shared with them -- not reinvented here), driven by
// RemoteDesktopWorkerHostCore on the TypeScript side
// (src/node/remote-desktop-worker-host-core.ts). This is what
// LinuxRemoteDesktopWorkerHost (src/node/linux-remote-desktop-worker-host.ts)
// spawns.
//
// Scope, stated plainly rather than silently: PREPARE, OFFER/ANSWER, ICE
// (both directions), LEASE renewal, MODE_STATE (view/control switching and
// the Server's same-mode input-epoch resume fence), STOP, and a STATUS poll
// are handled. LEASE/MODE_STATE mirror Windows' PeerSession::Renew/SetMode
// (peer_session.cc) and its worker_main.cc dispatch. Until they did, this
// worker parsed every LEASE and dropped it, so each session only ever held
// PREPARE's original 60s lease and TransportSessionCore::AuthorityAlive()
// ended it exactly then -- every Linux session died at ~60s, deterministic,
// regardless of input or network. A session the transport core ends on its
// own (lease/route expiry, media stall, peer failure, ...) is now reported
// to the Server as a TERMINAL instead of being silently forgotten. The data-channel wire
// protocol's pointer/keyboard messages ARE wired to the input adapters now
// (linux_remote_desktop_session.cc's own DataChannelObserver); clipboard,
// display selection/mode/scale, and auto-unlock are not, exactly as
// documented in linux_remote_desktop_session.h's own header comment. One
// process serves however many concurrent sessions PREPARE for, matching
// RemoteDesktopWorkerHostCore's own multi-authority design on the other end
// of the pipe.
#include <chrono>
#include <csignal>
#include <cstdio>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/create_modular_peer_connection_factory.h"
#include "api/enable_media.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "api/video_codecs/builtin_video_encoder_factory.h"
#include "modules/audio_device/include/audio_device_default.h"
#include "rtc_base/ssl_adapter.h"

#include "../remote-desktop-common/json_protocol.h"
#include "../remote-desktop-common/local_management_types.h"
#include "../remote-desktop-common/signaling_types.h"
#include "linux_platform_adapters.h"
#include "linux_remote_desktop_session.h"

namespace rd = imcodes::remote_desktop::linux_platform;
namespace common = imcodes::remote_desktop::common;

namespace {

// Remote desktop carries no audio (this is a view-only screen session; the
// data-channel wire protocol is pointer/keyboard/clipboard, never audio).
// Without an explicit override here, PeerConnectionFactory lazily builds a
// REAL platform audio device module the first time a PeerConnection is
// created -- not at factory-creation time, but inside
// ConnectionContext::AddRefMediaEngine() -> WebRtcVoiceEngine::Init() ->
// webrtc::adm_helpers::Init(), triggered by this worker's own Start(), i.e.
// on the very first PREPARE. On a machine where this worker runs as a
// systemd-launched root service with no reachable PulseAudio/ALSA user
// session (confirmed live: a real X11 desktop and Xvfb were both healthy,
// only the audio device module's own Init() failed), that real ADM's
// Init() fails internally, and webrtc's own RTC_CHECK on that failure calls
// abort() -- SIGABRT, mid-session, on every single attempt, confirmed via a
// full symbolized backtrace (adm_helpers::Init -> WebRtcVoiceEngine::Init ->
// ConnectionContext::AddRefMediaEngine -> PeerConnection::PeerConnection,
// called from this file's own StartTransport()). Windows' worker_main.cc
// already carries the identical fix for the identical reason (its own
// comment: "Remote desktop carries no audio. The media engine would
// otherwise build the platform Core Audio device, which opens the
// microphone stack this product never uses") -- mirrored here, not
// reinvented, using the same cross-platform AudioDeviceModuleDefault base
// WebRTC ships for exactly this "I genuinely have no audio" case.
class SilentAudioDeviceModule
    : public webrtc::webrtc_impl::AudioDeviceModuleDefault<
          webrtc::AudioDeviceModule> {};

std::mutex g_stdout_mutex;

void WriteLine(const Json::Value& value) {
  const std::string line = imcodes::rd::WriteJson(value) + "\n";
  std::lock_guard<std::mutex> lock(g_stdout_mutex);
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fflush(stdout);
}

std::int64_t NowUnixMs() noexcept {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

/**
 * A real common::TransportTime -- unix_ms from the wall clock, monotonic_ms
 * from a genuine monotonic clock, NOT the same value duplicated into both
 * fields. TransportSessionCore::ObserveTime() rejects any call whose
 * monotonic_ms goes backward relative to the last one it recorded; feeding
 * it a wall-clock timestamp as a monotonic_ms stand-in here, while
 * LinuxRemoteDesktopSession's own OnConnectionChange() samples a REAL
 * monotonic clock for that same field (see that file's SampleNow(), which
 * this mirrors), would make that later real-monotonic value read as
 * "earlier than the huge unix-epoch number Start() recorded" and terminate
 * the transport the moment it connects -- exactly the bug that motivated
 * both of these functions existing.
 */
common::TransportTime SampleTransportTime() noexcept {
  const auto unix_now = std::chrono::system_clock::now().time_since_epoch();
  const auto steady_now = std::chrono::steady_clock::now().time_since_epoch();
  return common::TransportTime{
      std::chrono::duration_cast<std::chrono::milliseconds>(unix_now).count(),
      std::chrono::duration_cast<std::chrono::milliseconds>(steady_now).count(),
  };
}

common::RouteAuthority ToRouteAuthority(const imcodes::rd::Authority& authority) noexcept {
  common::RouteAuthority route;
  route.identity.request_id = authority.request_id;
  route.identity.session_id = authority.session_id;
  route.identity.negotiated_capability_binding = authority.capability;
  route.identity.daemon_generation =
      static_cast<common::WorkerGeneration>(authority.daemon_generation);
  // A missing routeGeneration means legacy v2 authenticated access (see
  // shared/remote-desktop.ts's own RemoteDesktopPrepare.routeGeneration
  // comment), not "no route" -- RouteAuthorityIdentity::IsValid() requires
  // route_generation != 0 unconditionally, so this falls back to 1, exactly
  // matching how both macos_remote_desktop_worker_main.mm and
  // peer_session.cc (Windows) already resolve the same optional field.
  route.identity.route_generation = static_cast<std::uint64_t>(
      authority.route_generation.value_or(1));
  route.mode = authority.mode == imcodes::rd::kControlMode
      ? common::TransportSessionMode::kControl
      : common::TransportSessionMode::kView;
  route.input_epoch = static_cast<std::uint64_t>(authority.input_epoch);
  route.expires_at_unix_ms = authority.expires_at_ms;
  route.relay_bitrate_cap_bps = authority.relay_bitrate_cap_bps;
  route.lease_expires_at_unix_ms = authority.lease_expires_at_ms;
  return route;
}

/**
 * The REMOTE_DESKTOP_TERMINAL_REASON (shared/remote-desktop.ts) wire value
 * for a session the transport core ended on its own -- the same mapping
 * macOS's WorkerTransportSink::OnTerminal uses. nullptr for kStopped: an
 * explicit STOP (or a PREPARE replacing a session) is already answered by
 * its own handler, and a second TERMINAL for it would be a duplicate.
 */
const char* WireTerminalReason(common::TransportTerminalReason reason) noexcept {
  switch (reason) {
    case common::TransportTerminalReason::kStopped:
      return nullptr;
    case common::TransportTerminalReason::kRouteExpired:
      return "authority_expired";
    case common::TransportTerminalReason::kLeaseExpired:
      return "lease_expired";
    case common::TransportTerminalReason::kIdleTimeout:
      return "idle_timeout";
    case common::TransportTerminalReason::kProtocolViolation:
    case common::TransportTerminalReason::kCandidateOverflow:
      return "protocol_error";
    case common::TransportTerminalReason::kMediaStalled:
      return "media_unavailable";
    case common::TransportTerminalReason::kNone:
    case common::TransportTerminalReason::kPeerFailed:
    case common::TransportTerminalReason::kChannelFailed:
    case common::TransportTerminalReason::kAdapterFailure:
      return "peer_failed";
  }
  return "peer_failed";
}

/** Diagnostic name for stderr only; the wire uses WireTerminalReason. */
const char* TerminalReasonName(common::TransportTerminalReason reason) noexcept {
  switch (reason) {
    case common::TransportTerminalReason::kNone: return "none";
    case common::TransportTerminalReason::kStopped: return "stopped";
    case common::TransportTerminalReason::kRouteExpired: return "route_expired";
    case common::TransportTerminalReason::kLeaseExpired: return "lease_expired";
    case common::TransportTerminalReason::kIdleTimeout: return "idle_timeout";
    case common::TransportTerminalReason::kMediaStalled: return "media_stalled";
    case common::TransportTerminalReason::kPeerFailed: return "peer_failed";
    case common::TransportTerminalReason::kChannelFailed: return "channel_failed";
    case common::TransportTerminalReason::kCandidateOverflow: return "candidate_overflow";
    case common::TransportTerminalReason::kAdapterFailure: return "adapter_failure";
    case common::TransportTerminalReason::kProtocolViolation: return "protocol_violation";
  }
  return "unknown";
}

/** REMOTE_DESKTOP_STATE (shared/remote-desktop.ts) -- only the subset a
 * Linux session can actually be in during this first slice; SWITCHING_DISPLAY
 * and RECONNECTING describe worker-replacement/display-change behavior this
 * slice does not implement. */
const char* StateFor(const common::TransportDiagnostics& diagnostics) noexcept {
  switch (diagnostics.peer_state) {
    case common::PeerConnectionState::kNew:
    case common::PeerConnectionState::kConnecting:
      return "connecting";
    case common::PeerConnectionState::kConnected:
      return diagnostics.path == common::TransportPath::kRelay ? "relayed" : "direct";
    case common::PeerConnectionState::kDisconnected:
      return "reconnecting";
    case common::PeerConnectionState::kFailed:
      return "failed";
    case common::PeerConnectionState::kClosed:
      return "stopped";
  }
  return "failed";
}

class WorkerSession {
 public:
  WorkerSession(webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
               rd::LinuxPlatformAdapters& adapters,
               webrtc::Thread* signaling_thread,
               imcodes::rd::Authority authority)
      : authority_(std::move(authority)) {
    session_ = rd::LinuxRemoteDesktopSession::Create(
        factory, adapters, signaling_thread,
        [this](const std::string& mid, const std::string& sdp) {
          Json::Value ice = imcodes::rd::BaseEnvelope(imcodes::rd::kIceType, authority_);
          ice["mid"] = mid;
          ice["candidate"] = sdp;
          WriteLine(ice);
        });
  }

  [[nodiscard]] bool Start(const imcodes::rd::Authority& authority) {
    session_->SetIceServers(authority.ice_servers);
    return session_->Start(ToRouteAuthority(authority), SampleTransportTime());
  }

  void ApplyOffer(const imcodes::rd::Authority& request_authority, const std::string& sdp) {
    session_->ApplyOffer(sdp, [request_authority](bool ok, const std::string& answer_sdp) {
      if (!ok) {
        // "worker_failed", not a made-up string: shared/remote-desktop.ts's
        // REMOTE_DESKTOP_TERMINAL_REASON is the exact, closed wire
        // vocabulary validateRemoteDesktopDaemonMessage enforces, and this
        // is the same fallback macOS's own worker uses for an
        // adapter/session-level failure with no more specific reason code
        // (see WorkerTransportSink::OnSessionTerminal in
        // macos_remote_desktop_worker_main.mm).
        WriteLine(imcodes::rd::TerminalEnvelope(request_authority,
                                                "worker_failed"));
        return;
      }
      Json::Value answer = imcodes::rd::BaseEnvelope(imcodes::rd::kAnswerType, request_authority);
      answer["sdp"] = answer_sdp;
      WriteLine(answer);
    });
  }

  void AddRemoteIce(const std::string& mid, const std::string& candidate) {
    session_->AddRemoteIce(mid, candidate);
  }

  // Same identity triple Windows' PeerSession::Matches checks.
  [[nodiscard]] bool Matches(const imcodes::rd::Authority& other) const noexcept {
    return other.request_id == authority_.request_id &&
           other.session_id == authority_.session_id &&
           other.capability == authority_.capability;
  }

  // LEASE -- mirrors Windows' PeerSession::Renew exactly: bind the fields an
  // incremental envelope omits (expiresAt, and daemon/route generation when
  // absent) to the PREPARE-admitted route, require the same daemon and route
  // generation, then let TransportSessionCore::RenewLease enforce every
  // deadline/identity/mode/epoch rule.
  [[nodiscard]] bool Renew(const imcodes::rd::Authority& renewal) {
    const imcodes::rd::Authority bound =
        imcodes::rd::BindOmittedAuthorityFields(authority_, renewal);
    if (!Matches(bound) ||
        bound.daemon_generation != authority_.daemon_generation ||
        bound.route_generation != authority_.route_generation ||
        !session_->RenewLease(ToRouteAuthority(bound), SampleTransportTime())) {
      return false;
    }
    authority_.lease_expires_at_ms = bound.lease_expires_at_ms;
    return true;
  }

  // MODE_STATE -- mirrors Windows' PeerSession::SetMode: apply, record the
  // new mode/epoch (STATUS reports authority_.input_epoch, so a stale value
  // here would make every later STATUS look like it belonged to the old
  // epoch), and acknowledge with a MODE_STATE of our own.
  [[nodiscard]] bool SetMode(const imcodes::rd::Authority& update,
                             const std::string& reason) {
    const imcodes::rd::Authority bound =
        imcodes::rd::BindOmittedAuthorityFields(authority_, update);
    if (!Matches(bound) ||
        (bound.mode != imcodes::rd::kViewMode &&
         bound.mode != imcodes::rd::kControlMode) ||
        !session_->UpdateMode(ToRouteAuthority(bound), SampleTransportTime())) {
      return false;
    }
    authority_.mode = bound.mode;
    authority_.input_epoch = bound.input_epoch;
    authority_.lease_expires_at_ms = bound.lease_expires_at_ms;
    Json::Value response =
        imcodes::rd::BaseEnvelope(imcodes::rd::kModeStateType, authority_);
    response["mode"] = authority_.mode;
    response["inputEpoch"] = authority_.input_epoch;
    response["reason"] = reason == imcodes::rd::kModeReasonInitial
        ? imcodes::rd::kModeReasonInitial
        : imcodes::rd::kModeReasonUserSelected;
    WriteLine(response);
    return true;
  }

  [[nodiscard]] common::TransportDiagnostics diagnostics() const {
    return session_->diagnostics();
  }

  [[nodiscard]] bool closed() const noexcept { return session_->closed(); }

  void Stop() noexcept { session_->Stop(); }

  [[nodiscard]] const imcodes::rd::Authority& authority() const noexcept { return authority_; }

  [[nodiscard]] const common::DesktopTopology* topology() const noexcept {
    return session_->topology();
  }

  [[nodiscard]] bool FramePresented() const noexcept {
    return session_->FramePresented();
  }

  // Kicks off an async GetStats() round trip so common::TransportDiagnostics::
  // last_outbound_video_bytes (and therefore this tick's own "mediaStarted")
  // stays current -- see LinuxRemoteDesktopSession::CheckMediaProgress()'s
  // own comment for why this is required at all. Internally rate-limited via
  // its own in-flight guard, so unconditionally every PublishStatus tick is
  // exactly the cadence Windows' worker_main.cc uses for its own
  // PeerSession::CheckMediaProgress() call.
  void CheckMediaProgress() { session_->CheckMediaProgress(); }

 private:
  imcodes::rd::Authority authority_;
  std::shared_ptr<rd::LinuxRemoteDesktopSession> session_;
};

class Worker {
 public:
  Worker(webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
        rd::LinuxPlatformAdapters& adapters,
        webrtc::Thread* signaling_thread)
      : factory_(std::move(factory)), adapters_(adapters), signaling_thread_(signaling_thread) {}

  void HandleSignal(const imcodes::rd::Signal& signal) {
    switch (signal.kind) {
      case imcodes::rd::Signal::Kind::kPrepare: {
        const std::string session_id = signal.authority.session_id;
        auto existing = sessions_.find(session_id);
        if (existing != sessions_.end()) {
          existing->second->Stop();
          sessions_.erase(existing);
        }
        // A session begins on a clean keyboard. A modifier the X server
        // still holds that this worker never pressed was left behind by
        // something it no longer tracks -- a worker killed mid-press, a
        // route lost between a modifier's down and its up -- and until
        // something releases it, it silently rewrites every click and
        // keystroke that follows. Sessions already running keep everything
        // they are holding. See common/latched_modifiers.h.
        adapters_.input().ReleaseLatchedModifiers();
        auto session = std::make_shared<WorkerSession>(
            factory_, adapters_, signaling_thread_, signal.authority);
        if (!session->Start(signal.authority)) {
          // "protocol_error": TransportSessionCore::Start() only refuses an
          // authority that fails its own validity check (bad identity,
          // already-expired lease, control mode with no input epoch, ...),
          // which is a malformed/invalid request, not an adapter/media
          // failure -- see this file's other TerminalEnvelope call for why
          // that gets "worker_failed" instead.
          WriteLine(imcodes::rd::TerminalEnvelope(signal.authority, "protocol_error"));
          return;
        }
        sessions_.emplace(session_id, std::move(session));
        return;
      }
      case imcodes::rd::Signal::Kind::kOffer: {
        auto* session = Find(signal.authority.session_id);
        if (session) session->ApplyOffer(signal.authority, signal.sdp);
        return;
      }
      case imcodes::rd::Signal::Kind::kIce: {
        auto* session = Find(signal.authority.session_id);
        if (session) session->AddRemoteIce(signal.mid, signal.candidate);
        return;
      }
      case imcodes::rd::Signal::Kind::kStop: {
        auto it = sessions_.find(signal.authority.session_id);
        if (it == sessions_.end()) return;
        it->second->Stop();
        // "stopped_by_controller": a STOP always originates from the
        // daemon/server side of the wire (there is no local-user stop
        // surface on this delivery model), matching macOS's own worker
        // comment on why explicit STOP gets its terminal reply from the
        // command handler rather than from OnTerminal's kStopped case.
        WriteLine(imcodes::rd::TerminalEnvelope(signal.authority, "stopped_by_controller"));
        sessions_.erase(it);
        return;
      }
      case imcodes::rd::Signal::Kind::kLease:
      case imcodes::rd::Signal::Kind::kMode: {
        auto it = sessions_.find(signal.authority.session_id);
        // Not ours (or already gone): ignored, exactly like Windows'
        // worker_main.cc, which only acts on an identity-matching session.
        if (it == sessions_.end() || !it->second->Matches(signal.authority)) {
          return;
        }
        const bool accepted = signal.kind == imcodes::rd::Signal::Kind::kLease
            ? it->second->Renew(signal.authority)
            : it->second->SetMode(signal.authority, signal.reason);
        // Also mirrors Windows: a LEASE/MODE_STATE the transport core refuses
        // for a still-live, identity-matching session is a protocol error,
        // never something to keep silently running past. (A session the core
        // already ended is reported by PublishStatus below instead.)
        if (!accepted && !it->second->closed()) {
          // One stderr line per refusal (error path only; lands in the node
          // service journal): which envelope, and what it asked for against
          // what the session holds, is the whole diagnosis.
          const imcodes::rd::Authority& held = it->second->authority();
          std::fprintf(stderr,
                       "linux worker: session %.8s refused %s: mode=%s epoch=%d "
                       "lease=%lld (held mode=%s epoch=%d lease=%lld, now=%lld)\n",
                       it->first.c_str(),
                       signal.kind == imcodes::rd::Signal::Kind::kLease ? "LEASE"
                                                                       : "MODE_STATE",
                       signal.authority.mode.c_str(), signal.authority.input_epoch,
                       static_cast<long long>(signal.authority.lease_expires_at_ms),
                       held.mode.c_str(), held.input_epoch,
                       static_cast<long long>(held.lease_expires_at_ms),
                       static_cast<long long>(NowUnixMs()));
          it->second->Stop();
          WriteLine(imcodes::rd::TerminalEnvelope(it->second->authority(),
                                                  "protocol_error"));
          sessions_.erase(it);
        }
        return;
      }
    }
  }

  /** One status line per still-live session; called on a fixed poll tick. */
  void PublishStatus() {
    for (auto it = sessions_.begin(); it != sessions_.end();) {
      if (it->second->closed()) {
        // Every path that closes a session explicitly (STOP, PREPARE
        // replacement, a refused LEASE/MODE_STATE) erases it on the spot, so
        // one found closed here was ended by the transport core itself. Tell
        // the Server why, like macOS and Windows do. Silently forgetting it
        // left the Server renewing a route nothing served anymore until the
        // browser's 5-minute reconnect grace expired, and hid the real
        // reason (e.g. lease_expired) behind a generic browser disconnect.
        const common::TransportDiagnostics ended = it->second->diagnostics();
        std::fprintf(stderr,
                     "linux worker: session %.8s ended by transport core: %s "
                     "(local ice %zu, remote ice %zu)\n",
                     it->first.c_str(), TerminalReasonName(ended.terminal_reason),
                     ended.accepted_local_ice, ended.accepted_remote_ice);
        if (const char* reason = WireTerminalReason(ended.terminal_reason)) {
          WriteLine(imcodes::rd::TerminalEnvelope(it->second->authority(), reason));
        }
        it = sessions_.erase(it);
        continue;
      }
      it->second->CheckMediaProgress();
      const common::TransportDiagnostics diagnostics = it->second->diagnostics();
      Json::Value status = imcodes::rd::BaseEnvelope(
          imcodes::rd::kStatusType, it->second->authority());
      status["mode"] = diagnostics.mode == common::TransportSessionMode::kControl
          ? imcodes::rd::kControlMode : imcodes::rd::kViewMode;
      status["inputEpoch"] = static_cast<Json::Int64>(it->second->authority().input_epoch);
      status["state"] = StateFor(diagnostics);
      status["peerConnected"] = diagnostics.peer_state == common::PeerConnectionState::kConnected;
      status["dataChannelsReady"] = diagnostics.required_channels_ready;
      // Honours set_quality_preference; the browser sends it only when true.
      status["qualityPreference"] = true;
      // ...including Ultra: maxHeight 2160 and a raised bitrate ceiling.
      status["qualityUltra"] = true;
      status["mediaStarted"] = diagnostics.last_outbound_video_bytes > 0;
      // The fourth fact the Server requires before it disarms
      // NEGOTIATION_TIMEOUT_MS and calls the session connected -- see
      // LinuxRemoteDesktopSession::FramePresented()'s own comment. Left
      // unset (permanently undefined over the wire, so === true always
      // failed server-side) meant every Linux session, however healthy,
      // was killed by the negotiation timeout exactly 45s after PREPARE.
      status["firstFramePresented"] = it->second->FramePresented();
      // Real now: linux_remote_desktop_session.cc's own DataChannelObserver
      // dispatches pointer/keyboard once this is true. Conservative (not the
      // full mode/channels/frame/state formula macOS's own EmitStatus uses)
      // but never reports enabled before the browser could plausibly act on
      // it: Control mode granted, and the keyboard/pointer/control channels
      // all actually open. A hardcoded false here -- left over from when
      // dispatch genuinely did not exist -- is exactly why a browser that
      // reads this field to decide whether to show/send input at all kept
      // finding nothing to do even after dispatch was wired.
      status["inputEnabled"] =
          diagnostics.mode == common::TransportSessionMode::kControl &&
          diagnostics.required_channels_ready;
      // The browser's own gate (remote-desktop-client.ts's
      // statusMatchesConsumedTopology/statusMatchesPresentedFrame) refuses to
      // enable input until a STATUS carries a selectedDisplayId/layoutRevision
      // that matches what it already has and has itself presented a decoded
      // frame for -- exactly like Windows' and macOS's own STATUS payloads
      // already do. Leaving these two fields unset here (as this worker did
      // until now) meant every browser session sat with inputEnabled=true
      // over the wire but the client's own snapshot.inputEnabled permanently
      // false: video visibly playing, every click/keystroke silently
      // dropped by the client before it ever reached a data channel. Linux
      // has exactly one fixed display, so "selected" is simply the one
      // display topology already reports.
      if (const common::DesktopTopology* topology = it->second->topology();
          topology != nullptr && !topology->displays.empty()) {
        status["selectedDisplayId"] = topology->displays.front().display_id;
        status["layoutRevision"] = Json::UInt64(topology->revision);
      }
      WriteLine(status);
      ++it;
    }
  }

 private:
  WorkerSession* Find(const std::string& session_id) {
    auto it = sessions_.find(session_id);
    return it == sessions_.end() ? nullptr : it->second.get();
  }

  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  rd::LinuxPlatformAdapters& adapters_;
  webrtc::Thread* signaling_thread_;
  std::unordered_map<std::string, std::shared_ptr<WorkerSession>> sessions_;
};

}  // namespace

int main() {
  std::signal(SIGPIPE, SIG_IGN);
  webrtc::InitializeSSL();

  auto connection = rd::X11Connection::Open();
  if (!connection) { std::fprintf(stderr, "linux worker: cannot open X display\n"); return 10; }
  auto adapters = rd::LinuxPlatformAdapters::Create(connection);
  if (!adapters) { std::fprintf(stderr, "linux worker: LinuxPlatformAdapters::Create failed\n"); return 11; }
  // The worker is the local agent. Its corner affordance exists for the whole
  // worker lifetime, not only after a remote PREPARE arrives.
  if (!adapters->disclosure().Show(0, 0)) {
    std::fprintf(stderr, "linux worker: idle disclosure unavailable\n");
    return 14;
  }

  auto signaling_thread = webrtc::Thread::Create();
  signaling_thread->Start();
  auto worker_thread = webrtc::Thread::Create();
  worker_thread->Start();
  auto network_thread = webrtc::Thread::CreateWithSocketServer();
  network_thread->Start();

  webrtc::PeerConnectionFactoryDependencies factory_deps;
  factory_deps.network_thread = network_thread.get();
  factory_deps.worker_thread = worker_thread.get();
  factory_deps.signaling_thread = signaling_thread.get();
  // Set before EnableMedia() below, which is what actually captures it into
  // the deferred media-engine construction path -- see SilentAudioDeviceModule's
  // own comment for why a real platform ADM here aborts this exact process.
  factory_deps.adm = webrtc::make_ref_counted<SilentAudioDeviceModule>();
  if (!factory_deps.adm) {
    std::fprintf(stderr, "linux worker: failed to construct silent audio device module\n");
    return 13;
  }
  factory_deps.audio_encoder_factory = webrtc::CreateBuiltinAudioEncoderFactory();
  factory_deps.audio_decoder_factory = webrtc::CreateBuiltinAudioDecoderFactory();
  factory_deps.video_encoder_factory = webrtc::CreateBuiltinVideoEncoderFactory();
  factory_deps.video_decoder_factory = webrtc::CreateBuiltinVideoDecoderFactory();
  webrtc::EnableMedia(factory_deps);
  auto factory = webrtc::CreateModularPeerConnectionFactory(std::move(factory_deps));
  if (!factory) { std::fprintf(stderr, "linux worker: CreatePeerConnectionFactory failed\n"); return 12; }

  Worker worker(factory, *adapters, signaling_thread.get());

  // Worker (its sessions_ map, and everything reachable through
  // LinuxRemoteDesktopSession/TransportSessionCore, which is documented as
  // "signaling-sequence confined" -- see transport_session_core.h's own
  // comment) is touched EXCLUSIVELY from the signaling thread from here on.
  // The stdin-reading loop below and the status timer's sleep loop both run
  // on their own threads, but only ever hand work to Worker by posting it
  // onto signaling_thread -- never by calling into Worker directly. This is
  // what actually makes that single-threaded confinement hold: an earlier
  // version of this file called worker.PublishStatus() directly from a
  // detached timer thread while HandleSignal() ran on the stdin thread, an
  // unsynchronized concurrent-map bug whose corruption surfaced as an
  // unrelated-looking crash inside WebRTC's audio device init.
  std::thread status_thread([&worker, thread = signaling_thread.get()]() {
    while (true) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1000));
      thread->PostTask([&worker]() { worker.PublishStatus(); });
    }
  });
  status_thread.detach();

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    Json::Value root;
    if (!imcodes::rd::ParseJson(line, &root)) continue;
    if (root["type"].asString() == common::kLocalAccessStateType &&
        root["paused"].isBool()) {
      adapters->disclosure().SetAccessPaused(root["paused"].asBool());
      continue;
    }
    auto signal = imcodes::rd::ParseServiceSignal(root, NowUnixMs());
    if (!signal) continue;
    // Posted, not called directly, and posted tasks on one webrtc::Thread
    // run strictly in the order they were posted, so PREPARE/OFFER/ICE for
    // one session still process in the order they arrived on stdin even
    // though this loop never waits for one to finish before reading the
    // next line.
    signaling_thread->PostTask([&worker, signal = *signal]() { worker.HandleSignal(signal); });
  }
  return 0;
}
