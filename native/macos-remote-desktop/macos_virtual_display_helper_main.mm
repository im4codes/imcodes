// Long-lived holder for the single warm virtual display.
//
// This process IS the display's lifetime. That is not a stylistic choice: on
// macOS 26.2 releasing the CGVirtualDisplay owner does not remove the display,
// so the only teardown primitive that still works is process exit — and even
// that was measured to leave the display registered. Holding it in a dedicated,
// separately signed process is what makes the lifetime explicit, bounds the
// blast radius of a crash, and matches the two mature implementations
// (Lumen's vd_helper, DeskPad's app lifecycle).
//
// It owns no route and receives no credential. Its entire remote-influenced
// input is four generation-stamped verbs on stdin.

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#import <CoreFoundation/CoreFoundation.h>
#import <dispatch/dispatch.h>

#include <chrono>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sysexits.h>
#include <unistd.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <optional>
#include <string>

#include "macos_virtual_display_adapter.h"
#include "macos_virtual_display_helper_binding.h"
#include "macos_virtual_display_identity.h"
#include "macos_slvirtual_display_backend.h"
#include "macos_virtual_display_hold_composition.h"
#include "macos_virtual_display_policy.h"
#include "macos_virtual_display_helper_protocol.h"
#include "macos_virtual_display_skylight.h"
#include "macos_virtual_display_version_gate.h"

namespace {

namespace rd = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

std::atomic<bool> g_stop{false};


std::string ReadProductVersion() {
  @autoreleasepool {
    NSOperatingSystemVersion version =
        [[NSProcessInfo processInfo] operatingSystemVersion];
    if (version.majorVersion <= 0)
      return {};
    return std::to_string(version.majorVersion) + "." +
           std::to_string(version.minorVersion) + "." +
           std::to_string(version.patchVersion);
  }
}

const char* PresenceText(rd::SkyLightDisplayPresence presence) {
  switch (presence) {
    case rd::SkyLightDisplayPresence::kActive: return "active";
    case rd::SkyLightDisplayPresence::kRegisteredInactive: return "inactive";
    case rd::SkyLightDisplayPresence::kAbsent: break;
  }
  return "absent";
}

bool WriteReply(const rd::VirtualDisplayHelperReply& reply) {
  const std::string line = rd::SerializeVirtualDisplayHelperReply(reply);
  if (line.empty())
    return false;
  const std::string framed = line + "\n";
  if (std::fwrite(framed.data(), 1, framed.size(), stdout) != framed.size())
    return false;
  return std::fflush(stdout) == 0;
}

struct VirtualDisplayHelperTeardownOutcome {
  bool removed = false;
  std::uint32_t leaked_display_id = 0;
  std::string presence = "absent";
  // Set only on the endorsed modern path when DestroyAndVerify() could not
  // confirm removal. Recorded for diagnostics; it never upgrades `removed`,
  // which the presence poll alone decides.
  std::string destroy_error;
};

class HelperState {
 public:
  // The binding arrives at LAUNCH, on an inherited descriptor, before any
  // command is read. It is not derived from the first frame: "first frame wins"
  // would let a stale worker, a racing second worker, or any process of this
  // uid that connected first own the display.
  HelperState(rd::SkyLightSeam seam, rd::VirtualDisplayHelperBinding binding,
              rd::VirtualDisplayVersionDecision version_decision)
      : seam_(std::move(seam)),
        binding_(std::move(binding)),
        version_decision_(std::move(version_decision)) {}

