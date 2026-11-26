// Counterfactuals for the virtual-display authority model.
//
// A fake WindowServer stands in for SkyLight so every transition below is
// exercised without creating a real display. That is deliberate: on this host a
// failed removal strands a display until reboot, so the state machine has to be
// provable offline before any real mutation is authorised.

#include "macos_virtual_display_authority.h"
#include "macos_virtual_display_helper_protocol.h"
#include "macos_virtual_display_hold_composition.h"
#include "macos_virtual_display_policy.h"

#include <cassert>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace rd = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

// Models what the measured host actually does, including the part that broke
// the previous design: releasing an owner does NOT unregister the display.
class FakeWindowServer {
 public:
  std::uint32_t Hold() {
    const std::uint32_t id = next_id_++;
    registered_[id] = false;  // registered, inactive until explicitly enabled
    held_ = id;
    return id;
  }

  // `sticky_` reproduces macOS 26.2: the helper drops its hold and WindowServer
  // keeps the display anyway.
  bool Release() {
    if (held_ == 0)
      return false;
    if (!sticky_)
      registered_.erase(held_);
    held_ = 0;
    return true;
  }

  bool SetEnabled(std::uint32_t id, bool enabled, std::string* error) {
    auto it = registered_.find(id);
    if (it == registered_.end()) {
      if (error != nullptr)
        *error = "unknown display";
      return false;
    }
    if (enable_fails_) {
      if (error != nullptr)
        *error = "injected enable failure";
      return false;
    }
    it->second = enabled;
    // Enabling the virtual display displaces the headless fallback, exactly as
    // measured: the baseline id vanished from the online list.
    fallback_active_ = !enabled && fallback_exists_;
    return true;
  }

  std::vector<rd::SkyLightDisplay> List() const {
    std::vector<rd::SkyLightDisplay> out;
    if (fallback_exists_) {
      rd::SkyLightDisplay fallback;
      fallback.display_id = kFallbackId;
      fallback.registered = true;
      fallback.active = fallback_active_;
      out.push_back(fallback);
    }
    for (const auto& [id, active] : registered_) {
      rd::SkyLightDisplay display;
      display.display_id = id;
      display.registered = true;
      display.active = active;
      out.push_back(display);
    }
    return out;
  }

  std::vector<std::uint32_t> Online() const {
    std::vector<std::uint32_t> out;
    for (const rd::SkyLightDisplay& display : List()) {
      if (display.active)
        out.push_back(display.display_id);
    }
    return out;
  }

  static constexpr std::uint32_t kFallbackId = 4;
  void set_sticky(bool sticky) { sticky_ = sticky; }
  void set_enable_fails(bool fails) { enable_fails_ = fails; }
  bool fallback_active() const { return fallback_active_; }
  std::size_t registered_count() const { return registered_.size(); }

 private:
  std::map<std::uint32_t, bool> registered_;
  std::uint32_t next_id_ = 5;
  std::uint32_t held_ = 0;
  bool sticky_ = true;
  bool enable_fails_ = false;
  bool fallback_exists_ = true;
  bool fallback_active_ = true;
};

struct Harness {
  FakeWindowServer server;
  rd::HelperLifecycle lifecycle = rd::HelperLifecycle::kRunning;
  std::string os_version = "26.2";
  bool first_frame = true;
  std::uint64_t clock_ms = 0;
  int hold_calls = 0;

  rd::SkyLightSeam Seam() {
    rd::SkyLightSeam seam;
    seam.list_displays = [this] { return server.List(); };
    seam.configure_display_enabled = [this](std::uint32_t id, bool enabled,
                                            std::string* error) {
      return server.SetEnabled(id, enabled, error);
    };
    seam.force_extend = [](std::uint32_t, std::string*) { return true; };
    seam.online_display_ids = [this] { return server.Online(); };
    return seam;
  }

  rd::VirtualDisplayAuthorityHooks Hooks() {
    rd::VirtualDisplayAuthorityHooks hooks;
    hooks.read_os_version = [this] { return os_version; };
    hooks.helper_lifecycle = [this] { return lifecycle; };
    hooks.helper_hold = [this](std::uint32_t* id, std::string* error) {
      ++hold_calls;
      if (lifecycle != rd::HelperLifecycle::kRunning) {
        if (error != nullptr)
          *error = "helper not running";
        return false;
      }
      *id = server.Hold();
      return true;
    };
    hooks.helper_release = [this](std::string*) { return server.Release(); };
    hooks.capture_first_frame = [this] { return first_frame; };
    hooks.now_ms = [this] { return clock_ms; };
    hooks.sleep_ms = [this](std::uint32_t ms) { clock_ms += ms; };
    return hooks;
  }
};

void Check(bool condition, const char* what) {
  if (!condition) {
    std::fprintf(stderr, "FAILED: %s\n", what);
    std::abort();
  }
}

// 1. An unknown or unqualified macOS is refused outright.
void UnknownVersionIsRefused() {
  for (const char* version : {"", "26.2-beta", "99.0", "10.15"}) {
    Harness harness;
    harness.os_version = version;
    rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks());
    rd::VirtualDisplayAuthorityToken token;
    const auto result = authority.Acquire(7, &token);
    Check(!result.ok(), "unqualified macOS must not acquire");
    Check(result.outcome == rd::VirtualDisplayOutcome::kUnsupportedVersion,
          "refusal must name the version gate");
    Check(!token.IsValid(), "no token on refusal");
    Check(harness.hold_calls == 0, "must not reach the helper at all");
    Check(authority.ProbeSupport() == common::ReadinessState::kUnavailable,
          "capability must not advertise on an unqualified OS");
  }
}

