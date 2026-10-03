#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <deque>
#include <iostream>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "input_ledger.h"
#include "platform_interfaces.h"
#include "protocol_contracts.h"
#include "session_core.h"

namespace common = imcodes::remote_desktop::common;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition)
    return;
  std::cerr << "remote-desktop-common conformance failure: " << message << '\n';
  std::exit(1);
}

bool Near(double actual, double expected) {
  return std::abs(actual - expected) < 0.0001;
}

class FakeCapture final : public common::CaptureAdapter {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  bool Start(const common::DisplayTopology&,
             common::CapturedFrameSink) override {
    started = true;
    return true;
  }
  void Stop() noexcept override {
    started = false;
    ++stop_count;
  }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  bool started = false;
  int stop_count = 0;
};

class FakeEncoder final : public common::EncoderAdapter {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  bool Configure(const common::EncoderConfiguration&,
                 common::H264AccessUnitSink) override {
    configured = true;
    return true;
  }
  bool Encode(common::CapturedFrame, bool) override { return configured; }
  void Stop() noexcept override {
    configured = false;
    ++stop_count;
  }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  bool configured = false;
  int stop_count = 0;
};

class FakeInput final : public common::InputAdapter {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  bool MovePointer(const common::LogicalPoint& point) override {
    moves.push_back(point);
    return !fail_next;
  }
  bool EmitKey(std::string_view key, bool pressed) override {
    key_events.emplace_back(std::string(key), pressed);
    return !fail_next;
  }
  bool EmitButton(std::string_view button, bool pressed) override {
    button_events.emplace_back(std::string(button), pressed);
    return !fail_next;
  }
  bool EmitWheel(double delta_x, double delta_y) override {
    wheel_events.emplace_back(delta_x, delta_y);
    return !fail_next;
  }
  bool EmitText(std::string_view text) override {
    text_events.emplace_back(text);
    return !fail_next;
  }
  void ReleaseAllEmittedState() noexcept override { ++release_all_count; }
  // Models every platform backend: modifiers the OS still holds, minus the
  // ones this adapter itself emitted (its own held keys stay with the path
  // that tracks them), are released.
  std::size_t ReleaseLatchedModifiers() noexcept override {
    ++heal_calls;
    std::size_t released = 0;
    for (auto current = latched.begin(); current != latched.end();) {
      if (EmittedHeld(*current)) {
        ++current;
        continue;
      }
      key_events.emplace_back(*current, false);
      current = latched.erase(current);
      ++released;
    }
    return released;
  }
  bool EmittedHeld(const std::string& key) const {
    for (auto event = key_events.rbegin(); event != key_events.rend(); ++event) {
      if (event->first == key) return event->second;
    }
    return false;
  }

  common::ReadinessState readiness = common::ReadinessState::kUnavailable;
  bool fail_next = false;
  std::vector<std::string> latched;
  int heal_calls = 0;
  std::vector<common::LogicalPoint> moves;
  std::vector<std::pair<std::string, bool>> key_events;
  std::vector<std::pair<std::string, bool>> button_events;
  std::vector<std::pair<double, double>> wheel_events;
  std::vector<std::string> text_events;
  int release_all_count = 0;
};

class FakeClipboard final : public common::ClipboardAdapter {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  bool PasteText(std::string_view) override { return true; }
  bool CopySelection(std::string* text) override {
    *text = "selection";
    return true;
  }

  common::ReadinessState readiness = common::ReadinessState::kUnavailable;
};

class FakeDisplay final : public common::DisplayAdapter {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  std::optional<common::DesktopTopology> EnumerateTopology() override {
    return topology;
  }
  bool SelectDisplay(std::string_view) override { return true; }
  bool SetMode(std::string_view, common::PixelSize) override { return false; }
  bool SetScale(std::string_view, double) override { return false; }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  std::optional<common::DesktopTopology> topology;
};

