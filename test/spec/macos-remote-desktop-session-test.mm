#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <condition_variable>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "macos_remote_desktop_session.h"

namespace macos = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition) return;
  std::cerr << "macOS remote-desktop session failure: " << message << '\n';
  std::exit(1);
}

class FrameBytes final : public common::FrameStorage {
 public:
  explicit FrameBytes(std::size_t size) : bytes_(size) {}
  const std::byte* data() const noexcept override { return bytes_.data(); }
  std::size_t size() const noexcept override { return bytes_.size(); }

 private:
  std::vector<std::byte> bytes_;
};

common::CapturedFrame Frame(common::PixelSize pixels) {
  const std::uint32_t row_bytes = pixels.width * 4;
  return {
      .encoded_pixels = pixels,
      .pixel_format = common::PixelFormat::kBgra8888,
      .row_bytes = row_bytes,
      .capture_time_us = 10,
      .color_primaries = common::ColorPrimaries::kBt709,
      .storage = std::make_shared<FrameBytes>(static_cast<std::size_t>(row_bytes) * pixels.height),
  };
}

common::DesktopTopology Topology(common::TopologyRevision revision, double secondary_scale = 2.0) {
  return {
      .generation = 77,
      .revision = revision,
      .displays =
          {
              {.display_id = "display-a",
               .generation = 77,
               .encoded_pixels = {1920, 1080},
               .logical_input_bounds = {0, 0, 960, 540},
               .scale = 2.0,
               .rotation = common::DisplayRotation::k0,
               .operations = {.selectable = true}},
              {.display_id = "display-b",
               .generation = 77,
               .encoded_pixels = {2560, 1440},
               .logical_input_bounds = {960, 0, 1280, 720},
               .scale = secondary_scale,
               .rotation = common::DisplayRotation::k0,
               .operations = {.selectable = true}},
          },
  };
}

class FakeCapture final : public common::CaptureAdapter {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  bool Start(const common::DisplayTopology& display, common::CapturedFrameSink next_sink) override {
    ++start_count;
    started_display = display.display_id;
    sink = std::move(next_sink);
    return start_result;
  }
  void Stop() noexcept override {
    ++stop_count;
    sink = {};
  }
  void Emit(common::PixelSize pixels) {
    if (sink) sink(Frame(pixels));
  }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  common::CapturedFrameSink sink;
  std::string started_display;
  int start_count = 0;
  int stop_count = 0;
  bool start_result = true;
};

class FakeEncoder final : public common::EncoderAdapter {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  bool Configure(const common::EncoderConfiguration& next_configuration,
                 common::H264AccessUnitSink next_sink) override {
    ++configure_count;
    configuration = next_configuration;
    sink = std::move(next_sink);
    return configure_result;
  }
  bool Encode(common::CapturedFrame frame, bool) override {
    ++encode_count;
    if (!encode_result || !frame.IsValid() || !sink) return false;
    sink({.bytes = {std::byte{0x01}},
          .presentation_time_us = frame.capture_time_us,
          .profile = configuration.profile,
          .keyframe = encode_count == 1});
    return true;
  }
  void Stop() noexcept override {
    ++stop_count;
    sink = {};
  }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  common::EncoderConfiguration configuration;
  common::H264AccessUnitSink sink;
  int configure_count = 0;
  int encode_count = 0;
  int stop_count = 0;
  bool configure_result = true;
  bool encode_result = true;
};

class FakeInput final : public common::InputAdapter {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  bool MovePointer(const common::LogicalPoint& point) override {
    points.push_back(point);
    return true;
  }
  bool EmitKey(std::string_view key, bool pressed) override {
    if (!key_result) return false;
    keys.emplace_back(std::string(key), pressed);
    if (pressed)
      held_keys.insert(std::string(key));
    else
      held_keys.erase(std::string(key));
    return true;
  }
  bool EmitButton(std::string_view button, bool pressed) override {
    buttons.emplace_back(std::string(button), pressed);
    if (pressed)
      held_buttons.insert(std::string(button));
    else
      held_buttons.erase(std::string(button));
    return true;
  }
  bool EmitWheel(double, double) override { return true; }
  bool EmitText(std::string_view) override { return true; }
  void ReleaseAllEmittedState() noexcept override {
    ++release_all_count;
    for (const std::string& key : held_keys) keys.emplace_back(key, false);
    for (const std::string& button : held_buttons) buttons.emplace_back(button, false);
    held_keys.clear();
    held_buttons.clear();
  }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  std::vector<common::LogicalPoint> points;
  std::vector<std::pair<std::string, bool>> keys;
  std::vector<std::pair<std::string, bool>> buttons;
  std::set<std::string> held_keys;
  std::set<std::string> held_buttons;
  int release_all_count = 0;
  bool key_result = true;
};

