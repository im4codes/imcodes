#include "third_party/imcodes_remote_desktop/peer_session.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/create_modular_peer_connection_factory.h"
#include "api/data_channel_interface.h"
#include "api/enable_media.h"
#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/peer_connection_interface.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "gtest/gtest.h"
#include "rtc_base/ssl_adapter.h"
#include "rtc_base/thread.h"
#include "rtc_base/win32_socket_init.h"
#include "test/create_test_environment.h"
#include "third_party/imcodes_remote_desktop/common/data_channel_constants.h"
#include "third_party/imcodes_remote_desktop/common/loopback_audio_device_module.h"
#include "third_party/imcodes_remote_desktop/mf_h264_encoder.h"
#include "third_party/imcodes_remote_desktop/quality_ladder.h"

namespace imcodes::rd {

class PeerSessionTestAccessor {
 public:
  static std::shared_ptr<PeerSession> CreateReadySession(
      int64_t expires_at_ms,
      int64_t lease_expires_at_ms,
      InputArbiter* input,
      ClipboardSequence clipboard_sequence,
      ReadClipboardText read_clipboard_text,
      std::function<common::TransportTime()> now_clock,
      std::vector<Json::Value>* sent_control_frames,
      const char* mode = kControlMode,
      int input_epoch = 1,
      AudioEnabledCallback on_audio_enabled_changed = {}) {
    Authority authority;
    authority.request_id = "req-1";
    authority.session_id = "session-1";
    authority.capability = "0123456789abcdef0123456789abcdef0123456789a";
    authority.mode = mode;
    authority.input_epoch = input_epoch;
    authority.daemon_generation = 1;
    authority.route_generation = 1;
    authority.expires_at_ms = expires_at_ms;
    authority.lease_expires_at_ms = lease_expires_at_ms;

    DisplayInfo display;
    display.id = "display-1";
    display.label = "Primary";
    display.primary = true;
    display.width = 1920;
    display.height = 1080;
    display.dpi_scale = 1.0;
    display.rotation_degrees = 0;

    auto session = PeerSession::Create(
        std::move(authority),
        /*factory=*/nullptr,
        {display},
        /*acquire_source=*/{},
        /*release_source=*/{},
        input,
        std::move(clipboard_sequence),
        std::move(read_clipboard_text),
        /*request_unlock=*/{},
        /*signaling_thread=*/nullptr,
        [](const Json::Value&) {},
        std::move(on_audio_enabled_changed));
    session->now_clock_ = std::move(now_clock);
    session->bypass_webrtc_for_testing_ = true;
    session->send_control_override_ =
        [sent_control_frames](const std::string& raw) {
          Json::Value parsed;
          if (!ParseJson(raw, &parsed)) return false;
          sent_control_frames->push_back(std::move(parsed));
          return true;
        };

    const common::TransportTime start_time = session->NowTransportTime();
    EXPECT_TRUE(session->transport_core_.Start(
        session->CommonAuthority(session->authority_), start_time));
    EXPECT_TRUE(session->transport_core_.SetRemoteDescriptionReady(
        session->CallbackStamp()));
    EXPECT_TRUE(session->transport_core_.SetLocalIceEmissionReady(
        session->CallbackStamp()));
    EXPECT_TRUE(session->transport_core_.OnPeerConnectionState(
        session->CallbackStamp(), common::PeerConnectionState::kConnected,
        start_time));
    for (const auto channel : {common::DataChannelKind::kControl,
                               common::DataChannelKind::kKeyboard,
                               common::DataChannelKind::kPointer}) {
      EXPECT_TRUE(session->transport_core_.OnDataChannelState(
          session->CallbackStamp(), channel, common::DataChannelState::kOpen));
    }
    session->layout_acknowledged_ = true;
    if (std::string(mode) == kControlMode) {
      EXPECT_TRUE(session->InputReady());
    }
    EXPECT_TRUE(session->ChannelsReady());
    return session;
  }

  static void ReceiveControlData(PeerSession& session,
                                 const Json::Value& root,
                                 const char* channel = kControlChannel) {
    session.HandleData(channel, webrtc::DataBuffer(WriteJson(root)));
  }

