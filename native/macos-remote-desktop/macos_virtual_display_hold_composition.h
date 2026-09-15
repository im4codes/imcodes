// The production hold composition, in a LINKABLE translation unit.
//
// Why this file exists: helper_main.mm carries main() and AppKit, so it can
// never be linked into a counterexample binary. While the modern callback was
// built inline there, a mutation that ignored the acquisition verdict and
// returned true was unreachable by any behavioural test -- only source-string
// hygiene could see it, and hygiene is not proof. Everything that DECIDES now
// lives here; helper_main injects concrete dependencies and installs what this
// file returns, nothing more.
//
// The native counterexample links this same TU and drives the same objects, so
// mutating production behaviour is mutating what the test executes.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HOLD_COMPOSITION_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HOLD_COMPOSITION_H_

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "macos_slvirtual_display_backend.h"
#include "macos_virtual_display_adapter.h"
#include "macos_virtual_display_policy.h"

namespace imcodes::remote_desktop::macos {

/**
 * How a successful hold publishes ownership.
 *
 * One call, so the concrete view, the owning pointer and the native id become
 * visible together and never partially.
 */
struct VirtualDisplayHoldPublication {
  std::function<void(SLVirtualDisplayBackend* concrete,
                     std::unique_ptr<MacosVirtualDisplayBackend> owned,
                     std::uint32_t native)>
      publish;
};

/**
 * Builds the modern (26.x) admission callback that helper_main installs.
 *
 * The returned callable performs, in this order and no other: construct through
 * the injected concrete factory, run Create (CreateExact + this instance's own
 * destroy endorsement + initial activation), and only then publish. A refused
 * or unendorsed acquisition publishes nothing, keeps the real error, and leaves
 * no display behind.
 *
 * `factory` is injected rather than called directly so the counterexample can
 * supply an unendorsed or unavailable instance without a real display.
 */
[[nodiscard]] std::function<bool()> MakeModernHoldCallback(
    const MacosVirtualDisplayConfiguration& configuration,
    std::function<std::unique_ptr<SLVirtualDisplayBackend>()> factory,
    VirtualDisplayHoldPublication publication,
    std::uint32_t* native_out,
    std::string* error_out);

/**
 * RELEASE -> runloop stop -> shutdown share ONE terminal verdict.
 *
 * The first teardown is authoritative; every later call replays it verbatim.
 * A second pass must never re-run, never promote `removed`, and never erase
 * `destroy_error` -- that is how an operator-visible leak was previously
 * rewritten into a clean success.
 */
/** What HOLD must do once the admission callback has returned. */
struct VirtualDisplayHoldCompletion {
  bool ok = false;
  std::uint32_t display_id = 0;
  std::string error;
  /** True ONLY for the pre-26 legacy path, which still owes a CG Create. */
  bool enter_legacy_create = false;
};

/**
 * Decides what happens after the admission callback, structurally.
 *
 * The defect this replaces: HOLD consulted a `modern_create_attempted` bool
 * that nothing ever set. A successful modern hold -- which had already created,
 * endorsed, activated and published -- therefore fell through to a SECOND
 * Create on the same backend, deterministically failed as already-created,
 * entered identity-collision self-heal and PERSISTED A GENERATION, while the
 * display existed and display_id_ stayed 0.
 *
 * There is no flag here. The published native id IS the signal: a modern
 * success cannot exist without one, and the legacy path cannot produce one at
 * this point. So the outcome is derived from state that only the real code path
 * can produce, and cannot silently desynchronise again.
 */
[[nodiscard]] VirtualDisplayHoldCompletion CompleteHoldAfterCallback(
    bool admitted,
    std::uint32_t published_native,
    const std::string& modern_error,
    const std::string& admission_error);

class VirtualDisplayReleaseOrchestrator {
 public:
  VirtualDisplayTerminalTeardown Settle(
      const std::function<VirtualDisplayTerminalTeardown()>& run_once);
  [[nodiscard]] bool settled() const noexcept { return latch_.settled(); }
  [[nodiscard]] int run_count() const noexcept { return latch_.run_count(); }

 private:
  VirtualDisplayTerminalOutcomeLatch latch_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HOLD_COMPOSITION_H_
