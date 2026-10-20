#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_GATEWAY_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_GATEWAY_H_

#include <cstdint>
#include <optional>
#include <string>

#include "macos_auto_unlock_authority.h"
#include "macos_auto_unlock_paths.h"

namespace imcodes::remote_desktop::macos {

/**
 * Local enrolment. Policy and the ACL's designated requirement ONLY.
 *
 * There is deliberately no credential field. The secret lives exclusively in the
 * file-based System keychain under an ACL naming the plug-in, so it never enters
 * this record, the authority store, daemon/Server/browser messages, argv or the
 * environment.
 */
struct AutoUnlockEnrollment {
  /** kAutoUnlockPolicy* ; absent enrolment reads as `disabled`. */
  std::string policy;
  std::string designated_requirement;
};

/** Diagnostic written to stderr when a locked, enrolled session did not get an
 *  authority. Named so tests assert an exact failure class, not prose. */
inline constexpr char kDiagAutoUnlockNotIssued[] =
    "macos_remote_desktop_worker_auto_unlock_not_issued";

enum class AutoUnlockGatewayStatus {
  kIssued,
  kSkippedNotEnrolled,
  kSkippedPolicyDisabled,
  /** Policy is loginwindow_only and this surface is an unlocked session. */
  kSkippedSurfaceNotPermitted,
  kSkippedNotLocked,
  kSkippedIncompleteBinding,
  kFailedIssue,
};

struct AutoUnlockGatewayResult {
  AutoUnlockGatewayStatus status = AutoUnlockGatewayStatus::kSkippedNotEnrolled;
  std::string path;

  [[nodiscard]] bool issued() const noexcept {
    return status == AutoUnlockGatewayStatus::kIssued;
  }
};

/** What the worker can see about the session at the moment a route is prepared. */
struct AutoUnlockGatewayObservation {
  std::string local_user_name;
  std::uint32_t local_user_uid = 0;
  std::uint32_t audit_session_id = 0;
  std::string session_type;
  std::uint64_t worker_generation = 0;
  std::uint64_t route_generation = 0;
  bool locked = false;
  /** kAutoUnlockSurface* -- which security surface is asking. */
  std::string surface;
};

[[nodiscard]] bool WriteAutoUnlockEnrollment(const std::string& base_directory,
                                             std::uint32_t uid,
                                             const AutoUnlockEnrollment& enrollment,
                                             AutoUnlockStoreIdentity identity);
/** Missing or unreadable enrolment yields an empty policy, i.e. disabled. */
[[nodiscard]] AutoUnlockEnrollment ReadAutoUnlockEnrollment(
    const std::string& base_directory, std::uint32_t uid,
    AutoUnlockStoreIdentity identity);

/**
 * Narrows a signalling route generation to the gateway's binding, fail-closed.
 *
 * `rd::Authority::route_generation` is `std::optional<std::int64_t>`, and its own
 * header notes that a MISSING value stays parseable only for legacy v2
 * authenticated access which "is never eligible for management-privacy ACK".
 * That is precisely the population auto unlock must not serve, so absent,
 * non-positive and out-of-range values all refuse. There is deliberately no
 * `value_or` fallback: substituting 0 or 1 would mint an authority bound to a
 * route that never existed, and the plug-in has no way to tell the difference.
 *
 * Returns false and leaves *out untouched on refusal.
 */
[[nodiscard]] bool ResolveAutoUnlockRouteGeneration(
    const std::optional<std::int64_t>& raw, std::uint64_t* out);

/** Cryptographically random, hex, bounded. */
[[nodiscard]] std::string GenerateAutoUnlockNonce();

/**
 * The production decision: should this route mint a one-shot authority, and if
 * so, mint it.
 *
 * Called by the worker as root when a route is prepared. Every refusal is a
 * distinct status so a silent skip cannot be mistaken for a failed issue.
 */
[[nodiscard]] AutoUnlockGatewayResult RunAutoUnlockGateway(
    const AutoUnlockGatewayObservation& observation, std::int64_t now_ms,
    const std::string& nonce, const std::string& base_directory,
    AutoUnlockStoreIdentity identity);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_GATEWAY_H_