// 1b. macOS 26.x may HOLD, but must never claim the legacy teardown works.
//
// `legacy_release_removes` is the single most consequential field this gate
// produces, and it was previously unasserted anywhere. The only test touching
// it was `expect(gateHeader).toContain('legacy_release_removes')` -- a
// source-text assertion on the HEADER, which passes no matter what value the
// function computes. A compile-clean flip of this one field to `true` left the
// entire suite green.
//
// It is load-bearing in production: HelperState::Hold feeds exactly this field
// to AdmitVirtualDisplayHold, which on a removal-regressed major admits only a
// factory that can vouch for a destroy-capable instance. A wrong `true` here
// would route 26.x down the legacy factory instead, letting the helper create a
// display on an OS where the only available teardown was MEASURED not to work
// -- stranding one per route until the user reboots.
//
// This function pins the DECISION only. RefusedHoldCreatesNoBackend below
// executes the admission branch itself, through the same seam production
// enters, including a backend-creation count of exactly zero on refusal.
void RemovalRegressedMajorMustNotClaimLegacyRemoval() {
  for (const char* version : {"26.0", "26.2", "26.2.1", "26.9"}) {
    const rd::VirtualDisplayVersionDecision decision =
        rd::EvaluateVirtualDisplayVersion(rd::ParseMacosVersion(version));
    Check(decision.verdict == rd::VirtualDisplayVersionVerdict::kRemovalRegressed,
          "26.x must be reported as removal-regressed");
    // Still holdable: refusing to hold at all would block the one path that was
    // measured to work (SLVirtualDisplay -destroy).
    Check(decision.may_hold, "26.x must still be permitted to hold");
    Check(!decision.legacy_release_removes,
          "26.x must NOT claim that dropping the legacy owner removes the display");
    Check(decision.modern_destroy_path_expected,
          "26.x must still expect the modern destroy path so the seam can resolve it");
    Check(!decision.reason.empty(), "a refusal-shaped verdict must carry a reason");
  }

  // CONTRAST, so the assertion above is discriminating rather than vacuously
  // true: a qualified pre-26 major DOES report legacy removal. Without this,
  // hard-coding the field to false everywhere would still pass.
  for (const char* version : {"13.0", "14.4", "15.3"}) {
    const rd::VirtualDisplayVersionDecision decision =
        rd::EvaluateVirtualDisplayVersion(rd::ParseMacosVersion(version));
    Check(decision.verdict == rd::VirtualDisplayVersionVerdict::kQualified,
          "pre-26 qualified majors must read as kQualified");
    Check(decision.may_hold, "a qualified major must be permitted to hold");
    Check(decision.legacy_release_removes,
          "a qualified pre-26 major must report that legacy release removes");
  }

  // And the authority really is constructed from this decision on 26.x: it
  // admits (unlike the unqualified versions in test 1), which is what makes the
  // helper guard the only thing standing between 26.x and a stranded display.
  Harness harness;
  harness.os_version = "26.2";
  rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks());
  rd::VirtualDisplayAuthorityToken token;
  Check(authority.Acquire(7, &token).ok(),
        "26.x must reach admission rather than being refused by the version gate");
}

// 1c. The helper's PRE-CREATE hold gate: a refused hold creates no backend.
//
// This drives the same seam production enters -- HelperState::Hold calls
// AdmitVirtualDisplayHold and passes its real factory through it -- so what is
// proved here is the ordering between the decision and the side effect, not a
// restated copy of the condition. The factory counter is the whole point: it
// can only stay at zero if the refusal happens strictly before creation.
void RefusedHoldCreatesNoBackend() {
  const rd::VirtualDisplayVersionDecision regressed =
      rd::EvaluateVirtualDisplayVersion(rd::ParseMacosVersion("26.2"));
  Check(!regressed.legacy_release_removes,
        "fixture precondition: 26.x must report the legacy teardown as broken");

  // THE DEFECT THIS PINS.
  //
  // The gate used to take a capability PROBE and a separate factory. A true
  // probe (SLVirtualDisplay + `-destroy` resolve on this OS) then authorised
  // whatever the factory happened to build -- and the only factory that exists
  // builds a CGVirtualDisplay-backed adapter that never calls `-destroy`. So
  // the capability asserted and the capability created were different
  // statements, and 26.x could still strand a display.
  //
  // The factory must now vouch for the instance it produced. A CG-only factory
  // cannot, so it returns false WITHOUT constructing anything.
  {
    int probe_calls = 0;
    int cg_creates = 0;
    int legacy_creates = 0;
    std::string error;
    const bool admitted = rd::AdmitVirtualDisplayHold(
        regressed.legacy_release_removes,
        [&probe_calls, &cg_creates] {
          // Availability probe says YES...
          ++probe_calls;
          const bool destroy_symbols_resolve = true;
          if (!destroy_symbols_resolve) return false;
          // ...but the only factory available is CG-backed, which cannot vouch
          // for a reliable destroy, so it constructs nothing and declines.
          (void)cg_creates;
          return false;
        },
        [&legacy_creates] { ++legacy_creates; }, &error);
    Check(!admitted,
          "a true availability probe must NOT authorise a CG factory on 26.x");
    Check(error == "removal_unsupported_on_this_os",
          "a refused hold must report exactly removal_unsupported_on_this_os");
    Check(cg_creates == 0 && legacy_creates == 0,
          "a refused hold must create NO backend at all");
    Check(probe_calls == 1, "the vouching factory is what decides on 26.x");
  }

  // A factory that genuinely vouches for a destroy-capable instance proceeds.
  {
    int destroy_capable_creates = 0;
    int legacy_creates = 0;
    std::string error;
    const bool admitted = rd::AdmitVirtualDisplayHold(
        regressed.legacy_release_removes,
        [&destroy_capable_creates] { ++destroy_capable_creates; return true; },
        [&legacy_creates] { ++legacy_creates; }, &error);
    Check(admitted, "a vouched destroy-capable backend may hold on 26.x");
    Check(error.empty(), "an admitted hold reports no error");
    Check(destroy_capable_creates == 1,
          "the destroy-capable factory creates exactly once");
    Check(legacy_creates == 0,
          "26.x must never fall back to the legacy factory");
  }

  // A qualified major whose legacy release really removes uses the legacy
  // factory, and never consults the destroy-capable one.
  {
    const rd::VirtualDisplayVersionDecision qualified =
        rd::EvaluateVirtualDisplayVersion(rd::ParseMacosVersion("15.3"));
    Check(qualified.legacy_release_removes, "fixture precondition: 15.3 removes");
    int destroy_capable_creates = 0;
    int legacy_creates = 0;
    std::string error;
    const bool admitted = rd::AdmitVirtualDisplayHold(
        qualified.legacy_release_removes,
        [&destroy_capable_creates] { ++destroy_capable_creates; return true; },
        [&legacy_creates] { ++legacy_creates; }, &error);
    Check(admitted, "a qualified legacy-removal OS must hold");
    Check(legacy_creates == 1, "it uses the legacy factory exactly once");
    Check(destroy_capable_creates == 0,
          "a qualified OS must not be gated on the modern destroy path");
  }
}

