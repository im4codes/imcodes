// Real Authorization Services plug-in host for aiDeskAutoUnlock.
//
// Apple loads this bundle inside authorizationhost and calls
// AuthorizationPluginCreate. Everything security-relevant lives in the pure
// sequencing layer (macos_auto_unlock_plugin.cc); this file is the adapter that
// maps AuthorizationCallbacks onto that layer, so the flag contract and the
// clear-on-every-failure rule stay testable without a login window.
//
// NOTE ON CONTEXT FLAGS: kAuthorizationContextFlagVolatile is set and
// kAuthorizationContextFlagExtractable deliberately is NOT. Volatile keeps the
// value out of the credential store; withholding extractable keeps every other
// mechanism in the right's list -- including ones we do not ship -- from
// reading the password back out of the engine.

#import <Security/AuthorizationPlugin.h>
#import <bsm/audit.h>
#import <bsm/audit_session.h>
#import <Security/AuthorizationTags.h>

#include <cstring>
#include <string>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include "macos_auto_unlock_keychain.h"
#include "macos_auto_unlock_package.h"
#include "macos_auto_unlock_paths.h"
#include "macos_auto_unlock_provision.h"
#include "macos_auto_unlock_record_io.h"
#include "macos_auto_unlock_rights.h"
#include "macos_auto_unlock_plugin.h"

namespace imcodes::remote_desktop::macos {
namespace {

class EngineCallbacks final : public AutoUnlockPluginEngine {
 public:
  EngineCallbacks(const AuthorizationCallbacks* callbacks,
                  AuthorizationEngineRef engine)
      : callbacks_(callbacks), engine_(engine) {}

  bool SetContextValue(std::string_view key,
                       AutoUnlockContextFlags flags,
                       const char* bytes,
                       std::size_t length) override {
    if (callbacks_ == nullptr || callbacks_->SetContextValue == nullptr)
      return false;
    (void)flags;  // Mapped below; the enum exists so tests can assert intent.
    AuthorizationValue value{length, const_cast<char*>(bytes)};
    const std::string owned_key(key);
    return callbacks_->SetContextValue(
               engine_, owned_key.c_str(),
               kAuthorizationContextFlagVolatile,  // NOT ...FlagExtractable
               &value) == errAuthorizationSuccess;
  }

  void ClearContextValue(std::string_view key) noexcept override {
    if (callbacks_ == nullptr || callbacks_->SetContextValue == nullptr)
      return;
    // Overwrite with an empty volatile value; the engine drops the prior bytes.
    AuthorizationValue empty{0, nullptr};
    const std::string owned_key(key);
    (void)callbacks_->SetContextValue(engine_, owned_key.c_str(),
                                      kAuthorizationContextFlagVolatile, &empty);
  }

  AutoUnlockMechanismVerdict ReadVerdict() override {
    if (callbacks_ == nullptr || callbacks_->GetContextValue == nullptr)
      return AutoUnlockMechanismVerdict::kUndetermined;
    const AuthorizationValue* value = nullptr;
    AuthorizationContextFlags flags = 0;
    if (callbacks_->GetContextValue(engine_, "authorize-result", &flags,
                                    &value) != errAuthorizationSuccess ||
        value == nullptr || value->data == nullptr || value->length == 0) {
      // No authenticated answer. Never optimistic.
      return AutoUnlockMechanismVerdict::kUndetermined;
    }
    const auto* result = static_cast<const std::uint32_t*>(value->data);
    return *result == 0 ? AutoUnlockMechanismVerdict::kAllow
                        : AutoUnlockMechanismVerdict::kDeny;
  }

  /** Reads a context string the engine already holds. Empty when absent. */
  std::string ReadContextString(const char* key) {
    if (callbacks_ == nullptr || callbacks_->GetContextValue == nullptr)
      return {};
    const AuthorizationValue* value = nullptr;
    AuthorizationContextFlags flags = 0;
    if (callbacks_->GetContextValue(engine_, key, &flags, &value) !=
            errAuthorizationSuccess ||
        value == nullptr || value->data == nullptr || value->length == 0) {
      return {};
    }
    std::size_t length = value->length;
    const char* bytes = static_cast<const char*>(value->data);
    while (length > 0 && bytes[length - 1] == '\0') --length;
    return std::string(bytes, length);
  }

