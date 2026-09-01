#include "macos_remote_desktop_session.h"

#import <dispatch/dispatch.h>

#include <algorithm>
#include <limits>
#include <mutex>
#include <utility>

#include "cg_event_input_adapter.h"
#include "macos_permission_readiness.h"
#include "macos_session_monitor.h"
#include "macos_virtual_display_adapter.h"

namespace imcodes::remote_desktop::macos {
namespace {

using common::CapabilityReadiness;
using common::GraphicalSessionEvent;
using common::ReadinessState;
using common::SessionState;
using common::TerminalError;
using common::TerminalErrorCode;

TerminalError Error(TerminalErrorCode code, std::string detail) {
  return TerminalError{code, std::move(detail)};
}

class MacosSessionQualityLadder final : public common::QualityLadder {
 public:
  common::QualitySelection Select(
      const common::QualityTarget& target) const noexcept override {
    return common::QualitySelection{
        "macos-videotoolbox",
        target.source_pixels,
        30,
        target.bitrate_bps,
    };
  }
};

common::TerminalError TransportError(common::TransportTerminalReason reason) {
  using Reason = common::TransportTerminalReason;
  switch (reason) {
    case Reason::kRouteExpired:
    case Reason::kLeaseExpired:
    case Reason::kIdleTimeout:
      return Error(TerminalErrorCode::kStopped,
                   "macOS route authority expired or became idle");
    case Reason::kMediaStalled:
      return Error(TerminalErrorCode::kEncoderUnavailable,
                   "macOS transport media progress stalled");
    case Reason::kStopped:
      return Error(TerminalErrorCode::kStopped, "macOS transport stopped");
    case Reason::kNone:
    case Reason::kPeerFailed:
    case Reason::kChannelFailed:
    case Reason::kCandidateOverflow:
    case Reason::kAdapterFailure:
    case Reason::kProtocolViolation:
      return Error(TerminalErrorCode::kAdapterFailure,
                   "macOS transport failed closed");
  }
  return Error(TerminalErrorCode::kAdapterFailure,
               "macOS transport failed closed");
}

class H264BridgeMediaSender final : public MacosEncodedMediaSender {
 public:
  explicit H264BridgeMediaSender(
      std::unique_ptr<H264SenderBackend> pinned_backend)
      : bridge_(std::move(pinned_backend)) {}

  bool Start(common::WorkerGeneration generation,
             common::PixelSize encoded_pixels,
             common::H264Profile profile) override {
    return bridge_.Start(generation, encoded_pixels, profile);
  }

  bool Submit(common::WorkerGeneration generation,
              common::H264AccessUnit access_unit) override {
    return bridge_.Submit(generation, std::move(access_unit));
  }

  void Stop() noexcept override { bridge_.Stop(); }

 private:
  H264SenderBridge bridge_;
};

class ProductionLifecycle final : public MacosSessionLifecycle {
 public:
  ProductionLifecycle(CGEventInputAdapter& input,
                      NSPasteboardClipboardAdapter& clipboard,
                      common::DisclosureAdapter& disclosure,
                      MacosVirtualDisplayAdapter& virtual_display,
                      MacosDisclosureBeginGeneration begin_disclosure)
      : input_(input),
        clipboard_(clipboard),
        disclosure_(disclosure),
        virtual_display_(virtual_display),
        begin_disclosure_(std::move(begin_disclosure)) {}

  bool BeginGeneration(common::WorkerGeneration generation) override {
    if (!begin_disclosure_ || !begin_disclosure_(generation))
      return false;
    if (clipboard_.StartSession())
      return true;
    disclosure_.Hide();
    return false;
  }

  bool BindInputTopology(const common::DesktopTopology& topology,
                         std::string_view display_id) override {
    return input_.BindTopology(topology, display_id);
  }

  void EndGeneration(MacosSessionEndReason reason) noexcept override {
    clipboard_.StopSession();
    input_.HandleLifecycleBoundary(ToInputReason(reason));
    // SessionCore has already stopped capture and released emitted input when
    // this lifecycle callback runs. Never remove the WindowServer display
    // while capture or a stale input mapping can still reference it.
    virtual_display_.ReleaseVirtualDisplay();
  }

 private:
  static CGEventInputReleaseReason ToInputReason(
      MacosSessionEndReason reason) noexcept {
    switch (reason) {
      case MacosSessionEndReason::kPermissionLoss:
        return CGEventInputReleaseReason::kPermissionLoss;
      case MacosSessionEndReason::kUserChanged:
      case MacosSessionEndReason::kGraphicalSessionEnded:
        return CGEventInputReleaseReason::kUserChange;
      case MacosSessionEndReason::kDisclosureLost:
      case MacosSessionEndReason::kAdapterFailure:
        return CGEventInputReleaseReason::kAgentCrash;
      case MacosSessionEndReason::kLocked:
      case MacosSessionEndReason::kSleeping:
        return CGEventInputReleaseReason::kDisconnect;
      case MacosSessionEndReason::kShutdown:
        return CGEventInputReleaseReason::kShutdown;
    }
    return CGEventInputReleaseReason::kShutdown;
  }

  CGEventInputAdapter& input_;
  NSPasteboardClipboardAdapter& clipboard_;
  common::DisclosureAdapter& disclosure_;
  MacosVirtualDisplayAdapter& virtual_display_;
  MacosDisclosureBeginGeneration begin_disclosure_;
};

class ProductionReadinessGate final : public MacosSessionReadinessGate {
 public:
  ProductionReadinessGate(MacosPermissionReadiness& permissions,
                          SessionCapabilityProfile profile)
      : permissions_(permissions), profile_(profile) {}

  CapabilityReadiness Constrain(CapabilityReadiness observed) override {
    const ReadinessState adapter_capture = observed.capture;
    const ReadinessState adapter_input = observed.input;
    [[maybe_unused]] const MacosPermissionReadinessSnapshot snapshot =
        permissions_.Probe();
    CapabilityReadiness constrained = permissions_.ApplyTo(observed);
    // TCC evidence only constrains an adapter observation. It can never turn
    // an unavailable adapter into an authority-granting Ready state.
    if (adapter_capture != ReadinessState::kReady) {
      constrained.capture = ReadinessState::kUnavailable;
    }
    if (adapter_input != ReadinessState::kReady) {
      constrained.input = ReadinessState::kUnavailable;
    }
    // The session-type profile is applied last and only ever removes. This is
    // what makes readiness reflect the authenticated session rather than an
    // Aqua probe: at the login window NSPasteboard still answers, so the
    // clipboard adapter reports Ready even though there is no logged-in user
    // whose clipboard it could legitimately be. Reported readiness is what
    // PasteText/CopySelection and control admission consult, so removing it
    // here is the enforcement, not a label.
    if (!profile_.capture) constrained.capture = ReadinessState::kUnavailable;
    if (!profile_.clipboard) {
      constrained.clipboard = ReadinessState::kUnavailable;
    }
    if (!profile_.pointer && !profile_.keyboard) {
      constrained.input = ReadinessState::kUnavailable;
    }
    return constrained;
  }

 private:
  MacosPermissionReadiness& permissions_;
  SessionCapabilityProfile profile_;
};

class StopRelay final {
 public:
  explicit StopRelay(MacosDisclosureStopAllRoutes external)
      : external_(std::move(external)) {}

  void Bind(common::WorkerGeneration generation,
            std::function<void()> stop_session) {
    std::lock_guard lock(mutex_);
    generation_ = generation;
    stop_session_ = std::move(stop_session);
  }

