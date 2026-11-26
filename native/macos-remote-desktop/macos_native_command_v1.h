#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_NATIVE_COMMAND_V1_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_NATIVE_COMMAND_V1_H_

#include <cstdint>
#include <string>
#include <vector>

namespace imcodes::remote_desktop::macos {

// Exact argv tokens the daemon invokes. These are duplicated in
// src/node/macos-remote-desktop-production.ts
// (MACOS_REMOTE_DESKTOP_NATIVE_COMMAND); a cross-layer guard test compares the
// two byte-for-byte so the pair cannot drift.
inline constexpr char kNativeCommandReadinessV1[] = "--imcodes-readiness-v1";
inline constexpr char kNativeCommandRequestPermissionsV1[] =
    "--imcodes-request-permissions-v1";
inline constexpr char kNativeCommandReleaseInputV1[] =
    "--imcodes-release-input-v1";
inline constexpr char kNativeCommandStopCaptureV1[] =
    "--imcodes-stop-capture-v1";

// Mirrors MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION.
inline constexpr std::int64_t kNativeReadinessVersionV1 = 1;

// Mirrors MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE. The TypeScript parser
// rejects any other value, so these must stay exact.
inline constexpr char kNativeSessionStateActiveUnlocked[] = "active_unlocked";
inline constexpr char kNativeSessionStateLocked[] = "locked";
inline constexpr char kNativeSessionStateSleeping[] = "sleeping";
inline constexpr char kNativeSessionStateInactive[] = "inactive";

// A bounded set: the daemon rejects duplicates, so a probe that cannot produce
// a clean list must report none rather than a partial one.
inline constexpr std::size_t kNativeReadinessMaxActiveUids = 32;

struct NativeReadinessV1 {
  std::vector<std::uint32_t> active_aqua_user_uids;
  std::string session_state = kNativeSessionStateInactive;
  bool screen_recording = false;
  bool encoder = false;
  bool accessibility = false;
  bool clipboard = false;
  bool disclosure = false;
  bool lifecycle_observation = false;
  // CAPABILITY, NOT LIVENESS. These answer "can this signed build release all
  // input / stop capture when a generation exists", which is exactly what the
  // daemon's readiness gate consumes. They deliberately do NOT mean "a
  // generation is active right now".
  //
  // They used to mean the latter, and that was a deadlock: readiness runs as a
  // short-lived process BEFORE any worker exists, so liveness is necessarily
  // false there, the daemon gate mapped either false to UNAVAILABLE, and no
  // generation could ever be created to make them true. Nothing on the machine
  // could leave that state.
  //
  // RunNativeCommandV1 overwrites both from NativeCleanupCapabilityV1 after the
  // probe returns, so a probe implementation cannot answer this at all. Whether
  // a generation actually exists stays the cleanup command's business, and it
  // still fails closed when it cannot act.
  bool release_input = false;
  bool stop_capture = false;
  // True only after a create/apply/online/destroy probe of the built-in
  // WindowServer virtual-display seam. Class/selector presence alone is not
  // enough to advertise display control.
  bool virtual_display = false;
};

// Serializes exactly the twelve keys the TypeScript parser demands, in a fixed
// order, with no extra whitespace. `exactKeys` on the TypeScript side rejects
// any missing or additional key, so this function is the only place the shape
// is produced.
//
// Returns false without touching `out` when the snapshot cannot be represented
// (unknown session state, too many uids, duplicate uid, or a zero uid). A
// caller must then fail the command rather than emit a narrowed snapshot.
[[nodiscard]] bool SerializeNativeReadinessV1(const NativeReadinessV1& snapshot,
                                              std::string* out);

// Non-interactive probe seam. Every implementation must observe current state
// only: prompting for TCC, opening System Settings, or inferring a permission
// from an unrelated signal are all forbidden here, because the daemon treats
// this output as authoritative advertisement.
class NativeReadinessProbe {
 public:
  virtual ~NativeReadinessProbe() = default;
  [[nodiscard]] virtual bool Collect(NativeReadinessV1* out) noexcept = 0;
};

// Explicit, user-initiated onboarding seam. Unlike NativeReadinessProbe this
// command is allowed to ask macOS to register the signed worker in the Screen
// Recording and Accessibility privacy panes. macOS still requires the user to
// enable both switches; this interface must never edit or bypass TCC.
class NativePermissionOnboarding {
 public:
  virtual ~NativePermissionOnboarding() = default;
  [[nodiscard]] virtual bool RequestRegistration() noexcept = 0;
};

// Cleanup commands act on one generation. `generation` of zero means "whatever
// this process currently owns"; a nonzero value must match exactly.
class NativeCleanupTarget {
 public:
  virtual ~NativeCleanupTarget() = default;
  // Must return false when there is no active generation to act on, so the
  // daemon can tell "released" from "nothing to release".
  [[nodiscard]] virtual bool ReleaseAllInput(
      std::uint64_t generation) noexcept = 0;
  [[nodiscard]] virtual bool StopCapture(std::uint64_t generation) noexcept = 0;
};

// Whether this build can service the generation-bound cleanup verbs at all.
//
// This is the single source for the `releaseInput`/`stopCapture` readiness
// fields, and it is deliberately the SAME condition RunNativeCommandV1 uses to
// decide whether it can dispatch a cleanup command (see the
// `macos_remote_desktop_cleanup_unavailable` branch). Readiness and dispatch
// therefore cannot disagree: a build with no cleanup target advertises none and
// refuses the commands, and a build that advertises them can be asked.
//
// It is NOT a statement that a generation exists. It never consults one.
[[nodiscard]] bool NativeCleanupCapabilityV1(
    const NativeCleanupTarget* cleanup) noexcept;

enum class NativeCommandOutcome : std::uint8_t {
  kNotACommand,
  kOk,
  kFailed,
  kUsage,
};

struct NativeCommandResult {
  NativeCommandOutcome outcome = NativeCommandOutcome::kNotACommand;
  std::string stdout_text;
  std::string stderr_text;
};

// Dispatches exactly one of the four commands. Any other argv is reported as
// kNotACommand so the caller can continue to its ordinary startup path.
//
// Deliberate properties:
//   * The readiness probe never prompts or infers. Permission registration is
//     a separate, explicit user-invoked command and never changes TCC itself.
//   * Cleanup commands are idempotent in effect but NOT in exit status: a
//     command that could not act on the active generation reports failure, so
//     a supervisor cannot read "nothing happened" as "cleaned up".
//   * A generation argument must be a plain bounded decimal; anything else is
//     a usage error rather than a silently clamped value.
[[nodiscard]] NativeCommandResult RunNativeCommandV1(
    int argc,
    const char* const argv[],
    NativeReadinessProbe* probe,
    NativeCleanupTarget* cleanup,
    NativePermissionOnboarding* onboarding);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_NATIVE_COMMAND_V1_H_