  rd::VirtualDisplayHelperReply Handle(
      const rd::VirtualDisplayHelperCommand& command) {
    rd::VirtualDisplayHelperReply reply;
    reply.generation = command.generation;
    reply.display_id = display_id_;
    reply.presence = PresenceText(Presence());

    // Admission is decided entirely by the launch binding: uid, host epoch,
    // generation, and a per-request cookie that must be derivable from the
    // bound seed and must strictly advance. Every refusal is distinct so a
    // rejected frame is never ambiguous in the field.
    reply.cookie = command.cookie;
    rd::HelperAdmissionRequest admission_request;
    admission_request.epoch = command.epoch;
    admission_request.generation = command.generation;
    admission_request.cookie = command.cookie;
    admission_request.request_index = command.request_index;
    admission_request.running_uid = static_cast<std::uint32_t>(::geteuid());
    const rd::HelperAdmission admission = rd::EvaluateHelperAdmission(
        binding_, /*bound=*/true, highest_spent_index_, admission_request);
    if (admission != rd::HelperAdmission::kAdmitted) {
      reply.ok = false;
      reply.admitted = false;
      reply.error = AdmissionText(admission);
      return reply;
    }
    // Spent only after admission, so a refused frame cannot burn an index and
    // wedge the legitimate host out.
    highest_spent_index_ = command.request_index;
    // Once authority is revoked this helper is finished. Without this a peer
    // could RELEASE (tearing the display down) and then HOLD again, creating a
    // second display under a helper the supervisor already considers spent.
    if (authority_revoked_) {
      reply.ok = false;
      reply.admitted = false;
      reply.error = "authority_revoked";
      return reply;
    }
    // EXPLICIT. This was previously only ever assigned false on the refusal
    // path, so every successful reply serialised admitted=0 and
    // HelperReplyProvesAdmission rejected it -- making authenticated readiness
    // permanently false no matter how healthy the helper was.
    reply.admitted = true;

    switch (command.verb) {
      case rd::VirtualDisplayHelperVerb::kHold:
        return Hold(reply);
      case rd::VirtualDisplayHelperVerb::kEnable:
        return SetEnabled(reply, command, true);
      case rd::VirtualDisplayHelperVerb::kDisable:
        return SetEnabled(reply, command, false);
      case rd::VirtualDisplayHelperVerb::kStatus:
        reply.ok = true;
        return reply;
      case rd::VirtualDisplayHelperVerb::kRelease:
        return Release(reply);
      case rd::VirtualDisplayHelperVerb::kInvalid:
        break;
    }
    reply.ok = false;
    reply.error = "invalid_verb";
    return reply;
  }

  // Authority is dropped BEFORE the display is touched, so a peer still holding
  // the socket cannot re-arm anything half-way through teardown.
  void RevokeAuthority() noexcept { authority_revoked_ = true; }

  /**
   * RELEASE is a real teardown, not a flag.
   *
   * It previously only set an atomic that nothing in the file ever read: no
   * run-loop stop, no revocation, no teardown. The reply still carried the
   * pre-switch `active` presence, so the worker's Destroy always concluded the
   * display had leaked while the helper went on holding it.
   *
   * The order is fixed: revoke authority, tear the display down for real, then
   * report what ENUMERATION says -- absent or registered-inactive -- and only
   * then ask the run loop to stop so the supervisor can reap us.
   */
  rd::VirtualDisplayHelperReply Release(rd::VirtualDisplayHelperReply reply) {
    if (display_id_ != 0 && !LastSurfaceAllowsRemoval()) {
      reply.ok = false;
      reply.error = "would_leave_no_surface";
      return reply;
    }
    RevokeAuthority();
    const VirtualDisplayHelperTeardownOutcome outcome = TearDown();
    reply.ok = true;
    reply.display_id = outcome.leaked_display_id;
    // The enumerated presence, never the state from before the teardown.
    reply.presence = outcome.presence;
    release_requested_ = true;
    return reply;
  }

  [[nodiscard]] bool release_requested() const noexcept {
    return release_requested_;
  }

  /** Same last-surface rule the RELEASE verb applies, for signal/EOF paths. */
  [[nodiscard]] bool ShutdownRemovalAllowed() const {
    return display_id_ == 0 || LastSurfaceAllowsRemoval();
  }

  // Bounded, once, and judged by enumeration.
  //
  // Deallocation is not removal on macOS 26.x -- measured. So this releases the
  // owner and then polls the private registered list AND the online list for up
  // to five seconds. Registered-but-inactive counts as NOT removed: it is the
  // state that looks like success to anything that only asks whether a display
  // is online, and calling it success is how a leak gets reported as a clean
  // shutdown. There is no retry after the deadline; a stranded display is
  // reported, not fought.
  // ONE AUTHORITATIVE TERMINAL OUTCOME.
  //
  // RELEASE tears down, and shutdown tears down again. The second call saw a
  // cleared target, reported removed=true/presence=absent/destroy_error=none,
  // and OVERWROTE a genuine "still registered, destroy failed" verdict with a
  // clean one -- turning an operator-visible leak into a silent success. The
  // first terminal outcome is therefore retained and replayed; a later teardown
  // never re-runs and never rewrites it.
  VirtualDisplayHelperTeardownOutcome TearDown() {
    const rd::VirtualDisplayTerminalTeardown settled =
        terminal_latch_.Settle([this] {
          const VirtualDisplayHelperTeardownOutcome once = TearDownOnce();
          return rd::VirtualDisplayTerminalTeardown{
              once.removed, once.leaked_display_id, once.presence,
              once.destroy_error};
        });
    VirtualDisplayHelperTeardownOutcome outcome;
    outcome.removed = settled.removed;
    outcome.leaked_display_id = settled.leaked_display_id;
    outcome.presence = settled.presence;
    outcome.destroy_error = settled.destroy_error;
    return outcome;
  }