  void Fire(common::WorkerGeneration generation) noexcept {
    std::function<void()> stop_session;
    MacosDisclosureStopAllRoutes external;
    {
      std::lock_guard lock(mutex_);
      if (generation == 0 || generation != generation_)
        return;
      stop_session = stop_session_;
      external = external_;
    }
    // AppKit invokes disclosure failure on the main queue. Session cleanup can
    // synchronously marshal Hide back to that queue, so never block the main
    // queue trying to enter a composition operation that may already be
    // waiting for AppKit. Route authority is revoked first; local cleanup is
    // then handed to a system queue through a weak session callback.
    // Pinned WebRTC/Chromium builds this target with -fno-exceptions. These
    // lifecycle callbacks are therefore required to be non-throwing.
    if (external)
      external(generation);
    if (stop_session) {
      auto task =
          std::make_shared<std::function<void()>>(std::move(stop_session));
      dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        (*task)();
      });
    }
  }

 private:
  std::mutex mutex_;
  common::WorkerGeneration generation_ = 0;
  std::function<void()> stop_session_;
  MacosDisclosureStopAllRoutes external_;
};

class OwnedProductionAdapters;

}  // namespace

class MacosRemoteDesktopSession::Impl final
    : public std::enable_shared_from_this<MacosRemoteDesktopSession::Impl>,
      private common::TransportSessionAdapter {
 public:
  Impl(MacosRemoteDesktopSessionDependencies dependencies,
       MacosRemoteDesktopSessionEventSink event_sink,
       std::shared_ptr<void> owned = {})
      : owned_(std::move(owned)),
        dependencies_(dependencies),
        core_(dependencies_.adapters),
        transport_core_(*this, quality_ladder_),
        event_sink_(std::move(event_sink)) {}

  ~Impl() { Stop(); }

  bool Start(const MacosRemoteDesktopStartRequest& request) {
    std::lock_guard lock(mutex_);
    if (core_.state() != SessionState::kIdle || cleaned_ ||
        request.worker_generation == 0 || request.viewers == 0 ||
        request.controllers > request.viewers ||
        request.video.frame_rate == 0 || request.video.bitrate_bps == 0 ||
        !request.authority_now.IsValid() ||
        request.authority_now.unix_ms >
            std::numeric_limits<std::int64_t>::max() -
                common::kTransportMaximumLeaseFutureMs) {
      return false;
    }

    worker_generation_ = request.worker_generation;
    video_ = request.video;
    viewers_ = request.viewers;
    requested_controllers_ = request.controllers;

    if (!dependencies_.lifecycle.BeginGeneration(worker_generation_)) {
      TerminateLocked(Error(TerminalErrorCode::kDisclosureUnavailable,
                            "macOS session generation failed to initialize"),
                      MacosSessionEndReason::kDisclosureLost);
      return false;
    }
    generation_begun_ = true;

    // The local surface is visible before capture/media is admitted. It starts
    // with zero controllers until current Accessibility readiness is known.
    if (!dependencies_.adapters.disclosure.Show(viewers_, 0)) {
      TerminateLocked(Error(TerminalErrorCode::kDisclosureUnavailable,
                            "local remote-desktop disclosure is unavailable"),
                      MacosSessionEndReason::kDisclosureLost);
      return false;
    }

    const std::weak_ptr<Impl> weak = weak_from_this();
    if (!dependencies_.adapters.session_monitor.Start(
            [weak](GraphicalSessionEvent event) {
              if (const auto self = weak.lock())
                self->DispatchLifecycleEvent(event);
            })) {
      TerminateLocked(Error(TerminalErrorCode::kGraphicalSessionEnded,
                            "graphical-session monitoring is unavailable"),
                      MacosSessionEndReason::kGraphicalSessionEnded);
      return false;
    }
    if (core_.state() == SessionState::kTerminal)
      return false;

    CapabilityReadiness observed = ProbeReadinessLocked();
    if (!observed.ViewReady()) {
      TerminateLocked(Error(TerminalErrorCode::kCaptureUnavailable,
                            "macOS view readiness is incomplete"),
                      MacosSessionEndReason::kPermissionLoss);
      return false;
    }

    const auto backend_topology =
        dependencies_.adapters.display.EnumerateTopology();
    if (!backend_topology || !backend_topology->IsValid() ||
        backend_topology->generation != worker_generation_) {
      TerminateLocked(Error(TerminalErrorCode::kCaptureUnavailable,
                            "no valid active-user display topology"),
                      MacosSessionEndReason::kAdapterFailure);
      return false;
    }
    backend_topology_revision_ = backend_topology->revision;
    exposed_topology_ = PublishTopology(*backend_topology);
    selected_display_id_ =
        SelectRequestedDisplay(exposed_topology_, request.preferred_display_id);
    if (selected_display_id_.empty() ||
        !dependencies_.adapters.display.SelectDisplay(selected_display_id_) ||
        !dependencies_.lifecycle.BindInputTopology(exposed_topology_,
                                                   selected_display_id_)) {
      TerminateLocked(Error(TerminalErrorCode::kAdapterFailure,
                            "selected display could not be bound"),
                      MacosSessionEndReason::kAdapterFailure);
      return false;
    }

    const common::TransportSessionMode initial_mode =
        requested_controllers_ > 0 && observed.ControlReady()
            ? common::TransportSessionMode::kControl
            : common::TransportSessionMode::kView;
    common::RouteAuthority authority = request.route_authority.value_or(
        BuildCompatibilityAuthority(request, initial_mode));
    // The daemon authority generation and the local worker process generation
    // are independent fences. IPC authenticates the latter;
    // TransportSessionCore owns the former. Requiring equality makes every real
    // route fail once either lifecycle advances independently.
    if (authority.mode != initial_mode ||
        !transport_core_.Start(std::move(authority), request.authority_now)) {
      if (!cleaned_) {
        TerminateLocked(Error(TerminalErrorCode::kProtocolViolation,
                              "macOS route authority was rejected"),
                        MacosSessionEndReason::kAdapterFailure);
      }
      return false;
    }
    last_transport_time_ = request.authority_now;

    if (!core_.Start(observed, exposed_topology_) || !StartMediaLocked()) {
      TerminateLocked(Error(TerminalErrorCode::kAdapterFailure,
                            "macOS media pipeline failed to start"),
                      MacosSessionEndReason::kAdapterFailure);
      return false;
    }

    EmitLocked(MacosRemoteDesktopSessionEventType::kStartedViewing);
    if (requested_controllers_ > 0 && observed.ControlReady() &&
        (dependencies_.transport == nullptr ||
         transport_core_.control_ready())) {
      if (!SetControlActiveLocked(true, last_transport_time_))
        return false;
    } else if (requested_controllers_ > 0) {
      EmitLocked(MacosRemoteDesktopSessionEventType::kControlDowngraded);
    }
    return core_.state() != SessionState::kTerminal;
  }

  bool RefreshReadiness() {
    std::lock_guard lock(mutex_);
    return RefreshReadinessLocked();
  }

  bool RefreshTopology() {
    std::lock_guard lock(mutex_);
    return RefreshTopologyLocked(false);
  }

  bool SetDisplayMode(std::string_view display_id, common::PixelSize pixels) {
    std::lock_guard lock(mutex_);
    const common::DisplayTopology* display =
        exposed_topology_.FindDisplay(std::string(display_id));
    if (!ActiveLocked() || display == nullptr ||
        !display->operations.set_mode ||
        !dependencies_.adapters.display.SetMode(display_id, pixels)) {
      return false;
    }
    return RefreshTopologyLocked(true);
  }

  bool SetDisplayScale(std::string_view display_id, double scale) {
    std::lock_guard lock(mutex_);
    const common::DisplayTopology* display =
        exposed_topology_.FindDisplay(std::string(display_id));
    if (!ActiveLocked() || display == nullptr ||
        !display->operations.set_scale ||
        !dependencies_.adapters.display.SetScale(display_id, scale)) {
      return false;
    }
    return RefreshTopologyLocked(true);
  }

  bool RefreshTopologyLocked(bool require_revision_advance) {
    if (!ActiveLocked())
      return false;
    const auto backend_topology =
        dependencies_.adapters.display.EnumerateTopology();
    if (!backend_topology || !backend_topology->IsValid() ||
        backend_topology->generation != worker_generation_ ||
        backend_topology->revision < backend_topology_revision_) {
      TerminateLocked(Error(TerminalErrorCode::kCaptureUnavailable,
                            "display topology became invalid or regressed"),
                      MacosSessionEndReason::kAdapterFailure);
      return false;
    }
    if (backend_topology->revision == backend_topology_revision_ &&
        !require_revision_advance) {
      return true;
    }
    if (backend_topology->revision == backend_topology_revision_) {
      TerminateLocked(Error(TerminalErrorCode::kCaptureUnavailable,
                            "display mutation did not advance topology"),
                      MacosSessionEndReason::kAdapterFailure);
      return false;
    }

    backend_topology_revision_ = backend_topology->revision;
    common::DesktopTopology next = PublishTopology(*backend_topology);
    std::string selected = selected_display_id_;
    if (next.FindDisplay(selected) == nullptr) {
      selected = SelectRequestedDisplay(next, {});
    }
    if (selected.empty() ||
        !dependencies_.adapters.display.SelectDisplay(selected) ||
        !core_.UpdateTopology(next) ||
        !dependencies_.lifecycle.BindInputTopology(next, selected)) {
      TerminateLocked(Error(TerminalErrorCode::kAdapterFailure,
                            "updated display topology could not be bound"),
                      MacosSessionEndReason::kAdapterFailure);
      return false;
    }
    exposed_topology_ = std::move(next);
    selected_display_id_ = std::move(selected);
    if (!RestartMediaLocked()) {
      TerminateLocked(Error(TerminalErrorCode::kAdapterFailure,
                            "media restart after topology change failed"),
                      MacosSessionEndReason::kAdapterFailure);
      return false;
    }
    EmitLocked(MacosRemoteDesktopSessionEventType::kTopologyChanged);
    return true;
  }

  bool SelectDisplay(std::string_view display_id) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || display_id.empty() ||
        display_id == selected_display_id_) {
      return display_id == selected_display_id_ && ActiveLocked();
    }
    const common::DisplayTopology* display =
        exposed_topology_.FindDisplay(std::string(display_id));
    if (display == nullptr || !display->operations.selectable ||
        !dependencies_.adapters.display.SelectDisplay(display_id)) {
      return false;
    }

    // Monitor selection changes the logical input mapping even when the
    // backend display set is unchanged. Publish a fresh revision rather than
    // reusing encoded geometry or bypassing CGEvent's stale-topology fence.
    common::DesktopTopology selected_topology = exposed_topology_;
    selected_topology.revision = ++published_topology_revision_;
    if (!core_.UpdateTopology(selected_topology) ||
        !dependencies_.lifecycle.BindInputTopology(selected_topology,
                                                   display_id)) {
      TerminateLocked(Error(TerminalErrorCode::kAdapterFailure,
                            "selected monitor input topology was rejected"),
                      MacosSessionEndReason::kAdapterFailure);
      return false;
    }
    exposed_topology_ = std::move(selected_topology);
    selected_display_id_ = std::string(display_id);
    if (!RestartMediaLocked()) {
      TerminateLocked(Error(TerminalErrorCode::kAdapterFailure,
                            "media restart after monitor selection failed"),
                      MacosSessionEndReason::kAdapterFailure);
      return false;
    }
    EmitLocked(MacosRemoteDesktopSessionEventType::kDisplaySelected);
    EmitLocked(MacosRemoteDesktopSessionEventType::kTopologyChanged);
    return true;
  }

  bool SetControlActive(bool active) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked())
      return false;
    if (active && !RefreshReadinessLocked())
      return false;
    return SetControlActiveLocked(active, last_transport_time_);
  }

  bool SetControlActive(bool active, common::TransportTime now) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked())
      return false;
    if (active && !RefreshReadinessLocked())
      return false;
    return SetControlActiveLocked(active, now);
  }

  bool RenewRouteAuthority(const common::RouteAuthority& authority,
                           common::TransportTime now) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || !transport_core_.RenewLease(authority, now)) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    last_transport_time_ = now;
    return true;
  }

  bool ApplyModeAuthority(const common::RouteAuthority& authority,
                          common::TransportTime now) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked())
      return false;
    const bool control =
        authority.mode == common::TransportSessionMode::kControl;
    if (control &&
        (!RefreshReadinessLocked() || !core_.readiness().ControlReady() ||
         (dependencies_.transport != nullptr &&
          !transport_core_.control_ready()))) {
      return false;
    }
    if (!transport_core_.UpdateMode(authority, now)) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    requested_controllers_ = control ? 1 : 0;
    if (!core_.SetControlActive(control))
      return false;
    if (!dependencies_.adapters.disclosure.Show(viewers_,
                                                requested_controllers_)) {
      TerminateLocked(Error(TerminalErrorCode::kDisclosureUnavailable,
                            "disclosure failed to reflect controller state"),
                      MacosSessionEndReason::kDisclosureLost);
      return false;
    }
    last_transport_time_ = now;
    EmitLocked(control
                   ? MacosRemoteDesktopSessionEventType::kControlEnabled
                   : MacosRemoteDesktopSessionEventType::kControlDowngraded);
    return true;
  }

  bool RecordRouteActivity(const common::RouteAuthorityIdentity& identity,
                           common::TransportTime now) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || !transport_core_.RecordActivity(identity, now)) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    last_transport_time_ = now;
    return true;
  }

  bool TickTransport(common::TransportTime now) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || !transport_core_.Tick(now)) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    last_transport_time_ = now;
    return true;
  }

  void ReportTransportFailure() noexcept {
    std::lock_guard lock(mutex_);
    transport_core_.Stop(common::TransportTerminalReason::kAdapterFailure);
    FinalizeIfTransportTerminatedLocked();
  }

  bool AddRemoteIceCandidate(const common::RouteAuthorityIdentity& identity,
                             common::IceCandidate candidate) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || dependencies_.transport == nullptr ||
        !transport_core_.AddRemoteIceCandidate(identity,
                                               std::move(candidate))) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    return true;
  }

  bool NegotiateOffer(std::string_view offer_sdp, std::string* answer_sdp) {
    if (answer_sdp == nullptr)
      return false;

    MacosRemoteDesktopOfferNegotiator negotiator;
    common::TransportCallbackStamp stamp;
    {
      std::lock_guard lock(mutex_);
      const common::RouteAuthority* authority = transport_core_.authority();
      if (!ActiveLocked() || dependencies_.transport == nullptr ||
          !dependencies_.negotiate_offer || authority == nullptr) {
        return false;
      }
      stamp.daemon_generation = authority->identity.daemon_generation;
      stamp.route_generation = authority->identity.route_generation;
      negotiator = dependencies_.negotiate_offer;
    }

    // Do not hold the session lock while libwebrtc runs the bounded signaling
    // chain. SetLocalDescription may synchronously produce ICE callbacks that
    // must be able to re-enter OnLocalIceCandidate and queue candidates.
    std::string produced;
    if (!negotiator(offer_sdp, &produced))
      return false;

    std::lock_guard lock(mutex_);
    const common::RouteAuthority* authority = transport_core_.authority();
    if (!ActiveLocked() || authority == nullptr ||
        authority->identity.daemon_generation != stamp.daemon_generation ||
        authority->identity.route_generation != stamp.route_generation ||
        !transport_core_.SetRemoteDescriptionReady(stamp) ||
        !transport_core_.SetLocalIceEmissionReady(stamp)) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    *answer_sdp = std::move(produced);
    return true;
  }

  bool SetRemoteDescriptionReady(const common::TransportCallbackStamp& stamp) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || dependencies_.transport == nullptr ||
        !transport_core_.SetRemoteDescriptionReady(stamp)) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    return true;
  }

  bool OnLocalIceCandidate(const common::TransportCallbackStamp& stamp,
                           common::IceCandidate candidate) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || dependencies_.transport == nullptr ||
        !transport_core_.OnLocalIceCandidate(stamp, std::move(candidate))) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    return true;
  }

  bool SetLocalIceEmissionReady(const common::TransportCallbackStamp& stamp) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || dependencies_.transport == nullptr ||
        !transport_core_.SetLocalIceEmissionReady(stamp)) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    return true;
  }

  bool OnPeerConnectionState(const common::TransportCallbackStamp& stamp,
                             common::PeerConnectionState state,
                             common::TransportTime now) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || dependencies_.transport == nullptr ||
        !transport_core_.OnPeerConnectionState(stamp, state, now)) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    last_transport_time_ = now;
    return true;
  }

  bool OnDataChannelState(const common::TransportCallbackStamp& stamp,
                          common::DataChannelKind channel,
                          common::DataChannelState state) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || dependencies_.transport == nullptr ||
        !transport_core_.OnDataChannelState(stamp, channel, state)) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    // A Control route starts View-only until the browser-created channels are
    // all open. Promote through the same SessionCore/disclosure path only at
    // that boundary; otherwise the signaling status can claim input before a
    // payload has any authenticated path to the input ledger.
    if (state == common::DataChannelState::kOpen &&
        requested_controllers_ > 0 && transport_core_.control_ready() &&
        core_.state() == SessionState::kViewing &&
        !SetControlActiveLocked(true, last_transport_time_)) {
      return false;
    }
    return true;
  }

  bool OnTransportPath(const common::TransportCallbackStamp& stamp,
                       common::TransportPath path) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || dependencies_.transport == nullptr ||
        !transport_core_.OnTransportPath(stamp, path)) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    return true;
  }

  bool UpdateTransportQuality(const common::TransportCallbackStamp& stamp,
                              const common::QualityTarget& target) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || dependencies_.transport == nullptr ||
        !transport_core_.UpdateQualityTarget(stamp, target)) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    return true;
  }

  bool RecordTransportMediaProgress(const common::TransportCallbackStamp& stamp,
                                    std::uint64_t source_frames,
                                    std::uint64_t outbound_video_bytes,
                                    common::TransportTime now) {
    std::lock_guard lock(mutex_);
    if (!ActiveLocked() || dependencies_.transport == nullptr ||
        !transport_core_.RecordMediaProgress(stamp, source_frames,
                                             outbound_video_bytes, now)) {
      FinalizeIfTransportTerminatedLocked();
      return false;
    }
    last_transport_time_ = now;
    return true;
  }

  common::InputResult ApplyPointerMove(const common::PointerMove& move) {
    std::lock_guard lock(mutex_);
    const common::InputResult result = core_.ApplyPointerMove(move);
    FinalizeIfCoreTerminatedLocked(MacosSessionEndReason::kAdapterFailure);
    return result;
  }

  common::InputResult ApplyKey(const common::KeyTransition& transition) {
    std::lock_guard lock(mutex_);
    const common::InputResult result = core_.ApplyKey(transition);
    FinalizeIfCoreTerminatedLocked(MacosSessionEndReason::kAdapterFailure);
    return result;
  }

  common::InputResult ApplyButton(const common::ButtonTransition& transition) {
    std::lock_guard lock(mutex_);
    const common::InputResult result = core_.ApplyButton(transition);
    FinalizeIfCoreTerminatedLocked(MacosSessionEndReason::kAdapterFailure);
    return result;
  }

  common::InputResult ClickButton(const common::ButtonTransition& transition) {
    std::lock_guard lock(mutex_);
    const common::InputResult result = core_.ClickButton(transition);
    FinalizeIfCoreTerminatedLocked(MacosSessionEndReason::kAdapterFailure);
    return result;
  }

  common::InputResult ApplyWheel(const common::WheelInput& input) {
    std::lock_guard lock(mutex_);
    const common::InputResult result = core_.ApplyWheel(input);
    FinalizeIfCoreTerminatedLocked(MacosSessionEndReason::kAdapterFailure);
    return result;
  }

  common::InputResult ApplyText(const common::TextInput& input) {
    std::lock_guard lock(mutex_);
    const common::InputResult result = core_.ApplyText(input);
    FinalizeIfCoreTerminatedLocked(MacosSessionEndReason::kAdapterFailure);
    return result;
  }

  void ReleaseController(std::string_view controller_id) noexcept {
    std::lock_guard lock(mutex_);
    core_.ReleaseController(controller_id);
    FinalizeIfCoreTerminatedLocked(MacosSessionEndReason::kAdapterFailure);
  }

  bool ReleaseAllControllers() noexcept {
    std::lock_guard lock(mutex_);
    // SetControlActive(false) is the public seam that calls
    // SessionCore::ReleaseAllControllers() and moves the session to kViewing.
    const bool released = core_.SetControlActive(false);
    FinalizeIfCoreTerminatedLocked(MacosSessionEndReason::kAdapterFailure);
    return released;
  }

  bool PasteText(std::string_view text) {
    {
      std::lock_guard lock(mutex_);
      if (core_.state() != SessionState::kControlling ||
          core_.readiness().clipboard != ReadinessState::kReady) {
        return false;
      }
    }
    // NSPasteboard operations may wait for a local clipboard change. Do not
    // hold the session mutex while waiting: a lock/user transition must be
    // able to end the generation and invalidate the operation immediately.
    return dependencies_.adapters.clipboard.PasteText(text);
  }

  bool CopySelection(std::string* text) {
    if (text == nullptr) {
      return false;
    }
    {
      std::lock_guard lock(mutex_);
      if (core_.state() != SessionState::kControlling ||
          core_.readiness().clipboard != ReadinessState::kReady) {
        return false;
      }
    }
    // See PasteText(): lifecycle cleanup must be able to cancel this bounded
    // operation through StopSession() while it is in flight.
    return dependencies_.adapters.clipboard.CopySelection(text);
  }

  void Stop() noexcept {
    std::lock_guard lock(mutex_);
    TerminateLocked(Error(TerminalErrorCode::kStopped, "session stopped"),
                    MacosSessionEndReason::kShutdown);
  }

  void HandleDisclosureFailure() noexcept {
    std::unique_lock lock(mutex_, std::try_to_lock);
    if (lock.owns_lock()) {
      TerminateLocked(Error(TerminalErrorCode::kDisclosureUnavailable,
                            "local disclosure stopped or failed"),
                      MacosSessionEndReason::kDisclosureLost);
      return;
    }
    DispatchAsync([weak = weak_from_this()]() {
      if (const auto self = weak.lock()) {
        std::lock_guard blocking_lock(self->mutex_);
        self->TerminateLocked(Error(TerminalErrorCode::kDisclosureUnavailable,
                                    "local disclosure stopped or failed"),
                              MacosSessionEndReason::kDisclosureLost);
      }
    });
  }

  SessionState state() const noexcept {
    std::lock_guard lock(mutex_);
    return core_.state();
  }

  CapabilityReadiness readiness() const noexcept {
    std::lock_guard lock(mutex_);
    return core_.readiness();
  }

  std::optional<common::DesktopTopology> topology() const {
    std::lock_guard lock(mutex_);
    if (!exposed_topology_.IsValid())
      return std::nullopt;
    return exposed_topology_;
  }

  std::string selected_display_id() const {
    std::lock_guard lock(mutex_);
    return selected_display_id_;
  }

  TerminalError terminal_error() const {
    std::lock_guard lock(mutex_);
    return core_.terminal_error();
  }

  common::TransportDiagnostics transport_diagnostics() const {
    std::lock_guard lock(mutex_);
    return transport_core_.diagnostics();
  }

  common::TransportTerminalReason transport_terminal_reason() const noexcept {
    std::lock_guard lock(mutex_);
    return transport_core_.terminal_reason();
  }

  bool has_transport_adapter() const noexcept {
    return dependencies_.transport != nullptr;
  }

 private:
  static common::RouteAuthority BuildCompatibilityAuthority(
      const MacosRemoteDesktopStartRequest& request,
      common::TransportSessionMode mode) {
    const std::string generation = std::to_string(request.worker_generation);
    return common::RouteAuthority{
        .identity = {.request_id = "macos-local-request-" + generation,
                     .session_id = "macos-local-session-" + generation,
                     .negotiated_capability_binding =
                         "macos-local-composition-v1",
                     .daemon_generation = request.worker_generation,
                     .route_generation = request.worker_generation},
        .expires_at_unix_ms = request.authority_now.unix_ms +
                              common::kTransportMaximumLeaseFutureMs,
        .lease_expires_at_unix_ms = request.authority_now.unix_ms +
                                    common::kTransportMaximumLeaseFutureMs,
        .mode = mode,
        .input_epoch = mode == common::TransportSessionMode::kControl
                           ? std::uint64_t{1}
                           : std::uint64_t{0},
    };
  }

  CapabilityReadiness ProbeReadinessLocked() {
    CapabilityReadiness observed;
    observed.capture = dependencies_.adapters.capture.ProbeReadiness();
    observed.encoder = dependencies_.adapters.encoder.ProbeReadiness();
    observed.input = dependencies_.adapters.input.ProbeReadiness();
    observed.clipboard = dependencies_.adapters.clipboard.ProbeReadiness();
    observed.display = dependencies_.adapters.display.ProbeReadiness();
    observed.disclosure = dependencies_.adapters.disclosure.ProbeReadiness();
    observed.graphical_session =
        dependencies_.adapters.session_monitor.ProbeReadiness();
    if (observed.display != ReadinessState::kReady) {
      observed.capture = ReadinessState::kUnavailable;
    }
    CapabilityReadiness constrained =
        dependencies_.readiness_gate.Constrain(observed);
    // A caller-supplied gate is also remove-only.
    if (observed.capture != ReadinessState::kReady)
      constrained.capture = ReadinessState::kUnavailable;
    if (observed.encoder != ReadinessState::kReady)
      constrained.encoder = ReadinessState::kUnavailable;
    if (observed.input != ReadinessState::kReady)
      constrained.input = ReadinessState::kUnavailable;
    if (observed.clipboard != ReadinessState::kReady)
      constrained.clipboard = ReadinessState::kUnavailable;
    if (observed.display != ReadinessState::kReady)
      constrained.display = ReadinessState::kUnavailable;
    if (observed.disclosure != ReadinessState::kReady)
      constrained.disclosure = ReadinessState::kUnavailable;
    if (observed.graphical_session != ReadinessState::kReady)
      constrained.graphical_session = ReadinessState::kUnavailable;
    return constrained;
  }

  bool RefreshReadinessLocked() {
    if (!ActiveLocked())
      return false;
    const SessionState previous_state = core_.state();
    CapabilityReadiness next = ProbeReadinessLocked();
    if (next.input == ReadinessState::kReady &&
        core_.readiness().input != ReadinessState::kReady &&
        !dependencies_.lifecycle.BindInputTopology(exposed_topology_,
                                                   selected_display_id_)) {
      next.input = ReadinessState::kUnavailable;
    }
    if (!core_.UpdateReadiness(next)) {
      FinalizeIfCoreTerminatedLocked(MacosSessionEndReason::kPermissionLoss);
      return false;
    }
    if (previous_state == SessionState::kControlling &&
        core_.state() == SessionState::kViewing) {
      return SetControlActiveLocked(false, last_transport_time_);
    }
    return true;
  }

  bool SetControlActiveLocked(bool active, common::TransportTime now) {
    if (active && requested_controllers_ == 0)
      return false;
    if (active && dependencies_.transport != nullptr &&
        !transport_core_.control_ready()) {
      return false;
    }
    const common::RouteAuthority* current = transport_core_.authority();
    if (current == nullptr)
      return false;
    const common::TransportSessionMode next_mode =
        active ? common::TransportSessionMode::kControl
               : common::TransportSessionMode::kView;
    if (current->mode != next_mode) {
      if (current->input_epoch == std::numeric_limits<std::uint64_t>::max()) {
        TerminateLocked(Error(TerminalErrorCode::kProtocolViolation,
                              "macOS input authority epoch overflowed"),
                        MacosSessionEndReason::kAdapterFailure);
        return false;
      }
      common::RouteAuthority update = *current;
      update.mode = next_mode;
      ++update.input_epoch;
      if (!transport_core_.UpdateMode(update, now)) {
        FinalizeIfTransportTerminatedLocked();
        return false;
      }
      last_transport_time_ = now;
    }
    if ((active || core_.state() != SessionState::kViewing) &&
        !core_.SetControlActive(active)) {
      return false;
    }
    const std::uint32_t controllers = active ? requested_controllers_ : 0;
    if (!dependencies_.adapters.disclosure.Show(viewers_, controllers)) {
      TerminateLocked(Error(TerminalErrorCode::kDisclosureUnavailable,
                            "disclosure failed to reflect controller state"),
                      MacosSessionEndReason::kDisclosureLost);
      return false;
    }
    EmitLocked(active ? MacosRemoteDesktopSessionEventType::kControlEnabled
                      : MacosRemoteDesktopSessionEventType::kControlDowngraded);
    return true;
  }

  common::DesktopTopology PublishTopology(
      const common::DesktopTopology& backend_topology) {
    common::DesktopTopology published = backend_topology;
    published.revision = ++published_topology_revision_;
    return published;
  }

  static std::string SelectRequestedDisplay(
      const common::DesktopTopology& topology,
      std::string_view preferred_display_id) {
    if (!preferred_display_id.empty() &&
        topology.FindDisplay(std::string(preferred_display_id)) != nullptr) {
      return std::string(preferred_display_id);
    }
    return topology.displays.empty() ? std::string{}
                                     : topology.displays.front().display_id;
  }

  bool StartMediaLocked() {
    const common::DisplayTopology* display =
        exposed_topology_.FindDisplay(selected_display_id_);
    if (display == nullptr)
      return false;
    const std::uint64_t epoch = ++media_epoch_;
    if (!dependencies_.media_sender.Start(
            worker_generation_, display->encoded_pixels, video_.profile)) {
      return false;
    }
    common::EncoderConfiguration encoder_configuration{
        .encoded_pixels = display->encoded_pixels,
        .frame_rate = video_.frame_rate,
        .bitrate_bps = video_.bitrate_bps,
        .profile = video_.profile,
    };
    const std::weak_ptr<Impl> weak = weak_from_this();
    if (!dependencies_.adapters.encoder.Configure(
            encoder_configuration,
            [weak, epoch](common::H264AccessUnit access_unit) {
              if (const auto self = weak.lock())
                self->OnAccessUnit(epoch, std::move(access_unit));
            })) {
      dependencies_.media_sender.Stop();
      return false;
    }
    if (!dependencies_.adapters.capture.Start(
            *display, [weak, epoch](common::CapturedFrame frame) {
              if (const auto self = weak.lock())
                self->OnCapturedFrame(epoch, std::move(frame));
            })) {
      dependencies_.adapters.encoder.Stop();
      dependencies_.media_sender.Stop();
      return false;
    }
    media_started_ = true;
    return true;
  }

  bool RestartMediaLocked() {
    StopMediaLocked();
    return StartMediaLocked();
  }

  void StopMediaLocked() noexcept {
    ++media_epoch_;
    dependencies_.adapters.capture.Stop();
    dependencies_.adapters.encoder.Stop();
    dependencies_.media_sender.Stop();
    media_started_ = false;
  }

  void OnCapturedFrame(std::uint64_t epoch, common::CapturedFrame frame) {
    // Stop() can wait for an Apple callback queue. Never let a late media
    // callback wait on the composition mutex while terminal cleanup waits for
    // that same queue; a busy composition simply drops the bounded frame.
    std::unique_lock lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock() || !ActiveLocked() || epoch != media_epoch_ ||
        !media_started_) {
      return;
    }
    const common::DisplayTopology* display =
        exposed_topology_.FindDisplay(selected_display_id_);
    if (display == nullptr || !frame.IsValid() ||
        frame.encoded_pixels.width != display->encoded_pixels.width ||
        frame.encoded_pixels.height != display->encoded_pixels.height ||
        !dependencies_.adapters.encoder.Encode(std::move(frame), false)) {
      TerminateLocked(Error(TerminalErrorCode::kEncoderUnavailable,
                            "captured frame could not be encoded"),
                      MacosSessionEndReason::kAdapterFailure);
    }
  }

  void OnAccessUnit(std::uint64_t epoch, common::H264AccessUnit access_unit) {
    std::unique_lock lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock() || !ActiveLocked() || epoch != media_epoch_ ||
        !media_started_) {
      return;
    }
    if (!access_unit.IsValid() ||
        !dependencies_.media_sender.Submit(worker_generation_,
                                           std::move(access_unit))) {
      TerminateLocked(Error(TerminalErrorCode::kEncoderUnavailable,
                            "encoded frame sender rejected access unit"),
                      MacosSessionEndReason::kAdapterFailure);
    }
  }

  void DispatchLifecycleEvent(GraphicalSessionEvent event) {
    std::unique_lock lock(mutex_, std::try_to_lock);
    if (lock.owns_lock()) {
      OnLifecycleEventLocked(event);
      return;
    }
    DispatchAsync([weak = weak_from_this(), event]() {
      if (const auto self = weak.lock()) {
        std::lock_guard blocking_lock(self->mutex_);
        self->OnLifecycleEventLocked(event);
      }
    });
  }

  void OnLifecycleEventLocked(GraphicalSessionEvent event) {
    if (cleaned_)
      return;
    EmitLocked(MacosRemoteDesktopSessionEventType::kLifecycleBoundary, event);
    switch (event) {
      case GraphicalSessionEvent::kLocked:
        TerminateLocked(Error(TerminalErrorCode::kGraphicalSessionEnded,
                              "graphical session locked"),
                        MacosSessionEndReason::kLocked);
        break;
      case GraphicalSessionEvent::kUserChanged:
        TerminateLocked(Error(TerminalErrorCode::kGraphicalSessionEnded,
                              "active graphical user changed"),
                        MacosSessionEndReason::kUserChanged);
        break;
      case GraphicalSessionEvent::kSleeping:
        TerminateLocked(Error(TerminalErrorCode::kGraphicalSessionEnded,
                              "graphical session is sleeping"),
                        MacosSessionEndReason::kSleeping);
        break;
      case GraphicalSessionEvent::kEnded:
        TerminateLocked(Error(TerminalErrorCode::kGraphicalSessionEnded,
                              "graphical session ended"),
                        MacosSessionEndReason::kGraphicalSessionEnded);
        break;
      case GraphicalSessionEvent::kReady:
      case GraphicalSessionEvent::kUnlocked:
      case GraphicalSessionEvent::kWoke:
        // A terminal authority generation is never revived by a later event.
        break;
    }
  }

  static void DispatchAsync(std::function<void()> callback) {
    auto task = std::make_shared<std::function<void()>>(std::move(callback));
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      (*task)();
    });
  }

  bool StartTransport(const common::RouteAuthority& authority) override {
    if (dependencies_.transport == nullptr) {
      // Compatibility mode owns route lifetime and cleanup only. The encoded
      // sender remains the sole existing media seam; no PeerConnection or
      // DataChannel is fabricated here.
      return authority.identity.daemon_generation == worker_generation_;
    }
    return dependencies_.transport->StartTransport(authority);
  }

  bool AddRemoteIceCandidate(const common::IceCandidate& candidate) override {
    if (dependencies_.transport == nullptr)
      return false;
    return dependencies_.transport->AddRemoteIceCandidate(candidate);
  }

  bool EmitLocalIceCandidate(const common::IceCandidate& candidate) override {
    if (dependencies_.transport == nullptr)
      return false;
    return dependencies_.transport->EmitLocalIceCandidate(candidate);
  }

  bool ApplyQuality(const common::QualitySelection& selection) override {
    if (dependencies_.transport == nullptr ||
        (dependencies_.apply_quality &&
         !dependencies_.apply_quality(selection)))
      return false;
    return dependencies_.transport->ApplyQuality(selection);
  }

  void ReleaseControlAuthority(const common::RouteAuthorityIdentity& identity,
                               std::uint64_t input_epoch) noexcept override {
    // The common transport core owns the ordering: input authority is revoked
    // before channels and transport. SessionCore remains the physical-input
    // ledger owner, so this call releases CGEvent state idempotently before
    // channel closure. SessionCore's terminal safety release may repeat it.
    if (core_.state() == SessionState::kControlling) {
      core_.SetControlActive(false);
    }
    if (dependencies_.transport != nullptr) {
      dependencies_.transport->ReleaseControlAuthority(identity, input_epoch);
    }
  }

  void CloseDataChannel(common::DataChannelKind channel) noexcept override {
    if (dependencies_.transport != nullptr) {
      dependencies_.transport->CloseDataChannel(channel);
    }
  }

  void CloseTransport() noexcept override {
    if (dependencies_.transport != nullptr) {
      dependencies_.transport->CloseTransport();
    }
  }

  void PublishDiagnostics(
      const common::TransportDiagnostics& diagnostics) noexcept override {
    if (dependencies_.transport != nullptr) {
      dependencies_.transport->PublishDiagnostics(diagnostics);
    }
  }

  void OnTerminal(common::TransportTerminalReason reason) noexcept override {
    if (dependencies_.transport != nullptr) {
      dependencies_.transport->OnTerminal(reason);
    }
    if (terminating_locally_ || cleaned_)
      return;
    TerminateLocked(TransportError(reason),
                    reason == common::TransportTerminalReason::kStopped
                        ? MacosSessionEndReason::kShutdown
                        : MacosSessionEndReason::kAdapterFailure);
  }

  bool ActiveLocked() const noexcept {
    return core_.state() == SessionState::kViewing ||
           core_.state() == SessionState::kControlling;
  }

  void FinalizeIfCoreTerminatedLocked(MacosSessionEndReason reason) noexcept {
    if (core_.state() == SessionState::kTerminal) {
      terminating_locally_ = true;
      transport_core_.Stop(common::TransportTerminalReason::kAdapterFailure);
      terminating_locally_ = false;
      FinalizeTerminalLocked(reason);
    }
  }

  void FinalizeIfTransportTerminatedLocked() noexcept {
    if (transport_core_.terminal() && !cleaned_) {
      TerminateLocked(TransportError(transport_core_.terminal_reason()),
                      transport_core_.terminal_reason() ==
                              common::TransportTerminalReason::kStopped
                          ? MacosSessionEndReason::kShutdown
                          : MacosSessionEndReason::kAdapterFailure);
    }
  }

  void TerminateLocked(TerminalError error,
                       MacosSessionEndReason reason) noexcept {
    if (cleaned_)
      return;
    terminating_locally_ = true;
    transport_core_.Stop(
        reason == MacosSessionEndReason::kShutdown
            ? common::TransportTerminalReason::kStopped
            : common::TransportTerminalReason::kAdapterFailure);
    terminating_locally_ = false;
    core_.Stop(std::move(error));
    FinalizeTerminalLocked(reason);
  }

  void FinalizeTerminalLocked(MacosSessionEndReason reason) noexcept {
    if (cleaned_)
      return;
    cleaned_ = true;
    ++media_epoch_;
    dependencies_.media_sender.Stop();
    media_started_ = false;
    if (generation_begun_) {
      dependencies_.lifecycle.EndGeneration(reason);
      generation_begun_ = false;
    }
    EmitLocked(MacosRemoteDesktopSessionEventType::kTerminal,
               GraphicalSessionEvent::kEnded, core_.terminal_error());
  }

  void EmitLocked(
      MacosRemoteDesktopSessionEventType type,
      GraphicalSessionEvent lifecycle = GraphicalSessionEvent::kReady,
      TerminalError error = {}) noexcept {
    if (!event_sink_)
      return;
    MacosRemoteDesktopSessionEvent event{
        .type = type,
        .lifecycle_event = lifecycle,
        .topology_revision = exposed_topology_.revision,
        .display_id = selected_display_id_,
        .terminal_error = std::move(error),
    };
    // Observability callbacks never own session authority or cleanup and must
    // not throw across the pinned -fno-exceptions boundary.
    event_sink_(event);
  }

  // Owned adapters precede SessionCore so the core is destroyed first.
  std::shared_ptr<void> owned_;
  MacosRemoteDesktopSessionDependencies dependencies_;
  common::SessionCore core_;
  MacosSessionQualityLadder quality_ladder_;
  common::TransportSessionCore transport_core_;
  MacosRemoteDesktopSessionEventSink event_sink_;
  mutable std::recursive_mutex mutex_;
  common::WorkerGeneration worker_generation_ = 0;
  common::TopologyRevision backend_topology_revision_ = 0;
  common::TopologyRevision published_topology_revision_ = 0;
  common::DesktopTopology exposed_topology_;
  std::string selected_display_id_;
  MacosRemoteDesktopVideoConfiguration video_;
  std::uint32_t viewers_ = 0;
  std::uint32_t requested_controllers_ = 0;
  std::uint64_t media_epoch_ = 0;
  common::TransportTime last_transport_time_;
  bool generation_begun_ = false;
  bool media_started_ = false;
  bool terminating_locally_ = false;
  bool cleaned_ = false;
};