  /** A partially numeric value yields 0, which every caller treats as refusal. */
  std::uint32_t ReadContextUnsigned(const char* key) {
    const std::string text = ReadContextString(key);
    if (text.empty()) return 0;
    char* end = nullptr;
    const unsigned long parsed = std::strtoul(text.c_str(), &end, 10);
    return (end != nullptr && *end == '\0') ? static_cast<std::uint32_t>(parsed) : 0;
  }

  void SetDisposition(AutoUnlockMechanismDisposition disposition) override {
    if (callbacks_ == nullptr || callbacks_->SetResult == nullptr)
      return;
    (void)callbacks_->SetResult(engine_,
                                disposition == AutoUnlockMechanismDisposition::kAllow
                                    ? kAuthorizationResultAllow
                                    : kAuthorizationResultDeny);
  }

 private:
  const AuthorizationCallbacks* callbacks_ = nullptr;
  AuthorizationEngineRef engine_ = nullptr;
};

}  // namespace
}  // namespace imcodes::remote_desktop::macos

namespace imcodes::remote_desktop::macos {
namespace {

// One live mechanism instance. `authorizationhost` creates one per mechanism
// per authorization, invokes it, then destroys it.
std::int64_t NowMilliseconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch()).count();
}

AutoUnlockAuthorityStore CreateLocalAutoUnlockAuthorityStore() {
  AutoUnlockAuthorityStore store;
  store.take = [](std::uint32_t uid, std::uint32_t asid)
      -> std::optional<std::string> {
    const std::string path =
        AutoUnlockAuthorityPath(kAutoUnlockStateDirectory, uid, asid);
    // Root-owned: the writer is the controlled-node LaunchDaemon, and so are we.
    const std::string contents = ReadValidatedAutoUnlockRecord(
        path, kAutoUnlockRecordOwnerUid, kAutoUnlockAuthorityMaxBytes);
    // Unlink regardless of what we found, and BEFORE returning: two mechanisms
    // racing the same authority must not both see it. rename/unlink are atomic,
    // so exactly one caller observes a non-empty read for a given file.
    ::unlink(path.c_str());
    if (contents.empty()) return std::nullopt;
    return contents;
  };
  store.discard = [](std::uint32_t uid, std::uint32_t asid) {
    ::unlink(AutoUnlockAuthorityPath(kAutoUnlockStateDirectory, uid, asid).c_str());
  };
  return store;
}

std::unique_ptr<AutoUnlockCredentialBackend>
CreateSystemKeychainAutoUnlockBackend() {
  // ACL is bound to the PLUG-IN requirement, so this is the bundle path.
  return std::make_unique<SystemKeychainCredentialBackend>(
      std::string(kAutoUnlockPluginInstallDirectory) + "/" +
      kAutoUnlockPluginBundleName + ".bundle");
}

AutoUnlockAttemptState LoadAutoUnlockLedger(std::uint32_t uid) {
  AutoUnlockAttemptState state;
  if (uid == 0) return state;
  const std::string contents = ReadValidatedAutoUnlockRecord(
      AutoUnlockLedgerPath(kAutoUnlockStateDirectory, uid),
      kAutoUnlockRecordOwnerUid, kAutoUnlockAuthorityMaxBytes);
  AutoUnlockLedgerRecord record;
  // A ledger we cannot parse is NOT treated as fresh -- that would forgive every
  // spent attempt. It is treated as fully spent, so a tampered or torn ledger
  // costs the user a manual password instead of removing the retry bound.
  if (contents.empty()) return state;
  if (!ParseAutoUnlockLedger(contents, &record)) {
    state.attempts = kAutoUnlockMaxAttempts;
    return state;
  }
  state.attempts = record.attempts;
  state.locked_out_until_ms = record.locked_out_until_ms;
  state.last_nonce = record.last_nonce;
  return state;
}

[[nodiscard]] bool StoreAutoUnlockLedger(std::uint32_t uid,
                                         const AutoUnlockAttemptState& state) {
  if (uid == 0) return false;
  AutoUnlockLedgerRecord record;
  record.attempts = state.attempts;
  record.locked_out_until_ms = state.locked_out_until_ms;
  record.last_nonce = state.last_nonce;
  const std::string rendered = SerializeAutoUnlockLedger(record);
  if (rendered.empty()) return false;
  return WriteAutoUnlockRecordAtomically(
      AutoUnlockLedgerPath(kAutoUnlockStateDirectory, uid), rendered);
}

/**
 * Can we still record a spent attempt?
 *
 * Asked BEFORE anything is consumed. If the ledger cannot be persisted then
 * attempts never accumulate, the lockout never triggers, and the retry bound
 * required by the unlock spec silently stops existing -- a fail-OPEN. The state
 * directory is provisioned here too, so a missing directory self-heals rather
 * than becoming a permanent silent refusal.
 */
