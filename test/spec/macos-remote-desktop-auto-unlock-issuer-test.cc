// End-to-end store counterfactuals: gateway -> issuer -> validated read ->
// parse, on a real temp directory. No root, no keychain, no login window.
//
// The store identity is seamed as {effective_uid, required_owner_uid}. Production
// is always {geteuid(), 0}; these tests pass {getuid(), getuid()}, which keeps
// the production property under test (writer identity must equal store owner)
// instead of deleting it to make the suite runnable.
#include "macos_auto_unlock_gateway.h"

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <optional>
#include <string>

#include "macos_auto_unlock_controller.h"
#include "macos_auto_unlock_issuer.h"
#include "macos_auto_unlock_paths.h"
#include "macos_auto_unlock_provision.h"
#include "macos_auto_unlock_record_io.h"

namespace md = imcodes::remote_desktop::macos;
namespace {
int g_failures = 0;
void Check(bool c, const char* w) {
  if (!c) { std::printf("FAIL: %s\n", w); ++g_failures; }
}

const md::AutoUnlockStoreIdentity kSelf{static_cast<std::uint32_t>(::getuid()),
                                        static_cast<std::uint32_t>(::getuid())};
constexpr std::uint32_t kAsid = 0x186a3;
constexpr std::uint64_t kWorkerGeneration = 77;
constexpr std::uint64_t kRouteGeneration = 9;
constexpr std::int64_t kNow = 1'000'000;
const char kRequirement[] = "identifier \"to.aidesk.remote-desktop.autounlock\"";

std::string MakeTempRoot() {
  char pattern[] = "/tmp/aidesk-autounlock-store-XXXXXX";
  const char* made = ::mkdtemp(pattern);
  if (made == nullptr) return {};
  // mkdtemp gives 0700 already; the store must adopt it as-is.
  return std::string(made);
}

/** A temp root that does NOT yet contain the store directory. */
std::string MakeUnprovisionedRoot() { return MakeTempRoot() + "/state"; }

std::uint32_t SelfUid() { return static_cast<std::uint32_t>(::getuid()); }

md::AutoUnlockGatewayObservation LockedObservation() {
  md::AutoUnlockGatewayObservation o;
  o.local_user_name = "tester";
  o.local_user_uid = SelfUid();
  o.audit_session_id = kAsid;
  o.session_type = "Aqua";
  o.worker_generation = kWorkerGeneration;
  o.route_generation = kRouteGeneration;
  o.locked = true;
  o.surface = md::kAutoUnlockSurfaceLockedSession;
  return o;
}

bool Enroll(const std::string& root, const char* policy) {
  md::AutoUnlockEnrollment enrollment;
  enrollment.policy = policy;
  enrollment.designated_requirement = kRequirement;
  return md::WriteAutoUnlockEnrollment(root, SelfUid(), enrollment, kSelf);
}

/** Reads exactly the way the plug-in does, then parses. */
std::optional<md::AutoUnlockAuthority> ConsumeLikePlugin(
    const std::string& root, std::uint32_t uid, std::uint32_t asid) {
  const std::string path = md::AutoUnlockAuthorityPath(root, uid, asid);
  const std::string raw = md::ReadValidatedAutoUnlockRecord(
      path, kSelf.required_owner_uid, md::kAutoUnlockAuthorityMaxBytes);
  ::unlink(path.c_str());
  if (raw.empty()) return std::nullopt;
  return md::ParseAutoUnlockAuthority(raw);
}

// ---------------------------------------------------------------- first boot

// A missing store directory must SELF-HEAL, not become a silent permanent
// refusal that no operator can diagnose.
void FirstBootCreatesTheStoreInsteadOfRefusingForever() {
  const std::string root = MakeUnprovisionedRoot();
  struct stat info = {};
  Check(::lstat(root.c_str(), &info) != 0, "store absent before first issue");

  Check(md::WriteAutoUnlockEnrollment(
            root, SelfUid(),
            md::AutoUnlockEnrollment{md::kAutoUnlockPolicyAlways, kRequirement},
            kSelf),
        "enrolment provisions the store on first use");
  const md::AutoUnlockGatewayResult result = md::RunAutoUnlockGateway(
      LockedObservation(), kNow, md::GenerateAutoUnlockNonce(), root, kSelf);
  Check(result.issued(), "first boot issues rather than refusing forever");

  Check(::lstat(root.c_str(), &info) == 0 && S_ISDIR(info.st_mode),
        "the store directory now exists");
  Check((info.st_mode & 0777) == md::kAutoUnlockStateDirectoryMode,
        "the store is created 0700, not merely present");
}

// Isolates the ISSUER's self-provisioning. The first-boot test above enrols
// first, and enrolment provisions the store, so deleting the issuer's own
// provisioning left that test green. Here nothing has provisioned anything.
void TheIssuerItselfProvisionsAMissingStore() {
  const std::string root = MakeUnprovisionedRoot();
  struct stat info = {};
  Check(::lstat(root.c_str(), &info) != 0, "store absent");

  md::AutoUnlockAuthority authority;
  authority.policy = md::kAutoUnlockPolicyAlways;
  authority.surface = md::kAutoUnlockSurfaceLockedSession;
  authority.designated_requirement = kRequirement;
  authority.enrolled.local_user_name = "tester";
  authority.enrolled.local_user_uid = SelfUid();
  authority.enrolled.session_type = "Aqua";
  authority.enrolled.audit_session_id = kAsid;
  authority.enrolled.worker_generation = kWorkerGeneration;
  authority.route_generation = kRouteGeneration;
  authority.nonce = md::GenerateAutoUnlockNonce();
  authority.issued_at_ms = kNow;
  authority.expires_at_ms = kNow + 60'000;

  const md::AutoUnlockIssueResult issued =
      md::IssueAutoUnlockAuthority(authority, root, kSelf);
  Check(issued.issued(),
        "the issuer creates the store itself rather than refusing forever");
  Check(::lstat(root.c_str(), &info) == 0 && S_ISDIR(info.st_mode) &&
            (info.st_mode & 0777) == md::kAutoUnlockStateDirectoryMode,
        "and creates it 0700");
  Check(!md::ReadValidatedAutoUnlockRecord(issued.path, kSelf.required_owner_uid,
                                           md::kAutoUnlockAuthorityMaxBytes)
             .empty(),
        "the record it wrote is readable by the consumer's validated read");
}

// ------------------------------------------------------------------- policy

void PolicyGovernsIssuance() {
  const std::string root = MakeTempRoot();
  const md::AutoUnlockGatewayObservation observation = LockedObservation();
  const std::string nonce = md::GenerateAutoUnlockNonce();

  Check(md::RunAutoUnlockGateway(observation, kNow, nonce, root, kSelf).status ==
            md::AutoUnlockGatewayStatus::kSkippedNotEnrolled,
        "an unenrolled user is skipped, and default is not permissive");

  Check(Enroll(root, md::kAutoUnlockPolicyDisabled), "enrol disabled");
  Check(md::RunAutoUnlockGateway(observation, kNow, nonce, root, kSelf).status ==
            md::AutoUnlockGatewayStatus::kSkippedPolicyDisabled,
        "policy disabled issues nothing");

  Check(Enroll(root, "something-else"), "enrol unknown policy");
  Check(md::RunAutoUnlockGateway(observation, kNow, nonce, root, kSelf).status ==
            md::AutoUnlockGatewayStatus::kSkippedPolicyDisabled,
        "an unrecognised policy is not treated as permissive");

  // loginwindow_only must not mint for a merely locked Aqua session.
  Check(Enroll(root, md::kAutoUnlockPolicyLoginWindowOnly), "enrol lw-only");
  Check(md::RunAutoUnlockGateway(observation, kNow, nonce, root, kSelf).status ==
            md::AutoUnlockGatewayStatus::kSkippedSurfaceNotPermitted,
        "loginwindow_only refuses a locked-session surface");

  md::AutoUnlockGatewayObservation login_window = observation;
  login_window.surface = md::kAutoUnlockSurfaceLoginWindow;
  Check(md::RunAutoUnlockGateway(login_window, kNow, nonce, root, kSelf).issued(),
        "loginwindow_only issues for the login window surface");
}

void AnUnlockedSessionLeavesNoTrace() {
  const std::string root = MakeTempRoot();
  Check(Enroll(root, md::kAutoUnlockPolicyAlways), "enrol");
  md::AutoUnlockGatewayObservation unlocked = LockedObservation();
  unlocked.locked = false;
  Check(md::RunAutoUnlockGateway(unlocked, kNow, md::GenerateAutoUnlockNonce(),
                                 root, kSelf)
              .status == md::AutoUnlockGatewayStatus::kSkippedNotLocked,
        "an unlocked session is skipped");
  struct stat info = {};
  Check(::lstat(md::AutoUnlockAuthorityPath(root, SelfUid(), kAsid).c_str(),
                &info) != 0,
        "an unlocked session writes no authority at all");
}

// --------------------------------------------------------------- bindings

void EveryBindingFieldIsMandatory() {
  const std::string root = MakeTempRoot();
  Check(Enroll(root, md::kAutoUnlockPolicyAlways), "enrol");
  const std::string nonce = md::GenerateAutoUnlockNonce();

  struct Case { const char* what; md::AutoUnlockGatewayObservation observation; };
  md::AutoUnlockGatewayObservation no_route = LockedObservation();
  no_route.route_generation = 0;
  md::AutoUnlockGatewayObservation no_generation = LockedObservation();
  no_generation.worker_generation = 0;
  md::AutoUnlockGatewayObservation no_asid = LockedObservation();
  no_asid.audit_session_id = 0;
  md::AutoUnlockGatewayObservation no_user = LockedObservation();
  no_user.local_user_name.clear();
  md::AutoUnlockGatewayObservation no_uid = LockedObservation();
  no_uid.local_user_uid = 0;

  const Case cases[] = {
      {"route generation 0", no_route},
      {"worker generation 0", no_generation},
      {"ASID 0", no_asid},
      {"empty username", no_user},
      {"uid 0", no_uid},
  };
  for (const Case& c : cases) {
    Check(md::RunAutoUnlockGateway(c.observation, kNow, nonce, root, kSelf)
                  .status ==
              md::AutoUnlockGatewayStatus::kSkippedIncompleteBinding,
          c.what);
  }
  Check(md::RunAutoUnlockGateway(LockedObservation(), kNow, "", root, kSelf)
                .status == md::AutoUnlockGatewayStatus::kSkippedIncompleteBinding,
        "an empty nonce is refused");
}

void TheAuthorityCarriesTheFullBindingAndNoCredential() {
  const std::string root = MakeTempRoot();
  Check(Enroll(root, md::kAutoUnlockPolicyAlways), "enrol");
  const std::string nonce = md::GenerateAutoUnlockNonce();
  Check(md::RunAutoUnlockGateway(LockedObservation(), kNow, nonce, root, kSelf)
            .issued(), "issued");

  const auto parsed = ConsumeLikePlugin(root, SelfUid(), kAsid);
  Check(parsed.has_value(), "the plug-in's validated read accepts it");
  if (parsed.has_value()) {
    Check(parsed->enrolled.local_user_uid == SelfUid(), "uid bound");
    Check(parsed->enrolled.local_user_name == "tester", "username bound");
    Check(parsed->enrolled.audit_session_id == kAsid, "ASID bound");
    Check(parsed->enrolled.session_type == "Aqua", "session type bound");
    Check(parsed->enrolled.worker_generation == kWorkerGeneration,
          "worker generation bound");
    Check(parsed->route_generation == kRouteGeneration, "route bound");
    Check(parsed->nonce == nonce, "nonce bound");
    Check(parsed->expires_at_ms > parsed->issued_at_ms, "expiry bound");
    Check(parsed->expires_at_ms - parsed->issued_at_ms <=
              md::kAutoUnlockAuthorityMaxLifetimeMs,
          "lifetime is within the hard bound");
  }
}

// A record minted for one ASID must not be readable as another session's, and a
// stale generation must not survive a re-route.
void CrossAsidAndCrossGenerationAreDistinct() {
  const std::string root = MakeTempRoot();
  Check(Enroll(root, md::kAutoUnlockPolicyAlways), "enrol");
  Check(md::RunAutoUnlockGateway(LockedObservation(), kNow,
                                 md::GenerateAutoUnlockNonce(), root, kSelf)
            .issued(), "issued for kAsid");

  // Another session's ASID finds nothing: the path itself is ASID-scoped.
  Check(!ConsumeLikePlugin(root, SelfUid(), kAsid + 1).has_value(),
        "a different ASID finds no authority");
  // A different uid likewise.
  Check(!ConsumeLikePlugin(root, SelfUid() + 1000, kAsid).has_value(),
        "a different uid finds no authority");
  // The original is still there and still names the generation it was minted for.
  const auto parsed = ConsumeLikePlugin(root, SelfUid(), kAsid);
  Check(parsed.has_value() &&
            parsed->enrolled.worker_generation == kWorkerGeneration &&
            parsed->route_generation == kRouteGeneration,
        "the original authority still names its own route and generation");
}

// rd::Authority::route_generation is std::optional<int64_t>. A missing value is
// the legacy, less-authenticated population; coercing it with value_or would
// mint an authority bound to a route that never existed.
void AMissingOrIllegalRouteGenerationNeverBecomesABinding() {
  std::uint64_t resolved = 12345;  // sentinel: must be left untouched on refusal
  Check(!md::ResolveAutoUnlockRouteGeneration(std::nullopt, &resolved),
        "an absent route generation is refused");
  Check(resolved == 12345, "a refused resolve leaves the output untouched");
  Check(!md::ResolveAutoUnlockRouteGeneration(std::optional<std::int64_t>(0),
                                              &resolved),
        "route generation 0 is refused, not widened");
  Check(!md::ResolveAutoUnlockRouteGeneration(std::optional<std::int64_t>(-1),
                                              &resolved),
        "a negative route generation is refused, not widened to a huge uint64");
  Check(!md::ResolveAutoUnlockRouteGeneration(
            std::optional<std::int64_t>(-9223372036854775807LL - 1), &resolved),
        "the most negative int64 is refused rather than wrapping");
  Check(resolved == 12345, "no refusal path ever wrote an output");

  Check(md::ResolveAutoUnlockRouteGeneration(std::optional<std::int64_t>(9),
                                             &resolved),
        "a positive route generation resolves");
  Check(resolved == 9, "and resolves to exactly that value");
  std::uint64_t big = 0;
  Check(md::ResolveAutoUnlockRouteGeneration(
            std::optional<std::int64_t>(9223372036854775807LL), &big),
        "int64 max resolves");
  Check(big == 9223372036854775807ULL, "int64 max survives the narrowing");
}

// ...and end-to-end: a refused generation must leave NOTHING in the store.
void AnUnusableRouteGenerationWritesNoAuthority() {
  const std::string root = MakeTempRoot();
  Check(Enroll(root, md::kAutoUnlockPolicyAlways), "enrol");
  for (std::uint64_t bad : {static_cast<std::uint64_t>(0)}) {
    md::AutoUnlockGatewayObservation observation = LockedObservation();
    observation.route_generation = bad;
    Check(md::RunAutoUnlockGateway(observation, kNow,
                                   md::GenerateAutoUnlockNonce(), root, kSelf)
                  .status ==
              md::AutoUnlockGatewayStatus::kSkippedIncompleteBinding,
          "an unbound route generation is refused by the gateway");
  }
  struct stat info = {};
  Check(::lstat(md::AutoUnlockAuthorityPath(root, SelfUid(), kAsid).c_str(),
                &info) != 0,
        "a refused route generation writes no authority at all");
}

// ------------------------------------------------------ single consume/replay

void ConcurrentConsumeYieldsExactlyOneWinner() {
  const std::string root = MakeTempRoot();
  Check(Enroll(root, md::kAutoUnlockPolicyAlways), "enrol");
  Check(md::RunAutoUnlockGateway(LockedObservation(), kNow,
                                 md::GenerateAutoUnlockNonce(), root, kSelf)
            .issued(), "issued");

  // Two consumers race the same record. take() reads AND unlinks, so exactly
  // one can observe a non-empty read.
  const auto first = ConsumeLikePlugin(root, SelfUid(), kAsid);
  const auto second = ConsumeLikePlugin(root, SelfUid(), kAsid);
  Check(first.has_value(), "the first consumer wins");
  Check(!second.has_value(), "the second consumer gets nothing");
}

// A record restored from a copy after consumption (crash-time snapshot, backup)
// is refused because the ledger remembers the last spent nonce.
void ReplayOfARestoredAuthorityIsRefusedByTheLedger() {
  const std::string root = MakeTempRoot();
  Check(Enroll(root, md::kAutoUnlockPolicyAlways), "enrol");
  const std::string nonce = md::GenerateAutoUnlockNonce();
  Check(md::RunAutoUnlockGateway(LockedObservation(), kNow, nonce, root, kSelf)
            .issued(), "issued");

  const std::string path = md::AutoUnlockAuthorityPath(root, SelfUid(), kAsid);
  const std::string snapshot = md::ReadValidatedAutoUnlockRecord(
      path, kSelf.required_owner_uid, md::kAutoUnlockAuthorityMaxBytes);
  Check(!snapshot.empty(), "snapshot taken");

  // Consume once; the ledger records the spent nonce.
  Check(ConsumeLikePlugin(root, SelfUid(), kAsid).has_value(), "first consume");
  md::AutoUnlockLedgerRecord spent;
  spent.attempts = 1;
  spent.last_nonce = nonce;
  Check(md::WriteAutoUnlockRecordAtomically(
            md::AutoUnlockLedgerPath(root, SelfUid()),
            md::SerializeAutoUnlockLedger(spent)),
        "ledger persisted");

  // Restore the snapshot and read the ledger back the way the plug-in does.
  Check(md::WriteAutoUnlockRecordAtomically(path, snapshot), "restored");
  md::AutoUnlockLedgerRecord reloaded;
  Check(md::ParseAutoUnlockLedger(
            md::ReadValidatedAutoUnlockRecord(
                md::AutoUnlockLedgerPath(root, SelfUid()),
                kSelf.required_owner_uid, md::kAutoUnlockAuthorityMaxBytes),
            &reloaded),
        "ledger reloads across a process boundary");
  const auto replayed = ConsumeLikePlugin(root, SelfUid(), kAsid);
  Check(replayed.has_value(), "the restored record still parses");
  Check(replayed.has_value() && replayed->nonce == reloaded.last_nonce,
        "the replayed nonce equals the last spent nonce, so submit refuses it");
}

void ExpiryIsEnforcedByTheRecordItself() {
  const std::string root = MakeTempRoot();
  Check(Enroll(root, md::kAutoUnlockPolicyAlways), "enrol");
  Check(md::RunAutoUnlockGateway(LockedObservation(), kNow,
                                 md::GenerateAutoUnlockNonce(), root, kSelf)
            .issued(), "issued");
  const auto parsed = ConsumeLikePlugin(root, SelfUid(), kAsid);
  Check(parsed.has_value(), "parsed");
  // The consumer compares against `now`; a record minted at kNow is dead well
  // before kNow + lifetime + 1.
  Check(parsed.has_value() &&
            parsed->expires_at_ms <
                kNow + md::kAutoUnlockAuthorityMaxLifetimeMs + 1,
        "an authority cannot outlive the hard lifetime bound");
}

// ------------------------------------------------------------ ledger safety

void ATornLedgerIsNotReadAsFresh() {
  md::AutoUnlockLedgerRecord out;
  Check(!md::ParseAutoUnlockLedger("", &out), "empty ledger is not parseable");
  Check(!md::ParseAutoUnlockLedger("aidesk-auto-unlock-ledger-v1\n3", &out),
        "a truncated ledger is refused");
  Check(!md::ParseAutoUnlockLedger("wrong-version\n1\n2\nabc", &out),
        "a foreign version is refused");
  Check(!md::ParseAutoUnlockLedger("aidesk-auto-unlock-ledger-v1\nx\n2\nabc",
                                   &out),
        "a non-numeric attempt count is refused");
  Check(!md::ParseAutoUnlockLedger("aidesk-auto-unlock-ledger-v1\n-1\n2\nabc",
                                   &out),
        "a negative attempt count is refused");

  md::AutoUnlockLedgerRecord record;
  record.attempts = 2;
  record.locked_out_until_ms = 12345;
  record.last_nonce = "deadbeef";
  Check(md::ParseAutoUnlockLedger(md::SerializeAutoUnlockLedger(record), &out),
        "a well-formed ledger round-trips");
  Check(out.attempts == 2 && out.locked_out_until_ms == 12345 &&
            out.last_nonce == "deadbeef",
        "every ledger field survives the round trip");

  md::AutoUnlockLedgerRecord poisoned;
  poisoned.last_nonce = "a\nb";
  Check(md::SerializeAutoUnlockLedger(poisoned).empty(),
        "a separator-bearing nonce refuses to serialise");
}

// Crash recovery: a ledger written atomically survives, and the retry count is
// carried across the process boundary rather than reset.
void LockoutSurvivesAProcessBoundary() {
  const std::string root = MakeTempRoot();
  md::AutoUnlockLedgerRecord record;
  record.attempts = md::kAutoUnlockMaxAttempts;
  record.locked_out_until_ms = kNow + 60'000;
  record.last_nonce = "spent";
  Check(md::WriteAutoUnlockRecordAtomically(
            md::AutoUnlockLedgerPath(root, SelfUid()),
            md::SerializeAutoUnlockLedger(record)),
        "ledger written");

  md::AutoUnlockLedgerRecord reloaded;
  Check(md::ParseAutoUnlockLedger(
            md::ReadValidatedAutoUnlockRecord(
                md::AutoUnlockLedgerPath(root, SelfUid()),
                kSelf.required_owner_uid, md::kAutoUnlockAuthorityMaxBytes),
            &reloaded),
        "ledger reloads");
  Check(reloaded.attempts == md::kAutoUnlockMaxAttempts,
        "a spent attempt count is NOT reset by restarting the process");
  Check(reloaded.locked_out_until_ms == kNow + 60'000,
        "the lockout deadline survives the restart");
  Check(reloaded.last_nonce == "spent", "the spent nonce survives the restart");
}

// ------------------------------------------------------- store trust boundary

void OnlyTheStoreOwnerMayIssueOrProvision() {
  const std::string root = MakeTempRoot();
  const md::AutoUnlockStoreIdentity stranger{SelfUid() + 1000, 0};
  Check(md::ProvisionAutoUnlockStateDirectory(root + "/x", stranger).status ==
            md::AutoUnlockProvisionStatus::kRefusedNotRoot,
        "a non-owner may not provision the store");
  md::AutoUnlockAuthority authority;
  authority.enrolled.local_user_uid = SelfUid();
  Check(md::IssueAutoUnlockAuthority(authority, root, stranger).status ==
            md::AutoUnlockIssueStatus::kRefusedNotRoot,
        "a non-owner may not issue");
  Check(!md::WriteAutoUnlockEnrollment(
            root, SelfUid(),
            md::AutoUnlockEnrollment{md::kAutoUnlockPolicyAlways, kRequirement},
            stranger),
        "a non-owner may not enrol");
}

void RecordsOwnedByAnotherUserOrWithLooseModesAreRefused() {
  const std::string root = MakeTempRoot();
  const std::string path = root + "/record";
  Check(md::WriteAutoUnlockRecordAtomically(path, "payload"), "write");

  Check(md::ReadValidatedAutoUnlockRecord(path, SelfUid() + 1000, 4096).empty(),
        "a record owned by another user is refused");
  Check(!md::ReadValidatedAutoUnlockRecord(path, SelfUid(), 4096).empty(),
        "the same record is accepted for its real owner");

  Check(::chmod(path.c_str(), 0644) == 0, "loosen");
  Check(md::ReadValidatedAutoUnlockRecord(path, SelfUid(), 4096).empty(),
        "a group/world-readable record is refused");
  Check(::chmod(path.c_str(), md::kAutoUnlockRecordMode) == 0, "restore");
  Check(md::ReadValidatedAutoUnlockRecord(path, SelfUid(), 3).empty(),
        "a record beyond the caller's bound is refused");
}

void SymlinkAndHardLinkRecordsAreRefused() {
  const std::string root = MakeTempRoot();
  const std::string real = root + "/real";
  Check(md::WriteAutoUnlockRecordAtomically(real, "payload"), "write");

  const std::string link = root + "/link";
  Check(::symlink(real.c_str(), link.c_str()) == 0, "symlink");
  Check(md::ReadValidatedAutoUnlockRecord(link, SelfUid(), 4096).empty(),
        "a symlink to a valid record is refused");

  // A hard link is a second name for the same bytes, so unlinking the consumed
  // name would NOT destroy the record and single-consume would be a fiction.
  const std::string hard = root + "/hard";
  Check(::link(real.c_str(), hard.c_str()) == 0, "hard link");
  Check(md::ReadValidatedAutoUnlockRecord(real, SelfUid(), 4096).empty(),
        "a multiply-linked record is refused");
}

void SymlinkedOrForeignStoreDirectoryIsRefused() {
  const std::string root = MakeTempRoot();
  const std::string target = root + "/target";
  Check(::mkdir(target.c_str(), 0700) == 0, "target dir");
  const std::string linked = root + "/linked";
  Check(::symlink(target.c_str(), linked.c_str()) == 0, "symlink");
  Check(md::ProvisionAutoUnlockStateDirectory(linked, kSelf).status ==
            md::AutoUnlockProvisionStatus::kRefusedUnsafeExisting,
        "a symlinked store directory is refused, never adopted");

  // A regular file with the store's exact owner and mode: only the file-type
  // check can distinguish it.
  const std::string file = root + "/file";
  Check(md::WriteAutoUnlockRecordAtomically(file, "x"), "file");
  Check(::chmod(file.c_str(), md::kAutoUnlockStateDirectoryMode) == 0, "0700");
  Check(md::ProvisionAutoUnlockStateDirectory(file, kSelf).status ==
            md::AutoUnlockProvisionStatus::kRefusedUnsafeExisting,
        "a regular file with the store's owner and mode is still refused");

  const md::AutoUnlockStoreIdentity foreign{SelfUid(), SelfUid() + 1000};
  Check(md::ProvisionAutoUnlockStateDirectory(root, foreign).status ==
            md::AutoUnlockProvisionStatus::kRefusedNotRoot,
        "a store required to be owned by someone else is refused");
}

// Un-enrolment must not leave a consumable authority behind.
void RevokeRemovesEveryPendingAuthorityAndTheLedger() {
  const std::string root = MakeTempRoot();
  Check(Enroll(root, md::kAutoUnlockPolicyAlways), "enrol");
  md::AutoUnlockGatewayObservation first = LockedObservation();
  md::AutoUnlockGatewayObservation second = LockedObservation();
  second.audit_session_id = kAsid + 7;
  Check(md::RunAutoUnlockGateway(first, kNow, md::GenerateAutoUnlockNonce(),
                                 root, kSelf).issued(), "issue 1");
  Check(md::RunAutoUnlockGateway(second, kNow, md::GenerateAutoUnlockNonce(),
                                 root, kSelf).issued(), "issue 2");
  md::AutoUnlockLedgerRecord record;
  record.attempts = 1;
  Check(md::WriteAutoUnlockRecordAtomically(
            md::AutoUnlockLedgerPath(root, SelfUid()),
            md::SerializeAutoUnlockLedger(record)), "ledger");

  Check(md::RevokeAutoUnlockUserState(root, SelfUid(), kSelf), "revoke");
  struct stat info = {};
  Check(::lstat(md::AutoUnlockAuthorityPath(root, SelfUid(), kAsid).c_str(),
                &info) != 0, "first authority removed");
  Check(::lstat(md::AutoUnlockAuthorityPath(root, SelfUid(), kAsid + 7).c_str(),
                &info) != 0, "every ASID's authority removed, not just one");
  Check(::lstat(md::AutoUnlockLedgerPath(root, SelfUid()).c_str(), &info) != 0,
        "the ledger is removed too");
}

void NoncesAreUniqueAndBounded() {
  std::string previous;
  for (int i = 0; i < 64; ++i) {
    const std::string nonce = md::GenerateAutoUnlockNonce();
    Check(!nonce.empty() && nonce.size() <= md::kAutoUnlockNonceMaxBytes,
          "nonce is non-empty and within the bound");
    Check(nonce != previous, "consecutive nonces differ");
    Check(nonce.find('\n') == std::string::npos, "nonce carries no separator");
    previous = nonce;
  }
}

void TheStoreNeverContainsACredential() {
  const std::string root = MakeTempRoot();
  Check(Enroll(root, md::kAutoUnlockPolicyAlways), "enrol");
  Check(md::RunAutoUnlockGateway(LockedObservation(), kNow,
                                 md::GenerateAutoUnlockNonce(), root, kSelf)
            .issued(), "issued");
  DIR* handle = ::opendir(root.c_str());
  Check(handle != nullptr, "store readable");
  int inspected = 0;
  while (const dirent* entry = ::readdir(handle)) {
    const std::string name = entry->d_name;
    if (name == "." || name == "..") continue;
    ++inspected;
    const std::string body = md::ReadValidatedAutoUnlockRecord(
        root + "/" + name, kSelf.required_owner_uid, 64 * 1024);
    Check(body.find("password") == std::string::npos &&
              body.find("secret") == std::string::npos &&
              body.find("hunter2") == std::string::npos,
          "no record in the store contains a credential");
  }
  ::closedir(handle);
  Check(inspected >= 2, "both the enrolment and the authority were inspected");
}

}  // namespace

