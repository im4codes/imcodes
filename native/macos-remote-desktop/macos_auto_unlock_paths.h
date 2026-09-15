#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_PATHS_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_PATHS_H_

#include <cstdint>
#include <string>

// Single source of truth for the auto-unlock store layout. The producer (the
// controlled-node daemon/worker) and the consumer (the Authorization Plug-in,
// inside authorizationhost) must agree exactly; restating any of these in a
// second file is how the two drift apart.
//
// EVERYTHING HERE IS ROOT-ONLY. On macOS the controlled node installs as a
// LaunchDaemon in /Library/LaunchDaemons -- see src/node/installer.ts, which
// states "macOS: LaunchDaemon (/Library/LaunchDaemons, root) -- NOT a user
// LaunchAgent" -- so the authenticated writer is already root and the plug-in
// consumes as root. Nothing unprivileged ever needs to traverse this tree, so
// the directory is 0700 rather than a traversable 0711, and there are no
// per-user subdirectories for a local user to race into.
//
//   /var/db/aidesk-autounlock            root:wheel 0700
//   .../authority-<uid>-<asid>           root:wheel 0600   one-shot, NO credential
//   .../ledger-<uid>                     root:wheel 0600   retries, lockout, last nonce
//
// The ledger is root-only for the same reason the store is: a user who could
// rewrite their own ledger could reset their own lockout, and a bounded retry
// count that the subject can edit is not a bound.

namespace imcodes::remote_desktop::macos {

inline constexpr char kAutoUnlockStateDirectory[] = "/var/db/aidesk-autounlock";

/** 0700: root only. No unprivileged traversal is required by any participant. */
inline constexpr unsigned int kAutoUnlockStateDirectoryMode = 0700;
/** 0600 for the authority and the ledger alike. */
inline constexpr unsigned int kAutoUnlockRecordMode = 0600;
/** Every record in this tree is owned by root. */
inline constexpr std::uint32_t kAutoUnlockRecordOwnerUid = 0;

/**
 * Who we are, and who must own the store.
 *
 * Production is always `{geteuid(), kAutoUnlockRecordOwnerUid}` -- i.e. the
 * privileged check is `effective_uid == 0`. It is expressed as two fields rather
 * than a hardcoded 0 so the refusal ordering is provable in a temp directory by
 * an unprivileged test, which passes its own uid for both. That keeps the
 * production property intact (writer identity must equal store owner) instead of
 * weakening it to make tests pass.
 */
struct AutoUnlockStoreIdentity {
  std::uint32_t effective_uid = 0;
  std::uint32_t required_owner_uid = kAutoUnlockRecordOwnerUid;

  [[nodiscard]] bool privileged() const noexcept {
    return effective_uid == required_owner_uid;
  }
};

/** The only identity production ever uses. */
inline AutoUnlockStoreIdentity ProductionAutoUnlockStoreIdentity(
    std::uint32_t effective_uid) {
  return AutoUnlockStoreIdentity{effective_uid, kAutoUnlockRecordOwnerUid};
}

inline std::string AutoUnlockAuthorityPath(const std::string& base_directory,
                                           std::uint32_t uid,
                                           std::uint32_t audit_session_id) {
  return base_directory + "/authority-" + std::to_string(uid) + "-" +
         std::to_string(audit_session_id);
}

inline std::string AutoUnlockLedgerPath(const std::string& base_directory,
                                        std::uint32_t uid) {
  return base_directory + "/ledger-" + std::to_string(uid);
}

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_PATHS_H_