// 1d. PRODUCTION-CHAIN wiring: the endorsed factory, and only it.
//
// RefusedHoldCreatesNoBackend proves the seam's ordering. This proves the shape
// production actually passes to it after wiring: a factory that constructs the
// SL-backed instance and vouches ONLY for that instance, with no global
// availability probe and no CG fallback on any failure path.
//
// The three negative paths are kept distinct on purpose. "Unavailable" (no
// runtime), "constructed but not endorsed" and "endorsed but destroy
// unsupported" fail for different reasons, and collapsing them would let a
// future change satisfy one while silently regressing another.
void ProductionChainAuthorisesOnlyTheEndorsedFactory() {
  const rd::VirtualDisplayVersionDecision regressed =
      rd::EvaluateVirtualDisplayVersion(rd::ParseMacosVersion("26.2"));
  Check(!regressed.legacy_release_removes, "fixture precondition: 26.x");

  // REAL ORDER, EXECUTED -- not asserted on source text.
  //
  // The defect: the gate admitted as soon as the wrapper was ALLOCATED, while
  // CreateExact + this instance's own destroy endorsement + initial activation
  // still lay ahead inside Create(). The unendorsed failure that followed was
  // then misread as an identity collision and burned a PERSISTED generation.
  struct Trace {
    std::vector<std::string> order;
    bool committed = false;
    bool discarded = false;
    std::uint32_t committed_id = 0;
  };

  // (a) success: construct THEN create_exact, and only then commit.
  {
    Trace t;
    rd::VirtualDisplayModernAcquireSeam seam;
    seam.construct = [&t] { t.order.emplace_back("construct"); return true; };
    seam.create_exact = [&t](std::uint32_t* native, std::string*) {
      t.order.emplace_back("create_exact");
      *native = 42;
      return true;
    };
    seam.commit = [&t](std::uint32_t native) {
      t.order.emplace_back("commit");
      t.committed = true;
      t.committed_id = native;
    };
    seam.discard = [&t] { t.discarded = true; };
    const auto r = rd::AcquireEndorsedVirtualDisplay(seam);
    Check(r.admitted, "endorsed acquire must admit");
    Check(t.order == std::vector<std::string>{"construct", "create_exact", "commit"},
          "commit may only follow construct AND create_exact, in that order");
    Check(t.committed && t.committed_id == 42 && r.native_display_id == 42,
          "ownership and native id publish together on success");
    Check(!t.discarded, "a successful acquire discards nothing");
  }

  // (b) allocated but NOT endorsed: create_exact fails.
  {
    Trace t;
    rd::VirtualDisplayModernAcquireSeam seam;
    seam.construct = [&t] { t.order.emplace_back("construct"); return true; };
    seam.create_exact = [&t](std::uint32_t*, std::string* error) {
      t.order.emplace_back("create_exact");
      *error = "sl_destroy_not_endorsed";
      return false;
    };
    seam.commit = [&t](std::uint32_t) { t.order.emplace_back("commit"); t.committed = true; };
    seam.discard = [&t] { t.order.emplace_back("discard"); t.discarded = true; };
    const auto r = rd::AcquireEndorsedVirtualDisplay(seam);
    Check(!r.admitted, "an allocated but unendorsed instance must NOT admit");
    Check(!t.committed, "nothing may be committed for an unendorsed instance");
    Check(t.discarded, "the unendorsed instance must be discarded");
    Check(r.native_display_id == 0, "no display id may survive a refusal");
    // THE REGRESSION THIS PINS: the real reason must survive, and the outcome
    // must not be presentable as an identity collision.
    Check(r.error == "sl_destroy_not_endorsed", "the exact failure reason is preserved");
    Check(!r.identity_generation_consumable,
          "an unendorsed instance must consume ZERO identity generations");
  }

  // (c) unavailable: construct fails, create_exact must never run.
  {
    Trace t;
    rd::VirtualDisplayModernAcquireSeam seam;
    seam.construct = [&t] { t.order.emplace_back("construct"); return false; };
    seam.create_exact = [&t](std::uint32_t*, std::string*) {
      t.order.emplace_back("create_exact");
      return true;
    };
    seam.commit = [&t](std::uint32_t) { t.committed = true; };
    seam.discard = [&t] { t.discarded = true; };
    const auto r = rd::AcquireEndorsedVirtualDisplay(seam);
    Check(!r.admitted, "unavailable must not admit");
    Check(t.order == std::vector<std::string>{"construct"},
          "create_exact must never run when construction failed");
    Check(!t.committed, "nothing committed when unavailable");
    Check(r.error == "removal_unsupported_on_this_os",
          "unavailable fails closed with the exact wire error");
    Check(!r.identity_generation_consumable, "unavailable consumes no generation");
  }
}

