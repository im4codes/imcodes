#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "transport_session_core.h"

namespace common = imcodes::remote_desktop::common;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition) return;
  std::cerr << "remote-desktop common transport failure: " << message << '\n';
  std::exit(1);
}

const char* ChannelName(common::DataChannelKind channel) {
  switch (channel) {
    case common::DataChannelKind::kControl:
      return "control";
    case common::DataChannelKind::kKeyboard:
      return "keyboard";
    case common::DataChannelKind::kPointer:
      return "pointer";
  }
  return "invalid";
}

class FakeQualityLadder final : public common::QualityLadder {
 public:
  common::QualitySelection Select(
      const common::QualityTarget& target) const noexcept override {
    return common::QualitySelection{
        "bounded",
        target.source_pixels,
        30,
        target.bitrate_bps,
    };
  }
};

class FakeTransportAdapter final : public common::TransportSessionAdapter {
 public:
  bool StartTransport(const common::RouteAuthority& authority) override {
    ++start_count;
    started_authority = authority;
    events.push_back("start");
    return start_result;
  }

  bool AddRemoteIceCandidate(const common::IceCandidate& candidate) override {
    remote_ice.push_back(candidate);
    events.push_back("remote-ice");
    return remote_ice_result;
  }

  bool EmitLocalIceCandidate(const common::IceCandidate& candidate) override {
    local_ice.push_back(candidate);
    events.push_back("local-ice");
    return local_ice_result;
  }

  bool ApplyQuality(const common::QualitySelection& selection) override {
    qualities.push_back(selection);
    events.push_back("quality");
    return quality_result;
  }

  void ReleaseControlAuthority(const common::RouteAuthorityIdentity&,
                               std::uint64_t input_epoch) noexcept override {
    released_epochs.push_back(input_epoch);
    events.push_back("release");
  }

  void CloseDataChannel(common::DataChannelKind channel) noexcept override {
    events.push_back(std::string("close:") + ChannelName(channel));
  }

  void CloseTransport() noexcept override {
    ++close_transport_count;
    events.push_back("close:transport");
  }

  void PublishDiagnostics(
      const common::TransportDiagnostics& diagnostics) noexcept override {
    published_diagnostics.push_back(diagnostics);
  }

  void OnTerminal(common::TransportTerminalReason reason) noexcept override {
    ++terminal_count;
    terminal_reason = reason;
    events.push_back("terminal");
  }

  bool start_result = true;
  bool remote_ice_result = true;
  bool local_ice_result = true;
  bool quality_result = true;
  int start_count = 0;
  int close_transport_count = 0;
  int terminal_count = 0;
  common::TransportTerminalReason terminal_reason =
      common::TransportTerminalReason::kNone;
  common::RouteAuthority started_authority;
  std::vector<common::IceCandidate> remote_ice;
  std::vector<common::IceCandidate> local_ice;
  std::vector<common::QualitySelection> qualities;
  std::vector<std::uint64_t> released_epochs;
  std::vector<common::TransportDiagnostics> published_diagnostics;
  std::vector<std::string> events;
};

common::TransportSessionLimits Limits() {
  common::TransportSessionLimits limits;
  limits.maximum_remote_ice_candidates = 2;
  limits.maximum_local_ice_candidates = 2;
  limits.maximum_lease_future_ms = 10'000;
  limits.idle_timeout_ms = 1'000;
  limits.media_stall_timeout_ms = 100;
  return limits;
}

common::RouteAuthority Authority(
    common::TransportSessionMode mode = common::TransportSessionMode::kControl,
    std::uint64_t input_epoch = 7,
    std::int64_t lease_expires_at_unix_ms = 5'000,
    std::int64_t expires_at_unix_ms = 9'000) {
  return common::RouteAuthority{
      common::RouteAuthorityIdentity{
          "request_1234567890",
          "session_1234567890",
          "negotiated_binding_1234567890",
          41,
          9,
      },
      expires_at_unix_ms,
      lease_expires_at_unix_ms,
      mode,
      input_epoch,
  };
}