class FakeClipboard final : public common::ClipboardAdapter {
 public:
  enum class BlockingOperation {
    kNone,
    kPasteText,
    kCopySelection,
  };

  common::ReadinessState ProbeReadiness() override { return readiness; }
  bool PasteText(std::string_view text) override {
    WaitIfBlocked(BlockingOperation::kPasteText);
    pasted = std::string(text);
    return true;
  }
  bool CopySelection(std::string* text) override {
    WaitIfBlocked(BlockingOperation::kCopySelection);
    *text = "selected";
    return true;
  }

  void Block(BlockingOperation operation) {
    std::lock_guard lock(block_mutex_);
    blocked_operation_ = operation;
    entered_ = false;
    released_ = false;
  }

  bool WaitUntilEntered(std::chrono::milliseconds timeout) {
    std::unique_lock lock(block_mutex_);
    return block_condition_.wait_for(lock, timeout,
                                     [this]() { return entered_; });
  }

  void Release() {
    {
      std::lock_guard lock(block_mutex_);
      released_ = true;
    }
    block_condition_.notify_all();
  }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  std::string pasted;

 private:
  void WaitIfBlocked(BlockingOperation operation) {
    std::unique_lock lock(block_mutex_);
    if (blocked_operation_ != operation) return;
    entered_ = true;
    block_condition_.notify_all();
    block_condition_.wait(lock, [this]() { return released_; });
    blocked_operation_ = BlockingOperation::kNone;
  }

  std::mutex block_mutex_;
  std::condition_variable block_condition_;
  BlockingOperation blocked_operation_ = BlockingOperation::kNone;
  bool entered_ = false;
  bool released_ = false;
};

class FakeDisplay final : public common::DisplayAdapter {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  std::optional<common::DesktopTopology> EnumerateTopology() override {
    ++enumerate_count;
    return topology;
  }
  bool SelectDisplay(std::string_view id) override {
    ++select_count;
    selected = std::string(id);
    return select_result;
  }
  bool SetMode(std::string_view, common::PixelSize) override { return false; }
  bool SetScale(std::string_view, double) override { return false; }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  std::optional<common::DesktopTopology> topology = Topology(10);
  std::string selected;
  int enumerate_count = 0;
  int select_count = 0;
  bool select_result = true;
};

class FakeDisclosure final : public common::DisclosureAdapter {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  bool Show(std::uint32_t viewers, std::uint32_t controllers) override {
    shows.emplace_back(viewers, controllers);
    visible = show_result;
    return show_result;
  }
  void Hide() noexcept override {
    ++hide_count;
    visible = false;
  }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  std::vector<std::pair<std::uint32_t, std::uint32_t>> shows;
  int hide_count = 0;
  bool show_result = true;
  bool visible = false;
};

class FakeMonitor final : public common::SessionMonitor {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  bool Start(Observer next_observer) override {
    ++start_count;
    observer = std::move(next_observer);
    return start_result;
  }
  void Stop() noexcept override { ++stop_count; }
  void Fire(common::GraphicalSessionEvent event) {
    if (observer) observer(event);
  }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  Observer observer;
  int start_count = 0;
  int stop_count = 0;
  bool start_result = true;
};

class FakeMediaSender final : public macos::MacosEncodedMediaSender {
 public:
  bool Start(common::WorkerGeneration generation, common::PixelSize pixels,
             common::H264Profile) override {
    ++start_count;
    active_generation = generation;
    active_pixels = pixels;
    return start_result;
  }
  bool Submit(common::WorkerGeneration generation, common::H264AccessUnit unit) override {
    ++submit_count;
    last_unit = std::move(unit);
    return submit_result && generation == active_generation;
  }
  void Stop() noexcept override { ++stop_count; }

