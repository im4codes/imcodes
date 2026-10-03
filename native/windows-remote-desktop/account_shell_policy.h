#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace imcodes::remote_desktop::account_shell {

inline constexpr std::string_view kNativeClientId =
    "imcodes-controlled-shell-v1";
inline constexpr std::string_view kNativeAudience =
    "imcodes-remote-desktop-management";
inline constexpr std::string_view kNativeRedirectUri =
    "http://127.0.0.1:19139/oauth/callback";
inline constexpr std::string_view kNativeLoopbackHost = "127.0.0.1";
inline constexpr uint16_t kNativeLoopbackPort = 19139;
inline constexpr uint64_t kMaximumLaunchLifetimeMs = 60 * 1000;
inline constexpr uint64_t kMaximumStepUpLifetimeMs = 5 * 60 * 1000;
inline constexpr std::string_view kStepUpGrantPrefix = "rdsg_";
inline constexpr uint64_t kClipboardCleanupLifetimeMs = 60 * 1000;

// Mirrors the shared platform-neutral recovery vocabulary. These values are
// sent only to the authenticated native recovery endpoint and never carry
// clipboard text, invite bearers or passwords.
inline constexpr std::string_view kClipboardWatchdogFailedReason =
    "clipboard_watchdog_failed";
inline constexpr std::string_view kClipboardWatchdogCrashedReason =
    "clipboard_watchdog_crashed";
inline constexpr std::string_view kClipboardCleanupUncertainReason =
    "clipboard_cleanup_uncertain";

struct LaunchContext {
  std::string host_id;
  std::string launch_id;
  uint64_t endpoint_generation = 0;
  uint64_t issued_at = 0;
  uint64_t expires_at = 0;
};

struct SessionState {
  std::string session_id;
  std::string user_id;
  std::string client_id;
  std::string issuer;
  std::string audience;
  uint64_t expires_at = 0;
  bool revoked = false;
};

struct StepUpState {
  std::string canonical_host_id;
  std::string request_id;
  std::string action_digest;
  std::string grant_token;
  uint64_t expires_at = 0;
  bool consumed = false;
};

struct SecretUiState {
  bool signed_in = false;
  bool launch_context_current = false;
  bool privacy_active = false;
  bool step_up_current = false;
};

enum class OwnerAction : uint8_t {
  kCreateInvitationLink,
  kUpdateInvitationLink,
  kRevokeInvitationLink,
  kRotatePublicId,
  kSetUnattendedPassword,
  kRemoveUnattendedPassword,
};

enum class InvitationLinkKind : uint8_t {
  kAttended,
  kUnattended,
};

enum class InvitationLinkMode : uint8_t {
  kView,
  kControl,
};

enum class PasswordMutationAction : uint8_t {
  kSet,
  kChange,
  kDisable,
};

bool IsBoundedOpaqueId(std::string_view value);
bool IsExactLoopbackRedirect(std::string_view uri);
bool IsValidPkceVerifier(std::string_view value);
bool IsCanonicalBase64Url32(std::string_view value);
/** Exact output shape of WHATWG URL.origin for a credential-free HTTPS URL. */
bool IsCanonicalHttpsOrigin(std::wstring_view value);

bool ValidateLaunchContext(const LaunchContext& context,
                           std::string_view expected_host_id,
                           uint64_t expected_endpoint_generation,
                           uint64_t now_ms);
bool ValidateSessionState(const SessionState& state,
                          std::string_view expected_issuer,
                          uint64_t now_ms);
bool ValidateStepUpState(const StepUpState& state,
                         std::string_view expected_host_id,
                         std::string_view expected_request_id,
                         std::string_view expected_action_digest,
                         uint64_t now_ms);
bool SecretUiEnabled(const SecretUiState& state);
bool ConsumeStepUp(StepUpState* state,
                   std::string_view expected_host_id,
                   std::string_view expected_request_id,
                   std::string_view expected_action_digest,
                   uint64_t now_ms);

std::string_view OwnerActionName(OwnerAction action);
std::string_view InvitationLinkKindName(InvitationLinkKind kind);
std::string_view InvitationLinkModeName(InvitationLinkMode mode);
std::string_view PasswordMutationActionName(PasswordMutationAction action);

}  // namespace imcodes::remote_desktop::account_shell
