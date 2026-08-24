import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const policyHeader = readFileSync(
  new URL('../../native/windows-remote-desktop/account_shell_policy.h', import.meta.url),
  'utf8',
);
const policySource = readFileSync(
  new URL('../../native/windows-remote-desktop/account_shell_policy.cc', import.meta.url),
  'utf8',
);
const shellHeader = readFileSync(
  new URL('../../native/windows-remote-desktop/account_shell.h', import.meta.url),
  'utf8',
);
const shellSource = readFileSync(
  new URL('../../native/windows-remote-desktop/account_shell.cc', import.meta.url),
  'utf8',
);
const shellUi = readFileSync(
  new URL('../../native/windows-remote-desktop/account_shell_ui.cc', import.meta.url),
  'utf8',
);
const shellMain = readFileSync(
  new URL('../../native/windows-remote-desktop/account_shell_main.cc', import.meta.url),
  'utf8',
);
const buildScript = readFileSync(
  new URL('../../native/windows-remote-desktop/build-account-shell.ps1', import.meta.url),
  'utf8',
);
const selftest = readFileSync(
  new URL('../../native/windows-remote-desktop/account_shell_policy_selftest.cc', import.meta.url),
  'utf8',
);
const guestLinksIntegration = readFileSync(
  new URL('../../server/test/remote-desktop-guest-links.integration.test.ts', import.meta.url),
  'utf8',
);

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `missing ${signature}`).toBeGreaterThanOrEqual(0);
  const brace = source.indexOf('{', start);
  expect(brace, `missing body for ${signature}`).toBeGreaterThan(start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(brace, index + 1);
  }
  throw new Error(`unterminated body for ${signature}`);
}

