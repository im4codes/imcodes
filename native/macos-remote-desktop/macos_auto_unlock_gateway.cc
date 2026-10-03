#include "macos_auto_unlock_gateway.h"

#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <sstream>
#include <vector>

#include "macos_auto_unlock_controller.h"
#include "macos_auto_unlock_issuer.h"
#include "macos_auto_unlock_paths.h"
#include "macos_auto_unlock_provision.h"
#include "macos_auto_unlock_record_io.h"

namespace imcodes::remote_desktop::macos {
namespace {

constexpr char kEnrollmentVersion[] = "aidesk-auto-unlock-enrollment-v1";
constexpr char kSeparator = '\n';
constexpr std::size_t kEnrollmentMaxBytes = 4 * 1024;
/** 16 bytes of entropy, hex-encoded. */
constexpr std::size_t kNonceEntropyBytes = 16;

std::string EnrollmentPath(const std::string& base_directory,
                           std::uint32_t uid) {
  return base_directory + "/enrollment-" + std::to_string(uid);
}

}  // namespace

bool WriteAutoUnlockEnrollment(const std::string& base_directory,
                               std::uint32_t uid,
                               const AutoUnlockEnrollment& enrollment,
                               AutoUnlockStoreIdentity identity) {
  if (uid == 0 || !identity.privileged()) return false;
  if (enrollment.policy.find(kSeparator) != std::string::npos ||
      enrollment.designated_requirement.find(kSeparator) != std::string::npos) {
    return false;
  }
  if (!ProvisionAutoUnlockStateDirectory(base_directory, identity)
           .provisioned()) {
    return false;
  }
  const std::string rendered = std::string(kEnrollmentVersion) + kSeparator +
                               enrollment.policy + kSeparator +
                               enrollment.designated_requirement;
  if (rendered.size() > kEnrollmentMaxBytes) return false;
  return WriteAutoUnlockRecordAtomically(EnrollmentPath(base_directory, uid),
                                         rendered);
}

AutoUnlockEnrollment ReadAutoUnlockEnrollment(const std::string& base_directory,
                                              std::uint32_t uid,
                                              AutoUnlockStoreIdentity identity) {
  AutoUnlockEnrollment enrollment;
  if (uid == 0) return enrollment;
  const std::string contents = ReadValidatedAutoUnlockRecord(
      EnrollmentPath(base_directory, uid), identity.required_owner_uid,
      kEnrollmentMaxBytes);
  if (contents.empty()) return enrollment;

  std::vector<std::string> fields;
  std::string field;
  std::istringstream in(contents);
  while (std::getline(in, field, kSeparator)) fields.push_back(field);
  // A malformed enrolment stays disabled. Guessing at a partial record could
  // enable auto unlock the operator never actually configured.
  if (fields.size() != 3 || fields[0] != kEnrollmentVersion) return enrollment;
  enrollment.policy = fields[1];
  enrollment.designated_requirement = fields[2];
  return enrollment;
}

bool ResolveAutoUnlockRouteGeneration(const std::optional<std::int64_t>& raw,
                                      std::uint64_t* out) {
  if (out == nullptr || !raw.has_value()) return false;
  // Zero is the gateway's "unbound" sentinel and negatives cannot be a route
  // epoch; both would otherwise widen into a huge or meaningless uint64.
  if (*raw <= 0) return false;
  *out = static_cast<std::uint64_t>(*raw);
  return true;
}

std::string GenerateAutoUnlockNonce() {
  unsigned char entropy[kNonceEntropyBytes] = {};
  // arc4random_buf cannot fail and needs no seeding, so there is no path where
  // a weak or predictable nonce is silently produced.
  ::arc4random_buf(entropy, sizeof(entropy));
  std::string hex;
  hex.reserve(sizeof(entropy) * 2);
  static constexpr char kDigits[] = "0123456789abcdef";
  for (unsigned char byte : entropy) {
    hex.push_back(kDigits[(byte >> 4) & 0x0F]);
    hex.push_back(kDigits[byte & 0x0F]);
  }
  return hex;
}

AutoUnlockGatewayResult RunAutoUnlockGateway(
    const AutoUnlockGatewayObservation& observation, std::int64_t now_ms,
    const std::string& nonce, const std::string& base_directory,
    AutoUnlockStoreIdentity identity) {
  AutoUnlockGatewayResult result;

  // Nothing to unlock. Checked before enrolment is even read so an unlocked
  // session leaves no trace in the store.
  if (!observation.locked) {
    result.status = AutoUnlockGatewayStatus::kSkippedNotLocked;
    return result;
  }
  if (observation.local_user_uid == 0 || observation.audit_session_id == 0 ||
      observation.local_user_name.empty() || observation.session_type.empty() ||
      observation.worker_generation == 0 || observation.route_generation == 0 ||
      observation.surface.empty() || nonce.empty()) {
    result.status = AutoUnlockGatewayStatus::kSkippedIncompleteBinding;
    return result;
  }

  const AutoUnlockEnrollment enrollment =
      ReadAutoUnlockEnrollment(base_directory, observation.local_user_uid,
                               identity);
  if (enrollment.policy.empty() ||
      enrollment.designated_requirement.empty()) {
    result.status = AutoUnlockGatewayStatus::kSkippedNotEnrolled;
    return result;
  }
  if (enrollment.policy == kAutoUnlockPolicyDisabled) {
    result.status = AutoUnlockGatewayStatus::kSkippedPolicyDisabled;
    return result;
  }
  // loginwindow_only must not mint an authority for a merely locked Aqua
  // session; `always` covers both surfaces.
  if (enrollment.policy == kAutoUnlockPolicyLoginWindowOnly &&
      observation.surface != kAutoUnlockSurfaceLoginWindow) {
    result.status = AutoUnlockGatewayStatus::kSkippedSurfaceNotPermitted;
    return result;
  }
  if (enrollment.policy != kAutoUnlockPolicyLoginWindowOnly &&
      enrollment.policy != kAutoUnlockPolicyAlways) {
    // An unrecognised policy is not a permissive one.
    result.status = AutoUnlockGatewayStatus::kSkippedPolicyDisabled;
    return result;
  }

  AutoUnlockAuthority authority;
  authority.policy = enrollment.policy;
  authority.surface = observation.surface;
  authority.designated_requirement = enrollment.designated_requirement;
  authority.enrolled.local_user_name = observation.local_user_name;
  authority.enrolled.local_user_uid = observation.local_user_uid;
  authority.enrolled.session_type = observation.session_type;
  authority.enrolled.audit_session_id = observation.audit_session_id;
  authority.enrolled.worker_generation = observation.worker_generation;
  authority.route_generation = observation.route_generation;
  authority.nonce = nonce;
  authority.issued_at_ms = now_ms;
  // Short by construction: an authority that outlives the moment it was minted
  // for is an authority someone else can spend.
  authority.expires_at_ms = now_ms + kAutoUnlockAuthorityMaxLifetimeMs;

  const AutoUnlockIssueResult issued =
      IssueAutoUnlockAuthority(authority, base_directory, identity);
  if (!issued.issued()) {
    result.status = AutoUnlockGatewayStatus::kFailedIssue;
    return result;
  }
  result.status = AutoUnlockGatewayStatus::kIssued;
  result.path = issued.path;
  return result;
}

}  // namespace imcodes::remote_desktop::macos
