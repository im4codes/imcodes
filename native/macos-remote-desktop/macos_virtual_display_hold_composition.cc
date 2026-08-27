#include "macos_virtual_display_hold_composition.h"

#include <utility>

namespace imcodes::remote_desktop::macos {

std::function<bool()> MakeModernHoldCallback(
    const MacosVirtualDisplayConfiguration& configuration,
    std::function<std::unique_ptr<SLVirtualDisplayBackend>()> factory,
    VirtualDisplayHoldPublication publication,
    std::uint32_t* native_out,
    std::string* error_out) {
  return [configuration, factory = std::move(factory),
          publication = std::move(publication), native_out,
          error_out]() -> bool {
    // The instance is owned locally for the whole attempt. If it is never
    // endorsed it dies here, so an unendorsed backend can never escape into
    // ownership -- the failure mode that let 26.x hold a display it could not
    // destroy.
    std::unique_ptr<SLVirtualDisplayBackend> pending;
    SLVirtualDisplayBackend* concrete = nullptr;

    VirtualDisplayModernAcquireSeam seam;
    seam.construct = [&]() -> bool {
      if (!factory)
        return false;
      pending = factory();
      concrete = pending.get();
      return pending != nullptr;
    };
    // CreateExact + this instance's own destroy endorsement + initial
    // activation. Nothing before this line may justify admission.
    seam.create_exact = [&](std::uint32_t* native, std::string* error) {
      return pending && pending->Create(configuration, native, error);
    };
    seam.commit = [&](std::uint32_t native) {
      if (publication.publish)
        publication.publish(concrete, std::move(pending), native);
    };
    seam.discard = [&] { pending.reset(); };

    // The verdict is NOT decided here and is not decided in helper_main: it is
    // the return of the audited composition, so a mutation that turns a failed
    // or unendorsed acquisition into true has to happen inside code the native
    // counterexample executes.
    return AdmitModernHoldThroughFactory(seam, native_out, error_out);
  };
}

VirtualDisplayHoldCompletion CompleteHoldAfterCallback(
    bool admitted,
    std::uint32_t published_native,
    const std::string& modern_error,
    const std::string& admission_error) {
  VirtualDisplayHoldCompletion completion;
  if (!admitted) {
    // Refusal. The modern reason wins when present: it is the specific one,
    // and it must never be re-presented as a collision.
    completion.error = modern_error.empty() ? admission_error : modern_error;
    return completion;
  }
  if (published_native != 0) {
    // Modern success. Create/endorsement/activation/publication ALREADY
    // happened inside the callback, so HOLD is complete here. Falling through
    // to the legacy corridor would Create a second time on a live backend.
    completion.ok = true;
    completion.display_id = published_native;
    return completion;
  }
  // Admitted with no published id: the pre-26 legacy path, which still owes its
  // CG Create.
  completion.enter_legacy_create = true;
  return completion;
}

VirtualDisplayTerminalTeardown VirtualDisplayReleaseOrchestrator::Settle(
    const std::function<VirtualDisplayTerminalTeardown()>& run_once) {
  return latch_.Settle(run_once);
}

}  // namespace imcodes::remote_desktop::macos
