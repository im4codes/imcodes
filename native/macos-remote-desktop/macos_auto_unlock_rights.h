// Transactional installation of the authorization rights auto-unlock needs.
//
// Registering a mechanism means REWRITING a right definition the OS already
// owns and other software already depends on -- system.login.console for
// post-boot LoginWindow, system.login.screensaver for a locked session. A
// partial write, or an uninstall that restores an approximation, can leave a
// Mac that cannot log in at all. That is a worse failure than auto-unlock never
// working.
//
// So: snapshot the COMPLETE prior definition, apply, read it back and require
// equality, roll back on any failure, and restore the exact snapshot on disable
// or uninstall. The definition is carried opaquely -- every key, not just the
// mechanism list -- because a definition rebuilt from the fields we happen to
// know about is not the definition we replaced.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_RIGHTS_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_RIGHTS_H_

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace imcodes::remote_desktop::macos {

/** Rights auto-unlock participates in. Nothing else may be touched. */
inline constexpr char kAutoUnlockRightLoginConsole[] = "system.login.console";
inline constexpr char kAutoUnlockRightScreensaver[] = "system.login.screensaver";

/**
 * The only rights this plug-in may be registered into. Both are lock-bearing:
 * reaching a mechanism through either means the surface asking to unlock really
 * is locked. Submit's `locked` guard rests on exactly this invariant, so the
 * predicate is shared with the plug-in host rather than restated there.
 */
[[nodiscard]] bool IsAutoUnlockLockBearingRight(const std::string& name) noexcept;

/**
 * A complete right definition, opaque on purpose.
 *
 * `serialized` is the entire plist as the OS returned it. Equality is compared
 * over these exact bytes, so a read-back that "looks right" but differs in a
 * key we never modelled still fails.
 */
struct AuthorizationRightDefinition {
  std::string name;
  std::string serialized;

  [[nodiscard]] bool operator==(
      const AuthorizationRightDefinition& other) const noexcept {
    return name == other.name && serialized == other.serialized;
  }
};

/** The OS operations, seamed so the transaction is testable without mutating. */
struct AuthorizationRightStore {
  std::function<std::optional<std::string>(const std::string& name)> read;
  std::function<bool(const std::string& name,
                     const std::string& serialized,
                     std::string* error)>
      write;
  /** Removing a right we ADDED, as opposed to restoring one we replaced. */
  std::function<bool(const std::string& name, std::string* error)> remove;

  [[nodiscard]] bool IsComplete() const noexcept;
};

enum class AuthorizationRightTransactionStatus {
  kApplied,
  kRolledBack,
  kRollbackFailed,  // the dangerous one: say so loudly rather than swallow it
  kInvalid,
};

struct AuthorizationRightTransactionResult {
  AuthorizationRightTransactionStatus status =
      AuthorizationRightTransactionStatus::kInvalid;
  /** Exact prior definitions. Persist these; uninstall cannot be truthful otherwise. */
  std::vector<AuthorizationRightDefinition> snapshot;
  /** Rights that did NOT exist before, so uninstall must remove rather than restore. */
  std::vector<std::string> created;
  std::string error;

  [[nodiscard]] bool applied() const noexcept {
    return status == AuthorizationRightTransactionStatus::kApplied;
  }
};

/**
 * Applies definitions atomically in effect: every right ends up either at its
 * new definition or at exactly its prior one.
 *
 * Read-back is mandatory. A write that reports success but stores something
 * else is precisely the case that bricks login, and the only way to catch it is
 * to read the bytes back and compare them.
 */
[[nodiscard]] AuthorizationRightTransactionResult ApplyAuthorizationRights(
    const std::vector<AuthorizationRightDefinition>& desired,
    const AuthorizationRightStore& store);

/**
 * Restores a snapshot on disable, uninstall or a failed update.
 *
 * Rights listed in `created` are removed, because restoring them would leave
 * definitions the machine never had. Everything else is written back verbatim
 * and read back for equality.
 */
[[nodiscard]] AuthorizationRightTransactionResult RestoreAuthorizationRights(
    const std::vector<AuthorizationRightDefinition>& snapshot,
    const std::vector<std::string>& created,
    const AuthorizationRightStore& store);

/**
 * Production store over AuthorizationRightGet/Set/Remove.
 *
 * Declared here and defined in the .mm so pure C++ tests never link Security.
 * `authorization` may be null for read-only inspection; every mutation refuses
 * without it rather than attempting an unauthorised write.
 */
[[nodiscard]] AuthorizationRightStore CreateSystemAuthorizationRightStore(
    struct AuthorizationOpaqueRef* authorization);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_RIGHTS_H_
