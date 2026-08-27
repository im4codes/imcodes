#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_REMOTE_DESKTOP_SESSION_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_REMOTE_DESKTOP_SESSION_H_

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "../remote-desktop-common/session_core.h"
#include "../remote-desktop-common/transport_session_core.h"
#include "h264_sender_bridge.h"
#include "macos_local_disclosure.h"
#include "macos_virtual_display_adapter.h"
#include "ns_pasteboard_clipboard_adapter.h"
#include "macos_login_window_capture.h"
#include "screen_capture_kit_adapter.h"
#include "video_toolbox_h264_encoder.h"

namespace imcodes::remote_desktop::macos {

// The composition owns no RTP, RTCP, ICE, pacing, congestion-control or
// network implementation. A production caller supplies the backend returned
// by CreatePinnedLibwebrtcH264Sender(); tests supply the same narrow seam.
class MacosEncodedMediaSender {
 public:
  virtual ~MacosEncodedMediaSender() = default;
  virtual bool Start(common::WorkerGeneration generation,
                     common::PixelSize encoded_pixels,
                     common::H264Profile profile) = 0;
  virtual bool Submit(common::WorkerGeneration generation,
                      common::H264AccessUnit access_unit) = 0;
  virtual void Stop() noexcept = 0;
};

enum class MacosSessionEndReason : std::uint8_t {
  kShutdown,
  kPermissionLoss,
  kLocked,
  kUserChanged,
  kSleeping,
  kGraphicalSessionEnded,
  kDisclosureLost,
  kAdapterFailure,
};

// Existing macOS adapters have generation/topology lifecycle operations that
// are intentionally narrower than the common platform interfaces. Keeping
// those operations here avoids weakening the common contract or teaching it
// about TCC, Quartz or LaunchAgent state.
class MacosSessionLifecycle {
 public:
  virtual ~MacosSessionLifecycle() = default;
  virtual bool BeginGeneration(common::WorkerGeneration generation) = 0;
  virtual bool BindInputTopology(const common::DesktopTopology& topology,
                                 std::string_view display_id) = 0;
  virtual void EndGeneration(MacosSessionEndReason reason) noexcept = 0;
};

// A readiness gate can only remove authority from adapter observations. The
// production gate applies a fresh MacosPermissionReadiness snapshot; it may
// never synthesize Ready for an adapter that did not report Ready itself.
class MacosSessionReadinessGate {
 public:
  virtual ~MacosSessionReadinessGate() = default;
  [[nodiscard]] virtual common::CapabilityReadiness Constrain(
      common::CapabilityReadiness observed) = 0;
};

using MacosRemoteDesktopOfferNegotiator =
    std::function<bool(std::string_view, std::string*)>;
using MacosRemoteDesktopApplyQuality =
    std::function<bool(const common::QualitySelection&)>;

struct MacosRemoteDesktopSessionDependencies {
  common::PlatformAdapters adapters;
  MacosEncodedMediaSender& media_sender;
  MacosSessionLifecycle& lifecycle;
  MacosSessionReadinessGate& readiness_gate;
  // Optional real signaling transport. When absent, the session still uses
  // TransportSessionCore for route authority, mode, activity and ordered
  // cleanup, but deliberately does not claim a PeerConnection/DataChannel.
  common::TransportSessionAdapter* transport = nullptr;
  // Bounded synchronous SDP seam owned by the pinned transport composition.
  // Kept separate from TransportSessionAdapter because the common core owns
  // negotiation readiness/order, not libwebrtc SDP objects.
  MacosRemoteDesktopOfferNegotiator negotiate_offer;
  MacosRemoteDesktopApplyQuality apply_quality;
};

struct MacosRemoteDesktopVideoConfiguration {
  std::uint32_t frame_rate = 30;
  std::uint32_t bitrate_bps = 4'000'000;
  common::H264Profile profile = common::H264Profile::kConstrainedBaseline;
};

struct MacosRemoteDesktopStartRequest {
  common::WorkerGeneration worker_generation = 0;
  std::string preferred_display_id;
  std::uint32_t viewers = 1;
  std::uint32_t controllers = 0;
  MacosRemoteDesktopVideoConfiguration video;
  // Authenticated callers provide the exact Server route authority and their
  // monotonic observation time. Existing composition-only callers may omit
  // it; they receive a bounded local compatibility authority that is never
  // exposed as network authority.
  std::optional<common::RouteAuthority> route_authority;
  common::TransportTime authority_now;
};

enum class MacosRemoteDesktopSessionEventType : std::uint8_t {
  kStartedViewing,
  kControlEnabled,
  kControlDowngraded,
  kTopologyChanged,
  kDisplaySelected,
  kLifecycleBoundary,
  kTerminal,
};

struct MacosRemoteDesktopSessionEvent {
  MacosRemoteDesktopSessionEventType type =
      MacosRemoteDesktopSessionEventType::kLifecycleBoundary;
  common::GraphicalSessionEvent lifecycle_event =
      common::GraphicalSessionEvent::kReady;
  common::TopologyRevision topology_revision = 0;
  std::string display_id;
  common::TerminalError terminal_error;
};

using MacosRemoteDesktopSessionEventSink =
    std::function<void(const MacosRemoteDesktopSessionEvent&)>;
using MacosDisclosureBeginGeneration =
    std::function<bool(common::WorkerGeneration)>;
struct MacosRemoteDesktopProductionConfiguration {
  common::WorkerGeneration worker_generation = 0;
  std::unique_ptr<H264SenderBackend> pinned_libwebrtc_sender_backend;
  ClipboardAction request_copy;
  ClipboardAction request_paste;
  MacosDisclosureStopAllRoutes stop_all_routes;
  ScreenCaptureKitLimits capture_limits;
  VideoToolboxEncoderPolicy encoder_policy;
  VideoToolboxEncoderLimits encoder_limits;
  NSPasteboardClipboardOptions clipboard_options;
  MacosLocalDisclosureOptions disclosure_options;
  // The stock worker supplies the separately signed disclosure process here.
  // Tests and composition-only callers may omit it and retain the owned local
  // adapter. Supplying one without a generation binder fails closed.
  common::DisclosureAdapter* disclosure = nullptr;
  // Display ownership belongs to the resident signed helper, never to this
  // process. Production injects a helper-backed backend here; leaving it null
  // means the session has no display control at all, which is the correct
  // refusal. It must NEVER fall back to constructing the in-process Apple
  // backend: that would put a CGVirtualDisplay in a process whose crash strands
  // it, with a release-to-remove teardown measured not to remove on macOS 26.x.
  std::unique_ptr<MacosVirtualDisplayBackend> virtual_display_backend;
  MacosDisclosureBeginGeneration begin_disclosure;
  // Borrowed real signaling transport, when the LaunchAgent composition has
  // one. The current encoded sender alone is not a PeerConnection substitute.
  common::TransportSessionAdapter* transport = nullptr;
  MacosRemoteDesktopOfferNegotiator negotiate_offer;
  // Authenticated session type from the LaunchAgent launch context, never a
  // probe of the current desktop: an Aqua probe run at the login window reports
  // a user surface that does not exist there. The capability profile is derived
  // from exactly this value, so it is never intersected with a configured set
  // -- an adapter that advertises clipboard must not inherit it here.
  std::string session_type = std::string(kSessionTypeAqua);
  // The capture backend this session will own. Which backend can see the login
  // window depends on the running release, so the composition names it rather
  // than inheriting a default. Null means the ordinary Aqua ScreenCaptureKit
  // backend; at a LoginWindow session null is refused outright, because falling
  // back to that default is the exact bug this field exists to prevent.
  std::unique_ptr<ScreenCaptureKitBackend> capture_backend;
};

// Concrete active-user composition owner. Borrowed dependencies must outlive
// the session. CreateWithPinnedLibwebrtcSender owns the production adapters
// and is ready for a later signed LaunchAgent main to select; this file does
// not itself claim an executable, PeerConnection or release-manifest entry.
class MacosRemoteDesktopSession final {
 public:
  explicit MacosRemoteDesktopSession(
      MacosRemoteDesktopSessionDependencies dependencies,
      MacosRemoteDesktopSessionEventSink event_sink = {});
  ~MacosRemoteDesktopSession();