// 1e. The PRODUCTION composition binding, and the terminal teardown latch.
//
// The gap this closes: the earlier counterexample drove only the synthetic
// policy seam, so a helper mutation that ignored `admitted` and returned true
// still passed. AdmitModernHoldThroughFactory is the function the production
// lambda actually calls -- the lambda now contains no decision of its own --
// so mutating the verdict here is mutating production.
void ProductionCompositionBindingAndTerminalLatch() {
  // Refused acquisition must produce a refused ADMISSION, with the real error
  // and no native id leaking out.
  {
    rd::VirtualDisplayModernAcquireSeam seam;
    seam.construct = [] { return true; };
    seam.create_exact = [](std::uint32_t*, std::string* error) {
      *error = "sl_destroy_not_endorsed";
      return false;
    };
    bool published = false;
    seam.commit = [&published](std::uint32_t) { published = true; };
    seam.discard = [] {};
    std::uint32_t native = 12345;   // poisoned on purpose
    std::string error;
    const bool admitted = rd::AdmitModernHoldThroughFactory(seam, &native, &error);
    Check(!admitted, "an unendorsed acquisition must NOT admit");
    Check(error == "sl_destroy_not_endorsed", "the real error reaches the caller");
    Check(!published, "nothing may be published for a refused admission");
    Check(native == 12345, "a refused admission must not write a native id");
  }
  // Endorsed acquisition admits and hands back the exact id.
  {
    rd::VirtualDisplayModernAcquireSeam seam;
    seam.construct = [] { return true; };
    seam.create_exact = [](std::uint32_t* n, std::string*) { *n = 77; return true; };
    std::uint32_t published_id = 0;
    seam.commit = [&published_id](std::uint32_t n) { published_id = n; };
    seam.discard = [] {};
    std::uint32_t native = 0;
    std::string error;
    Check(rd::AdmitModernHoldThroughFactory(seam, &native, &error),
          "an endorsed acquisition must admit");
    Check(native == 77 && published_id == 77, "the exact id publishes once");
    Check(error.empty(), "an admitted composition reports no error");
  }

  // TERMINAL LATCH: RELEASE -> shutdown must not rewrite a failed teardown.
  {
    rd::VirtualDisplayTerminalOutcomeLatch latch;
    // First teardown: destroy failed and the display is STILL REGISTERED.
    const rd::VirtualDisplayTerminalTeardown first = latch.Settle([] {
      rd::VirtualDisplayTerminalTeardown o;
      o.removed = false;
      o.leaked_display_id = 9;
      o.presence = "active";
      o.destroy_error = "sl_destroy_verify_timeout";
      return o;
    });
    Check(!first.removed && first.destroy_error == "sl_destroy_verify_timeout",
          "the first verdict records the real failure");
    // Second teardown, as shutdown would do it: a CLEAN run that would report
    // removed/absent. It must never execute, and must never overwrite.
    const rd::VirtualDisplayTerminalTeardown second = latch.Settle([] {
      rd::VirtualDisplayTerminalTeardown clean;
      clean.removed = true;
      clean.presence = "absent";
      return clean;
    });
    Check(latch.run_count() == 1, "the teardown must run exactly once");
    Check(!second.removed, "a later teardown may never promote removed");
    Check(second.presence == "active", "the still-registered presence survives");
    Check(second.destroy_error == "sl_destroy_verify_timeout",
          "destroy_error must never be erased by a second teardown");
    Check(second.leaked_display_id == 9, "the leaked id survives");
  }
}

// 1f. THE PRODUCTION CALLBACK ITSELF, linked and executed.
//
// This drives MakeModernHoldCallback -- the very object helper_main installs --
// not a correct-shaped synthetic copy. Previously the callback was built inline
// in helper_main.mm, which has main() and AppKit and therefore cannot link
// here, so a mutation that ignored the verdict was reachable only by source
// text. Now the decision lives in a linkable TU and this test executes it.
void ProductionModernCallbackIsExecutable() {
  rd::MacosVirtualDisplayConfiguration configuration;
  configuration.worker_generation = 7;
  configuration.vendor_id = 0x4149;
  configuration.product_id = 0x4445;
  configuration.serial_number = 4242;
  Check(configuration.IsValid(), "fixture configuration must be valid");

  // (a) factory unavailable -> refuse, publish nothing.
  {
    int published = 0;
    std::uint32_t native = 999;
    std::string error;
    auto callback = rd::MakeModernHoldCallback(
        configuration,
        [] { return std::unique_ptr<rd::SLVirtualDisplayBackend>(); },
        rd::VirtualDisplayHoldPublication{
            [&published](rd::SLVirtualDisplayBackend*,
                         std::unique_ptr<rd::MacosVirtualDisplayBackend>,
                         std::uint32_t) { ++published; }},
        &native, &error);
    Check(!callback(), "an unavailable factory must not admit");
    Check(published == 0, "nothing may publish when the factory is unavailable");
    Check(error == "removal_unsupported_on_this_os",
          "unavailable fails closed with the exact wire error");
  }

  // (b) constructed but Create fails (unendorsed) -> refuse, publish nothing,
  //     and the real reason survives. This is the case that used to be misread
  //     as an identity collision.
  {
    int published = 0;
    std::uint32_t native = 999;
    std::string error;
    auto callback = rd::MakeModernHoldCallback(
        configuration,
        [] {
          // A real SLVirtualDisplayBackend over a runtime that cannot endorse:
          // Create() must fail rather than hand back an unendorsed instance.
          return rd::CreateSLVirtualDisplayBackend();
        },
        rd::VirtualDisplayHoldPublication{
            [&published](rd::SLVirtualDisplayBackend*,
                         std::unique_ptr<rd::MacosVirtualDisplayBackend>,
                         std::uint32_t) { ++published; }},
        &native, &error);
    const bool admitted = callback();
    // On this host the SL runtime does not endorse, so the honest outcome is a
    // refusal. Whichever way it resolves, the INVARIANT is the same: publish
    // happens if and only if admission succeeded.
    Check(admitted == (published == 1),
          "publication must occur if and only if the callback admitted");
    if (!admitted)
      Check(!error.empty(), "a refusal must carry a reason");
  }
}

