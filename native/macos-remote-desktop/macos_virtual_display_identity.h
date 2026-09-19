// Identity derivation for an aiDesk virtual display.
//
// WHY THIS EXISTS, measured rather than assumed.
//
// On this host, `SLSGetDisplayList` reports stranded ids 5 and 6 carrying
// vendor 0x4149 ("AI") and product 0x4445 ("DE") — the literal defaults in
// MacosVirtualDisplayConfiguration. They are ours, they survived process exit,
// and they still hold that identity. `-[CGVirtualDisplay initWithDescriptor:]`
// returns nil when the vendor/product/serial triple is still registered, so a
// fixed serial makes every future creation on this machine fail until reboot.
//
// Three independent shipping implementations hit the same wall and all escape
// it the same way — by changing the identity rather than by retrying it:
//   * NetEase UURemote 4.37.1 (verified read-only) logs
//     `self heal with new identity slot:` and, when it runs out,
//     `self heal failed reason:identityGenerationExhausted slot:` — a BOUNDED
//     walk that terminates in an explicit exhausted state.
//   * ActiveSpace falls back to a PID-derived serial "which can't collide
//     (PIDs don't repeat within a boot)".
//   * macrdp #154: a hardcoded serialNum of 1 made a second display "rejected
//     outright"; it is now pid-derived.
//
// Design consequences encoded below:
//   * Vendor and product stay FIXED. They are brand identity and they are how a
//     leak audit attributes a stranded display back to aiDesk. Only the serial
//     moves.
//   * The serial is derived from a persistent per-install instance id, the slot,
//     and the identity generation. It is therefore stable across restarts (so a
//     warm display can be re-adopted) yet escapable (so a poisoned identity can
//     be abandoned).
//   * The generation walk is BOUNDED and its exhaustion is a terminal, reported
//     state. There is no unbounded retry, because the failure this recovers from
//     is permanent until reboot.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_IDENTITY_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_IDENTITY_H_

#include <cstdint>
#include <string>

namespace imcodes::remote_desktop::macos {

/** Fixed brand identity. Never derived, never rotated. */
inline constexpr std::uint32_t kAiDeskVirtualDisplayVendorId = 0x4149;   // "AI"
inline constexpr std::uint32_t kAiDeskVirtualDisplayProductId = 0x4445;  // "DE"

/**
 * At most one warm display, so exactly one slot. The parameter exists because
 * every shipping implementation that survives collisions is slot-indexed, and
 * because a future second surface must not silently reuse slot 0's serial.
 */
inline constexpr std::uint32_t kAiDeskVirtualDisplayMaxSlots = 1;

/**
 * Bounded self-heal. Eight attempts is not a tuning knob: past this point the
 * failure is not a collision we can walk away from, and continuing would be the
 * retry storm this design exists to prevent.
 */
inline constexpr std::uint32_t kAiDeskVirtualDisplayMaxIdentityGeneration = 8;

struct VirtualDisplayIdentity {
  std::uint32_t vendor_id = kAiDeskVirtualDisplayVendorId;
  std::uint32_t product_id = kAiDeskVirtualDisplayProductId;
  std::uint32_t serial_number = 0;
  std::uint32_t slot = 0;
  std::uint32_t identity_generation = 0;

  [[nodiscard]] bool IsValid() const noexcept;
  /** Stable, loggable form for leak attribution and for the experiment record. */
  [[nodiscard]] std::string DebugString() const;
};

/**
 * Derives the serial from (instance_id, slot, identity_generation).
 *
 * Requirements this satisfies, each of which a naive counter would violate:
 *   * Deterministic — the same inputs re-derive the same serial after a restart,
 *     which is what lets a warm display be re-adopted rather than duplicated.
 *   * Avalanche — adjacent generations must not produce adjacent serials, or a
 *     collision-driven walk would keep landing next to the poisoned identity.
 *   * Never zero — a zero serial is rejected by the private API, and Chromium
 *     records that "a serial number of 0 was causing a crash".
 *   * Bounded output — stays inside 32 bits without relying on UB.
 */
[[nodiscard]] std::uint32_t DeriveVirtualDisplaySerial(
    std::uint64_t instance_id,
    std::uint32_t slot,
    std::uint32_t identity_generation) noexcept;

/**
 * Builds the full identity, or an invalid identity when the slot is out of
 * range or the generation is exhausted. Returning an invalid identity rather
 * than clamping is deliberate: exhaustion must surface as a terminal state, not
 * as a silently-reused identity.
 */
[[nodiscard]] VirtualDisplayIdentity DeriveVirtualDisplayIdentity(
    std::uint64_t instance_id,
    std::uint32_t slot,
    std::uint32_t identity_generation) noexcept;

/** Whether another self-heal step is permitted. */
[[nodiscard]] bool CanAdvanceIdentityGeneration(
    std::uint32_t identity_generation) noexcept;

enum class IdentityStoreStatus {
  kLoaded,        // existing instance id read from disk
  kCreated,       // a new instance id was minted and durably written
  kRejected,      // the path exists but is unsafe (symlink, wrong owner/mode)
  kUnavailable,   // the path could not be created or read at all
};

struct IdentityStoreResult {
  IdentityStoreStatus status = IdentityStoreStatus::kUnavailable;
  std::uint64_t instance_id = 0;
  std::string detail;