namespace {

class OwnedProductionAdapters final {
 public:
  OwnedProductionAdapters(
      MacosRemoteDesktopProductionConfiguration configuration,
      std::shared_ptr<StopRelay> stop_relay)
      : capture_(configuration.worker_generation,
                 configuration.capture_backend != nullptr
                     ? std::move(configuration.capture_backend)
                     : CreateAppleScreenCaptureKitBackend(),
                 configuration.capture_limits),
        // The production chain must NOT construct the Apple backend directly.
        // That backend owns a CGVirtualDisplay in THIS process, and this
        // process is not the display's lifetime — a worker crash would strand
        // the display, and release-to-remove was measured not to remove on
        // macOS 26.x. Display ownership belongs to the resident signed helper,
        // so production injects a helper-backed backend and a null injection is
        // a refusal rather than a silent fallback to the in-process path.
        virtual_display_(
            capture_, std::move(configuration.virtual_display_backend),
            {.worker_generation = configuration.worker_generation,
             .serial_number = MacosVirtualDisplaySerialForGeneration(
                 configuration.worker_generation)},
            [this] {
              return capture_.LastError().code ==
                     CaptureErrorCode::kNoPresentableDisplay;
            }),
        encoder_(configuration.encoder_policy, configuration.encoder_limits),
        input_(configuration.worker_generation),
        clipboard_(configuration.request_copy
                       ? std::move(configuration.request_copy)
                       : [this](std::uint64_t deadline) {
                           return input_.EmitClipboardShortcut("KeyC", deadline);
                         },
                   configuration.request_paste
                       ? std::move(configuration.request_paste)
                       : [this](std::uint64_t deadline) {
                           return input_.EmitClipboardShortcut("KeyV", deadline);
                         },
                   configuration.clipboard_options),
        local_disclosure_(
            [stop_relay](std::uint64_t generation) {
              stop_relay->Fire(generation);
            },
            configuration.disclosure_options),
        disclosure_(
            configuration.disclosure != nullptr
                ? *configuration.disclosure
                : static_cast<common::DisclosureAdapter&>(local_disclosure_)),
        permissions_(configuration.worker_generation),
        sender_(std::move(configuration.pinned_libwebrtc_sender_backend)),
        lifecycle_(
            input_,
            clipboard_,
            disclosure_,
            virtual_display_,
            configuration.begin_disclosure
                ? std::move(configuration.begin_disclosure)
                : (configuration.disclosure == nullptr
                       ? MacosDisclosureBeginGeneration(
                             [this](common::WorkerGeneration generation) {
                               return local_disclosure_.BeginSession(
                                   generation);
                             })
                       : MacosDisclosureBeginGeneration{})),
        readiness_(permissions_,
                   CapabilityProfileFor(configuration.session_type)),
        transport_(configuration.transport),
        negotiate_offer_(std::move(configuration.negotiate_offer)) {}