  MacosRemoteDesktopSession(const MacosRemoteDesktopSession&) = delete;
  MacosRemoteDesktopSession& operator=(const MacosRemoteDesktopSession&) =
      delete;

  static std::unique_ptr<MacosRemoteDesktopSession>
  CreateWithPinnedLibwebrtcSender(
      MacosRemoteDesktopProductionConfiguration configuration,
      MacosRemoteDesktopSessionEventSink event_sink = {});

  bool Start(const MacosRemoteDesktopStartRequest& request);
  bool RefreshReadiness();
  bool RefreshTopology();
  bool SelectDisplay(std::string_view display_id);
  bool SetDisplayMode(std::string_view display_id, common::PixelSize pixels);
  bool SetDisplayScale(std::string_view display_id, double scale);
  bool SetControlActive(bool active);
  bool SetControlActive(bool active, common::TransportTime now);

  bool RenewRouteAuthority(const common::RouteAuthority& authority,
                           common::TransportTime now);
  // Applies the exact Server-granted mode/input epoch rather than synthesizing
  // a local epoch. The transport core validates identity, monotonic epoch and
  // lease ordering before physical input state changes.
  bool ApplyModeAuthority(const common::RouteAuthority& authority,
                          common::TransportTime now);
  bool RecordRouteActivity(const common::RouteAuthorityIdentity& identity,
                           common::TransportTime now);
  bool TickTransport(common::TransportTime now);
  void ReportTransportFailure() noexcept;
  bool AddRemoteIceCandidate(const common::RouteAuthorityIdentity& identity,
                             common::IceCandidate candidate);
  bool NegotiateOffer(std::string_view offer_sdp, std::string* answer_sdp);
  bool SetRemoteDescriptionReady(const common::TransportCallbackStamp& stamp);
  bool OnLocalIceCandidate(const common::TransportCallbackStamp& stamp,
                           common::IceCandidate candidate);
  bool SetLocalIceEmissionReady(const common::TransportCallbackStamp& stamp);
  bool OnPeerConnectionState(const common::TransportCallbackStamp& stamp,
                             common::PeerConnectionState state,
                             common::TransportTime now);
  bool OnDataChannelState(const common::TransportCallbackStamp& stamp,
                          common::DataChannelKind channel,
                          common::DataChannelState state);
  bool OnTransportPath(const common::TransportCallbackStamp& stamp,
                       common::TransportPath path);
  bool UpdateTransportQuality(const common::TransportCallbackStamp& stamp,
                              const common::QualityTarget& target);
  bool RecordTransportMediaProgress(const common::TransportCallbackStamp& stamp,
                                    std::uint64_t source_frames,
                                    std::uint64_t outbound_video_bytes,
                                    common::TransportTime now);

