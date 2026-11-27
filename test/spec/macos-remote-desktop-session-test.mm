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
    last_frame = frame;
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
  common::CapturedFrame last_frame;
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
    // Same contract as the production H264SenderBridge: a generation it has
    // already started is refused, so every media start needs a fresh one.
    if (generation == 0 || generation <= last_started_generation) return false;
    last_started_generation = generation;
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
  common::WorkerGeneration last_started_generation = 0;
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
  // Locking is NOT the end of the session: the lock screen is what a remote
  // operator most needs to see and type into.
  fixture.monitor.Fire(common::GraphicalSessionEvent::kLocked);
  Require(fixture.session.state() != common::SessionState::kTerminal &&
              fixture.lifecycle.end_count == 0,
          "lock must keep the session so the lock screen stays reachable");
  fixture.monitor.Fire(common::GraphicalSessionEvent::kUnlocked);
  Require(fixture.session.state() != common::SessionState::kTerminal &&
              fixture.lifecycle.end_count == 0,
          "unlock must continue the same session");
  fixture.monitor.Fire(common::GraphicalSessionEvent::kSleeping);
  Require(fixture.session.state() == common::SessionState::kTerminal &&
              fixture.session.terminal_error().code ==
                  common::TerminalErrorCode::kGraphicalSessionEnded,
          "sleep must terminate the current authority generation");
  Require(fixture.lifecycle.end_count == 1 &&
              fixture.lifecycle.end_reason == macos::MacosSessionEndReason::kSleeping,
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
  fixture.monitor.Fire(common::GraphicalSessionEvent::kWoke);
  fixture.session.Stop();
  Require(fixture.lifecycle.end_count == 1 && fixture.events.size() == event_count,
          "later wake/Stop cannot revive or duplicate cleanup");
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

void TestPrivacyShieldReplacesEveryFrameBeforeEncoding() {
  Fixture fixture;
  Require(fixture.session.Start(Request()), "privacy fixture should start");
  fixture.capture.Emit({1920, 1080});
  Require(fixture.session.real_frames_encoded() == 1,
          "a real frame counts toward the fresh-frame generation");

  fixture.session.SetPrivacyShield(true);
  Require(fixture.session.privacy_shielded(), "shield flag is observable");
  fixture.capture.Emit({1920, 1080});
  const common::CapturedFrame& shielded = fixture.encoder.last_frame;
  Require(fixture.encoder.encode_count == 2 && shielded.IsValid() &&
              shielded.encoded_pixels.width == 1920 &&
              shielded.encoded_pixels.height == 1080,
          "the stream keeps flowing at the captured size while shielded");
  const auto* pixels = shielded.storage->data();
  bool opaque = true;
  for (std::size_t i = 0; i < 1920u * 1080u; i += 4099) {
    opaque = opaque && pixels[i * 4] == std::byte{0x24} &&
             pixels[i * 4 + 1] == std::byte{0x17} &&
             pixels[i * 4 + 2] == std::byte{0x0F} &&
             pixels[i * 4 + 3] == std::byte{0xFF};
  }
  Require(opaque, "every encoded pixel is the opaque brand surface, never the capture");
  Require(fixture.session.real_frames_encoded() == 1,
          "shield frames never count as fresh real frames");

  fixture.session.SetPrivacyShield(false);
  fixture.capture.Emit({1920, 1080});
  Require(fixture.session.real_frames_encoded() == 2,
          "the first real frame after release advances the generation");
}

void TestTransientCaptureAndEncodeFailuresDoNotEndSession() {
  Fixture fixture;
  Require(fixture.session.Start(Request()), "transient-failure fixture should start");
  // A frame whose size disagrees with the selected display (the display
  // sleeping behind the lock screen) is dropped, never fatal.
  fixture.capture.Emit({640, 360});
  Require(fixture.session.state() != common::SessionState::kTerminal &&
              fixture.encoder.encode_count == 0,
          "a mismatched frame must be dropped without ending the session");
  fixture.capture.Emit({1920, 1080});
  Require(fixture.encoder.encode_count == 1, "a matching frame still encodes");

  // A short run of refused frames is backpressure; a sustained run is not.
  fixture.encoder.encode_result = false;
  for (int i = 0; i < 59; ++i) fixture.capture.Emit({1920, 1080});
  Require(fixture.session.state() != common::SessionState::kTerminal,
          "a transient run of encoder refusals must not end the session");
  fixture.encoder.encode_result = true;
  fixture.capture.Emit({1920, 1080});
  fixture.encoder.encode_result = false;
  for (int i = 0; i < 59; ++i) fixture.capture.Emit({1920, 1080});
  Require(fixture.session.state() != common::SessionState::kTerminal,
          "a successful encode resets the refusal run");
  for (int i = 0; i < 2; ++i) fixture.capture.Emit({1920, 1080});
  Require(fixture.session.state() == common::SessionState::kTerminal &&
              fixture.session.terminal_error().code ==
                  common::TerminalErrorCode::kEncoderUnavailable,
          "a sustained run of encoder refusals ends the session");
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

void TestSetAudioEnabledWorksInViewAndControlModes() {
  // 1. macOS 12 / CGDisplayStream / LoginWindow fallback: both capture and
  // transport stay OFF in view and control modes while video keeps flowing.
  {
    bool transport_audio = false;
    int transport_enable_calls = 0;
    int capture_enable_calls = 0;
    Fixture fallback_fixture;
    macos::MacosRemoteDesktopSessionDependencies fallback_deps =
        fallback_fixture.dependencies;
    fallback_deps.supports_audio = []() { return false; };
    fallback_deps.set_audio_enabled_async =
        [&capture_enable_calls](bool enabled, std::function<void(bool)> cb) {
          if (enabled) ++capture_enable_calls;
          if (cb) cb(false);
        };
    fallback_deps.set_transport_audio_enabled =
        [&transport_audio, &transport_enable_calls](
            bool enabled, std::function<bool()> validate) {
          if (validate && !validate()) return;
          if (enabled) ++transport_enable_calls;
          transport_audio = enabled;
        };
    macos::MacosRemoteDesktopSession view_fallback(fallback_deps);
    bool settled = false;
    macos::DispatchSetAudioControl(
        view_fallback, true, [&](bool active) { settled = !active; });
    Require(settled && !transport_audio && transport_enable_calls == 0 &&
                capture_enable_calls == 0,
            "pre-start SET_AUDIO must keep capture and transport closed");

    const macos::MacosRemoteDesktopStartRequest view_request =
        Request(/*controllers=*/0);
    Require(view_fallback.Start(view_request),
            "view-only fallback session should start");
    settled = false;
    macos::DispatchSetAudioControl(
        view_fallback, true, [&](bool active) { settled = !active; });
    Require(settled && !view_fallback.SupportsAudio() && !transport_audio &&
                transport_enable_calls == 0 && capture_enable_calls == 0 &&
                view_fallback.state() == common::SessionState::kViewing,
            "view-mode fallback must leave both capture and transport disabled");
    fallback_fixture.capture.Emit({1920, 1080});
    Require(fallback_fixture.encoder.encode_count == 1,
            "view-mode video capture/encode must keep flowing after audio fallback");
    view_fallback.Stop();

    Fixture control_fallback_fixture;
    macos::MacosRemoteDesktopSessionDependencies control_fallback_deps =
        control_fallback_fixture.dependencies;
    control_fallback_deps.supports_audio = []() { return false; };
    control_fallback_deps.set_audio_enabled_async =
        [&capture_enable_calls](bool enabled, std::function<void(bool)> cb) {
          if (enabled) ++capture_enable_calls;
          if (cb) cb(false);
        };
    control_fallback_deps.set_transport_audio_enabled =
        [&transport_audio, &transport_enable_calls](
            bool enabled, std::function<bool()> validate) {
          if (validate && !validate()) return;
          if (enabled) ++transport_enable_calls;
          transport_audio = enabled;
        };
    macos::MacosRemoteDesktopSession control_fallback(control_fallback_deps);
    const macos::MacosRemoteDesktopStartRequest control_request =
        Request(/*controllers=*/1);
    Require(control_fallback.Start(control_request),
            "control fallback session should start");
    const common::TransportCallbackStamp stamp = StampFor(control_request);
    Require(control_fallback.OnPeerConnectionState(
                stamp, common::PeerConnectionState::kConnected,
                {.unix_ms = 110, .monotonic_ms = 110}) &&
                control_fallback.OnDataChannelState(
                    stamp, common::DataChannelKind::kControl,
                    common::DataChannelState::kOpen) &&
                control_fallback.OnDataChannelState(
                    stamp, common::DataChannelKind::kKeyboard,
                    common::DataChannelState::kOpen) &&
                control_fallback.OnDataChannelState(
                    stamp, common::DataChannelKind::kPointer,
                    common::DataChannelState::kOpen) &&
                control_fallback.state() == common::SessionState::kControlling,
            "control fallback session should promote cleanly to kControlling");
    settled = false;
    macos::DispatchSetAudioControl(
        control_fallback, true, [&](bool active) { settled = !active; });
    Require(settled && !transport_audio && transport_enable_calls == 0 &&
                capture_enable_calls == 0,
            "control-mode fallback must keep both capture and transport closed");
    control_fallback_fixture.capture.Emit({1920, 1080});
    Require(control_fallback_fixture.encoder.encode_count == 1,
            "control-mode video must keep flowing after audio fallback");
    control_fallback.Stop();
  }

  // 2. Async ON->ON shares intent, ON->OFF->ON leaves stale ON side-effect-free,
  // and worker queue commit-time validation rejects stale ON after OFF runs.
  {
    struct QueuedCommit {
      bool enabled = false;
      std::function<bool()> validate;
    };
    std::vector<QueuedCommit> worker_queue;
    bool transport_audio = false;
    std::vector<bool> observed_capture;
    std::vector<bool> observed_transport;
    std::vector<std::function<void(bool)>> pending_completions;

    auto drain_worker = [&]() {
      std::vector<QueuedCommit> batch;
      batch.swap(worker_queue);
      for (auto& item : batch) {
        if (item.validate && !item.validate()) {
          continue;
        }
        transport_audio = item.enabled;
        observed_transport.push_back(item.enabled);
      }
    };

    Fixture fixture;
    macos::MacosRemoteDesktopSessionDependencies deps = fixture.dependencies;
    deps.supports_audio = []() { return true; };
    deps.set_audio_enabled_async =
        [&](bool enabled, std::function<void(bool)> cb) {
          observed_capture.push_back(enabled);
          if (enabled) {
            pending_completions.push_back(std::move(cb));
          } else if (cb) {
            cb(false);
          }
        };
    deps.set_transport_audio_enabled =
        [&](bool enabled, std::function<bool()> validate) {
          worker_queue.push_back({enabled, std::move(validate)});
        };
    macos::MacosRemoteDesktopSession view_session(deps);
    Require(view_session.Start(Request(/*controllers=*/0)),
            "view-only audio session must start");

    // 2a. ON -> ON -> single completion(true) activates transport with zero OFF rollback.
    std::vector<bool> settled_results;
    macos::DispatchSetAudioControl(
        view_session, true,
        [&](bool active) { settled_results.push_back(active); });
    macos::DispatchSetAudioControl(
        view_session, true,
        [&](bool active) { settled_results.push_back(active); });
    Require(observed_capture == (std::vector<bool>{true, true}) &&
                pending_completions.size() == 2 && worker_queue.empty(),
            "duplicate ON must not open transport before completion");
    // Simulate coalescing backend completing once (both waiters see true).
    auto w1 = std::move(pending_completions[0]);
    auto w2 = std::move(pending_completions[1]);
    pending_completions.clear();
    w1(true);
    w2(true);
    drain_worker();
    Require(transport_audio &&
                settled_results == (std::vector<bool>{true, true}) &&
                observed_capture == (std::vector<bool>{true, true}),
            "ON -> ON -> single completion must keep capture/transport ON without stale rollback");

    // Emit video while audio config ran: zero dropped frames.
    fixture.capture.Emit({1920, 1080});
    fixture.capture.Emit({1920, 1080});
    Require(fixture.encoder.encode_count == 2,
            "video frames must not be dropped while audio toggles run");

    // 2b. Reset to OFF, then ON -> OFF -> ON: stale first ON completion must be
    // strictly side-effect-free (no capture OFF, no transport false).
    observed_capture.clear();
    observed_transport.clear();
    settled_results.clear();
    macos::DispatchSetAudioControl(view_session, false, {});
    drain_worker();
    Require(!transport_audio, "explicit OFF must close transport");
    observed_capture.clear();
    observed_transport.clear();

    macos::DispatchSetAudioControl(
        view_session, true,
        [&](bool active) { settled_results.push_back(active); });
    macos::DispatchSetAudioControl(
        view_session, false,
        [&](bool active) { settled_results.push_back(active); });
    macos::DispatchSetAudioControl(
        view_session, true,
        [&](bool active) { settled_results.push_back(active); });
    drain_worker();
    Require(pending_completions.size() == 2 && !transport_audio &&
                observed_transport == std::vector<bool>{false},
            "ON -> OFF -> ON before completion leaves transport closed");
    observed_transport.clear();
    auto stale_on = std::move(pending_completions[0]);
    auto fresh_on = std::move(pending_completions[1]);
    pending_completions.clear();
    const std::size_t capture_before_stale = observed_capture.size();
    stale_on(true);
    drain_worker();
    Require(observed_capture.size() == capture_before_stale &&
                !transport_audio && observed_transport.empty(),
            "stale ON completion must be a pure side-effect-free cancellation");
    fresh_on(true);
    drain_worker();
    Require(transport_audio && observed_transport == std::vector<bool>{true} &&
                settled_results == (std::vector<bool>{false, false, true}),
            "fresh ON after stale cancellation must activate transport cleanly");

    // 2c. Worker queue ordering window: ON completes on session and queues to worker
    // queue, then OFF runs synchronously on worker BEFORE worker drains queued ON.
    macos::DispatchSetAudioControl(view_session, false, {});
    drain_worker();
    observed_transport.clear();
    macos::DispatchSetAudioControl(view_session, true, {});
    Require(pending_completions.size() == 1, "expected queued ON before OFF race");
    pending_completions[0](true);
    pending_completions.clear();
    Require(worker_queue.size() == 1 && !transport_audio,
            "ON completion queued to worker awaiting drain");
    // Worker handles OFF synchronously (matches worker_main.mm:2186-2189) BEFORE DrainEvents runs queued ON!
    transport_audio = false;
    observed_transport.push_back(false);
    macos::DispatchSetAudioControl(view_session, false, {});
    drain_worker();
    Require(!transport_audio &&
                observed_transport == (std::vector<bool>{false, false}),
            "queued stale ON commit must be rejected on worker thread after synchronous OFF");

    view_session.Stop();
  }

  // 3. Control mode dispatch enables transport only after capture confirms.
  {
    std::vector<bool> observed_transport;
    Fixture control_fixture;
    macos::MacosRemoteDesktopSessionDependencies control_deps =
        control_fixture.dependencies;
    control_deps.supports_audio = []() { return true; };
    control_deps.set_audio_enabled_async =
        [](bool enabled, std::function<void(bool)> cb) {
          if (cb) cb(enabled);
        };
    control_deps.set_transport_audio_enabled =
        [&](bool enabled, std::function<bool()> validate) {
          if (validate && !validate()) return;
          observed_transport.push_back(enabled);
        };
    macos::MacosRemoteDesktopSession control_session(control_deps);
    const macos::MacosRemoteDesktopStartRequest control_request =
        Request(/*controllers=*/1);
    Require(control_session.Start(control_request),
            "control audio session must start");
    const common::TransportCallbackStamp stamp = StampFor(control_request);
    Require(control_session.OnPeerConnectionState(
                stamp, common::PeerConnectionState::kConnected,
                {.unix_ms = 110, .monotonic_ms = 110}) &&
                control_session.OnDataChannelState(
                    stamp, common::DataChannelKind::kControl,
                    common::DataChannelState::kOpen) &&
                control_session.OnDataChannelState(
                    stamp, common::DataChannelKind::kKeyboard,
                    common::DataChannelState::kOpen) &&
                control_session.OnDataChannelState(
                    stamp, common::DataChannelKind::kPointer,
                    common::DataChannelState::kOpen) &&
                control_session.state() == common::SessionState::kControlling,
            "control session should promote cleanly to kControlling");
    bool active_on = false;
    macos::DispatchSetAudioControl(
        control_session, true, [&](bool active) { active_on = active; });
    Require(active_on && observed_transport == std::vector<bool>{true},
            "DispatchSetAudioControl must enable audio in control mode");
    bool active_off = true;
    macos::DispatchSetAudioControl(
        control_session, false, [&](bool active) { active_off = active; });
    Require(!active_off &&
                observed_transport == (std::vector<bool>{true, false}),
            "DispatchSetAudioControl must disable audio in control mode");
  }
}

void TestDisplaySwitchAndTopologyChangePreserveAudioIntent() {
  struct QueuedCommit {
    bool enabled = false;
    std::function<bool()> validate;
  };
  std::vector<QueuedCommit> worker_queue;
  bool transport_audio = false;
  std::vector<bool> observed_transport;
  std::vector<bool> observed_capture;
  std::vector<std::function<void(bool)>> pending_completions;

  auto drain_worker = [&]() {
    std::vector<QueuedCommit> batch;
    batch.swap(worker_queue);
    for (auto& item : batch) {
      if (item.validate && !item.validate()) continue;
      transport_audio = item.enabled;
      observed_transport.push_back(item.enabled);
    }
  };

  Fixture fixture;
  macos::MacosRemoteDesktopSessionDependencies deps = fixture.dependencies;
  deps.supports_audio = []() { return true; };
  deps.set_audio_enabled_async =
      [&](bool enabled, std::function<void(bool)> cb) {
        observed_capture.push_back(enabled);
        if (enabled) {
          pending_completions.push_back(std::move(cb));
        } else if (cb) {
          cb(false);
        }
      };
  deps.set_transport_audio_enabled =
      [&](bool enabled, std::function<bool()> validate) {
        worker_queue.push_back({enabled, std::move(validate)});
      };
  macos::MacosRemoteDesktopSession session(deps);
  Require(session.Start(Request(/*controllers=*/0)),
          "audio intent preserve session must start");

  // 1. Enable audio -> confirm transport active.
  macos::DispatchSetAudioControl(session, true, {});
  Require(pending_completions.size() == 1, "expected initial ON capture call");
  pending_completions[0](true);
  pending_completions.clear();
  drain_worker();
  Require(transport_audio, "audio must be enabled before display switch");

  // 2. Switch display without re-sending SET_AUDIO: closes old transport first,
  // re-requests capture ON on new stream generation, and restores transport once confirmed.
  observed_transport.clear();
  observed_capture.clear();
  Require(session.SelectDisplay("display-b"),
          "SelectDisplay must succeed with active audio");
  drain_worker();
  Require(!transport_audio && observed_transport == std::vector<bool>{false} &&
              observed_capture == std::vector<bool>{true} &&
              pending_completions.size() == 1,
          "SelectDisplay must close transport synchronously before new capture confirms audio");
  pending_completions[0](true);
  pending_completions.clear();
  drain_worker();
  Require(transport_audio &&
              observed_transport == (std::vector<bool>{false, true}),
          "SelectDisplay must automatically restore audio without a second SET_AUDIO");

  // 3. Topology refresh while ON also restores audio; if OFF lands mid-restore,
  // stale restore completion must stay disabled.
  observed_transport.clear();
  observed_capture.clear();
  fixture.display.topology = Topology(11);
  Require(session.RefreshTopology(), "RefreshTopology must succeed");
  drain_worker();
  Require(!transport_audio && observed_capture == std::vector<bool>{true} &&
              pending_completions.size() == 1,
          "RefreshTopology must close transport and re-request capture ON");
  macos::DispatchSetAudioControl(session, false, {});
  drain_worker();
  pending_completions[0](true);
  pending_completions.clear();
  drain_worker();
  Require(!transport_audio,
          "OFF during RefreshTopology audio restore must keep transport closed");

  // 4. Switching display while OFF must NOT re-request capture ON or open transport.
  observed_transport.clear();
  observed_capture.clear();
  Require(session.SelectDisplay("display-a"),
          "SelectDisplay while OFF must succeed");
  drain_worker();
  Require(!transport_audio && observed_capture.empty() &&
              pending_completions.empty(),
          "SelectDisplay while OFF must keep audio capture and transport off");
  session.Stop();
}

void TestAudioCompletionOverlapWithRouteDestructionDoesNotDeadlock() {
  std::promise<void> cb_paused;
  std::promise<void> release_cb;
  std::shared_future<void> release_future = release_cb.get_future().share();
  std::atomic<int> transport_calls{0};

  Fixture fixture;
  macos::MacosRemoteDesktopSessionDependencies deps = fixture.dependencies;
  deps.supports_audio = []() { return true; };
  std::function<void(bool)> captured_settle;
  deps.set_audio_enabled_async =
      [&](bool enabled, std::function<void(bool)> cb) {
        if (enabled) {
          captured_settle = std::move(cb);
        } else if (cb) {
          cb(false);
        }
      };
  deps.set_transport_audio_enabled =
      [&](bool enabled, std::function<bool()> validate) {
        if (validate && !validate()) return;
        if (enabled) ++transport_calls;
      };
  auto session = std::make_unique<macos::MacosRemoteDesktopSession>(deps);
  Require(session->Start(Request(/*controllers=*/0)),
          "route destroy overlap session must start");

  std::thread audio_queue_thread;
  macos::DispatchSetAudioControl(*session, true, {});
  Require(static_cast<bool>(captured_settle),
          "expected captured session settle callback");

  audio_queue_thread = std::thread([&]() {
    cb_paused.set_value();
    release_future.wait();
    captured_settle(true);
  });
  cb_paused.get_future().wait();

  // Synchronously tear down route while audio completion is paused on audio thread.
  session.reset();
  release_cb.set_value();
  audio_queue_thread.join();
  Require(transport_calls.load() == 0,
          "late completion after route destruction must not enable transport");
}

void TestLoginWindowForbidsAudioWhilePreservingAquaAudioAndVideo() {
  struct SckBackendState {
    std::atomic<int> audio_toggle_calls{0};
    std::vector<bool> created_capture_audio;
    std::vector<bool> created_has_audio_buffer;
    macos::ScreenCaptureKitBackendFrameSink frame_sink;
  };
  class FakeAudioSckStream final : public macos::ScreenCaptureKitBackendStream {
   public:
    explicit FakeAudioSckStream(SckBackendState* state) : state_(state) {}
    bool Start(std::uint32_t, std::string*) override { return true; }
    bool WaitForFirstFrame(std::uint32_t, std::string*) override { return true; }
    void Stop(std::uint32_t) noexcept override {}
    [[nodiscard]] bool SupportsAudio() const noexcept override { return true; }
    bool SetAudioEnabled(bool) noexcept override {
      state_->audio_toggle_calls.fetch_add(1, std::memory_order_relaxed);
      return true;
    }
    void SetAudioEnabledAsync(
        bool,
        std::function<void(bool)> completion) noexcept override {
      state_->audio_toggle_calls.fetch_add(1, std::memory_order_relaxed);
      if (completion) completion(true);
    }

   private:
    SckBackendState* state_;
  };
  class FakeAudioSckBackend final : public macos::ScreenCaptureKitBackend {
   public:
    explicit FakeAudioSckBackend(SckBackendState* state) : state_(state) {}
    [[nodiscard]] bool SupportsAudio() const noexcept override { return true; }
    common::ReadinessState ProbeReadiness() noexcept override {
      return common::ReadinessState::kReady;
    }
    bool EnumerateDisplays(
        std::uint32_t,
        std::uint32_t,
        std::vector<macos::ScreenCaptureKitBackendDisplay>* displays,
        macos::CaptureError* error) override {
      if (error) *error = {};
      *displays = {
          {.native_display_id = 1,
           .encoded_pixels = {1920, 1080},
           .logical_input_bounds = {0, 0, 960, 540},
           .scale = 2.0,
           .rotation = common::DisplayRotation::k0,
           .cursor_supported = true},
      };
      return true;
    }
    std::unique_ptr<macos::ScreenCaptureKitBackendStream> CreateStream(
        const macos::ScreenCaptureKitStreamConfiguration& configuration,
        macos::ScreenCaptureKitBackendFrameSink frame_sink,
        macos::ScreenCaptureKitBackendErrorSink,
        macos::CaptureError* error) override {
      if (error) *error = {};
      state_->created_capture_audio.push_back(configuration.capture_audio);
      state_->created_has_audio_buffer.push_back(configuration.audio_buffer !=
                                                 nullptr);
      state_->frame_sink = std::move(frame_sink);
      return std::make_unique<FakeAudioSckStream>(state_);
    }

   private:
    SckBackendState* state_;
  };
  class FakeH264Backend final : public macos::H264SenderBackend {
   public:
    bool Start(const macos::H264SenderConfiguration&) override { return true; }
    bool Submit(macos::H264SenderFrame frame,
                macos::H264SenderCompletionCallback completion) override {
      if (completion) {
        completion(macos::H264SenderCompletion::kAccepted, frame.bytes.size());
      }
      return true;
    }
    void Cancel(common::WorkerGeneration) noexcept override {}
  };

  auto settle_blocking = [](macos::MacosRemoteDesktopSession& session,
                            bool enabled) -> bool {
    std::promise<bool> p;
    auto f = p.get_future();
    macos::DispatchSetAudioControl(session, enabled,
                                   [&](bool active) { p.set_value(active); });
    Require(f.wait_for(std::chrono::seconds(2)) == std::future_status::ready,
            "audio control settlement timed out");
    return f.get();
  };

  // 1. LoginWindow with audio-capable ScreenCaptureKit must keep video working,
  // but must never bind audio_buffer, invoke capture audio ON, or enable
  // transport audio.
  {
    SckBackendState sck_state;
    macos::ScreenCaptureKitAdapter sck_capture(
        77, std::make_unique<FakeAudioSckBackend>(&sck_state));
    FakeEncoder encoder;
    FakeInput input;
    FakeClipboard clipboard;
    FakeDisclosure disclosure;
    FakeMonitor monitor;
    FakeMediaSender sender;
    FakeLifecycle lifecycle;
    FakeReadinessGate readiness_gate;
    FakeTransport transport;
    common::PlatformAdapters adapters{sck_capture, encoder,    input,  clipboard,
                                      sck_capture, disclosure, monitor};
    macos::MacosRemoteDesktopSessionDependencies deps{
        .adapters = adapters,
        .media_sender = sender,
        .lifecycle = lifecycle,
        .readiness_gate = readiness_gate,
        .transport = &transport,
    };
    auto audio_buffer = std::make_shared<imcodes::rd::AudioLoopbackBuffer>();
    std::vector<bool> transport_audio_calls;
    macos::ConfigureProductionAudioDependencies(
        macos::kSessionTypeLoginWindow, sck_capture, audio_buffer,
        [&](bool enabled, std::function<bool()> validate) {
          if (validate && !validate()) return;
          transport_audio_calls.push_back(enabled);
        },
        &deps);
    macos::MacosRemoteDesktopSession session(deps);
    Require(session.Start(Request(/*controllers=*/1)),
            "LoginWindow session must start video normally");
    Require(!session.SupportsAudio(),
            "LoginWindow production dependencies must reject SupportsAudio()");
    Require(!settle_blocking(session, true),
            "LoginWindow SET_AUDIO=true must fail closed");
    Require(sck_state.audio_toggle_calls.load() == 0,
            "LoginWindow SET_AUDIO=true must never call SCK capture audio");
    Require(transport_audio_calls.empty(),
            "LoginWindow SET_AUDIO=true must never enable transport audio");
    Require(!audio_buffer->enabled(),
            "LoginWindow must keep AudioLoopbackBuffer disabled");
    Require(sck_state.created_capture_audio == std::vector<bool>{false} &&
                sck_state.created_has_audio_buffer == std::vector<bool>{false},
            "LoginWindow SCK stream must be created without audio_buffer or capture_audio");
    // LoginWindow video frames still flow into encoder/sender.
    Require(static_cast<bool>(sck_state.frame_sink),
            "LoginWindow must bind capture frame sink");
    sck_state.frame_sink(Frame({1920, 1080}));
    Require(encoder.encode_count == 1 && sender.submit_count == 1,
            "LoginWindow video capture/encode path must stay intact");
    session.Stop();
  }

  // 2. Positive control: Aqua with the same audio-capable ScreenCaptureKit enables
  // audio cleanly in both view and control modes.
  for (std::uint32_t controllers : {std::uint32_t{0}, std::uint32_t{1}}) {
    SckBackendState sck_state;
    macos::ScreenCaptureKitAdapter sck_capture(
        77, std::make_unique<FakeAudioSckBackend>(&sck_state));
    FakeEncoder encoder;
    FakeInput input;
    FakeClipboard clipboard;
    FakeDisclosure disclosure;
    FakeMonitor monitor;
    FakeMediaSender sender;
    FakeLifecycle lifecycle;
    FakeReadinessGate readiness_gate;
    FakeTransport transport;
    common::PlatformAdapters adapters{sck_capture, encoder,    input,  clipboard,
                                      sck_capture, disclosure, monitor};
    macos::MacosRemoteDesktopSessionDependencies deps{
        .adapters = adapters,
        .media_sender = sender,
        .lifecycle = lifecycle,
        .readiness_gate = readiness_gate,
        .transport = &transport,
    };
    auto audio_buffer = std::make_shared<imcodes::rd::AudioLoopbackBuffer>();
    std::vector<bool> transport_audio_calls;
    macos::ConfigureProductionAudioDependencies(
        macos::kSessionTypeAqua, sck_capture, audio_buffer,
        [&](bool enabled, std::function<bool()> validate) {
          if (validate && !validate()) return;
          transport_audio_calls.push_back(enabled);
        },
        &deps);
    macos::MacosRemoteDesktopSession session(deps);
    Require(session.Start(Request(controllers)),
            "Aqua session must start cleanly");
    Require(session.SupportsAudio(),
            "Aqua production dependencies must expose SupportsAudio()");
    Require(settle_blocking(session, true),
            "Aqua SET_AUDIO=true must succeed in both view and control modes");
    Require(sck_state.audio_toggle_calls.load() == 1,
            "Aqua SET_AUDIO=true must invoke SCK capture audio");
    Require(transport_audio_calls == std::vector<bool>{true},
            "Aqua SET_AUDIO=true must enable transport audio");
    Require(!settle_blocking(session, false),
            "Aqua SET_AUDIO=false must settle disabled");
    Require(transport_audio_calls == (std::vector<bool>{true, false}),
            "Aqua SET_AUDIO=false must disable transport audio");
    session.Stop();
  }

  // 3. Direct CreateWithPinnedLibwebrtcSender LoginWindow guard even if caller
  // mistakenly supplies audio_buffer and set_transport_audio_enabled alongside
  // an audio-capable SCK backend.
  {
    SckBackendState sck_state;
    auto audio_buffer = std::make_shared<imcodes::rd::AudioLoopbackBuffer>();
    std::vector<bool> transport_audio_calls;
    macos::MacosRemoteDesktopProductionConfiguration config;
    config.worker_generation = 77;
    config.session_type = macos::kSessionTypeLoginWindow;
    config.capture_backend = std::make_unique<FakeAudioSckBackend>(&sck_state);
    config.pinned_libwebrtc_sender_backend = std::make_unique<FakeH264Backend>();
    config.audio_buffer = audio_buffer;
    config.set_transport_audio_enabled =
        [&](bool enabled, std::function<bool()> validate) {
          if (validate && !validate()) return;
          transport_audio_calls.push_back(enabled);
        };
    auto prod_session = macos::MacosRemoteDesktopSession::CreateWithPinnedLibwebrtcSender(
        std::move(config));
    Require(prod_session != nullptr,
            "LoginWindow CreateWithPinnedLibwebrtcSender must compose cleanly");
    Require(!prod_session->SupportsAudio(),
            "CreateWithPinnedLibwebrtcSender must refuse audio for LoginWindow");
    Require(!settle_blocking(*prod_session, true),
            "LoginWindow production session SET_AUDIO=true must return false");
    Require(sck_state.audio_toggle_calls.load() == 0,
            "LoginWindow production session must never invoke SCK audio toggle");
    Require(transport_audio_calls.empty(),
            "LoginWindow production session must never enable transport audio");
    Require(!audio_buffer->enabled(),
            "LoginWindow production session must leave AudioLoopbackBuffer disabled");
  }
}

void TestApplyModeAuthorityRoundTripsAndPendingChannelPromotion() {
  // 1. Multi-round Control <-> View <-> Control switching via ApplyModeAuthority.
  {
    Fixture fixture;
    macos::MacosRemoteDesktopStartRequest request = Request(/*controllers=*/1);
    Require(fixture.session.Start(request), "round-trip fixture must start");
    ConnectTransport(fixture, request);
    Require(fixture.session.state() == common::SessionState::kControlling,
            "initial Control route must become controlling");

    common::RouteAuthority current = *request.route_authority;
    common::InputSequence input_seq = 1;
    std::int64_t now_ms = 200;

    for (int round = 0; round < 3; ++round) {
      const common::TopologyRevision revision = fixture.session.topology()->revision;
      Require(fixture.session.ApplyKey({{.controller_id = "controller-a",
                                         .epoch = current.input_epoch,
                                         .sequence = input_seq++,
                                         .topology_revision = revision},
                                        "KeyA",
                                        true}) == common::InputResult::kApplied,
              "key down must apply while controlling");

      const int release_before = fixture.input.release_all_count;
      ++current.input_epoch;
      current.mode = common::TransportSessionMode::kView;
      now_ms += 20;
      Require(fixture.session.ApplyModeAuthority(current, {.unix_ms = now_ms, .monotonic_ms = now_ms}),
              "Control -> View mode switch must succeed");
      Require(fixture.session.state() == common::SessionState::kViewing,
              "Control -> View must transition session to kViewing");
      Require(fixture.session.transport_diagnostics().mode == common::TransportSessionMode::kView,
              "Control -> View must update transport diagnostics to kView");
      Require(fixture.input.release_all_count > release_before && fixture.input.held_keys.empty(),
              "Control -> View must release held input state");
      Require(fixture.disclosure.shows.back() == std::pair<std::uint32_t, std::uint32_t>{2, 0},
              "Control -> View must update disclosure controller count to 0");
      Require(fixture.session.ApplyKey({{.controller_id = "controller-a",
                                         .epoch = current.input_epoch,
                                         .sequence = input_seq++,
                                         .topology_revision = revision},
                                        "KeyB",
                                        true}) == common::InputResult::kCapabilityUnavailable,
              "View mode must reject key injection");

      ++current.input_epoch;
      current.mode = common::TransportSessionMode::kControl;
      now_ms += 20;
      Require(fixture.session.ApplyModeAuthority(current, {.unix_ms = now_ms, .monotonic_ms = now_ms}),
              "View -> Control mode switch must succeed without protocol_error");
      Require(fixture.session.state() == common::SessionState::kControlling,
              "View -> Control must restore kControlling");
      Require(fixture.session.transport_diagnostics().mode == common::TransportSessionMode::kControl,
              "View -> Control must update transport diagnostics to kControl");
      Require(fixture.disclosure.shows.back() == std::pair<std::uint32_t, std::uint32_t>{2, 1},
              "View -> Control must update disclosure controller count to 1");
    }

    // Invalid epoch regression / skip, expired lease, and mismatched identity must still fail.
    common::RouteAuthority regressed = current;
    regressed.mode = common::TransportSessionMode::kView;
    --regressed.input_epoch;
    Require(!fixture.session.ApplyModeAuthority(regressed, {.unix_ms = now_ms + 10, .monotonic_ms = now_ms + 10}),
            "regressed input_epoch must still be rejected");

    common::RouteAuthority skipped = current;
    skipped.mode = common::TransportSessionMode::kView;
    skipped.input_epoch += 2;
    Require(!fixture.session.ApplyModeAuthority(skipped, {.unix_ms = now_ms + 20, .monotonic_ms = now_ms + 20}),
            "skipped input_epoch must still be rejected");

    common::RouteAuthority wrong_identity = current;
    wrong_identity.mode = common::TransportSessionMode::kView;
    ++wrong_identity.input_epoch;
    wrong_identity.identity.session_id = "other-session";
    Require(!fixture.session.ApplyModeAuthority(wrong_identity, {.unix_ms = now_ms + 30, .monotonic_ms = now_ms + 30}),
            "mismatched route identity must still be rejected");
  }

  // 2. Starting in kView, then promoting to kControl after transport connects.
  {
    Fixture fixture;
    const macos::MacosRemoteDesktopStartRequest view_request = Request(/*controllers=*/0);
    Require(fixture.session.Start(view_request), "initial View fixture should start");
    const common::TransportCallbackStamp stamp = StampFor(view_request);
    Require(fixture.session.OnPeerConnectionState(stamp, common::PeerConnectionState::kConnected,
                                                  {.unix_ms = 110, .monotonic_ms = 110}),
            "peer connection should succeed in View");
    for (const common::DataChannelKind channel :
         {common::DataChannelKind::kControl, common::DataChannelKind::kKeyboard,
          common::DataChannelKind::kPointer}) {
      Require(fixture.session.OnDataChannelState(stamp, channel, common::DataChannelState::kOpen),
              "channels should open cleanly in View");
    }
    Require(fixture.session.state() == common::SessionState::kViewing,
            "connected transport in View mode must remain kViewing");

    common::RouteAuthority promote = *view_request.route_authority;
    promote.mode = common::TransportSessionMode::kControl;
    promote.input_epoch = 1;
    Require(fixture.session.ApplyModeAuthority(promote, {.unix_ms = 120, .monotonic_ms = 120}),
            "first promotion from View -> Control must succeed");
    Require(fixture.session.state() == common::SessionState::kControlling &&
                fixture.disclosure.shows.back() == std::pair<std::uint32_t, std::uint32_t>{2, 1},
            "promoted session must become controlling with disclosure controller count 1");
  }

  // 3. ApplyModeAuthority(kControl) before data channels are all open stays in View,
  //    then promotes automatically when missing channels open.
  {
    Fixture fixture;
    const macos::MacosRemoteDesktopStartRequest view_request = Request(/*controllers=*/0);
    Require(fixture.session.Start(view_request), "pending-channels fixture should start");
    const common::TransportCallbackStamp stamp = StampFor(view_request);
    Require(fixture.session.OnPeerConnectionState(stamp, common::PeerConnectionState::kConnected,
                                                  {.unix_ms = 110, .monotonic_ms = 110}) &&
                fixture.session.OnDataChannelState(stamp, common::DataChannelKind::kControl,
                                                   common::DataChannelState::kOpen),
            "partial channel setup should succeed");

    common::RouteAuthority promote = *view_request.route_authority;
    promote.mode = common::TransportSessionMode::kControl;
    promote.input_epoch = 1;
    Require(fixture.session.ApplyModeAuthority(promote, {.unix_ms = 120, .monotonic_ms = 120}),
            "ApplyModeAuthority(kControl) must accept authority before all channels open");
    Require(fixture.session.state() == common::SessionState::kViewing &&
                fixture.disclosure.shows.back() == std::pair<std::uint32_t, std::uint32_t>{2, 0},
            "control must remain inactive while keyboard/pointer channels are not open");
    const common::TopologyRevision revision = fixture.session.topology()->revision;
    Require(fixture.session.ApplyKey({Stamp(1, revision), "KeyA", true}) ==
                common::InputResult::kCapabilityUnavailable,
            "input must be refused until all required channels open");

    Require(fixture.session.OnDataChannelState(stamp, common::DataChannelKind::kKeyboard,
                                               common::DataChannelState::kOpen) &&
                fixture.session.state() == common::SessionState::kViewing,
            "control must still wait until final required channel opens");
    Require(fixture.session.OnDataChannelState(stamp, common::DataChannelKind::kPointer,
                                               common::DataChannelState::kOpen) &&
                fixture.session.state() == common::SessionState::kControlling &&
                fixture.disclosure.shows.back() == std::pair<std::uint32_t, std::uint32_t>{2, 1},
            "opening final required channel must automatically promote to Control");
  }

  // 4. Reverse order: all data channels open BEFORE PeerConnection reaches kConnected.
  {
    Fixture fixture;
    const macos::MacosRemoteDesktopStartRequest view_request = Request(/*controllers=*/0);
    Require(fixture.session.Start(view_request), "peer-last fixture should start");
    const common::TransportCallbackStamp stamp = StampFor(view_request);
    for (const common::DataChannelKind channel :
         {common::DataChannelKind::kControl, common::DataChannelKind::kKeyboard,
          common::DataChannelKind::kPointer}) {
      Require(fixture.session.OnDataChannelState(stamp, channel, common::DataChannelState::kOpen),
              "channels opening before kConnected should succeed");
    }
    common::RouteAuthority promote = *view_request.route_authority;
    promote.mode = common::TransportSessionMode::kControl;
    promote.input_epoch = 1;
    Require(fixture.session.ApplyModeAuthority(promote, {.unix_ms = 115, .monotonic_ms = 115}) &&
                fixture.session.state() == common::SessionState::kViewing &&
                fixture.disclosure.shows.back() == std::pair<std::uint32_t, std::uint32_t>{2, 0},
            "ApplyModeAuthority(kControl) before kConnected must hold View");
    Require(fixture.session.OnPeerConnectionState(stamp, common::PeerConnectionState::kConnected,
                                                  {.unix_ms = 120, .monotonic_ms = 120}) &&
                fixture.session.state() == common::SessionState::kControlling &&
                fixture.disclosure.shows.back() == std::pair<std::uint32_t, std::uint32_t>{2, 1},
            "PeerConnection becoming kConnected must promote waiting Control mode");
  }

  // 5. Missing Accessibility keeps ApplyModeAuthority(kControl) failing closed.
  {
    Fixture fixture;
    const macos::MacosRemoteDesktopStartRequest view_request = Request(/*controllers=*/0);
    Require(fixture.session.Start(view_request), "missing-accessibility fixture should start");
    const common::TransportCallbackStamp stamp = StampFor(view_request);
    Require(fixture.session.OnPeerConnectionState(stamp, common::PeerConnectionState::kConnected,
                                                  {.unix_ms = 110, .monotonic_ms = 110}),
            "peer connected");
    for (const common::DataChannelKind channel :
         {common::DataChannelKind::kControl, common::DataChannelKind::kKeyboard,
          common::DataChannelKind::kPointer}) {
      Require(fixture.session.OnDataChannelState(stamp, channel, common::DataChannelState::kOpen),
              "channels opened");
    }
    fixture.readiness_gate.remove_input = true;
    common::RouteAuthority promote = *view_request.route_authority;
    promote.mode = common::TransportSessionMode::kControl;
    promote.input_epoch = 1;
    Require(!fixture.session.ApplyModeAuthority(promote, {.unix_ms = 120, .monotonic_ms = 120}) &&
                fixture.session.state() == common::SessionState::kViewing &&
                fixture.disclosure.shows.back() == std::pair<std::uint32_t, std::uint32_t>{2, 0},
            "missing Accessibility must keep ApplyModeAuthority(kControl) failing closed");
  }

  // 6. SetControlActive(false) -> SetControlActive(true) succeeds when transport ready,
  //    and still refuses when transport channels/peer are not ready.
  {
    Fixture fixture;
    const macos::MacosRemoteDesktopStartRequest request = Request(/*controllers=*/1);
    Require(fixture.session.Start(request), "SetControlActive toggle fixture should start");
    Require(!fixture.session.SetControlActive(true, {.unix_ms = 105, .monotonic_ms = 105}) &&
                fixture.session.state() == common::SessionState::kViewing,
            "SetControlActive(true) must stay false while transport is not ready");
    ConnectTransport(fixture, request);
    Require(fixture.session.state() == common::SessionState::kControlling,
            "transport connect should allow Control");
    Require(fixture.session.SetControlActive(false, {.unix_ms = 140, .monotonic_ms = 140}) &&
                fixture.session.state() == common::SessionState::kViewing &&
                fixture.session.transport_diagnostics().mode == common::TransportSessionMode::kView,
            "SetControlActive(false) must downgrade to View");
    Require(fixture.session.SetControlActive(true, {.unix_ms = 150, .monotonic_ms = 150}) &&
                fixture.session.state() == common::SessionState::kControlling &&
                fixture.session.transport_diagnostics().mode == common::TransportSessionMode::kControl &&
                fixture.disclosure.shows.back() == std::pair<std::uint32_t, std::uint32_t>{2, 1},
            "SetControlActive(true) must reactivate Control after downgrade when transport is ready");

    // Partial channels (missing pointer open) must refuse SetControlActive(true).
    Fixture partial;
    const macos::MacosRemoteDesktopStartRequest partial_req = Request(/*controllers=*/1);
    Require(partial.session.Start(partial_req), "partial-channel fixture should start");
    const common::TransportCallbackStamp partial_stamp = StampFor(partial_req);
    Require(partial.session.OnPeerConnectionState(partial_stamp, common::PeerConnectionState::kConnected,
                                                  {.unix_ms = 110, .monotonic_ms = 110}) &&
                partial.session.OnDataChannelState(partial_stamp, common::DataChannelKind::kControl,
                                                   common::DataChannelState::kOpen) &&
                partial.session.OnDataChannelState(partial_stamp, common::DataChannelKind::kKeyboard,
                                                   common::DataChannelState::kOpen) &&
                partial.session.OnDataChannelState(partial_stamp, common::DataChannelKind::kPointer,
                                                   common::DataChannelState::kConnecting),
            "partial open + connecting pointer");
    Require(!partial.session.SetControlActive(true, {.unix_ms = 120, .monotonic_ms = 120}) &&
                partial.session.state() == common::SessionState::kViewing,
            "SetControlActive(true) must refuse while a required channel is not open");

    // Disconnected PeerConnection after SetControlActive(false) must refuse SetControlActive(true).
    Require(fixture.session.SetControlActive(false, {.unix_ms = 160, .monotonic_ms = 160}),
            "downgrade before peer disconnect");
    Require(fixture.session.OnPeerConnectionState(StampFor(request), common::PeerConnectionState::kDisconnected,
                                                  {.unix_ms = 165, .monotonic_ms = 165}),
            "peer disconnect callback succeeds cleanly");
    Require(!fixture.session.SetControlActive(true, {.unix_ms = 170, .monotonic_ms = 170}) &&
                fixture.session.state() == common::SessionState::kViewing,
            "SetControlActive(true) must still refuse while peer connection is disconnected");
    const common::TopologyRevision revision = fixture.session.topology()->revision;
    Require(fixture.session.ApplyKey({Stamp(1, revision), "KeyA", true}) ==
                common::InputResult::kCapabilityUnavailable,
            "input frame must remain rejected while peer connection is disconnected");
  }
}

}  // namespace

int main() {
  TestViewOnlyStartsAndFeedsExistingMediaSeams();
  TestPermissionLossReleasesHeldInputAndDowngrades();
  TestStopDoesNotWaitForBlockingClipboardAdapters();
  TestMonitorSelectionPublishesRevisionAndRejectsStaleInput();
  TestLifecycleBoundaryPerformsTerminalCleanupOnce();
  TestReadinessAndMediaFailuresFailClosed();
  TestTransientCaptureAndEncodeFailuresDoNotEndSession();
  TestPrivacyShieldReplacesEveryFrameBeforeEncoding();
  TestRouteAuthorityActivityModeAndExpiryUseCommonTransportCore();
  TestTransportAdapterFailureAndCompatibilityModeFailHonestly();
  TestRealTransportCallbacksFlowThroughCommonCore();
  TestSetAudioEnabledWorksInViewAndControlModes();
  TestDisplaySwitchAndTopologyChangePreserveAudioIntent();
  TestAudioCompletionOverlapWithRouteDestructionDoesNotDeadlock();
  TestLoginWindowForbidsAudioWhilePreservingAquaAudioAndVideo();
  TestApplyModeAuthorityRoundTripsAndPendingChannelPromotion();
  return 0;
}