  MacosRemoteDesktopSessionDependencies Dependencies() {
    return {
        .adapters = {capture_, encoder_, input_, clipboard_, virtual_display_,
                     disclosure_, monitor_},
        .media_sender = sender_,
        .lifecycle = lifecycle_,
        .readiness_gate = readiness_,
        .transport = transport_,
        .negotiate_offer = negotiate_offer_,
        .apply_quality =
            [this](const common::QualitySelection& selection) {
              return encoder_.ReconfigureFromQualitySelection(
                  imcodes::rd::QualitySelection{
                      selection.preset_id.c_str(),
                      static_cast<int>(selection.encoded_pixels.width),
                      static_cast<int>(selection.encoded_pixels.height),
                      static_cast<int>(selection.frame_rate),
                      selection.bitrate_bps,
                  });
            },
    };
  }

 private:
  ScreenCaptureKitAdapter capture_;
  MacosVirtualDisplayAdapter virtual_display_;
  VideoToolboxH264Encoder encoder_;
  CGEventInputAdapter input_;
  NSPasteboardClipboardAdapter clipboard_;
  MacosLocalDisclosureAdapter local_disclosure_;
  common::DisclosureAdapter& disclosure_;
  MacosSessionMonitor monitor_;
  MacosPermissionReadiness permissions_;
  H264BridgeMediaSender sender_;
  ProductionLifecycle lifecycle_;
  ProductionReadinessGate readiness_;
  common::TransportSessionAdapter* transport_ = nullptr;
  MacosRemoteDesktopOfferNegotiator negotiate_offer_;
};

}  // namespace