bool LedgerIsPersistable(std::uint32_t uid) {
  if (uid == 0) return false;
  if (!ProvisionAutoUnlockStateDirectory(
           kAutoUnlockStateDirectory,
           ProductionAutoUnlockStoreIdentity(::geteuid()))
           .provisioned()) {
    return false;
  }
  const std::string probe =
      std::string(kAutoUnlockStateDirectory) + "/.probe-" + std::to_string(uid);
  ::unlink(probe.c_str());
  const int fd = ::open(probe.c_str(),
                        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                        kAutoUnlockRecordMode);
  if (fd < 0) return false;
  ::close(fd);
  ::unlink(probe.c_str());
  return true;
}

struct MechanismInstance {
  AuthorizationEngineRef engine = nullptr;
  bool is_settle = false;
  EngineCallbacks callbacks;
  MechanismInstance(const AuthorizationCallbacks* cbs,
                    AuthorizationEngineRef eng,
                    bool settle)
      : engine(eng), is_settle(settle), callbacks(cbs, eng) {}
};

struct PluginInstance {
  const AuthorizationCallbacks* callbacks = nullptr;
};

OSStatus PluginDestroy(AuthorizationPluginRef plugin) {
  delete static_cast<PluginInstance*>(plugin);
  return errAuthorizationSuccess;
}

OSStatus MechanismCreate(AuthorizationPluginRef plugin,
                         AuthorizationEngineRef engine,
                         AuthorizationMechanismId mechanism_id,
                         AuthorizationMechanismRef* out_mechanism) {
  auto* instance = static_cast<PluginInstance*>(plugin);
  if (instance == nullptr || out_mechanism == nullptr || mechanism_id == nullptr)
    return errAuthorizationInternal;
  // Only the two mechanisms this bundle vends. An unknown id is refused rather
  // than defaulted, so a right that names something we do not implement fails
  // closed instead of silently allowing.
  const bool submit = std::strcmp(mechanism_id, "submit") == 0;
  const bool settle = std::strcmp(mechanism_id, "settle") == 0;
  if (!submit && !settle)
    return errAuthorizationInternal;
  *out_mechanism = new MechanismInstance(instance->callbacks, engine, settle);
  return errAuthorizationSuccess;
}

OSStatus MechanismInvoke(AuthorizationMechanismRef mechanism) {
  auto* instance = static_cast<MechanismInstance*>(mechanism);
  if (instance == nullptr)
    return errAuthorizationInternal;

  // The uid identifies whose ledger this is. Both mechanisms must agree on it,
  // otherwise submit spends one user's budget and settle clears another's.
  const std::uint32_t uid = instance->callbacks.ReadContextUnsigned("uid");
  const std::int64_t now_ms = NowMilliseconds();

  if (instance->is_settle) {
    // Apple's verifier has run by now. Read its verdict, clear both context
    // values, and settle the ledger.
    //
    // The ledger must be the REAL one and the result must be written back.
    // Submit persists the spent attempt; settle is the only thing that clears
    // it on success. Discarding the settled state here would make the counter
    // monotonic and lock the user out permanently after kAutoUnlockMaxAttempts
    // *successful* unlocks. A settle with no prior submit still cannot clear
    // anything, because the loaded ledger is then already fresh.
    const AutoUnlockSettleOutcome outcome = RunAutoUnlockSettleMechanism(
        instance->callbacks, LoadAutoUnlockLedger(uid), now_ms);
    // A settle that cannot persist leaves the spent attempt on record, which is
    // the safe direction: the user retries manually rather than gaining a free
    // one. Nothing to roll back, so the verdict still stands.
    (void)StoreAutoUnlockLedger(uid, outcome.next_state);
    return errAuthorizationSuccess;
  }

  // submit. Everything the decision needs comes from the engine and from the
  // one-shot local authority; nothing arrives over product IPC, argv or env.
  AutoUnlockSubmitObservation observation;
  observation.uid = uid;
  observation.local_user_name = instance->callbacks.ReadContextString("username");
  // The audit session id of the session actually asking to unlock.
  auditinfo_addr_t audit_info = {};
  if (getaudit_addr(&audit_info, sizeof(audit_info)) == 0)
    observation.audit_session_id = static_cast<std::uint32_t>(audit_info.ai_asid);
  observation.session_type = "Aqua";
  // Honest accounting: a mechanism is not told which right invoked it, so this
  // is NOT observed here -- it is an invariant of the registration module. Every
  // right this plug-in may be registered into is lock-bearing
  // (IsAutoUnlockLockBearingRight gates ApplyAutoUnlockRights), so reaching
  // submit at all implies a locked surface. The invariant is asserted by
  // AutoUnlockRegistrationTargetsOnlyLockBearingRights; if someone later
  // registers submit into a non-lock right, that test fails rather than this
  // line silently lying. Until LoginWindow qualification runs on real hardware
  // this stays a residual assumption, tracked unchecked in evidence.
  observation.locked = true;

  // Preflight BEFORE consuming anything. The authority is one-shot: if we spend
  // it and only then discover the attempt cannot be recorded, the user has lost
  // their authority AND the retry bound has quietly disappeared.
  if (!LedgerIsPersistable(uid)) {
    instance->callbacks.SetDisposition(AutoUnlockMechanismDisposition::kDeny);
    return errAuthorizationSuccess;
  }

  const AutoUnlockAuthorityStore authority_store =
      CreateLocalAutoUnlockAuthorityStore();
  std::unique_ptr<AutoUnlockCredentialBackend> backend =
      CreateSystemKeychainAutoUnlockBackend();

  const AutoUnlockSubmitOutcome outcome = RunAutoUnlockSubmitMechanism(
      instance->callbacks, observation, LoadAutoUnlockLedger(uid), now_ms,
      authority_store, backend.get());
  if (!StoreAutoUnlockLedger(uid, outcome.next_state)) {
    // The attempt happened but could not be recorded. Deny rather than let an
    // unrecorded attempt through -- otherwise the ledger under-counts and the
    // lockout bound is not a bound.
    instance->callbacks.SetDisposition(AutoUnlockMechanismDisposition::kDeny);
  }
  return errAuthorizationSuccess;
}