  static const std::optional<int>& ClipboardSyncEpoch(
      const PeerSession& session) {
    return session.clipboard_sync_input_epoch_;
  }

  static uint32_t ViewerBitrateCeiling(const PeerSession& session) {
    return session.viewer_bitrate_ceiling_bps_;
  }

  static bool AudioEnabled(const PeerSession& session) {
    return session.audio_enabled_;
  }
};

namespace {

Json::Value BaseControlFrame(uint64_t sequence, const char* kind) {
  Json::Value root(Json::objectValue);
  root["type"] = kControlType;
  root["protocolVersion"] = kProtocolVersion;
  root["sessionId"] = "session-1";
  root["sequence"] = Json::UInt64(sequence);
  root["layoutRevision"] = 1;
  root["inputEpoch"] = 1;
  root["kind"] = kind;
  return root;
}

TEST(PeerSessionTest, SetClipboardSyncToggleStartsAndStopsOnControlChannel) {
  InputArbiter input([](UINT count, LPINPUT, int) { return count; },
                     []() { return true; });
  std::atomic<DWORD> clip_seq{10};
  std::string clip_text = "copied-once";
  int64_t clock_ms = 10'000;
  std::vector<Json::Value> sent_frames;

  auto session = PeerSessionTestAccessor::CreateReadySession(
      /*expires_at_ms=*/60'000,
      /*lease_expires_at_ms=*/30'000, &input,
      [&clip_seq]() -> DWORD { return clip_seq.load(); },
      [&clip_text](DWORD) -> std::optional<std::u16string> {
        return std::u16string(clip_text.begin(), clip_text.end());
      },
      [&clock_ms]() { return common::TransportTime{clock_ms, clock_ms}; },
      &sent_frames);

  EXPECT_FALSE(PeerSessionTestAccessor::ClipboardSyncEpoch(*session).has_value());
  EXPECT_TRUE(session->Tick(clock_ms));
  EXPECT_TRUE(sent_frames.empty());

  Json::Value enable = BaseControlFrame(1, kSetClipboardSyncKind);
  enable["enabled"] = true;
  PeerSessionTestAccessor::ReceiveControlData(*session, enable);
  ASSERT_TRUE(PeerSessionTestAccessor::ClipboardSyncEpoch(*session).has_value());
  EXPECT_EQ(*PeerSessionTestAccessor::ClipboardSyncEpoch(*session), 1);

  // Baseline capture does not emit immediately; next clipboard sequence change does.
  clock_ms += 300;
  EXPECT_TRUE(session->Tick(clock_ms));
  EXPECT_TRUE(sent_frames.empty());

  clip_seq.store(11);
  clock_ms += 300;
  EXPECT_TRUE(session->Tick(clock_ms));
  ASSERT_EQ(sent_frames.size(), 1u);
  EXPECT_EQ(sent_frames[0]["type"].asString(), kClipboardUpdateType);
  EXPECT_EQ(sent_frames[0]["text"].asString(), "copied-once");
  EXPECT_EQ(sent_frames[0]["inputEpoch"].asInt(), 1);

  Json::Value disable = BaseControlFrame(2, kSetClipboardSyncKind);
  disable["enabled"] = false;
  PeerSessionTestAccessor::ReceiveControlData(*session, disable);
  EXPECT_FALSE(PeerSessionTestAccessor::ClipboardSyncEpoch(*session).has_value());

  clip_seq.store(12);
  clip_text = "after-disable";
  clock_ms += 300;
  EXPECT_TRUE(session->Tick(clock_ms));
  EXPECT_EQ(sent_frames.size(), 1u);
}

TEST(PeerSessionTest,
     RejectsMalformedSetClipboardSyncAndForeignEnabledFieldOnOtherKinds) {
  InputArbiter input([](UINT count, LPINPUT, int) { return count; },
                     []() { return true; });
  int64_t clock_ms = 10'000;
  std::vector<Json::Value> sent_frames;

  auto session = PeerSessionTestAccessor::CreateReadySession(
      /*expires_at_ms=*/60'000,
      /*lease_expires_at_ms=*/30'000, &input,
      []() -> DWORD { return 1; },
      [](DWORD) -> std::optional<std::u16string> { return std::nullopt; },
      [&clock_ms]() { return common::TransportTime{clock_ms, clock_ms}; },
      &sent_frames);

  const uint32_t initial_ceiling =
      PeerSessionTestAccessor::ViewerBitrateCeiling(*session);
  EXPECT_EQ(initial_ceiling, kPerPeerVideoBitrateBps);

  // Regression guard for Round-2 P0 #4: non-clipboard-sync control kinds
  // (including set_quality_preference, which runs before ValidateInputBase)
  // must reject any trailing "enabled" field without mutating session state.
  Json::Value polluted_quality = BaseControlFrame(1, "set_quality_preference");
  polluted_quality["maxHeight"] = 720;
  polluted_quality["maxFps"] = 15;
  polluted_quality["maxBitrateBps"] = kMaxViewerVideoBitrateBps;
  polluted_quality["priority"] = "framerate";
  polluted_quality["enabled"] = true;
  PeerSessionTestAccessor::ReceiveControlData(*session, polluted_quality);
  EXPECT_EQ(PeerSessionTestAccessor::ViewerBitrateCeiling(*session),
            initial_ceiling);
  EXPECT_FALSE(PeerSessionTestAccessor::ClipboardSyncEpoch(*session).has_value());
  EXPECT_TRUE(sent_frames.empty());

  // Positive control: the exact same set_quality_preference frame WITHOUT
  // "enabled" succeeds through HandleData and updates viewer bitrate ceiling.
  Json::Value clean_quality = BaseControlFrame(2, "set_quality_preference");
  clean_quality["maxHeight"] = 720;
  clean_quality["maxFps"] = 15;
  clean_quality["maxBitrateBps"] = kMaxViewerVideoBitrateBps;
  clean_quality["priority"] = "framerate";
  PeerSessionTestAccessor::ReceiveControlData(*session, clean_quality);
  EXPECT_EQ(PeerSessionTestAccessor::ViewerBitrateCeiling(*session),
            kMaxViewerVideoBitrateBps);

  Json::Value polluted_keepalive = BaseControlFrame(3, kKeepaliveKind);
  polluted_keepalive["enabled"] = true;
  PeerSessionTestAccessor::ReceiveControlData(*session, polluted_keepalive);
  EXPECT_FALSE(PeerSessionTestAccessor::ClipboardSyncEpoch(*session).has_value());

  Json::Value non_bool_sync = BaseControlFrame(3, kSetClipboardSyncKind);
  non_bool_sync["enabled"] = "true";
  PeerSessionTestAccessor::ReceiveControlData(*session, non_bool_sync);
  EXPECT_FALSE(PeerSessionTestAccessor::ClipboardSyncEpoch(*session).has_value());

  Json::Value missing_enabled = BaseControlFrame(3, kSetClipboardSyncKind);
  PeerSessionTestAccessor::ReceiveControlData(*session, missing_enabled);
  EXPECT_FALSE(PeerSessionTestAccessor::ClipboardSyncEpoch(*session).has_value());
}

TEST(PeerSessionTest,
     TickAbortsClipboardUpdateWhenClockCrossesLeaseDuringRead) {
  InputArbiter input([](UINT count, LPINPUT, int) { return count; },
                     []() { return true; });
  std::atomic<DWORD> clip_seq{20};
  int64_t clock_ms = 10'000;
  std::vector<Json::Value> sent_frames;

  // Lease expires at 10'500 while route deadline stays valid through 60'000.
  auto session = PeerSessionTestAccessor::CreateReadySession(
      /*expires_at_ms=*/60'000,
      /*lease_expires_at_ms=*/10'500, &input,
      [&clip_seq]() -> DWORD { return clip_seq.load(); },
      [&clock_ms, &clip_seq](DWORD) -> std::optional<std::u16string> {
        if (clip_seq.load() > 20) {
          // Simulate clipboard read blocking across lease expiry boundary.
          clock_ms = 10'500;
        }
        return std::u16string(u"late-clipboard-secret");
      },
      [&clock_ms]() { return common::TransportTime{clock_ms, clock_ms}; },
      &sent_frames);

  Json::Value enable = BaseControlFrame(1, kSetClipboardSyncKind);
  enable["enabled"] = true;
  PeerSessionTestAccessor::ReceiveControlData(*session, enable);
  ASSERT_TRUE(PeerSessionTestAccessor::ClipboardSyncEpoch(*session).has_value());

  // First tick seeds observer at seq 20 before lease expiry (10'000 < 10'500).
  EXPECT_TRUE(session->Tick(clock_ms));
  EXPECT_TRUE(sent_frames.empty());

  // Next poll enters at 10'300 (< 10'500), reads at seq 21, and clock_ms
  // advances to 10'500 during ReadClipboardText. SendClipboardUpdate must
  // re-sample wall clock and drop the update rather than emitting it.
  clip_seq.store(21);
  clock_ms = 10'300;
  (void)session->Tick(clock_ms);
  EXPECT_FALSE(PeerSessionTestAccessor::ClipboardSyncEpoch(*session).has_value());
  EXPECT_TRUE(sent_frames.empty());
}

TEST(PeerSessionTest,
     SetAudioAcceptedInBothViewAndControlModesAndResetsOnClose) {
  InputArbiter input([](UINT count, LPINPUT, int) { return count; },
                     []() { return true; });
  int64_t clock_ms = 10'000;
  std::vector<Json::Value> sent_frames;
  std::vector<bool> callback_events;

  // View-only session (input_epoch == 0, !InputReady()) MUST allow set_audio.
  auto view_session = PeerSessionTestAccessor::CreateReadySession(
      /*expires_at_ms=*/60'000,
      /*lease_expires_at_ms=*/30'000, &input,
      []() -> DWORD { return 1; },
      [](DWORD) -> std::optional<std::u16string> { return std::nullopt; },
      [&clock_ms]() { return common::TransportTime{clock_ms, clock_ms}; },
      &sent_frames, kViewMode, /*input_epoch=*/0,
      [&callback_events](bool enabled) { callback_events.push_back(enabled); });

  EXPECT_FALSE(PeerSessionTestAccessor::AudioEnabled(*view_session));
  Json::Value view_enable = BaseControlFrame(1, kSetAudioKind);
  view_enable["inputEpoch"] = 0;
  view_enable["enabled"] = true;
  PeerSessionTestAccessor::ReceiveControlData(*view_session, view_enable);
  EXPECT_TRUE(PeerSessionTestAccessor::AudioEnabled(*view_session));
  ASSERT_EQ(callback_events.size(), 1u);
  EXPECT_TRUE(callback_events[0]);

  // Duplicate enabled=true does not emit duplicate refcount updates.
  Json::Value dup_enable = BaseControlFrame(2, kSetAudioKind);
  dup_enable["inputEpoch"] = 0;
  dup_enable["enabled"] = true;
  PeerSessionTestAccessor::ReceiveControlData(*view_session, dup_enable);
  EXPECT_EQ(callback_events.size(), 1u);

  // Explicit Close must reset audio once and notify callback(false).
  view_session->Close("stopped_by_controller");
  EXPECT_FALSE(PeerSessionTestAccessor::AudioEnabled(*view_session));
  ASSERT_EQ(callback_events.size(), 2u);
  EXPECT_FALSE(callback_events[1]);

  // Control session enables audio, keeps it across SetMode(control -> view),
  // and releases cleanly when destroyed.
  callback_events.clear();
  {
    auto control_session = PeerSessionTestAccessor::CreateReadySession(
        /*expires_at_ms=*/60'000,
        /*lease_expires_at_ms=*/30'000, &input,
        []() -> DWORD { return 1; },
        [](DWORD) -> std::optional<std::u16string> { return std::nullopt; },
        [&clock_ms]() { return common::TransportTime{clock_ms, clock_ms}; },
        &sent_frames, kControlMode, /*input_epoch=*/1,
        [&callback_events](bool enabled) {
          callback_events.push_back(enabled);
        });

    Json::Value ctrl_enable = BaseControlFrame(1, kSetAudioKind);
    ctrl_enable["enabled"] = true;
    PeerSessionTestAccessor::ReceiveControlData(*control_session, ctrl_enable);
    EXPECT_TRUE(PeerSessionTestAccessor::AudioEnabled(*control_session));
    ASSERT_EQ(callback_events.size(), 1u);
    EXPECT_TRUE(callback_events[0]);

    Authority drop_control = control_session->authority();
    drop_control.mode = kViewMode;
    drop_control.input_epoch = 2;
    EXPECT_TRUE(control_session->SetMode(drop_control, "user_selected"));
    EXPECT_TRUE(PeerSessionTestAccessor::AudioEnabled(*control_session));
    EXPECT_EQ(callback_events.size(), 1u);
  }
  ASSERT_EQ(callback_events.size(), 2u);
  EXPECT_FALSE(callback_events[1]);
}

TEST(PeerSessionTest,
     RejectsMalformedSetAudioAndForeignEnabledFieldOnOtherKinds) {
  InputArbiter input([](UINT count, LPINPUT, int) { return count; },
                     []() { return true; });
  int64_t clock_ms = 10'000;
  std::vector<Json::Value> sent_frames;
  std::vector<bool> callback_events;

  auto session = PeerSessionTestAccessor::CreateReadySession(
      /*expires_at_ms=*/60'000,
      /*lease_expires_at_ms=*/30'000, &input,
      []() -> DWORD { return 1; },
      [](DWORD) -> std::optional<std::u16string> { return std::nullopt; },
      [&clock_ms]() { return common::TransportTime{clock_ms, clock_ms}; },
      &sent_frames, kViewMode, /*input_epoch=*/0,
      [&callback_events](bool enabled) { callback_events.push_back(enabled); });

  Json::Value missing_enabled = BaseControlFrame(1, kSetAudioKind);
  missing_enabled["inputEpoch"] = 0;
  PeerSessionTestAccessor::ReceiveControlData(*session, missing_enabled);
  EXPECT_FALSE(PeerSessionTestAccessor::AudioEnabled(*session));

  Json::Value string_enabled = BaseControlFrame(1, kSetAudioKind);
  string_enabled["inputEpoch"] = 0;
  string_enabled["enabled"] = "true";
  PeerSessionTestAccessor::ReceiveControlData(*session, string_enabled);
  EXPECT_FALSE(PeerSessionTestAccessor::AudioEnabled(*session));

  Json::Value extra_display = BaseControlFrame(1, kSetAudioKind);
  extra_display["inputEpoch"] = 0;
  extra_display["enabled"] = true;
  extra_display["displayId"] = "display-1";
  PeerSessionTestAccessor::ReceiveControlData(*session, extra_display);
  EXPECT_FALSE(PeerSessionTestAccessor::AudioEnabled(*session));

  Json::Value extra_unknown = BaseControlFrame(1, kSetAudioKind);
  extra_unknown["inputEpoch"] = 0;
  extra_unknown["enabled"] = true;
  extra_unknown["bogus"] = 1;
  PeerSessionTestAccessor::ReceiveControlData(*session, extra_unknown);
  EXPECT_FALSE(PeerSessionTestAccessor::AudioEnabled(*session));

  Json::Value wrong_channel = BaseControlFrame(1, kSetAudioKind);
  wrong_channel["inputEpoch"] = 0;
  wrong_channel["enabled"] = true;
  PeerSessionTestAccessor::ReceiveControlData(*session, wrong_channel,
                                              kKeyboardChannel);
  EXPECT_FALSE(PeerSessionTestAccessor::AudioEnabled(*session));
  EXPECT_TRUE(callback_events.empty());

  // Sequence 1 was never consumed by rejected messages, so sequence 1 still
  // succeeds when well-formed.
  Json::Value valid = BaseControlFrame(1, kSetAudioKind);
  valid["inputEpoch"] = 0;
  valid["enabled"] = true;
  PeerSessionTestAccessor::ReceiveControlData(*session, valid);
  EXPECT_TRUE(PeerSessionTestAccessor::AudioEnabled(*session));
  ASSERT_EQ(callback_events.size(), 1u);
}

TEST(PeerSessionTest,
     AcceptsSetAudioAcrossLayoutRevisionMismatchWhileKeepingOtherControlsStrict) {
  InputArbiter input([](UINT count, LPINPUT, int) { return count; },
                     []() { return true; });
  int64_t clock_ms = 10'000;
  std::vector<Json::Value> sent_frames;
  std::vector<bool> callback_events;

  auto session = PeerSessionTestAccessor::CreateReadySession(
      /*expires_at_ms=*/60'000,
      /*lease_expires_at_ms=*/30'000, &input,
      []() -> DWORD { return 1; },
      [](DWORD) -> std::optional<std::u16string> { return std::nullopt; },
      [&clock_ms]() { return common::TransportTime{clock_ms, clock_ms}; },
      &sent_frames, kControlMode, /*input_epoch=*/1,
      [&callback_events](bool enabled) { callback_events.push_back(enabled); });

  // Pre-topology set_audio with layoutRevision=0 (while layout_revision_==1)
  // must succeed.
  Json::Value rev_zero = BaseControlFrame(1, kSetAudioKind);
  rev_zero["layoutRevision"] = 0;
  rev_zero["enabled"] = true;
  PeerSessionTestAccessor::ReceiveControlData(*session, rev_zero);
  EXPECT_TRUE(PeerSessionTestAccessor::AudioEnabled(*session));
  ASSERT_EQ(callback_events.size(), 1u);
  EXPECT_TRUE(callback_events[0]);

  // Stale/in-flight positive layoutRevision mismatch must also succeed.
  Json::Value rev_stale = BaseControlFrame(2, kSetAudioKind);
  rev_stale["layoutRevision"] = 99;
  rev_stale["enabled"] = false;
  PeerSessionTestAccessor::ReceiveControlData(*session, rev_stale);
  EXPECT_FALSE(PeerSessionTestAccessor::AudioEnabled(*session));
  ASSERT_EQ(callback_events.size(), 2u);
  EXPECT_FALSE(callback_events[1]);

  // Negative, non-int, wrong sessionId, and stale/future inputEpoch must still
  // be rejected without consuming sequence 3.
  for (const auto& [field, bad_value] : std::vector<std::pair<const char*, Json::Value>>{
           {"layoutRevision", Json::Value(-1)},
           {"layoutRevision", Json::Value("1")},
           {"layoutRevision", Json::Value(true)},
           {"sessionId", Json::Value("wrong-session")},
           {"inputEpoch", Json::Value(0)},
           {"inputEpoch", Json::Value(2)},
       }) {
    Json::Value bad = BaseControlFrame(3, kSetAudioKind);
    bad[field] = bad_value;
    bad["enabled"] = true;
    PeerSessionTestAccessor::ReceiveControlData(*session, bad);
    EXPECT_FALSE(PeerSessionTestAccessor::AudioEnabled(*session));
    EXPECT_EQ(callback_events.size(), 2u);
  }

  // Sequence 3 was not consumed by rejected attempts and now enables audio.
  Json::Value seq3 = BaseControlFrame(3, kSetAudioKind);
  seq3["layoutRevision"] = 0;
  seq3["enabled"] = true;
  PeerSessionTestAccessor::ReceiveControlData(*session, seq3);
  EXPECT_TRUE(PeerSessionTestAccessor::AudioEnabled(*session));
  ASSERT_EQ(callback_events.size(), 3u);
  EXPECT_TRUE(callback_events[2]);

  // Replayed/non-monotonic sequence must still be rejected.
  Json::Value replay = BaseControlFrame(3, kSetAudioKind);
  replay["layoutRevision"] = 1;
  replay["enabled"] = false;
  PeerSessionTestAccessor::ReceiveControlData(*session, replay);
  EXPECT_TRUE(PeerSessionTestAccessor::AudioEnabled(*session));
  EXPECT_EQ(callback_events.size(), 3u);

  // Other control/layout commands still strictly enforce layoutRevision == 1.
  Json::Value bad_clip_sync = BaseControlFrame(4, kSetClipboardSyncKind);
  bad_clip_sync["layoutRevision"] = 0;
  bad_clip_sync["enabled"] = true;
  PeerSessionTestAccessor::ReceiveControlData(*session, bad_clip_sync);
  EXPECT_FALSE(PeerSessionTestAccessor::ClipboardSyncEpoch(*session).has_value());

  Json::Value good_clip_sync = BaseControlFrame(4, kSetClipboardSyncKind);
  good_clip_sync["layoutRevision"] = 1;
  good_clip_sync["enabled"] = true;
  PeerSessionTestAccessor::ReceiveControlData(*session, good_clip_sync);
  ASSERT_TRUE(PeerSessionTestAccessor::ClipboardSyncEpoch(*session).has_value());
  EXPECT_EQ(*PeerSessionTestAccessor::ClipboardSyncEpoch(*session), 1);

  sent_frames.clear();
  Json::Value bad_frame_presented = BaseControlFrame(5, "frame_presented");
  bad_frame_presented["layoutRevision"] = 0;
  bad_frame_presented["displayId"] = "display-1";
  bad_frame_presented["frameWidth"] = 1920;
  bad_frame_presented["frameHeight"] = 1080;
  PeerSessionTestAccessor::ReceiveControlData(*session, bad_frame_presented);
  EXPECT_TRUE(sent_frames.empty());
}

TEST(PeerSessionTest,
     LoopbackAudioTrackNegotiatesWithModernAndVideoOnlyOffers) {
  webrtc::WinsockInitializer winsock;
  ASSERT_EQ(winsock.error(), 0);
  webrtc::InitializeSSL();
  auto network_thread = webrtc::Thread::CreateWithSocketServer();
  auto worker_thread = webrtc::Thread::Create();
  auto signaling_thread = webrtc::Thread::Create();
  ASSERT_TRUE(network_thread->Start());
  ASSERT_TRUE(worker_thread->Start());
  ASSERT_TRUE(signaling_thread->Start());

  auto buffer = std::make_shared<AudioLoopbackBuffer>();
  auto adm = webrtc::make_ref_counted<LoopbackAudioDeviceModule>(buffer);
  webrtc::PeerConnectionFactoryDependencies deps;
  deps.network_thread = network_thread.get();
  deps.worker_thread = worker_thread.get();
  deps.signaling_thread = signaling_thread.get();
  deps.env = webrtc::CreateTestEnvironment();
  deps.adm = adm;
  deps.audio_encoder_factory = webrtc::CreateBuiltinAudioEncoderFactory();
  deps.audio_decoder_factory = webrtc::CreateBuiltinAudioDecoderFactory();
  deps.video_encoder_factory = std::make_unique<MfH264EncoderFactory>("test");
  deps.video_decoder_factory = webrtc::CreateBuiltinVideoDecoderFactory();
  webrtc::EnableMedia(deps);
  auto factory = webrtc::CreateModularPeerConnectionFactory(std::move(deps));
  ASSERT_NE(factory, nullptr);

  struct DummyPCObserver : public webrtc::PeerConnectionObserver {
    void OnSignalingChange(
        webrtc::PeerConnectionInterface::SignalingState) override {}
    void OnDataChannel(
        webrtc::scoped_refptr<webrtc::DataChannelInterface>) override {}
    void OnIceGatheringChange(
        webrtc::PeerConnectionInterface::IceGatheringState) override {}
    void OnIceCandidate(const webrtc::IceCandidate*) override {}
  };

  auto create_answer_for_offer = [&](bool include_audio_in_offer,
                                     std::string* out_answer_sdp) {
    DummyPCObserver viewer_obs;
    DummyPCObserver worker_obs;
    webrtc::PeerConnectionInterface::RTCConfiguration cfg;
    cfg.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
    cfg.bundle_policy =
        webrtc::PeerConnectionInterface::kBundlePolicyMaxBundle;

    auto viewer =
        factory->CreatePeerConnectionOrError(
            cfg, webrtc::PeerConnectionDependencies(&viewer_obs));
    auto worker =
        factory->CreatePeerConnectionOrError(
            cfg, webrtc::PeerConnectionDependencies(&worker_obs));
    ASSERT_TRUE(viewer.ok());
    ASSERT_TRUE(worker.ok());

    webrtc::RtpTransceiverInit recvonly_init;
    recvonly_init.direction = webrtc::RtpTransceiverDirection::kRecvOnly;
    ASSERT_TRUE(
        viewer.value()->AddTransceiver(webrtc::MediaType::VIDEO, recvonly_init).ok());
    if (include_audio_in_offer) {
      ASSERT_TRUE(
          viewer.value()->AddTransceiver(webrtc::MediaType::AUDIO, recvonly_init).ok());
    }

    auto audio_source = factory->CreateAudioSource(MakeDesktopAudioOptions());
    ASSERT_NE(audio_source, nullptr);
    auto audio_track =
        factory->CreateAudioTrack("imcodes-audio", audio_source.get());
    ASSERT_NE(audio_track, nullptr);
    audio_track->set_enabled(false);
    ASSERT_TRUE(
        worker.value()->AddTrack(audio_track, {"imcodes-remote-desktop"}).ok());

    struct OfferCb : public webrtc::CreateSessionDescriptionObserver {
      std::mutex mu;
      std::condition_variable cv;
      bool done = false;
      std::string sdp;
      void OnSuccess(webrtc::SessionDescriptionInterface* desc) override {
        std::unique_ptr<webrtc::SessionDescriptionInterface> owned(desc);
        std::lock_guard<std::mutex> lock(mu);
        if (owned) owned->ToString(&sdp);
        done = true;
        cv.notify_all();
      }
      void OnFailure(webrtc::RTCError) override {
        std::lock_guard<std::mutex> lock(mu);
        done = true;
        cv.notify_all();
      }
    };
    struct SetCb : public webrtc::SetRemoteDescriptionObserverInterface {
      std::mutex mu;
      std::condition_variable cv;
      bool done = false;
      bool ok = false;
      void OnSetRemoteDescriptionComplete(webrtc::RTCError err) override {
        std::lock_guard<std::mutex> lock(mu);
        ok = err.ok();
        done = true;
        cv.notify_all();
      }
    };

    auto offer_cb = webrtc::make_ref_counted<OfferCb>();
    viewer.value()->CreateOffer(
        offer_cb.get(),
        webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
    {
      std::unique_lock<std::mutex> lock(offer_cb->mu);
      ASSERT_TRUE(offer_cb->cv.wait_for(lock, std::chrono::seconds(5),
                                        [&] { return offer_cb->done; }));
    }
    ASSERT_FALSE(offer_cb->sdp.empty());

    webrtc::SdpParseError parse_err;
    auto offer = webrtc::CreateSessionDescription(webrtc::SdpType::kOffer,
                                                  offer_cb->sdp, &parse_err);
    ASSERT_NE(offer, nullptr);
    auto set_cb = webrtc::make_ref_counted<SetCb>();
    worker.value()->SetRemoteDescription(std::move(offer), set_cb);
    {
      std::unique_lock<std::mutex> lock(set_cb->mu);
      ASSERT_TRUE(set_cb->cv.wait_for(lock, std::chrono::seconds(5),
                                      [&] { return set_cb->done; }));
      ASSERT_TRUE(set_cb->ok);
    }

    auto ans_cb = webrtc::make_ref_counted<OfferCb>();
    worker.value()->CreateAnswer(
        ans_cb.get(), webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
    {
      std::unique_lock<std::mutex> lock(ans_cb->mu);
      ASSERT_TRUE(ans_cb->cv.wait_for(lock, std::chrono::seconds(5),
                                      [&] { return ans_cb->done; }));
    }
    *out_answer_sdp = ans_cb->sdp;
    worker.value()->Close();
    viewer.value()->Close();
  };

  std::string modern_answer;
  create_answer_for_offer(/*include_audio_in_offer=*/true, &modern_answer);
  EXPECT_NE(modern_answer.find("m=audio "), std::string::npos);
  EXPECT_NE(modern_answer.find("opus/48000/2"), std::string::npos);

  // Older viewer offering only m=video must still negotiate cleanly!
  std::string legacy_answer;
  create_answer_for_offer(/*include_audio_in_offer=*/false, &legacy_answer);
  EXPECT_NE(legacy_answer.find("m=video "), std::string::npos);
  EXPECT_EQ(legacy_answer.find("m=audio "), std::string::npos);

  factory = nullptr;
  signaling_thread->Stop();
  worker_thread->Stop();
  network_thread->Stop();
  webrtc::CleanupSSL();
}

}  // namespace
}  // namespace imcodes::rd