MacosRemoteDesktopSession::MacosRemoteDesktopSession(
    MacosRemoteDesktopSessionDependencies dependencies,
    MacosRemoteDesktopSessionEventSink event_sink)
    : impl_(std::make_shared<Impl>(dependencies, std::move(event_sink))) {}

MacosRemoteDesktopSession::MacosRemoteDesktopSession(std::shared_ptr<Impl> impl)
    : impl_(std::move(impl)) {}

MacosRemoteDesktopSession::~MacosRemoteDesktopSession() {
  if (impl_)
    impl_->Stop();
}

std::unique_ptr<MacosRemoteDesktopSession>
MacosRemoteDesktopSession::CreateWithPinnedLibwebrtcSender(
    MacosRemoteDesktopProductionConfiguration configuration,
    MacosRemoteDesktopSessionEventSink event_sink) {
  if (configuration.worker_generation == 0 ||
      !configuration.pinned_libwebrtc_sender_backend) {
    return nullptr;
  }
  // An unrecognized session type has an all-false profile, so it could never
  // capture; refusing here says so at composition instead of producing a
  // session that can do nothing.
  if (configuration.session_type != kSessionTypeAqua &&
      configuration.session_type != kSessionTypeLoginWindow) {
    return nullptr;
  }
  // A LoginWindow session must arrive with the backend its running release
  // needs already chosen. Composing one without it would silently construct the
  // ordinary Aqua ScreenCaptureKit backend -- which below 14.4 cannot see the
  // login window at all, and above it would still mean the version decision was
  // never made. Refusing is the only answer that cannot become a fake success.
  if (configuration.session_type == kSessionTypeLoginWindow &&
      configuration.capture_backend == nullptr) {
    return nullptr;
  }
  const common::WorkerGeneration generation = configuration.worker_generation;
  auto stop_relay =
      std::make_shared<StopRelay>(std::move(configuration.stop_all_routes));
  auto owned = std::make_shared<OwnedProductionAdapters>(
      std::move(configuration), stop_relay);
  const MacosRemoteDesktopSessionDependencies dependencies =
      owned->Dependencies();
  auto impl =
      std::make_shared<Impl>(dependencies, std::move(event_sink), owned);
  const std::weak_ptr<Impl> weak = impl;
  stop_relay->Bind(generation, [weak]() {
    if (const auto self = weak.lock())
      self->HandleDisclosureFailure();
  });
  return std::unique_ptr<MacosRemoteDesktopSession>(
      new MacosRemoteDesktopSession(std::move(impl)));
}

