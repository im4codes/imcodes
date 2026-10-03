#include "session_core.h"

#include <cmath>
#include <utility>

namespace imcodes::remote_desktop::common {

namespace {

TerminalError StoppedError() {
  return TerminalError{TerminalErrorCode::kStopped, "session stopped"};
}

}  // namespace

SessionCore::SessionCore(PlatformAdapters adapters)
    : adapters_(adapters), input_ledger_(adapters.input) {}

SessionCore::~SessionCore() {
  Stop(StoppedError());
}

bool SessionCore::Start(CapabilityReadiness readiness,
                        DesktopTopology topology) {
  if (state_ != SessionState::kIdle || !readiness.ViewReady() ||
      !topology.IsValid()) {
    return false;
  }
  readiness_ = readiness;
  topology_ = std::move(topology);
  state_ = SessionState::kViewing;
  return true;
}

bool SessionCore::UpdateReadiness(CapabilityReadiness readiness) {
  if (state_ == SessionState::kTerminal || !readiness.ViewReady()) {
    if (state_ != SessionState::kTerminal) {
      ReportAdapterFailure(TerminalError{
          TerminalErrorCode::kAdapterFailure,
          "view capability became unavailable",
      });
    }
    return false;
  }
  readiness_ = readiness;
  if (state_ == SessionState::kControlling && !readiness_.ControlReady()) {
    ReleaseAllControllers();
    state_ = SessionState::kViewing;
  }
  return true;
}

bool SessionCore::UpdateTopology(DesktopTopology topology) {
  if (state_ == SessionState::kTerminal || !topology.IsValid() || !topology_ ||
      topology.generation != topology_->generation ||
      topology.revision <= topology_->revision) {
    return false;
  }
  ReleaseAllControllers();
  topology_ = std::move(topology);
  return true;
}

bool SessionCore::SetControlActive(bool active) {
  if (state_ == SessionState::kTerminal || !readiness_.ViewReady()) {
    return false;
  }
  if (active) {
    if (!readiness_.ControlReady())
      return false;
    state_ = SessionState::kControlling;
  } else {
    ReleaseAllControllers();
    state_ = SessionState::kViewing;
  }
  return true;
}

InputResult SessionCore::EnsureControlAvailable() const noexcept {
  if (state_ == SessionState::kTerminal)
    return InputResult::kTerminal;
  if (state_ != SessionState::kControlling || !readiness_.ControlReady()) {
    return InputResult::kCapabilityUnavailable;
  }
  return InputResult::kApplied;
}

InputResult SessionCore::HandleLedgerResult(InputResult result,
                                            std::string_view operation) {
  if (result != InputResult::kAdapterFailure)
    return result;
  ReportAdapterFailure(TerminalError{
      TerminalErrorCode::kInputUnavailable,
      std::string(operation) + " adapter failed",
  });
  return InputResult::kAdapterFailure;
}

InputResult SessionCore::ApplyPointerMove(const PointerMove& move) {
  const InputResult validation = EnsureControlAvailable();
  if (validation != InputResult::kApplied)
    return validation;
  if (!std::isfinite(move.normalized_x) || !std::isfinite(move.normalized_y) ||
      move.normalized_x < 0.0 || move.normalized_x > 1.0 ||
      move.normalized_y < 0.0 || move.normalized_y > 1.0) {
    return InputResult::kInvalidInput;
  }
  const DisplayTopology* display = topology_->FindDisplay(move.display_id);
  if (display == nullptr)
    return InputResult::kUnknownDisplay;
  return HandleLedgerResult(
      input_ledger_.ApplyPointer(move.stamp, topology_->revision,
                                 display->logical_input_bounds.MapNormalized(
                                     move.normalized_x, move.normalized_y)),
      "pointer");
}

InputResult SessionCore::ApplyKey(const KeyTransition& transition) {
  const InputResult validation = EnsureControlAvailable();
  if (validation != InputResult::kApplied)
    return validation;
  return HandleLedgerResult(
      input_ledger_.ApplyKey(transition.stamp, topology_->revision,
                             transition.key, transition.pressed),
      "key transition");
}

InputResult SessionCore::ApplyButton(const ButtonTransition& transition) {
  const InputResult validation = EnsureControlAvailable();
  if (validation != InputResult::kApplied)
    return validation;
  return HandleLedgerResult(
      input_ledger_.ApplyButton(transition.stamp, topology_->revision,
                                transition.button, transition.pressed),
      "button transition");
}

InputResult SessionCore::ClickButton(const ButtonTransition& transition) {
  const InputResult available = EnsureControlAvailable();
  if (available != InputResult::kApplied)
    return available;
  if (!topology_)
    return InputResult::kStaleTopology;
  return HandleLedgerResult(
      input_ledger_.ClickButton(transition.stamp, topology_->revision,
                                transition.button),
      "button_click");
}

InputResult SessionCore::ApplyWheel(const WheelInput& input) {
  const InputResult validation = EnsureControlAvailable();
  if (validation != InputResult::kApplied)
    return validation;
  return HandleLedgerResult(
      input_ledger_.ApplyWheel(input.stamp, topology_->revision, input.delta_x,
                               input.delta_y),
      "wheel");
}

InputResult SessionCore::ApplyText(const TextInput& input) {
  const InputResult validation = EnsureControlAvailable();
  if (validation != InputResult::kApplied)
    return validation;
  return HandleLedgerResult(
      input_ledger_.ApplyText(input.stamp, topology_->revision, input.text),
      "text");
}

void SessionCore::ReleaseController(std::string_view controller_id) noexcept {
  if (input_ledger_.ReleaseController(controller_id) ==
      InputResult::kAdapterFailure) {
    ReportAdapterFailure(TerminalError{
        TerminalErrorCode::kInputUnavailable,
        "input release adapter failed while releasing controller",
    });
  }
}

void SessionCore::ReleaseAllControllers() noexcept {
  input_ledger_.ReleaseAll();
}

void SessionCore::StopPlatformResources() noexcept {
  if (resources_stopped_)
    return;
  resources_stopped_ = true;
  adapters_.capture.Stop();
  adapters_.encoder.Stop();
  adapters_.disclosure.Hide();
  adapters_.session_monitor.Stop();
}

void SessionCore::ReportAdapterFailure(TerminalError error) noexcept {
  if (!error.IsTerminal()) {
    error = TerminalError{TerminalErrorCode::kAdapterFailure,
                          "adapter failed without a terminal code"};
  }
  Stop(std::move(error));
}

void SessionCore::Stop(TerminalError error) noexcept {
  if (state_ == SessionState::kTerminal)
    return;
  // Terminal cleanup always calls the backend release seam, even if the
  // ledger currently appears empty. The backend may have emitted a transition
  // immediately before reporting failure, so local bookkeeping alone is not
  // authoritative enough to skip this safety action.
  input_ledger_.ReleaseAll();
  StopPlatformResources();
  terminal_error_ = error.IsTerminal() ? std::move(error) : StoppedError();
  state_ = SessionState::kTerminal;
}

}  // namespace imcodes::remote_desktop::common