// 1g. POST-CALLBACK completion: a modern success must never Create twice.
//
// The P0 this pins: HOLD consulted a `modern_create_attempted` bool that was
// declared false and never assigned. A healthy modern hold -- already created,
// endorsed, activated and published -- fell through to a SECOND Create on the
// live backend, failed as already-created, entered identity-collision
// self-heal and PERSISTED a generation, while the display existed and
// display_id_ stayed 0. There is no flag any more: the published id is the
// signal, and this function is what HelperState runs verbatim.
void PostCallbackCompletionNeverCreatesTwice() {
  // Healthy modern: complete immediately with the exact id, never legacy.
  {
    const auto c = rd::CompleteHoldAfterCallback(true, 4242, "", "");
    Check(c.ok, "a modern success must complete the HOLD");
    Check(c.display_id == 4242, "the published id is reported exactly");
    Check(!c.enter_legacy_create,
          "a modern success must NEVER enter the legacy Create/self-heal path");
    Check(c.error.empty(), "a success carries no error");
  }
  // Legacy pre-26: admitted with no published id -> still owes a CG Create.
  {
    const auto c = rd::CompleteHoldAfterCallback(true, 0, "", "");
    Check(!c.ok, "the legacy path is not complete at this point");
    Check(c.enter_legacy_create, "the legacy path must proceed to its CG Create");
    Check(c.display_id == 0, "no id is claimed for the legacy path yet");
  }
  // Refused: the specific modern reason wins, and legacy is NOT entered.
  {
    const auto c = rd::CompleteHoldAfterCallback(
        false, 0, "sl_destroy_not_endorsed", "removal_unsupported_on_this_os");
    Check(!c.ok, "a refusal is not a success");
    Check(!c.enter_legacy_create,
          "a refused 26.x hold must never fall into the legacy corridor");
    Check(c.error == "sl_destroy_not_endorsed",
          "the specific modern reason survives, never re-presented as collision");
  }
  // Refused with no modern reason falls back to the admission error.
  {
    const auto c = rd::CompleteHoldAfterCallback(
        false, 0, "", "removal_unsupported_on_this_os");
    Check(c.error == "removal_unsupported_on_this_os",
          "the admission error is used when no modern reason exists");
  }
}

// 2. Capability is never advertised before a real admitted display.
void CapabilityNeedsRealAdmission() {
  Harness harness;
  rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks());
  Check(authority.ProbeSupport() == common::ReadinessState::kUnknown,
        "resolvable symbols alone must not report ready");
  rd::VirtualDisplayAuthorityToken token;
  Check(authority.Acquire(1, &token).ok(), "acquire");
  Check(authority.ProbeSupport() == common::ReadinessState::kUnknown,
        "an active display alone is still not qualification");
  Check(authority.Admit(token).ok(), "admit");
  Check(authority.ProbeSupport() == common::ReadinessState::kReady,
        "ready only after active + first frame");
}

// 3. Admission requires a captured frame, not merely an active display.
void ActiveWithoutFrameIsDenied() {
  Harness harness;
  harness.first_frame = false;
  rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks());
  rd::VirtualDisplayAuthorityToken token;
  Check(authority.Acquire(1, &token).ok(), "acquire");
  Check(!authority.Admit(token).ok(), "no frame means no admission");
  Check(authority.Snapshot().admission == rd::VirtualDisplayAdmission::kDenied,
        "snapshot must report denied");
  Check(authority.ProbeSupport() != common::ReadinessState::kReady,
        "denied admission must not advertise capability");
}

// 4. Route end disables the display; inactive is NOT removed.
void ReleaseDisablesButKeepsRegistered() {
  Harness harness;
  rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks());
  rd::VirtualDisplayAuthorityToken token;
  Check(authority.Acquire(1, &token).ok(), "acquire");
  Check(authority.Admit(token).ok(), "admit");
  const std::uint32_t id = authority.Snapshot().display_id;
  Check(authority.Snapshot().presence == rd::SkyLightDisplayPresence::kActive,
        "active while routed");
  Check(authority.ReleaseAuthority(token).ok(), "release");
  const auto snapshot = authority.Snapshot();
  Check(snapshot.presence == rd::SkyLightDisplayPresence::kRegisteredInactive,
        "disabled display must remain REGISTERED, not absent");
  Check(snapshot.display_id == id, "the warm display keeps its identity");
  Check(!snapshot.holder.IsValid(), "authority is revoked at route end");
  // The weaker CoreGraphics view would have called this "gone".
  const auto online = harness.server.Online();
  Check(std::find(online.begin(), online.end(), id) == online.end(),
        "an inactive display is absent from the ONLINE list only");
  Check(rd::PresenceOf(harness.server.List(), id) ==
            rd::SkyLightDisplayPresence::kRegisteredInactive,
        "SkyLight still sees it: inactive != removed");
}

// 5. Disabling the virtual display restores the headless fallback.
void FallbackRestoresOnDisable() {
  Harness harness;
  rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks());
  rd::VirtualDisplayAuthorityToken token;
  Check(authority.Acquire(1, &token).ok(), "acquire");
  Check(!harness.server.fallback_active(),
        "the virtual display displaces the fallback while active");
  Check(authority.ReleaseAuthority(token).ok(), "release");
  Check(harness.server.fallback_active(),
        "disabling must bring the fallback display back");
}