bool MacosRemoteDesktopSession::Start(
    const MacosRemoteDesktopStartRequest& request) {
  return impl_->Start(request);
}

bool MacosRemoteDesktopSession::RefreshReadiness() {
  return impl_->RefreshReadiness();
}

bool MacosRemoteDesktopSession::RefreshTopology() {
  return impl_->RefreshTopology();
}

bool MacosRemoteDesktopSession::SelectDisplay(std::string_view display_id) {
  return impl_->SelectDisplay(display_id);
}

bool MacosRemoteDesktopSession::SetDisplayMode(
    std::string_view display_id, common::PixelSize pixels) {
  return impl_->SetDisplayMode(display_id, pixels);
}

bool MacosRemoteDesktopSession::SetDisplayScale(std::string_view display_id,
                                                double scale) {
  return impl_->SetDisplayScale(display_id, scale);
}

bool MacosRemoteDesktopSession::SetControlActive(bool active) {
  return impl_->SetControlActive(active);
}

bool MacosRemoteDesktopSession::SetControlActive(bool active,
                                                 common::TransportTime now) {
  return impl_->SetControlActive(active, now);
}

bool MacosRemoteDesktopSession::RenewRouteAuthority(
    const common::RouteAuthority& authority,
    common::TransportTime now) {
  return impl_->RenewRouteAuthority(authority, now);
}