  common::InputResult ApplyPointerMove(const common::PointerMove& move);
  common::InputResult ApplyKey(const common::KeyTransition& transition);
  common::InputResult ApplyButton(const common::ButtonTransition& transition);
  common::InputResult ClickButton(const common::ButtonTransition& transition);
  common::InputResult ApplyWheel(const common::WheelInput& input);
  common::InputResult ApplyText(const common::TextInput& input);
  void ReleaseController(std::string_view controller_id) noexcept;

  // Releases every held key/button for every controller and drops back to
  // viewing. Returns false when the session cannot act (terminal, or view not
  // ready), so a cleanup caller can report that truthfully instead of claiming
  // a release that never happened.
  //
  // `ReleaseController("")` is NOT a substitute: InputLedger looks the id up in
  // its controller map, misses, and returns kApplied — a success report that
  // released nothing while real controllers still hold state down. This seam
  // goes through SessionCore::SetControlActive(false), the public path that
  // reaches InputLedger::ReleaseAll() and therefore the input backend's
  // ReleaseAllEmittedState(). Capture and viewing are deliberately preserved:
  // it drops input authority, not the session.
  bool ReleaseAllControllers() noexcept;

  bool PasteText(std::string_view text);
  bool CopySelection(std::string* text);

  void Stop() noexcept;

  [[nodiscard]] common::SessionState state() const noexcept;
  [[nodiscard]] common::CapabilityReadiness readiness() const noexcept;
  [[nodiscard]] std::optional<common::DesktopTopology> topology() const;
  [[nodiscard]] std::string selected_display_id() const;
  [[nodiscard]] common::TerminalError terminal_error() const;
  [[nodiscard]] common::TransportDiagnostics transport_diagnostics() const;
  [[nodiscard]] common::TransportTerminalReason transport_terminal_reason()
      const noexcept;
  [[nodiscard]] bool has_transport_adapter() const noexcept;

 private:
  class Impl;
  explicit MacosRemoteDesktopSession(std::shared_ptr<Impl> impl);
  std::shared_ptr<Impl> impl_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_REMOTE_DESKTOP_SESSION_H_
