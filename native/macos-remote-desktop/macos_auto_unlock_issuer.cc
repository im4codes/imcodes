#include "macos_auto_unlock_issuer.h"

#include "macos_auto_unlock_paths.h"
#include "macos_auto_unlock_provision.h"
#include "macos_auto_unlock_record_io.h"

namespace imcodes::remote_desktop::macos {

AutoUnlockIssueResult IssueAutoUnlockAuthority(
    const AutoUnlockAuthority& authority, const std::string& base_directory,
    AutoUnlockStoreIdentity identity) {
  AutoUnlockIssueResult result;

  // Issuing is a privileged act. On macOS the controlled node runs as a
  // LaunchDaemon, so this is the ordinary case, not a special one.
  if (!identity.privileged()) {
    result.status = AutoUnlockIssueStatus::kRefusedNotRoot;
    return result;
  }
  // uid 0 is not an enrollable console user, and an authority naming it could
  // never match a real Aqua session.
  if (authority.enrolled.local_user_uid == 0 || !authority.IsValid()) {
    result.status = AutoUnlockIssueStatus::kRefusedInvalidAuthority;
    return result;
  }

  // Self-healing: first boot, a wiped /var/db or a deleted directory must not
  // become a permanent refusal that no operator can diagnose.
  if (!ProvisionAutoUnlockStateDirectory(base_directory, identity)
           .provisioned()) {
    result.status = AutoUnlockIssueStatus::kRefusedStoreUnsafe;
    return result;
  }

  const std::string serialized = SerializeAutoUnlockAuthority(authority);
  // A record that cannot round-trip, or that exceeds the consumer's bound, would
  // be read as malformed and burn the attempt. Refuse before writing.
  if (serialized.empty() || serialized.size() > kAutoUnlockAuthorityMaxBytes) {
    result.status = AutoUnlockIssueStatus::kRefusedInvalidAuthority;
    return result;
  }

  const std::string path =
      AutoUnlockAuthorityPath(base_directory, authority.enrolled.local_user_uid,
                              authority.enrolled.audit_session_id);
  if (!WriteAutoUnlockRecordAtomically(path, serialized)) {
    result.status = AutoUnlockIssueStatus::kRefusedWriteFailed;
    return result;
  }

  result.status = AutoUnlockIssueStatus::kIssued;
  result.path = path;
  return result;
}

}  // namespace imcodes::remote_desktop::macos