  VirtualDisplayHelperTeardownOutcome TearDownOnce() {
    VirtualDisplayHelperTeardownOutcome outcome;
    const std::uint32_t target = display_id_;
    if (target == 0 || !backend_) {
      outcome.removed = true;  // nothing was ever held
      outcome.presence = "absent";
      return outcome;
    }
    // On the endorsed modern path use DestroyAndVerify: it invokes the exact
    // destroy IMP and confirms removal. A teardown that fails here must NOT be
    // reported as removed -- the presence poll below is what decides, and a
    // quarantined instance is deliberately never claimed as removed.
    if (sl_backend_ != nullptr) {
      std::string destroy_error;
      if (!sl_backend_->DestroyAndVerify(&destroy_error))
        outcome.destroy_error = destroy_error;
    } else {
      backend_->Destroy();
    }
    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(5);
    for (;;) {
      const rd::SkyLightDisplayPresence presence =
          seam_.list_displays ? rd::PresenceOf(seam_.list_displays(), target)
                              : rd::SkyLightDisplayPresence::kAbsent;
      outcome.presence = PresenceText(presence);
      if (presence == rd::SkyLightDisplayPresence::kAbsent) {
        outcome.removed = true;
        break;
      }
      if (std::chrono::steady_clock::now() >= deadline) {
        outcome.removed = false;
        outcome.leaked_display_id = target;
        break;
      }
      // Service the run loop while waiting: WindowServer finishes teardown on
      // its own time and needs our callbacks drained to do it.
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.25, true);
    }
    display_id_ = 0;
    return outcome;
  }

  /** SLS registered vs online, which is the only view that sees inactive. */
  rd::VirtualDisplayTopologyView TopologyView() const {
    rd::VirtualDisplayTopologyView view;
    if (!seam_.list_displays)
      return view;
    for (const rd::SkyLightDisplay& display : seam_.list_displays()) {
      view.registered_ids.push_back(display.display_id);
      if (display.active)
        view.online_ids.push_back(display.display_id);
    }
    return view;
  }

  /**
   * Physical and virtual surfaces are counted the same here on purpose: the
   * user cares that SOMETHING is on screen, not what kind of thing it is.
   * Removing the last one leaves the session with no surface at all.
   */
  bool LastSurfaceAllowsRemoval() const {
    const rd::VirtualDisplayTopologyView view = TopologyView();
    rd::LastSurfaceGuardInput input;
    input.current_screen_count =
        static_cast<std::uint32_t>(view.online_ids.size());
    input.already_disconnecting = 0;
    input.newly_removed = 1;
    return rd::EvaluateLastSurfaceGuard(input) ==
           rd::LastSurfaceVerdict::kAllowed;
  }

  rd::SkyLightDisplayPresence Presence() const {
    if (display_id_ == 0 || !seam_.list_displays)
      return rd::SkyLightDisplayPresence::kAbsent;
    return rd::PresenceOf(seam_.list_displays(), display_id_);
  }

