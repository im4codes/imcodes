#include "third_party/imcodes_remote_desktop/account_shell.h"

#include <atomic>
#include <initializer_list>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include "third_party/imcodes_remote_desktop/brand_logo_generated.h"

namespace imcodes::remote_desktop::account_shell {
namespace {

constexpr wchar_t kWindowClass[] = L"IMCodesRemoteDesktopAccountShell";
constexpr wchar_t kProductName[] = L"IM.codes Remote Desktop";
constexpr wchar_t kSignIn[] = L"Sign in with system browser";
constexpr wchar_t kSignOut[] = L"Sign out";
constexpr wchar_t kStop[] = L"Stop remote desktop";
constexpr wchar_t kSignedOutStatus[] = L"Signed out. Management controls are hidden.";
constexpr wchar_t kSignedInStatus[] = L"Signed in. Waiting for a current privacy context.";
constexpr wchar_t kPrivacyStatus[] = L"Privacy protection active.";
constexpr wchar_t kPrivacyEndingStatus[] = L"Privacy cleanup in progress.";
constexpr wchar_t kRecoveryStatus[] =
    L"Recovery required. Management controls remain hidden.";
constexpr wchar_t kBindingStatus[] =
    L"Signed in. Binding this shell to the current controlled computer.";
constexpr wchar_t kStepUpStatus[] =
    L"Complete verification in the system browser.";
constexpr wchar_t kRotatePublicId[] = L"Rotate public ID";
constexpr wchar_t kPublicIdUnavailable[] = L"Public ID unavailable";
constexpr wchar_t kCreateLink[] = L"Create invitation link";
constexpr wchar_t kReduceLink[] = L"Reduce selected link to View";
constexpr wchar_t kRevokeLink[] = L"Revoke selected link";
constexpr wchar_t kCopyInvite[] = L"Copy one-time invitation";
constexpr wchar_t kClearInvite[] = L"Clear one-time invitation";
constexpr wchar_t kSetPassword[] = L"Set unattended password";
constexpr wchar_t kChangePassword[] = L"Change unattended password";
constexpr wchar_t kDisablePassword[] = L"Disable unattended password";
constexpr wchar_t kClipboardCleanupStatus[] =
    L"Clipboard cleanup in progress. Privacy remains active.";
constexpr int kSignInButton = 1001;
constexpr int kSignOutButton = 1002;
constexpr int kStopButton = 1003;
constexpr int kRotatePublicIdButton = 1004;
constexpr int kCreateLinkButton = 1005;
constexpr int kReduceLinkButton = 1006;
constexpr int kRevokeLinkButton = 1007;
constexpr int kCopyInviteButton = 1008;
constexpr int kClearInviteButton = 1009;
constexpr int kSetPasswordButton = 1010;
constexpr int kChangePasswordButton = 1011;
constexpr int kDisablePasswordButton = 1012;
constexpr UINT_PTR kPrivacyPollTimer = 2001;
constexpr UINT_PTR kClipboardPollTimer = 2002;
constexpr UINT kPrivacyPollIntervalMs = 500;
constexpr UINT kClipboardPollIntervalMs = 1'000;
constexpr UINT kRequestBoundLaunch = WM_APP + 17;

struct WindowState {
  OwnerApiClient api;
  ProtectedSessionStore store;
  std::optional<NativeAccountSession> session;
  std::optional<LaunchContext> launch;
  std::string expected_host_id;
  std::string expected_issuer;
  uint64_t expected_generation = 0;
  std::optional<PrivacyEpochState> privacy_epoch;
  bool privacy_active = false;
  bool privacy_recovery = false;
  bool logout_pending = false;
  bool close_pending = false;
  bool metadata_attempted = false;
  bool clipboard_cleanup_pending = false;
  uint64_t clipboard_cleanup_deadline = 0;
  std::string public_id;
  std::vector<OwnerInvitationLink> links;
  std::wstring raw_invitation_link;
  HWND status = nullptr;
  HWND sign_in = nullptr;
  HWND sign_out = nullptr;
  HWND stop = nullptr;
  HWND public_id_label = nullptr;
  HWND rotate_public_id = nullptr;
  HWND link_label = nullptr;
  HWND link_kind = nullptr;
  HWND link_mode = nullptr;
  HWND link_duration = nullptr;
  HWND create_link = nullptr;
  HWND link_list = nullptr;
  HWND reduce_link = nullptr;
  HWND revoke_link = nullptr;
  HWND raw_invitation = nullptr;
  HWND copy_invitation = nullptr;
  HWND clear_invitation = nullptr;
  HWND password = nullptr;
  HWND set_password = nullptr;
  HWND change_password = nullptr;
  HWND disable_password = nullptr;

