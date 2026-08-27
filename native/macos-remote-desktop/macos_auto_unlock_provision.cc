#include "macos_auto_unlock_provision.h"

#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include "macos_auto_unlock_paths.h"
#include "macos_auto_unlock_record_io.h"

namespace imcodes::remote_desktop::macos {
namespace {

/** mkdir's mode is masked by umask, so the mode is always set explicitly after. */
bool CreateDirectoryWithExactMode(const std::string& path, unsigned int mode) {
  if (::mkdir(path.c_str(), mode) != 0) return false;
  return ::chmod(path.c_str(), mode) == 0;
}

}  // namespace

AutoUnlockProvisionResult ProvisionAutoUnlockStateDirectory(
    const std::string& base_directory, AutoUnlockStoreIdentity identity) {
  AutoUnlockProvisionResult result;
  result.path = base_directory;
  if (!identity.privileged()) {
    result.status = AutoUnlockProvisionStatus::kRefusedNotRoot;
    return result;
  }

  switch (InspectAutoUnlockDirectory(base_directory,
                                     identity.required_owner_uid, 0)) {
    case AutoUnlockDirectoryState::kUnsafe:
      result.status = AutoUnlockProvisionStatus::kRefusedUnsafeExisting;
      return result;
    case AutoUnlockDirectoryState::kUsable:
      // Adopt, but re-assert the mode: a directory left group- or
      // world-writable would let a non-root user drop a ledger in beside ours.
      result.status =
          ::chmod(base_directory.c_str(), kAutoUnlockStateDirectoryMode) == 0
              ? AutoUnlockProvisionStatus::kProvisioned
              : AutoUnlockProvisionStatus::kFailed;
      return result;
    case AutoUnlockDirectoryState::kAbsent:
      break;
  }

  result.status = CreateDirectoryWithExactMode(base_directory,
                                               kAutoUnlockStateDirectoryMode)
                      ? AutoUnlockProvisionStatus::kProvisioned
                      : AutoUnlockProvisionStatus::kFailed;
  return result;
}

bool RevokeAutoUnlockUserState(const std::string& base_directory,
                               std::uint32_t enrolled_uid,
                               AutoUnlockStoreIdentity identity) {
  if (!identity.privileged() || enrolled_uid == 0) return false;
  if (InspectAutoUnlockDirectory(base_directory, identity.required_owner_uid,
                                 0) != AutoUnlockDirectoryState::kUsable) {
    return false;
  }

  // Remove every authority for this uid regardless of ASID, plus the ledger. A
  // per-ASID authority left behind by un-enrolment would still be consumable.
  const std::string prefix = "authority-" + std::to_string(enrolled_uid) + "-";
  DIR* handle = ::opendir(base_directory.c_str());
  if (handle == nullptr) return false;
  while (const dirent* entry = ::readdir(handle)) {
    const std::string name = entry->d_name;
    if (name.rfind(prefix, 0) == 0)
      ::unlink((base_directory + "/" + name).c_str());
  }
  ::closedir(handle);
  ::unlink(AutoUnlockLedgerPath(base_directory, enrolled_uid).c_str());
  return true;
}

}  // namespace imcodes::remote_desktop::macos
