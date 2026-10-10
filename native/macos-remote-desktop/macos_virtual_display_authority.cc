#include "macos_virtual_display_authority.h"

#include <algorithm>
#include <string>
#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

VirtualDisplayResult Fail(VirtualDisplayOutcome outcome, std::string detail) {
  VirtualDisplayResult result;
  result.outcome = outcome;
  result.detail = std::move(detail);
  return result;
}

VirtualDisplayResult Ok() {
  VirtualDisplayResult result;
  result.outcome = VirtualDisplayOutcome::kOk;
  return result;
}

}  // namespace

bool VirtualDisplayAuthorityHooks::IsComplete() const noexcept {
  return static_cast<bool>(read_os_version) &&
         static_cast<bool>(helper_lifecycle) && static_cast<bool>(helper_hold) &&
         static_cast<bool>(helper_release) &&
         static_cast<bool>(capture_first_frame) && static_cast<bool>(now_ms) &&
         static_cast<bool>(sleep_ms);
}

bool VirtualDisplayAuthorityLimits::IsValid() const noexcept {
  return activate_timeout_ms > 0 && poll_interval_ms > 0 &&
         poll_interval_ms <= activate_timeout_ms &&
         max_activation_attempts > 0 && max_activation_attempts <= 16;
}

MacosVirtualDisplayAuthority::MacosVirtualDisplayAuthority(
    SkyLightSeam seam,
    VirtualDisplayAuthorityHooks hooks,
    VirtualDisplayAuthorityLimits limits)
    : seam_(std::move(seam)),
      hooks_(std::move(hooks)),
      limits_(limits) {
  // The version is read once, at construction, from the injected hook. A gate
  // that re-reads per call could be raced by an OS update mid-session into
  // admitting a build it never qualified.
  if (hooks_.read_os_version) {
    version_ = EvaluateVirtualDisplayVersion(
        ParseMacosVersion(hooks_.read_os_version()));
  }
}

common::ReadinessState MacosVirtualDisplayAuthority::ProbeSupport()
    const noexcept {
  if (!version_.may_hold || !seam_.IsComplete() || !hooks_.IsComplete() ||
      !limits_.IsValid()) {
    return common::ReadinessState::kUnavailable;
  }
  // Not kReady on the strength of resolvable symbols. The 26.2 blocker had every
  // selector present and the feature still could not be used safely, so the
  // only evidence accepted here is a display this process actually admitted.
  return ever_admitted_ ? common::ReadinessState::kReady
                        : common::ReadinessState::kUnknown;
}

VirtualDisplayResult MacosVirtualDisplayAuthority::CheckPreconditions() const {
  if (!hooks_.IsComplete())
    return Fail(VirtualDisplayOutcome::kSeamUnavailable, "hooks incomplete");
  if (!limits_.IsValid())
    return Fail(VirtualDisplayOutcome::kInvalidArgument, "limits invalid");
  if (!version_.may_hold) {
    return Fail(VirtualDisplayOutcome::kUnsupportedVersion, version_.reason);
  }
  if (!seam_.IsComplete()) {
    return Fail(VirtualDisplayOutcome::kSeamUnavailable,
                "SkyLight symbols unavailable");
  }
  return Ok();
}

SkyLightDisplayPresence MacosVirtualDisplayAuthority::PresenceNow() const {
  if (display_id_ == 0 || !seam_.list_displays)
    return SkyLightDisplayPresence::kAbsent;
  return PresenceOf(seam_.list_displays(), display_id_);
}

bool MacosVirtualDisplayAuthority::WaitForPresence(
    SkyLightDisplayPresence wanted) {
  const std::uint64_t deadline =
      hooks_.now_ms() + static_cast<std::uint64_t>(limits_.activate_timeout_ms);
  for (;;) {
    if (PresenceNow() == wanted)
      return true;
    if (hooks_.now_ms() >= deadline)
      return false;
    hooks_.sleep_ms(limits_.poll_interval_ms);
  }
}

