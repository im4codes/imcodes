// Admission, retirement and self-heal policy for the aiDesk virtual display.
//
// Pure logic, no OS calls, so every rule below is provable against a fake
// WindowServer. The rules are not invented: each one is a response to a
// measured failure, and the ones adopted from a shipping implementation are
// marked as such. Nothing proprietary is copied — these are the decision rules,
// re-derived and re-expressed.
//
// MEASURED CONTEXT (this host, macOS 26.2 / 25C56, read-only probes):
//   * Stranded ids 5 and 6 carry vendor 0x4149 / product 0x4445 — ours.
//   * SLSGetDisplayList reports {5,6,1,2,3}; online reports {5,6}. Registered
//     and active are genuinely different sets, and only the private enumeration
//     can see the difference.
//   * -[CGVirtualDisplay dealloc] has no reliable teardown; release-to-remove
//     is fail-open by construction.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_POLICY_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_POLICY_H_

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace imcodes::remote_desktop::macos {

/** Hard ceilings. Exceeding any of these is a refusal, never a clamp. */
inline constexpr std::uint32_t kVirtualDisplayMaxTotalDisplays = 5;
inline constexpr std::uint32_t kVirtualDisplayMaxPixelsWide = 8192;
inline constexpr std::uint32_t kVirtualDisplayMaxPixelsHigh = 5120;

/**
 * The two-level fence.
 *
 * A single generation counter is not enough. A slot generation rotates on
 * self-heal within one session, while the process-wide epoch rotates when the
 * owning authority is recreated. Comparing only one of them lets a stale
 * completion from a previous session land on a slot that has since been
 * re-materialised under the same slot generation.
 */
struct VirtualDisplayFence {
  std::uint64_t epoch = 0;
  std::uint32_t slot = 0;
  std::uint32_t slot_generation = 0;

  [[nodiscard]] bool IsValid() const noexcept { return epoch != 0; }
  [[nodiscard]] bool Matches(const VirtualDisplayFence& other) const noexcept {
    return epoch == other.epoch && slot == other.slot &&
           slot_generation == other.slot_generation;
  }
};

/** What the OS currently reports, split the way the three-state model requires. */
struct VirtualDisplayTopologyView {
  /** Everything WindowServer has registered, including disabled displays. */
  std::vector<std::uint32_t> registered_ids;
  /** The subset that is actually in the active topology. */
  std::vector<std::uint32_t> online_ids;

  [[nodiscard]] bool IsRegistered(std::uint32_t display_id) const noexcept;
  [[nodiscard]] bool IsOnline(std::uint32_t display_id) const noexcept;
  /** Registered but not online — the state that is NOT removal. */
  [[nodiscard]] bool IsRegisteredInactive(std::uint32_t display_id) const noexcept;
};

enum class VirtualDisplayPresence {
  kAbsent,
  kRegisteredInactive,
  kActive,
};

[[nodiscard]] VirtualDisplayPresence PresenceIn(
    const VirtualDisplayTopologyView& view,
    std::uint32_t display_id) noexcept;

// ---------------------------------------------------------------------------
// Last-surface guard
// ---------------------------------------------------------------------------

/**
 * Inputs for "may this display be retired right now".
 *
 * The count arithmetic is deliberately explicit rather than a simple
 * "screens > 1" test: displays already being disconnected have not left the
 * enumeration yet, so counting them as present would authorise a removal that
 * strands the session with no surface at all.
 */
struct LastSurfaceGuardInput {
  std::uint32_t current_screen_count = 0;
  std::uint32_t already_disconnecting = 0;
  std::uint32_t newly_removed = 0;
};

enum class LastSurfaceVerdict {
  kAllowed,
  kWouldLeaveNoSurface,
  kInvalidCounts,
};

/**
 * Allows retirement only while
 *   current_screen_count - already_disconnecting - newly_removed >= 1.
 *
 * Underflow is a REFUSAL, not a wrap: unsigned arithmetic would otherwise turn
 * "we are already over-committed" into an enormous positive remainder and
 * authorise exactly the removal this guard exists to stop.
 */
[[nodiscard]] LastSurfaceVerdict EvaluateLastSurfaceGuard(
    const LastSurfaceGuardInput& input) noexcept;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

enum class ActivationDecision {
  kAlreadyActive,     // nothing to do
  kRequestExtend,     // registered but inactive: re-extend before giving up
  kSelfHeal,          // extend already retried and still inactive
  kAbsent,            // not registered at all
};

/**
 * Registered-but-inactive is a RETRY state, not a failure state.
 *
 * A display that is registered and not online has not failed to exist — macOS
 * routinely brings a new virtual display up mirrored or parked, and the correct
 * first response is to ask for extend again. Only after that has been tried and
 * the display is still inactive does the identity get abandoned. Treating the
 * first inactive observation as fatal is what burns identity generations for no
 * reason, and generations are a bounded resource.
 */
[[nodiscard]] ActivationDecision DecideActivation(
    const VirtualDisplayTopologyView& view,
    std::uint32_t display_id,
    std::uint32_t extend_attempts_already_made) noexcept;

/** How many extend attempts are permitted before self-heal. Bounded, small. */
inline constexpr std::uint32_t kVirtualDisplayMaxExtendAttempts = 2;

// ---------------------------------------------------------------------------
// Self-heal ordering
// ---------------------------------------------------------------------------

enum class SelfHealStep {
  kMarkStale,          // atomically mark the slot disconnecting
  kReleaseOldOwner,    // drop the owner
  kAwaitOldIdAbsent,   // MUST observe the old id leave before anything else
  kCreateNewIdentity,  // only now, with generation + 1
  kExhausted,          // bounded walk is over; terminal, reported, no retry
  kBlockedOldIdPresent,// old id still registered; creating now would duplicate
};

struct SelfHealState {
  bool marked_stale = false;
  bool owner_released = false;
  bool old_id_absent = false;
  std::uint32_t identity_generation = 0;
};

/**
 * Drives the ordering, and in particular refuses to create a replacement while
 * the previous id is still registered.
 *
 * This ordering is the whole point. Creating the replacement first is what
 * turns one stranded display into two: the old identity is still held, the new
 * one registers alongside it, and the machine now leaks at twice the rate. On
 * this host that is not hypothetical — it is exactly how ids 5 and 6 both came
 * to exist.
 */
[[nodiscard]] SelfHealStep NextSelfHealStep(
    const SelfHealState& state,
    const VirtualDisplayTopologyView& view,
    std::uint32_t old_display_id) noexcept;

// ---------------------------------------------------------------------------
// Persisted intent vs runtime state
// ---------------------------------------------------------------------------

/**
 * What is safe to write to disk.
 *
 * Runtime handles and display ids are deliberately ABSENT. A display id is
 * meaningful only within one WindowServer session; persisting it invites a
 * restart to "recognise" an id that now belongs to something else entirely —
 * including a physical display. Only the INTENT survives a restart, and the
 * runtime identity is re-derived and re-confirmed by enumeration.
 */
struct PersistedDisplayIntent {
  std::string device_id;
  std::uint32_t slot = 0;
  std::uint32_t pixels_wide = 0;
  std::uint32_t pixels_high = 0;
  bool hidpi = false;
  std::uint32_t identity_generation = 0;

  [[nodiscard]] bool IsValid() const noexcept;
};

/**
 * Rejects any intent that carries a runtime-only field.
 *
 * Enforced as a function rather than a comment because "just this once" is how
 * a display id ends up in a persisted record.
 */
[[nodiscard]] bool PersistedIntentIsRuntimeFree(
    const PersistedDisplayIntent& intent) noexcept;

/** The exact wire error a helper must report when it may not hold at all. */
inline constexpr char kVirtualDisplayRemovalUnsupportedError[] =
    "removal_unsupported_on_this_os";

/**
 * The pre-create gate for a helper hold. It owns the FACTORY BOUNDARY, and it
 * binds the teardown capability to the factory that is actually selected.
 *
 * Why a factory that VOUCHES rather than a capability predicate: an earlier
 * shape took a `destroy_capable` probe and a separate `make_backend`. Those two
 * are not the same statement. `DestroyCapableVirtualDisplayBackendAvailable()`
 * reports that the SLVirtualDisplay class and its `-destroy` selector resolve
 * on this OS; it says nothing about the object this process would construct.
 * The only factory that exists returns a CGVirtualDisplay-backed adapter whose
 * Destroy() releases descriptors and never calls `-destroy`. So a true probe
 * could authorise a backend that still cannot be torn down -- the exact
 * stranded-display risk the gate exists to prevent, re-entered through a
 * split between the capability asserted and the capability created.
 *
 * `make_destroy_capable_backend` must therefore create a backend whose OWN
 * reliable destroy path it can vouch for, and return false WITHOUT creating
 * anything when it cannot. `make_legacy_backend` is reached only where the
 * legacy release genuinely removes the display.
 *
 * Returns true when the hold may proceed. On refusal writes the exact wire
 * error and leaves no backend behind.
 */
[[nodiscard]] bool AdmitVirtualDisplayHold(
    bool legacy_release_removes,
    const std::function<bool()>& make_destroy_capable_backend,
    const std::function<void()>& make_legacy_backend,
    std::string* error);

/**
 * The 26.x acquire composition, extracted so real ordering is executable.
 *
 * The defect this exists to prevent: the gate used to admit as soon as the
 * concrete wrapper had been ALLOCATED, while CreateExact, the instance's own
 * destroy endorsement and initial activation all happened later, inside
 * Create(). Admission therefore vouched for "a wrapper exists", and a genuinely
 * unendorsed instance failed afterwards -- where the caller misread it as an
 * identity collision and BURNED A PERSISTED GENERATION for a display that was
 * never endorsed and never held.
 *
 * Every step is injected so a counterexample can drive the true order rather
 * than assert on source text. `construct` allocates; `create_exact` must be the
 * call that performs CreateExact + endorsement + activation; `commit` publishes
 * ownership; `discard` drops a constructed-but-unendorsed instance leaving no
 * display behind.
 */
struct VirtualDisplayModernAcquireSeam {
  std::function<bool()> construct;
  std::function<bool(std::uint32_t* native, std::string* error)> create_exact;
  std::function<void(std::uint32_t native)> commit;
  std::function<void()> discard;
};

struct VirtualDisplayModernAcquireResult {
  bool admitted = false;
  /** Must remain false on every failure path: an unendorsed instance is not a
   *  collision and may not consume identity generations. */
  bool identity_generation_consumable = false;
  std::uint32_t native_display_id = 0;
  std::string error;
};

/**
 * Returns admitted only after construct AND create_exact have both succeeded,
 * in that order, and only then calls commit. Any failure discards, reports the
 * real reason, and marks the outcome as NOT a collision candidate.
 */
[[nodiscard]] VirtualDisplayModernAcquireResult AcquireEndorsedVirtualDisplay(
    const VirtualDisplayModernAcquireSeam& seam);

/** The terminal teardown verdict, as an operator would observe it. */
struct VirtualDisplayTerminalTeardown {
  bool removed = false;
  std::uint32_t leaked_display_id = 0;
  std::string presence = "absent";
  std::string destroy_error;
};

/**
 * Makes the FIRST teardown verdict terminal.
 *
 * RELEASE tears down, then shutdown tears down again. The second pass saw a
 * cleared target, produced removed=true / presence=absent / destroy_error=none
 * and overwrote a genuine "still registered, destroy failed" verdict -- an
 * operator-visible leak rewritten into a clean success. The latch runs the real
 * teardown once and replays that verdict verbatim thereafter: never re-running,
 * never promoting `removed`, never erasing `destroy_error`.
 */
class VirtualDisplayTerminalOutcomeLatch {
 public:
  VirtualDisplayTerminalTeardown Settle(
      const std::function<VirtualDisplayTerminalTeardown()>& run_once);
  [[nodiscard]] bool settled() const noexcept { return settled_; }
  [[nodiscard]] int run_count() const noexcept { return run_count_; }

 private:
  bool settled_ = false;
  int run_count_ = 0;
  VirtualDisplayTerminalTeardown outcome_;
};

/**
 * The modern (26.x) hold composition the production lambda IS.
 *
 * Extracted so the production decision is executable from a counterexample:
 * previously only the synthetic policy seam was driven, so a helper mutation
 * that ignored `admitted` and returned true still passed. All decision logic
 * lives here; the production lambda supplies real callables and nothing else.
 */
[[nodiscard]] bool AdmitModernHoldThroughFactory(
    const VirtualDisplayModernAcquireSeam& seam,
    std::uint32_t* native_out,
    std::string* error_out);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_POLICY_H_
