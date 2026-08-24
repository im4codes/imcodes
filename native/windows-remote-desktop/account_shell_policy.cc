#include "third_party/imcodes_remote_desktop/account_shell_policy.h"

#include <algorithm>

namespace imcodes::remote_desktop::account_shell {
namespace {

bool IsBase64UrlCharacter(char character) {
  return (character >= 'a' && character <= 'z') ||
         (character >= 'A' && character <= 'Z') ||
         (character >= '0' && character <= '9') || character == '-' ||
         character == '_';
}

bool IsLowerHexCharacter(char character) {
  return (character >= '0' && character <= '9') ||
         (character >= 'a' && character <= 'f');
}

bool IsLowerAsciiHostCharacter(wchar_t character) {
  return (character >= L'a' && character <= L'z') ||
         (character >= L'0' && character <= L'9') || character == L'-' ||
         character == L'.';
}

bool IsCanonicalPort(std::wstring_view value) {
  if (value.empty() || value.size() > 5 ||
      (value.size() > 1 && value.front() == L'0')) {
    return false;
  }
  uint32_t port = 0;
  for (const wchar_t character : value) {
    if (character < L'0' || character > L'9') return false;
    port = port * 10 + static_cast<uint32_t>(character - L'0');
  }
  // WHATWG canonical origin removes the default HTTPS port.
  return port > 0 && port <= 65'535 && port != 443;
}

}  // namespace

bool IsBoundedOpaqueId(std::string_view value) {
  return !value.empty() && value.size() <= 128 &&
         std::all_of(value.begin(), value.end(), IsBase64UrlCharacter);
}

bool IsExactLoopbackRedirect(std::string_view uri) {
  return uri == kNativeRedirectUri;
}

bool IsValidPkceVerifier(std::string_view value) {
  if (value.size() < 43 || value.size() > 128) return false;
  return std::all_of(value.begin(), value.end(), [](char character) {
    return IsBase64UrlCharacter(character) || character == '.' ||
           character == '~';
  });
}

bool IsCanonicalBase64Url32(std::string_view value) {
  return value.size() == 43 &&
         std::all_of(value.begin(), value.end(), IsBase64UrlCharacter);
}

bool IsCanonicalHttpsOrigin(std::wstring_view value) {
  constexpr std::wstring_view prefix = L"https://";
  if (!value.starts_with(prefix) || value.size() <= prefix.size() ||
      value.size() > 2048) {
    return false;
  }
  const std::wstring_view authority = value.substr(prefix.size());
  if (authority.find_first_of(L"/?#@\\") != std::wstring_view::npos) {
    return false;
  }

  std::wstring_view host;
  std::wstring_view port;
  if (authority.front() == L'[') {
    const size_t close = authority.find(L']');
    if (close == std::wstring_view::npos || close == 1) return false;
    host = authority.substr(1, close - 1);
    const std::wstring_view suffix = authority.substr(close + 1);
    if (!suffix.empty()) {
      if (suffix.front() != L':') return false;
      port = suffix.substr(1);
    }
    if (host.find(L':') == std::wstring_view::npos ||
        !std::all_of(host.begin(), host.end(), [](wchar_t character) {
          return (character >= L'0' && character <= L'9') ||
                 (character >= L'a' && character <= L'f') ||
                 character == L':' || character == L'.';
        })) {
      return false;
    }
  } else {
    const size_t colon = authority.find(L':');
    if (colon == std::wstring_view::npos) {
      host = authority;
    } else {
      if (authority.find(L':', colon + 1) != std::wstring_view::npos) {
        return false;
      }
      host = authority.substr(0, colon);
      port = authority.substr(colon + 1);
    }
    if (host.empty() || host.size() > 253 ||
        !std::all_of(host.begin(), host.end(), IsLowerAsciiHostCharacter) ||
        host.front() == L'.' || host.front() == L'-' ||
        host.back() == L'-' || host.find(L"..") != std::wstring_view::npos) {
      return false;
    }
    size_t offset = 0;
    while (offset < host.size()) {
      size_t end = host.find(L'.', offset);
      if (end == std::wstring_view::npos) end = host.size();
      const std::wstring_view label = host.substr(offset, end - offset);
      if (label.empty() || label.size() > 63 || label.front() == L'-' ||
          label.back() == L'-') {
        return false;
      }
      offset = end + 1;
    }
  }
  return port.empty() || IsCanonicalPort(port);
}

bool ValidateLaunchContext(const LaunchContext& context,
                           std::string_view expected_host_id,
                           uint64_t expected_endpoint_generation,
                           uint64_t now_ms) {
  return IsBoundedOpaqueId(context.host_id) &&
         IsBoundedOpaqueId(context.launch_id) &&
         context.host_id == expected_host_id &&
         context.endpoint_generation == expected_endpoint_generation &&
         context.expires_at > context.issued_at &&
         context.expires_at - context.issued_at <= kMaximumLaunchLifetimeMs &&
         now_ms >= context.issued_at && now_ms < context.expires_at;
}

bool ValidateSessionState(const SessionState& state,
                          std::string_view expected_issuer,
                          uint64_t now_ms) {
  return !state.revoked && IsCanonicalBase64Url32(state.session_id) &&
         IsBoundedOpaqueId(state.user_id) && state.client_id == kNativeClientId &&
         state.issuer == expected_issuer && state.audience == kNativeAudience &&
         state.expires_at > now_ms;
}

bool ValidateStepUpState(const StepUpState& state,
                         std::string_view expected_host_id,
                         std::string_view expected_request_id,
                         std::string_view expected_action_digest,
                         uint64_t now_ms) {
  return !state.consumed && state.canonical_host_id == expected_host_id &&
         state.request_id == expected_request_id &&
         state.action_digest == expected_action_digest &&
         state.grant_token.starts_with(kStepUpGrantPrefix) &&
         IsCanonicalBase64Url32(
             std::string_view(state.grant_token).substr(kStepUpGrantPrefix.size())) &&
         IsBoundedOpaqueId(state.canonical_host_id) &&
         IsCanonicalBase64Url32(state.request_id) &&
         state.action_digest.size() == 64 &&
         std::all_of(state.action_digest.begin(), state.action_digest.end(),
                     IsLowerHexCharacter) &&
         state.expires_at > now_ms &&
         state.expires_at - now_ms <= kMaximumStepUpLifetimeMs;
}

bool SecretUiEnabled(const SecretUiState& state) {
  return state.signed_in && state.launch_context_current &&
         state.privacy_active && state.step_up_current;
}

bool ConsumeStepUp(StepUpState* state,
                   std::string_view expected_host_id,
                   std::string_view expected_request_id,
                   std::string_view expected_action_digest,
                   uint64_t now_ms) {
  if (!state || !ValidateStepUpState(*state, expected_host_id,
                                     expected_request_id,
                                     expected_action_digest, now_ms)) {
    return false;
  }
  state->consumed = true;
  return true;
}

std::string_view OwnerActionName(OwnerAction action) {
  switch (action) {
    case OwnerAction::kCreateInvitationLink:
      return "remote_desktop.link.create";
    case OwnerAction::kUpdateInvitationLink:
      return "remote_desktop.link.update";
    case OwnerAction::kRevokeInvitationLink:
      return "remote_desktop.link.revoke";
    case OwnerAction::kRotatePublicId:
      return "remote_desktop.host.rotate";
    case OwnerAction::kSetUnattendedPassword:
      return "remote_desktop.unattended_password.set";
    case OwnerAction::kRemoveUnattendedPassword:
      return "remote_desktop.unattended_password.remove";
  }
  return {};
}

std::string_view InvitationLinkKindName(InvitationLinkKind kind) {
  switch (kind) {
    case InvitationLinkKind::kAttended:
      return "attended";
    case InvitationLinkKind::kUnattended:
      return "unattended";
  }
  return {};
}

std::string_view InvitationLinkModeName(InvitationLinkMode mode) {
  switch (mode) {
    case InvitationLinkMode::kView:
      return "view";
    case InvitationLinkMode::kControl:
      return "control";
  }
  return {};
}

std::string_view PasswordMutationActionName(PasswordMutationAction action) {
  switch (action) {
    case PasswordMutationAction::kSet:
      return "set";
    case PasswordMutationAction::kChange:
      return "change";
    case PasswordMutationAction::kDisable:
      return "disable";
  }
  return {};
}

}  // namespace imcodes::remote_desktop::account_shell