VirtualDisplayResult MacosVirtualDisplayAuthority::ReconcileOnStart() {
  const VirtualDisplayResult pre = CheckPreconditions();
  if (!pre.ok())
    return pre;
  const HelperLifecycle lifecycle = hooks_.helper_lifecycle();
  if (lifecycle != HelperLifecycle::kRunning) {
    // The holder is gone. Authority NEVER survives its holder: a display left
    // registered by a dead helper is stranded state to be reported and cleaned,
    // never an asset a new generation may inherit.
    if (display_id_ != 0 &&
        PresenceNow() != SkyLightDisplayPresence::kAbsent &&
        std::find(stranded_ids_.begin(), stranded_ids_.end(), display_id_) ==
            stranded_ids_.end()) {
      stranded_ids_.push_back(display_id_);
    }
    holder_ = {};
    display_id_ = 0;
    return Fail(VirtualDisplayOutcome::kHelperUnavailable,
                lifecycle == HelperLifecycle::kCrashed ? "helper crashed"
                                                       : "helper not running");
  }
  // A running helper may legitimately still hold the warm display from a prior
  // route. The display is adoptable; the authority over it is not.
  holder_ = {};
  return Ok();
}

VirtualDisplayResult MacosVirtualDisplayAuthority::Acquire(
    common::WorkerGeneration generation,
    VirtualDisplayAuthorityToken* token) {
  if (token == nullptr || generation == 0)
    return Fail(VirtualDisplayOutcome::kInvalidArgument, "generation/token");
  *token = {};
  const VirtualDisplayResult pre = CheckPreconditions();
  if (!pre.ok())
    return pre;
  if (hooks_.helper_lifecycle() != HelperLifecycle::kRunning) {
    return Fail(VirtualDisplayOutcome::kHelperUnavailable,
                "no live helper holds the display");
  }
  if (holder_.IsValid() && holder_.generation != generation) {
    return Fail(VirtualDisplayOutcome::kAlreadyHeldByOther,
                "another generation holds authority");
  }
  if (activation_attempts_ >= limits_.max_activation_attempts) {
    return Fail(VirtualDisplayOutcome::kRetryBudgetExhausted,
                "activation budget spent; refusing to retry");
  }
  ++activation_attempts_;

  if (display_id_ == 0) {
    // Single-instance cap, checked against SkyLight's view rather than
    // CoreGraphics'. A disabled display is invisible to CGGetOnlineDisplayList
    // but is very much still registered, so "none is online, create one" is
    // exactly how a second display appears. Any id a previous run stranded
    // still counts against the cap: creating alongside it would mean two.
    for (std::uint32_t stranded : stranded_ids_) {
      if (PresenceOf(seam_.list_displays(), stranded) !=
          SkyLightDisplayPresence::kAbsent) {
        return Fail(VirtualDisplayOutcome::kSingleInstanceViolation,
                    "display " + std::to_string(stranded) +
                        " is stranded from a previous run; refusing to create "
                        "a second");
      }
    }
    std::uint32_t held = 0;
    std::string error;
    if (!hooks_.helper_hold(&held, &error) || held == 0) {
      return Fail(VirtualDisplayOutcome::kHelperUnavailable,
                  error.empty() ? "helper refused to hold a display" : error);
    }
    display_id_ = held;
  }

  std::string error;
  if (!seam_.configure_display_enabled(display_id_, true, &error)) {
    return Fail(VirtualDisplayOutcome::kSeamUnavailable,
                error.empty() ? "enable failed" : error);
  }
  if (!seam_.force_extend(display_id_, &error)) {
    // Mirroring would hand capture the wrong surface. Fail rather than serve a
    // mirrored desktop that looks plausible.
    return Fail(VirtualDisplayOutcome::kSeamUnavailable,
                error.empty() ? "extend failed" : error);
  }
  if (!WaitForPresence(SkyLightDisplayPresence::kActive)) {
    return Fail(VirtualDisplayOutcome::kTimedOut,
                "display did not become active within the bounded wait");
  }
  holder_.generation = generation;
  holder_.epoch = next_epoch_++;
  *token = holder_;
  return Ok();
}

