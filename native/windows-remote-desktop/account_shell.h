#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "third_party/imcodes_remote_desktop/account_shell_policy.h"

namespace imcodes::remote_desktop::account_shell {

// The system browser owns account authentication; no account password or
// browser cookie enters native. An unattended-access password may exist only
// in the password edit control and one bounded mutation buffer, both of which
// are cleared immediately after the single mutation attempt.
// The launch context is presentation/privacy coordination only; it grants no
// Owner authority and callers must not call EndPrivacy until local secret UI
// and clipboard cleanup have completed successfully.

struct NativeAccountSession {
  SessionState state;
  std::string access_token;
};

struct PkceRequest {
  std::string state;
  std::string verifier;
  std::string challenge;
};

struct AuthorizationResult {
  std::string code;
  std::string state;
};

struct HttpResponse {
  uint32_t status = 0;
  std::string body;
};

enum class PrivacyPhase : uint8_t {
  kStarting,
  kActive,
  kEnding,
  kRecoveryRequired,
  kEnded,
};

struct PrivacyEpochState {
  std::string host_id;
  std::string epoch_id;
  uint64_t revision = 0;
  PrivacyPhase phase = PrivacyPhase::kStarting;
};

struct OwnerInvitationLink {
  std::string id;
  std::string label;
  InvitationLinkKind kind = InvitationLinkKind::kAttended;
  InvitationLinkMode mode = InvitationLinkMode::kView;
  std::string state;
};

struct CreatedInvitationLink {
  OwnerInvitationLink link;
  // The raw bearer exists only in this transient local result. It is never
  // sent to the Server, node or Worker and must be cleared by the UI.
  std::wstring invitation_url;
};

enum class ClipboardCleanupStatus : uint8_t {
  kClean,
  kPending,
  kFailed,
};

class ProtectedSessionStore {
 public:
  bool Save(const NativeAccountSession& session,
            std::string_view expected_issuer) const;
  std::optional<NativeAccountSession> Load(
      std::string_view expected_issuer) const;
  bool Remove() const;
};

class OwnerApiClient {
 public:
  explicit OwnerApiClient(std::wstring server_origin);
  ~OwnerApiClient();

  bool valid() const { return valid_; }
  const std::wstring& server_origin() const { return server_origin_; }
  const std::string& issuer() const { return issuer_; }
  std::optional<std::string> CreateRequestId() const;
  std::optional<PkceRequest> CreatePkceRequest() const;
  std::optional<AuthorizationResult> AuthorizeWithSystemBrowser(
      const PkceRequest& request) const;
  std::optional<NativeAccountSession> ExchangeAuthorizationCode(
      const PkceRequest& request,
      const AuthorizationResult& authorization) const;
  bool RevokeSession(const NativeAccountSession& session) const;
  bool RequestLaunchContext(const NativeAccountSession& session,
                            std::string_view canonical_host_id) const;
  std::optional<PrivacyEpochState> BeginPrivacy(
      const NativeAccountSession& session,
      const LaunchContext& launch_context,
      std::string_view expected_host_id,
      uint64_t expected_endpoint_generation,
      uint64_t now_ms) const;
  std::optional<PrivacyPhase> GetPrivacyStatus(
      const NativeAccountSession& session,
      const PrivacyEpochState& epoch) const;
  std::optional<PrivacyPhase> EndPrivacy(
      const NativeAccountSession& session,
      const PrivacyEpochState& epoch) const;
  bool ReportPrivacyRecovery(
      const NativeAccountSession& session,
      const PrivacyEpochState& epoch,
      uint64_t endpoint_generation,
      std::string_view reason) const;