bool MacosRemoteDesktopSession::ApplyModeAuthority(
    const common::RouteAuthority& authority,
    common::TransportTime now) {
  return impl_->ApplyModeAuthority(authority, now);
}

bool MacosRemoteDesktopSession::RecordRouteActivity(
    const common::RouteAuthorityIdentity& identity,
    common::TransportTime now) {
  return impl_->RecordRouteActivity(identity, now);
}

bool MacosRemoteDesktopSession::TickTransport(common::TransportTime now) {
  return impl_->TickTransport(now);
}

void MacosRemoteDesktopSession::ReportTransportFailure() noexcept {
  impl_->ReportTransportFailure();
}

bool MacosRemoteDesktopSession::AddRemoteIceCandidate(
    const common::RouteAuthorityIdentity& identity,
    common::IceCandidate candidate) {
  return impl_->AddRemoteIceCandidate(identity, std::move(candidate));
}

bool MacosRemoteDesktopSession::NegotiateOffer(std::string_view offer_sdp,
                                               std::string* answer_sdp) {
  return impl_->NegotiateOffer(offer_sdp, answer_sdp);
}

bool MacosRemoteDesktopSession::SetRemoteDescriptionReady(
    const common::TransportCallbackStamp& stamp) {
  return impl_->SetRemoteDescriptionReady(stamp);
}