  WindowState(std::wstring origin, std::optional<LaunchContext> context,
              std::string host, uint64_t generation)
      : api(origin), launch(std::move(context)),
        expected_host_id(std::move(host)), expected_issuer(api.issuer()),
        expected_generation(generation) {}
};

bool IsHighContrast() {
  HIGHCONTRASTW contrast{sizeof(contrast)};
  return SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(contrast),
                               &contrast, 0) &&
         (contrast.dwFlags & HCF_HIGHCONTRASTON) != 0;
}

int Scale(HWND window, int logical) {
  const UINT dpi = GetDpiForWindow(window);
  return MulDiv(logical, static_cast<int>(dpi == 0 ? 96 : dpi), 96);
}

uint64_t WallNow() {
  FILETIME file_time{};
  GetSystemTimeAsFileTime(&file_time);
  ULARGE_INTEGER value{};
  value.LowPart = file_time.dwLowDateTime;
  value.HighPart = file_time.dwHighDateTime;
  constexpr uint64_t kWindowsToUnix100Ns = 116444736000000000ULL;
  return value.QuadPart <= kWindowsToUnix100Ns
             ? 0
             : (value.QuadPart - kWindowsToUnix100Ns) / 10'000;
}

bool CurrentLaunch(const WindowState& state) {
  return state.launch && ValidateLaunchContext(
      *state.launch, state.expected_host_id, state.expected_generation,
      WallNow());
}

bool CurrentSession(const WindowState& state) {
  return state.session && !state.expected_issuer.empty() &&
         ValidateSessionState(state.session->state, state.expected_issuer,
                              WallNow());
}

void SetStatus(WindowState* state, const wchar_t* text) {
  if (state->status) SetWindowTextW(state->status, text);
}

std::wstring WidenAscii(std::string_view value) {
  std::wstring output;
  output.reserve(value.size());
  for (const char character : value) {
    output.push_back(static_cast<wchar_t>(static_cast<unsigned char>(character)));
  }
  return output;
}

void SetPublicId(WindowState* state, std::string value) {
  state->public_id = std::move(value);
  if (!state->public_id_label) return;
  const std::wstring text = state->public_id.empty()
      ? std::wstring(kPublicIdUnavailable)
      : L"Public ID: " + WidenAscii(state->public_id);
  SetWindowTextW(state->public_id_label, text.c_str());
}

void SecureClear(std::wstring* value) {
  if (!value) return;
  if (!value->empty()) {
    SecureZeroMemory(value->data(), value->size() * sizeof(wchar_t));
  }
  value->clear();
}

std::wstring ReadControlText(HWND control, size_t maximum_characters) {
  if (!control) return {};
  const int length = GetWindowTextLengthW(control);
  if (length <= 0 || static_cast<size_t>(length) > maximum_characters) {
    return {};
  }
  std::wstring value(static_cast<size_t>(length) + 1, L'\0');
  const int copied = GetWindowTextW(control, value.data(), length + 1);
  if (copied != length) {
    SecureClear(&value);
    return {};
  }
  value.resize(static_cast<size_t>(copied));
  return value;
}

std::string Utf8FromWide(std::wstring_view value) {
  if (value.empty() || value.size() > 4096) return {};
  const int required = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (required <= 0) return {};
  std::string output(static_cast<size_t>(required), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), output.data(),
                          required, nullptr, nullptr) != required) {
    SecureZeroMemory(output.data(), output.size());
    return {};
  }
  return output;
}

void SetRawInvitation(WindowState* state, std::wstring value) {
  SecureClear(&state->raw_invitation_link);
  state->raw_invitation_link = std::move(value);
  if (state->raw_invitation) {
    SetWindowTextW(state->raw_invitation,
                   state->raw_invitation_link.c_str());
  }
}

void RefreshLinkList(WindowState* state) {
  if (!state->link_list) return;
  SendMessageW(state->link_list, LB_RESETCONTENT, 0, 0);
  for (const auto& link : state->links) {
    const std::wstring label = WidenAscii(link.label) + L" | " +
        WidenAscii(InvitationLinkKindName(link.kind)) + L" | " +
        WidenAscii(InvitationLinkModeName(link.mode)) + L" | " +
        WidenAscii(link.state);
    SendMessageW(state->link_list, LB_ADDSTRING, 0,
                 reinterpret_cast<LPARAM>(label.c_str()));
  }
}

std::optional<size_t> SelectedLinkIndex(const WindowState& state) {
  if (!state.link_list) return std::nullopt;
  const LRESULT selected = SendMessageW(state.link_list, LB_GETCURSEL, 0, 0);
  if (selected == LB_ERR || selected < 0 ||
      static_cast<size_t>(selected) >= state.links.size()) {
    return std::nullopt;
  }
  return static_cast<size_t>(selected);
}

void RefreshUi(HWND window, WindowState* state);

void ClearLocalSecretUi(WindowState* state) {
  // Remove all Owner metadata and secret-bearing controls before END. The
  // clipboard marker is deliberately not cleared here: its independently
  // signed watchdog must prove cleanup first.
  state->privacy_active = false;
  state->metadata_attempted = false;
  state->api.ClearPendingInvitationCreation();
  SetPublicId(state, {});
  state->links.clear();
  RefreshLinkList(state);
  SetRawInvitation(state, {});
  if (state->password) SetWindowTextW(state->password, L"");
}

void CompleteLogout(WindowState* state) {
  if (state->session) state->api.RevokeSession(*state->session);
  state->store.Remove();
  state->session.reset();
  state->logout_pending = false;
}

