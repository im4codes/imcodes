#include "macos_auto_unlock_rights.h"

#include <algorithm>

namespace imcodes::remote_desktop::macos {

bool IsAutoUnlockLockBearingRight(const std::string& name) noexcept {
  return name == kAutoUnlockRightLoginConsole ||
         name == kAutoUnlockRightScreensaver;
}

namespace {

bool IsPermittedRight(const std::string& name) noexcept {
  return IsAutoUnlockLockBearingRight(name);
}

/** Best-effort restore used while unwinding a failed apply. */
bool RollBackApplied(const std::vector<AuthorizationRightDefinition>& snapshot,
                     const std::vector<std::string>& created,
                     std::size_t count,
                     const AuthorizationRightStore& store,
                     std::string* error) {
  bool ok = true;
  for (std::size_t index = count; index-- > 0;) {
    const AuthorizationRightDefinition& prior = snapshot[index];
    const bool was_created =
        std::find(created.begin(), created.end(), prior.name) != created.end();
    std::string failure;
    if (was_created) {
      if (!store.remove(prior.name, &failure))
        ok = false;
    } else if (!store.write(prior.name, prior.serialized, &failure)) {
      ok = false;
    }
    if (!ok && error->empty())
      *error = failure.empty() ? "rollback failed" : failure;
  }
  return ok;
}

}  // namespace

bool AuthorizationRightStore::IsComplete() const noexcept {
  return read && write && remove;
}

AuthorizationRightTransactionResult ApplyAuthorizationRights(
    const std::vector<AuthorizationRightDefinition>& desired,
    const AuthorizationRightStore& store) {
  AuthorizationRightTransactionResult result;
  if (!store.IsComplete() || desired.empty()) {
    result.status = AuthorizationRightTransactionStatus::kInvalid;
    result.error = "authorization right store or desired set is incomplete";
    return result;
  }
  for (const auto& definition : desired) {
    if (!IsPermittedRight(definition.name) || definition.serialized.empty()) {
      result.status = AuthorizationRightTransactionStatus::kInvalid;
      result.error = "refusing to modify an unlisted authorization right";
      return result;
    }
  }

  // Snapshot EVERYTHING first. Interleaving snapshot with write would leave the
  // later rights unrecoverable if an early write failed.
  for (const auto& definition : desired) {
    const std::optional<std::string> prior = store.read(definition.name);
    result.snapshot.push_back({definition.name, prior.value_or(std::string{})});
    if (!prior.has_value())
      result.created.push_back(definition.name);
  }

  for (std::size_t index = 0; index < desired.size(); ++index) {
    const auto& definition = desired[index];
    std::string error;
    const bool written =
        store.write(definition.name, definition.serialized, &error);
    // Read-back equality, not the write's own return code.
    const std::optional<std::string> observed =
        written ? store.read(definition.name) : std::nullopt;
    if (!written || !observed.has_value() ||
        *observed != definition.serialized) {
      result.error = !written ? (error.empty() ? "right write failed" : error)
                              : "right read-back did not match what was written";
      // A write that REFUSED changed nothing, so this right needs no restore and
      // attempting one would report a spurious rollback failure. A write that
      // SUCCEEDED but read back wrong did change something, so it must be
      // restored along with everything before it.
      const std::size_t to_restore = written ? index + 1 : index;
      std::string rollback_error;
      const bool rolled_back = RollBackApplied(result.snapshot, result.created,
                                               to_restore, store, &rollback_error);
      result.status = rolled_back
                          ? AuthorizationRightTransactionStatus::kRolledBack
                          : AuthorizationRightTransactionStatus::kRollbackFailed;
      if (!rolled_back && !rollback_error.empty())
        result.error += "; " + rollback_error;
      return result;
    }
  }

  result.status = AuthorizationRightTransactionStatus::kApplied;
  return result;
}

AuthorizationRightTransactionResult RestoreAuthorizationRights(
    const std::vector<AuthorizationRightDefinition>& snapshot,
    const std::vector<std::string>& created,
    const AuthorizationRightStore& store) {
  AuthorizationRightTransactionResult result;
  result.snapshot = snapshot;
  result.created = created;
  if (!store.IsComplete()) {
    result.status = AuthorizationRightTransactionStatus::kInvalid;
    result.error = "authorization right store is incomplete";
    return result;
  }

  bool ok = true;
  for (const auto& prior : snapshot) {
    std::string error;
    const bool was_created =
        std::find(created.begin(), created.end(), prior.name) != created.end();
    if (was_created) {
      // Never restore a definition the machine never had.
      if (!store.remove(prior.name, &error))
        ok = false;
    } else if (!store.write(prior.name, prior.serialized, &error)) {
      ok = false;
    } else {
      const std::optional<std::string> observed = store.read(prior.name);
      if (!observed.has_value() || *observed != prior.serialized) {
        ok = false;
        error = "restored right did not read back byte-identical";
      }
    }
    if (!ok) {
      result.status = AuthorizationRightTransactionStatus::kRollbackFailed;
      result.error = error.empty() ? "authorization right restore failed" : error;
      return result;
    }
  }
  result.status = AuthorizationRightTransactionStatus::kRolledBack;
  return result;
}

}  // namespace imcodes::remote_desktop::macos
