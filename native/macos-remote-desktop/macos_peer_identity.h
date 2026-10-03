#ifndef IMCODES_NATIVE_MACOS_REMOTE_DESKTOP_MACOS_PEER_IDENTITY_H_
#define IMCODES_NATIVE_MACOS_REMOTE_DESKTOP_MACOS_PEER_IDENTITY_H_

#include <sys/types.h>

#include <bsm/audit.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

namespace imcodes::remote_desktop::macos {

inline constexpr std::size_t kMacosPeerBundleIdentifierMaxBytes = 255;
inline constexpr std::size_t kMacosPeerTeamIdBytes = 10;
inline constexpr std::size_t kMacosPeerDesignatedRequirementMaxBytes = 1024;
inline constexpr std::size_t kMacosPeerAuditTokenBytes = 32;

enum class MacosPeerIdentityErrorCode : std::uint8_t {
  kNone = 0,
  kInvalidArgument,
  kPeerCredentialsUnavailable,
  kPeerCredentialsMismatch,
  kPeerProcessUnavailable,
  kSecurityGuestUnavailable,
  kSecurityRequirementInvalid,
  kSecurityValidationFailed,
  kSigningInformationUnavailable,
  kCodeIdentityMismatch,
};

struct MacosPeerIdentityError {
  MacosPeerIdentityErrorCode code = MacosPeerIdentityErrorCode::kNone;
  int system_error = 0;
  std::int32_t security_status = 0;
};

struct MacosExpectedPeerIdentity {
  uid_t uid = 0;
  /**
   * Audit session the peer must be in. Zero means "any".
   *
   * Not decoration: uid alone cannot tell two successive login windows of the
   * SAME user apart, so a capability bound only to uid survives a logout and
   * applies to the next session. The audit session id is what distinguishes
   * them.
   */
  au_asid_t audit_session_id = 0;
  std::string bundle_identifier;
  std::string team_id;
  std::string designated_requirement;
};

/**
 * Kernel-owned identity captured from a connected AF_UNIX socket. The audit
 * token is opaque evidence and must never be populated from IPC JSON.
 */
struct MacosKernelPeerIdentity {
  uid_t uid = 0;
  gid_t gid = 0;
  pid_t pid = 0;
  /**
   * Audit session id, decoded from the token rather than asked for separately.
   *
   * The token is the kernel's single coherent statement about the peer; taking
   * one field from it and another from a different syscall would let the two
   * describe different processes.
   */
  au_asid_t audit_session_id = 0;
  /**
   * Process-id VERSION, which is what makes a pid an identity.
   *
   * A pid is reused. Without this, a peer that exits and a new process that
   * lands on the same pid are indistinguishable -- and on a busy machine that
   * is not a remote possibility, it is a matter of time.
   */
  int pid_version = 0;
  std::array<std::uint8_t, kMacosPeerAuditTokenBytes> audit_token{};
};

struct MacosVerifiedPeerIdentity {
  uid_t uid = 0;
  gid_t gid = 0;
  pid_t pid = 0;
  /** Surfaced so a caller can BIND a capability to this exact session. */
  au_asid_t audit_session_id = 0;
  int pid_version = 0;
  std::string bundle_identifier;
  std::string team_id;
  std::string designated_requirement;
};

struct MacosVerifiedCodeIdentity {
  std::string bundle_identifier;
  std::string team_id;
  std::string designated_requirement;
};

/**
 * Injectable only at the native Security.framework seam. Socket uid, gid,
 * pid and audit-token evidence always comes from Darwin kernel APIs.
 */
class MacosPeerCodeIdentityValidator {
public:
  virtual ~MacosPeerCodeIdentityValidator() = default;

  virtual bool Verify(const MacosKernelPeerIdentity &peer,
                      const MacosExpectedPeerIdentity &expected,
                      MacosVerifiedCodeIdentity *verified,
                      MacosPeerIdentityError *error) noexcept = 0;
};

/**
 * Authenticates one connected AF_UNIX socket peer with getpeereid,
 * LOCAL_PEERCRED/LOCAL_PEERTOKEN and Security.framework. Returns no partial
 * identity on failure.
 */
bool AuthenticateMacosRemoteDesktopPeer(
    int socket_fd, const MacosExpectedPeerIdentity &expected,
    MacosVerifiedPeerIdentity *verified,
    MacosPeerIdentityError *error) noexcept;

namespace testing {

/**
 * Test seam for Security.framework outcomes. It deliberately does not permit
 * callers to inject or override kernel socket credentials.
 */
bool AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
    int socket_fd, const MacosExpectedPeerIdentity &expected,
    MacosPeerCodeIdentityValidator &validator,
    MacosVerifiedPeerIdentity *verified,
    MacosPeerIdentityError *error) noexcept;

} // namespace testing

} // namespace imcodes::remote_desktop::macos

#endif // IMCODES_NATIVE_MACOS_REMOTE_DESKTOP_MACOS_PEER_IDENTITY_H_