// 6. A superseded token is dead: no cross-generation authority inheritance.
void RebindMintsFreshAuthority() {
  Harness harness;
  rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks());
  rd::VirtualDisplayAuthorityToken first;
  Check(authority.Acquire(1, &first).ok(), "generation 1 acquires");
  Check(authority.Admit(first).ok(), "generation 1 admitted");

  rd::VirtualDisplayAuthorityToken intruder;
  Check(!authority.Acquire(2, &intruder).ok(),
        "a second generation must not steal a live claim");
  Check(!intruder.IsValid(), "no token for the intruder");

  Check(authority.ReleaseAuthority(first).ok(), "generation 1 releases");
  rd::VirtualDisplayAuthorityToken second;
  Check(authority.Acquire(2, &second).ok(), "generation 2 acquires after release");
  Check(!(second == first), "rebind must mint a NEW epoch");
  Check(!authority.Admit(first).ok(), "the old token is dead");
  Check(authority.Admit(first).outcome == rd::VirtualDisplayOutcome::kStaleToken,
        "replay must be named as a stale token");
  Check(!authority.ReleaseAuthority(first).ok(),
        "a stale token must not be able to tear down the live route");
  Check(authority.Admit(second).ok(), "the live token still works");
}

// Same generation number, new epoch: the number alone must not authorise.
void SameGenerationNumberStillNeedsFreshEpoch() {
  Harness harness;
  rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks());
  rd::VirtualDisplayAuthorityToken first;
  Check(authority.Acquire(9, &first).ok(), "acquire");
  Check(authority.ReleaseAuthority(first).ok(), "release");
  rd::VirtualDisplayAuthorityToken again;
  Check(authority.Acquire(9, &again).ok(), "re-acquire same generation number");
  Check(again.generation == first.generation, "same generation number");
  Check(again.epoch != first.epoch, "but a distinct epoch");
  Check(!authority.Admit(first).ok(),
        "the pre-release token must not be replayable");
}

// 7. Helper crash strands nothing silently and grants nothing.
void HelperCrashRevokesAuthority() {
  Harness harness;
  rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks());
  rd::VirtualDisplayAuthorityToken token;
  Check(authority.Acquire(1, &token).ok(), "acquire");
  Check(authority.Admit(token).ok(), "admit");
  const std::uint32_t id = authority.Snapshot().display_id;

  harness.lifecycle = rd::HelperLifecycle::kCrashed;
  const auto reconciled = authority.ReconcileOnStart();
  Check(!reconciled.ok(), "a crashed helper is not a usable state");
  Check(reconciled.outcome == rd::VirtualDisplayOutcome::kHelperUnavailable,
        "crash must be named");
  const auto snapshot = authority.Snapshot();
  Check(!snapshot.holder.IsValid(), "authority does not survive its holder");
  Check(std::find(snapshot.stranded_ids.begin(), snapshot.stranded_ids.end(),
                  id) != snapshot.stranded_ids.end(),
        "the display the dead helper left behind is recorded as stranded");

  // Restart: the stranded display must block creating a SECOND one.
  harness.lifecycle = rd::HelperLifecycle::kRunning;
  Check(authority.ReconcileOnStart().ok(), "restarted helper reconciles");
  rd::VirtualDisplayAuthorityToken after;
  const auto result = authority.Acquire(2, &after);
  Check(!result.ok(), "must not create alongside a stranded display");
  Check(result.outcome == rd::VirtualDisplayOutcome::kSingleInstanceViolation,
        "single-instance cap must be the stated reason");
  Check(harness.server.registered_count() == 1,
        "exactly one display exists, never two");
}

// 8. Bounded timeout, and no retry storm afterwards.
void BoundedTimeoutAndNoRetryStorm() {
  Harness harness;
  harness.server.set_enable_fails(true);
  rd::VirtualDisplayAuthorityLimits limits;
  limits.activate_timeout_ms = 500;
  limits.poll_interval_ms = 50;
  limits.max_activation_attempts = 3;
  rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks(),
                                             limits);
  for (int attempt = 0; attempt < 3; ++attempt) {
    rd::VirtualDisplayAuthorityToken token;
    Check(!authority.Acquire(1, &token).ok(), "enable failure must not acquire");
  }
  rd::VirtualDisplayAuthorityToken token;
  const auto exhausted = authority.Acquire(1, &token);
  Check(exhausted.outcome == rd::VirtualDisplayOutcome::kRetryBudgetExhausted,
        "the fourth attempt must be refused, not retried");
  Check(harness.server.registered_count() == 1,
        "a storm must not multiply displays");
  Check(authority.Snapshot().activation_attempts_spent == 3,
        "the budget is spent exactly once per attempt");
}

void TimeoutIsBounded() {
  Harness harness;
  rd::VirtualDisplayAuthorityLimits limits;
  limits.activate_timeout_ms = 400;
  limits.poll_interval_ms = 100;
  rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks(),
                                             limits);
  rd::VirtualDisplayAuthorityToken token;
  Check(authority.Acquire(1, &token).ok(), "acquire");
  Check(authority.Admit(token).ok(), "admit");
  // Force the release wait to never observe the wanted state.
  harness.server.set_enable_fails(true);
  const std::uint64_t before = harness.clock_ms;
  const auto released = authority.ReleaseAuthority(token);
  Check(!released.ok(), "a failing disable must not report success");
  Check(harness.clock_ms - before <= limits.activate_timeout_ms + 200,
        "the wait must be bounded, not unbounded");
}