  common::WorkerGeneration active_generation = 0;
  common::PixelSize active_pixels;
  common::H264AccessUnit last_unit;
  int start_count = 0;
  int submit_count = 0;
  int stop_count = 0;
  bool start_result = true;
  bool submit_result = true;
};

class FakeLifecycle final : public macos::MacosSessionLifecycle {
 public:
  bool BeginGeneration(common::WorkerGeneration generation) override {
    ++begin_count;
    begun_generation = generation;
    return begin_result;
  }
  bool BindInputTopology(const common::DesktopTopology& topology,
                         std::string_view display_id) override {
    bound_revisions.push_back(topology.revision);
    bound_displays.emplace_back(display_id);
    return bind_result;
  }
  void EndGeneration(macos::MacosSessionEndReason reason) noexcept override {
    ++end_count;
    end_reason = reason;
  }

  common::WorkerGeneration begun_generation = 0;
  std::vector<common::TopologyRevision> bound_revisions;
  std::vector<std::string> bound_displays;
  macos::MacosSessionEndReason end_reason = macos::MacosSessionEndReason::kShutdown;
  int begin_count = 0;
  int end_count = 0;
  bool begin_result = true;
  bool bind_result = true;
};

class FakeReadinessGate final : public macos::MacosSessionReadinessGate {
 public:
  common::CapabilityReadiness Constrain(common::CapabilityReadiness observed) override {
    if (remove_capture) observed.capture = common::ReadinessState::kUnavailable;
    if (remove_input) observed.input = common::ReadinessState::kUnavailable;
    return observed;
  }
  bool remove_capture = false;
  bool remove_input = false;
};

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

class FakeTransport final : public common::TransportSessionAdapter {
 public:
  bool StartTransport(const common::RouteAuthority& authority) override {
    ++start_count;
    started_authority = authority;
    events.push_back("start");
    return start_result;
  }
  bool AddRemoteIceCandidate(const common::IceCandidate& candidate) override {
    ++remote_ice_count;
    last_remote_ice = candidate;
    return true;
  }
  bool EmitLocalIceCandidate(const common::IceCandidate& candidate) override {
    ++local_ice_count;
    last_local_ice = candidate;
    return true;
  }
  bool ApplyQuality(const common::QualitySelection& selection) override {
    ++quality_count;
    last_quality = selection;
    return true;
  }
  void ReleaseControlAuthority(const common::RouteAuthorityIdentity& identity,
                               std::uint64_t input_epoch) noexcept override {
    released_identity = identity;
    released_epoch = input_epoch;
    events.push_back("release");
  }
  void CloseDataChannel(common::DataChannelKind channel) noexcept override {
    events.push_back(std::string("close:") + ChannelName(channel));
  }
  void CloseTransport() noexcept override {
    ++close_count;
    events.push_back("close:transport");
  }
  void PublishDiagnostics(const common::TransportDiagnostics& diagnostics) noexcept override {
    published.push_back(diagnostics);
  }
  void OnTerminal(common::TransportTerminalReason reason) noexcept override {
    ++terminal_count;
    terminal_reason = reason;
    events.push_back("terminal");
  }

  common::RouteAuthority started_authority;
  common::RouteAuthorityIdentity released_identity;
  std::vector<common::TransportDiagnostics> published;
  std::vector<std::string> events;
  std::uint64_t released_epoch = 0;
  common::TransportTerminalReason terminal_reason = common::TransportTerminalReason::kNone;
  int start_count = 0;
  int close_count = 0;
  int terminal_count = 0;
  int remote_ice_count = 0;
  int local_ice_count = 0;
  int quality_count = 0;
  common::IceCandidate last_remote_ice;
  common::IceCandidate last_local_ice;
  common::QualitySelection last_quality;
  bool start_result = true;
};

struct Fixture {
  FakeCapture capture;
  FakeEncoder encoder;
  FakeInput input;
  FakeClipboard clipboard;
  FakeDisplay display;
  FakeDisclosure disclosure;
  FakeMonitor monitor;
  FakeMediaSender sender;
  FakeLifecycle lifecycle;
  FakeReadinessGate readiness_gate;
  FakeTransport transport;
  std::vector<macos::MacosRemoteDesktopSessionEvent> events;
  common::PlatformAdapters adapters{capture, encoder,    input,  clipboard,
                                    display, disclosure, monitor};
  macos::MacosRemoteDesktopSessionDependencies dependencies{
      .adapters = adapters,
      .media_sender = sender,
      .lifecycle = lifecycle,
      .readiness_gate = readiness_gate,
      .transport = &transport,
      .negotiate_offer = {},
  };
  macos::MacosRemoteDesktopSession session{
      dependencies,
      [this](const macos::MacosRemoteDesktopSessionEvent& event) { events.push_back(event); }};
};