describe('Windows remote-desktop account-shell policy foundation', () => {
  it('pins the fixed public client and exact loopback redirect', () => {
    expect(policyHeader).toContain('imcodes-controlled-shell-v1');
    expect(policyHeader).toContain('imcodes-remote-desktop-management');
    expect(policyHeader).toContain('http://127.0.0.1:19139/oauth/callback');
    expect(policyHeader).not.toMatch(/0\.0\.0\.0|localhost|:\d+\/oauth\/callback.*\*/);
  });

  it('requires exact host, endpoint generation and a bounded current launch context', () => {
    expect(policyHeader).toContain('kMaximumLaunchLifetimeMs = 60 * 1000');
    expect(policySource).toContain('context.host_id == expected_host_id');
    expect(policySource).toContain('context.endpoint_generation == expected_endpoint_generation');
    expect(policySource).toContain('context.expires_at - context.issued_at <=');
    expect(policySource).toContain('now_ms >= context.issued_at && now_ms < context.expires_at');
    expect(selftest).toContain('ValidateLaunchContext(context, "other_123"');
    expect(selftest).toContain('ValidateLaunchContext(context, "host_1234", 8');
    expect(policyHeader).toContain('std::string launch_id;');
    expect(policyHeader).not.toMatch(/privacy_epoch|privacy_revision/i);
    const launchStruct = policyHeader.slice(
      policyHeader.indexOf('struct LaunchContext {'),
      policyHeader.indexOf('};', policyHeader.indexOf('struct LaunchContext {')),
    );
    const members = [...launchStruct.matchAll(/(?:std::string|uint64_t)\s+(\w+)/g)]
      .map((match) => match[1]);
    expect(members).toEqual([
      'host_id',
      'launch_id',
      'endpoint_generation',
      'issued_at',
      'expires_at',
    ]);
  });

  it('strictly consumes the current Node launch argv and exact base64url context', () => {
    expect(shellMain).toContain('L"--remote-desktop-signed-shell"');
    expect(shellMain).toContain('L"--launch-context-b64"');
    expect(shellMain).toContain('L"--server-origin"');
    expect(shellMain).toContain('L"--bootstrap-host-id"');
    expect(shellMain).toContain('if (count != 6');
    expect(shellMain).toContain('IsCanonicalNetworkOrigin(');
    expect(shellMain).toContain('InetPtonW(AF_INET6');
    expect(shellMain).toContain('InetNtopW(AF_INET6');
    expect(shellMain).toContain('DecodeBase64Url(encoded)');
    expect(shellMain).toContain('CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT');
    expect(shellMain).toContain('Unknown and duplicate fields are equally invalid');
    expect(shellMain).toContain('!host || !launch || !issued ||');
    expect(shellMain).toContain('ValidateLaunchContext(');
    expect(shellMain).not.toMatch(/privacyEpoch|privacyRevision|privacy_epoch|privacy_revision/);
    expect(shellMain).toContain('std::wstring(server_origin)');
    expect(shellMain).toContain('std::nullopt');
    expect(policySource).toContain('value.starts_with(prefix)');
    expect(policySource).toContain('authority.find_first_of');
    expect(policySource).toContain('port != 443');
  });

  it('keeps secret UI behind sign-in, local presentation, privacy and step-up', () => {
    expect(policySource).toMatch(/state\.signed_in\s*&&\s*state\.launch_context_current\s*&&\s*\n?\s*state\.privacy_active\s*&&\s*state\.step_up_current/);
    expect(selftest).toContain('SecretUiEnabled({true, true, true, false})');
    expect(selftest).toContain('SecretUiEnabled({true, true, true, true})');
  });

  it('keeps account credentials out of native and bounds unattended password handling', () => {
    const combined = `${policyHeader}\n${policySource}\n${shellHeader}\n${shellSource}\n${shellUi}\n${shellMain}`;
    expect(combined).not.toMatch(/collectAccountPassword|accountPassword|nodeCredential|daemonToken|localAdmin/i);
    expect(shellHeader).toContain('no account password or');
    expect(shellHeader).toContain('browser cookie enters native');
    expect(shellHeader).toContain('one bounded mutation buffer');
    expect(shellHeader).toContain('callers must not call EndPrivacy');
    expect(shellMain).not.toMatch(/--(?:password|token|cookie|link|privacy-epoch)/i);
    expect(shellUi).toContain('WS_TABSTOP | ES_PASSWORD');
    expect(shellUi).toContain('SetWindowTextW(state->password, L"")');
    expect(shellSource).toContain('if (password) SecureClear(password);');
    expect(shellSource).not.toMatch(/CopyPassword|WriteShellOwnedPassword/);
  });

  it('uses the system browser with S256 and binds an exact loopback listener before launch', () => {
    const listen = shellSource.indexOf('auto listener = CreateExactLoopbackListener();');
    const launch = shellSource.indexOf('ShellExecuteW(');
    expect(listen).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(listen);
    expect(shellSource).toContain('address.sin_addr');
    expect(shellSource).toContain('InetPtonW(AF_INET, L"127.0.0.1"');
    expect(shellSource).toContain('code_challenge_method=S256');
    expect(shellSource).toContain('BCryptGenRandom(');
    expect(shellSource).toContain('BCRYPT_SHA256_ALGORITHM');
    expect(shellSource).toContain('result.state != request.state');
    expect(shellSource).not.toMatch(/WebView|IWebBrowser|InternetExplorer/i);
  });

  it('stores only the native account session under CurrentUser DPAPI', () => {
    expect(shellSource).toContain('CryptProtectData(&input');
    expect(shellSource).toContain('CryptUnprotectData(&input');
    expect(shellSource).toContain('FOLDERID_LocalAppData');
    expect(shellSource).toContain('account-session.bin');
    expect(shellSource).toContain('FILE_FLAG_OPEN_REPARSE_POINT');
    expect(shellSource).not.toContain('CRYPTPROTECT_LOCAL_MACHINE');
    expect(shellSource).toContain('ValidateSessionState(session->state');
  });

  it('uses bearer Owner APIs and requires a fresh bounded step-up envelope', () => {
    expect(shellSource).toContain('L"/api/auth/remote-desktop/step-up/begin"');
    expect(shellSource).toContain('L"/api/auth/remote-desktop/step-up/native/claim"');
    expect(shellSource).toContain('L"/remote-desktop/native-step-up?challengeId="');
    expect(shellSource).toContain('The browser receives only the non-authorizing challenge identifier');
    expect(shellSource).toContain('step_up.grant_token');
    expect(shellSource).toContain('SecureZeroMemory(step_up->grant_token.data()');
    expect(shellSource).toContain('L"/api/auth/remote-desktop/native/session/revoke"');
    expect(shellSource).toContain('L"/api/auth/remote-desktop/shell/launch-context/issue"');
    expect(shellSource).toContain('L"Authorization: Bearer "');
    expect(shellSource).toContain('IsCanonicalBase64Url32(request_id)');
    expect(shellSource).toContain('canonical_action_json.size() > 16 * 1024');
    expect(shellSource).toContain('deadline - now > kMaximumStepUpLifetimeMs');
    expect(shellHeader).toContain('GetOwnerMetadata(');
    expect(shellHeader).toContain('CallOwnerMutation(');
    expect(shellHeader).toContain('const SecretUiState& secret_ui');
    expect(shellSource).toContain('return Request(L"GET", path_and_query, {}, session.access_token);');
    expect(shellSource).toContain('!ValidateLaunchContext(launch_context');
    expect(shellSource).toContain('!SecretUiEnabled(secret_ui)');
    expect(shellSource).not.toContain('SecretUiEnabled({true, true, true, true})');
    expect(shellSource).toContain('!ValidateStepUpState(*step_up');
    expect(shellSource).toContain('if (!ConsumeStepUp(step_up');
    expect(shellSource).toContain('path_and_query.starts_with(L"/api/remote-desktop/")');
    expect(policySource).toContain('state->consumed = true;');
    expect(selftest).toContain('!ConsumeStepUp(&step_up');
    expect(selftest).toContain('ConsumeStepUp(&step_up');
    expect(selftest).toContain('missing_grant.grant_token.clear()');
    expect(shellSource).toContain('RotateOwnerPublicId(');
    expect(shellSource).toContain('remote_desktop.public_id.rotate');
    expect(shellUi).toContain('kRotatePublicIdButton');
    expect(shellUi).toContain('state->api.RotateOwnerPublicId(');
  });

  it('uses the exact Owner link and password APIs with one fresh step-up per mutation', () => {
    expect(shellSource).toContain('L"/api/remote-desktop/guest/links?hostId="');
    expect(shellSource).toContain('L"/api/remote-desktop/guest/links"');
    expect(shellSource).toContain('L"/api/remote-desktop/guest/links/"');
    expect(shellSource).toContain('L"/api/remote-desktop/unattended-password"');
    expect(shellSource).toContain('remote_desktop.link.create');
    expect(shellSource).toContain('remote_desktop.link.mutate');
    expect(shellSource).toContain('remote_desktop.unattended_password.mutation.v1');
    expect(shellSource).toContain('"reduce_to_view", L"PATCH"');
    expect(shellSource).toContain('expected_endpoint_generation, link_id, "revoke"');
    expect(shellSource).toContain('L"DELETE", now_ms');

    const create = functionBody(shellSource, 'OwnerApiClient::CreateOwnerInvitationLink(');
    const mutate = functionBody(shellSource, 'std::optional<OwnerInvitationLink> MutateOwnerInvitationLink(');
    const password = functionBody(shellSource, 'bool OwnerApiClient::MutateOwnerUnattendedPassword(');
    for (const body of [create, mutate, password]) {
      expect(body).toContain('CreateRequestId()');
      expect(body).toContain('BeginStepUp(');
      expect(body).toContain('CompleteStepUpWithSystemBrowser(');
      expect(body).toContain('CallOwnerMutation(');
      expect(body).toContain('UnixMillisecondsNow()');
    }
    expect(password).toContain('if (password) SecureClear(password);');
    expect(password).toContain('action != PasswordMutationAction::kDisable');
    expect(password).toContain('static_cast<unsigned char>(value) < 0x20');
    expect(shellUi).toContain('PasswordMutationAction::kSet');
    expect(shellUi).toContain('PasswordMutationAction::kChange');
    expect(shellUi).toContain('PasswordMutationAction::kDisable');
  });

  it('keeps the raw invite transient and copies it only after the watchdog is durable-ready', () => {
    const create = functionBody(shellSource, 'OwnerApiClient::CreateOwnerInvitationLink(');
    const complete = functionBody(shellSource, 'OwnerApiClient::CompletePendingInvitationCreation(');
    const copy = functionBody(shellSource, 'bool CopyInvitationLinkWithWatchdog(');
    expect(create).toContain('kLinkHashDomain');
    expect(create).toContain('tokenHashVersion');
    expect(create).toContain('SecureClear(&raw_token);');
    expect(create.indexOf('CallOwnerMutation(')).toBeLessThan(
      create.indexOf('CompletePendingInvitationCreation(response)'),
    );
    expect(complete).toContain('created.invitation_url =');
    expect(shellUi).toContain('std::wstring raw_invitation_link;');
    expect(shellUi).toContain('SetRawInvitation(state, {});');
    expect(shellUi).toContain('CopyInvitationLinkWithWatchdog(');
    expect(shellUi).not.toContain('SetClipboardData(');
    expect(copy).toContain('RunWatchdogProcess(arguments, kWatchdogReadyTimeoutMs');
    expect(copy).toContain('WriteInvitationClipboard(invitation_link)');
    expect(copy.indexOf('RunWatchdogProcess(')).toBeLessThan(
      copy.indexOf('WriteInvitationClipboard('),
    );
    expect(copy).not.toMatch(/password/i);
  });

  it('replays one exact in-memory creation tuple after an indeterminate response', () => {
    const create = functionBody(shellSource, 'OwnerApiClient::CreateOwnerInvitationLink(');
    const retry = functionBody(shellSource, 'OwnerApiClient::DispatchPendingInvitationCreation(');
    const complete = functionBody(shellSource, 'OwnerApiClient::CompletePendingInvitationCreation(');
    const clear = functionBody(shellSource, 'void OwnerApiClient::ClearPendingInvitationCreation()');
    expect(shellHeader).toContain('struct PendingInvitationCreation {');
    for (const field of [
      'creation_request_id', 'raw_token', 'token_hash', 'policy_hash',
      'request_json', 'action_digest', 'grant_token',
    ]) {
      expect(shellHeader).toContain(field);
    }
    expect(create.indexOf('if (pending_invitation_creation_)')).toBeLessThan(
      create.indexOf('BCryptGenRandom('),
    );
    expect(create).toContain('pending.creation_request_id = *request_id;');
    expect(create).toContain('pending.raw_token = raw_token;');
    expect(create).toContain('pending.grant_token = step_up->grant_token;');
    expect(create).toContain('pending_invitation_creation_ = std::move(pending);');
    expect(retry).toContain('pending.request_json');
    expect(retry).toContain('JsonEscape(pending.grant_token)');
    expect(retry).not.toContain('CreateRequestId()');
    expect(retry).not.toContain('BeginStepUp(');
    expect(complete).toContain('if (!response) return std::nullopt;');
    expect(complete.indexOf('created.invitation_url =')).toBeLessThan(
      complete.lastIndexOf('ClearPendingInvitationCreation();'),
    );
    expect(clear).toContain('SecureClear(&pending_invitation_creation_->raw_token);');
    expect(clear).toContain('SecureClear(&pending_invitation_creation_->grant_token);');
    expect(shellUi).toContain('state->api.ClearPendingInvitationCreation();');
    expect(shellUi).toContain('state->api.HasPendingInvitationCreation();');

    // The native retry uses the same consumed grant because the Server's real
    // PostgreSQL counterfactual proves this returns one original result/row.
    expect(guestLinksIntegration).toContain(
      'replays the identical result for an exact retry after a lost response',
    );
    expect(guestLinksIntegration).toContain('stepUpToken: first.grant');
    expect(guestLinksIntegration).toContain('expect(second.link.id).toBe(first.link.id)');
    expect(guestLinksIntegration).toContain('expect(all).toHaveLength(1)');
  });

  it('reports exact clipboard recovery before refusing privacy END', () => {
    const report = functionBody(shellSource, 'bool OwnerApiClient::ReportPrivacyRecovery(');
    const mark = functionBody(shellUi, 'void MarkRecoveryRequired(');
    const end = functionBody(shellUi, 'void RequestPrivacyEnd(');
    const poll = functionBody(shellUi, 'void PollClipboardCleanup(');
    expect(report).toContain('L"/api/remote-desktop/guest/privacy/recovery"');
    expect(report).toContain(String.raw`{\"hostId\":\"`);
    expect(report).toContain(String.raw`\",\"epochId\":\"`);
    expect(report).toContain(String.raw`\",\"revision\":`);
    expect(report).toContain(String.raw`,\"endpointGeneration\":`);
    expect(report).toContain(String.raw`,\"reason\":\"`);
    expect(report).toContain(String.raw`{\"status\":\"recovery_required\"}`);
    expect(report).not.toMatch(/password|clipboard(?:Text|_text)|raw_invitation/i);
    expect(mark.indexOf('state->api.ReportPrivacyRecovery(')).toBeLessThan(
      mark.indexOf('FinishPendingUiAction(window, state);'),
    );
    expect(end.indexOf('kClipboardWatchdogCrashedReason')).toBeLessThan(
      end.indexOf('state->api.EndPrivacy('),
    );
    expect(end.indexOf('kClipboardCleanupUncertainReason')).toBeLessThan(
      end.indexOf('state->api.EndPrivacy('),
    );
    expect(poll).toContain('kClipboardCleanupUncertainReason');
    expect(poll).toContain('kClipboardWatchdogCrashedReason');
    expect(policyHeader).toContain('"clipboard_watchdog_failed"');
    expect(policyHeader).toContain('"clipboard_watchdog_crashed"');
    expect(policyHeader).toContain('"clipboard_cleanup_uncertain"');
  });

  it('redeems launch context only to begin privacy and gates UI on authoritative active state', () => {
    expect(shellHeader).toContain('BeginPrivacy(');
    expect(shellHeader).toContain('GetPrivacyStatus(');
    expect(shellHeader).toContain('EndPrivacy(');
    expect(shellSource).toContain('L"/api/remote-desktop/guest/privacy/begin"');
    expect(shellSource).toContain('L"/api/remote-desktop/guest/privacy/status?hostId="');
    expect(shellSource).toContain('L"/api/remote-desktop/guest/privacy/end"');
    expect(shellSource).toContain('Bearer account authority remains the sole Owner');
    expect(shellSource).toContain('response->body != canonical');
    expect(shellUi).toContain('state->privacy_active = epoch->phase == PrivacyPhase::kActive;');
    expect(shellUi).toContain('case PrivacyPhase::kActive:');
    expect(shellUi).toContain('case PrivacyPhase::kRecoveryRequired:');
    expect(shellUi).toContain('ClearLocalSecretUi(state);');
    expect(shellUi.indexOf('ClearLocalSecretUi(state);', shellUi.indexOf('void RequestPrivacyEnd')))
      .toBeLessThan(shellUi.indexOf('state->api.EndPrivacy(', shellUi.indexOf('void RequestPrivacyEnd')));
    expect(shellUi).toContain('state->logout_pending = true;');
    expect(shellUi).toContain('state->close_pending = true;');
    expect(shellUi).toContain('SetTimer(window, kPrivacyPollTimer');
    expect(shellUi).toContain('RequestBoundLaunch(HWND window, WindowState* state)');
    expect(shellUi).toContain('state->api.RequestLaunchContext(');
    expect(shellUi).toContain('DestroyWindow(window);');
  });

  it('keeps bootstrap non-authorizing until a fresh bound process owns the exact launch context', () => {
    const main = functionBody(shellMain, 'int Main(');
    const beginPrivacy = functionBody(shellUi, 'void BeginPrivacy(');
    const requestBoundLaunch = functionBody(shellUi, 'bool RequestBoundLaunch(');

    const isNonAuthorizing = (candidateMain: string, candidateBegin: string, candidateRequest: string) => {
      const bootstrap = candidateMain.slice(candidateMain.indexOf('if (binding == kBootstrapHostArgument)'));
      const launchGuard = candidateBegin.indexOf('!CurrentLaunch(*state)');
      const privacyCall = candidateBegin.indexOf('state->api.BeginPrivacy(');
      return bootstrap.includes('std::wstring(server_origin), std::nullopt,')
        && bootstrap.includes('NarrowValidatedAscii(host), 0)')
        && !bootstrap.includes('DecodeLaunchContext(arguments[5])')
        && launchGuard >= 0 && privacyCall > launchGuard
        && candidateRequest.includes('state->api.RequestLaunchContext(')
        && !/BeginPrivacy|BeginStepUp|CallOwnerMutation|GetOwnerMetadata|EndPrivacy|SecretUiEnabled/.test(candidateRequest);
    };

    expect(isNonAuthorizing(main, beginPrivacy, requestBoundLaunch)).toBe(true);

    // Positive controls: each unsafe implementation strategy must turn the
    // gate red, proving this is not a comment/source-presence-only assertion.
    expect(isNonAuthorizing(
      main.replace('std::wstring(server_origin), std::nullopt,',
        'std::wstring(server_origin), LaunchContext{},'),
      beginPrivacy,
      requestBoundLaunch,
    )).toBe(false);
    expect(isNonAuthorizing(
      main,
      beginPrivacy.replace('!CurrentLaunch(*state) ||', ''),
      requestBoundLaunch,
    )).toBe(false);
    expect(isNonAuthorizing(
      main,
      beginPrivacy,
      requestBoundLaunch.replace('state->api.RequestLaunchContext(', 'state->api.BeginPrivacy('),
    )).toBe(false);
  });

  it('hides controls on logout, revocation, expiry, or stale privacy context', () => {
    expect(shellUi).toContain('ShowWindow(state->sign_in, signed_in ? SW_HIDE : SW_SHOW);');
    expect(shellUi).toContain('ShowWindow(state->sign_out, signed_in ? SW_SHOW : SW_HIDE);');
    expect(shellUi).toContain('ShowWindow(state->stop, launch_current ? SW_SHOW : SW_HIDE);');
    expect(shellUi).toContain('const SecretUiState secret_gate{signed_in, launch_current, privacy, false};');
    expect(shellUi).toContain('bool privacy_active = false;');
    expect(shellUi).toContain('if (SecretUiEnabled(secret_gate))');
    expect(shellUi).toContain('state->store.Remove();');
    expect(shellUi).toContain('state->session.reset();');
    expect(policySource).toContain('!state.revoked');
    expect(policySource).toContain('state.expires_at > now_ms');
  });

  it('uses canonical compiled branding with DPI, high contrast and accessible native controls', () => {
    expect(shellUi).toContain('#include "third_party/imcodes_remote_desktop/brand_logo_generated.h"');
    expect(shellUi).toContain('kLogoBgra60');
    expect(shellUi).toContain('kProductName[] = L"IM.codes Remote Desktop"');
    expect(shellUi).toContain('DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2');
    expect(shellUi).toContain('SPI_GETHIGHCONTRAST');
    expect(shellUi).toContain('HCF_HIGHCONTRASTON');
    expect(shellUi).toContain('WS_TABSTOP | BS_PUSHBUTTON');
    expect(shellUi).toContain('WS_TABSTOP | BS_DEFPUSHBUTTON');
  });

  it('builds and Authenticode-signs a separate artifact, deleting it on signing failure', () => {
    expect(buildScript).toContain("'imcodes-remote-desktop-account-shell.exe'");
    expect(buildScript).toContain('& $SigningScript -Mode Sign -ArtifactPath $AccountShell');
    expect(buildScript).toContain('Remove-Item -Force -LiteralPath $AccountShell');
    expect(buildScript).toContain('account_shell_policy_selftest.cc');
    expect(buildScript).toContain('/W4 /WX');
    expect(buildScript).not.toContain('build-worker.ps1');
  });

  it('has counterfactual guards for critical trust and ordering checks', () => {
    const guards = [
      [shellSource, 'auto listener = CreateExactLoopbackListener();'],
      [shellSource, 'result.state != request.state'],
      [shellSource, 'CryptProtectData(&input'],
      [shellSource, 'CRYPTPROTECT_UI_FORBIDDEN'],
      [shellSource, 'ValidateSessionState(session->state'],
      [shellSource, 'IsCanonicalBase64Url32(request_id)'],
      [shellUi, 'if (SecretUiEnabled(secret_gate))'],
      [shellMain, 'if (count != 6'],
      [shellMain, 'IsCanonicalNetworkOrigin('],
      [shellMain, 'CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT'],
      [buildScript, 'Remove-Item -Force -LiteralPath $AccountShell'],
    ] as const;
    const satisfies = (values: readonly string[]) => guards.every(([, needle], index) => (
      values[index]!.includes(needle)
    ));
    const originals = guards.map(([source]) => source);
    expect(satisfies(originals)).toBe(true);
    for (let index = 0; index < guards.length; index += 1) {
      const mutated = [...originals];
      mutated[index] = mutated[index]!.split(guards[index]![1]).join('');
      expect(satisfies(mutated), `guard ${guards[index]![1]} must be non-vacuous`).toBe(false);
    }
  });
});