class FakeDisclosure final : public common::DisclosureAdapter {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  bool Show(std::uint32_t, std::uint32_t) override {
    visible = true;
    return true;
  }
  void Hide() noexcept override {
    visible = false;
    ++hide_count;
  }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  bool visible = false;
  int hide_count = 0;
};

class FakeSessionMonitor final : public common::SessionMonitor {
 public:
  common::ReadinessState ProbeReadiness() override { return readiness; }
  bool Start(Observer next_observer) override {
    observer = std::move(next_observer);
    started = true;
    return true;
  }
  void Stop() noexcept override {
    started = false;
    ++stop_count;
  }

  common::ReadinessState readiness = common::ReadinessState::kReady;
  Observer observer;
  bool started = false;
  int stop_count = 0;
};

class FakeJsonCodec final : public common::JsonProtocolCodec {
 public:
  std::optional<common::ProtocolEnvelope> Decode(
      std::string_view serialized_json,
      common::TerminalError* error) const override {
    if (serialized_json != "{\"type\":\"offer\"}") {
      *error = {common::TerminalErrorCode::kProtocolViolation, "bad fixture"};
      return std::nullopt;
    }
    return common::ProtocolEnvelope{"offer", std::string(serialized_json)};
  }

  std::optional<std::string> Encode(
      const common::ProtocolEnvelope& envelope,
      common::TerminalError* error) const override {
    if (envelope.type != "offer") {
      *error = {common::TerminalErrorCode::kProtocolViolation, "bad type"};
      return std::nullopt;
    }
    return envelope.serialized_json;
  }
};

class FakeIceQueue final : public common::IceCandidateQueue {
 public:
  explicit FakeIceQueue(std::size_t maximum) : maximum_(maximum) {}

  bool Push(common::IceCandidate candidate) override {
    if (values_.size() >= maximum_)
      return false;
    values_.push_back(std::move(candidate));
    return true;
  }
  std::vector<common::IceCandidate> TakeAll() override {
    std::vector<common::IceCandidate> result;
    while (!values_.empty()) {
      result.push_back(std::move(values_.front()));
      values_.pop_front();
    }
    return result;
  }
  void Clear() noexcept override { values_.clear(); }
  std::size_t size() const noexcept override { return values_.size(); }

 private:
  std::size_t maximum_;
  std::deque<common::IceCandidate> values_;
};

class FakeQualityLadder final : public common::QualityLadder {
 public:
  common::QualitySelection Select(
      const common::QualityTarget& target) const noexcept override {
    return common::QualitySelection{
        "fake-half",
        {target.source_pixels.width / 2, target.source_pixels.height / 2},
        15,
        target.bitrate_bps,
    };
  }
};

common::DesktopTopology RetinaTopology(common::TopologyRevision revision) {
  return common::DesktopTopology{
      41,
      revision,
      {common::DisplayTopology{
          "display-41-main",
          41,
          {3024, 1964},
          {100.0, 50.0, 1512.0, 982.0},
          2.0,
          common::DisplayRotation::k0,
          {true, false, false},
      }},
  };
}

common::CapabilityReadiness ViewOnlyReadiness() {
  common::CapabilityReadiness readiness;
  readiness.capture = common::ReadinessState::kReady;
  readiness.encoder = common::ReadinessState::kReady;
  readiness.input = common::ReadinessState::kUnavailable;
  readiness.clipboard = common::ReadinessState::kUnavailable;
  readiness.display = common::ReadinessState::kReady;
  readiness.disclosure = common::ReadinessState::kReady;
  readiness.graphical_session = common::ReadinessState::kReady;
  return readiness;
}

common::InputStamp Stamp(std::string controller,
                         common::InputSequence sequence,
                         common::TopologyRevision revision = 1,
                         common::InputEpoch epoch = 1) {
  return common::InputStamp{std::move(controller), epoch, sequence, revision};
}

}  // namespace

