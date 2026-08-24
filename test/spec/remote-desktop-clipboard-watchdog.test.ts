import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REMOTE_DESKTOP_PRIVACY_LIMITS } from '../../shared/remote-desktop-access.js';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = resolve(ROOT, 'native', 'windows-remote-desktop');

function native(name: string): string {
  return readFileSync(resolve(NATIVE, name), 'utf8');
}

const sources = {
  header: native('clipboard_watchdog.h'),
  implementation: native('clipboard_watchdog.cc'),
  main: native('clipboard_watchdog_main.cc'),
  policy: native('clipboard_watchdog_policy.cc'),
  policyHeader: native('clipboard_watchdog_policy.h'),
  selftest: native('clipboard_watchdog_policy_selftest.cc'),
  shellHeader: native('account_shell.h'),
  shell: native('account_shell.cc'),
  shellUi: native('account_shell_ui.cc'),
  build: native('build-clipboard-watchdog.ps1'),
  install: native('install-clipboard-watchdog-lifecycle.ps1'),
  workerHost: readFileSync(resolve(ROOT, 'src/node/remote-desktop-worker-host.ts'), 'utf8'),
  nodeRuntime: readFileSync(resolve(ROOT, 'src/node/runtime.ts'), 'utf8'),
};

interface Guard {
  source: keyof typeof sources;
  needle: string;
}

const criticalGuards: Guard[] = [
  { source: 'implementation', needle: 'if (!PersistMarker(marker)) return 11;' },
  { source: 'implementation', needle: 'const bool signaled = SetEvent(ready) != FALSE;' },
  { source: 'implementation', needle: 'CryptProtectData(&input' },
  { source: 'implementation', needle: 'CryptUnprotectData(&input' },
  { source: 'implementation', needle: 'if (!instance.acquired()) return 16;' },
  { source: 'implementation', needle: 'request.deadline_unix_ms - wall_now > kCleanupDelayMs' },
  { source: 'implementation', needle: 'std::chrono::steady_clock::now() < monotonic_deadline' },
  { source: 'implementation', needle: 'ShouldAdoptClipboard(request.baseline_sequence, current_sequence,' },
  { source: 'policy', needle: 'if (!expected_hash_matches) return CleanupDecision::kPreserveReplacement;' },
  { source: 'policy', needle: 'recorded_sequence != current_sequence' },
  { source: 'implementation', needle: 'if (!ReadOpenClipboardHash(&current_sequence, &has_text, &current_hash))' },
  { source: 'implementation', needle: 'SetOptOutFormat(history) && SetOptOutFormat(cloud)' },
  { source: 'implementation', needle: 'return ReconcileMarker(marker);' },
  { source: 'build', needle: "[Parameter(Mandatory = $true)]\n  [string]$CodeSigningCertificateThumbprint" },
  { source: 'build', needle: "& $SigningScript -Mode Sign -ArtifactPath $Watchdog" },
  { source: 'build', needle: 'bcrypt.lib crypt32.lib ole32.lib shell32.lib user32.lib uuid.lib' },
  { source: 'install', needle: "& $SigningScript -Mode Verify -ArtifactPath $ResolvedWatchdog" },
  { source: 'install', needle: "throw 'Watchdog must be installed beneath a protected Program Files root.'" },
  { source: 'install', needle: "-ArgumentList '--sanitize'" },
];

function satisfiesGuards(candidate: typeof sources): boolean {
  return criticalGuards.every(({ source, needle }) => candidate[source].includes(needle));
}

