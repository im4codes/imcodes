#include "macos_peer_verifier_command.h"

#include "macos_peer_identity.h"

#include <bsm/audit.h>

#include <charconv>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>

namespace imcodes::remote_desktop::macos {
namespace {

constexpr std::string_view kMode = "--imcodes-verify-peer-v1";
constexpr std::string_view kSocketFd = "--socket-fd=";
constexpr std::string_view kExpectedUid = "--expected-uid=";
constexpr std::string_view kExpectedAuditSessionId = "--expected-audit-session-id=";
constexpr std::string_view kBundleIdentifier = "--bundle-id=";
constexpr std::string_view kTeamId = "--team-id=";
constexpr std::string_view kDesignatedRequirement =
    "--designated-requirement=";
constexpr int kInheritedSocketFd = 3;
constexpr int kUsageExit = 64;
constexpr int kRejectedExit = 65;

bool TakeValue(std::string_view argument, std::string_view prefix,
               std::string* output) {
  if (!argument.starts_with(prefix) || !output->empty()) return false;
  const std::string_view value = argument.substr(prefix.size());
  if (value.empty()) return false;
  output->assign(value);
  return true;
}

template <typename Integer>
bool ParseInteger(std::string_view value, Integer* output) {
  if (value.empty()) return false;
  Integer parsed = 0;
  const auto result =
      std::from_chars(value.data(), value.data() + value.size(), parsed);
  if (result.ec != std::errc{} || result.ptr != value.data() + value.size()) {
    return false;
  }
  *output = parsed;
  return true;
}

std::string JsonString(std::string_view value) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string encoded;
  encoded.reserve(value.size() + 2);
  encoded.push_back('"');
  for (const unsigned char byte : value) {
    switch (byte) {
      case '"': encoded.append("\\\""); break;
      case '\\': encoded.append("\\\\"); break;
      case '\b': encoded.append("\\b"); break;
      case '\f': encoded.append("\\f"); break;
      case '\n': encoded.append("\\n"); break;
      case '\r': encoded.append("\\r"); break;
      case '\t': encoded.append("\\t"); break;
      default:
        if (byte < 0x20) {
          encoded.append("\\u00");
          encoded.push_back(kHex[(byte >> 4) & 0x0f]);
          encoded.push_back(kHex[byte & 0x0f]);
        } else {
          encoded.push_back(static_cast<char>(byte));
        }
    }
  }
  encoded.push_back('"');
  return encoded;
}

int Reject(const MacosPeerIdentityError& error) {
  // Numeric diagnostics are intentionally bounded and contain no authority,
  // challenge, requirement text, or peer-controlled payload.
  std::cerr << "macos_peer_verification_rejected code="
            << static_cast<unsigned>(error.code)
            << " system=" << error.system_error
            << " security=" << error.security_status << '\n';
  return kRejectedExit;
}

}  // namespace

MacosPeerVerifierCommandResult MaybeRunMacosPeerVerifierCommand(
    int argc, const char* const argv[]) noexcept {
  if (argc < 2 || argv == nullptr || argv[1] == nullptr ||
      std::string_view(argv[1]) != kMode) {
    return {.handled = false, .exit_code = 0};
  }
  if (argc != 7) return {.handled = true, .exit_code = kUsageExit};

  std::string socket_fd_text;
  std::string expected_uid_text;
  std::string expected_asid_text;
  std::string bundle_identifier;
  std::string team_id;
  std::string designated_requirement;
  for (int index = 2; index < argc; ++index) {
    const std::string_view argument(argv[index] == nullptr ? "" : argv[index]);
    if (TakeValue(argument, kSocketFd, &socket_fd_text) ||
        TakeValue(argument, kExpectedUid, &expected_uid_text) ||
        TakeValue(argument, kExpectedAuditSessionId, &expected_asid_text) ||
        TakeValue(argument, kBundleIdentifier, &bundle_identifier) ||
        TakeValue(argument, kTeamId, &team_id) ||
        TakeValue(argument, kDesignatedRequirement, &designated_requirement)) {
      continue;
    }
    return {.handled = true, .exit_code = kUsageExit};
  }

  int socket_fd = -1;
  unsigned long expected_uid_value = 0;
  if (!ParseInteger(socket_fd_text, &socket_fd) ||
      socket_fd != kInheritedSocketFd ||
      !ParseInteger(expected_uid_text, &expected_uid_value) ||
      expected_uid_value == 0 ||
      expected_uid_value > std::numeric_limits<uid_t>::max()) {
    return {.handled = true, .exit_code = kUsageExit};
  }

  // Optional. When present the peer must be in THAT audit session: uid alone
  // cannot tell two successive login windows of the same user apart, so a
  // capability bound only to uid survives a logout and applies to the next
  // session.
  unsigned long expected_asid_value = 0;
  if (!expected_asid_text.empty() &&
      (!ParseInteger(expected_asid_text, &expected_asid_value) ||
       expected_asid_value == 0 ||
       expected_asid_value > std::numeric_limits<au_asid_t>::max())) {
    return {.handled = true, .exit_code = kUsageExit};
  }

  MacosExpectedPeerIdentity expected{
      .uid = static_cast<uid_t>(expected_uid_value),
      .audit_session_id = static_cast<au_asid_t>(expected_asid_value),
      .bundle_identifier = std::move(bundle_identifier),
      .team_id = std::move(team_id),
      .designated_requirement = std::move(designated_requirement),
  };
  MacosVerifiedPeerIdentity verified;
  MacosPeerIdentityError error;
  if (!AuthenticateMacosRemoteDesktopPeer(socket_fd, expected, &verified,
                                           &error)) {
    return {.handled = true, .exit_code = Reject(error)};
  }

  // The audit session and the process-id VERSION are emitted so the caller can
  // bind a capability to this exact session and this exact process incarnation.
  // Without the pid version a pid is not an identity: pids are reused, and on a
  // busy machine that is a matter of time rather than a remote possibility.
  std::cout << "{\"version\":1,\"uid\":" << verified.uid
            << ",\"auditSessionId\":" << verified.audit_session_id
            << ",\"pidVersion\":" << verified.pid_version
            << ",\"bundleIdentifier\":"
            << JsonString(verified.bundle_identifier)
            << ",\"teamId\":" << JsonString(verified.team_id)
            << ",\"designatedRequirement\":"
            << JsonString(verified.designated_requirement) << "}\n";
  return {.handled = true, .exit_code = 0};
}

}  // namespace imcodes::remote_desktop::macos

#if defined(IMCODES_MACOS_PEER_VERIFIER_STANDALONE)
int main(int argc, const char* argv[]) {
  const auto result =
      imcodes::remote_desktop::macos::MaybeRunMacosPeerVerifierCommand(
          argc, argv);
  return result.handled ? result.exit_code : 64;
}
#endif