macos::MacosRemoteDesktopStartRequest Request(std::uint32_t controllers = 1) {
  const common::TransportSessionMode mode = controllers > 0 ? common::TransportSessionMode::kControl
                                                            : common::TransportSessionMode::kView;
  return {
      .worker_generation = 77,
      .preferred_display_id = "display-a",
      .viewers = 2,
      .controllers = controllers,
      .video = {.frame_rate = 30, .bitrate_bps = 3'000'000},
      .route_authority =
          common::RouteAuthority{.identity = {.request_id = "request-macos-77",
                                              .session_id = "session-macos-77",
                                              .negotiated_capability_binding = "macos-profile-hash",
                                              .daemon_generation = 77,
                                              .route_generation = 5},
                                 .expires_at_unix_ms = 10'000,
                                 .lease_expires_at_unix_ms = 5'000,
                                 .mode = mode,
                                 .input_epoch = mode == common::TransportSessionMode::kControl
                                                    ? std::uint64_t{7}
                                                    : std::uint64_t{0}},
      .authority_now = {.unix_ms = 100, .monotonic_ms = 100},
  };
}

common::TransportCallbackStamp StampFor(const macos::MacosRemoteDesktopStartRequest& request) {
  return {request.route_authority->identity.daemon_generation,
          request.route_authority->identity.route_generation};
}

void ConnectTransport(Fixture& fixture, const macos::MacosRemoteDesktopStartRequest& request) {
  const common::TransportCallbackStamp stamp = StampFor(request);
  Require(fixture.session.OnPeerConnectionState(stamp, common::PeerConnectionState::kConnecting,
                                                {.unix_ms = 110, .monotonic_ms = 110}) &&
              fixture.session.OnPeerConnectionState(stamp, common::PeerConnectionState::kConnected,
                                                    {.unix_ms = 120, .monotonic_ms = 120}),
          "real transport callbacks must connect through the common core");
  for (const common::DataChannelKind channel :
       {common::DataChannelKind::kControl, common::DataChannelKind::kKeyboard,
        common::DataChannelKind::kPointer}) {
    Require(fixture.session.OnDataChannelState(stamp, channel, common::DataChannelState::kOpen),
            "every required data channel must enter the common core");
  }
  Require(fixture.session.SetControlActive(true, {.unix_ms = 130, .monotonic_ms = 130}),
          "Control must become available only after transport readiness");
}

common::InputStamp Stamp(common::InputSequence sequence, common::TopologyRevision revision) {
  return {.controller_id = "controller-a",
          .epoch = 1,
          .sequence = sequence,
          .topology_revision = revision};
}

void TestViewOnlyStartsAndFeedsExistingMediaSeams() {
  Fixture fixture;
  fixture.readiness_gate.remove_input = true;
  macos::MacosRemoteDesktopStartRequest request = Request();
  request.route_authority->mode = common::TransportSessionMode::kView;
  request.route_authority->input_epoch = 0;
  Require(fixture.session.Start(request), "view-only session should start");
  Require(fixture.session.state() == common::SessionState::kViewing,
          "missing Accessibility must downgrade to View");
  Require(fixture.disclosure.shows.front() == std::pair<std::uint32_t, std::uint32_t>{2, 0},
          "disclosure must be visible with zero controllers before media");
  Require(fixture.capture.start_count == 1 && fixture.encoder.configure_count == 1 &&
              fixture.sender.start_count == 1 && fixture.transport.start_count == 1 &&
              fixture.transport.started_authority.mode == common::TransportSessionMode::kView,
          "capture, VideoToolbox seam and pinned sender seam must all start");
  fixture.capture.Emit({1920, 1080});
  Require(fixture.encoder.encode_count == 1 && fixture.sender.submit_count == 1,
          "one captured frame must reach encoder and existing sender bridge");
  Require(!fixture.sender.last_unit.bytes.empty(),
          "sender must receive an encoded access unit, not a custom packet");
  Require(!fixture.session.PasteText("view cannot paste"),
          "View-only authority must not reach explicit clipboard injection");
  Require(
      fixture.events.size() >= 2 &&
          fixture.events[0].type == macos::MacosRemoteDesktopSessionEventType::kStartedViewing &&
          fixture.events[1].type == macos::MacosRemoteDesktopSessionEventType::kControlDowngraded,
      "start and truthful view-only downgrade events must be emitted");
}