void FinishPendingUiAction(HWND window, WindowState* state) {
  if (state->logout_pending) CompleteLogout(state);
  if (state->close_pending) {
    DestroyWindow(window);
    return;
  }
}

void MarkRecoveryRequired(HWND window, WindowState* state,
                          std::string_view reason = std::string_view()) {
  // Tighten the durable Server state before refusing END whenever this shell
  // still has the exact current epoch. Failure to report does not make local
  // cleanup safe; the UI remains fail closed either way.
  if (!reason.empty() && state->session && state->privacy_epoch &&
      CurrentSession(*state)) {
    state->api.ReportPrivacyRecovery(
        *state->session, *state->privacy_epoch, state->expected_generation,
        reason);
  }
  ClearLocalSecretUi(state);
  state->privacy_recovery = true;
  SetStatus(state, kRecoveryStatus);
  FinishPendingUiAction(window, state);
}

void BeginPrivacy(HWND window, WindowState* state) {
  if (!CurrentSession(*state) || !CurrentLaunch(*state) ||
      state->privacy_epoch || state->privacy_recovery) {
    return;
  }
  const ClipboardCleanupStatus startup_cleanup = ReconcileClipboardWatchdog();
  if (startup_cleanup != ClipboardCleanupStatus::kClean) {
    // A previous shell/watchdog may still own a secret marker. Without its
    // exact old epoch identity this process cannot safely claim cleanup or END.
    MarkRecoveryRequired(window, state);
    return;
  }
  const auto epoch = state->api.BeginPrivacy(
      *state->session, *state->launch, state->expected_host_id,
      state->expected_generation, WallNow());
  if (!epoch) {
    MarkRecoveryRequired(window, state);
    return;
  }
  state->privacy_epoch = *epoch;
  state->privacy_active = epoch->phase == PrivacyPhase::kActive;
  SetTimer(window, kPrivacyPollTimer, kPrivacyPollIntervalMs, nullptr);
}

bool RequestBoundLaunch(HWND window, WindowState* state) {
  if (state->launch || !CurrentSession(*state) ||
      state->expected_host_id.empty() || state->privacy_recovery) {
    return false;
  }
  SetStatus(state, kBindingStatus);
  if (!state->api.RequestLaunchContext(*state->session,
                                       state->expected_host_id)) {
    SetStatus(state, kSignedInStatus);
    return false;
  }
  // The Server delivered the one-use context to Node before acknowledging the
  // request. Close this non-authorizing bootstrap; Node starts a fresh bound
  // process which reloads the protected Owner session and begins privacy.
  DestroyWindow(window);
  return true;
}

void RequestPrivacyEnd(HWND window, WindowState* state) {
  ClearLocalSecretUi(state);
  if (!state->privacy_epoch) {
    FinishPendingUiAction(window, state);
    return;
  }
  if (!CurrentSession(*state)) {
    MarkRecoveryRequired(window, state);
    return;
  }
  if (state->clipboard_cleanup_pending) {
    const ClipboardCleanupStatus cleanup = ReconcileClipboardWatchdog();
    if (cleanup == ClipboardCleanupStatus::kClean) {
      state->clipboard_cleanup_pending = false;
      state->clipboard_cleanup_deadline = 0;
      KillTimer(window, kClipboardPollTimer);
    } else if (cleanup == ClipboardCleanupStatus::kPending &&
               WallNow() <= state->clipboard_cleanup_deadline + 5'000) {
      SetStatus(state, kClipboardCleanupStatus);
      SetTimer(window, kClipboardPollTimer, kClipboardPollIntervalMs, nullptr);
      return;
    } else {
      MarkRecoveryRequired(
          window, state,
          cleanup == ClipboardCleanupStatus::kPending
              ? kClipboardWatchdogCrashedReason
              : kClipboardCleanupUncertainReason);
      return;
    }
  }
  const auto phase = state->api.EndPrivacy(*state->session,
                                            *state->privacy_epoch);
  if (!phase) {
    MarkRecoveryRequired(window, state);
    return;
  }
  state->privacy_epoch->phase = *phase;
  if (*phase == PrivacyPhase::kEnded) {
    state->privacy_epoch.reset();
    FinishPendingUiAction(window, state);
  } else {
    SetStatus(state, kPrivacyEndingStatus);
    SetTimer(window, kPrivacyPollTimer, kPrivacyPollIntervalMs, nullptr);
  }
}

void PollClipboardCleanup(HWND window, WindowState* state) {
  if (!state->clipboard_cleanup_pending || state->privacy_recovery) {
    KillTimer(window, kClipboardPollTimer);
    return;
  }
  const ClipboardCleanupStatus cleanup = ReconcileClipboardWatchdog();
  if (cleanup == ClipboardCleanupStatus::kClean) {
    state->clipboard_cleanup_pending = false;
    state->clipboard_cleanup_deadline = 0;
    KillTimer(window, kClipboardPollTimer);
    if (state->logout_pending || state->close_pending) {
      RequestPrivacyEnd(window, state);
    } else {
      RefreshUi(window, state);
    }
    return;
  }
  if (cleanup == ClipboardCleanupStatus::kFailed ||
      WallNow() > state->clipboard_cleanup_deadline + 5'000) {
    MarkRecoveryRequired(
        window, state,
        cleanup == ClipboardCleanupStatus::kFailed
            ? kClipboardCleanupUncertainReason
            : kClipboardWatchdogCrashedReason);
  }
}