int main() {
  FirstBootCreatesTheStoreInsteadOfRefusingForever();
  TheIssuerItselfProvisionsAMissingStore();
  PolicyGovernsIssuance();
  AnUnlockedSessionLeavesNoTrace();
  EveryBindingFieldIsMandatory();
  TheAuthorityCarriesTheFullBindingAndNoCredential();
  CrossAsidAndCrossGenerationAreDistinct();
  AMissingOrIllegalRouteGenerationNeverBecomesABinding();
  AnUnusableRouteGenerationWritesNoAuthority();
  ConcurrentConsumeYieldsExactlyOneWinner();
  ReplayOfARestoredAuthorityIsRefusedByTheLedger();
  ExpiryIsEnforcedByTheRecordItself();
  ATornLedgerIsNotReadAsFresh();
  LockoutSurvivesAProcessBoundary();
  OnlyTheStoreOwnerMayIssueOrProvision();
  RecordsOwnedByAnotherUserOrWithLooseModesAreRefused();
  SymlinkAndHardLinkRecordsAreRefused();
  SymlinkedOrForeignStoreDirectoryIsRefused();
  RevokeRemovesEveryPendingAuthorityAndTheLedger();
  NoncesAreUniqueAndBounded();
  TheStoreNeverContainsACredential();
  if (g_failures != 0) {
    std::printf("%d store counterfactual(s) failed\n", g_failures);
    return 1;
  }
  std::printf("macos auto unlock store counterfactual ok\n");
  return 0;
}
