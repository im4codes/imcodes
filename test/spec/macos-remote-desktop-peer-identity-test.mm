#include "macos_peer_identity.h"

#include <sys/socket.h>
#include <bsm/audit_session.h>
#include <unistd.h>

#include <cstdlib>
#include <iostream>
#include <string>

namespace macos = imcodes::remote_desktop::macos;

namespace {

constexpr char kBundleIdentifier[] = "cc.imcodes.node.remote-desktop-agent";
constexpr char kTeamId[] = "ABCDE12345";

void Require(bool condition, const char *message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
  }
}

macos::MacosExpectedPeerIdentity Expected(uid_t uid) {
  return {
      .uid = uid,
      .bundle_identifier = kBundleIdentifier,
      .team_id = kTeamId,
      .designated_requirement =
          std::string("identifier \"") + kBundleIdentifier +
          "\" and anchor apple generic and certificate leaf[subject.OU] = \"" +
          kTeamId + "\"",
  };
}

class FakeCodeValidator final : public macos::MacosPeerCodeIdentityValidator {
public:
  bool Verify(const macos::MacosKernelPeerIdentity &peer,
              const macos::MacosExpectedPeerIdentity &expected,
              macos::MacosVerifiedCodeIdentity *verified,
              macos::MacosPeerIdentityError *error) noexcept override {
    ++calls;
    observed_pid = peer.pid;
    observed_uid = peer.uid;
    bool has_token_byte = false;
    for (const std::uint8_t byte : peer.audit_token) {
      has_token_byte = has_token_byte || byte != 0;
    }
    observed_nonempty_audit_token = has_token_byte;
    if (!succeeds) {
      if (error != nullptr) {
        error->code =
            macos::MacosPeerIdentityErrorCode::kSecurityValidationFailed;
        error->security_status = -67050;
      }
      return false;
    }
    verified->bundle_identifier = wrong_bundle
                                      ? "cc.attacker.remote-desktop-agent"
                                      : expected.bundle_identifier;
    verified->team_id = expected.team_id;
    verified->designated_requirement = expected.designated_requirement;
    return true;
  }

  bool succeeds = true;
  bool wrong_bundle = false;
  bool observed_nonempty_audit_token = false;
  uid_t observed_uid = 0;
  pid_t observed_pid = 0;
  int calls = 0;
};

class SocketPair {
public:
  SocketPair() {
    Require(socketpair(AF_UNIX, SOCK_STREAM, 0, fds_) == 0,
            "socketpair is available");
  }
  ~SocketPair() {
    close(fds_[0]);
    close(fds_[1]);
  }
  int server() const { return fds_[0]; }

private:
  int fds_[2] = {-1, -1};
};

} // namespace