  // Every Owner mutation must first create a fresh request ID, action body and
  // short deadline, call BeginStepUp, complete it in the system browser, then
  // submit the returned one-use grant in exactly one mutation request.
  std::optional<HttpResponse> BeginStepUp(
      const NativeAccountSession& session,
      std::string_view canonical_host_id,
      std::string_view request_id,
      uint64_t deadline,
      std::string_view canonical_action_json) const;
  std::optional<StepUpState> CompleteStepUpWithSystemBrowser(
      const NativeAccountSession& session,
      const HttpResponse& begin_response,
      std::string_view canonical_host_id,
      std::string_view request_id,
      uint64_t expected_deadline) const;
  std::optional<HttpResponse> GetOwnerMetadata(
      const NativeAccountSession& session,
      std::wstring_view path_and_query) const;
  std::optional<std::string> GetOwnerPublicId(
      const NativeAccountSession& session,
      std::string_view canonical_host_id) const;
  std::optional<std::string> RotateOwnerPublicId(
      const NativeAccountSession& session,
      const LaunchContext& launch_context,
      const SecretUiState& secret_ui,
      std::string_view expected_host_id,
      uint64_t expected_endpoint_generation,
      uint64_t now_ms) const;
  std::optional<std::vector<OwnerInvitationLink>> GetOwnerInvitationLinks(
      const NativeAccountSession& session,
      std::string_view canonical_host_id) const;
  std::optional<CreatedInvitationLink> CreateOwnerInvitationLink(
      const NativeAccountSession& session,
      const LaunchContext& launch_context,
      const PrivacyEpochState& privacy_epoch,
      const SecretUiState& secret_ui,
      std::string_view expected_host_id,
      uint64_t expected_endpoint_generation,
      InvitationLinkKind kind,
      InvitationLinkMode mode,
      std::string_view label,
      std::optional<uint64_t> duration_ms,
      uint64_t now_ms);
  // An indeterminate transport result retains exactly one bounded, memory-only
  // creation tuple so the next identical action can replay the same consumed
  // grant and recover the Server's original result. Authority/privacy loss,
  // explicit cancellation and process teardown erase it.
  bool HasPendingInvitationCreation() const {
    return pending_invitation_creation_.has_value();
  }
  void ClearPendingInvitationCreation();
  std::optional<OwnerInvitationLink> ReduceOwnerInvitationLinkToView(
      const NativeAccountSession& session,
      const LaunchContext& launch_context,
      const PrivacyEpochState& privacy_epoch,
      const SecretUiState& secret_ui,
      std::string_view expected_host_id,
      uint64_t expected_endpoint_generation,
      std::string_view link_id,
      uint64_t now_ms) const;
  std::optional<OwnerInvitationLink> RevokeOwnerInvitationLink(
      const NativeAccountSession& session,
      const LaunchContext& launch_context,
      const PrivacyEpochState& privacy_epoch,
      const SecretUiState& secret_ui,
      std::string_view expected_host_id,
      uint64_t expected_endpoint_generation,
      std::string_view link_id,
      uint64_t now_ms) const;
  bool MutateOwnerUnattendedPassword(
      const NativeAccountSession& session,
      const LaunchContext& launch_context,
      const PrivacyEpochState& privacy_epoch,
      const SecretUiState& secret_ui,
      std::string_view expected_host_id,
      uint64_t expected_endpoint_generation,
      PasswordMutationAction action,
      std::string* password,
      uint64_t now_ms) const;
  std::optional<HttpResponse> CallOwnerMutation(
      const NativeAccountSession& session,
      const LaunchContext& launch_context,
      const SecretUiState& secret_ui,
      std::string_view expected_host_id,
      uint64_t expected_endpoint_generation,
      StepUpState* step_up,
      std::string_view expected_request_id,
      std::string_view expected_action_digest,
      std::wstring_view method,
      std::wstring_view path_and_query,
      std::string_view json_body,
      uint64_t now_ms) const;

 private:
  struct PendingInvitationCreation {
    std::string canonical_host_id;
    uint64_t endpoint_generation = 0;
    std::string privacy_epoch_id;
    uint64_t privacy_revision = 0;
    InvitationLinkKind kind = InvitationLinkKind::kAttended;
    InvitationLinkMode mode = InvitationLinkMode::kView;
    std::string label;
    std::optional<uint64_t> duration_ms;
    std::string creation_request_id;
    std::string raw_token;
    std::string token_hash;
    std::string policy_hash;
    std::string request_json;
    std::string action_digest;
    std::string grant_token;
  };

  bool PendingInvitationMatches(
      const PendingInvitationCreation& pending,
      const PrivacyEpochState& privacy_epoch,
      std::string_view expected_host_id,
      uint64_t expected_endpoint_generation,
      InvitationLinkKind kind,
      InvitationLinkMode mode,
      std::string_view label,
      std::optional<uint64_t> duration_ms,
      std::string_view policy_hash) const;
  std::optional<CreatedInvitationLink> DispatchPendingInvitationCreation(
      const NativeAccountSession& session);
  std::optional<CreatedInvitationLink> CompletePendingInvitationCreation(
      const std::optional<HttpResponse>& response);
  std::optional<HttpResponse> Request(std::wstring_view method,
                                      std::wstring_view path_and_query,
                                      std::string_view json_body,
                                      std::string_view bearer) const;

  std::wstring server_origin_;
  std::string issuer_;
  bool valid_ = false;
  std::optional<PendingInvitationCreation> pending_invitation_creation_;
};

// The watchdog is armed and durably ready before the raw invitation is copied.
// Its command line receives only epoch/hash/sequence/deadline metadata.
bool CopyInvitationLinkWithWatchdog(std::wstring_view invitation_link,
                                    std::string_view epoch_id,
                                    uint64_t* cleanup_deadline_ms);
ClipboardCleanupStatus ReconcileClipboardWatchdog();

// Runs the separately signed account shell. Without a validated launch context
// it presents only IM.codes branding, sign-in/status and local Stop. Sensitive
// controls remain absent rather than disabled or inferred from node state.
int RunAccountShell(std::wstring server_origin,
                    std::optional<LaunchContext> launch_context,
                    std::string expected_host_id,
                    uint64_t expected_endpoint_generation);

}  // namespace imcodes::remote_desktop::account_shell