common::TransportTime At(std::int64_t unix_ms, std::int64_t monotonic_ms) {
  return common::TransportTime{unix_ms, monotonic_ms};
}

common::TransportCallbackStamp Stamp(
    common::WorkerGeneration daemon_generation = 41,
    std::uint64_t route_generation = 9) {
  return common::TransportCallbackStamp{daemon_generation, route_generation};
}

common::IceCandidate Candidate(std::string suffix) {
  return common::IceCandidate{"0", "candidate:" + std::move(suffix)};
}

std::vector<std::string> CleanupEvents(const std::vector<std::string>& events) {
  std::vector<std::string> result;
  for (const std::string& event : events) {
    if (event == "release" || event.starts_with("close:") ||
        event == "terminal") {
      result.push_back(event);
    }
  }
  return result;
}

}  // namespace

int main() {
  FakeQualityLadder ladder;

  {
    FakeTransportAdapter adapter;
    common::TransportSessionLimits unbounded = Limits();
    unbounded.maximum_remote_ice_candidates =
        common::kTransportMaximumIceCandidates + 1;
    common::TransportSessionCore core(adapter, ladder, unbounded);
    Require(!core.Start(Authority(), At(0, 0)) && adapter.start_count == 0,
            "caller limits cannot exceed the compiled hard bounds");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(), At(0, 0)),
            "a valid bounded authority starts the transport");
    const std::int64_t original_lease =
        core.authority()->lease_expires_at_unix_ms;

    common::RouteAuthority stale_generation = Authority();
    stale_generation.identity.daemon_generation++;
    stale_generation.lease_expires_at_unix_ms = 6'000;
    Require(!core.RenewLease(stale_generation, At(100, 100)) &&
                core.authority()->lease_expires_at_unix_ms == original_lease,
            "stale generation renewal cannot extend route authority");

    common::RouteAuthority stale_renewal = Authority();
    stale_renewal.lease_expires_at_unix_ms = original_lease;
    Require(!core.RenewLease(stale_renewal, At(100, 101)),
            "non-increasing renewal is rejected");

    common::RouteAuthority renewal = Authority();
    renewal.lease_expires_at_unix_ms = 6'000;
    Require(core.RenewLease(renewal, At(100, 102)) &&
                core.authority()->lease_expires_at_unix_ms == 6'000,
            "matching increasing renewal extends the lease");

    common::RouteAuthority changed_absolute_expiry = renewal;
    changed_absolute_expiry.expires_at_unix_ms++;
    changed_absolute_expiry.lease_expires_at_unix_ms = 7'000;
    Require(!core.RenewLease(changed_absolute_expiry, At(100, 103)) &&
                core.authority()->expires_at_unix_ms == 9'000 &&
                core.authority()->lease_expires_at_unix_ms == 6'000,
            "renewal cannot mutate the bound absolute route expiry");

    common::RouteAuthority beyond_absolute_expiry = renewal;
    beyond_absolute_expiry.lease_expires_at_unix_ms = 9'001;
    Require(!core.RenewLease(beyond_absolute_expiry, At(100, 104)) &&
                core.authority()->lease_expires_at_unix_ms == 6'000,
            "renewal lease cannot outlive absolute route authority");

    common::RouteAuthority changed_binding = renewal;
    changed_binding.identity.negotiated_capability_binding =
        "other_binding_1234567890";
    changed_binding.lease_expires_at_unix_ms = 7'000;
    Require(!core.RenewLease(changed_binding, At(100, 105)) &&
                core.authority()->lease_expires_at_unix_ms == 6'000,
            "negotiated capability binding fences renewal authority");

    Require(!core.OnPeerConnectionState(Stamp(40, 9),
                                        common::PeerConnectionState::kConnected,
                                        At(100, 106)) &&
                core.peer_state() == common::PeerConnectionState::kNew,
            "stale callback generation cannot connect a replacement route");

    common::RouteAuthority expired_renewal = renewal;
    expired_renewal.lease_expires_at_unix_ms = 8'000;
    Require(!core.RenewLease(expired_renewal, At(6'000, 107)) &&
                core.authority()->lease_expires_at_unix_ms == 6'000,
            "expired authority cannot be revived by a late renewal");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    common::RouteAuthority invalid = Authority();
    invalid.expires_at_unix_ms = invalid.lease_expires_at_unix_ms - 1;
    Require(!core.Start(invalid, At(0, 0)) && adapter.start_count == 0,
            "absolute authority expiry cannot precede its renewable lease");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(
        core.Start(Authority(), At(0, 0)) &&
            core.peer_state() == common::PeerConnectionState::kNew &&
            core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kNew, At(1, 1)) &&
            core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kConnecting, At(2, 2)) &&
            core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kConnected, At(3, 3)),
        "first libwebrtc callback may report new before connecting and "
        "connected");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(), At(0, 0)) &&
                core.OnPeerConnectionState(
                    Stamp(), common::PeerConnectionState::kConnected,
                    At(1, 1)),
            "recoverable failure transport starts connected");
    Require(core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kFailed, At(2, 2)) &&
                !core.terminal() && adapter.close_transport_count == 0 &&
                adapter.released_epochs == std::vector<std::uint64_t>{7},
            "failed peer releases input but stays alive for ICE restart");
    Require(core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kConnecting,
                At(3, 3)) &&
                core.OnPeerConnectionState(
                    Stamp(), common::PeerConnectionState::kConnected,
                    At(4, 4)) &&
                !core.terminal(),
            "failed peer can recover in place through connecting");
    Require(!core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kClosed, At(5, 5)) &&
                core.terminal_reason() ==
                    common::TransportTerminalReason::kPeerFailed,
            "an explicit peer close remains terminal after recovery");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(), At(0, 0)), "ICE test transport starts");
    Require(
        core.AddRemoteIceCandidate(Authority().identity, Candidate("r1")) &&
            core.AddRemoteIceCandidate(Authority().identity, Candidate("r2")) &&
            core.pending_remote_ice() == 2 && adapter.remote_ice.empty(),
        "remote ICE remains bounded before remote description");
    Require(core.SetRemoteDescriptionReady(Stamp()) &&
                core.pending_remote_ice() == 0 &&
                adapter.remote_ice.size() == 2 &&
                adapter.remote_ice[0].candidate == "candidate:r1" &&
                adapter.remote_ice[1].candidate == "candidate:r2",
            "remote ICE flushes FIFO through the transport adapter");

    Require(core.OnLocalIceCandidate(Stamp(), Candidate("l1")) &&
                core.OnLocalIceCandidate(Stamp(), Candidate("l2")) &&
                core.pending_local_ice() == 2 && adapter.local_ice.empty(),
            "local ICE remains bounded before signaling emission is ready");
    Require(core.SetLocalIceEmissionReady(Stamp()) &&
                core.pending_local_ice() == 0 &&
                adapter.local_ice.size() == 2 &&
                adapter.local_ice[0].candidate == "candidate:l1" &&
                adapter.local_ice[1].candidate == "candidate:l2",
            "local ICE flushes FIFO through the signaling adapter");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(), At(0, 0)), "overflow transport starts");
    Require(
        core.AddRemoteIceCandidate(Authority().identity, Candidate("one")) &&
            core.AddRemoteIceCandidate(Authority().identity, Candidate("two")),
        "candidate queue fills to its exact bound");
    Require(!core.AddRemoteIceCandidate(Authority().identity,
                                        Candidate("overflow")) &&
                core.terminal() &&
                core.terminal_reason() ==
                    common::TransportTerminalReason::kCandidateOverflow &&
                core.pending_remote_ice() == 0,
            "candidate overflow terminates and erases queued material");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(), At(0, 0)),
            "local overflow transport starts");
    Require(core.OnLocalIceCandidate(Stamp(), Candidate("one")) &&
                core.OnLocalIceCandidate(Stamp(), Candidate("two")),
            "local candidate queue fills to its exact bound");
    Require(!core.OnLocalIceCandidate(Stamp(), Candidate("overflow")) &&
                core.terminal_reason() ==
                    common::TransportTerminalReason::kCandidateOverflow &&
                core.pending_local_ice() == 0,
            "local candidate overflow is bounded and terminal");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(), At(0, 0)), "channel test transport starts");
    Require(core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kConnected, At(10, 10)),
            "peer reaches connected state");
    Require(
        core.OnDataChannelState(Stamp(), common::DataChannelKind::kControl,
                                common::DataChannelState::kOpen) &&
            core.OnDataChannelState(Stamp(), common::DataChannelKind::kKeyboard,
                                    common::DataChannelState::kOpen) &&
            core.OnDataChannelState(Stamp(), common::DataChannelKind::kPointer,
                                    common::DataChannelState::kOpen) &&
            core.required_channels_ready() && core.control_ready(),
        "all required DataChannels gate control readiness");

    Require(
        !core.OnDataChannelState(Stamp(), common::DataChannelKind::kKeyboard,
                                 common::DataChannelState::kFailed) &&
            core.terminal_reason() ==
                common::TransportTerminalReason::kChannelFailed,
        "required channel failure is terminal");
    const std::vector<std::string> expected = {
        "release",       "close:control",   "close:keyboard",
        "close:pointer", "close:transport", "terminal",
    };
    Require(CleanupEvents(adapter.events) == expected,
            "terminal cleanup orders authority release before channels and "
            "transport");
    core.Stop();
    Require(adapter.close_transport_count == 1 && adapter.terminal_count == 1,
            "transport close and terminal callback happen exactly once");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(), At(0, 0)), "lifecycle transport starts");
    Require(core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kConnected, At(10, 10)),
            "lifecycle reaches connected state");
    Require(!core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kNew, At(11, 11)) &&
                core.terminal_reason() ==
                    common::TransportTerminalReason::kProtocolViolation,
            "peer lifecycle cannot regress to new and bypass watchdog state");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(), At(0, 0)), "mode test transport starts");
    common::RouteAuthority view =
        Authority(common::TransportSessionMode::kView, 8);
    common::RouteAuthority changed_expiry = view;
    changed_expiry.expires_at_unix_ms++;
    Require(!core.UpdateMode(changed_expiry, At(9, 9)) &&
                adapter.released_epochs.empty(),
            "mode update cannot mutate absolute route expiry before release");
    Require(core.UpdateMode(view, At(10, 10)) &&
                adapter.released_epochs.size() == 1 &&
                adapter.released_epochs[0] == 7,
            "control downgrade releases the previous input epoch");
    core.Stop();
    Require(adapter.released_epochs.size() == 1,
            "terminal cleanup does not double-release a downgraded epoch");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    const common::RouteAuthority control = Authority(
        common::TransportSessionMode::kControl, 7, 10'000, 20'000);
    Require(core.Start(control, At(0, 0)),
            "control transport starts before same-mode rekey");
    common::RouteAuthority rekeyed = control;
    rekeyed.input_epoch = 8;
    Require(core.UpdateMode(rekeyed, At(10, 10)) &&
                adapter.released_epochs == std::vector<std::uint64_t>{7},
            "same-mode rekey releases every input owned by the old epoch");
    Require(core.UpdateMode(rekeyed, At(11, 11)) &&
                adapter.released_epochs == std::vector<std::uint64_t>{7},
            "duplicate rekey is idempotent and does not release twice");
    common::RouteAuthority skipped = rekeyed;
    skipped.input_epoch = 10;
    Require(!core.UpdateMode(skipped, At(12, 12)) &&
                adapter.released_epochs == std::vector<std::uint64_t>{7},
            "same-mode rekey cannot skip an input authority generation");
    core.Stop();
    Require(adapter.released_epochs == std::vector<std::uint64_t>{7, 8},
            "terminal cleanup releases only the replacement epoch");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    common::RouteAuthority view =
        Authority(common::TransportSessionMode::kView, 0);
    Require(core.Start(view, At(0, 0)), "view mode transport starts");
    common::RouteAuthority control =
        Authority(common::TransportSessionMode::kControl, 1,
                  view.lease_expires_at_unix_ms, view.expires_at_unix_ms);
    Require(core.UpdateMode(control, At(10, 10)),
            "view can advance to control epoch");
    core.Stop();
    Require(adapter.released_epochs == std::vector<std::uint64_t>{1},
            "terminal cleanup releases newly granted control authority");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(common::TransportSessionMode::kControl, 7,
                                 10'000, 20'000),
                       At(0, 0)),
            "watchdog transport starts");
    Require(core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kConnected, At(10, 10)),
            "media watchdog arms on connection");
    Require(core.RecordMediaProgress(Stamp(), 20, 100, At(50, 50)) &&
                core.RecordMediaProgress(Stamp(), 21, 100, At(9'999, 149)) &&
                core.Tick(At(500, 149)),
            "fresh media progress keeps the watchdog alive");
    Require(core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kConnected, At(500, 149)),
            "duplicate connected callbacks remain observable");
    Require(!core.Tick(At(500, 150)) &&
                core.terminal_reason() ==
                    common::TransportTerminalReason::kMediaStalled,
            "wall-clock jumps and duplicate callbacks cannot postpone a real "
            "media stall");
  }

  {
    // The stall must be reported BY RecordMediaProgress, not only by the next
    // Tick.
    //
    // Both paths terminate, so a Tick-only stall looks identical in the
    // transport diagnostics -- and that is exactly why this needs its own
    // counterfactual. The Windows worker burns the process-local hardware
    // encoder in HandleMediaStats, on the strength of RecordMediaProgress
    // returning false with kMediaStalled. Nothing reacts to a stall observed
    // by Tick: PeerSession::OnTerminal maps kMediaStalled to a wire reason and
    // stops there. So if this call started returning true and left the
    // termination to Tick, the session would still fail -- and then reconnect
    // straight back onto the same hardware encoder that had just stalled,
    // forever.
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(common::TransportSessionMode::kControl, 7,
                                 10'000, 20'000),
                       At(0, 0)) &&
                core.OnPeerConnectionState(Stamp(),
                                           common::PeerConnectionState::kConnected,
                                           At(10, 10)) &&
                core.RecordMediaProgress(Stamp(), 20, 100, At(50, 50)),
            "immediate-stall transport establishes a media baseline");
    // Capture advanced (21 > 20) but not one outbound byte moved, and the
    // stall timeout has elapsed on the monotonic clock.
    Require(!core.RecordMediaProgress(Stamp(), 21, 100, At(60, 150)),
            "RecordMediaProgress itself reports the stall, because its return "
            "value is what disqualifies the hardware encoder");
    Require(core.terminal_reason() ==
                common::TransportTerminalReason::kMediaStalled,
            "the immediate stall is attributed to kMediaStalled");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(
        core.Start(Authority(common::TransportSessionMode::kControl, 7, 10'000,
                             20'000),
                   At(0, 0)) &&
            core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kConnected, At(10, 10)) &&
            core.RecordMediaProgress(Stamp(), 20, 100, At(50, 50)) &&
            core.RecordMediaProgress(Stamp(), 20, 100, At(9'999, 150)) &&
            core.Tick(At(500, 151)),
        "a static source never trips the media watchdog across wall-clock "
        "jumps");
    Require(!core.terminal(),
            "static desktop remains live while capture is not advancing");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(
        core.Start(Authority(), At(0, 0)) &&
            core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kConnected, At(10, 10)) &&
            core.RecordMediaProgress(Stamp(), 100, 1'000, At(50, 50)) &&
            core.ResetMediaProgress(Stamp(), At(60, 60)) &&
            core.RecordMediaProgress(Stamp(), 1, 1, At(61, 61)) &&
            core.diagnostics().last_observed_source_frames == 1 &&
            core.diagnostics().last_outbound_video_bytes == 1,
        "explicit media reset admits fresh monotonic counters after track "
        "replacement");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(
        core.Start(Authority(), At(0, 0)) &&
            core.OnPeerConnectionState(
                Stamp(), common::PeerConnectionState::kConnected, At(10, 10)) &&
            core.RecordMediaProgress(Stamp(), 20, 100, At(50, 50)),
        "counter regression transport establishes a media baseline");
    Require(
        !core.RecordMediaProgress(Stamp(), 19, 100, At(51, 51)) &&
            core.terminal_reason() ==
                common::TransportTerminalReason::kProtocolViolation &&
            adapter.close_transport_count == 1,
        "media counter regression fails closed instead of resetting watchdogs");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(), At(0, 100)),
            "monotonic regression transport starts");
    Require(!core.RecordActivity(Authority().identity, At(100, 99)) &&
                core.terminal_reason() ==
                    common::TransportTerminalReason::kProtocolViolation &&
                adapter.close_transport_count == 1,
            "monotonic clock regression fails closed with one cleanup");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(common::TransportSessionMode::kControl, 7,
                                 7'000, 7'000),
                       At(0, 0)),
            "absolute expiry transport starts");
    Require(!core.Tick(At(7'000, 1)) &&
                core.terminal_reason() ==
                    common::TransportTerminalReason::kRouteExpired,
            "absolute route expiry wins over lease expiry at the same Unix "
            "deadline");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(), At(0, 0)), "lease expiry transport starts");
    Require(!core.Tick(At(5'000, 1)) &&
                core.terminal_reason() ==
                    common::TransportTerminalReason::kLeaseExpired,
            "renewable lease expiry remains distinct from absolute authority "
            "expiry");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(), At(0, 0)), "diagnostic transport starts");
    Require(core.OnTransportPath(Stamp(), common::TransportPath::kDirect) &&
                core.path() == common::TransportPath::kDirect,
            "direct transport status is owned by the common core");
    Require(core.OnTransportPath(Stamp(), common::TransportPath::kRelay) &&
                core.path() == common::TransportPath::kRelay,
            "relay transport status replaces direct status");
    Require(
        core.UpdateQualityTarget(
            Stamp(), common::QualityTarget{4'000'000, {1920, 1080}}) &&
            adapter.qualities.size() == 1 &&
            adapter.qualities[0].preset_id == "bounded" &&
            core.diagnostics().quality.has_value(),
        "quality target and selected diagnostics use the shared ladder seam");
    Require(!adapter.published_diagnostics.empty() &&
                adapter.published_diagnostics.back().path ==
                    common::TransportPath::kRelay,
            "transport diagnostics publish bounded route state");
  }

  {
    FakeTransportAdapter adapter;
    common::TransportSessionCore core(adapter, ladder, Limits());
    Require(core.Start(Authority(common::TransportSessionMode::kControl, 7,
                                 10'000, 20'000),
                       At(1'000, 0)),
            "idle watchdog transport starts");
    Require(core.RecordActivity(Authority().identity, At(1'100, 900)) &&
                core.Tick(At(9'999, 1'899)),
            "wall-clock forward jump does not expire the idle watchdog");
    Require(
        !core.Tick(At(500, 1'900)) &&
            core.terminal_reason() ==
                common::TransportTerminalReason::kIdleTimeout,
        "wall-clock rollback does not postpone the monotonic idle watchdog");
  }

  std::cout << "remote-desktop common transport counterfactuals passed\n";
  return 0;
}