int main() {
  FakeInput ledger_input;
  common::InputLedger ledger(ledger_input);
  Require(ledger.ApplyKey(Stamp("ledger-a", 1, 7), 7, "ShiftLeft", true) ==
              common::InputResult::kApplied,
          "ledger admits the first controller key owner");
  Require(ledger.ApplyKey(Stamp("ledger-b", 1, 7), 7, "ShiftLeft", true) ==
              common::InputResult::kApplied,
          "ledger admits a second controller key owner");
  Require(ledger_input.key_events.size() == 1 &&
              ledger_input.key_events[0] ==
                  std::pair<std::string, bool>{"ShiftLeft", true},
          "multi-controller reference counting emits one physical key down");
  Require(ledger.ApplyButton(Stamp("ledger-a", 1, 7), 7, "primary", true) ==
              common::InputResult::kStaleSequence,
          "stale sequence is rejected by the common ledger");
  Require(ledger_input.button_events.empty(),
          "stale sequence reaches no platform backend");
  Require(ledger.ApplyKey(Stamp("ledger-a", 2, 6, 2), 7, "KeyQ", true) ==
              common::InputResult::kStaleTopology,
          "stale topology is rejected before advancing the controller epoch");
  Require(
      ledger.ReleaseController("ledger-a") == common::InputResult::kApplied &&
          ledger_input.key_events.size() == 1,
      "targeted release preserves a key owned by another controller");
  Require(
      ledger.ReleaseController("ledger-b") == common::InputResult::kApplied &&
          ledger_input.key_events.size() == 2 &&
          !ledger_input.key_events.back().second,
      "last targeted owner release emits the physical key up");

  Require(ledger.ApplyButton(Stamp("ledger-a", 1, 7, 3), 7, "primary", true) ==
              common::InputResult::kApplied,
          "ledger records a pointer-button owner");
  Require(ledger.ApplyButton(Stamp("ledger-a", 2, 7, 2), 7, "primary", false) ==
              common::InputResult::kStaleEpoch,
          "obsolete controller epochs are rejected");
  Require(ledger_input.button_events.size() == 1 &&
              ledger_input.button_events[0].second,
          "stale epochs preserve current held state");
  Require(ledger.ApplyButton(Stamp("ledger-a", 1, 7, 4), 7, "secondary",
                             true) == common::InputResult::kApplied,
          "advancing an epoch releases old ownership before new input");
  Require(ledger_input.button_events.size() == 3 &&
              !ledger_input.button_events[1].second &&
              ledger_input.button_events[2] ==
                  std::pair<std::string, bool>{"secondary", true},
          "epoch advance emits the old button up before the new button down");

  const std::string oversized_text(common::kMaximumInputTextBytes + 1, 'x');
  Require(ledger.ApplyText(Stamp("ledger-a", 2, 7, 4), 7, oversized_text) ==
              common::InputResult::kInvalidInput,
          "oversized text is rejected before sequence consumption");
  Require(ledger.ApplyText(Stamp("ledger-a", 2, 7, 4), 7,
                           "hello \xe4\xb8\x96\xe7\x95\x8c") ==
              common::InputResult::kApplied,
          "bounded UTF-8 text can reuse the unconsumed sequence");
  Require(ledger_input.text_events.size() == 1,
          "only valid text reaches the platform backend");
  const std::string invalid_utf8("\xc0\xaf", 2);
  Require(ledger.ApplyText(Stamp("ledger-a", 3, 7, 4), 7, invalid_utf8) ==
              common::InputResult::kInvalidInput,
          "non-canonical UTF-8 text is rejected");
  Require(ledger.ApplyWheel(Stamp("ledger-a", 3, 7, 4), 7,
                            common::kMaximumWheelDelta + 1.0,
                            0.0) == common::InputResult::kInvalidInput,
          "out-of-range wheel input is rejected before sequence consumption");
  Require(ledger.ApplyWheel(Stamp("ledger-a", 3, 7, 4), 7, 12.0, -24.0) ==
              common::InputResult::kApplied,
          "bounded wheel input can reuse the unconsumed sequence");
  Require(ledger.ApplyWheel(Stamp("ledger-a", 4, 7, 4), 7,
                            std::numeric_limits<double>::infinity(),
                            0.0) == common::InputResult::kInvalidInput,
          "non-finite wheel input is rejected");
  Require(ledger_input.wheel_events.size() == 1,
          "only bounded wheel input reaches the platform backend");
  Require(ledger.ClickButton(Stamp("ledger-a", 4, 7, 4), 7, "primary") ==
              common::InputResult::kApplied,
          "an unowned button can be clicked atomically");
  Require(ledger_input.button_events.size() == 5 &&
              ledger_input.button_events[3] ==
                  std::pair<std::string, bool>{"primary", true} &&
              ledger_input.button_events[4] ==
                  std::pair<std::string, bool>{"primary", false},
          "atomic click emits one bounded down/up pair");
  Require(ledger.ClickButton(Stamp("ledger-a", 5, 7, 4), 7, "secondary") ==
              common::InputResult::kInvalidInput,
          "atomic click cannot release a button another state owns");
  Require(ledger.ApplyText(Stamp("ledger-a", 5, 7, 4), 7, "still fresh") ==
              common::InputResult::kApplied,
          "a refused owned-button click does not consume its sequence");
  ledger.ReleaseAll();
  Require(ledger_input.release_all_count == 1 && ledger.controller_count() == 0,
          "ledger terminal release-all clears every controller");
  Require(
      ledger.ReleaseController("ledger-a") == common::InputResult::kApplied &&
          ledger_input.button_events.size() == 5,
      "release-all leaves no duplicated ownership state");

  // A modifier latched in the OS that this session never pressed (its key-up
  // lost to a crashed worker, a swallowed release, a topology change
  // mid-chord) must not turn later letters into shortcuts or clicks into
  // modified clicks, and must heal mid-session rather than at the next
  // session. Covers every latchable modifier and every press path.
  {
    FakeInput healed;
    common::InputLedger heal_ledger(healed);
    healed.latched = {"MetaLeft", "ControlLeft", "AltRight", "ShiftLeft"};
    Require(heal_ledger.ApplyKey(Stamp("heal", 1, 7), 7, "KeyA", true) ==
                common::InputResult::kApplied &&
                healed.latched.empty() && healed.key_events.size() == 5 &&
                healed.key_events.back() ==
                    std::pair<std::string, bool>{"KeyA", true},
            "every latched modifier is released before a letter is pressed");
    for (std::size_t index = 0; index < 4; ++index) {
      Require(!healed.key_events[index].second,
              "the heal only ever releases, never presses");
    }

    // The operator's own held modifier is not a stray: Shift+A stays Shift+A.
    FakeInput held;
    common::InputLedger held_ledger(held);
    Require(held_ledger.ApplyKey(Stamp("held", 1, 7), 7, "ShiftLeft", true) ==
                common::InputResult::kApplied,
            "operator presses Shift");
    held.latched = {"ShiftLeft"};
    Require(held_ledger.ApplyKey(Stamp("held", 2, 7), 7, "KeyA", true) ==
                common::InputResult::kApplied &&
                held.latched.size() == 1 && held.key_events.size() == 2 &&
                held.key_events.back() == std::pair<std::string, bool>{"KeyA", true},
            "a modifier this session emitted is never healed away");

    // A modifier press itself is not a heal point (it may be the start of the
    // operator's own chord), only what the modifier then applies to is.
    FakeInput chord;
    common::InputLedger chord_ledger(chord);
    chord.latched = {"ControlLeft"};
    Require(chord_ledger.ApplyKey(Stamp("chord", 1, 7), 7, "MetaLeft", true) ==
                common::InputResult::kApplied &&
                chord.heal_calls == 0,
            "pressing a modifier does not trigger a heal");
    Require(chord_ledger.ApplyKey(Stamp("chord", 2, 7), 7, "KeyC", true) ==
                common::InputResult::kApplied &&
                chord.latched.empty() &&
                chord.key_events ==
                    std::vector<std::pair<std::string, bool>>{
                        {"MetaLeft", true}, {"ControlLeft", false}, {"KeyC", true}},
            "Cmd+C with a stray Control latched arrives as Cmd+C, not Ctrl+Cmd+C");
    Require(chord_ledger.ApplyKey(Stamp("chord", 3, 7), 7, "KeyC", false) ==
                common::InputResult::kApplied &&
                chord.heal_calls == 1,
            "a release is not a heal point");

    // Clicks: a latched Control turns a left click into a right click on macOS.
    FakeInput clicks;
    common::InputLedger click_ledger(clicks);
    clicks.latched = {"ControlLeft"};
    Require(click_ledger.ClickButton(Stamp("click", 1, 7), 7, "primary") ==
                common::InputResult::kApplied &&
                clicks.latched.empty() && clicks.key_events.size() == 1 &&
                clicks.button_events.size() == 2,
            "an atomic click heals a latched modifier first");
    clicks.latched = {"MetaLeft"};
    Require(click_ledger.ApplyButton(Stamp("click", 2, 7), 7, "primary", true) ==
                common::InputResult::kApplied &&
                clicks.latched.empty(),
            "a button press heals a latched modifier first");
  }

  // Modifier combinations are held transitions, not a text shortcut or a
  // tap synthesized on the viewer. Exercise every modifier subset against
  // every supported key class so a backend regression that releases a held
  // modifier before the target key (or leaves one latched afterward) fails
  // with the exact transition sequence. Ctrl+Alt+Delete remains deliberately
  // excluded: it is the Windows secure-attention sequence, which the client
  // and native workers reject rather than synthesizing.
  {
    constexpr std::string_view kModifiers[] = {
        "ControlLeft", "ShiftLeft", "AltLeft", "MetaLeft"};
    constexpr std::string_view kKeyClasses[] = {
        "KeyA", "Digit1", "Semicolon", "F1", "ArrowLeft", "Tab",
        "Enter", "Escape", "Backspace", "Delete", "Home", "End",
        "PageUp", "PageDown"};
    std::uint64_t sequence = 1;
    for (unsigned int mask = 1; mask < (1u << 4); ++mask) {
      std::vector<std::string> modifiers;
      for (std::size_t index = 0; index < 4; ++index) {
        if ((mask & (1u << index)) != 0)
          modifiers.emplace_back(kModifiers[index]);
      }
      for (const std::string_view key : kKeyClasses) {
        if (key == "Delete" &&
            (mask & ((1u << 0) | (1u << 2))) ==
                ((1u << 0) | (1u << 2))) {
          continue;
        }
        FakeInput matrix_input;
        common::InputLedger matrix_ledger(matrix_input);
        std::vector<std::pair<std::string, bool>> expected;
        for (const std::string& modifier : modifiers) {
          expected.emplace_back(modifier, true);
          Require(matrix_ledger.ApplyKey(
                      Stamp("combo-matrix", sequence++, 7), 7, modifier,
                      true) == common::InputResult::kApplied,
                  "matrix modifier down is accepted");
        }
        expected.emplace_back(key, true);
        Require(matrix_ledger.ApplyKey(
                    Stamp("combo-matrix", sequence++, 7), 7, key, true) ==
                    common::InputResult::kApplied,
                "matrix target key down is accepted");
        expected.emplace_back(key, false);
        Require(matrix_ledger.ApplyKey(
                    Stamp("combo-matrix", sequence++, 7), 7, key, false) ==
                    common::InputResult::kApplied,
                "matrix target key up is accepted");
        for (auto modifier = modifiers.rbegin(); modifier != modifiers.rend();
             ++modifier) {
          expected.emplace_back(*modifier, false);
          Require(matrix_ledger.ApplyKey(
                      Stamp("combo-matrix", sequence++, 7), 7, *modifier,
                      false) == common::InputResult::kApplied,
                  "matrix modifier up is accepted");
        }
        Require(matrix_input.key_events == expected,
                "modifier matrix reaches the adapter held through key, then releases");
      }
    }
  }

  // A physically held modifier remains authoritative even when it has been
  // quiet for several seconds; browser/controller release is the only source
  // allowed to clear ownership.
  FakeInput held_input;
  common::InputLedger held_ledger(held_input);
  Require(held_ledger.ApplyKey(Stamp("held-controller", 1, 7), 7,
                               "ShiftLeft", true) ==
              common::InputResult::kApplied,
          "held fixture admits a modifier down");
  Require(held_ledger.ApplyKey(Stamp("held-controller", 2, 7), 7,
                               "KeyA", true) ==
              common::InputResult::kApplied,
          "ordinary key can follow a held modifier");
  Require(held_ledger.ClickButton(Stamp("held-controller", 3, 7), 7,
                                  "primary") == common::InputResult::kApplied,
          "click remains modified by the held modifier until explicit release");
  Require(held_input.key_events.size() == 2 &&
              held_input.key_events.back() ==
                  std::pair<std::string, bool>{"KeyA", true},
          "held modifier is not released by elapsed time");

  FakeCapture capture;
  FakeEncoder encoder;
  FakeInput input;
  FakeClipboard clipboard;
  FakeDisplay display;
  FakeDisclosure disclosure;
  FakeSessionMonitor monitor;
  common::PlatformAdapters adapters{capture, encoder,    input,  clipboard,
                                    display, disclosure, monitor};
  common::SessionCore core(adapters);

  const common::DesktopTopology retina = RetinaTopology(1);
  Require(retina.IsValid(), "separate Retina topology is valid");
  Require(retina.displays[0].encoded_pixels.width == 3024,
          "encoded width remains video pixels");
  Require(Near(retina.displays[0].logical_input_bounds.width, 1512.0),
          "logical width remains input coordinates");

  common::CapabilityReadiness readiness = ViewOnlyReadiness();
  Require(readiness.ViewReady(), "partial capability set is view-ready");
  Require(!readiness.ControlReady(),
          "partial capability set is not control-ready");
  Require(core.Start(readiness, retina), "view-only core starts");
  Require(core.state() == common::SessionState::kViewing,
          "partial capability set selects View");
  Require(!core.SetControlActive(true), "missing input cannot claim Control");

  readiness.input = common::ReadinessState::kReady;
  input.readiness = common::ReadinessState::kReady;
  Require(core.UpdateReadiness(readiness),
          "input readiness can become available");
  Require(core.SetControlActive(true), "complete readiness permits Control");
  Require(!core.UpdateTopology(RetinaTopology(1)),
          "non-increasing topology revisions are rejected");

  Require(
      core.ApplyPointerMove({Stamp("controller-a", 1, 0), "display-41-main",
                             0.5, 0.5}) == common::InputResult::kStaleTopology,
      "stale topology input is rejected before injection");
  Require(input.moves.empty(), "stale topology emitted no pointer input");
  Require(core.ApplyPointerMove({Stamp("controller-a", 2), "display-41-main",
                                 0.5, 0.5}) == common::InputResult::kApplied,
          "current topology input is accepted");
  Require(input.moves.size() == 1 && Near(input.moves[0].x, 856.0) &&
              Near(input.moves[0].y, 541.0),
          "pointer maps through logical bounds, never encoded pixels");

  Require(core.ApplyKey({Stamp("controller-a", 3), "ShiftLeft", true}) ==
              common::InputResult::kApplied,
          "first controller owns key");
  Require(core.ApplyKey({Stamp("controller-b", 1), "ShiftLeft", true}) ==
              common::InputResult::kApplied,
          "second controller shares key ownership");
  Require(input.key_events.size() == 1 && input.key_events[0].second,
          "shared ownership emits one physical key down");
  core.ReleaseController("controller-a");
  Require(input.key_events.size() == 1,
          "controller-specific release preserves another owner");
  core.ReleaseController("controller-b");
  Require(input.key_events.size() == 2 && !input.key_events[1].second,
          "last controller release emits key up");

  Require(core.ApplyKey({Stamp("controller-a", 4), "KeyQ", true}) ==
              common::InputResult::kApplied,
          "terminal fixture holds a key");
  Require(core.ApplyButton({Stamp("controller-a", 5), "primary", true}) ==
              common::InputResult::kApplied,
          "terminal fixture holds a pointer button");
  core.ReportAdapterFailure(
      {common::TerminalErrorCode::kCaptureUnavailable, "capture stopped"});
  Require(core.state() == common::SessionState::kTerminal,
          "adapter failure is terminal");
  Require(core.terminal_error().code ==
              common::TerminalErrorCode::kCaptureUnavailable,
          "terminal adapter error is preserved");
  Require(input.release_all_count == 1,
          "terminal failure performs one release-all");
  Require(capture.stop_count == 1 && encoder.stop_count == 1 &&
              disclosure.hide_count == 1 && monitor.stop_count == 1,
          "terminal failure stops every live platform resource");
  core.Stop({common::TerminalErrorCode::kStopped, "duplicate stop"});
  Require(input.release_all_count == 1 && capture.stop_count == 1,
          "terminal cleanup is idempotent");
  Require(core.ApplyKey({Stamp("controller-a", 6), "KeyQ", false}) ==
              common::InputResult::kTerminal,
          "terminal core accepts no later input");

  FakeCapture failing_capture;
  FakeEncoder failing_encoder;
  FakeInput failing_input;
  FakeClipboard failing_clipboard;
  FakeDisplay failing_display;
  FakeDisclosure failing_disclosure;
  FakeSessionMonitor failing_monitor;
  common::PlatformAdapters failing_adapters{
      failing_capture, failing_encoder,    failing_input,  failing_clipboard,
      failing_display, failing_disclosure, failing_monitor};
  common::SessionCore failing_core(failing_adapters);
  common::CapabilityReadiness failing_readiness = ViewOnlyReadiness();
  failing_readiness.input = common::ReadinessState::kReady;
  failing_input.readiness = common::ReadinessState::kReady;
  Require(failing_core.Start(failing_readiness, RetinaTopology(1)) &&
              failing_core.SetControlActive(true),
          "adapter-failure fixture reaches Control");
  failing_input.fail_next = true;
  Require(failing_core.ApplyText({Stamp("controller-failure", 1), "safe"}) ==
              common::InputResult::kAdapterFailure,
          "input backend failure is reported through SessionCore");
  Require(failing_core.state() == common::SessionState::kTerminal &&
              failing_core.terminal_error().code ==
                  common::TerminalErrorCode::kInputUnavailable,
          "input backend failure terminates with the exact input error");
  Require(failing_input.release_all_count == 1,
          "input backend failure performs terminal release-all");

  FakeJsonCodec codec;
  common::TerminalError protocol_error;
  const auto envelope = codec.Decode("{\"type\":\"offer\"}", &protocol_error);
  Require(envelope && envelope->type == "offer",
          "platform-neutral JSON codec seam is usable");
  Require(codec.Encode(*envelope, &protocol_error) == envelope->serialized_json,
          "platform-neutral JSON codec preserves its fixture");

  FakeIceQueue ice(2);
  Require(ice.Push({"0", "candidate:first"}) &&
              ice.Push({"0", "candidate:second"}) &&
              !ice.Push({"0", "candidate:overflow"}),
          "ICE queue seam can be bounded");
  const auto candidates = ice.TakeAll();
  Require(candidates.size() == 2 &&
              candidates[0].candidate == "candidate:first" &&
              candidates[1].candidate == "candidate:second" && ice.size() == 0,
          "ICE queue seam preserves FIFO ordering");

  FakeQualityLadder quality;
  const common::QualitySelection selection =
      quality.Select({3'000'000, {3024, 1964}});
  Require(selection.encoded_pixels.width == 1512 &&
              selection.encoded_pixels.height == 982 &&
              selection.bitrate_bps == 3'000'000,
          "quality-ladder seam consumes encoded pixels only");

  return 0;
}
