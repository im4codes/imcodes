// Counterfactuals for the Authorization Plug-in mechanisms and the transactional
// right installer. No Apple types, no login window, no installation.
#include "macos_auto_unlock_plugin.h"
#include "macos_auto_unlock_rights.h"

#include <algorithm>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace md = imcodes::remote_desktop::macos;
namespace { int g_failures = 0;
void Check(bool c, const char* what) { if (!c) { std::printf("FAIL: %s\n", what); ++g_failures; } }

struct FakeEngine final : md::AutoUnlockPluginEngine {
  std::map<std::string, std::string> context;
  std::vector<std::string> flag_log;
  std::vector<std::string> order;
  md::AutoUnlockMechanismVerdict verdict = md::AutoUnlockMechanismVerdict::kAllow;
  md::AutoUnlockMechanismDisposition disposition = md::AutoUnlockMechanismDisposition::kAllow;
  bool fail_password = false;

  bool SetContextValue(std::string_view key, md::AutoUnlockContextFlags flags,
                       const char* bytes, std::size_t length) override {
    order.emplace_back(std::string("set:") + std::string(key));
    if (fail_password && key == md::kAutoUnlockContextKeyPassword) return false;
    flag_log.emplace_back(std::string(key) + "=" +
                          std::to_string(static_cast<std::uint32_t>(flags)));
    context[std::string(key)] = std::string(bytes, length);
    return true;
  }
  void ClearContextValue(std::string_view key) noexcept override {
    order.emplace_back(std::string("clear:") + std::string(key));
    context.erase(std::string(key));
  }
  md::AutoUnlockMechanismVerdict ReadVerdict() override {
    order.emplace_back("read_verdict"); return verdict;
  }
  void SetDisposition(md::AutoUnlockMechanismDisposition d) override { disposition = d; }
};

void ContextIsVolatileNonExtractable() {
  FakeEngine engine;
  md::EnginePluginContextWriter writer(engine);
  Check(writer.SetVolatileUsername("alice", 5), "username is written");
  Check(writer.SetVolatilePassword("pw", 2), "password is written");
  const auto expected = std::to_string(static_cast<std::uint32_t>(
      md::AutoUnlockContextFlags::kVolatileNonExtractable));
  for (const auto& entry : engine.flag_log) {
    Check(entry.find("=" + expected) != std::string::npos,
          "every context value is volatile and non-extractable");
  }
  // Extractable would let any later mechanism read the password back out.
  Check(static_cast<std::uint32_t>(md::AutoUnlockContextFlags::kVolatileNonExtractable) == 0x1u,
        "the flag set does not include extractable");
}

void OversizeAndEmptyContextRefused() {
  FakeEngine engine;
  md::EnginePluginContextWriter writer(engine);
  const std::string big(257, 'x');
  Check(!writer.SetVolatilePassword(big.data(), big.size()), "oversize password refused");
  Check(!writer.SetVolatileUsername(nullptr, 4), "null username refused");
  Check(!writer.SetVolatilePassword("x", 0), "empty password refused");
  Check(engine.context.empty(), "nothing partial reached the engine");
}

void PartialWriteLeavesNoCredentialBehind() {
  // The real hazard: username lands, password fails, and a username with no
  // password turns auto-unlock into an interactive prompt with our name in it.
  FakeEngine engine;
  engine.fail_password = true;
  md::EnginePluginContextWriter writer(engine);
  md::AuthorizationContextAutoUnlockInjector injector(writer, "alice");
  Check(!injector.Inject("pw", 2), "a failed password write fails the injection");
  Check(engine.context.find(md::kAutoUnlockContextKeyUsername) == engine.context.end(),
        "the username is rolled back when the password cannot be written");
  Check(engine.context.empty(), "no credential fragment remains in context");
}

void SettleClearsContextOnEveryVerdict() {
  for (const auto verdict : {md::AutoUnlockMechanismVerdict::kAllow,
                             md::AutoUnlockMechanismVerdict::kDeny,
                             md::AutoUnlockMechanismVerdict::kUndetermined}) {
    FakeEngine engine;
    engine.verdict = verdict;
    engine.context["username"] = "alice";
    engine.context["password"] = "pw";
    md::AutoUnlockAttemptState spent; spent.attempts = 1;
    const auto outcome = md::RunAutoUnlockSettleMechanism(engine, spent, 1'000);
    Check(engine.context.empty(), "settle clears both values on every verdict");
    Check(outcome.context_cleared, "settle reports the clear");
    // Verdict must be read before the clear, or there is nothing left to read.
    const auto read_at = std::find(engine.order.begin(), engine.order.end(), "read_verdict");
    const auto clear_at = std::find(engine.order.begin(), engine.order.end(),
                                    std::string("clear:") + md::kAutoUnlockContextKeyPassword);
    Check(read_at < clear_at, "the verdict is read before the context is cleared");
  }
}

void OnlyAllowClearsTheLedger() {
  md::AutoUnlockAttemptState spent; spent.attempts = 2;

  FakeEngine allow; allow.verdict = md::AutoUnlockMechanismVerdict::kAllow;
  const auto accepted = md::RunAutoUnlockSettleMechanism(allow, spent, 1'000);
  Check(accepted.next_state.attempts == 0, "an allowed verdict clears the ledger");
  Check(accepted.disposition == md::AutoUnlockMechanismDisposition::kAllow, "allow propagates");

  FakeEngine deny; deny.verdict = md::AutoUnlockMechanismVerdict::kDeny;
  const auto rejected = md::RunAutoUnlockSettleMechanism(deny, spent, 1'000);
  Check(rejected.next_state.attempts == 2, "a denied verdict keeps the attempt spent");
  Check(rejected.disposition == md::AutoUnlockMechanismDisposition::kDeny, "deny propagates");

  FakeEngine silent; silent.verdict = md::AutoUnlockMechanismVerdict::kUndetermined;
  const auto undetermined = md::RunAutoUnlockSettleMechanism(silent, spent, 1'000);
  Check(undetermined.next_state.attempts == 2, "silence is not a free retry");
  Check(undetermined.disposition == md::AutoUnlockMechanismDisposition::kDeny,
        "an undetermined verdict denies");
}

void MechanismOrderPutsAppleInTheMiddle() {
  // Our submit must precede Apple's verifier and our settle must follow it;
  // settling before verification would read a verdict that does not exist yet.
  const std::vector<std::string> order = {
      md::kAutoUnlockMechanismSubmit, md::kAutoUnlockMechanismBuiltinAuthenticate,
      md::kAutoUnlockMechanismSettle};
  Check(order[0] == std::string("aiDeskAutoUnlock:submit"), "submit is first");
  Check(order[1] == std::string("builtin:authenticate"), "Apple verifies in the middle");
  Check(order[2] == std::string("aiDeskAutoUnlock:settle"), "settle is last");
}

// ---------- transactional right installer ----------

struct FakeRightStore {
  std::map<std::string, std::string> rights;
  int writes = 0;
  std::string fail_write_for;
  std::string corrupt_write_for;
  std::vector<std::string> removed;

  md::AuthorizationRightStore Store() {
    md::AuthorizationRightStore s;
    s.read = [this](const std::string& n) -> std::optional<std::string> {
      const auto found = rights.find(n);
      return found == rights.end() ? std::nullopt : std::optional<std::string>(found->second);
    };
    s.write = [this](const std::string& n, const std::string& v, std::string* e) {
      ++writes;
      if (n == fail_write_for) { *e = "write refused"; return false; }
      rights[n] = (n == corrupt_write_for) ? v + "-corrupted" : v;
      return true;
    };
    s.remove = [this](const std::string& n, std::string*) {
      removed.push_back(n); rights.erase(n); return true;
    };
    return s;
  }
};

const std::vector<md::AuthorizationRightDefinition> Desired() {
  return {{md::kAutoUnlockRightLoginConsole, "<new-console/>"},
          {md::kAutoUnlockRightScreensaver, "<new-saver/>"}};
}

void ApplySnapshotsCompletePriorDefinitions() {
  FakeRightStore store;
  store.rights[md::kAutoUnlockRightLoginConsole] = "<old-console keys=all/>";
  store.rights[md::kAutoUnlockRightScreensaver] = "<old-saver keys=all/>";
  const auto result = md::ApplyAuthorizationRights(Desired(), store.Store());
  Check(result.applied(), "a clean apply succeeds");
  Check(result.snapshot.size() == 2, "every right is snapshotted");
  Check(result.snapshot[0].serialized == "<old-console keys=all/>",
        "the snapshot is the complete prior definition, verbatim");
  Check(result.created.empty(), "pre-existing rights are not marked created");
}

void ReadBackMismatchRollsBack() {
  // The write says success but stores something else. Only read-back catches it.
  FakeRightStore store;
  store.rights[md::kAutoUnlockRightLoginConsole] = "<old-console/>";
  store.rights[md::kAutoUnlockRightScreensaver] = "<old-saver/>";
  store.corrupt_write_for = md::kAutoUnlockRightLoginConsole;
  const auto result = md::ApplyAuthorizationRights(Desired(), store.Store());
  Check(!result.applied(), "a read-back mismatch is not an apply");
  Check(result.status == md::AuthorizationRightTransactionStatus::kRolledBack,
        "a read-back mismatch rolls back");
  Check(store.rights[md::kAutoUnlockRightScreensaver] == "<old-saver/>",
        "the untouched right keeps its prior definition");
}

void FailedSecondWriteRestoresTheFirst() {
  FakeRightStore store;
  store.rights[md::kAutoUnlockRightLoginConsole] = "<old-console/>";
  store.rights[md::kAutoUnlockRightScreensaver] = "<old-saver/>";
  store.fail_write_for = md::kAutoUnlockRightScreensaver;
  const auto result = md::ApplyAuthorizationRights(Desired(), store.Store());
  Check(result.status == md::AuthorizationRightTransactionStatus::kRolledBack,
        "a mid-transaction failure rolls back");
  Check(store.rights[md::kAutoUnlockRightLoginConsole] == "<old-console/>",
        "the already-written right is restored to its exact prior definition");
}

void UninstallRemovesRightsItCreated() {
  FakeRightStore store;  // neither right exists beforehand
  const auto applied = md::ApplyAuthorizationRights(Desired(), store.Store());
  Check(applied.applied(), "apply succeeds on a machine without these rights");
  Check(applied.created.size() == 2, "both rights are recorded as created");
  const auto restored = md::RestoreAuthorizationRights(
      applied.snapshot, applied.created, store.Store());
  Check(restored.status == md::AuthorizationRightTransactionStatus::kRolledBack,
        "restore completes");
  Check(store.rights.empty(), "created rights are removed, not resurrected empty");
  Check(store.removed.size() == 2, "removal is what uninstall performs for created rights");
}

void UninstallRestoresReplacedDefinitionsVerbatim() {
  FakeRightStore store;
  store.rights[md::kAutoUnlockRightLoginConsole] = "<old-console keys=all/>";
  store.rights[md::kAutoUnlockRightScreensaver] = "<old-saver keys=all/>";
  const auto applied = md::ApplyAuthorizationRights(Desired(), store.Store());
  Check(applied.applied(), "apply succeeds");
  const auto restored = md::RestoreAuthorizationRights(
      applied.snapshot, applied.created, store.Store());
  Check(restored.status == md::AuthorizationRightTransactionStatus::kRolledBack, "restore completes");
  Check(store.rights[md::kAutoUnlockRightLoginConsole] == "<old-console keys=all/>",
        "the replaced definition returns byte-identical");
  Check(store.removed.empty(), "a replaced right is restored, never removed");
}

void UnlistedRightsAreRefused() {
  FakeRightStore store;
  const std::vector<md::AuthorizationRightDefinition> hostile = {
      {"system.preferences", "<anything/>"}};
  const auto result = md::ApplyAuthorizationRights(hostile, store.Store());
  Check(result.status == md::AuthorizationRightTransactionStatus::kInvalid,
        "a right outside the permitted set is refused");
  Check(store.writes == 0, "an unlisted right is never written");
}
}  // namespace

int main() {
  ContextIsVolatileNonExtractable();
  OversizeAndEmptyContextRefused();
  PartialWriteLeavesNoCredentialBehind();
  SettleClearsContextOnEveryVerdict();
  OnlyAllowClearsTheLedger();
  MechanismOrderPutsAppleInTheMiddle();
  ApplySnapshotsCompletePriorDefinitions();
  ReadBackMismatchRollsBack();
  FailedSecondWriteRestoresTheFirst();
  UninstallRemovesRightsItCreated();
  UninstallRestoresReplacedDefinitionsVerbatim();
  UnlistedRightsAreRefused();
  if (g_failures != 0) { std::printf("%d plugin/rights counterfactual(s) failed\n", g_failures); return 1; }
  std::printf("macos auto unlock plugin and rights counterfactual ok\n");
  return 0;
}