int main() {
  const uid_t uid = geteuid();
  SocketPair sockets;

  if (uid != 0) {
    FakeCodeValidator validator;
    macos::MacosVerifiedPeerIdentity verified;
    macos::MacosPeerIdentityError error;
    Require(macos::testing::AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
                sockets.server(), Expected(uid), validator, &verified, &error),
            "real kernel credentials plus matching code identity authenticate");
    Require(validator.calls == 1 && validator.observed_uid == uid &&
                validator.observed_pid == getpid() &&
                validator.observed_nonempty_audit_token,
            "validator receives kernel-owned uid, pid and audit token");
    Require(verified.uid == uid && verified.pid == getpid() &&
                verified.bundle_identifier == kBundleIdentifier &&
                verified.team_id == kTeamId &&
                error.code == macos::MacosPeerIdentityErrorCode::kNone,
            "successful authentication returns only verified evidence");

    // AUDIT SESSION. uid alone cannot tell two successive login windows of the
    // same user apart, so a capability bound only to uid survives a logout and
    // applies to the next session. The session id is what distinguishes them,
    // and it must be decoded from the SAME audit token that was cross-checked
    // against getpeereid/LOCAL_PEERCRED/LOCAL_PEERPID -- taking one field from
    // the token and another from a separate syscall would let the two describe
    // different processes.
    auditinfo_addr_t own_audit = {};
    Require(getaudit_addr(&own_audit, sizeof(own_audit)) == 0,
            "this process has an audit session to compare against");
    Require(verified.audit_session_id == own_audit.ai_asid &&
                verified.audit_session_id != 0,
            "the verified peer carries the kernel's audit session id");
    // pidversion is what makes a pid an identity: pids are reused, and on a
    // busy machine that is a matter of time rather than a remote possibility.
    Require(verified.pid_version != 0,
            "the verified peer carries a process-id version");

    {
      // A caller that NAMES a session gets that session.
      FakeCodeValidator session_validator;
      macos::MacosExpectedPeerIdentity expected = Expected(uid);
      expected.audit_session_id = own_audit.ai_asid;
      macos::MacosVerifiedPeerIdentity session_verified;
      Require(
          macos::testing::AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
              sockets.server(), expected, session_validator, &session_verified,
              &error),
          "naming this peer's own audit session authenticates");

      // ...and a caller that names a DIFFERENT session is refused, even though
      // the uid, the code identity and the requirement all still match. This is
      // the same-user-different-login-window case.
      FakeCodeValidator stale_validator;
      macos::MacosExpectedPeerIdentity stale = Expected(uid);
      stale.audit_session_id =
          own_audit.ai_asid == 1 ? 2 : own_audit.ai_asid - 1;
      macos::MacosVerifiedPeerIdentity stale_verified = {.uid = 999};
      Require(
          !macos::testing::AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
              sockets.server(), stale, stale_validator, &stale_verified,
              &error),
          "a stale audit session fails closed");
      Require(stale_validator.calls == 0 && stale_verified.uid == 0 &&
                  error.code ==
                      macos::MacosPeerIdentityErrorCode::kPeerCredentialsMismatch,
              "session rejection happens before code validation, no partial output");
    }

    FakeCodeValidator wrong_uid_validator;
    verified = {.uid = 999};
    const uid_t other_uid = uid == 1 ? 2 : 1;
    Require(
        !macos::testing::AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
            sockets.server(), Expected(other_uid), wrong_uid_validator,
            &verified, &error),
        "wrong uid fails closed");
    Require(
        wrong_uid_validator.calls == 0 && verified.uid == 0 &&
            error.code ==
                macos::MacosPeerIdentityErrorCode::kPeerCredentialsMismatch,
        "uid rejection happens before code validation without partial output");

    FakeCodeValidator attacker;
    attacker.wrong_bundle = true;
    Require(
        !macos::testing::AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
            sockets.server(), Expected(uid), attacker, &verified, &error),
        "a validator cannot widen the expected identity");
    Require(verified.uid == 0 &&
                error.code ==
                    macos::MacosPeerIdentityErrorCode::kCodeIdentityMismatch,
            "identity mismatch returns no partial authority");

    FakeCodeValidator rejected;
    rejected.succeeds = false;
    Require(
        !macos::testing::AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
            sockets.server(), Expected(uid), rejected, &verified, &error),
        "Security.framework rejection remains terminal");
    Require(
        error.code ==
                macos::MacosPeerIdentityErrorCode::kSecurityValidationFailed &&
            error.security_status == -67050 && verified.uid == 0,
        "security status is diagnostic only and grants no authority");

    Require(!macos::AuthenticateMacosRemoteDesktopPeer(
                sockets.server(), Expected(uid), &verified, &error),
            "the non-production-signed test process fails the real Security "
            "boundary");
    Require(verified.uid == 0 &&
                error.code != macos::MacosPeerIdentityErrorCode::kNone,
            "real Security rejection returns no claimed identity");
  } else {
    FakeCodeValidator validator;
    macos::MacosVerifiedPeerIdentity verified;
    macos::MacosPeerIdentityError error;
    Require(
        !macos::testing::AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
            sockets.server(), Expected(uid), validator, &verified, &error),
        "root peers are never accepted as GUI LaunchAgents");
    Require(validator.calls == 0,
            "root rejection occurs before code-signature validation");
  }

  {
    FakeCodeValidator validator;
    macos::MacosVerifiedPeerIdentity verified;
    macos::MacosPeerIdentityError error;
    auto invalid = Expected(uid == 0 ? 501 : uid);
    invalid.team_id = "abc";
    Require(
        !macos::testing::AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
            sockets.server(), invalid, validator, &verified, &error),
        "malformed Team ID is rejected before system inspection");
    invalid = Expected(uid == 0 ? 501 : uid);
    invalid.bundle_identifier.assign(
        macos::kMacosPeerBundleIdentifierMaxBytes + 1, 'a');
    Require(
        !macos::testing::AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
            sockets.server(), invalid, validator, &verified, &error),
        "oversized bundle identifier is rejected");
    invalid = Expected(uid == 0 ? 501 : uid);
    invalid.designated_requirement.append(
        macos::kMacosPeerDesignatedRequirementMaxBytes, 'x');
    Require(
        !macos::testing::AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
            sockets.server(), invalid, validator, &verified, &error),
        "oversized designated requirement is rejected");
    Require(validator.calls == 0 && verified.uid == 0 &&
                error.code ==
                    macos::MacosPeerIdentityErrorCode::kInvalidArgument,
            "invalid expected strings never reach the code validator");
  }

  {
    FakeCodeValidator validator;
    macos::MacosVerifiedPeerIdentity verified;
    macos::MacosPeerIdentityError error;
    Require(
        !macos::testing::AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
            -1, Expected(uid == 0 ? 501 : uid), validator, &verified, &error),
        "invalid file descriptors fail closed");
    Require(validator.calls == 0 && verified.uid == 0 &&
                error.code ==
                    macos::MacosPeerIdentityErrorCode::kInvalidArgument,
            "invalid descriptor grants no partial identity");
  }

  std::cout << "macOS remote-desktop peer identity tests passed\n";
  return 0;
}