void TestPermissionLossReleasesHeldInputAndDowngrades() {
  Fixture fixture;
  const macos::MacosRemoteDesktopStartRequest request = Request();
  Require(fixture.session.Start(request), "Control fixture should start");
  ConnectTransport(fixture, request);
  Require(fixture.session.state() == common::SessionState::kControlling,
          "complete readiness should permit Control");
  Require(fixture.session.PasteText("control paste") && fixture.clipboard.pasted == "control paste",
          "explicit clipboard remains available only to Control authority");
  const common::TopologyRevision revision = fixture.session.topology()->revision;
  Require(fixture.session.ApplyKey({Stamp(1, revision), "ShiftLeft", true}) ==
              common::InputResult::kApplied,
          "held key fixture should reach the common InputLedger");
  fixture.readiness_gate.remove_input = true;
  Require(fixture.session.RefreshReadiness(), "capture-ready permission loss should preserve View");
  Require(fixture.session.state() == common::SessionState::kViewing,
          "permission loss must downgrade Control to View");
  Require(fixture.input.keys.size() == 2 && !fixture.input.keys.back().second &&
              fixture.input.release_all_count == 1,
          "downgrade must release the physical key and backend state");
  Require(fixture.disclosure.shows.back().second == 0,
          "local disclosure must immediately remove controller count");
}

void TestStopDoesNotWaitForBlockingClipboardOperation(
    FakeClipboard::BlockingOperation operation) {
  using namespace std::chrono_literals;

  Fixture fixture;
  const macos::MacosRemoteDesktopStartRequest request = Request();
  Require(fixture.session.Start(request),
          "blocking clipboard fixture should start");
  ConnectTransport(fixture, request);
  fixture.clipboard.Block(operation);

  std::atomic<bool> clipboard_result = false;
  std::string copied;
  std::thread clipboard_thread([&]() {
    clipboard_result.store(
        operation == FakeClipboard::BlockingOperation::kPasteText
            ? fixture.session.PasteText("blocking paste")
            : fixture.session.CopySelection(&copied),
        std::memory_order_release);
  });

  const bool clipboard_entered = fixture.clipboard.WaitUntilEntered(1s);
  if (!clipboard_entered) {
    fixture.clipboard.Release();
    clipboard_thread.join();
    Require(false, "clipboard operation must reach the blocking adapter");
  }

  std::promise<void> stop_completed;
  std::future<void> stop_completion = stop_completed.get_future();
  std::thread stop_thread([&]() {
    fixture.session.Stop();
    stop_completed.set_value();
  });
  const std::future_status stop_status = stop_completion.wait_for(1s);

  // Always release and join before asserting so the old lock-held
  // implementation fails behaviorally instead of hanging the test process.
  fixture.clipboard.Release();
  clipboard_thread.join();
  stop_thread.join();

  Require(stop_status == std::future_status::ready,
          operation == FakeClipboard::BlockingOperation::kPasteText
              ? "Stop must not wait for a blocking PasteText adapter"
              : "Stop must not wait for a blocking CopySelection adapter");
  Require(clipboard_result.load(std::memory_order_acquire),
          "released clipboard operation should finish cleanly");
  Require(fixture.session.state() == common::SessionState::kTerminal,
          "Stop must still terminate the session while clipboard work is in flight");
}

void TestStopDoesNotWaitForBlockingClipboardAdapters() {
  TestStopDoesNotWaitForBlockingClipboardOperation(
      FakeClipboard::BlockingOperation::kPasteText);
  TestStopDoesNotWaitForBlockingClipboardOperation(
      FakeClipboard::BlockingOperation::kCopySelection);
}