OSStatus MechanismDeactivate(AuthorizationMechanismRef mechanism) {
  auto* instance = static_cast<MechanismInstance*>(mechanism);
  if (instance == nullptr)
    return errAuthorizationInternal;
  // Deactivation can happen at any point, including mid-authorization. Clear
  // both values so a credential never survives a cancelled unlock.
  instance->callbacks.ClearContextValue(kAutoUnlockContextKeyPassword);
  instance->callbacks.ClearContextValue(kAutoUnlockContextKeyUsername);
  return errAuthorizationSuccess;
}

OSStatus MechanismDestroy(AuthorizationMechanismRef mechanism) {
  auto* instance = static_cast<MechanismInstance*>(mechanism);
  if (instance != nullptr) {
    instance->callbacks.ClearContextValue(kAutoUnlockContextKeyPassword);
    instance->callbacks.ClearContextValue(kAutoUnlockContextKeyUsername);
  }
  delete instance;
  return errAuthorizationSuccess;
}

const AuthorizationPluginInterface kInterface = {
    kAuthorizationPluginInterfaceVersion,
    &PluginDestroy,
    &MechanismCreate,
    &MechanismInvoke,
    &MechanismDeactivate,
    &MechanismDestroy,
};

}  // namespace
}  // namespace imcodes::remote_desktop::macos

// authorizationhost dlopens the bundle and looks this symbol up by name, so it
// must survive the -fvisibility=hidden the surrounding build applies.
extern "C" __attribute__((visibility("default"))) OSStatus
AuthorizationPluginCreate(
    const AuthorizationCallbacks* callbacks,
    AuthorizationPluginRef* plugin,
    const AuthorizationPluginInterface** plugin_interface) {
  namespace md = imcodes::remote_desktop::macos;
  if (callbacks == nullptr || plugin == nullptr || plugin_interface == nullptr)
    return errAuthorizationInternal;
  auto* instance = new md::PluginInstance{callbacks};
  *plugin = instance;
  *plugin_interface = &md::kInterface;
  return errAuthorizationSuccess;
}

// The bundle identity this plug-in must be signed with. The System-keychain ACL
// designated requirement must name THIS identifier, not the LaunchAgent's: the
// LaunchAgent never reads the credential, and binding the ACL to it would let
// any code running as that agent reach the item.
extern "C" __attribute__((visibility("default")))
    const char kAiDeskAutoUnlockPluginBundleIdentifier[];
const char kAiDeskAutoUnlockPluginBundleIdentifier[] =
    "to.aidesk.remote-desktop.autounlock";