bool MacosRemoteDesktopSession::OnLocalIceCandidate(
    const common::TransportCallbackStamp& stamp,
    common::IceCandidate candidate) {
  return impl_->OnLocalIceCandidate(stamp, std::move(candidate));
}

bool MacosRemoteDesktopSession::SetLocalIceEmissionReady(
    const common::TransportCallbackStamp& stamp) {
  return impl_->SetLocalIceEmissionReady(stamp);
}

bool MacosRemoteDesktopSession::OnPeerConnectionState(
    const common::TransportCallbackStamp& stamp,
    common::PeerConnectionState state,
    common::TransportTime now) {
  return impl_->OnPeerConnectionState(stamp, state, now);
}

bool MacosRemoteDesktopSession::OnDataChannelState(
    const common::TransportCallbackStamp& stamp,
    common::DataChannelKind channel,
    common::DataChannelState state) {
  return impl_->OnDataChannelState(stamp, channel, state);
}

bool MacosRemoteDesktopSession::OnTransportPath(
    const common::TransportCallbackStamp& stamp,
    common::TransportPath path) {
  return impl_->OnTransportPath(stamp, path);
}

bool MacosRemoteDesktopSession::UpdateTransportQuality(
    const common::TransportCallbackStamp& stamp,
    const common::QualityTarget& target) {
  return impl_->UpdateTransportQuality(stamp, target);
}

bool MacosRemoteDesktopSession::RecordTransportMediaProgress(
    const common::TransportCallbackStamp& stamp,
    std::uint64_t source_frames,
    std::uint64_t outbound_video_bytes,
    common::TransportTime now) {
  return impl_->RecordTransportMediaProgress(stamp, source_frames,
                                             outbound_video_bytes, now);
}

common::InputResult MacosRemoteDesktopSession::ApplyPointerMove(
    const common::PointerMove& move) {
  return impl_->ApplyPointerMove(move);
}

common::InputResult MacosRemoteDesktopSession::ApplyKey(
    const common::KeyTransition& transition) {
  return impl_->ApplyKey(transition);
}

common::InputResult MacosRemoteDesktopSession::ApplyButton(
    const common::ButtonTransition& transition) {
  return impl_->ApplyButton(transition);
}

common::InputResult MacosRemoteDesktopSession::ClickButton(
    const common::ButtonTransition& transition) {
  return impl_->ClickButton(transition);
}

common::InputResult MacosRemoteDesktopSession::ApplyWheel(
    const common::WheelInput& input) {
  return impl_->ApplyWheel(input);
}

common::InputResult MacosRemoteDesktopSession::ApplyText(
    const common::TextInput& input) {
  return impl_->ApplyText(input);
}

void MacosRemoteDesktopSession::ReleaseController(
    std::string_view controller_id) noexcept {
  impl_->ReleaseController(controller_id);
}

bool MacosRemoteDesktopSession::ReleaseAllControllers() noexcept {
  return impl_->ReleaseAllControllers();
}

bool MacosRemoteDesktopSession::PasteText(std::string_view text) {
  return impl_->PasteText(text);
}

bool MacosRemoteDesktopSession::CopySelection(std::string* text) {
  return impl_->CopySelection(text);
}

void MacosRemoteDesktopSession::Stop() noexcept {
  impl_->Stop();
}

common::SessionState MacosRemoteDesktopSession::state() const noexcept {
  return impl_->state();
}

common::CapabilityReadiness MacosRemoteDesktopSession::readiness()
    const noexcept {
  return impl_->readiness();
}

std::optional<common::DesktopTopology> MacosRemoteDesktopSession::topology()
    const {
  return impl_->topology();
}

std::string MacosRemoteDesktopSession::selected_display_id() const {
  return impl_->selected_display_id();
}

common::TerminalError MacosRemoteDesktopSession::terminal_error() const {
  return impl_->terminal_error();
}

common::TransportDiagnostics MacosRemoteDesktopSession::transport_diagnostics()
    const {
  return impl_->transport_diagnostics();
}

common::TransportTerminalReason
MacosRemoteDesktopSession::transport_terminal_reason() const noexcept {
  return impl_->transport_terminal_reason();
}

bool MacosRemoteDesktopSession::has_transport_adapter() const noexcept {
  return impl_->has_transport_adapter();
}

}  // namespace imcodes::remote_desktop::macos