void TestMonitorSelectionPublishesRevisionAndRejectsStaleInput() {
  Fixture fixture;
  const macos::MacosRemoteDesktopStartRequest request = Request();
  Require(fixture.session.Start(request), "monitor fixture should start");
  ConnectTransport(fixture, request);
  const common::TopologyRevision initial = fixture.session.topology()->revision;
  Require(fixture.session.SelectDisplay("display-b"),
          "second selectable monitor should be accepted");
  const common::TopologyRevision selected = fixture.session.topology()->revision;
  Require(selected > initial && fixture.display.selected == "display-b" &&
              fixture.capture.started_display == "display-b",
          "monitor switch must publish a new revision and restart capture");
  Require(fixture.lifecycle.bound_displays.back() == "display-b" &&
              fixture.lifecycle.bound_revisions.back() == selected,
          "logical input must bind to the selected monitor revision");
  Require(fixture.session.ApplyPointerMove({Stamp(1, initial), "display-b", 0.5, 0.5}) ==
              common::InputResult::kStaleTopology,
          "input stamped with the old monitor revision must be rejected");

  fixture.display.topology = Topology(11, 1.5);
  Require(fixture.session.RefreshTopology(), "new backend topology should refresh");
  Require(fixture.session.topology()->revision > selected &&
              fixture.session.selected_display_id() == "display-b",
          "topology refresh must remain monotonic and preserve valid selection");
  Require(fixture.sender.start_count == 3 && fixture.capture.start_count == 3,
          "selection and topology changes must restart the bounded media path");
}

void TestLifecycleBoundaryPerformsTerminalCleanupOnce() {
  Fixture fixture;
  const macos::MacosRemoteDesktopStartRequest request = Request();
  Require(fixture.session.Start(request), "lifecycle fixture should start");
  ConnectTransport(fixture, request);
  const common::TopologyRevision revision = fixture.session.topology()->revision;
  Require(fixture.session.ApplyButton({Stamp(1, revision), "primary", true}) ==
              common::InputResult::kApplied,
          "terminal fixture should hold a pointer button");
  fixture.monitor.Fire(common::GraphicalSessionEvent::kLocked);
  Require(fixture.session.state() == common::SessionState::kTerminal &&
              fixture.session.terminal_error().code ==
                  common::TerminalErrorCode::kGraphicalSessionEnded,
          "lock must terminate the current authority generation");
  Require(fixture.lifecycle.end_count == 1 &&
              fixture.lifecycle.end_reason == macos::MacosSessionEndReason::kLocked,
          "lifecycle cleanup must receive the exact terminal reason");
  Require(fixture.capture.stop_count >= 1 && fixture.encoder.stop_count >= 1 &&
              fixture.sender.stop_count >= 1 && fixture.input.release_all_count >= 1 &&
              fixture.disclosure.hide_count == 1 && fixture.monitor.stop_count == 1,
          "terminal cleanup must stop every adapter and release input");
  Require(fixture.transport.events == std::vector<std::string>{"start", "release", "close:control",
                                                               "close:keyboard", "close:pointer",
                                                               "close:transport", "terminal"} &&
              fixture.transport.terminal_reason == common::TransportTerminalReason::kAdapterFailure,
          "common transport cleanup must revoke authority before ordered "
          "channel/transport closure and one terminal callback");
  const std::size_t event_count = fixture.events.size();
  fixture.monitor.Fire(common::GraphicalSessionEvent::kUnlocked);
  fixture.session.Stop();
  Require(fixture.lifecycle.end_count == 1 && fixture.events.size() == event_count,
          "later wake/unlock/Stop cannot revive or duplicate cleanup");
}

void TestReadinessAndMediaFailuresFailClosed() {
  Fixture not_ready;
  not_ready.readiness_gate.remove_capture = true;
  Require(!not_ready.session.Start(Request()), "missing Screen Recording must reject startup");
  Require(not_ready.session.state() == common::SessionState::kTerminal &&
              not_ready.capture.start_count == 0 && not_ready.sender.start_count == 0,
          "readiness failure must occur before media starts");

  Fixture sender_failure;
  Require(sender_failure.session.Start(Request()), "sender-failure fixture should start");
  sender_failure.sender.submit_result = false;
  sender_failure.capture.Emit({1920, 1080});
  Require(sender_failure.session.state() == common::SessionState::kTerminal &&
              sender_failure.session.terminal_error().code ==
                  common::TerminalErrorCode::kEncoderUnavailable,
          "pinned sender rejection must be terminal, never custom fallback");
}

