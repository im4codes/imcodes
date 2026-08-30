#ifndef IMCODES_REMOTE_DESKTOP_PEER_SESSION_H_
#define IMCODES_REMOTE_DESKTOP_PEER_SESSION_H_

#include <atomic>
#include <chrono>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "api/data_channel_interface.h"
#include "api/peer_connection_interface.h"
#include "api/scoped_refptr.h"
#include "rtc_base/thread.h"
#include "third_party/imcodes_remote_desktop/display_capture.h"
#include "third_party/imcodes_remote_desktop/input_injector.h"
#include "third_party/imcodes_remote_desktop/ice_candidate_queue.h"
#include "third_party/imcodes_remote_desktop/json_protocol.h"

namespace imcodes::rd {

using EmitJson = std::function<void(const Json::Value&)>;
using AcquireSource = std::function<webrtc::scoped_refptr<DxgiDesktopSource>(
    const DisplayInfo&)>;
using ReleaseSource = std::function<void(const DisplayInfo&)>;
// Runs the node's stored-secret unlock on the worker's signaling thread and
// reports whether it was attempted. The secret itself never crosses this
// boundary — only the request and the outcome do.
using RequestUnlock = std::function<bool()>;
using ClipboardSequence = std::function<DWORD()>;
using ReadClipboardText =
    std::function<std::optional<std::u16string>(DWORD)>;

class PeerSession;

class PeerDataObserver final : public webrtc::DataChannelObserver {
 public:
  PeerDataObserver(std::weak_ptr<PeerSession> session, std::string label);
  void OnStateChange() override;
  void OnMessage(const webrtc::DataBuffer& buffer) override;

