// Authority over the one warm virtual display, kept separate from its lifetime.
//
// THE MEASURED FACT THIS EXISTS FOR: on macOS 26.2 (25C56, arm64) releasing the
// CGVirtualDisplay owner does not remove the display. The refcount reaches
// zero, -dealloc runs, WindowServer keeps the display, and it survives the
// owning process exiting. Chromium's paired first-removal workaround
// (ui/display/mac/test/virtual_display_util_mac.mm, RemoveDisplay) was
// implemented here and also failed, stranding ids 5 and 6 until reboot.
//
// So "destroy the display when the generation ends" is not implementable, and
// any code shaped around it reports a lie. The model is inverted instead:
//
//   * The DISPLAY is owned by a long-lived signed helper and outlives any one
//     route. Lumen's vd_helper and DeskPad's app lifecycle are the same shape:
//     the display exists exactly as long as the process holding it.
//   * AUTHORITY is a short-lived, generation-scoped claim on that display.
//     Ending a route revokes authority and explicitly DISABLES the display via
//     SkyLight; it does not pretend to remove it.
//
// Three-state presence is load-bearing rather than cosmetic. aspace/displaytoggle
// documents that a display disabled through CGBeginDisplayConfiguration +
// CGSConfigureDisplayEnabled + CGCompleteDisplayConfiguration disappears from
// CGGetOnlineDisplayList while remaining re-enablable by cached id. A caller
// that only asks CGGetOnlineDisplayList therefore cannot tell kAbsent from
// kRegisteredInactive, and would happily create a SECOND display on top of the
// one it already owns.
//
// Everything here is pure C++ behind seams, so the whole state machine is
// provable with no WindowServer and without ever creating a real display.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_AUTHORITY_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_AUTHORITY_H_

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "../remote-desktop-common/value_types.h"
#include "macos_virtual_display_skylight.h"
#include "macos_virtual_display_version_gate.h"

namespace imcodes::remote_desktop::macos {

/** At most one warm display may exist for this product, ever. */
inline constexpr std::size_t kMaxWarmVirtualDisplays = 1;

/**
 * A generation-scoped claim. `epoch` is minted fresh on every acquire, so a
 * token captured by an earlier generation can never be replayed against a later
 * one even if the generation number happens to repeat.
 */
struct VirtualDisplayAuthorityToken {
  common::WorkerGeneration generation = 0;
  std::uint64_t epoch = 0;

  [[nodiscard]] bool IsValid() const noexcept {
    return generation != 0 && epoch != 0;
  }
  [[nodiscard]] bool operator==(
      const VirtualDisplayAuthorityToken& other) const noexcept {
    return generation == other.generation && epoch == other.epoch;
  }
};

enum class VirtualDisplayAdmission {
  kDenied,              // not admitted; never advertise capability
  kAdmitted,            // active AND capture produced a first frame
};

enum class VirtualDisplayOutcome {
  kOk,
  kUnsupportedVersion,      // version gate refused this macOS
  kSeamUnavailable,         // a private symbol is missing: fail closed
  kHelperUnavailable,       // the holding helper is not running
  kAlreadyHeldByOther,      // another generation still holds authority
  kStaleToken,              // token from a superseded epoch
  kSingleInstanceViolation, // a warm display already exists
  kTimedOut,                // bounded wait expired
  kRetryBudgetExhausted,    // refused rather than storm
  kNotRemoved,              // teardown ran and the display is STILL registered
  kInvalidArgument,
};

struct VirtualDisplayResult {
  VirtualDisplayOutcome outcome = VirtualDisplayOutcome::kInvalidArgument;
  std::string detail;
  [[nodiscard]] bool ok() const noexcept {
    return outcome == VirtualDisplayOutcome::kOk;
  }
};

/** What the helper process is doing, as the supervisor last observed it. */
enum class HelperLifecycle {
  kNotRunning,
  kRunning,
  kCrashed,
};

/**
 * Every effect on the world, injectable. No member touches CoreGraphics or
 * SkyLight directly, which is why the counterfactuals below can run under
 * sanitizers on a machine with no display server at all.
 */
struct VirtualDisplayAuthorityHooks {
  /** Reads the running macOS version; empty string means "unknown". */
  std::function<std::string()> read_os_version;
  /** Long-lived holder process state. */
  std::function<HelperLifecycle()> helper_lifecycle;
  /** Asks the helper to create and hold the single warm display. */
  std::function<bool(std::uint32_t* display_id, std::string* error)> helper_hold;
  /** Asks the helper to drop its hold entirely (helper exit / uninstall). */
  std::function<bool(std::string* error)> helper_release;
  /**
   * Capture qualification. Admission requires a real first frame, not merely a
   * display that enumerates: Sunshine issue 5509 shows a display that is
   * present and enumerable while producing no frames across sleep/wake.
   */
  std::function<bool()> capture_first_frame;
  /** Monotonic milliseconds. */
  std::function<std::uint64_t()> now_ms;
  std::function<void(std::uint32_t)> sleep_ms;

