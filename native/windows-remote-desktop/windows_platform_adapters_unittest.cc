#include "third_party/imcodes_remote_desktop/windows_platform_adapters.h"

#include <gtest/gtest.h>

#include "third_party/imcodes_remote_desktop/worker_policy.h"

namespace imcodes::rd {
namespace {

class FakeVideoEncoderFactory final : public webrtc::VideoEncoderFactory {
 public:
  explicit FakeVideoEncoderFactory(bool h264) : h264_(h264) {}

  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return h264_ ? std::vector<webrtc::SdpVideoFormat>{webrtc::SdpVideoFormat(
                       "H264")}
                 : std::vector<webrtc::SdpVideoFormat>{
                       webrtc::SdpVideoFormat("VP8")};
  }

  CodecSupport QueryCodecSupport(
      const webrtc::SdpVideoFormat &, std::optional<std::string>,
      std::optional<webrtc::Resolution>) const override {
    return {};
  }

  std::unique_ptr<webrtc::VideoEncoder> Create(
      const webrtc::Environment &, const webrtc::SdpVideoFormat &) override {
    return nullptr;
  }

 private:
  bool h264_;
};

DisplayInfo GeometryFixture() {
  DisplayInfo display;
  display.id = "display-a";
  display.label = "Display A";
  display.device_name = L"\\\\.\\DISPLAY1";
  display.desktop_rect = RECT{-1920, 100, 0, 1180};
  display.width = 3840;
  display.height = 2160;
  display.dpi_scale = 2.0;
  display.rotation_degrees = 90;
  display.available = true;
  return display;
}

TEST(WindowsPlatformAdaptersTest,
     KeepsEncodedPixelsSeparateFromLogicalInputBounds) {
  const DisplayInfo display = GeometryFixture();
  const common::DisplayTopology topology = ToCommonDisplayTopology(display, 9);
  ASSERT_TRUE(topology.IsValid());
  EXPECT_EQ(topology.encoded_pixels.width, 3840u);
  EXPECT_EQ(topology.encoded_pixels.height, 2160u);
  EXPECT_DOUBLE_EQ(topology.logical_input_bounds.x, -1920.0);
  EXPECT_DOUBLE_EQ(topology.logical_input_bounds.y, 100.0);
  EXPECT_DOUBLE_EQ(topology.logical_input_bounds.width, 1920.0);
  EXPECT_DOUBLE_EQ(topology.logical_input_bounds.height, 1080.0);
  EXPECT_EQ(topology.rotation, common::DisplayRotation::k90);
}

TEST(WindowsPlatformAdaptersTest,
     DxgiTrackAdapterPreservesTheProductionSourceObject) {
  const DisplayInfo display = GeometryFixture();
  int acquires = 0;
  int releases = 0;
  std::string released_id;
  webrtc::VideoTrackSourceInterface *acquired_source = nullptr;
  WindowsDxgiCaptureTrackAdapter adapter(
      [&](const common::DisplayTopology &requested) {
        ++acquires;
        EXPECT_EQ(requested.display_id, display.id);
        auto source = DxgiDesktopSource::Create(display);
        acquired_source = source.get();
        return source;
      },
      [&](const DisplayInfo &released) {
        ++releases;
        released_id = released.id;
      });

  EXPECT_EQ(adapter.ProbeReadiness(), common::ReadinessState::kReady);
  auto source = adapter.Acquire(ToCommonDisplayTopology(display, 1));
  ASSERT_TRUE(source);
  EXPECT_EQ(acquires, 1);
  EXPECT_EQ(source->display_id(), display.id);
  EXPECT_EQ(source->source_identity(), DisplaySourceKey(display));
  EXPECT_EQ(source->source(), acquired_source);
  source.reset();
  EXPECT_FALSE(source);
  EXPECT_EQ(releases, 1);
  EXPECT_EQ(released_id, display.id);
}

TEST(WindowsPlatformAdaptersTest,
     DxgiTrackAdapterFailsClosedWithoutBothPoolCallbacks) {
  WindowsDxgiCaptureTrackAdapter missing_release(
      [](const common::DisplayTopology &) {
        return DxgiDesktopSource::Create(GeometryFixture());
      },
      {});
  EXPECT_EQ(missing_release.ProbeReadiness(),
            common::ReadinessState::kUnavailable);
  EXPECT_FALSE(missing_release.Acquire(
      ToCommonDisplayTopology(GeometryFixture(), 1)));

  DisplayInfo unavailable = GeometryFixture();
  unavailable.available = false;
  int acquires = 0;
  WindowsDxgiCaptureTrackAdapter ready(
      [&](const common::DisplayTopology &) {
        ++acquires;
        return DxgiDesktopSource::Create(GeometryFixture());
      },
      [](const DisplayInfo &) {});
  EXPECT_FALSE(ready.Acquire(ToCommonDisplayTopology(unavailable, 1)));
  EXPECT_EQ(acquires, 0);
}

TEST(WindowsPlatformAdaptersTest,
     EncoderFactoryAdapterRequiresTheProductionH264FactorySeam) {
  WindowsWebRtcEncoderFactoryAdapter ready(
      std::make_unique<FakeVideoEncoderFactory>(true));
  WindowsWebRtcEncoderFactoryAdapter wrong_codec(
      std::make_unique<FakeVideoEncoderFactory>(false));
  WindowsWebRtcEncoderFactoryAdapter missing(nullptr);

  EXPECT_EQ(ready.ProbeReadiness(), common::ReadinessState::kReady);
  auto factory = ready.TakeFactory();
  ASSERT_TRUE(factory);
  EXPECT_EQ(ready.ProbeReadiness(), common::ReadinessState::kUnavailable);
  EXPECT_FALSE(ready.TakeFactory());
  EXPECT_EQ(wrong_codec.ProbeReadiness(), common::ReadinessState::kUnavailable);
  EXPECT_EQ(missing.ProbeReadiness(), common::ReadinessState::kUnavailable);
}

TEST(WindowsPlatformAdaptersTest, EnumeratesOneGenerationFencedTopology) {
  std::vector<DisplayInfo> displays{GeometryFixture()};
  WindowsDisplayAdapter adapter(
      [&]() -> const std::vector<DisplayInfo> & { return displays; });
  adapter.SetTopologyVersion(12, 4);
  const auto topology = adapter.EnumerateTopology();
  ASSERT_TRUE(topology.has_value());
  EXPECT_EQ(topology->generation, 12u);
  EXPECT_EQ(topology->revision, 4u);
  ASSERT_EQ(topology->displays.size(), 1u);
  EXPECT_TRUE(adapter.SelectDisplay("display-a"));
  EXPECT_FALSE(adapter.SelectDisplay("missing"));
}

TEST(WindowsPlatformAdaptersTest, ClipboardAdapterIsExplicitAndBounded) {
  std::vector<INPUT> emitted;
  InputArbiter input([&](UINT count, LPINPUT values, int) {
    emitted.insert(emitted.end(), values, values + count);
    return count;
  });
  int reads = 0;
  WindowsClipboardAdapter adapter(
      input, [] { return 7; },
      [&](DWORD previous) -> std::optional<std::u16string> {
        EXPECT_EQ(previous, 7u);
        ++reads;
        return reads < 2 ? std::nullopt
                         : std::optional<std::u16string>(u"selected");
      },
      "clipboard-controller");
  std::string copied;
  EXPECT_EQ(adapter.ProbeReadiness(), common::ReadinessState::kReady);
  EXPECT_TRUE(adapter.CopySelection(&copied));
  EXPECT_EQ(copied, "selected");
  EXPECT_EQ(reads, 2);
  EXPECT_FALSE(emitted.empty());
}

TEST(WindowsPlatformAdaptersTest,
     MapsWindowsGraphicalSessionEventsWithoutConsumingDisplayEvents) {
  EXPECT_EQ(ToCommonGraphicalSessionEvent(kEnvironmentSessionLocked),
            common::GraphicalSessionEvent::kLocked);
  EXPECT_EQ(ToCommonGraphicalSessionEvent(kEnvironmentSessionUnlocked),
            common::GraphicalSessionEvent::kUnlocked);
  EXPECT_EQ(ToCommonGraphicalSessionEvent(kEnvironmentSessionUnavailable),
            common::GraphicalSessionEvent::kUserChanged);
  EXPECT_EQ(ToCommonGraphicalSessionEvent(kEnvironmentSuspend),
            common::GraphicalSessionEvent::kSleeping);
  EXPECT_EQ(ToCommonGraphicalSessionEvent(kEnvironmentResume),
            common::GraphicalSessionEvent::kWoke);
  EXPECT_FALSE(
      ToCommonGraphicalSessionEvent(kEnvironmentDisplayChanged).has_value());
  EXPECT_FALSE(ToCommonGraphicalSessionEvent(kEnvironmentCompositionChanged)
                   .has_value());
  EXPECT_EQ(WindowsEnvironmentMask(common::GraphicalSessionEvent::kLocked),
            kEnvironmentSessionLocked);
  EXPECT_EQ(WindowsEnvironmentMask(common::GraphicalSessionEvent::kEnded),
            kEnvironmentSessionUnavailable);
}

TEST(WindowsPlatformAdaptersTest,
     DisclosureAndSessionMonitorShareOneBoundedLifecycle) {
  WindowsEnvironmentSink environment_sink;
  int starts = 0;
  int hides = 0;
  int stops = 0;
  int shows = 0;
  std::uint32_t shown_viewers = 0;
  std::uint32_t shown_controllers = 0;
  std::vector<std::uint32_t> residual_events;
  std::vector<common::GraphicalSessionEvent> session_events;
  WindowsDisclosureSessionAdapter adapter(
      [&](WindowsEnvironmentSink sink) {
        ++starts;
        environment_sink = std::move(sink);
        return true;
      },
      [&](std::uint32_t viewers, std::uint32_t controllers) {
        ++shows;
        shown_viewers = viewers;
        shown_controllers = controllers;
        return true;
      },
      [&] { ++hides; }, [&] { ++stops; },
      [&](std::uint32_t event) { residual_events.push_back(event); });

  EXPECT_EQ(adapter.ProbeReadiness(), common::ReadinessState::kUnknown);
  EXPECT_TRUE(adapter.Start([&](common::GraphicalSessionEvent event) {
    session_events.push_back(event);
  }));
  EXPECT_EQ(starts, 1);
  EXPECT_EQ(adapter.ProbeReadiness(), common::ReadinessState::kReady);
  EXPECT_TRUE(adapter.Show(3, 2));
  EXPECT_EQ(shows, 1);
  EXPECT_EQ(shown_viewers, 3u);
  EXPECT_EQ(shown_controllers, 2u);
  EXPECT_FALSE(adapter.Show(0, 0));
  EXPECT_FALSE(adapter.Show(1, 2));

  ASSERT_TRUE(environment_sink);
  environment_sink(kEnvironmentSessionLocked);
  environment_sink(kEnvironmentDisplayChanged);
  ASSERT_EQ(session_events.size(), 1u);
  EXPECT_EQ(session_events.front(), common::GraphicalSessionEvent::kLocked);
  ASSERT_EQ(residual_events.size(), 1u);
  EXPECT_EQ(residual_events.front(), kEnvironmentDisplayChanged);

  adapter.Hide();
  EXPECT_EQ(hides, 1);
  adapter.Stop();
  adapter.Stop();
  EXPECT_EQ(stops, 1);
  EXPECT_EQ(adapter.ProbeReadiness(), common::ReadinessState::kUnknown);
}

TEST(WindowsPlatformAdaptersTest,
     FailedSessionMonitorStartIsStoppedBeforeRetry) {
  WindowsEnvironmentSink first_sink;
  int starts = 0;
  int stops = 0;
  WindowsDisclosureSessionAdapter adapter(
      [&](WindowsEnvironmentSink sink) {
        ++starts;
        first_sink = std::move(sink);
        return starts > 1;
      },
      [](std::uint32_t, std::uint32_t) { return true; }, [] {},
      [&] { ++stops; }, [](std::uint32_t) {});
  const auto observer = [](common::GraphicalSessionEvent) {};

  EXPECT_FALSE(adapter.Start(observer));
  EXPECT_TRUE(first_sink);
  EXPECT_EQ(stops, 1);
  EXPECT_EQ(adapter.ProbeReadiness(), common::ReadinessState::kUnknown);
  EXPECT_TRUE(adapter.Start(observer));
  EXPECT_EQ(starts, 2);
  EXPECT_EQ(stops, 1);
  adapter.Stop();
  EXPECT_EQ(stops, 2);
}

}  // namespace
}  // namespace imcodes::rd
