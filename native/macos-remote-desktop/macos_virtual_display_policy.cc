#include "macos_virtual_display_policy.h"

#include <algorithm>

namespace imcodes::remote_desktop::macos {

bool VirtualDisplayTopologyView::IsRegistered(std::uint32_t display_id)
    const noexcept {
  return std::find(registered_ids.begin(), registered_ids.end(), display_id) !=
         registered_ids.end();
}

bool VirtualDisplayTopologyView::IsOnline(std::uint32_t display_id)
    const noexcept {
  return std::find(online_ids.begin(), online_ids.end(), display_id) !=
         online_ids.end();
}

bool VirtualDisplayTopologyView::IsRegisteredInactive(
    std::uint32_t display_id) const noexcept {
  return IsRegistered(display_id) && !IsOnline(display_id);
}

VirtualDisplayPresence PresenceIn(const VirtualDisplayTopologyView& view,
                                  std::uint32_t display_id) noexcept {
  if (!view.IsRegistered(display_id))
    return VirtualDisplayPresence::kAbsent;
  return view.IsOnline(display_id) ? VirtualDisplayPresence::kActive
                                   : VirtualDisplayPresence::kRegisteredInactive;
}

LastSurfaceVerdict EvaluateLastSurfaceGuard(
    const LastSurfaceGuardInput& input) noexcept {
  // Checked in widened signed arithmetic. Doing this in uint32 would let an
  // over-committed state (more disconnecting than present) wrap to a huge
  // positive remainder and authorise the exact removal being guarded against.
  const std::int64_t remaining =
      static_cast<std::int64_t>(input.current_screen_count) -
      static_cast<std::int64_t>(input.already_disconnecting) -
      static_cast<std::int64_t>(input.newly_removed);
  // A single signed test is the whole rule. An earlier version also compared
  // each subtrahend against the total first; mutation testing showed that check
  // was dead code, because any over-commitment already lands here as a negative
  // remainder. Two overlapping guards read as defence in depth and are actually
  // one guard plus an untested branch.
  if (remaining < 0)
    return LastSurfaceVerdict::kInvalidCounts;
  return remaining >= 1 ? LastSurfaceVerdict::kAllowed
                        : LastSurfaceVerdict::kWouldLeaveNoSurface;
}

ActivationDecision DecideActivation(
    const VirtualDisplayTopologyView& view,
    std::uint32_t display_id,
    std::uint32_t extend_attempts_already_made) noexcept {
  switch (PresenceIn(view, display_id)) {
    case VirtualDisplayPresence::kActive:
      return ActivationDecision::kAlreadyActive;
    case VirtualDisplayPresence::kAbsent:
      return ActivationDecision::kAbsent;
    case VirtualDisplayPresence::kRegisteredInactive:
      break;
  }
  // Registered-but-inactive: re-extend first. Only once the bounded extend
  // budget is spent is the identity considered poisoned.
  return extend_attempts_already_made < kVirtualDisplayMaxExtendAttempts
             ? ActivationDecision::kRequestExtend
             : ActivationDecision::kSelfHeal;
}

SelfHealStep NextSelfHealStep(const SelfHealState& state,
                              const VirtualDisplayTopologyView& view,
                              std::uint32_t old_display_id) noexcept {
  if (!state.marked_stale)
    return SelfHealStep::kMarkStale;
  if (!state.owner_released)
    return SelfHealStep::kReleaseOldOwner;
  // Enumeration, not deallocation, decides whether the old identity is gone.
  // This is the ordering rule that stops one stranded display becoming two.
  if (!state.old_id_absent) {
    return view.IsRegistered(old_display_id)
               ? SelfHealStep::kBlockedOldIdPresent
               : SelfHealStep::kAwaitOldIdAbsent;
  }
  if (view.IsRegistered(old_display_id))
    return SelfHealStep::kBlockedOldIdPresent;
  // Bounded. Exhaustion is terminal and reported; there is no wrap and no
  // unbounded retry, because the condition it recovers from is permanent until
  // reboot.
  if (state.identity_generation + 1U >= 8U)
    return SelfHealStep::kExhausted;
  return SelfHealStep::kCreateNewIdentity;
}

bool PersistedDisplayIntent::IsValid() const noexcept {
  return !device_id.empty() && pixels_wide > 0 && pixels_high > 0 &&
         pixels_wide <= kVirtualDisplayMaxPixelsWide &&
         pixels_high <= kVirtualDisplayMaxPixelsHigh;
}

bool PersistedIntentIsRuntimeFree(const PersistedDisplayIntent& intent) noexcept {
  // The type carries no runtime handle or display id by construction. This
  // predicate exists so a future field addition has to confront the rule
  // explicitly rather than quietly inheriting persistence.
  // Field-COUNT guard via structured bindings.
  //
  // A sizeof comparison was tried first and proved VACUOUS: adding a
  // std::uint32_t after identity_generation fit inside existing padding, so
  // sizeof stayed 48 and the guard never fired on exactly the case it claimed
  // to catch. A structured binding cannot be padded around — binding N names to
  // a struct with N+1 members is a hard compile error, which is the property
  // this guard actually needs.
  const auto& [device_id, slot, pixels_wide, pixels_high, hidpi,
               identity_generation] = intent;
  (void)device_id;
  (void)slot;
  (void)pixels_wide;
  (void)pixels_high;
  (void)hidpi;
  (void)identity_generation;
  return intent.IsValid();
}

bool AdmitVirtualDisplayHold(
    bool legacy_release_removes,
    const std::function<bool()>& make_destroy_capable_backend,
    const std::function<void()>& make_legacy_backend,
    std::string* error) {
  // Where the legacy release really does remove the display, the ordinary
  // backend is correct and no modern teardown is required of it.
  if (legacy_release_removes) {
    if (make_legacy_backend)
      make_legacy_backend();
    return true;
  }
  // FAIL CLOSED. On a major where dropping the legacy owner does not remove the
  // display, the ONLY thing that may be created is a backend that can actually
  // destroy itself -- and the factory has to say so about the instance it just
  // built, not about symbols that merely resolve somewhere on the system.
  // A factory that cannot vouch must create nothing at all, so a refused hold
  // leaves the display count untouched.
  if (!make_destroy_capable_backend || !make_destroy_capable_backend()) {
    if (error != nullptr)
      *error = kVirtualDisplayRemovalUnsupportedError;
    return false;
  }
  return true;
}

VirtualDisplayModernAcquireResult AcquireEndorsedVirtualDisplay(
    const VirtualDisplayModernAcquireSeam& seam) {
  VirtualDisplayModernAcquireResult result;
  if (!seam.construct || !seam.create_exact) {
    result.error = kVirtualDisplayRemovalUnsupportedError;
    return result;
  }
  // STEP 1: allocate. Allocation alone proves nothing and must never admit.
  if (!seam.construct()) {
    result.error = kVirtualDisplayRemovalUnsupportedError;
    return result;
  }
  // STEP 2: CreateExact + this instance's own destroy endorsement + initial
  // activation. Only this call can justify admission.
  std::uint32_t native = 0;
  std::string error;
  if (!seam.create_exact(&native, &error) || native == 0) {
    if (seam.discard)
      seam.discard();
    // The REAL reason, preserved. Reporting a collision here is what burned a
    // persisted generation for an instance that was never endorsed.
    result.error = error.empty() ? kVirtualDisplayRemovalUnsupportedError : error;
    result.identity_generation_consumable = false;
    return result;
  }
  // STEP 3: publish ownership only now, as one commit.
  if (seam.commit)
    seam.commit(native);
  result.admitted = true;
  result.native_display_id = native;
  return result;
}

VirtualDisplayTerminalTeardown VirtualDisplayTerminalOutcomeLatch::Settle(
    const std::function<VirtualDisplayTerminalTeardown()>& run_once) {
  if (settled_)
    return outcome_;  // replay, never re-run
  if (run_once) {
    ++run_count_;
    outcome_ = run_once();
  }
  settled_ = true;
  return outcome_;
}

bool AdmitModernHoldThroughFactory(const VirtualDisplayModernAcquireSeam& seam,
                                   std::uint32_t* native_out,
                                   std::string* error_out) {
  const VirtualDisplayModernAcquireResult acquired =
      AcquireEndorsedVirtualDisplay(seam);
  if (error_out != nullptr)
    *error_out = acquired.error;
  if (!acquired.admitted)
    return false;
  if (native_out != nullptr)
    *native_out = acquired.native_display_id;
  return true;
}

}  // namespace imcodes::remote_desktop::macos