void PollPrivacy(HWND window, WindowState* state) {
  if (!state->privacy_epoch || state->privacy_recovery) {
    KillTimer(window, kPrivacyPollTimer);
    return;
  }
  if (!CurrentSession(*state)) {
    MarkRecoveryRequired(window, state);
    KillTimer(window, kPrivacyPollTimer);
    return;
  }
  const auto phase = state->api.GetPrivacyStatus(*state->session,
                                                  *state->privacy_epoch);
  if (!phase) {
    MarkRecoveryRequired(window, state);
    KillTimer(window, kPrivacyPollTimer);
    return;
  }
  state->privacy_epoch->phase = *phase;
  switch (*phase) {
    case PrivacyPhase::kStarting:
      ClearLocalSecretUi(state);
      break;
    case PrivacyPhase::kActive:
      state->privacy_active = true;
      break;
    case PrivacyPhase::kEnding:
      ClearLocalSecretUi(state);
      SetStatus(state, kPrivacyEndingStatus);
      break;
    case PrivacyPhase::kRecoveryRequired:
      MarkRecoveryRequired(window, state);
      KillTimer(window, kPrivacyPollTimer);
      return;
    case PrivacyPhase::kEnded:
      ClearLocalSecretUi(state);
      state->privacy_epoch.reset();
      KillTimer(window, kPrivacyPollTimer);
      FinishPendingUiAction(window, state);
      return;
  }
  RefreshUi(window, state);
}

void RefreshUi(HWND window, WindowState* state) {
  const bool signed_in = CurrentSession(*state);
  const bool launch_current = CurrentLaunch(*state);
  const bool privacy = launch_current && state->privacy_active;
  const bool management_visible = signed_in && launch_current && privacy &&
                                  !state->privacy_recovery;
  ShowWindow(state->sign_in, signed_in ? SW_HIDE : SW_SHOW);
  ShowWindow(state->sign_out, signed_in ? SW_SHOW : SW_HIDE);
  ShowWindow(state->stop, launch_current ? SW_SHOW : SW_HIDE);
  ShowWindow(state->public_id_label, management_visible ? SW_SHOW : SW_HIDE);
  ShowWindow(state->rotate_public_id, management_visible ? SW_SHOW : SW_HIDE);
  EnableWindow(state->rotate_public_id, management_visible);
  const HWND management_controls[] = {
      state->link_label, state->link_kind, state->link_mode,
      state->link_duration, state->create_link, state->link_list,
      state->reduce_link, state->revoke_link, state->raw_invitation,
      state->copy_invitation, state->clear_invitation, state->password,
      state->set_password, state->change_password, state->disable_password};
  for (HWND control : management_controls) {
    if (control) ShowWindow(control, management_visible ? SW_SHOW : SW_HIDE);
  }
  const bool has_raw_invitation = management_visible &&
                                  !state->raw_invitation_link.empty();
  const bool has_pending_invitation = management_visible &&
                                      state->api.HasPendingInvitationCreation();
  EnableWindow(state->copy_invitation, has_raw_invitation &&
                                        !state->clipboard_cleanup_pending);
  EnableWindow(state->clear_invitation,
               has_raw_invitation || has_pending_invitation);
  EnableWindow(state->create_link, management_visible &&
                                    !state->clipboard_cleanup_pending);
  EnableWindow(state->reduce_link, management_visible);
  EnableWindow(state->revoke_link, management_visible);
  EnableWindow(state->set_password, management_visible);
  EnableWindow(state->change_password, management_visible);
  EnableWindow(state->disable_password, management_visible);
  if (management_visible && !state->metadata_attempted && state->session) {
    state->metadata_attempted = true;
    const auto public_id = state->api.GetOwnerPublicId(
        *state->session, state->expected_host_id);
    SetPublicId(state, public_id.value_or(std::string{}));
    const auto links = state->api.GetOwnerInvitationLinks(
        *state->session, state->expected_host_id);
    state->links = links.value_or(std::vector<OwnerInvitationLink>{});
    RefreshLinkList(state);
  }
  // Secret-bearing controls are created only as later actions need them. The
  // visible rotation action itself obtains a fresh browser-verified step-up;
  // its mutation call sets step_up_current only after native Bearer claim.
  const SecretUiState secret_gate{signed_in, launch_current, privacy, false};
  if (state->privacy_recovery) {
    SetStatus(state, kRecoveryStatus);
  } else if (state->clipboard_cleanup_pending) {
    SetStatus(state, kClipboardCleanupStatus);
  } else if (state->privacy_epoch &&
             state->privacy_epoch->phase == PrivacyPhase::kEnding) {
    SetStatus(state, kPrivacyEndingStatus);
  } else if (SecretUiEnabled(secret_gate)) {
    SetStatus(state, kPrivacyStatus);
  } else {
    SetStatus(state, signed_in ? (privacy ? kPrivacyStatus : kSignedInStatus)
                               : kSignedOutStatus);
  }
  InvalidateRect(window, nullptr, TRUE);
}