 private:
  // Builds the configuration for a hold. PRECISE SIDE-EFFECT CONTRACT, stated
  // narrowly on purpose rather than claimed as blanket "read-only":
  //
  //   * IDENTITY GENERATION: strictly read-only. This function calls
  //     LoadIdentityGeneration and never StoreIdentityGeneration, and never
  //     increments identity_generation_. So no failure path -- unavailable,
  //     unendorsed or failed activation -- can consume a generation. That is
  //     the half that matters for the misclassification bug.
  //
  //   * INSTANCE-ID FILE: NOT read-only on first run. LoadOrCreateInstanceId
  //     creates and fsync/renames the id when none exists yet, and it must,
  //     because the configuration's vendor/product/serial are DERIVED from that
  //     id and Create() cannot run without them. Deferring creation until after
  //     a successful Create would move the crash window rather than close it: a
  //     crash between a successful Create and the deferred persist would leave a
  //     held display under an id no later launch could re-adopt.
  //     Closing this properly needs a load-only entry point in
  //     macos_virtual_display_identity.{h,cc}, which is OUTSIDE this
  //     assignment's file scope. Reported rather than silently narrowed.
  bool PrepareHoldConfiguration(rd::MacosVirtualDisplayConfiguration* configuration,
                                std::string* error) {
    // Generation and serial come from the AUTHENTICATED binding.
    //
    // A default-constructed configuration carries generation 0, which
    // MacosVirtualDisplayConfiguration::IsValid rejects outright. The identity
    // is derived rather than fixed because ids 5/6 on the dev host still hold
    // the literal default vendor/product/serial triple, and initWithDescriptor:
    // returns nil while a triple is still registered.
    configuration->worker_generation = binding_.generation;
    if (instance_id_ == 0) {
      // From the uid the VERIFIED binding carries, never from the environment:
      // the helper is spawned with an empty env precisely so credentials cannot
      // arrive that way, and HOME is not available to it.
      const auto store = rd::LoadOrCreateInstanceId(
          rd::InstanceIdPathForUid(binding_.uid), binding_.cookie_seed);
      if (!store.usable()) {
        *error = "identity_store_unavailable";
        return false;
      }
      instance_id_ = store.instance_id;
      // The generation MUST survive a restart: holding it only in memory means
      // a helper that already walked past a poisoned identity starts at zero on
      // the next launch and walks straight back into it. READ only -- this
      // function never writes it.
      generation_path_ = rd::IdentityGenerationPathForUid(binding_.uid, 0);
      identity_generation_ = rd::LoadIdentityGeneration(generation_path_);
    }
    const rd::VirtualDisplayIdentity identity = rd::DeriveVirtualDisplayIdentity(
        instance_id_, /*slot=*/0, identity_generation_);
    if (!identity.IsValid()) {
      *error = "identity_exhausted";
      return false;
    }
    configuration->vendor_id = identity.vendor_id;
    configuration->product_id = identity.product_id;
    configuration->serial_number = identity.serial_number;
    if (!configuration->IsValid()) {
      *error = "invalid_configuration";
      return false;
    }
    return true;
  }