void TestRouteAuthorityActivityModeAndExpiryUseCommonTransportCore() {
  Fixture fixture;
  macos::MacosRemoteDesktopStartRequest request = Request();
  Require(fixture.session.Start(request), "authority fixture should start");
  ConnectTransport(fixture, request);
  Require(
      fixture.session.has_transport_adapter() &&
          fixture.transport.started_authority.identity.route_generation == 5 &&
          fixture.session.transport_diagnostics().mode == common::TransportSessionMode::kControl,
      "exact authenticated generation and mode must reach common core");

  common::RouteAuthorityIdentity stale = request.route_authority->identity;
  ++stale.route_generation;
  Require(!fixture.session.RecordRouteActivity(stale, {.unix_ms = 200, .monotonic_ms = 200}),
          "stale route generation cannot refresh activity");
  Require(fixture.session.RecordRouteActivity(request.route_authority->identity,
                                              {.unix_ms = 200, .monotonic_ms = 200}),
          "matching authority must refresh common activity state");

  common::RouteAuthority renewal = *request.route_authority;
  renewal.lease_expires_at_unix_ms = 6'000;
  Require(fixture.session.RenewRouteAuthority(renewal, {.unix_ms = 300, .monotonic_ms = 300}),
          "matching increasing lease must renew through common core");
  Require(fixture.session.SetControlActive(false, {.unix_ms = 400, .monotonic_ms = 400}) &&
              fixture.session.state() == common::SessionState::kViewing &&
              fixture.transport.released_epoch == 7 &&
              fixture.session.transport_diagnostics().mode == common::TransportSessionMode::kView,
          "Control downgrade must revoke the common route/input epoch before "
          "remaining in View");
  Require(!fixture.session.TickTransport({.unix_ms = 6'000, .monotonic_ms = 6'000}) &&
              fixture.session.state() == common::SessionState::kTerminal &&
              fixture.session.transport_terminal_reason() ==
                  common::TransportTerminalReason::kLeaseExpired,
          "common lease expiry must terminate the real macOS composition");

  Fixture route_expiry;
  macos::MacosRemoteDesktopStartRequest expiring = Request();
  expiring.route_authority->expires_at_unix_ms = 5'000;
  expiring.route_authority->lease_expires_at_unix_ms = 5'000;
  Require(route_expiry.session.Start(expiring) &&
              !route_expiry.session.TickTransport({.unix_ms = 5'000, .monotonic_ms = 500}) &&
              route_expiry.session.transport_terminal_reason() ==
                  common::TransportTerminalReason::kRouteExpired,
          "absolute route expiry must remain distinct from renewable lease "
          "expiry in the macOS composition");
}

void TestTransportAdapterFailureAndCompatibilityModeFailHonestly() {
  Fixture adapter_failure;
  adapter_failure.transport.start_result = false;
  Require(!adapter_failure.session.Start(Request()) &&
              adapter_failure.session.state() == common::SessionState::kTerminal &&
              adapter_failure.capture.start_count == 0 && adapter_failure.sender.start_count == 0 &&
              adapter_failure.transport.terminal_reason ==
                  common::TransportTerminalReason::kAdapterFailure,
          "transport startup failure must terminate before capture/media");

  FakeCapture capture;
  FakeEncoder encoder;
  FakeInput input;
  FakeClipboard clipboard;
  FakeDisplay display;
  FakeDisclosure disclosure;
  FakeMonitor monitor;
  FakeMediaSender sender;
  FakeLifecycle lifecycle;
  FakeReadinessGate readiness_gate;
  common::PlatformAdapters adapters{capture, encoder,    input,  clipboard,
                                    display, disclosure, monitor};
  macos::MacosRemoteDesktopSessionDependencies dependencies{
      .adapters = adapters,
      .media_sender = sender,
      .lifecycle = lifecycle,
      .readiness_gate = readiness_gate,
      .transport = nullptr,
      .negotiate_offer = {},
  };
  macos::MacosRemoteDesktopSession compatibility(dependencies);
  macos::MacosRemoteDesktopStartRequest request = Request(0);
  request.route_authority.reset();
  Require(compatibility.Start(request) && !compatibility.has_transport_adapter() &&
              compatibility.transport_diagnostics().mode == common::TransportSessionMode::kView,
          "existing callers must retain an explicit authority-only "
          "compatibility path without claiming native transport");
  compatibility.ReportTransportFailure();
  Require(compatibility.state() == common::SessionState::kTerminal &&
              compatibility.transport_terminal_reason() ==
                  common::TransportTerminalReason::kAdapterFailure,
          "later transport failure must still fail the composition closed");

  Fixture platform_failure;
  const macos::MacosRemoteDesktopStartRequest platform_request = Request();
  Require(platform_failure.session.Start(platform_request),
          "platform-adapter failure fixture should start");
  ConnectTransport(platform_failure, platform_request);
  platform_failure.input.key_result = false;
  const common::TopologyRevision revision = platform_failure.session.topology()->revision;
  Require(platform_failure.session.ApplyKey({Stamp(1, revision), "KeyA", true}) ==
                  common::InputResult::kAdapterFailure &&
              platform_failure.session.state() == common::SessionState::kTerminal &&
              platform_failure.transport.close_count == 1 &&
              platform_failure.transport.terminal_count == 1,
          "platform adapter failure must also close common transport and "
          "finalize the macOS session exactly once");
}

void TestRealTransportCallbacksFlowThroughCommonCore() {
  Fixture fixture;
  const macos::MacosRemoteDesktopStartRequest request = Request();
  Require(fixture.session.Start(request), "transport callback fixture should start");
  const common::TransportCallbackStamp stamp = StampFor(request);
  const common::IceCandidate remote{"video", "candidate:remote"};
  const common::IceCandidate local{"video", "candidate:local"};
  Require(fixture.session.AddRemoteIceCandidate(request.route_authority->identity, remote) &&
              fixture.transport.remote_ice_count == 0,
          "remote ICE must remain queued until remote description readiness");
  Require(fixture.session.SetRemoteDescriptionReady(stamp) &&
              fixture.transport.remote_ice_count == 1 &&
              fixture.transport.last_remote_ice.candidate == remote.candidate,
          "remote ICE must flush through the injected native transport");
  Require(
      fixture.session.OnLocalIceCandidate(stamp, local) && fixture.transport.local_ice_count == 0,
      "local ICE must remain queued until signaling emission is ready");
  Require(fixture.session.SetLocalIceEmissionReady(stamp) &&
              fixture.transport.local_ice_count == 1 &&
              fixture.transport.last_local_ice.candidate == local.candidate,
          "local ICE must flush through the injected native transport");
  ConnectTransport(fixture, request);
  Require(fixture.session.OnTransportPath(stamp, common::TransportPath::kRelay) &&
              fixture.session.transport_diagnostics().path == common::TransportPath::kRelay,
          "direct/relay state must be owned by the common core");
  Require(fixture.session.UpdateTransportQuality(
              stamp, {.bitrate_bps = 3'000'000, .source_pixels = {1920, 1080}}) &&
              fixture.transport.quality_count == 1 &&
              fixture.transport.last_quality.bitrate_bps == 3'000'000,
          "quality selection must cross the common ladder before the native adapter");
  Require(fixture.session.RecordTransportMediaProgress(stamp, 1, 1024,
                                                       {.unix_ms = 140, .monotonic_ms = 140}),
          "media progress must enter the shared watchdog state");
  common::TransportCallbackStamp stale = stamp;
  ++stale.route_generation;
  Require(!fixture.session.OnPeerConnectionState(stale, common::PeerConnectionState::kDisconnected,
                                                 {.unix_ms = 150, .monotonic_ms = 150}),
          "stale native callbacks must not mutate the current route");
}

}  // namespace

int main() {
  TestViewOnlyStartsAndFeedsExistingMediaSeams();
  TestPermissionLossReleasesHeldInputAndDowngrades();
  TestStopDoesNotWaitForBlockingClipboardAdapters();
  TestMonitorSelectionPublishesRevisionAndRejectsStaleInput();
  TestLifecycleBoundaryPerformsTerminalCleanupOnce();
  TestReadinessAndMediaFailuresFailClosed();
  TestRouteAuthorityActivityModeAndExpiryUseCommonTransportCore();
  TestTransportAdapterFailureAndCompatibilityModeFailHonestly();
  TestRealTransportCallbacksFlowThroughCommonCore();
  return 0;
}
