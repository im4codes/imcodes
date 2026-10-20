#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_ISSUER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_ISSUER_H_

#include <cstdint>
#include <string>

#include "macos_auto_unlock_authority.h"
#include "macos_auto_unlock_paths.h"

namespace imcodes::remote_desktop::macos {

enum class AutoUnlockIssueStatus {
  kIssued,
  /** Issuing is privileged: the writer is the root LaunchDaemon, never a user. */
  kRefusedNotRoot,
  kRefusedInvalidAuthority,
  /** The state directory is missing AND could not be safely created. */
  kRefusedStoreUnsafe,
  kRefusedWriteFailed,
};

struct AutoUnlockIssueResult {
  AutoUnlockIssueStatus status = AutoUnlockIssueStatus::kRefusedWriteFailed;
  std::string path;

  [[nodiscard]] bool issued() const noexcept {
    return status == AutoUnlockIssueStatus::kIssued;
  }
};

/**
 * Mints a one-shot authority for the plug-in to consume.
 *
 * Runs as ROOT inside the authenticated controlled-node daemon/worker. It writes
 * NO credential -- only the binding facts the plug-in needs in order to say no:
 * uid, username, ASID, session type, route generation, worker generation, expiry
 * and a nonce. The password never touches this store, and never travels over
 * daemon, Server or browser IPC.
 *
 * The state directory is provisioned here on every call rather than only at
 * install, so a missing directory self-heals instead of becoming a silent
 * permanent refusal.
 *
 * `base_directory` and `effective_uid` are seamed purely so the refusal ordering
 * is provable in a temp directory without root. Production passes
 * kAutoUnlockStateDirectory and the real euid.
 */
[[nodiscard]] AutoUnlockIssueResult IssueAutoUnlockAuthority(
    const AutoUnlockAuthority& authority, const std::string& base_directory,
    AutoUnlockStoreIdentity identity);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_ISSUER_H_