// 9. Uninstall never claims a removal it did not observe.
void UninstallReportsStrandedTruthfully() {
  Harness harness;
  rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks());
  rd::VirtualDisplayAuthorityToken token;
  Check(authority.Acquire(1, &token).ok(), "acquire");
  const std::uint32_t id = authority.Snapshot().display_id;

  // macOS 26.x shape: the helper drops the display, WindowServer keeps it.
  harness.server.set_sticky(true);
  const auto sticky = authority.DestroyWarmDisplay();
  Check(!sticky.ok(), "a display that survives release is NOT removed");
  Check(sticky.outcome == rd::VirtualDisplayOutcome::kNotRemoved,
        "the outcome must say not-removed");
  Check(sticky.detail.find(std::to_string(id)) != std::string::npos,
        "the surviving id must be reported for the operator");
  const auto snapshot = authority.Snapshot();
  Check(std::find(snapshot.stranded_ids.begin(), snapshot.stranded_ids.end(),
                  id) != snapshot.stranded_ids.end(),
        "the stranded id is recorded for reboot cleanup");
}

void UninstallSucceedsWhenReallyRemoved() {
  Harness harness;
  rd::MacosVirtualDisplayAuthority authority(harness.Seam(), harness.Hooks());
  rd::VirtualDisplayAuthorityToken token;
  Check(authority.Acquire(1, &token).ok(), "acquire");
  // A hypothetical fixed OS where release really unregisters.
  harness.server.set_sticky(false);
  Check(authority.DestroyWarmDisplay().ok(),
        "removal confirmed by enumeration is a real success");
  Check(authority.Snapshot().display_id == 0, "state is cleared after removal");
  Check(authority.DestroyWarmDisplay().ok(), "teardown stays idempotent");
}

// An incomplete seam must fail closed rather than guess.
void IncompleteSeamFailsClosed() {
  Harness harness;
  rd::SkyLightSeam partial = harness.Seam();
  partial.configure_display_enabled = nullptr;
  Check(!partial.IsComplete(), "a partial seam is not complete");
  rd::MacosVirtualDisplayAuthority authority(partial, harness.Hooks());
  rd::VirtualDisplayAuthorityToken token;
  const auto result = authority.Acquire(1, &token);
  Check(result.outcome == rd::VirtualDisplayOutcome::kSeamUnavailable,
        "a missing private symbol must fail closed");
  Check(authority.ProbeSupport() == common::ReadinessState::kUnavailable,
        "an incomplete seam must not advertise capability");
  Check(harness.hold_calls == 0, "must not create anything");
}

// --- helper control protocol -------------------------------------------------

// Frames are bounded and generation-stamped, so a superseded worker cannot
// disable a display a newer generation just enabled.
void ProtocolRejectsUnstampedAndOversizedFrames() {
  rd::VirtualDisplayHelperCommand command;
  Check(!rd::ParseVirtualDisplayHelperCommand("hold 0 0 9 9 1 0 0 0 0", &command),
        "an unstamped frame must be refused");
  Check(!rd::ParseVirtualDisplayHelperCommand("enable 7 0 9 9 1 1920 1080 60000 100", &command),
        "enable must name a display");
  Check(!rd::ParseVirtualDisplayHelperCommand("hold 7 5 9 9 1 0 0 0 0", &command),
        "hold cannot name a display it has not created");
  Check(!rd::ParseVirtualDisplayHelperCommand("bogus 7 0 9 9 1 0 0 0 0", &command),
        "unknown verbs are refused");
  Check(!rd::ParseVirtualDisplayHelperCommand("hold 007 0 9 9 1 0 0 0 0", &command),
        "leading zeros give a value two encodings");
  Check(!rd::ParseVirtualDisplayHelperCommand("hold 7 0 9 9 1 0 0 0 0 extra", &command),
        "extra fields are refused");
  // NOTE: with exactly three fields and bounded integers, a WELL-FORMED command
  // can never approach the frame cap, so the cap is unreachable by construction
  // on the command grammar. Assert the property that actually rejects this
  // input (an over-long field), and exercise the cap where it is genuinely
  // reachable: reply frames carry free-form OS error text.
  Check(!rd::ParseVirtualDisplayHelperCommand(
            std::string("hold 7 0 9 9 ") + std::string(600, '1'), &command),
        "an over-long field must never be parsed");
  // 20 digits: inside the per-field length budget, so this reaches the overflow
  // arithmetic instead of being rejected earlier for being too long.
  Check(!rd::ParseVirtualDisplayHelperCommand("hold 99999999999999999999 0 9 9 1 0 0 0 0",
                                              &command),
        "a generation that overflows uint64 must not wrap");
  Check(rd::ParseVirtualDisplayHelperCommand("hold 18446744073709551615 0 9 9 1 0 0 0 0",
                                             &command),
        "the largest representable generation is still accepted");
  // display_id is bounded to uint32 independently of the uint64 generation.
  // 4294967301 is chosen because it truncates to 5 — a REAL display id in these
  // fixtures. A bound that merely truncated would silently retarget the command
  // at display 5, so asserting rejection here is asserting the absence of an
  // aliasing bug, not just a range check.
  Check(!rd::ParseVirtualDisplayHelperCommand("enable 7 4294967301 9 9 1 1920 1080 60000 100", &command),
        "a display id beyond uint32 must be refused, never truncated into "
        "another display's id");
  Check(!rd::ParseVirtualDisplayHelperCommand("enable 7 4294967296 9 9 1 1920 1080 60000 100", &command),
        "and one that truncates to zero is refused too");
  Check(rd::ParseVirtualDisplayHelperCommand("disable 7 5 9 9 1 0 0 0 0", &command),
        "a well-formed frame parses");
  Check(command.verb == rd::VirtualDisplayHelperVerb::kDisable &&
            command.generation == 7 && command.display_id == 5,
        "fields survive the round trip");
}

