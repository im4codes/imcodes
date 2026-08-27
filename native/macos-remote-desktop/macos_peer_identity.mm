#include "macos_peer_identity.h"

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <bsm/libbsm.h>
#include <cerrno>
#include <cstring>
#include <mach/message.h>
#include <sys/socket.h>
#include <sys/ucred.h>
#include <sys/un.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <string>

namespace imcodes::remote_desktop::macos {
namespace {

static_assert(sizeof(audit_token_t) == kMacosPeerAuditTokenBytes,
              "Darwin audit-token size changed");

template <typename T> class ScopedCfRef {
public:
  ScopedCfRef() = default;
  explicit ScopedCfRef(T value) : value_(value) {}
  ~ScopedCfRef() {
    if (value_ != nullptr) {
      CFRelease(value_);
    }
  }

  ScopedCfRef(const ScopedCfRef &) = delete;
  ScopedCfRef &operator=(const ScopedCfRef &) = delete;

  T get() const { return value_; }
  T *out() { return &value_; }

private:
  T value_ = nullptr;
};

void ResetOutput(MacosVerifiedPeerIdentity *verified,
                 MacosPeerIdentityError *error) {
  if (verified != nullptr) {
    *verified = {};
  }
  if (error != nullptr) {
    *error = {};
  }
}

bool Fail(MacosPeerIdentityErrorCode code, MacosPeerIdentityError *error,
          int system_error = 0, OSStatus security_status = errSecSuccess) {
  if (error != nullptr) {
    error->code = code;
    error->system_error = system_error;
    error->security_status = security_status;
  }
  return false;
}

bool IsBundleIdentifier(const std::string &value) {
  if (value.empty() || value.size() > kMacosPeerBundleIdentifierMaxBytes ||
      value.front() == '.' || value.back() == '.') {
    return false;
  }
  bool saw_dot = false;
  bool previous_dot = false;
  for (const unsigned char character : value) {
    if (character == '.') {
      if (previous_dot) {
        return false;
      }
      saw_dot = true;
      previous_dot = true;
      continue;
    }
    previous_dot = false;
    if (!std::isalnum(character) && character != '-') {
      return false;
    }
  }
  return saw_dot;
}

bool IsTeamId(const std::string &value) {
  return value.size() == kMacosPeerTeamIdBytes &&
         std::all_of(value.begin(), value.end(), [](unsigned char character) {
           return (character >= 'A' && character <= 'Z') ||
                  (character >= '0' && character <= '9');
         });
}

bool IsExpectedIdentityValid(const MacosExpectedPeerIdentity &expected) {
  if (expected.uid == 0 || !IsBundleIdentifier(expected.bundle_identifier) ||
      !IsTeamId(expected.team_id) || expected.designated_requirement.empty() ||
      expected.designated_requirement.size() >
          kMacosPeerDesignatedRequirementMaxBytes ||
      expected.designated_requirement.find('\0') != std::string::npos) {
    return false;
  }
  const std::string canonical_requirement =
      "identifier \"" + expected.bundle_identifier +
      "\" and anchor apple generic and certificate leaf[subject.OU] = \"" +
      expected.team_id + "\"";
  return expected.designated_requirement == canonical_requirement;
}

bool SameKernelPeer(const MacosKernelPeerIdentity &left,
                    const MacosKernelPeerIdentity &right) {
  // The audit-token byte comparison already subsumes the decoded fields, and
  // they are still compared by name. That is not redundancy for its own sake:
  // if the token comparison were ever relaxed -- to tolerate a field that
  // "obviously does not matter" -- these named checks are what would keep the
  // session and the process generation pinned.
  return left.uid == right.uid && left.gid == right.gid &&
         left.pid == right.pid &&
         left.audit_session_id == right.audit_session_id &&
         left.pid_version == right.pid_version &&
         left.audit_token == right.audit_token;
}

bool ReadKernelPeerIdentity(int socket_fd, MacosKernelPeerIdentity *peer,
                            MacosPeerIdentityError *error) {
  if (socket_fd < 0 || peer == nullptr) {
    return Fail(MacosPeerIdentityErrorCode::kInvalidArgument, error);
  }

  uid_t peer_uid = 0;
  gid_t peer_gid = 0;
  if (getpeereid(socket_fd, &peer_uid, &peer_gid) != 0) {
    return Fail(MacosPeerIdentityErrorCode::kPeerCredentialsUnavailable, error,
                errno);
  }

  xucred credentials{};
  socklen_t credentials_length = sizeof(credentials);
  if (getsockopt(socket_fd, SOL_LOCAL, LOCAL_PEERCRED, &credentials,
                 &credentials_length) != 0 ||
      credentials_length != sizeof(credentials) ||
      credentials.cr_version != XUCRED_VERSION || credentials.cr_ngroups <= 0 ||
      credentials.cr_ngroups > NGROUPS) {
    return Fail(MacosPeerIdentityErrorCode::kPeerCredentialsUnavailable, error,
                errno);
  }

  pid_t peer_pid = 0;
  socklen_t pid_length = sizeof(peer_pid);
  if (getsockopt(socket_fd, SOL_LOCAL, LOCAL_PEERPID, &peer_pid, &pid_length) !=
          0 ||
      pid_length != sizeof(peer_pid) || peer_pid <= 0) {
    return Fail(MacosPeerIdentityErrorCode::kPeerProcessUnavailable, error,
                errno);
  }

  audit_token_t audit_token{};
  socklen_t token_length = sizeof(audit_token);
  if (getsockopt(socket_fd, SOL_LOCAL, LOCAL_PEERTOKEN, &audit_token,
                 &token_length) != 0 ||
      token_length != sizeof(audit_token)) {
    return Fail(MacosPeerIdentityErrorCode::kPeerCredentialsUnavailable, error,
                errno);
  }

  if (peer_uid == 0 || credentials.cr_uid != peer_uid ||
      credentials.cr_groups[0] != peer_gid ||
      audit_token_to_euid(audit_token) != peer_uid ||
      audit_token_to_egid(audit_token) != peer_gid ||
      audit_token_to_pid(audit_token) != peer_pid) {
    return Fail(MacosPeerIdentityErrorCode::kPeerCredentialsMismatch, error);
  }

  peer->uid = peer_uid;
  peer->gid = peer_gid;
  peer->pid = peer_pid;
  // Decoded from the SAME token that was just cross-checked against
  // getpeereid/LOCAL_PEERCRED/LOCAL_PEERPID, so every field describes one
  // process at one moment.
  peer->audit_session_id = audit_token_to_asid(audit_token);
  peer->pid_version = audit_token_to_pidversion(audit_token);
  if (peer->audit_session_id == 0 || peer->audit_session_id == AU_DEFAUDITSID) {
    // No audit session means nothing can be bound to it, and a capability that
    // cannot be bound to a session is one that survives the session.
    return Fail(MacosPeerIdentityErrorCode::kPeerCredentialsMismatch, error);
  }
  std::memcpy(peer->audit_token.data(), &audit_token, sizeof(audit_token));
  return true;
}

bool CopyBoundedCfString(CFStringRef value, std::size_t max_bytes,
                         std::string *output) {
  if (value == nullptr || output == nullptr) {
    return false;
  }
  std::string buffer(max_bytes + 1, '\0');
  if (!CFStringGetCString(value, buffer.data(), buffer.size(),
                          kCFStringEncodingUTF8)) {
    return false;
  }
  buffer.resize(std::strlen(buffer.c_str()));
  if (buffer.empty() || buffer.size() > max_bytes) {
    return false;
  }
  *output = std::move(buffer);
  return true;
}

class SecurityFrameworkCodeValidator final
    : public MacosPeerCodeIdentityValidator {
public:
  bool Verify(const MacosKernelPeerIdentity &peer,
              const MacosExpectedPeerIdentity &expected,
              MacosVerifiedCodeIdentity *verified,
              MacosPeerIdentityError *error) noexcept override {
    if (verified == nullptr) {
      return Fail(MacosPeerIdentityErrorCode::kInvalidArgument, error);
    }
    *verified = {};

    ScopedCfRef<CFDataRef> audit_data(CFDataCreate(
        kCFAllocatorDefault, peer.audit_token.data(), peer.audit_token.size()));
    if (audit_data.get() == nullptr) {
      return Fail(MacosPeerIdentityErrorCode::kSecurityGuestUnavailable, error);
    }
    const void *keys[] = {kSecGuestAttributeAudit};
    const void *values[] = {audit_data.get()};
    ScopedCfRef<CFDictionaryRef> attributes(CFDictionaryCreate(
        kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks));
    if (attributes.get() == nullptr) {
      return Fail(MacosPeerIdentityErrorCode::kSecurityGuestUnavailable, error);
    }

    ScopedCfRef<SecCodeRef> guest;
    OSStatus status = SecCodeCopyGuestWithAttributes(
        nullptr, attributes.get(), kSecCSDefaultFlags, guest.out());
    if (status != errSecSuccess) {
      return Fail(MacosPeerIdentityErrorCode::kSecurityGuestUnavailable, error,
                  0, status);
    }

    ScopedCfRef<CFStringRef> requirement_text(CFStringCreateWithBytes(
        kCFAllocatorDefault,
        reinterpret_cast<const UInt8 *>(expected.designated_requirement.data()),
        expected.designated_requirement.size(), kCFStringEncodingUTF8, false));
    if (requirement_text.get() == nullptr) {
      return Fail(MacosPeerIdentityErrorCode::kSecurityRequirementInvalid,
                  error);
    }
    ScopedCfRef<SecRequirementRef> expected_requirement;
    status = SecRequirementCreateWithString(
        requirement_text.get(), kSecCSDefaultFlags, expected_requirement.out());
    if (status != errSecSuccess) {
      return Fail(MacosPeerIdentityErrorCode::kSecurityRequirementInvalid,
                  error, 0, status);
    }

    status = SecCodeCheckValidity(guest.get(), kSecCSStrictValidate,
                                  expected_requirement.get());
    if (status != errSecSuccess) {
      return Fail(MacosPeerIdentityErrorCode::kSecurityValidationFailed, error,
                  0, status);
    }

    ScopedCfRef<SecStaticCodeRef> static_code;
    status = SecCodeCopyStaticCode(guest.get(), kSecCSDefaultFlags,
                                   static_code.out());
    if (status != errSecSuccess) {
      return Fail(MacosPeerIdentityErrorCode::kSigningInformationUnavailable,
                  error, 0, status);
    }

    ScopedCfRef<CFDictionaryRef> signing_information;
    status = SecCodeCopySigningInformation(
        static_code.get(), kSecCSSigningInformation, signing_information.out());
    if (status != errSecSuccess) {
      return Fail(MacosPeerIdentityErrorCode::kSigningInformationUnavailable,
                  error, 0, status);
    }
    const auto identifier = static_cast<CFStringRef>(CFDictionaryGetValue(
        signing_information.get(), kSecCodeInfoIdentifier));
    const auto team_id = static_cast<CFStringRef>(CFDictionaryGetValue(
        signing_information.get(), kSecCodeInfoTeamIdentifier));
    std::string actual_identifier;
    std::string actual_team_id;
    if (identifier == nullptr || team_id == nullptr ||
        CFGetTypeID(identifier) != CFStringGetTypeID() ||
        CFGetTypeID(team_id) != CFStringGetTypeID() ||
        !CopyBoundedCfString(identifier, kMacosPeerBundleIdentifierMaxBytes,
                             &actual_identifier) ||
        !CopyBoundedCfString(team_id, kMacosPeerTeamIdBytes, &actual_team_id)) {
      return Fail(MacosPeerIdentityErrorCode::kSigningInformationUnavailable,
                  error);
    }

    ScopedCfRef<SecRequirementRef> actual_requirement;
    status = SecCodeCopyDesignatedRequirement(
        static_code.get(), kSecCSDefaultFlags, actual_requirement.out());
    if (status != errSecSuccess) {
      return Fail(MacosPeerIdentityErrorCode::kSigningInformationUnavailable,
                  error, 0, status);
    }
    ScopedCfRef<CFDataRef> expected_requirement_data;
    ScopedCfRef<CFDataRef> actual_requirement_data;
    status =
        SecRequirementCopyData(expected_requirement.get(), kSecCSDefaultFlags,
                               expected_requirement_data.out());
    if (status == errSecSuccess) {
      status =
          SecRequirementCopyData(actual_requirement.get(), kSecCSDefaultFlags,
                                 actual_requirement_data.out());
    }
    if (status != errSecSuccess || expected_requirement_data.get() == nullptr ||
        actual_requirement_data.get() == nullptr) {
      return Fail(MacosPeerIdentityErrorCode::kSigningInformationUnavailable,
                  error, 0, status);
    }

    if (actual_identifier != expected.bundle_identifier ||
        actual_team_id != expected.team_id ||
        !CFEqual(expected_requirement_data.get(),
                 actual_requirement_data.get())) {
      return Fail(MacosPeerIdentityErrorCode::kCodeIdentityMismatch, error);
    }

    verified->bundle_identifier = std::move(actual_identifier);
    verified->team_id = std::move(actual_team_id);
    verified->designated_requirement = expected.designated_requirement;
    return true;
  }
};

bool AuthenticateWithValidator(int socket_fd,
                               const MacosExpectedPeerIdentity &expected,
                               MacosPeerCodeIdentityValidator &validator,
                               MacosVerifiedPeerIdentity *verified,
                               MacosPeerIdentityError *error) noexcept {
  ResetOutput(verified, error);
  if (verified == nullptr || !IsExpectedIdentityValid(expected)) {
    return Fail(MacosPeerIdentityErrorCode::kInvalidArgument, error);
  }

  MacosKernelPeerIdentity before;
  if (!ReadKernelPeerIdentity(socket_fd, &before, error)) {
    return false;
  }
  if (before.uid != expected.uid) {
    return Fail(MacosPeerIdentityErrorCode::kPeerCredentialsMismatch, error);
  }
  // A caller that named a session gets that session. uid alone would admit the
  // NEXT login window of the same user.
  if (expected.audit_session_id != 0 &&
      before.audit_session_id != expected.audit_session_id) {
    return Fail(MacosPeerIdentityErrorCode::kPeerCredentialsMismatch, error);
  }

  MacosVerifiedCodeIdentity code_identity;
  if (!validator.Verify(before, expected, &code_identity, error)) {
    if (error != nullptr && error->code == MacosPeerIdentityErrorCode::kNone) {
      error->code = MacosPeerIdentityErrorCode::kSecurityValidationFailed;
    }
    return false;
  }
  if (code_identity.bundle_identifier != expected.bundle_identifier ||
      code_identity.team_id != expected.team_id ||
      code_identity.designated_requirement != expected.designated_requirement) {
    return Fail(MacosPeerIdentityErrorCode::kCodeIdentityMismatch, error);
  }

  MacosKernelPeerIdentity after;
  if (!ReadKernelPeerIdentity(socket_fd, &after, error)) {
    return false;
  }
  if (!SameKernelPeer(before, after)) {
    return Fail(MacosPeerIdentityErrorCode::kPeerCredentialsMismatch, error);
  }

  verified->uid = after.uid;
  verified->gid = after.gid;
  verified->pid = after.pid;
  verified->audit_session_id = after.audit_session_id;
  verified->pid_version = after.pid_version;
  verified->bundle_identifier = std::move(code_identity.bundle_identifier);
  verified->team_id = std::move(code_identity.team_id);
  verified->designated_requirement =
      std::move(code_identity.designated_requirement);
  if (error != nullptr) {
    *error = {};
  }
  return true;
}

} // namespace

bool AuthenticateMacosRemoteDesktopPeer(
    int socket_fd, const MacosExpectedPeerIdentity &expected,
    MacosVerifiedPeerIdentity *verified,
    MacosPeerIdentityError *error) noexcept {
  SecurityFrameworkCodeValidator validator;
  return AuthenticateWithValidator(socket_fd, expected, validator, verified,
                                   error);
}

namespace testing {

bool AuthenticateMacosRemoteDesktopPeerWithCodeValidator(
    int socket_fd, const MacosExpectedPeerIdentity &expected,
    MacosPeerCodeIdentityValidator &validator,
    MacosVerifiedPeerIdentity *verified,
    MacosPeerIdentityError *error) noexcept {
  return AuthenticateWithValidator(socket_fd, expected, validator, verified,
                                   error);
}

} // namespace testing
} // namespace imcodes::remote_desktop::macos
