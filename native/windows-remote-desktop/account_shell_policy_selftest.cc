#include "third_party/imcodes_remote_desktop/account_shell_policy.h"

#include <cassert>

using namespace imcodes::remote_desktop::account_shell;

int main() {
  constexpr uint64_t now = 1'000'000;
  LaunchContext context{"host_1234", "launch_123456789", 7,
                        now - 100, now + 10'000};
  assert(ValidateLaunchContext(context, "host_1234", 7, now));
  assert(!ValidateLaunchContext(context, "other_123", 7, now));
  assert(!ValidateLaunchContext(context, "host_1234", 8, now));
  context.issued_at = now;
  context.expires_at = now + 60'001;
  assert(!ValidateLaunchContext(context, "host_1234", 7, now));

  assert(IsCanonicalHttpsOrigin(L"https://im.codes"));
  assert(IsCanonicalHttpsOrigin(L"https://im.codes:8443"));
  assert(IsCanonicalHttpsOrigin(L"https://[::1]:8443"));
  assert(!IsCanonicalHttpsOrigin(L"http://im.codes"));
  assert(!IsCanonicalHttpsOrigin(L"https://owner@im.codes"));
  assert(!IsCanonicalHttpsOrigin(L"https://IM.codes"));
  assert(!IsCanonicalHttpsOrigin(L"https://im.codes/"));
  assert(!IsCanonicalHttpsOrigin(L"https://im.codes:443"));
  assert(!IsCanonicalHttpsOrigin(L"https://im.codes?token=x"));

  assert(!SecretUiEnabled({true, true, true, false}));
  assert(SecretUiEnabled({true, true, true, true}));
  assert(!SecretUiEnabled({false, true, true, true}));
  assert(!SecretUiEnabled({true, false, true, true}));
  assert(!SecretUiEnabled({true, true, false, true}));

  SessionState session{"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                       "owner_1234", std::string(kNativeClientId),
                       "https://im.codes", std::string(kNativeAudience),
                       now + 30'000, false};
  assert(ValidateSessionState(session, "https://im.codes", now));
  session.revoked = true;
  assert(!ValidateSessionState(session, "https://im.codes", now));

  StepUpState step_up{"host_1234",
                      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
                      std::string(64, 'a'),
                      "rdsg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
                      now + 30'000, false};
  StepUpState missing_grant = step_up;
  missing_grant.grant_token.clear();
  assert(!ValidateStepUpState(missing_grant, "host_1234",
                              missing_grant.request_id,
                              std::string(64, 'a'), now));
  assert(!ConsumeStepUp(&step_up, "host_1234", step_up.request_id,
                        std::string(64, 'b'), now));
  assert(ConsumeStepUp(&step_up, "host_1234", step_up.request_id,
                       std::string(64, 'a'), now));
  assert(!ConsumeStepUp(&step_up, "host_1234", step_up.request_id,
                        std::string(64, 'a'), now));
  assert(InvitationLinkKindName(InvitationLinkKind::kAttended) == "attended");
  assert(InvitationLinkKindName(InvitationLinkKind::kUnattended) == "unattended");
  assert(InvitationLinkModeName(InvitationLinkMode::kView) == "view");
  assert(InvitationLinkModeName(InvitationLinkMode::kControl) == "control");
  assert(PasswordMutationActionName(PasswordMutationAction::kSet) == "set");
  assert(PasswordMutationActionName(PasswordMutationAction::kChange) == "change");
  assert(PasswordMutationActionName(PasswordMutationAction::kDisable) == "disable");
  assert(kClipboardCleanupLifetimeMs == 60'000);
  assert(kClipboardWatchdogFailedReason == "clipboard_watchdog_failed");
  assert(kClipboardWatchdogCrashedReason == "clipboard_watchdog_crashed");
  assert(kClipboardCleanupUncertainReason == "clipboard_cleanup_uncertain");
  return 0;
}