  [[nodiscard]] bool usable() const noexcept {
    return (status == IdentityStoreStatus::kLoaded ||
            status == IdentityStoreStatus::kCreated) &&
           instance_id != 0;
  }
};

/**
 * Parses a stored instance-id file body.
 *
 * Split out from the filesystem so the accept/reject rules are testable without
 * touching disk. Anything that is not exactly one non-zero unsigned decimal is
 * rejected — a partially written or truncated file must not be read as a
 * plausible id, because a wrong-but-plausible instance id silently changes the
 * identity of an already-registered display.
 */
[[nodiscard]] bool ParseInstanceId(const std::string& contents,
                                   std::uint64_t* instance_id) noexcept;

/** Serialises an instance id into the exact on-disk form ParseInstanceId accepts. */
[[nodiscard]] std::string FormatInstanceId(std::uint64_t instance_id);

/**
 * Loads, or creates once, the per-install instance id.
 *
 * Safety rules, all enforced rather than documented:
 *   * The file is opened with O_NOFOLLOW; a symlink at the path is REJECTED,
 *     never followed.
 *   * Ownership must be the calling euid and the mode must not grant group or
 *     other any access; otherwise the file is rejected rather than trusted.
 *   * Creation is atomic: write to a temporary in the same directory, fsync the
 *     file, rename into place, then fsync the directory. A crash therefore
 *     leaves either the old id or the new one, never a half-written one.
 *   * A rejected or unavailable store NEVER falls back to a guessed id. The
 *     caller must treat it as "cannot derive a stable identity" and fail closed;
 *     inventing one would risk colliding with a display that is already
 *     registered under it.
 */
[[nodiscard]] IdentityStoreResult LoadOrCreateInstanceId(
    const std::string& path,
    std::uint64_t candidate_instance_id);

/** Default location, under the caller's own state directory. */
[[nodiscard]] std::string DefaultInstanceIdPath();

/**
 * Instance-id path for an explicit uid, derived from the password database.
 *
 * The helper is spawned with an EMPTY environment on purpose, so it has no HOME
 * to read -- and DefaultInstanceIdPath(), which reads HOME, therefore returned
 * empty inside the helper and made every first HOLD fail with
 * identity_store_unavailable. Restoring the environment would undo the
 * credential isolation the empty env exists for, so the directory is looked up
 * from the uid the verified binding carries instead. getpwuid_r is not ambient
 * state: it cannot be influenced by whoever launched us.
 */
[[nodiscard]] std::string InstanceIdPathForUid(std::uint32_t uid);

/**
 * Persisted identity generation for a slot.
 *
 * The generation MUST survive a restart. Holding it only in memory means a
 * helper that exhausted several generations escaping a poisoned identity starts
 * again at zero on the next launch, walks straight back into the same
 * registered triple, and re-runs the whole collision walk every time.
 */
[[nodiscard]] std::string IdentityGenerationPathForUid(std::uint32_t uid,
                                                       std::uint32_t slot);
[[nodiscard]] std::uint32_t LoadIdentityGeneration(const std::string& path);
/** Best-effort durable store. Failure is reported so the caller can log it. */
[[nodiscard]] bool StoreIdentityGeneration(const std::string& path,
                                           std::uint32_t generation);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_IDENTITY_H_
