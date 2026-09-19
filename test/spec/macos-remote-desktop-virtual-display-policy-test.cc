// Counterfactuals for the virtual-display policy and identity layers.
// Every case below corresponds to a measured failure mode, not a hypothetical.
#include "macos_virtual_display_identity.h"
#include "macos_virtual_display_policy.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <set>
#include <string>

namespace rd = imcodes::remote_desktop::macos;

namespace {

rd::VirtualDisplayTopologyView MeasuredHostView() {
  // The literal reading from this host: registered {5,6,1,2,3}, online {5,6}.
  rd::VirtualDisplayTopologyView view;
  view.registered_ids = {5, 6, 1, 2, 3};
  view.online_ids = {5, 6};
  return view;
}

void ThreeStateIsNotTwoState() {
  const auto view = MeasuredHostView();
  assert(rd::PresenceIn(view, 5) == rd::VirtualDisplayPresence::kActive);
  // 1/2/3 are registered and invisible to every public enumerator. Reporting
  // them absent is what authorises creating another display on top of them.
  assert(rd::PresenceIn(view, 1) ==
         rd::VirtualDisplayPresence::kRegisteredInactive);
  assert(rd::PresenceIn(view, 99) == rd::VirtualDisplayPresence::kAbsent);
  assert(view.IsRegisteredInactive(2));
  assert(!view.IsRegisteredInactive(5));
}

void LastSurfaceGuardRefusesToStrandTheSession() {
  using rd::EvaluateLastSurfaceGuard;
  using rd::LastSurfaceVerdict;
  assert(EvaluateLastSurfaceGuard({2, 0, 1}) == LastSurfaceVerdict::kAllowed);
  // The only surface left may not be retired.
  assert(EvaluateLastSurfaceGuard({1, 0, 1}) ==
         LastSurfaceVerdict::kWouldLeaveNoSurface);
  // Already-disconnecting displays still enumerate; counting them as present
  // would authorise exactly the removal this guard exists to stop.
  assert(EvaluateLastSurfaceGuard({2, 1, 1}) ==
         LastSurfaceVerdict::kWouldLeaveNoSurface);
  // Over-committed state must be a refusal, NOT an unsigned wrap into a huge
  // positive remainder.
  assert(EvaluateLastSurfaceGuard({1, 2, 0}) ==
         LastSurfaceVerdict::kInvalidCounts);
  assert(EvaluateLastSurfaceGuard({0, 0, 1}) ==
         LastSurfaceVerdict::kInvalidCounts);
}

void RegisteredInactiveIsRetriedBeforeIdentityIsBurned() {
  const auto view = MeasuredHostView();
  // First observation of inactive must ask for extend again, not self-heal:
  // generations are a bounded resource and macOS routinely parks a new display.
  assert(rd::DecideActivation(view, 1, 0) ==
         rd::ActivationDecision::kRequestExtend);
  assert(rd::DecideActivation(view, 1, 1) ==
         rd::ActivationDecision::kRequestExtend);
  assert(rd::DecideActivation(view, 1, rd::kVirtualDisplayMaxExtendAttempts) ==
         rd::ActivationDecision::kSelfHeal);
  assert(rd::DecideActivation(view, 5, 0) ==
         rd::ActivationDecision::kAlreadyActive);
  assert(rd::DecideActivation(view, 99, 0) == rd::ActivationDecision::kAbsent);
}

void SelfHealRefusesToCreateWhileTheOldIdIsStillRegistered() {
  auto view = MeasuredHostView();
  rd::SelfHealState state;
  assert(rd::NextSelfHealStep(state, view, 5) == rd::SelfHealStep::kMarkStale);
  state.marked_stale = true;
  assert(rd::NextSelfHealStep(state, view, 5) ==
         rd::SelfHealStep::kReleaseOldOwner);
  state.owner_released = true;
  // THE ordering rule: id 5 is still registered, so creating now would make two
  // stranded displays out of one. That is literally how 5 and 6 both exist.
  assert(rd::NextSelfHealStep(state, view, 5) ==
         rd::SelfHealStep::kBlockedOldIdPresent);
  // Claiming absence while enumeration still reports it must NOT unblock.
  state.old_id_absent = true;
  assert(rd::NextSelfHealStep(state, view, 5) ==
         rd::SelfHealStep::kBlockedOldIdPresent);
  // Only a truthful enumeration releases the block.
  view.registered_ids = {6, 1, 2, 3};
  view.online_ids = {6};
  assert(rd::NextSelfHealStep(state, view, 5) ==
         rd::SelfHealStep::kCreateNewIdentity);
  // Bounded: exhaustion is terminal and reported, never a wrap or a retry storm.
  state.identity_generation = 7;
  assert(rd::NextSelfHealStep(state, view, 5) == rd::SelfHealStep::kExhausted);
}

void SerialsEscapeCollisionAndNeverRepeatOrZero() {
  std::set<std::uint32_t> serials;
  for (std::uint32_t generation = 0; generation < 8; ++generation) {
    const std::uint32_t serial =
        rd::DeriveVirtualDisplaySerial(0xA1DE5C0DEULL, 0, generation);
    assert(serial != 0);  // zero is rejected by the private API
    assert(serials.insert(serial).second);  // every generation escapes
  }
  // Deterministic across restarts, so a warm display can be re-adopted.
  assert(rd::DeriveVirtualDisplaySerial(42, 0, 3) ==
         rd::DeriveVirtualDisplaySerial(42, 0, 3));
  // A different install must not collide with ours.
  assert(rd::DeriveVirtualDisplaySerial(42, 0, 0) !=
         rd::DeriveVirtualDisplaySerial(43, 0, 0));
  // Avalanche: adjacent generations must not land adjacent to the poisoned one.
  const std::uint32_t a = rd::DeriveVirtualDisplaySerial(42, 0, 0);
  const std::uint32_t b = rd::DeriveVirtualDisplaySerial(42, 0, 1);
  assert(a > b ? (a - b) > 16 : (b - a) > 16);
}

void IdentityKeepsBrandAndFailsClosedOnExhaustion() {
  const auto ok = rd::DeriveVirtualDisplayIdentity(42, 0, 0);
  assert(ok.IsValid());
  // Vendor/product stay fixed: that is how a leak audit attributes ids 5 and 6
  // back to aiDesk in the first place.
  assert(ok.vendor_id == 0x4149 && ok.product_id == 0x4445);
  // An unusable instance id must NOT yield a plausible identity.
  assert(!rd::DeriveVirtualDisplayIdentity(0, 0, 0).IsValid());
  assert(!rd::DeriveVirtualDisplayIdentity(42, 0, 8).IsValid());
  assert(!rd::DeriveVirtualDisplayIdentity(42, 9, 0).IsValid());
  assert(rd::CanAdvanceIdentityGeneration(6));
  assert(!rd::CanAdvanceIdentityGeneration(7));
}

void InstanceIdParsingRejectsAnythingPlausibleButWrong() {
  std::uint64_t value = 0;
  assert(rd::ParseInstanceId("12345\n", &value) && value == 12345);
  assert(rd::ParseInstanceId("7", &value) && value == 7);
  assert(!rd::ParseInstanceId("", &value));
  assert(!rd::ParseInstanceId("0\n", &value));       // zero is not an identity
  assert(!rd::ParseInstanceId("12 34", &value));
  assert(!rd::ParseInstanceId("-5", &value));
  assert(!rd::ParseInstanceId("0x1f", &value));
  assert(!rd::ParseInstanceId("99999999999999999999999", &value));  // overflow
  assert(!rd::ParseInstanceId(std::string(64, '1'), &value));       // bounded
}

void IdentityStoreIsSafeAgainstSymlinksAndWrongOwnership() {
  char directory[] = "/tmp/aidesk-vd-identity-XXXXXX";
  assert(mkdtemp(directory) != nullptr);
  const std::string base(directory);
  const std::string path = base + "/instance-id";

  // Created atomically and durably on first use.
  auto created = rd::LoadOrCreateInstanceId(path, 0xC0FFEEULL);
  assert(created.status == rd::IdentityStoreStatus::kCreated);
  assert(created.instance_id == 0xC0FFEEULL && created.usable());
  struct stat info {};
  assert(::stat(path.c_str(), &info) == 0);
  assert((info.st_mode & (S_IRWXG | S_IRWXO)) == 0);  // private mode enforced

  // Re-read is stable: the same identity must survive a restart, or a warm
  // display could never be re-adopted.
  auto loaded = rd::LoadOrCreateInstanceId(path, 0xDEADBEEFULL);
  assert(loaded.status == rd::IdentityStoreStatus::kLoaded);
  assert(loaded.instance_id == 0xC0FFEEULL);  // candidate must NOT override

  // A symlink at the path is a hard rejection, never followed.
  //
  // The target is deliberately a file WE own with private mode and valid
  // contents. An earlier version pointed the symlink at /etc/passwd, and
  // mutation testing proved that test vacuous: removing O_NOFOLLOW still
  // passed, because the root-owned target was caught by the ownership check
  // instead. Only a target that would otherwise be fully acceptable can prove
  // the symlink itself is what gets rejected.
  const std::string decoy = base + "/decoy";
  const int decoy_fd = ::open(decoy.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600);
  assert(decoy_fd >= 0);
  assert(::write(decoy_fd, "4242\n", 5) == 5);
  ::close(decoy_fd);
  auto decoy_ok = rd::LoadOrCreateInstanceId(decoy, 1);
  assert(decoy_ok.status == rd::IdentityStoreStatus::kLoaded);  // acceptable
  const std::string link = base + "/linked";
  assert(::symlink(decoy.c_str(), link.c_str()) == 0);
  auto linked = rd::LoadOrCreateInstanceId(link, 1);
  assert(linked.status == rd::IdentityStoreStatus::kRejected);
  assert(!linked.usable());

  // Group/world-accessible is rejected rather than trusted.
  const std::string loose = base + "/loose";
  const int fd = ::open(loose.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0644);
  assert(fd >= 0);
  assert(::write(fd, "99\n", 3) == 3);
  ::close(fd);
  auto rejected = rd::LoadOrCreateInstanceId(loose, 1);
  assert(rejected.status == rd::IdentityStoreStatus::kRejected);

  // Malformed contents must not be read as a plausible id: a wrong-but-valid
  // instance id silently changes the identity of a registered display.
  const std::string junk = base + "/junk";
  const int junk_fd = ::open(junk.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600);
  assert(junk_fd >= 0);
  assert(::write(junk_fd, "not-a-number", 12) == 12);
  ::close(junk_fd);
  auto malformed = rd::LoadOrCreateInstanceId(junk, 1);
  assert(malformed.status == rd::IdentityStoreStatus::kRejected);
  assert(!malformed.usable());

  ::unlink(path.c_str());
  ::unlink(link.c_str());
  ::unlink(decoy.c_str());
  ::unlink(loose.c_str());
  ::unlink(junk.c_str());
  ::rmdir(directory);
}

void InstanceIdPathComesFromTheUidNotTheEnvironment() {
  // The helper is spawned with an EMPTY environment, so it has no HOME. An
  // earlier version derived this path from HOME, which made every first HOLD
  // inside the helper fail with identity_store_unavailable -- a regression
  // introduced by the very fix that removed the environment. The uid the
  // verified binding carries is the non-ambient replacement.
  const auto mine = rd::InstanceIdPathForUid(static_cast<std::uint32_t>(::geteuid()));
  assert(!mine.empty() && mine.front() == '/');
  assert(mine.find("/Library/Application Support/aiDesk/") != std::string::npos);
  // Root owns no Aqua container, so it must not resolve one.
  assert(rd::InstanceIdPathForUid(0).empty());
  // A uid with no password-database entry is a refusal, not a guessed path.
  assert(rd::InstanceIdPathForUid(65533u).empty());
  assert(rd::InstanceIdPathForUid(31337u).empty());
  // Proving it is NOT reading the environment: clobbering HOME changes nothing.
  const char* previous = ::getenv("HOME");
  ::setenv("HOME", "/tmp/definitely-not-home", 1);
  assert(rd::InstanceIdPathForUid(static_cast<std::uint32_t>(::geteuid())) == mine);
  if (previous != nullptr) ::setenv("HOME", previous, 1);
}

void IdentityGenerationSurvivesARestart() {
  // Holding the generation only in memory means a helper that already walked
  // past a poisoned identity restarts at zero and walks straight back into it.
  char directory[] = "/tmp/aidesk-vd-generation-XXXXXX";
  assert(mkdtemp(directory) != nullptr);
  const std::string path = std::string(directory) + "/generation";

  // Absent file reads as generation 0, not as an error to guess around.
  assert(rd::LoadIdentityGeneration(path) == 0);
  assert(rd::StoreIdentityGeneration(path, 3));
  assert(rd::LoadIdentityGeneration(path) == 3);
  // Durable across a "restart": a fresh read sees the same value.
  assert(rd::LoadIdentityGeneration(path) == 3);
  // Generation 0 is represented by absence, because the shared parser rejects
  // a literal zero.
  assert(rd::StoreIdentityGeneration(path, 0));
  assert(rd::LoadIdentityGeneration(path) == 0);
  // Out of range is refused rather than clamped: clamping to the maximum would
  // silently spend the whole budget.
  assert(!rd::StoreIdentityGeneration(path, 8));
  assert(!rd::StoreIdentityGeneration(path, 99));
  assert(!rd::StoreIdentityGeneration("", 2));

  // A group-readable file is not trusted, exactly like the instance id.
  const std::string loose = std::string(directory) + "/loose";
  const int fd = ::open(loose.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0644);
  assert(fd >= 0);
  assert(::write(fd, "4\n", 2) == 2);
  ::close(fd);
  assert(rd::LoadIdentityGeneration(loose) == 0);
  ::unlink(loose.c_str());
  ::unlink(path.c_str());
  ::rmdir(directory);
}

void PersistedIntentCarriesNoRuntimeState() {
  rd::PersistedDisplayIntent intent;
  intent.device_id = "device-1";
  intent.slot = 0;
  intent.pixels_wide = 1920;
  intent.pixels_high = 1080;
  intent.hidpi = true;
  intent.identity_generation = 2;
  assert(rd::PersistedIntentIsRuntimeFree(intent));
  // Bounds are refusals, not clamps.
  intent.pixels_wide = 9000;
  assert(!intent.IsValid());
}

}  // namespace

int main() {
  ThreeStateIsNotTwoState();
  LastSurfaceGuardRefusesToStrandTheSession();
  RegisteredInactiveIsRetriedBeforeIdentityIsBurned();
  SelfHealRefusesToCreateWhileTheOldIdIsStillRegistered();
  SerialsEscapeCollisionAndNeverRepeatOrZero();
  IdentityKeepsBrandAndFailsClosedOnExhaustion();
  InstanceIdParsingRejectsAnythingPlausibleButWrong();
  IdentityStoreIsSafeAgainstSymlinksAndWrongOwnership();
  InstanceIdPathComesFromTheUidNotTheEnvironment();
  IdentityGenerationSurvivesARestart();
  PersistedIntentCarriesNoRuntimeState();
  std::printf("macos virtual display policy counterfactual ok\n");
  return 0;
}