VirtualDisplayResult MacosVirtualDisplayAuthority::Admit(
    const VirtualDisplayAuthorityToken& token) {
  if (!token.IsValid())
    return Fail(VirtualDisplayOutcome::kInvalidArgument, "token invalid");
  if (!(token == holder_))
    return Fail(VirtualDisplayOutcome::kStaleToken, "token superseded");
  if (PresenceNow() != SkyLightDisplayPresence::kActive) {
    return Fail(VirtualDisplayOutcome::kTimedOut, "display is not active");
  }
  // A display can be active and still produce nothing — Sunshine issue 5509
  // reports exactly that across display sleep/wake. Admission therefore costs a
  // real frame.
  if (!hooks_.capture_first_frame()) {
    return Fail(VirtualDisplayOutcome::kTimedOut,
                "capture produced no first frame");
  }
  ever_admitted_ = true;
  return Ok();
}

VirtualDisplayResult MacosVirtualDisplayAuthority::ReleaseAuthority(
    const VirtualDisplayAuthorityToken& token) {
  if (!token.IsValid())
    return Fail(VirtualDisplayOutcome::kInvalidArgument, "token invalid");
  if (!(token == holder_))
    return Fail(VirtualDisplayOutcome::kStaleToken, "token superseded");
  const VirtualDisplayResult pre = CheckPreconditions();
  if (!pre.ok())
    return pre;
  std::string error;
  if (!seam_.configure_display_enabled(display_id_, false, &error)) {
    return Fail(VirtualDisplayOutcome::kSeamUnavailable,
                error.empty() ? "disable failed" : error);
  }
  if (!WaitForPresence(SkyLightDisplayPresence::kRegisteredInactive)) {
    return Fail(VirtualDisplayOutcome::kTimedOut,
                "display did not reach registered-inactive");
  }
  // Authority dies here; the display stays warm and registered on purpose.
  holder_ = {};
  return Ok();
}

VirtualDisplayResult MacosVirtualDisplayAuthority::DestroyWarmDisplay() {
  if (display_id_ == 0)
    return Ok();  // idempotent: nothing to remove
  std::string error;
  if (!hooks_.helper_release || !hooks_.helper_release(&error)) {
    return Fail(VirtualDisplayOutcome::kHelperUnavailable,
                error.empty() ? "helper release failed" : error);
  }
  const bool absent = WaitForPresence(SkyLightDisplayPresence::kAbsent);
  holder_ = {};
  if (!absent) {
    // The 26.x reality. Record the id and say so; never report a removal that
    // enumeration did not confirm.
    if (std::find(stranded_ids_.begin(), stranded_ids_.end(), display_id_) ==
        stranded_ids_.end()) {
      stranded_ids_.push_back(display_id_);
    }
    return Fail(VirtualDisplayOutcome::kNotRemoved,
                "display " + std::to_string(display_id_) +
                    " is still registered after release");
  }
  display_id_ = 0;
  return Ok();
}

VirtualDisplayAuthoritySnapshot MacosVirtualDisplayAuthority::Snapshot() const {
  VirtualDisplayAuthoritySnapshot snapshot;
  snapshot.display_id = display_id_;
  snapshot.presence = PresenceNow();
  snapshot.holder = holder_;
  snapshot.admission = ever_admitted_ && holder_.IsValid()
                           ? VirtualDisplayAdmission::kAdmitted
                           : VirtualDisplayAdmission::kDenied;
  snapshot.helper = hooks_.helper_lifecycle ? hooks_.helper_lifecycle()
                                            : HelperLifecycle::kNotRunning;
  snapshot.activation_attempts_spent = activation_attempts_;
  snapshot.stranded_ids = stranded_ids_;
  return snapshot;
}

}  // namespace imcodes::remote_desktop::macos