bool SignalLocalStop(const LaunchContext& launch) {
  const std::wstring launch_id(launch.launch_id.begin(), launch.launch_id.end());
  const std::wstring event_name =
      L"Local\\IMCodesRemoteDesktopStop-" + launch_id;
  HANDLE event = OpenEventW(EVENT_MODIFY_STATE, FALSE, event_name.c_str());
  if (!event) return false;
  const bool signaled = SetEvent(event) != FALSE;
  CloseHandle(event);
  return signaled;
}

bool CanManage(const WindowState& state) {
  return state.session && state.launch && state.privacy_epoch &&
         CurrentSession(state) && CurrentLaunch(state) &&
         state.privacy_active && !state.privacy_recovery;
}

SecretUiState CurrentSecretGate(const WindowState& state) {
  return SecretUiState{CurrentSession(state), CurrentLaunch(state),
                       state.privacy_active, false};
}

void ReloadLinks(WindowState* state) {
  if (!state->session || !CurrentSession(*state)) return;
  const auto links = state->api.GetOwnerInvitationLinks(
      *state->session, state->expected_host_id);
  state->links = links.value_or(std::vector<OwnerInvitationLink>{});
  RefreshLinkList(state);
}

std::optional<uint64_t> SelectedDuration(const WindowState& state) {
  const LRESULT selected = SendMessageW(state.link_duration, CB_GETCURSEL, 0, 0);
  switch (selected) {
    case 0:
      return 60ULL * 60 * 1000;
    case 1:
      return 6ULL * 60 * 60 * 1000;
    case 2:
      return 24ULL * 60 * 60 * 1000;
    case 3:
      return 7ULL * 24 * 60 * 60 * 1000;
    case 4:
      return 30ULL * 24 * 60 * 60 * 1000;
    default:
      return std::nullopt;
  }
}

void ExecutePasswordMutation(HWND window, WindowState* state,
                             PasswordMutationAction action) {
  if (!CanManage(*state)) return;
  std::string password;
  // A prior typed value never survives a disable attempt either. Passwords
  // are never copied and are never retained as UI confirmation state.
  if (action == PasswordMutationAction::kDisable && state->password) {
    SetWindowTextW(state->password, L"");
  }
  if (action != PasswordMutationAction::kDisable) {
    std::wstring wide = ReadControlText(state->password, 256);
    password = Utf8FromWide(wide);
    SecureClear(&wide);
    SetWindowTextW(state->password, L"");
    if (password.empty()) {
      MessageBoxW(window, L"Enter a valid unattended password.", kProductName,
                  MB_OK | MB_ICONWARNING);
      return;
    }
  }
  SetStatus(state, kStepUpStatus);
  const bool completed = state->api.MutateOwnerUnattendedPassword(
      *state->session, *state->launch, *state->privacy_epoch,
      CurrentSecretGate(*state), state->expected_host_id,
      state->expected_generation, action,
      action == PasswordMutationAction::kDisable ? nullptr : &password,
      WallNow());
  if (!password.empty()) {
    SecureZeroMemory(password.data(), password.size());
    password.clear();
  }
  if (!completed) {
    MessageBoxW(window, L"Password operation did not complete.", kProductName,
                MB_OK | MB_ICONWARNING);
  }
  RefreshUi(window, state);
}