 private:
  const std::weak_ptr<PeerSession> session_;
  const std::string label_;
};

class PeerSession final : public webrtc::PeerConnectionObserver,
                          public std::enable_shared_from_this<PeerSession> {
 public:
  static std::shared_ptr<PeerSession> Create(
      Authority authority,
      webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
      std::vector<DisplayInfo> displays,
      AcquireSource acquire_source,
      ReleaseSource release_source,
      InputArbiter* input,
      ClipboardSequence clipboard_sequence,
      ReadClipboardText read_clipboard_text,
      RequestUnlock request_unlock,
      webrtc::Thread* signaling_thread,
      EmitJson emit);
  ~PeerSession() override;

  bool Initialize();
  bool ApplyOffer(const std::string& sdp);
  bool AddIce(const std::string& mid, const std::string& candidate);
  bool Renew(const Authority& renewal);
  bool SetMode(const Authority& update, const std::string& reason);
  bool RefreshDisplays(std::vector<DisplayInfo> displays);
  bool Expired(int64_t now_ms) const;
  bool IdleExpired() const;
  void Close(const char* terminal_reason, bool emit_terminal = true);
  const Authority& authority() const { return authority_; }
  bool controlling() const;
  /**
   * Tell this session what the node is showing. A viewer that lands on a lock
   * screen must be told so — the picture alone cannot say whether a password
   * box is the desktop or a barrier — and the unlock control only exists while
   * a stored secret can actually answer it.
   */
  void SetSignInState(bool sign_in_screen, bool unlock_available);
  bool protected_content_masked() const;
  bool closed() const { return closed_.load(); }
  void CheckMediaProgress();
  /**
   * Push a status the moment input becomes usable (or stops being), instead of
   * leaving the viewer to discover it on the next lease renewal. Called from
   * the worker's tick, so the dead window after a connect or a desktop switch
   * is one tick rather than one renewal interval.
   */
  void PublishInputReadinessIfChanged();
  /** Let the video out once the input channels are up, or the wait expires. */
  void ActivateVideoIfReady();
  void HandleMediaStats(uint64_t generation,
                        bool has_outbound_video,
                        uint64_t outbound_bytes);

  void HandleData(const std::string& label,
                  const webrtc::DataBuffer& buffer);
  void HandleChannelState(const std::string& label);
  void CreateAnswer();
  void SendAnswer(std::unique_ptr<webrtc::SessionDescriptionInterface> answer,
                  const std::string& sdp);
  void OnRemoteDescriptionSet(bool success);

  // PeerConnectionObserver.
  void OnSignalingChange(
      webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnDataChannel(
      webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) override;
  void OnIceGatheringChange(
      webrtc::PeerConnectionInterface::IceGatheringState) override {}
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override;
  void OnConnectionChange(
      webrtc::PeerConnectionInterface::PeerConnectionState state) override;
  void OnIceSelectedCandidatePairChanged(
      const webrtc::CandidatePairChangeEvent& event) override;

 private:
  PeerSession(Authority authority,
              webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface>
                  factory,
              std::vector<DisplayInfo> displays,
              AcquireSource acquire_source,
              ReleaseSource release_source,
              InputArbiter* input,
              ClipboardSequence clipboard_sequence,
              ReadClipboardText read_clipboard_text,
              RequestUnlock request_unlock,
              webrtc::Thread* signaling_thread,
              EmitJson emit);

  bool Matches(const Authority& authority) const;
  bool ValidateInputBase(const Json::Value& root,
                         const std::string& channel,
                         bool require_control,
                         uint64_t* sequence);
  bool ConsumeRate(const std::string& bucket, int maximum,
                   std::chrono::seconds window);
  void HandleDataOnSignaling(const std::string& label,
                             const std::string& text);
  void HandleControl(const std::string& channel, const Json::Value& root);
  void HandlePointer(const std::string& channel, const Json::Value& root);
  void HandleKeyboard(const std::string& channel, const Json::Value& root);
  void SendTopology();
  void SendQuality();
  void SendInputAck(uint64_t acknowledged_sequence);
  bool CopySelection(const std::string& request_id);
  bool SendClipboard(const std::string& request_id,
                     const std::optional<std::u16string>& text);
  void SendStatus(const char* state, bool input_enabled);
  /** What input is waiting on, or nullptr when nothing is. */
  const char* InputBlockedReason() const;
  // Tell the controller why a control command did nothing. Always returns
  // false so refusal paths can `return SendControlRejected(...)`.
  bool SendControlRejected(const char* kind,
                           const char* reason,
                           const std::string& display_id = {});
  void EmitIceCandidate(std::string mid, std::string candidate);
  bool FlushPendingRemoteIce();
  bool SelectDisplay(const std::string& id);
  bool SetDisplayMode(const std::string& id, int width, int height);
  bool SetDisplayScale(const std::string& id, int percent);
  bool SendControl(const Json::Value& value);
  bool ChannelsReady() const;
  bool InputReady() const;
  bool ApplyTransportBitratePolicy(bool direct);
  bool ReleaseInput();
  void TouchActivity();
  void ResetMediaProgressWatchdog();

  Authority authority_;
  const webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  std::vector<DisplayInfo> displays_;
  const AcquireSource acquire_source_;
  const ReleaseSource release_source_;
  InputArbiter* const input_;
  const ClipboardSequence clipboard_sequence_;
  const ReadClipboardText read_clipboard_text_;
  const RequestUnlock request_unlock_;
  /**
   * Video is held back until the input channels are open. Their handshake is a
   * few small packets; the first video is megabits, and on a relayed link that
   * is one ordered pipe, so whichever goes first decides how long the other
   * waits. Bounded: a viewer that never opens all three still gets a picture.
   */
  bool video_activated_ = false;
  int64_t video_gate_deadline_ms_ = 0;
  bool sign_in_screen_ = false;
  bool unlock_available_ = false;
  /** Last input readiness reported, so only changes are pushed. */
  bool reported_input_ready_ = false;
  webrtc::Thread* const signaling_thread_;
  const EmitJson emit_;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> peer_;
  webrtc::scoped_refptr<webrtc::CreateSessionDescriptionObserver>
      answer_observer_;
  webrtc::scoped_refptr<webrtc::VideoTrackInterface> track_;
  webrtc::scoped_refptr<DxgiDesktopSource> source_;
  size_t selected_display_ = 0;
  bool selection_required_ = false;
  int layout_revision_ = 1;
  uint64_t outbound_sequence_ = 0;
  std::map<std::string, uint64_t> last_sequence_by_channel_;
  std::map<std::string, webrtc::scoped_refptr<webrtc::DataChannelInterface>>
      channels_;
  std::map<std::string, std::unique_ptr<PeerDataObserver>> channel_observers_;
  std::set<std::string> pressed_codes_;
  struct RateWindow {
    std::chrono::steady_clock::time_point start;
    int count = 0;
  };
  std::map<std::string, RateWindow> rate_windows_;
  std::chrono::steady_clock::time_point last_activity_ =
      std::chrono::steady_clock::now();
  int remote_ice_count_ = 0;
  int local_ice_count_ = 0;
  PendingRemoteIceCandidates pending_remote_ice_{kMaxIceCandidates};
  bool setting_remote_description_ = false;
  bool remote_description_set_ = false;
  bool layout_acknowledged_ = false;
  std::atomic<bool> closed_{false};
  std::atomic<bool> relayed_{false};
  bool candidate_pair_selected_ = false;
  bool peer_connected_ = false;
  bool media_started_ = false;
  std::optional<bool> direct_bitrate_policy_;
  uint64_t media_stats_generation_ = 0;
  uint64_t last_outbound_video_bytes_ = 0;
  uint64_t source_frames_at_media_progress_ = 0;
  int64_t media_stats_requested_at_ms_ = 0;
  int64_t last_media_progress_at_ms_ = 0;
  bool media_stats_in_flight_ = false;
  bool media_stats_initialized_ = false;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_PEER_SESSION_H_