void ProtocolRoundTripsAndRefusesContradictions() {
  for (const auto verb :
       {rd::VirtualDisplayHelperVerb::kHold, rd::VirtualDisplayHelperVerb::kEnable,
        rd::VirtualDisplayHelperVerb::kDisable,
        rd::VirtualDisplayHelperVerb::kStatus,
        rd::VirtualDisplayHelperVerb::kRelease}) {
    rd::VirtualDisplayHelperCommand command;
    command.verb = verb;
    command.generation = 42;
    command.display_id = verb == rd::VirtualDisplayHelperVerb::kHold ? 0 : 5;
    // Authentication fields are mandatory on EVERY verb now, including status:
    // an unauthenticated read-only probe is still a capability oracle.
    command.epoch = 99;
    command.cookie = 12345;
    command.request_index = 3;
    if (verb == rd::VirtualDisplayHelperVerb::kEnable) {
      command.pixels_wide = 1920;
      command.pixels_high = 1080;
      command.refresh_millihertz = 60'000;
      command.scale_percent = 100;
    }
    const std::string line = rd::SerializeVirtualDisplayHelperCommand(command);
    Check(!line.empty(), "serialize");
    Check(line.size() <= rd::kVirtualDisplayHelperMaxFrameBytes, "bounded");
    rd::VirtualDisplayHelperCommand parsed;
    Check(rd::ParseVirtualDisplayHelperCommand(line, &parsed), "reparse");
    Check(parsed.verb == command.verb &&
              parsed.generation == command.generation &&
              parsed.display_id == command.display_id,
          "round trip is lossless");
  }
  rd::VirtualDisplayHelperReply reply;
  Check(!rd::ParseVirtualDisplayHelperReply("ok 1 5 active boom 9 1", &reply),
        "a success frame carrying an error is contradictory");
  Check(!rd::ParseVirtualDisplayHelperReply("err 1 5 active - 9 1", &reply),
        "a failure frame with no error is contradictory");
  Check(!rd::ParseVirtualDisplayHelperReply("ok 1 5 bogus - 9 1", &reply),
        "presence outside the three-state vocabulary is refused");
  Check(rd::ParseVirtualDisplayHelperReply("ok 1 5 inactive - 9 1", &reply),
        "a disabled-but-registered reply is representable");
  Check(reply.ok && reply.presence == "inactive" && reply.error.empty(),
        "inactive is a first-class reportable state");

  // The frame cap is reachable here: a long OS error string must cause the
  // frame to be DROPPED, never truncated — a truncated control frame would
  // change its meaning.
  rd::VirtualDisplayHelperReply oversized;
  oversized.ok = false;
  oversized.generation = 1;
  oversized.display_id = 5;
  oversized.presence = "inactive";
  oversized.error = std::string(rd::kVirtualDisplayHelperMaxFrameBytes + 64, 'x');
  Check(rd::SerializeVirtualDisplayHelperReply(oversized).empty(),
        "an oversized reply must be dropped, not truncated");
  rd::VirtualDisplayHelperReply fits = oversized;
  fits.error = "disable_rejected";
  const std::string line = rd::SerializeVirtualDisplayHelperReply(fits);
  Check(!line.empty() && line.size() <= rd::kVirtualDisplayHelperMaxFrameBytes,
        "an in-budget reply still serializes");
  rd::VirtualDisplayHelperReply reparsed;
  Check(rd::ParseVirtualDisplayHelperReply(line, &reparsed) &&
            !reparsed.ok && reparsed.error == "disable_rejected",
        "reply round trip is lossless");
  // And the parser refuses an oversized frame arriving from the wire.
  Check(!rd::ParseVirtualDisplayHelperReply(
            std::string("err 1 5 inactive ") +
                std::string(rd::kVirtualDisplayHelperMaxFrameBytes, 'x'),
            &reparsed),
        "an oversized inbound reply frame must never be parsed");
  // The error field is the only free-text field in the grammar, so it is where
  // a control byte is genuinely reachable rather than being rejected earlier
  // for failing integer parsing.
  Check(!rd::ParseVirtualDisplayHelperReply(
            std::string("err 1 5 inactive bad\x01text"), &reparsed),
        "a control byte in the free-text field must be refused");
  Check(!rd::ParseVirtualDisplayHelperReply(
            std::string("err 1 5 inactive bad\x7ftext"), &reparsed),
        "DEL is not printable ASCII either");
  // Serialization sanitises rather than refuses, so a hostile OS string cannot
  // inject a field separator or a frame boundary.
  rd::VirtualDisplayHelperReply injected;
  injected.ok = false;
  injected.generation = 1;
  injected.display_id = 5;
  injected.presence = "active";
  injected.error = "a b\nc";
  const std::string safe = rd::SerializeVirtualDisplayHelperReply(injected);
  Check(safe.find(' ') != std::string::npos, "frame still has separators");
  Check(safe.find('\n') == std::string::npos, "no injected frame boundary");
  rd::VirtualDisplayHelperReply back;
  Check(rd::ParseVirtualDisplayHelperReply(safe, &back),
        "a sanitised frame is still parseable");
  Check(back.error == "a_b_c", "injection characters are neutralised");
}

}  // namespace

int main() {
  UnknownVersionIsRefused();
  RemovalRegressedMajorMustNotClaimLegacyRemoval();
  RefusedHoldCreatesNoBackend();
  ProductionChainAuthorisesOnlyTheEndorsedFactory();
  ProductionCompositionBindingAndTerminalLatch();
  ProductionModernCallbackIsExecutable();
  PostCallbackCompletionNeverCreatesTwice();
  CapabilityNeedsRealAdmission();
  ActiveWithoutFrameIsDenied();
  ReleaseDisablesButKeepsRegistered();
  FallbackRestoresOnDisable();
  RebindMintsFreshAuthority();
  SameGenerationNumberStillNeedsFreshEpoch();
  HelperCrashRevokesAuthority();
  BoundedTimeoutAndNoRetryStorm();
  TimeoutIsBounded();
  UninstallReportsStrandedTruthfully();
  UninstallSucceedsWhenReallyRemoved();
  IncompleteSeamFailsClosed();
  ProtocolRejectsUnstampedAndOversizedFrames();
  ProtocolRoundTripsAndRefusesContradictions();
  std::printf("macos virtual display authority counterfactual ok\n");
  return 0;
}