void Paint(HWND window, WindowState* state) {
  PAINTSTRUCT paint{};
  HDC dc = BeginPaint(window, &paint);
  RECT client{};
  GetClientRect(window, &client);
  const bool high_contrast = IsHighContrast();
  const COLORREF background = GetSysColor(high_contrast ? COLOR_WINDOW : COLOR_3DFACE);
  HBRUSH brush = CreateSolidBrush(background);
  FillRect(dc, &client, brush);
  DeleteObject(brush);
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, GetSysColor(COLOR_WINDOWTEXT));
  RECT title{Scale(window, 92), Scale(window, 24), client.right - Scale(window, 16),
             Scale(window, 62)};
  DrawTextW(dc, kProductName, -1, &title, DT_LEFT | DT_VCENTER | DT_SINGLELINE);

  // Canonical compiled logo. Text remains independently visible as the
  // accessibility and high-contrast fallback.
  if (!high_contrast) {
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = 60;
    info.bmiHeader.biHeight = -60;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    StretchDIBits(dc, Scale(window, 20), Scale(window, 16), Scale(window, 60),
                  Scale(window, 60), 0, 0, 60, 60,
                  imcodes::rd::brand::kLogoBgra60, &info, DIB_RGB_COLORS,
                  SRCCOPY);
  }
  EndPaint(window, &paint);
  (void)state;
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam,
                            LPARAM lparam) {
  auto* state = reinterpret_cast<WindowState*>(
      GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
    state = static_cast<WindowState*>(create->lpCreateParams);
    SetWindowLongPtrW(window, GWLP_USERDATA,
                      reinterpret_cast<LONG_PTR>(state));
  }
  if (!state) return DefWindowProcW(window, message, wparam, lparam);
  switch (message) {
    case WM_CREATE: {
      state->status = CreateWindowExW(
          0, L"STATIC", kSignedOutStatus, WS_CHILD | WS_VISIBLE | SS_LEFT,
          20, 92, 460, 44, window, nullptr, GetModuleHandleW(nullptr), nullptr);
      state->sign_in = CreateWindowExW(
          0, L"BUTTON", kSignIn, WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
          20, 150, 230, 36, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kSignInButton)),
          GetModuleHandleW(nullptr), nullptr);
      state->sign_out = CreateWindowExW(
          0, L"BUTTON", kSignOut, WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
          20, 150, 120, 36, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kSignOutButton)),
          GetModuleHandleW(nullptr), nullptr);
      state->stop = CreateWindowExW(
          0, L"BUTTON", kStop, WS_CHILD | WS_TABSTOP | BS_DEFPUSHBUTTON,
          270, 150, 210, 36, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kStopButton)),
          GetModuleHandleW(nullptr), nullptr);
      state->public_id_label = CreateWindowExW(
          0, L"STATIC", kPublicIdUnavailable, WS_CHILD | SS_LEFT,
          20, 205, 460, 28, window, nullptr, GetModuleHandleW(nullptr), nullptr);
      state->rotate_public_id = CreateWindowExW(
          0, L"BUTTON", kRotatePublicId, WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
          20, 238, 180, 34, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kRotatePublicIdButton)),
          GetModuleHandleW(nullptr), nullptr);
      state->link_label = CreateWindowExW(
          WS_EX_CLIENTEDGE, L"EDIT", L"Remote desktop invite",
          WS_CHILD | WS_TABSTOP | ES_AUTOHSCROLL,
          220, 238, 250, 30, window, nullptr, GetModuleHandleW(nullptr), nullptr);
      SendMessageW(state->link_label, EM_SETLIMITTEXT, 256, 0);
      state->link_kind = CreateWindowExW(
          0, L"COMBOBOX", nullptr,
          WS_CHILD | WS_TABSTOP | CBS_DROPDOWNLIST | WS_VSCROLL,
          20, 282, 150, 160, window, nullptr, GetModuleHandleW(nullptr), nullptr);
      SendMessageW(state->link_kind, CB_ADDSTRING, 0,
                   reinterpret_cast<LPARAM>(L"Attended"));
      SendMessageW(state->link_kind, CB_ADDSTRING, 0,
                   reinterpret_cast<LPARAM>(L"Unattended"));
      SendMessageW(state->link_kind, CB_SETCURSEL, 0, 0);
      state->link_mode = CreateWindowExW(
          0, L"COMBOBOX", nullptr,
          WS_CHILD | WS_TABSTOP | CBS_DROPDOWNLIST | WS_VSCROLL,
          180, 282, 130, 140, window, nullptr, GetModuleHandleW(nullptr), nullptr);
      SendMessageW(state->link_mode, CB_ADDSTRING, 0,
                   reinterpret_cast<LPARAM>(L"View"));
      SendMessageW(state->link_mode, CB_ADDSTRING, 0,
                   reinterpret_cast<LPARAM>(L"Control"));
      SendMessageW(state->link_mode, CB_SETCURSEL, 0, 0);
      state->link_duration = CreateWindowExW(
          0, L"COMBOBOX", nullptr,
          WS_CHILD | WS_TABSTOP | CBS_DROPDOWNLIST | WS_VSCROLL,
          320, 282, 150, 180, window, nullptr, GetModuleHandleW(nullptr), nullptr);
      for (const wchar_t* duration : {L"1 hour", L"6 hours", L"24 hours",
                                      L"7 days", L"30 days"}) {
        SendMessageW(state->link_duration, CB_ADDSTRING, 0,
                     reinterpret_cast<LPARAM>(duration));
      }
      SendMessageW(state->link_duration, CB_SETCURSEL, 2, 0);
      state->create_link = CreateWindowExW(
          0, L"BUTTON", kCreateLink, WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
          490, 282, 270, 32, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kCreateLinkButton)),
          GetModuleHandleW(nullptr), nullptr);
      state->link_list = CreateWindowExW(
          WS_EX_CLIENTEDGE, L"LISTBOX", nullptr,
          WS_CHILD | WS_TABSTOP | LBS_NOTIFY | WS_VSCROLL,
          20, 326, 740, 105, window, nullptr, GetModuleHandleW(nullptr), nullptr);
      state->reduce_link = CreateWindowExW(
          0, L"BUTTON", kReduceLink, WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
          20, 440, 260, 32, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kReduceLinkButton)),
          GetModuleHandleW(nullptr), nullptr);
      state->revoke_link = CreateWindowExW(
          0, L"BUTTON", kRevokeLink, WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
          290, 440, 220, 32, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kRevokeLinkButton)),
          GetModuleHandleW(nullptr), nullptr);
      state->raw_invitation = CreateWindowExW(
          WS_EX_CLIENTEDGE, L"EDIT", L"",
          WS_CHILD | WS_TABSTOP | ES_READONLY | ES_AUTOHSCROLL,
          20, 482, 740, 30, window, nullptr, GetModuleHandleW(nullptr), nullptr);
      state->copy_invitation = CreateWindowExW(
          0, L"BUTTON", kCopyInvite, WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
          20, 520, 260, 32, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kCopyInviteButton)),
          GetModuleHandleW(nullptr), nullptr);
      state->clear_invitation = CreateWindowExW(
          0, L"BUTTON", kClearInvite, WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
          290, 520, 260, 32, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kClearInviteButton)),
          GetModuleHandleW(nullptr), nullptr);
      state->password = CreateWindowExW(
          WS_EX_CLIENTEDGE, L"EDIT", L"",
          WS_CHILD | WS_TABSTOP | ES_PASSWORD | ES_AUTOHSCROLL,
          20, 566, 300, 30, window, nullptr, GetModuleHandleW(nullptr), nullptr);
      SendMessageW(state->password, EM_SETLIMITTEXT, 256, 0);
      state->set_password = CreateWindowExW(
          0, L"BUTTON", kSetPassword, WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
          330, 566, 200, 32, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kSetPasswordButton)),
          GetModuleHandleW(nullptr), nullptr);
      state->change_password = CreateWindowExW(
          0, L"BUTTON", kChangePassword, WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
          540, 566, 220, 32, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kChangePasswordButton)),
          GetModuleHandleW(nullptr), nullptr);
      state->disable_password = CreateWindowExW(
          0, L"BUTTON", kDisablePassword, WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
          20, 606, 260, 32, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kDisablePasswordButton)),
          GetModuleHandleW(nullptr), nullptr);
      state->session = state->store.Load(state->expected_issuer);
      if (state->session && !state->launch) {
        PostMessageW(window, kRequestBoundLaunch, 0, 0);
      } else {
        BeginPrivacy(window, state);
      }
      RefreshUi(window, state);
      return 0;
    }
    case WM_COMMAND:
      switch (LOWORD(wparam)) {
        case kSignInButton: {
          const auto pkce = state->api.CreatePkceRequest();
          const auto authorization = pkce
              ? state->api.AuthorizeWithSystemBrowser(*pkce)
              : std::nullopt;
          auto session = pkce && authorization
              ? state->api.ExchangeAuthorizationCode(*pkce, *authorization)
              : std::nullopt;
          if (session && state->store.Save(*session, state->expected_issuer)) {
            state->session = std::move(session);
            if (!state->launch) {
              PostMessageW(window, kRequestBoundLaunch, 0, 0);
            } else {
              BeginPrivacy(window, state);
            }
          } else {
            MessageBoxW(window, L"Sign-in did not complete.", kProductName,
                        MB_OK | MB_ICONWARNING);
          }
          RefreshUi(window, state);
          return 0;
        }
        case kSignOutButton:
          state->logout_pending = true;
          RequestPrivacyEnd(window, state);
          RefreshUi(window, state);
          return 0;
        case kStopButton:
          if (!state->launch || !CurrentLaunch(*state) ||
              !SignalLocalStop(*state->launch)) {
            MessageBoxW(window, L"Local Stop is unavailable.", kProductName,
                        MB_OK | MB_ICONWARNING);
          }
          return 0;
        case kRotatePublicIdButton: {
          if (!state->session || !state->launch || !CurrentSession(*state) ||
              !CurrentLaunch(*state) || !state->privacy_active ||
              state->privacy_recovery) {
            return 0;
          }
          SetStatus(state, kStepUpStatus);
          const SecretUiState gate{true, true, true, false};
          const auto public_id = state->api.RotateOwnerPublicId(
              *state->session, *state->launch, gate,
              state->expected_host_id, state->expected_generation, WallNow());
          if (!public_id) {
            MessageBoxW(window, L"Public ID rotation did not complete.",
                        kProductName, MB_OK | MB_ICONWARNING);
          } else {
            SetPublicId(state, *public_id);
            state->metadata_attempted = true;
          }
          RefreshUi(window, state);
          return 0;
        }
        case kCreateLinkButton: {
          if (!CanManage(*state) || state->clipboard_cleanup_pending) return 0;
          std::wstring wide_label = ReadControlText(state->link_label, 256);
          std::string label = Utf8FromWide(wide_label);
          SecureClear(&wide_label);
          if (label.empty()) return 0;
          const InvitationLinkKind kind =
              SendMessageW(state->link_kind, CB_GETCURSEL, 0, 0) == 0
                  ? InvitationLinkKind::kAttended
                  : InvitationLinkKind::kUnattended;
          const InvitationLinkMode mode =
              SendMessageW(state->link_mode, CB_GETCURSEL, 0, 0) == 0
                  ? InvitationLinkMode::kView
                  : InvitationLinkMode::kControl;
          const std::optional<uint64_t> duration =
              kind == InvitationLinkKind::kAttended
                  ? std::nullopt
                  : SelectedDuration(*state);
          SetStatus(state, kStepUpStatus);
          auto created = state->api.CreateOwnerInvitationLink(
              *state->session, *state->launch, *state->privacy_epoch,
              CurrentSecretGate(*state), state->expected_host_id,
              state->expected_generation, kind, mode, label, duration,
              WallNow());
          SecureZeroMemory(label.data(), label.size());
          label.clear();
          if (!created) {
            MessageBoxW(window, L"Invitation creation did not complete.",
                        kProductName, MB_OK | MB_ICONWARNING);
          } else {
            SetRawInvitation(state, std::move(created->invitation_url));
            ReloadLinks(state);
          }
          RefreshUi(window, state);
          return 0;
        }
        case kReduceLinkButton:
        case kRevokeLinkButton: {
          if (!CanManage(*state)) return 0;
          const auto selected = SelectedLinkIndex(*state);
          if (!selected) return 0;
          const std::string link_id = state->links[*selected].id;
          SetStatus(state, kStepUpStatus);
          const auto updated = LOWORD(wparam) == kReduceLinkButton
              ? state->api.ReduceOwnerInvitationLinkToView(
                    *state->session, *state->launch, *state->privacy_epoch,
                    CurrentSecretGate(*state), state->expected_host_id,
                    state->expected_generation, link_id, WallNow())
              : state->api.RevokeOwnerInvitationLink(
                    *state->session, *state->launch, *state->privacy_epoch,
                    CurrentSecretGate(*state), state->expected_host_id,
                    state->expected_generation, link_id, WallNow());
          if (!updated) {
            MessageBoxW(window, L"Invitation mutation did not complete.",
                        kProductName, MB_OK | MB_ICONWARNING);
          }
          ReloadLinks(state);
          RefreshUi(window, state);
          return 0;
        }
        case kCopyInviteButton: {
          if (!CanManage(*state) || state->raw_invitation_link.empty() ||
              state->clipboard_cleanup_pending) {
            return 0;
          }
          uint64_t cleanup_deadline = 0;
          const bool copied = CopyInvitationLinkWithWatchdog(
              state->raw_invitation_link, state->privacy_epoch->epoch_id,
              &cleanup_deadline);
          if (!copied) {
            MarkRecoveryRequired(window, state,
                                 kClipboardWatchdogFailedReason);
            return 0;
          }
          state->clipboard_cleanup_pending = true;
          state->clipboard_cleanup_deadline = cleanup_deadline;
          SetRawInvitation(state, {});
          SetTimer(window, kClipboardPollTimer, kClipboardPollIntervalMs,
                   nullptr);
          RefreshUi(window, state);
          return 0;
        }
        case kClearInviteButton:
          state->api.ClearPendingInvitationCreation();
          SetRawInvitation(state, {});
          RefreshUi(window, state);
          return 0;
        case kSetPasswordButton:
          ExecutePasswordMutation(window, state,
                                  PasswordMutationAction::kSet);
          return 0;
        case kChangePasswordButton:
          ExecutePasswordMutation(window, state,
                                  PasswordMutationAction::kChange);
          return 0;
        case kDisablePasswordButton:
          ExecutePasswordMutation(window, state,
                                  PasswordMutationAction::kDisable);
          return 0;
      }
      break;
    case kRequestBoundLaunch:
      RequestBoundLaunch(window, state);
      return 0;
    case WM_TIMER:
      if (wparam == kPrivacyPollTimer) {
        PollPrivacy(window, state);
        return 0;
      }
      if (wparam == kClipboardPollTimer) {
        PollClipboardCleanup(window, state);
        return 0;
      }
      break;
    case WM_DPICHANGED: {
      const RECT* suggested = reinterpret_cast<const RECT*>(lparam);
      SetWindowPos(window, nullptr, suggested->left, suggested->top,
                   suggested->right - suggested->left,
                   suggested->bottom - suggested->top,
                   SWP_NOACTIVATE | SWP_NOZORDER);
      return 0;
    }
    case WM_SETTINGCHANGE:
      InvalidateRect(window, nullptr, TRUE);
      return 0;
    case WM_PAINT:
      Paint(window, state);
      return 0;
    case WM_CLOSE:
      state->close_pending = true;
      RequestPrivacyEnd(window, state);
      return 0;
    case WM_DESTROY:
      KillTimer(window, kPrivacyPollTimer);
      KillTimer(window, kClipboardPollTimer);
      ClearLocalSecretUi(state);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

}  // namespace

int RunAccountShell(std::wstring server_origin,
                    std::optional<LaunchContext> launch_context,
                    std::string expected_host_id,
                    uint64_t expected_endpoint_generation) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  WindowState state(std::move(server_origin), std::move(launch_context),
                    std::move(expected_host_id), expected_endpoint_generation);
  // The separately validated public origin configures TLS requests only. The
  // launch context remains non-authorizing and carries no Server URL/account
  // authority.
  WNDCLASSEXW window_class{sizeof(window_class)};
  window_class.lpfnWndProc = WindowProc;
  window_class.hInstance = GetModuleHandleW(nullptr);
  window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  window_class.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  window_class.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  window_class.lpszClassName = kWindowClass;
  if (!RegisterClassExW(&window_class) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
    return 3;
  }
  HWND window = CreateWindowExW(
      WS_EX_APPWINDOW, kWindowClass, kProductName,
      WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
      CW_USEDEFAULT, CW_USEDEFAULT, 800, 700, nullptr, nullptr,
      window_class.hInstance, &state);
  if (!window) return 4;
  ShowWindow(window, SW_SHOWNORMAL);
  UpdateWindow(window);
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  return static_cast<int>(message.wParam);
}

}  // namespace imcodes::remote_desktop::account_shell