  [[nodiscard]] bool IsComplete() const noexcept;
};

struct VirtualDisplayAuthorityLimits {
  std::uint32_t activate_timeout_ms = 5'000;
  std::uint32_t poll_interval_ms = 50;
  /**
   * Hard cap on activation attempts for the whole process lifetime. Once spent,
   * the seam is refused rather than retried: a retry storm against WindowServer
   * is how a single failure turns into many stranded displays.
   */
  std::uint32_t max_activation_attempts = 3;

  [[nodiscard]] bool IsValid() const noexcept;
};

/** Snapshot for diagnostics and for the uninstall/reboot reconciler. */
struct VirtualDisplayAuthoritySnapshot {
  std::uint32_t display_id = 0;
  SkyLightDisplayPresence presence = SkyLightDisplayPresence::kAbsent;
  VirtualDisplayAuthorityToken holder;
  VirtualDisplayAdmission admission = VirtualDisplayAdmission::kDenied;
  HelperLifecycle helper = HelperLifecycle::kNotRunning;
  std::uint32_t activation_attempts_spent = 0;
  /** Display ids the helper is known to have left behind. */
  std::vector<std::uint32_t> stranded_ids;
};

class MacosVirtualDisplayAuthority final {
 public:
  MacosVirtualDisplayAuthority(SkyLightSeam seam,
                               VirtualDisplayAuthorityHooks hooks,
                               VirtualDisplayAuthorityLimits limits = {});

  MacosVirtualDisplayAuthority(const MacosVirtualDisplayAuthority&) = delete;
  MacosVirtualDisplayAuthority& operator=(const MacosVirtualDisplayAuthority&) =
      delete;

  /**
   * Capability advertisement. Deliberately conservative: this reports kReady
   * only once a display has actually been admitted (active AND first frame) on
   * this host. Selector presence is not qualification — the 26.2 blocker is
   * precisely a case where every selector resolved and the feature was still
   * unusable.
   */
  [[nodiscard]] common::ReadinessState ProbeSupport() const noexcept;

  /**
   * Called before any route. Adopts a display the helper already holds, or
   * records ids stranded by a previous run so uninstall can clean them. Never
   * creates anything.
   */
  VirtualDisplayResult ReconcileOnStart();

  /**
   * Claims the warm display for `generation` and enables it. Mints a fresh
   * epoch; any previously issued token is dead from this point.
   */
  VirtualDisplayResult Acquire(common::WorkerGeneration generation,
                               VirtualDisplayAuthorityToken* token);

  /** Admission gate: active AND a real captured frame. */
  VirtualDisplayResult Admit(const VirtualDisplayAuthorityToken& token);

  /**
   * Route end. Revokes authority and explicitly disables the display, leaving
   * it kRegisteredInactive and warm. This is the honest teardown on 26.x.
   */
  VirtualDisplayResult ReleaseAuthority(
      const VirtualDisplayAuthorityToken& token);

  /**
   * Uninstall / shutdown path. Asks the helper to drop the display, then
   * verifies via enumeration. Returns kNotRemoved (with the surviving id in
   * `detail`) when WindowServer keeps it — it never reports a removal it did
   * not observe.
   */
  VirtualDisplayResult DestroyWarmDisplay();

  [[nodiscard]] VirtualDisplayAuthoritySnapshot Snapshot() const;

 private:
  [[nodiscard]] VirtualDisplayResult CheckPreconditions() const;
  [[nodiscard]] SkyLightDisplayPresence PresenceNow() const;
  [[nodiscard]] bool WaitForPresence(SkyLightDisplayPresence wanted);

  SkyLightSeam seam_;
  VirtualDisplayAuthorityHooks hooks_;
  VirtualDisplayAuthorityLimits limits_;
  VirtualDisplayVersionDecision version_;
  std::uint32_t display_id_ = 0;
  VirtualDisplayAuthorityToken holder_;
  std::uint64_t next_epoch_ = 1;
  bool ever_admitted_ = false;
  std::uint32_t activation_attempts_ = 0;
  std::vector<std::uint32_t> stranded_ids_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_AUTHORITY_H_
