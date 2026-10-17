// One-shot local unlock authority.
//
// The plug-in runs inside `authorizationhost`, which knows nothing about routes,
// worker generations or enrolment policy. It cannot ask the daemon either: any
// product IPC that could answer would also be a channel a password could travel
// on, and the whole design forbids that.
//
// So the daemon writes a small, bounded, NON-CREDENTIAL record before it
// registers the authorization right, and the plug-in consumes it by uid+ASID.
// The record carries only the facts needed to REFUSE: which policy, which user,
// which audit session, which worker generation, which signer. It never carries a
// password; the password stays in the System keychain behind an ACL bound to the
// plug-in's designated requirement.
//
// Single-consume and expiry are the point. An authority that could be replayed
// would let one operator-approved unlock authorise every later one, and an
// authority with no deadline would outlive the session it was scoped to.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_AUTHORITY_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_AUTHORITY_H_

#include <cstdint>
#include <functional>
#include <optional>
#include <string>

#include "macos_auto_unlock_controller.h"

namespace imcodes::remote_desktop::macos {

/** Hard bound: an authority older than this is refused even if present. */
inline constexpr std::int64_t kAutoUnlockAuthorityMaxLifetimeMs = 2 * 60 * 1000;
inline constexpr std::size_t kAutoUnlockAuthorityMaxBytes = 4 * 1024;
inline constexpr std::size_t kAutoUnlockNonceMaxBytes = 64;

/**
 * Contains NO credential. Every field exists so the plug-in can say no.
 */
struct AutoUnlockAuthority {
  std::string policy;
  std::string surface;
  AutoUnlockBinding enrolled;
  /** Designated requirement the keychain ACL must name. */
  std::string designated_requirement;
  /** Route this authority was minted for. A session that has been re-routed is
   *  not the session that asked, so its authority must not still be spendable. */
  std::uint64_t route_generation = 0;
  /** Unique per issue. Single-consume is enforced by removing the record, but a
   *  record restored from a backup or a crash-time copy would otherwise be
   *  spendable twice; the ledger remembers the last nonce and refuses a repeat. */
  std::string nonce;
  std::int64_t issued_at_ms = 0;
  std::int64_t expires_at_ms = 0;

  [[nodiscard]] bool IsValid() const noexcept;
};

enum class AutoUnlockAuthorityStatus {
  kConsumed,
  kAbsent,          // no authority for this uid+ASID
  kExpired,
  kMalformed,
  kSessionMismatch, // present, but issued for a different uid or audit session
  kUnavailable,     // store itself could not be reached
};

struct AutoUnlockAuthorityResult {
  AutoUnlockAuthorityStatus status = AutoUnlockAuthorityStatus::kUnavailable;
  AutoUnlockAuthority authority;

  [[nodiscard]] bool consumed() const noexcept {
    return status == AutoUnlockAuthorityStatus::kConsumed;
  }
};

/**
 * Filesystem effects, seamed so the consume ordering is provable without a
 * login window and without touching a real store.
 */
struct AutoUnlockAuthorityStore {
  /** Reads and REMOVES atomically. A read that leaves the record behind would
   *  make single-consume unenforceable under concurrency. */
  std::function<std::optional<std::string>(std::uint32_t uid,
                                           std::uint32_t audit_session_id)>
      take;
  std::function<void(std::uint32_t uid, std::uint32_t audit_session_id)> discard;

  [[nodiscard]] bool IsComplete() const noexcept;
};

[[nodiscard]] std::string SerializeAutoUnlockAuthority(
    const AutoUnlockAuthority& authority);
[[nodiscard]] std::optional<AutoUnlockAuthority> ParseAutoUnlockAuthority(
    const std::string& serialized);

/**
 * Takes the authority for this session, or refuses.
 *
 * The record is removed whatever the verdict: a malformed or expired authority
 * must not be left for a later attempt to find, and a mismatched one must not be
 * left where the session it names could still pick it up.
 */
[[nodiscard]] AutoUnlockAuthorityResult ConsumeAutoUnlockAuthority(
    std::uint32_t uid,
    std::uint32_t audit_session_id,
    std::int64_t now_ms,
    const AutoUnlockAuthorityStore& store);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_AUTHORITY_H_