  rd::VirtualDisplayHelperReply Hold(rd::VirtualDisplayHelperReply reply) {
    // Single instance, enforced here as well as in the authority layer: this is
    // the process that would actually create a second display.
    if (display_id_ != 0) {
      reply.ok = true;  // idempotent
      reply.display_id = display_id_;
      return reply;
    }
    // PREPARE IDENTITY/CONFIGURATION BEFORE ADMISSION.
    //
    // Nothing here commits: no generation is incremented or persisted and no
    // display is claimed. The modern gate needs the configuration in hand
    // because admission is only justified once CreateExact, this instance's own
    // destroy endorsement and initial activation have all succeeded -- and
    // Create() is what performs them.
    rd::MacosVirtualDisplayConfiguration configuration;
    std::string prepare_error;
    if (!PrepareHoldConfiguration(&configuration, &prepare_error)) {
      reply.ok = false;
      reply.error = prepare_error;
      return reply;
    }

    // Fail-closed pre-create gate. The decision AND the factory both go through
    // AdmitVirtualDisplayHold, so "a refused hold creates no backend" is a
    // property of the one seam the counterexample also drives.
    std::uint32_t modern_native = 0;
    std::string modern_error;
    std::string admission_error;
    if (!rd::AdmitVirtualDisplayHold(
            version_decision_.legacy_release_removes,
            // INSTALLED VERBATIM from the linkable production composition.
            // helper_main injects concrete dependencies and nothing else: it
            // holds no admission policy, so there is no decision here that a
            // counterexample cannot execute.
            rd::MakeModernHoldCallback(
                configuration,
                [] { return rd::CreateSLVirtualDisplayBackend(); },
                rd::VirtualDisplayHoldPublication{
                    [this](rd::SLVirtualDisplayBackend* concrete,
                           std::unique_ptr<rd::MacosVirtualDisplayBackend> owned,
                           std::uint32_t native) {
                      // Ownership only. The native id is returned by the
                      // composition through native_out, so it cannot drift
                      // between two writers.
                      (void)native;
                      sl_backend_ = concrete;
                      backend_ = std::move(owned);
                    }},
                &modern_native, &modern_error),
            [this] {
              // Pre-26 legacy path, unchanged: the CG backend is correct where
              // the legacy release genuinely removes. sl_backend_ stays null so
              // teardown can never mistake this for the endorsed modern path.
              if (!backend_) {
                backend_ = rd::CreateAppleMacosVirtualDisplayBackend();
                sl_backend_ = nullptr;
              }
            },
            &admission_error)) {
      // Refusal: completed structurally, never re-presented as a collision.
      const rd::VirtualDisplayHoldCompletion refused =
          rd::CompleteHoldAfterCallback(false, modern_native, modern_error,
                                        admission_error);
      reply.ok = false;
      reply.error = refused.error;
      return reply;
    }
    // WHAT HAPPENS AFTER THE CALLBACK IS DECIDED IN THE LINKABLE COMPOSITION.
    //
    // A bool here previously said "the modern path ran", and nothing ever set
    // it. A successful modern hold therefore fell through to a SECOND Create on
    // a live backend, failed as already-created, and burned a persisted
    // generation while the display existed. The published native id is now the
    // only signal, and only the real modern path can produce one.
    const rd::VirtualDisplayHoldCompletion completion =
        rd::CompleteHoldAfterCallback(true, modern_native, modern_error,
                                      admission_error);
    if (completion.ok) {
      display_id_ = completion.display_id;
      reply.ok = true;
      reply.display_id = completion.display_id;
      reply.presence = PresenceText(Presence());
      return reply;
    }
    if (!completion.enter_legacy_create) {
      reply.ok = false;
      reply.error = completion.error;
      return reply;
    }
    if (!backend_ ||
        backend_->ProbeSupport() != common::ReadinessState::kReady) {
      reply.ok = false;
      reply.error = "virtual_display_unavailable";
      return reply;
    }
    std::uint32_t native = 0;
    std::string error;
    if (!backend_->Create(configuration, &native, &error) || native == 0) {
      // A create failure is usually an identity collision: the triple is still
      // registered by a stranded display. The recovery is a BOUNDED generation
      // walk, and it may only proceed once enumeration proves the old id is
      // gone -- creating first is exactly how one stranded display became two
      // on the dev host.
      rd::SelfHealState heal;
      heal.marked_stale = true;
      heal.owner_released = true;
      heal.identity_generation = identity_generation_;
      // Bounded wait for the OLD id to actually leave the registered set.
      //
      // Without this `old_id_absent` was never set, so NextSelfHealStep could
      // only ever return kAwaitOldIdAbsent or kBlockedOldIdPresent and
      // kCreateNewIdentity was unreachable -- the self-heal walk could not
      // advance at all. Enumeration, never deallocation, is what decides.
      rd::VirtualDisplayTopologyView view = TopologyView();
      for (int attempt = 0; attempt < 10 && view.IsRegistered(display_id_);
           ++attempt) {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.2, true);
        view = TopologyView();
      }
      heal.old_id_absent = !view.IsRegistered(display_id_);
      const rd::SelfHealStep step =
          rd::NextSelfHealStep(heal, view, display_id_);
      switch (step) {
        case rd::SelfHealStep::kCreateNewIdentity:
          ++identity_generation_;
          // Persist BEFORE reporting, so a crash between the two does not lose
          // the fact that this generation is already burned.
          if (!rd::StoreIdentityGeneration(generation_path_,
                                           identity_generation_)) {
            std::fprintf(stderr,
                         "aidesk_virtual_display_helper_generation_persist_failed\n");
          }
          reply.error = "identity_collision_retry";
          break;
        case rd::SelfHealStep::kExhausted:
          reply.error = "identity_generation_exhausted";
          break;
        case rd::SelfHealStep::kBlockedOldIdPresent:
          reply.error = "stale_display_still_registered";
          break;
        default:
          reply.error = error.empty() ? "create_failed" : error;
          break;
      }
      reply.ok = false;
      return reply;
    }
    display_id_ = native;
    reply.ok = true;
    reply.display_id = native;
    reply.presence = PresenceText(Presence());
    return reply;
  }

  rd::VirtualDisplayHelperReply SetEnabled(rd::VirtualDisplayHelperReply reply,
                                           const rd::VirtualDisplayHelperCommand& command,
                                           bool enabled) {
    const std::uint32_t display_id = command.display_id;
    if (display_id_ == 0 || display_id != display_id_) {
      reply.ok = false;
      reply.error = "unknown_display";
      return reply;
    }
    if (!seam_.IsComplete()) {
      reply.ok = false;
      reply.error = "skylight_unavailable";
      return reply;
    }
    std::string error;
    // Disabling removes a surface. Refuse when it would leave the session with
    // none: `current - already_disconnecting - newly_removed >= 1`.
    if (!enabled && !LastSurfaceAllowsRemoval()) {
      reply.ok = false;
      reply.error = "would_leave_no_surface";
      return reply;
    }
    // Apply the APPROVED mode before enabling. The worker's mode and scale
    // selection is otherwise discarded entirely -- the backend call was
    // previously `(void)mode; (void)modes;` and only ENABLE was sent, so the
    // display kept whatever WindowServer picked.
    if (enabled) {
      if (!backend_) {
        reply.ok = false;
        reply.error = "no_backend";
        return reply;
      }
      rd::MacosVirtualDisplayMode mode;
      mode.pixels = {command.pixels_wide, command.pixels_high};
      mode.refresh_rate_hz =
          static_cast<double>(command.refresh_millihertz) / 1000.0;
      mode.scale = static_cast<double>(command.scale_percent) / 100.0;
      // Exact validation here as well as in the frame parser: this process is
      // the one that would actually apply an unapproved mode.
      if (!mode.IsValid()) {
        reply.ok = false;
        reply.error = "mode_rejected";
        return reply;
      }
      if (!backend_->ApplyMode(display_id_, mode, {mode}, &error)) {
        reply.ok = false;
        reply.error = error.empty() ? "apply_mode_failed" : error;
        return reply;
      }
    }
    if (!seam_.configure_display_enabled(display_id_, enabled, &error)) {
      reply.ok = false;
      reply.error = error.empty() ? "configure_failed" : error;
      return reply;
    }
    if (enabled && !seam_.force_extend(display_id_, &error)) {
      reply.ok = false;
      reply.error = error.empty() ? "extend_failed" : error;
      return reply;
    }
    reply.ok = true;
    reply.presence = PresenceText(Presence());
    return reply;
  }

  static const char* AdmissionText(rd::HelperAdmission admission) noexcept {
    switch (admission) {
      case rd::HelperAdmission::kAdmitted: return "admitted";
      case rd::HelperAdmission::kNotBound: return "not_bound";
      case rd::HelperAdmission::kEpochMismatch: return "epoch_mismatch";
      case rd::HelperAdmission::kGenerationMismatch: return "generation_mismatch";
      case rd::HelperAdmission::kCookieReplay: return "cookie_replay";
      case rd::HelperAdmission::kCookieUnbound: return "cookie_unbound";
      case rd::HelperAdmission::kUidMismatch: return "uid_mismatch";
    }
    return "refused";
  }

  bool authority_revoked_ = false;
  std::uint64_t instance_id_ = 0;
  std::string generation_path_;
  bool release_requested_ = false;
  std::uint32_t identity_generation_ = 0;
  rd::SkyLightSeam seam_;
  rd::VirtualDisplayHelperBinding binding_;
  rd::VirtualDisplayVersionDecision version_decision_;
  std::uint64_t highest_spent_index_ = 0;
  std::unique_ptr<rd::MacosVirtualDisplayBackend> backend_;
  // Non-owning view of backend_ when the endorsed SL factory built it.
  rd::SLVirtualDisplayBackend* sl_backend_ = nullptr;
  // Retained so RELEASE -> shutdown cannot rewrite the terminal verdict.
  rd::VirtualDisplayReleaseOrchestrator terminal_latch_;
  std::uint32_t display_id_ = 0;
};

}  // namespace