describe('signed account clipboard watchdog safety boundary', () => {
  it('uses the exact shared sixty-second cleanup duration', () => {
    const match = sources.policyHeader.match(/kCleanupDelayMs\s*=\s*([\d']+);/);
    expect(match).not.toBeNull();
    expect(Number(match![1]!.replaceAll("'", '')))
      .toBe(REMOTE_DESKTOP_PRIVACY_LIMITS.CLIPBOARD_CLEANUP_MS);
  });

  it('writes a per-user DPAPI WAL before the shell may copy', () => {
    const persist = sources.implementation.indexOf('if (!PersistMarker(marker)) return 11;');
    const ready = sources.implementation.indexOf('const bool signaled = SetEvent(ready) != FALSE;');
    expect(persist).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(persist);
    expect(sources.implementation).toContain('CryptProtectData(&input');
    expect(sources.implementation).toContain('CryptUnprotectData(&input');
    expect(sources.implementation).toContain('FOLDERID_LocalAppData');
    expect(sources.implementation).toContain('L"Local\\\\IMCodesClipboardWatchdog"');
    expect(sources.implementation).not.toContain('CRYPTPROTECT_LOCAL_MACHINE');
    const marker = sources.implementation.match(
      /struct PersistedMarker \{[\s\S]*?\n\};\n#pragma pack\(pop\)/,
    )?.[0] ?? '';
    expect(marker).toContain('expected_hash');
    expect(marker).toContain('deadline_unix_ms');
    expect(marker).not.toMatch(/password|bearer|token|clipboard_text|std::wstring/i);
  });

  it('exposes no CLI argument capable of carrying the raw link or password', () => {
    expect(sources.main).toContain('L"--sha256"');
    expect(sources.main).toContain('L"--baseline-sequence"');
    expect(sources.main).toContain('L"--deadline-at"');
    expect(sources.main).not.toMatch(/L"--(?:text|value|link|password|token|secret)"/i);
    expect(sources.main).toContain('if (count != 12');
  });

  it('opts managed text out of clipboard history and cloud sync', () => {
    expect(sources.header).toContain('WriteShellOwnedInvitationLink');
    expect(sources.header).not.toMatch(/WriteShellOwnedPassword|CopyPassword/);
    expect(sources.implementation).toContain('invitation_link.rfind(L"https://", 0) != 0');
    expect(sources.implementation).toContain('L"CanIncludeInClipboardHistory"');
    expect(sources.implementation).toContain('L"CanUploadToCloudClipboard"');
    expect(sources.implementation).toContain('SetOptOutFormat(history) && SetOptOutFormat(cloud)');
    expect(sources.implementation).toContain('EmptyClipboard();  // Never leave a copy');
  });

  it('clears only an unchanged sequence and hash, including crash recovery', () => {
    expect(sources.policy).toContain('if (!expected_hash_matches) return CleanupDecision::kPreserveReplacement;');
    expect(sources.policy).toContain('recorded_sequence != current_sequence');
    expect(sources.selftest).toContain('MarkerPhase::kArmed, 8, 99, true');
    expect(sources.selftest).toContain('MarkerPhase::kOwned, 9, 10, true');
    expect(sources.selftest).toContain('MarkerPhase::kOwned, 9, 9, false');
    const reconciliation = sources.implementation.slice(
      sources.implementation.indexOf('int ReconcileMarker('),
      sources.implementation.indexOf('\n}\n\n}  // namespace', sources.implementation.indexOf('int ReconcileMarker(')),
    );
    expect(reconciliation).toContain('if (!EmptyClipboard())');
    expect(reconciliation.indexOf('ReadOpenClipboardHash')).toBeLessThan(
      reconciliation.indexOf('if (!EmptyClipboard())'),
    );
    expect(reconciliation.indexOf('if (!EmptyClipboard())')).toBeLessThan(
      reconciliation.lastIndexOf('CloseClipboard'),
    );
    expect(sources.implementation).toContain('return RemoveMarker() ? 0 : 22;');
  });

  it('keeps cleanup recoverable across shell failure and later logon', () => {
    expect(sources.main).toContain('arguments[1]) == L"--sanitize"');
    expect(sources.install).toContain("-ArgumentList '--sanitize'");
    expect(sources.install).toContain("$RunKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'");
    expect(sources.install).toContain('if ($Sanitizer.ExitCode -ne 0)');
    expect(sources.implementation).toContain('return 20;  // Keep the marker: cleanup is not proven.');
    expect(sources.implementation).toContain('if (result != MarkerLoadResult::kLoaded) return 30;');
  });

  it('builds a separate Authenticode-required artifact with no worker authority', () => {
    expect(sources.build).toContain("'imcodes-clipboard-watchdog.exe'");
    expect(sources.build).toContain("& $SigningScript -Mode Sign -ArtifactPath $Watchdog");
    expect(sources.build).toContain('Remove-Item -Force -LiteralPath $Watchdog');
    expect(sources.build.indexOf('try {')).toBeLessThan(
      sources.build.indexOf('& $SigningScript -Mode Sign -ArtifactPath $Watchdog'),
    );
    expect(sources.install).toContain("& $SigningScript -Mode Verify -ArtifactPath $ResolvedWatchdog");
    expect(sources.install).toContain('System.IO.FileAttributes]::ReparsePoint');
    expect(sources.install).toContain('protected Program Files root');
    expect(sources.build).not.toContain('build-worker.ps1');
    for (const file of [
      'clipboard_watchdog.cc',
      'clipboard_watchdog_main.cc',
      'clipboard_watchdog_policy.cc',
    ]) {
      expect(sources.build).toContain(`'${file}'`);
    }
    expect(sources.build).toContain('bcrypt.lib crypt32.lib ole32.lib shell32.lib user32.lib uuid.lib');
    expect(sources.implementation).not.toMatch(/peer_session|display_capture|input_injector|pipe_ipc|webrtc/i);
  });

  it('does not advertise the account shell without a separately verified sidecar', () => {
    expect(sources.workerHost).toContain('The signed account shell is a separately signed');
    expect(sources.workerHost).not.toContain('REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY');
    expect(sources.nodeRuntime).not.toMatch(/clipboard[_-]watchdog/i);
    expect(sources.nodeRuntime).toContain('remoteDesktopSignedShell?: {');
    expect(sources.nodeRuntime).toContain('options.remoteDesktopSignedShell?.available() ?? false');
    expect(sources.nodeRuntime).toContain('signedShellAvailable ? [REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY] : []');
  });

  it('arms the separate watchdog before shell copy and reports uncertain cleanup without secrets', () => {
    const copyStart = sources.shell.indexOf('bool CopyInvitationLinkWithWatchdog(');
    const copyEnd = sources.shell.indexOf('\n}\n\nClipboardCleanupStatus', copyStart);
    const copy = sources.shell.slice(copyStart, copyEnd);
    const recoveryStart = sources.shell.indexOf('bool OwnerApiClient::ReportPrivacyRecovery(');
    const recoveryEnd = sources.shell.indexOf('\n}\n\nstd::optional<HttpResponse>', recoveryStart);
    const recovery = sources.shell.slice(recoveryStart, recoveryEnd);
    expect(copy).toContain('L"--watch --epoch "');
    expect(copy).toContain('L" --sha256 "');
    expect(copy).toContain('L" --deadline-at "');
    expect(copy).toContain('L" --baseline-sequence "');
    expect(copy).toContain('L" --ready-event "');
    expect(copy.indexOf('RunWatchdogProcess(')).toBeLessThan(
      copy.indexOf('WriteInvitationClipboard('),
    );
    expect(copy).not.toMatch(/password|stepUpGrant|access_token/i);
    expect(sources.shellUi).toContain('CopyInvitationLinkWithWatchdog(');
    expect(sources.shellUi).toContain('ReconcileClipboardWatchdog()');
    expect(sources.shellUi).toContain('kClipboardWatchdogFailedReason');
    expect(sources.shellUi).toContain('kClipboardWatchdogCrashedReason');
    expect(sources.shellUi).toContain('kClipboardCleanupUncertainReason');
    expect(recovery).toContain('L"/api/remote-desktop/guest/privacy/recovery"');
    expect(recovery).not.toMatch(/password|clipboard(?:Text|_text)|invitation_link/i);
    expect(sources.shellHeader).not.toMatch(/CopyPassword|WriteShellOwnedPassword/);
  });

  it('has counterfactual guards for every critical ordering and trust check', () => {
    expect(satisfiesGuards(sources)).toBe(true);
    for (const guard of criticalGuards) {
      const mutated = {
        ...sources,
        [guard.source]: sources[guard.source].split(guard.needle).join(''),
      };
      expect(
        satisfiesGuards(mutated),
        `removing ${guard.source}:${guard.needle} must fail the contract`,
      ).toBe(false);
    }
  });
});