int main(int argc, const char* argv[]) {
  // A root process has no Aqua session, so a display it creates would not belong
  // to the console user's topology. Refusing is fail-closed.
  if (geteuid() == 0) {
    std::fprintf(stderr, "aidesk_virtual_display_helper_refuses_root\n");
    return EX_NOPERM;
  }
  bool probe_only = false;
  int bind_fd = -1;
  for (int index = 1; index < argc; ++index) {
    if (argv[index] != nullptr &&
        std::strcmp(argv[index], "--imcodes-virtual-display-probe") == 0) {
      probe_only = true;
      continue;
    }
    if (argv[index] != nullptr &&
        std::strcmp(argv[index], "--imcodes-bind-fd") == 0 && index + 1 < argc) {
      char* parse_end = nullptr;
      const long value = std::strtol(argv[++index], &parse_end, 10);
      if (parse_end == nullptr || *parse_end != '\0' || value < 3 ||
          value > 1024) {
        std::fprintf(stderr, "aidesk_virtual_display_helper_bad_bind_fd\n");
        return EX_USAGE;
      }
      bind_fd = static_cast<int>(value);
      continue;
    }
    std::fprintf(stderr, "aidesk_virtual_display_helper_unknown_argument\n");
    return EX_USAGE;
  }

  // Version gate before anything else touches a private symbol.
  const rd::VirtualDisplayVersionDecision decision =
      rd::EvaluateVirtualDisplayVersion(
          rd::ParseMacosVersion(ReadProductVersion()));
  if (!decision.may_hold) {
    std::fprintf(stderr, "aidesk_virtual_display_helper_unsupported_os: %s\n",
                 decision.reason.c_str());
    return EX_UNAVAILABLE;
  }
  rd::SkyLightSeam seam = rd::ResolveSystemSkyLightSeam();
  if (!seam.IsComplete()) {
    std::fprintf(stderr, "aidesk_virtual_display_helper_skylight_unavailable\n");
    return EX_UNAVAILABLE;
  }
  if (probe_only) {
    // Reports resolvability ONLY. It deliberately creates nothing, so it can
    // never strand a display, and it is never treated as qualification.
    std::fprintf(stdout,
                 "aidesk_virtual_display_helper_probe_ok "
                 "legacy_release_removes=%d modern_destroy_expected=%d\n",
                 decision.legacy_release_removes ? 1 : 0,
                 decision.modern_destroy_path_expected ? 1 : 0);
    return EX_OK;
  }

  // Read the launch binding BEFORE anything else, off an inherited descriptor.
  // Not argv: argv is readable by every process of this uid through `ps`, and a
  // readable epoch is a forgeable one. Not the first frame: that would let
  // whoever reaches the socket first own the display.
  if (bind_fd < 0) {
    std::fprintf(stderr, "aidesk_virtual_display_helper_missing_binding_fd\n");
    return EX_USAGE;
  }
  rd::VirtualDisplayHelperBinding binding;
  {
    std::string bind_line;
    char byte = 0;
    while (bind_line.size() <= rd::kVirtualDisplayHelperBindingMaxBytes) {
      const ssize_t got = ::read(bind_fd, &byte, 1);
      if (got == 0)
        break;
      if (got < 0) {
        if (errno == EINTR)
          continue;
        break;
      }
      if (byte == '\n')
        break;
      bind_line.push_back(byte);
    }
    ::close(bind_fd);
    if (!rd::ParseVirtualDisplayHelperBinding(bind_line, &binding)) {
      // Fail closed. A helper that could not be bound must answer nothing at
      // all rather than fall back to binding itself from traffic.
      std::fprintf(stderr, "aidesk_virtual_display_helper_invalid_binding\n");
      return EX_DATAERR;
    }
  }
  if (binding.uid != static_cast<std::uint32_t>(::geteuid())) {
    std::fprintf(stderr, "aidesk_virtual_display_helper_uid_mismatch\n");
    return EX_NOPERM;
  }

  ::signal(SIGPIPE, SIG_IGN);

  static HelperState state(std::move(seam), std::move(binding), decision);

  // Ready handshake. Emitted only after the binding was accepted AND the
  // SkyLight seam resolved, so a supervisor that sees "ready" knows the helper
  // is genuinely able to serve -- not merely that a process started. The
  // supervisor's wait for this line is bounded; a helper that never gets here
  // is killed and its authority is never granted.
  if (std::fwrite("ready\n", 1, 6, stdout) != 6 || std::fflush(stdout) != 0) {
    std::fprintf(stderr, "aidesk_virtual_display_helper_ready_write_failed\n");
    return EX_IOERR;
  }

  // Real CFRunLoop ownership of the main thread.
  //
  // The previous shape blocked the main thread in fgetc(stdin). That is not a
  // stylistic problem: a CGVirtualDisplay's descriptor callbacks and the
  // WindowServer connection are serviced on the main run loop, so a blocking
  // read starves exactly the callbacks the display depends on, and slop-desk
  // documents that a process without a live run loop has its display torn down
  // underneath it. stdin is therefore drained by a dispatch source and the run
  // loop is left free.
  const int stdin_fd = STDIN_FILENO;
  ::fcntl(stdin_fd, F_SETFL, ::fcntl(stdin_fd, F_GETFL, 0) | O_NONBLOCK);
  dispatch_source_t reader = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_READ, static_cast<uintptr_t>(stdin_fd), 0,
      dispatch_get_main_queue());
  if (reader == nullptr) {
    std::fprintf(stderr, "aidesk_virtual_display_helper_no_reader\n");
    return EX_OSERR;
  }
  static std::string pending;
  static bool peer_gone = false;
  dispatch_source_set_event_handler(reader, ^{
    char buffer[512];
    for (;;) {
      const ssize_t got = ::read(stdin_fd, buffer, sizeof(buffer));
      if (got < 0) {
        if (errno == EINTR)
          continue;
        break;  // EAGAIN: drained for now
      }
      if (got == 0) {
        peer_gone = true;
        CFRunLoopStop(CFRunLoopGetMain());
        return;
      }
      for (ssize_t index = 0; index < got; ++index) {
        const char character = buffer[index];
        if (character != '\n') {
          if (pending.size() < rd::kVirtualDisplayHelperMaxFrameBytes)
            pending.push_back(character);
          else
            pending.assign(1, '\x01');  // poisoned: oversized, never acted on
          continue;
        }
        const std::string line = pending;
        pending.clear();
        if (line.empty() || line == "\x01")
          continue;
        rd::VirtualDisplayHelperCommand command;
        rd::VirtualDisplayHelperReply reply;
        if (!rd::ParseVirtualDisplayHelperCommand(line, &command)) {
          reply.ok = false;
          reply.presence = "absent";
          reply.error = "malformed_frame";
        } else {
          reply = state.Handle(command);
        }
        if (!WriteReply(reply)) {
          peer_gone = true;
          CFRunLoopStop(CFRunLoopGetMain());
          return;
        }
        // RELEASE is terminal. The reply is written FIRST so the worker learns
        // the enumerated outcome, and only then does this process wind down --
        // a helper that lingered after releasing could still be commanded.
        if (state.release_requested()) {
          CFRunLoopStop(CFRunLoopGetMain());
          return;
        }
      }
    }
  });
  dispatch_resume(reader);

  // SIGTERM through a dispatch source rather than a handler: the ordered
  // teardown below allocates and talks to WindowServer, none of which is
  // async-signal-safe.
  ::signal(SIGTERM, SIG_IGN);
  ::signal(SIGINT, SIG_IGN);
  dispatch_source_t term = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
  dispatch_source_t intr = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_main_queue());
  for (dispatch_source_t source : {term, intr}) {
    if (source == nullptr)
      continue;
    dispatch_source_set_event_handler(source, ^{
      g_stop.store(true, std::memory_order_relaxed);
      CFRunLoopStop(CFRunLoopGetMain());
    });
    dispatch_resume(source);
  }

  CFRunLoopRun();

  // Ordered shutdown: authority first, then the display, then a truthful
  // enumeration. Revoking authority before touching the display means a peer
  // that is still talking cannot re-arm anything mid-teardown, and the
  // enumeration is what decides whether removal actually happened -- never the
  // fact that we released something.
  // SIGTERM and EOF take the SAME guard as an explicit RELEASE. Skipping it on
  // the signal path would make "kill the helper" a way to remove the session's
  // last remaining surface -- exactly what the guard exists to prevent.
  const bool teardown_allowed = state.ShutdownRemovalAllowed();
  state.RevokeAuthority();
  VirtualDisplayHelperTeardownOutcome outcome;
  if (teardown_allowed) {
    outcome = state.TearDown();
  } else {
    outcome.removed = false;
    outcome.presence = "active";
    std::fprintf(stderr,
                 "aidesk_virtual_display_helper_teardown_refused_last_surface\n");
  }
  // destroy_error is REPORTED, not merely recorded: a write-only field cannot
  // tell an operator why a display outlived shutdown. It is emitted alongside
  // `removed` precisely so the two stay visibly independent -- a destroy
  // failure explains, but never upgrades, removal, which the presence
  // enumeration alone decides.
  std::fprintf(stderr,
               "aidesk_virtual_display_helper_teardown removed=%d presence=%s "
               "peer_gone=%d destroy_error=%s\n",
               outcome.removed ? 1 : 0, outcome.presence.c_str(),
               peer_gone ? 1 : 0,
               outcome.destroy_error.empty() ? "none"
                                             : outcome.destroy_error.c_str());

  // Exiting is the only teardown primitive that exists. Whether WindowServer
  // honours it is reported by the worker's enumeration, never claimed here.
  std::fprintf(stderr, "aidesk_virtual_display_helper_exit\n");
  return EX_OK;
}
